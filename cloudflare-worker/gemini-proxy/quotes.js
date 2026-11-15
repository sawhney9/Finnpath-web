/**
 * GET /quotes?stocks=SPY,AAPL&crypto=BTC,ETH — live prices for the site's
 *   ticker bar and the Portfolio Tracker.
 * GET /news?symbol=AAPL — up to 4 recent headlines (Portfolio Pulse).
 *
 * Finnhub's free plan allows 60 calls a minute for the whole key, and CoinGecko's
 * public API rate-limits per IP (and refuses Cloudflare's servers), so crypto now
 * comes from Yahoo (BTC-USD etc.). Fetching from every visitor's browser ran out
 * of both quickly, and put the Finnhub key in page source. Here each price is fetched
 * at most once a minute and shared with every visitor through the edge cache, and
 * the key stays in a Worker secret (FINNHUB_KEY).
 */

const QUOTE_TTL = 60;
const NEWS_TTL = 1800;
const MAX_STOCKS = 25;
const MAX_CRYPTO = 25;
const FINNHUB = 'https://finnhub.io/api/v1';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

// Synthetic cache keys; these URLs are never fetched.
const cacheKey = path => new Request(`https://cache.finnpath.internal/${path}`);

async function cached(path, ttl, load) {
  const cache = caches.default, key = cacheKey(path);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const val = await load();
  if (val !== null) {
    await cache.put(key, new Response(JSON.stringify(val), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  }
  return val;
}

const list = (raw, max, clean) => [...new Set(String(raw || '').split(',').map(clean).filter(Boolean))].slice(0, max);
// Finnhub spelling: keep dots (BRK.B), unlike Yahoo's BRK-B in stats.js.
const stockSym = s => (/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(s = String(s).trim().toUpperCase()) ? s : null);
const cryptoSym = s => (/^[A-Z0-9]{1,10}$/.test(s = String(s).trim().toUpperCase()) ? s : null);

async function stockQuote(env, sym) {
  return cached(`q/${sym}`, QUOTE_TTL, async () => {
    const res = await fetch(`${FINNHUB}/quote?symbol=${encodeURIComponent(sym)}&token=${env.FINNHUB_KEY}`);
    if (!res.ok) return null;
    const d = await res.json();
    return d && d.c ? { c: d.c, pc: d.pc || d.c, dp: d.dp ?? 0 } : null;
  });
}

// Price and change since the previous daily close, from Yahoo's chart meta.
async function cryptoQuote(sym) {
  return cached(`c/${sym}`, QUOTE_TTL, async () => {
    const res = await fetch(`${YAHOO}${sym}-USD?range=1d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinnpathBot/1.0; +https://finnpath.com)' },
    });
    if (!res.ok) return null;
    const m = (await res.json())?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return null;
    const prev = m.chartPreviousClose || m.previousClose;
    return { usd: m.regularMarketPrice, change: prev ? (m.regularMarketPrice / prev - 1) * 100 : 0 };
  });
}

/** Returns [status, body]. */
export async function getQuotes(env, params) {
  const stocks = list(params.get('stocks'), MAX_STOCKS, stockSym);
  const crypto = list(params.get('crypto'), MAX_CRYPTO, cryptoSym);
  if (!stocks.length && !crypto.length) return [400, { error: 'invalid_request' }];
  const [stockVals, cryptoVals] = await Promise.all([
    Promise.all(stocks.map(s => stockQuote(env, s).catch(() => null))),
    Promise.all(crypto.map(s => cryptoQuote(s).catch(() => null))),
  ]);
  const body = { stocks: {}, crypto: {} };
  stocks.forEach((s, i) => { if (stockVals[i]) body.stocks[s] = stockVals[i]; });
  crypto.forEach((s, i) => { if (cryptoVals[i]) body.crypto[s] = cryptoVals[i]; });
  return [200, body];
}

/** Returns [status, body]. */
export async function getNews(env, raw) {
  const sym = stockSym(raw);
  if (!sym) return [400, { error: 'invalid_symbol' }];
  const items = await cached(`n/${sym}`, NEWS_TTL, async () => {
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
    const res = await fetch(`${FINNHUB}/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${env.FINNHUB_KEY}`);
    if (!res.ok) return null;
    const d = await res.json();
    return (Array.isArray(d) ? d : [])
      .filter(n => n && n.headline && /^https:\/\//.test(n.url || ''))
      .slice(0, 4)
      .map(n => ({ headline: String(n.headline).slice(0, 300), url: n.url, source: String(n.source || '').slice(0, 60), datetime: n.datetime }));
  });
  return [200, { symbol: sym, items: items || [] }];
}
