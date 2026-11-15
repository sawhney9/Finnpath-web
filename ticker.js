// ticker.js — Live market ticker bar
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

const FB_CONFIG = {
  apiKey: "AIzaSyCBPd8YbW3uiZTtF92oW-1QuGi027faxKU",
  authDomain: "finnpath-b82f3.firebaseapp.com",
  projectId: "finnpath-b82f3",
  storageBucket: "finnpath-b82f3.firebasestorage.app",
  messagingSenderId: "1058942599170",
  appId: "1:1058942599170:web:9aef88c5417e18b157e71b"
};

const app = getApps().length ? getApps()[0] : initializeApp(FB_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app);

// Prices come from the Finnpath Worker, which caches them for every visitor
// (and keeps the Finnhub key server-side).
const QUOTES_URL = 'https://finnpath-gemini-proxy.rimas2043.workers.dev/quotes';

const DEFAULT_STOCKS  = ['SPY','QQQ','DIA','AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA','META'];
const DEFAULT_CRYPTOS = ['BTC','ETH','SOL','XRP','DOGE','ADA'];

const CRYPTO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', ADA:'cardano',
  DOGE:'dogecoin', XRP:'ripple', AVAX:'avalanche-2', DOT:'polkadot',
  MATIC:'matic-network', LINK:'chainlink', LTC:'litecoin', UNI:'uniswap',
  ATOM:'cosmos', NEAR:'near', SHIB:'shiba-inu', TRX:'tron',
  TON:'the-open-network', BCH:'bitcoin-cash', FIL:'filecoin', APT:'aptos',
  ARB:'arbitrum', OP:'optimism', SUI:'sui', PEPE:'pepe', INJ:'injective-protocol',
  FTM:'fantom', ALGO:'algorand', VET:'vechain', SAND:'the-sandbox',
  MANA:'decentraland', CRO:'crypto-com-chain', FLOW:'flow', THETA:'theta-token'
};

let portfolioStocks  = [];
let portfolioCryptos = [];
let refreshTimer     = null;
let currentUid       = null;

// ── PRICE FETCHERS ──────────────────────────────────────────────────────────

async function fetchQuotes(stocks, cryptos) {
  const known = cryptos.filter(s => CRYPTO_IDS[s]);
  if (!stocks.length && !known.length) return [];
  try {
    const r = await fetch(`${QUOTES_URL}?stocks=${stocks.map(encodeURIComponent).join(',')}&crypto=${known.join(',')}`);
    if (!r.ok) return [];
    const d = await r.json();
    return [
      ...stocks.filter(s => d.stocks?.[s]).map(s => ({ symbol: s, price: d.stocks[s].c, change: d.stocks[s].dp ?? 0, isCrypto: false })),
      ...known.filter(s => d.crypto?.[s]).map(s => ({ symbol: s, price: d.crypto[s].usd, change: d.crypto[s].change ?? 0, isCrypto: true })),
    ];
  } catch { return []; }
}

// ── PORTFOLIO LOADER ─────────────────────────────────────────────────────────

async function loadPortfolioSymbols(uid) {
  try {
    const snap = await getDocs(collection(db, `portfolios/${uid}/transactions`));
    const stocks = new Set(), cryptos = new Set();
    snap.forEach(d => {
      const { ticker, assetType } = d.data();
      if (!ticker) return;
      if (assetType === 'crypto') cryptos.add(ticker.toUpperCase());
      else stocks.add(ticker.toUpperCase());
    });
    portfolioStocks  = [...stocks];
    portfolioCryptos = [...cryptos];
  } catch {
    portfolioStocks  = [];
    portfolioCryptos = [];
  }
}

// ── RENDER ──────────────────────────────────────────────────────────────────

function fmtPrice(price) {
  if (price >= 1000) return '$' + price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1)    return '$' + price.toFixed(2);
  return '$' + price.toPrecision(4);
}

function itemHTML({ symbol, price, change }) {
  const up  = change >= 0;
  const cls = up ? 'up' : 'dn';
  const arrow = up ? '▲' : '▼';
  const pct = (up ? '+' : '') + (change ?? 0).toFixed(2) + '%';
  return `<span class="ti"><span class="ti-sym">${symbol}</span><span class="ti-price">${fmtPrice(price)}</span><span class="ti-chg ${cls}">${arrow} ${pct}</span></span><span class="ti-dot">·</span>`;
}

function renderTicker(marketItems, portItems) {
  const track = document.getElementById('tickerTrack');
  if (!track) return;

  let inner = marketItems.map(itemHTML).join('');

  if (portItems.length) {
    inner += `<span class="ti-label">MY PORTFOLIO</span><span class="ti-dot">·</span>`;
    inner += portItems.map(itemHTML).join('');
  }

  // Duplicate for seamless infinite scroll
  track.innerHTML = inner + inner;

  // Scale animation duration to content volume (wider = longer cycle)
  const totalItems = marketItems.length + portItems.length;
  const dur = Math.max(40, totalItems * 3.5);
  track.style.animationDuration = `${dur}s`;
}

// ── REFRESH ──────────────────────────────────────────────────────────────────

async function refresh() {
  const allStocks  = [...new Set([...DEFAULT_STOCKS,  ...portfolioStocks])];
  const allCryptos = [...new Set([...DEFAULT_CRYPTOS, ...portfolioCryptos])];

  // The Worker accepts up to 25 of each per request.
  const all = await fetchQuotes(allStocks.slice(0, 25), allCryptos.slice(0, 25));

  const portSet  = new Set([...portfolioStocks, ...portfolioCryptos]);
  const market   = all.filter(i => !portSet.has(i.symbol));
  const port     = all.filter(i => portSet.has(i.symbol));

  renderTicker(market, port);
}

// ── BOOTSTRAP ────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async user => {
  if (user && user.uid !== currentUid) {
    currentUid = user.uid;
    await loadPortfolioSymbols(user.uid);
  } else if (!user) {
    currentUid       = null;
    portfolioStocks  = [];
    portfolioCryptos = [];
  }
  refresh();
});

// Initial load (runs before auth state resolves for speed)
refresh();

// Auto-refresh every 30 seconds
clearInterval(refreshTimer);
refreshTimer = setInterval(refresh, 30_000);
