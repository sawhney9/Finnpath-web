import './site-nav.js';
import './info-tips.js';
import { runRetirement } from './sim-engine.js';

/* Retirement check: five questions → chance your money lasts, then optional detail.
   Everything runs in the browser; nothing is sent anywhere. */

const QUICK = ['age', 'retireAge', 'saved', 'savings', 'spending'];
const DEFAULTS = {
  age: '', retireAge: '', saved: '', savings: '', spending: '',
  ssMonthly: 2000, ssAge: 67, pension: 0, pensionAge: 65, rental: 0, side: 0, sideStart: '', sideEnd: '',
  mix: 'tdf', stockPct: 80, cut: 0, trigger: 80, preTaxPct: 70, rothPct: 20, preTaxRate: 15, endAge: 95,
  stkMu: 6.5, stkVol: 17, bndMu: 2, bndVol: 7, sims: '2000',
};
const FIELDS = Object.keys(DEFAULTS);
const MONEY = new Set(['saved', 'savings', 'spending', 'ssMonthly', 'pension', 'rental', 'side']);
const LEVER_SIMS = 1000;
const LS = 'finnpath-retirement-check-v1';
// Brokerage withdrawals: roughly half is growth, taxed at a 15% long-term rate.
const BROKERAGE_TAX = 7.5;

// Stock share by fund choice. Target-date funds follow a typical glide path:
// 90% stocks until 25 years out, easing to 50% at retirement and 30% seven years later.
function allocFor(mix, retireAge, customPct) {
  if (mix === 'tdf') return { stockPct: 90, stockPctAt: age => { const y = retireAge - age; if (y >= 25) return 90; if (y >= 0) return 50 + 40 * y / 25; const t = -y; return t < 7 ? 50 - 20 * t / 7 : 30; } };
  return { stockPct: { idx: 100, m80: 80, m60: 60 }[mix] ?? customPct, stockPctAt: undefined };
}

const $ = id => document.getElementById(id);
const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, '')); return isFinite(n) ? n : NaN; };
const fmt = n => { if (!isFinite(n)) return '—'; const a = Math.abs(n), s = n < 0 ? '-' : ''; if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M'; if (a >= 1e4) return s + '$' + Math.round(a / 1e3) + 'K'; return s + '$' + Math.round(a).toLocaleString(); };
const money = n => Math.round(n).toLocaleString();
const pctf = n => Math.round(n * 100) + '%';
const cssv = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200); }

/* ---------- screens ---------- */
function show(id) { document.querySelectorAll('.rc .screen').forEach(s => s.classList.toggle('on', s.id === id)); window.scrollTo({ top: 0 }); }

/* ---------- the five questions ---------- */
let step = 1;
const retiredAlready = () => num($('q-retireAge').value) <= num($('q-age').value);

function showStep(n, dir = 1) {
  step = n;
  document.querySelectorAll('.step').forEach(s => { const on = +s.dataset.step === n; s.classList.toggle('on', on); s.classList.toggle('back', on && dir < 0); });
  $('wizBar').style.width = ((n - 1) / QUICK.length * 100) + '%';
  $('stepCount').textContent = `Question ${n} of ${QUICK.length}`;
  $('back').style.visibility = n === 1 ? 'hidden' : 'visible';
  $('next').textContent = n === QUICK.length ? 'See my results →' : 'Next →';
  $('wizErr').textContent = '';
  setTimeout(() => $('q-' + QUICK[n - 1]).focus({ preventScroll: true }), 60);
}

function checkStep(n) {
  const v = num($('q-' + QUICK[n - 1]).value), age = num($('q-age').value);
  if (n === 1 && !(v >= 18 && v <= 90)) return 'Enter an age between 18 and 90.';
  if (n === 2 && !(v >= age)) return `That's younger than you are now. Already retired? Enter ${age}.`;
  if (n === 2 && v > 85) return 'Enter an age up to 85.';
  if ((n === 3 || n === 4) && !(v >= 0)) return 'Enter an amount, or 0.';
  if (n === 5 && !(v > 0)) return "Enter how much you'd spend in a year.";
  return '';
}

