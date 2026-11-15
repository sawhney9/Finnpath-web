/**
 * GET /history?symbol=NVDA&range=1y — % change over time for the Portfolio
 * Tracker's Compare tab (simulator.html).
 *
 * The browser can't call Yahoo Finance directly (no CORS header), so the Worker
 * fetches the chart and returns each bar's % change from the first close, plus
 * the first and last close for the summary cards. Dividend-adjusted where Yahoo
 * provides it.
 *
 * Cached in KV (PRICE_CACHE) for 1h, shared with /stats.
 */

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TTL = 3600;

// Same timeframes the Compare tab offers.
export const RANGES = {
  '1mo': '1d',
  '3mo': '1d',
  '6mo': '1d',
  '1y': '1wk',
  '2y': '1wk',
};

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** Returns [status, body]. */
export async function getHistory(env, sym, range) {
  const key = `hist:v1:${sym}:${range}`;
  const cached = env.PRICE_CACHE ? await env.PRICE_CACHE.get(key, 'json') : null;
  if (cached) return [cached.error ? 404 : 200, cached];

  const res = await fetch(`${YAHOO}${encodeURIComponent(sym)}?interval=${RANGES[range]}&range=${range}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinnpathBot/1.0; +https://finnpath.com)' },
  });
  if (!res.ok && res.status !== 404) throw new Error(`upstream ${res.status}`);
  const r = res.ok ? (await res.json())?.chart?.result?.[0] : null;
  const closes = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close || [];
  const bars = (r?.timestamp || []).map((t, i) => [t, closes[i]]).filter(([, c]) => c > 0);

  let body;
  if (bars.length < 2) {
    body = { symbol: sym, error: 'unknown_symbol' };
  } else {
    const first = bars[0][1];
    body = {
      symbol: sym,
      name: r.meta?.longName || r.meta?.shortName || sym,
      range,
      start: round(first, 2),
      end: round(bars[bars.length - 1][1], 2),
      // [unix seconds, % change from the first close]
      points: bars.map(([t, c]) => [t, round((c / first - 1) * 100, 2)]),
    };
  }
  if (env.PRICE_CACHE) await env.PRICE_CACHE.put(key, JSON.stringify(body), { expirationTtl: TTL });
  return [body.error ? 404 : 200, body];
}
