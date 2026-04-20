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

const FINNHUB_KEY = "d7ilfrpr01qn2qaug760d7ilfrpr01qn2qaug76g";

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

async function fetchStocks(symbols) {
  const results = await Promise.all(symbols.map(async sym => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.c) return null;
      return { symbol: sym, price: d.c, change: d.dp ?? 0, isCrypto: false };
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

async function fetchCryptos(symbols) {
  const known = symbols.filter(s => CRYPTO_IDS[s]);
  if (!known.length) return [];
  const ids = known.map(s => CRYPTO_IDS[s]).join(',');
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
    );
    if (!r.ok) return [];
    const d = await r.json();
    return known.map(s => {
      const data = d[CRYPTO_IDS[s]];
      if (!data) return null;
      return { symbol: s, price: data.usd, change: data.usd_24h_change ?? 0, isCrypto: true };
    }).filter(Boolean);
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

  const [stockData, cryptoData] = await Promise.all([
    fetchStocks(allStocks),
    fetchCryptos(allCryptos)
  ]);

  const portSet  = new Set([...portfolioStocks, ...portfolioCryptos]);
  const all      = [...stockData, ...cryptoData];
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