$('wiz').addEventListener('submit', e => {
  e.preventDefault();
  const err = checkStep(step);
  if (err) { $('wizErr').textContent = err; $('q-' + QUICK[step - 1]).classList.add('bad'); return; }
  $('q-' + QUICK[step - 1]).classList.remove('bad');
  let next = step + 1;
  if (next === 4 && retiredAlready()) { $('q-savings').value = '0'; next = 5; } // no more saving once retired
  if (next <= QUICK.length) return showStep(next, 1);
  finishWizard();
});
$('back').onclick = () => { let prev = step - 1; if (prev === 4 && retiredAlready()) prev = 3; if (prev >= 1) showStep(prev, -1); };
document.querySelectorAll('.chips').forEach(c => c.addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  const input = $(c.dataset.for), v = +b.dataset.v;
  input.value = MONEY.has(input.id.slice(2)) ? money(v) : v;
  setTimeout(() => $('wiz').requestSubmit(), reduced ? 0 : 180);
}));
$('start').onclick = () => { show('wizard'); showStep(1); };

function finishWizard() {
  QUICK.forEach(k => { const v = $('q-' + k).value; $(k).value = MONEY.has(k) && isFinite(num(v)) ? money(num(v)) : v; });
  $('wizBar').style.width = '100%';
  show('crunch');
  $('crunchText').textContent = `Playing out ${num($('sims').value).toLocaleString()} possible futures…`;
  const bar = $('crunchBar'); bar.style.transition = 'none'; bar.style.width = '0';
  requestAnimationFrame(() => { bar.style.transition = `width ${reduced ? 0 : 1.1}s ease`; bar.style.width = '100%'; });
  setTimeout(() => { show('result'); update(true); }, reduced ? 50 : 1250);
}
$('restart').onclick = () => { QUICK.forEach(k => { $('q-' + k).value = $(k).value; }); save(true); show('wizard'); showStep(1); };

/* ---------- inputs → simulation parameters ---------- */
function params() {
  document.querySelectorAll('#result input.bad').forEach(x => x.classList.remove('bad'));
  const errs = [];
  const need = (id, min, max, label) => { const v = num($(id).value); if (!(v >= min && v <= max)) { $(id).classList.add('bad'); errs.push(label); return NaN; } return v; };
  const opt = (id, min, max, label) => ($(id).value.trim() === '' ? NaN : need(id, min, max, label));
  const age = need('age', 18, 90, 'age');
  const retireAge = need('retireAge', isFinite(age) ? age : 18, 85, 'when you stop working');
  const endAge = need('endAge', Math.max(isFinite(retireAge) ? retireAge + 1 : 60, 60), 110, 'plan-to age');
  const p = {
    age, retireAge, endAge,
    portfolio: need('saved', 0, 1e10, 'saved so far'), savings: need('savings', 0, 1e8, 'added per year'), spending: need('spending', 1, 1e8, 'spending'),
    stockPct: $('mix').value === 'custom' ? need('stockPct', 0, 100, 'stocks %') : NaN,
    cut: need('cut', 0, 50, 'spending cut') / 100, trigger: need('trigger', 10, 100, 'cut trigger') / 100,
    stkMu: need('stkMu', -5, 15, 'stock return') / 100, stkVol: need('stkVol', 1, 60, 'stock volatility') / 100,
    bndMu: need('bndMu', -5, 10, 'bond return') / 100, bndVol: need('bndVol', 0, 30, 'bond volatility') / 100,
    sims: +$('sims').value,
  };
  const ss = need('ssMonthly', 0, 10000, 'Social Security') * 12, ssAge = need('ssAge', 62, 70, 'Social Security age');
  const pension = need('pension', 0, 1e7, 'pension'), pensionAge = need('pensionAge', 40, 90, 'pension age');
  const rental = need('rental', 0, 1e7, 'rental income'), side = need('side', 0, 1e7, 'part-time income');
  const sideStart = isFinite(opt('sideStart', 18, 100, 'part-time start')) ? num($('sideStart').value) : retireAge;
  const sideEnd = isFinite(opt('sideEnd', 18, 110, 'part-time end')) ? num($('sideEnd').value) : retireAge + 5;
  const pre = need('preTaxPct', 0, 100, 'pre-tax %'), roth = need('rothPct', 0, 100, 'Roth %'), preRate = need('preTaxRate', 0, 50, 'pre-tax tax rate');
  if (pre + roth > 100) { $('preTaxPct').classList.add('bad'); $('rothPct').classList.add('bad'); errs.push('pre-tax + Roth can\'t be over 100%'); }
  const brokerage = Math.max(0, 100 - pre - roth);
  p.wdTax = (pre * preRate + brokerage * BROKERAGE_TAX) / 10000;
  if (isFinite(p.wdTax)) $('taxMixNote').innerHTML = `Regular brokerage: ${Math.round(brokerage)}%. Blended tax on what you withdraw: about <b>${(p.wdTax * 100).toFixed(1)}%</b>. Roth money comes out tax-free, so more Roth means a lower rate.`;
  Object.assign(p, allocFor($('mix').value, retireAge, p.stockPct));
  p.mix = $('mix').value;
  $('formErr').textContent = errs.length ? 'Check: ' + errs.join(', ') : '';
  if (errs.length) return null;
  p.incomeAt = a => (a >= ssAge ? ss : 0) + (a >= pensionAge ? pension : 0) + rental + (a >= sideStart && a < sideEnd ? side : 0);
  p.raw = readForm();
  return p;
}

