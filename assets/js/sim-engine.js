/**
 * Finnpath simulation engine — shared by the RSU selldown planner and the
 * upcoming FI-number and retirement Monte Carlo pages.
 *
 * Pure functions, no DOM access. Returns are annual and lognormal; a single
 * stock and a blended destination are correlated via z2 = rho*z1 + sqrt(1-rho^2)*e.
 */

// Correlations between asset classes, used to blend several destinations.
export const CLS_CORR = {
  eq:   { eq: .85, mix: .9, bond: .15, cash: 0, gold: .05 },
  mix:  { mix: 1, bond: .5, cash: .05, gold: .1 },
  bond: { bond: 1, cash: .1, gold: .2 },
  cash: { cash: 1, gold: 0 },
  gold: { gold: 1 },
};

export const corrCls = (a, b) =>
  (CLS_CORR[a] && CLS_CORR[a][b] !== undefined) ? CLS_CORR[a][b]
    : (CLS_CORR[b] && CLS_CORR[b][a] !== undefined ? CLS_CORR[b][a] : 0);

// Seeded PRNG (mulberry32) so the same inputs always give the same results.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Standard normal draws (Marsaglia polar method) from a uniform source.
export function normal(r) {
  let s = null;
  return () => {
    if (s !== null) { const v = s; s = null; return v; }
    let u, v, q;
    do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0);
    const m = Math.sqrt(-2 * Math.log(q) / q);
    s = v * m; return u * m;
  };
}

// One year's return with arithmetic mean `mu` and volatility `sd`, given a normal draw z.
export function lnRet(mu, sd, z) {
  const m = 1 + mu, s2 = Math.log(1 + (sd * sd) / (m * m));
  return Math.exp(Math.log(m) - s2 / 2 + Math.sqrt(s2) * z) - 1;
}

// Linear-interpolated percentile of a sorted array.
export function pct(a, p) {
  if (!a.length) return 0;
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/**
 * Blend destinations into one asset. Each dest: {key, w, mu, vol, cls, rho}
 * where rho is that destination's correlation with the single stock.
 */
export function blend(dests) {
  const mu = dests.reduce((s, d) => s + d.w * d.mu, 0);
  let v = 0;
  for (const a of dests) for (const b of dests) {
    const r = a === b ? 1 : (a.key === b.key ? 1 : corrCls(a.cls, b.cls));
    v += a.w * b.w * a.vol * b.vol * r;
  }
  const vol = Math.sqrt(Math.max(v, 1e-10));
  const cov = dests.reduce((s, d) => s + d.w * d.vol * d.rho, 0);
  return { mu, vol, rho: Math.max(-.99, Math.min(.99, cov / vol)) };
}

/**
 * Compare hold / sell over N years / sell now for a concentrated position.
 * p: {value, basis, vests, vestYears, sellVests, sellYears, keepPct, horizon,
 *     stkMu, stkVol, sims, tax, putIn, dests, schedule?}
 * schedule (optional) replaces the even selldown for the plan strategy: one
 * entry per year, {f, tax}, where f is the fraction of today's shares to sell
 * that year and tax is that year's capital gains rate.
 */
export function runSelldown(p) {
  const B = blend(p.dests), rho = B.rho, k = Math.sqrt(1 - rho * rho);
  const keep = p.keepPct / 100, n = Math.max(1, Math.round(p.sellYears));
  const strategies = ['hold', 'plan', 'now'], out = {};
  const ends = { hold: [], plan: [], now: [] }, paths = { hold: [], plan: [], now: [] }, dd = { hold: [], plan: [], now: [] };
  for (const s of strategies) {
    const nrm = normal(rng(20261114));
    for (let i = 0; i < p.sims; i++) {
      let S = p.value, SB = p.basis, D = 0, DB = 0, q = 1, peak = S, mdd = 0; const path = [];
      for (let y = 0; y < p.horizon; y++) {
        let frac = 0, rate = p.tax;
        if (s === 'now' && y === 0) { frac = 1 - keep; q = keep; }
        if (s === 'plan' && q > keep) {
          if (p.schedule) { const e = p.schedule[y]; if (e && e.f > 0) { const sq = Math.min(e.f, q - keep); frac = sq / q; q -= sq; rate = e.tax; } }
          else if (y < n) { const sq = (q - keep) / (n - y); frac = sq / q; q -= sq; }
        }
        if (frac > 0 && S > 0) { const sale = S * frac, bs = SB * frac, tax = Math.max(0, sale - bs) * rate; S -= sale; SB -= bs; D += sale - tax; DB += sale - tax; }
        const z1 = nrm(), z2 = rho * z1 + k * nrm();
        S *= 1 + lnRet(p.stkMu, p.stkVol, z1); D *= 1 + lnRet(B.mu, B.vol, z2);
        if (y < p.vestYears && p.vests > 0) { if (p.sellVests && s !== 'hold') { D += p.vests; DB += p.vests; } else { S += p.vests; SB += p.vests; } }
        const tot = S + D; peak = Math.max(peak, tot); mdd = Math.max(mdd, 1 - tot / peak); path.push(tot);
      }
      ends[s].push(S - Math.max(0, S - SB) * p.tax + D - Math.max(0, D - DB) * p.tax); dd[s].push(mdd); if (i < 600) paths[s].push(path);
    }
    const e = ends[s].slice().sort((a, b) => a - b);
    out[s] = {
      p10: pct(e, .1), p50: pct(e, .5), p90: pct(e, .9), mean: e.reduce((a, b) => a + b, 0) / e.length,
      loss: ends[s].filter(v => v < p.putIn).length / e.length, dd50: dd[s].filter(d => d >= .5).length / e.length,
      byYear: Array.from({ length: p.horizon }, (_, y) => { const c = paths[s].map(x => x[y]).sort((a, b) => a - b); return { p10: pct(c, .1), p50: pct(c, .5) }; }),
      raw: ends[s],
    };
  }
  let beats = 0; for (let i = 0; i < p.sims; i++) if (ends.plan[i] >= ends.hold[i]) beats++;
  out.planBeats = beats / p.sims; out.blend = B; return out;
}

/* ---------------------------------------------------------------------------
 * Retirement Monte Carlo, ported from the FIRE Tracker prototype.
 * ------------------------------------------------------------------------- */

// Cholesky factor of a correlation matrix, for drawing correlated normals.
export function cholesky(M) {
  const n = M.length, L = M.map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = M[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
  }
  return L;
}

export function correlated(L, nrm) {
  const n = L.length, z = Array.from({ length: n }, nrm), out = Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k <= i; k++) s += L[i][k] * z[k]; out[i] = s; }
  return out;
}

