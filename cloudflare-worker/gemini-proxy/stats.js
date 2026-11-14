/**
 * GET /stats?symbol=GOOG — price-history statistics for the RSU selldown planner.
 *
 * Pulls ~5 years of weekly, dividend-adjusted closes from Yahoo Finance (the same
 * source simulator.html uses) for the symbol and a fixed set of benchmark ETFs,
 * and returns only derived numbers (volatility, correlations, trailing return),
 * never raw price series, so this isn't a general-purpose market-data proxy.
 *
 * Results are cached in KV (PRICE_CACHE) for 12h; unknown symbols for 1h.
 */

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

// Benchmarks the planner maps destinations onto (VTI also stands in for VOO).
export const BENCHMARKS = ['VTI', 'VXUS', 'SCHD', 'VBIAX', 'BND', 'GLD'];

const TTL_OK = 12 * 3600;
const TTL_MISS = 3600;
const WEEK = 7 * 86400;
const MIN_WEEKS = 52;

// Plain equity / ETF symbols only. BRK.B → BRK-B (Yahoo's spelling).
export function normalizeSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\./g, '-');
  return /^[A-Z0-9][A-Z0-9-]{0,9}$/.test(s) ? s : null;
}

// Per-isolate fallback when the KV binding isn't configured (e.g. local dev).
const memCache = new Map();

async function cacheGet(env, key) {
  if (env.PRICE_CACHE) return env.PRICE_CACHE.get(key, 'json');
  const hit = memCache.get(key);
  return hit && hit.exp > Date.now() ? hit.val : null;
}

async function cachePut(env, key, val, ttl) {
  if (env.PRICE_CACHE) return env.PRICE_CACHE.put(key, JSON.stringify(val), { expirationTtl: ttl });
  memCache.set(key, { val, exp: Date.now() + ttl * 1000 });
}

// Weekly closes keyed by week index. Returns null if Yahoo doesn't know the symbol.
async function fetchWeekly(sym) {
  const res = await fetch(`${YAHOO}${encodeURIComponent(sym)}?interval=1wk&range=5y`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinnpathBot/1.0; +https://finnpath.com)' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r || !r.timestamp) return null;
  const closes = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || [];
  const byWeek = new Map();
  r.timestamp.forEach((t, i) => {
    const c = closes[i];
    // Epoch day 0 was a Thursday; +4 days makes week buckets start on Monday.
    if (c > 0) byWeek.set(Math.floor((t + 4 * 86400) / WEEK), c);
  });
  return { byWeek, name: r.meta?.longName || r.meta?.shortName || sym, last: r.timestamp[r.timestamp.length - 1] };
}

// Cached weekly series for a benchmark ETF (shared across every lookup).
async function benchmarkSeries(env, sym) {
  const key = `series:v1:${sym}`;
  const cached = await cacheGet(env, key);
  if (cached) return new Map(cached);
  const s = await fetchWeekly(sym);
  if (!s) return null;
  await cachePut(env, key, [...s.byWeek], TTL_OK);
  return s.byWeek;
}

// Log returns between consecutive weeks present in every series.
function alignedReturns(a, b) {
  const weeks = [...a.keys()].filter(w => b.has(w)).sort((x, y) => x - y);
  const ra = [], rb = [];
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i] - weeks[i - 1] !== 1) continue;
    ra.push(Math.log(a.get(weeks[i]) / a.get(weeks[i - 1])));
    rb.push(Math.log(b.get(weeks[i]) / b.get(weeks[i - 1])));
  }
  return [ra, rb];
}

function ownReturns(m) {
  const weeks = [...m.keys()].sort((x, y) => x - y), r = [];
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i] - weeks[i - 1] === 1) r.push(Math.log(m.get(weeks[i]) / m.get(weeks[i - 1])));
  }
  return r;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** Returns [status, body]. */
export async function getStats(env, sym) {
  const key = `stats:v1:${sym}`;
  const cached = await cacheGet(env, key);
  if (cached) return [cached.error ? 404 : 200, cached];

  const [own, ...benches] = await Promise.all([
    fetchWeekly(sym),
    ...BENCHMARKS.map(b => benchmarkSeries(env, b).catch(() => null)),
  ]);

  if (!own) {
    const body = { symbol: sym, error: 'unknown_symbol' };
    await cachePut(env, key, body, TTL_MISS);
    return [404, body];
  }

  const r = ownReturns(own.byWeek);
  if (r.length < MIN_WEEKS) {
    const body = { symbol: sym, error: 'insufficient_history', years: round(r.length / 52, 1) };
    await cachePut(env, key, body, TTL_MISS);
    return [404, body];
  }

  const years = r.length / 52;
  const correlations = {};
  BENCHMARKS.forEach((b, i) => {
    if (!benches[i]) return;
    const [ra, rb] = alignedReturns(own.byWeek, benches[i]);
    if (ra.length >= MIN_WEEKS) correlations[b] = round(corr(ra, rb), 2);
  });

  const body = {
    symbol: sym,
    name: own.name,
    asOf: new Date(own.last * 1000).toISOString().slice(0, 10),
    basis: 'weekly',
    years: round(years, 1),
    vol: round(sd(r) * Math.sqrt(52), 3),
    // Informational only — the planner never uses this as an expected return.
    trailingReturn: round(Math.exp(r.reduce((s, x) => s + x, 0) / years) - 1, 3),
    corr: correlations,
  };
  await cachePut(env, key, body, TTL_OK);
  return [200, body];
}