/* ---------- results ---------- */
const C = 2 * Math.PI * 72;
let shownPct = 0, chart = null;

function tier(s) { return s >= .75 ? 'good' : s >= .5 ? 'warn' : 'bad'; }
function countTo(to) {
  const from = shownPct, el = $('ringPct'), t0 = performance.now(), ms = reduced ? 0 : 1100;
  const tick = now => { const k = ms ? Math.min(1, (now - t0) / ms) : 1, e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round((from + (to - from) * e) * 100) + '%'; if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); shownPct = to;
}

function renderGauge(p, r) {
  const s = r.success, ring = $('ring');
  ring.style.stroke = cssv('--' + tier(s));
  requestAnimationFrame(() => { ring.style.strokeDashoffset = String(C * (1 - s)); });
  countTo(s);
  const V = s >= .9 ? ["You're in great shape.", 'You may even have room to stop earlier or spend more.']
    : s >= .75 ? ["You're on track.", 'Most futures work out. One of the changes below would add a cushion.']
    : s >= .5 ? ["You're close.", 'One or two of the changes below would make a real difference.']
    : ["There's a gap to close.", 'The changes below show what moves the needle most.'];
  $('verdict').textContent = V[0];
  $('vdetail').innerHTML = `In <b>${pctf(s)}</b> of ${p.sims.toLocaleString()} simulated futures, your money lasts to age ${p.endAge}. ${V[1]}` +
    (r.earlyDeplete ? ` When it falls short, it usually runs out around age <b>${Math.round(r.earlyDeplete)}</b>.` : '') +
    (r.endP50 >= 1000 ? ` Typical amount left at ${p.endAge}: <b>${fmt(r.endP50)}</b> in today's dollars.` : ` In the typical future, the money is gone before ${p.endAge}.`);
}

function niceMax(x) { if (!(x > 0)) return undefined; const m = 10 ** Math.floor(Math.log10(x)), f = x / m; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * m; }