/**
 * Year-by-year retirement simulation in real (after-inflation) dollars.
 * p: {age, retireAge, endAge, portfolio, savings, spending, wdTax, stockPct,
 *     cut, trigger, stkMu, stkVol, bndMu, bndVol, sims, seed?, incomeAt(age),
 *     employer?, modelEmployer?, empMu?, empVol?, sellYears?, keepFrac?, basisRatio?, ltcg?}
 * A run succeeds if spending (net of other income, grossed up for tax) is met every year.
 * When portfolio < trigger × its value at retirement, spending drops by `cut`.
 */
export function runRetirement(p) {
  const L = cholesky([[1, 0.1, 0.65], [0.1, 1, 0.05], [0.65, 0.05, 1]]);
  const years = Math.max(1, Math.round(p.endAge - p.age));
  const nrm = normal(rng(p.seed || 777));
  const paths = [], ends = []; let ok = 0; const depleteAges = [];
  const sw = p.stockPct / 100;
  for (let i = 0; i < p.sims; i++) {
    let R = p.portfolio - (p.employer || 0), E = p.employer || 0, startRet = null, alive = true, deplAge = null;
    const path = [R + E];
    const sellN = Math.max(1, Math.round(p.sellYears || 1));
    for (let y = 0; y < years; y++) {
      const age = p.age + y;
      // Employer stock is sold down into the diversified portfolio.
      if (E > 0 && p.modelEmployer && y < sellN) {
        const sellable = Math.max(0, E - p.employer * p.keepFrac), sale = sellable / (sellN - y);
        const tax = sale * (1 - p.basisRatio) * p.ltcg; E -= sale; R += sale - tax;
      }
      if (age < p.retireAge) R += p.savings;
      else {
        if (startRet === null) startRet = R + E;
        let spend = p.spending;
        if (p.cut > 0 && (R + E) < startRet * p.trigger) spend *= (1 - p.cut);
        const need = spend - p.incomeAt(age);
        if (need > 0) {
          let wd = need / (1 - p.wdTax);
          const fromR = Math.min(R, wd); R -= fromR; wd -= fromR;
          if (wd > 0) { const fromE = Math.min(E, wd); E -= fromE; wd -= fromE; }
          if (wd > 1e-6) alive = false;
        } else R += -need * (1 - p.wdTax);
      }
      if (!alive) { R = 0; E = 0; if (deplAge === null) deplAge = age; }
      const z = correlated(L, nrm);
      const rs = lnRet(p.stkMu, p.stkVol, z[0]), rb = lnRet(p.bndMu, p.bndVol, z[1]), re = lnRet(p.empMu || 0, p.empVol || 0, z[2]);
      R *= 1 + sw * rs + (1 - sw) * rb;
      E *= 1 + (p.modelEmployer ? re : rs);
      path.push(Math.max(0, R + E));
    }
    if (alive) ok++; else depleteAges.push(deplAge);
    ends.push(Math.max(0, path[path.length - 1]));
    if (i < 1500) paths.push(path);
  }
  const bands = [];
  for (let y = 0; y <= years; y++) {
    const col = paths.map(pp => pp[y]).sort((a, b) => a - b);
    bands.push({ age: p.age + y, p10: pct(col, .1), p25: pct(col, .25), p50: pct(col, .5), p75: pct(col, .75), p90: pct(col, .9) });
  }
  const se = ends.slice().sort((a, b) => a - b), da = depleteAges.sort((a, b) => a - b);
  return { success: ok / p.sims, bands, endP10: pct(se, .1), endP50: pct(se, .5), endP90: pct(se, .9), earlyDeplete: da.length ? pct(da, .5) : null };
}

// Years for P growing at g with S saved per year to reach T (Infinity if never).
export function yearsToTarget(P, S, g, T) {
  if (P >= T) return 0;
  if (g <= 0) return S > 0 ? (T - P) / S : Infinity;
  const n = Math.log((T * g + S) / (P * g + S)) / Math.log(1 + g);
  return isFinite(n) && n >= 0 ? n : Infinity;
}