function renderChart(p, r) {
  const B = r.bands, acc = cssv('--accent'), m = cssv('--muted'), l = cssv('--line');
  $('chartSub').textContent = `${p.retireAge > p.age ? `You stop working at ${p.retireAge}. ` : ''}Line: the typical future. Darker shading: the middle half of futures; lighter: 8 in 10. Hover or tap the chart for details at any age. Today's dollars.`;
  if (chart) chart.destroy();
  if (!window.Chart) return;
  chart = new Chart($('chFan'), {
    type: 'line',
    data: { labels: B.map(b => b.age), datasets: [
      { label: '_p90', data: B.map(b => b.p90), borderColor: 'transparent', pointHoverRadius: 0, pointRadius: 0, fill: false },
      { label: '_p10', data: B.map(b => b.p10), borderColor: 'transparent', pointHoverRadius: 0, backgroundColor: acc + '22', pointRadius: 0, fill: '-1' },
      { label: '_p75', data: B.map(b => b.p75), borderColor: 'transparent', pointHoverRadius: 0, pointRadius: 0, fill: false },
      { label: '_p25', data: B.map(b => b.p25), borderColor: 'transparent', pointHoverRadius: 0, backgroundColor: acc + '44', pointRadius: 0, fill: '-1' },
      { label: 'Typical', data: B.map(b => b.p50), borderColor: acc, borderWidth: 2.5, pointRadius: 0, tension: .25 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: reduced ? false : { duration: 700 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: {
        filter: c => !c.dataset.label.startsWith('_'), padding: 12, bodySpacing: 5, footerMarginTop: 8, displayColors: false,
        footerFont: { weight: 'normal', size: 11 }, footerColor: m,
        callbacks: {
          title: c => { const a = +c[0].label, d = a - p.retireAge; return `Age ${a} · ` + (d < 0 ? `${-d} year${d === -1 ? '' : 's'} until you stop working` : d === 0 ? 'the year you stop working' : `${d} year${d === 1 ? '' : 's'} into retirement`); },
          label: c => { const x = B[c.dataIndex]; return [
            `Typical future: ${fmt(x.p50)}`,
            `Middle half of futures: ${fmt(x.p25)} – ${fmt(x.p75)}`,
            `8 in 10 futures: ${fmt(x.p10)} – ${fmt(x.p90)}`,
            `Money still left in ${pctf(x.funded)} of futures`,
          ]; },
          footer: c => { const a = +c[0].label; return a < p.retireAge ? 'Still working and saving.' : 'Living on savings plus other income.'; },
        } } },
      // Cap the axis a bit above the upper-middle band so the best 10% of futures don't flatten the typical line.
      scales: { x: { ticks: { color: m, maxTicksLimit: 8 }, grid: { color: l } }, y: { ticks: { color: m, callback: v => fmt(v) }, grid: { color: l }, beginAtZero: true, max: niceMax(Math.max(...B.map(b => b.p75)) * 1.25) } },
    },
  });
}

// One change at a time, so people can see which lever matters most for them.
function levers(p, r) {
  const base = r.success, out = [];
  const add = (what, patch, apply) => out.push({ what, s: runRetirement({ ...p, ...patch, sims: LEVER_SIMS }).success, apply });
  const working = p.retireAge > p.age;
  if (base < .95) {
    if (working && p.retireAge + 2 <= 85) add(`Stop working at ${p.retireAge + 2}`, { retireAge: p.retireAge + 2, ...allocFor(p.mix, p.retireAge + 2, p.stockPct) }, () => { $('retireAge').value = p.retireAge + 2; });
    if (working) add(`Add ${fmt(5000)} more a year`, { savings: p.savings + 5000 }, () => { $('savings').value = money(p.savings + 5000); });
    else add(`Earn ${fmt(20000)}/yr part-time for 5 years`, { incomeAt: a => p.incomeAt(a) + (a < p.age + 5 ? 20000 : 0) }, () => { $('side').value = money(num($('side').value) + 20000); $('sideStart').value = p.age; $('sideEnd').value = p.age + 5; });
    add(`Spend ${fmt(p.spending * .9)} a year`, { spending: p.spending * .9 }, () => { $('spending').value = money(p.spending * .9); });
  } else {
    if (working && p.retireAge - 2 >= p.age) add(`Stop working at ${p.retireAge - 2}`, { retireAge: p.retireAge - 2, ...allocFor(p.mix, p.retireAge - 2, p.stockPct) }, () => { $('retireAge').value = p.retireAge - 2; });
    add(`Spend ${fmt(p.spending * 1.1)} a year`, { spending: p.spending * 1.1 }, () => { $('spending').value = money(p.spending * 1.1); });
    if (p.cut === 0) add('Cut spending 10% in bad years', { cut: .1 }, () => { $('cut').value = 10; });
  }
  $('levers').innerHTML = out.map((x, i) => { const d = Math.round((x.s - base) * 100);
    return `<div class="lever"><div class="what">${x.what}</div><div class="to ${tier(x.s)}">${pctf(x.s)} <small>${d > 0 ? '+' : ''}${d} pts</small></div><button type="button" class="ghost sm" data-lever="${i}">Try it</button></div>`; }).join('');
  $('levers').onclick = e => { const b = e.target.closest('[data-lever]'); if (!b) return; out[+b.dataset.lever].apply(); update(false); toast('Updated your plan'); };
}

function update(fresh) {
  const p = params(); if (!p) return;
  const r = runRetirement(p);
  if (fresh) { shownPct = 0; $('ring').style.transition = 'none'; $('ring').style.strokeDashoffset = String(C); $('ring').getBoundingClientRect(); $('ring').style.transition = ''; }
  renderGauge(p, r); renderChart(p, r); levers(p, r); save(false);
}
let timer = null;
$('result').addEventListener('input', e => { if (e.target.matches('input,select')) { clearTimeout(timer); timer = setTimeout(() => update(false), 350); } });
$('result').addEventListener('change', e => { if (e.target.matches('select')) setTimeout(() => update(false)); }); // after syncMix
document.querySelectorAll('.rc input[inputmode="decimal"]').forEach(el => el.addEventListener('blur', () => { const v = num(el.value); if (isFinite(v) && Math.abs(v) >= 1000) el.value = money(v); }));

function syncMix() { const c = $('mix').value === 'custom'; if (c && !$('stockPct').value) $('stockPct').value = 80; $('stockPct').disabled = !c; if (!c) $('stockPct').value = $('mix').value === 'tdf' ? '' : { idx: 100, m80: 80, m60: 60 }[$('mix').value]; $('stockPct').placeholder = c ? '' : 'Shifts with age'; }
$('mix').addEventListener('change', syncMix);

/* ---------- state: storage and share links ---------- */
function readForm() { const o = {}; FIELDS.forEach(f => { o[f] = $(f).value; }); return o; }
function fillForm(o) { FIELDS.forEach(f => { const v = o[f]; if (v === undefined || v === null) return; $(f).value = (MONEY.has(f) && isFinite(num(v)) && num(v) >= 1000) ? money(num(v)) : v; }); if (!$('mix').value) $('mix').value = DEFAULTS.mix; QUICK.forEach(k => { $('q-' + k).value = $(k).value; }); syncMix(); }
function save(restarting) { try { localStorage.setItem(LS, JSON.stringify({ ...readForm(), done: !restarting })); } catch (_) {} }
function load() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (_) { return null; } }
function fromQuery() { const q = new URLSearchParams(location.search); if (!q.has('age')) return null; const o = {}; FIELDS.forEach(f => { if (q.has(f)) o[f] = q.get(f); }); o.done = true; return o; }
$('share').onclick = async () => {
  const q = new URLSearchParams(); const o = readForm(); FIELDS.forEach(f => { if (o[f] !== '' && String(o[f]) !== String(DEFAULTS[f])) q.set(f, String(o[f]).replace(/,/g, '')); });
  try { await navigator.clipboard.writeText(location.origin + location.pathname + '?' + q); toast('Link copied. Anyone with it sees these numbers.'); } catch (_) { toast('Copy failed. Your browser blocked the clipboard.'); }
};

/* ---------- init ---------- */
const link = fromQuery(), saved = load();
fillForm({ ...DEFAULTS, ...(saved || {}), ...(link || {}) });
if ((link || saved?.done) && QUICK.every(k => $(k).value !== '')) { show('result'); update(true); }
