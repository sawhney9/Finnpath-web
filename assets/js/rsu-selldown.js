import { runSelldown, pct } from './sim-engine.js';

const STATS_URL = 'https://finnpath-gemini-proxy.rimas2043.workers.dev/stats';
const SUBSCRIBE_URL = 'https://insights.finnpath.com/subscribe';

// bench: the ETF whose measured correlation with the user's stock stands in for this destination.
const DEST = {
  vti:  {label:'Total US stock market (VTI / VTSAX)', mu:9,   vol:16,   cls:'eq',   rho:0.75, bench:'VTI',   color:'#3dba7e'},
  voo:  {label:'S&P 500 index (VOO / FXAIX)',          mu:9,   vol:15.5, cls:'eq',   rho:0.78, bench:'VTI',   color:'#6fd6a3'},
  intl: {label:'International stocks (VXUS / VTIAX)',  mu:7.5, vol:17,   cls:'eq',   rho:0.55, bench:'VXUS',  color:'#4a90d9'},
  div:  {label:'Dividend stocks (SCHD / VYM)',         mu:8,   vol:14,   cls:'eq',   rho:0.55, bench:'SCHD',  color:'#9b7bf5'},
  bal:  {label:'Balanced 60/40 fund (VBIAX)',          mu:6.5, vol:10,   cls:'mix',  rho:0.6,  bench:'VBIAX', color:'#7fb2ec'},
  bond: {label:'Total bond market (BND)',              mu:4.5, vol:6,    cls:'bond', rho:0.15, bench:'BND',   color:'#8a94a6'},
  cash: {label:'Treasury money market / T-bills',      mu:3.5, vol:1,    cls:'cash', rho:0,    bench:null,    color:'#b8c2d3'},
  gold: {label:'Gold (GLD / IAU)',                     mu:5.5, vol:15,   cls:'gold', rho:0.05, bench:'GLD',   color:'#c9a84c'},
  custom:{label:'Custom (enter your own)',             mu:8,   vol:20,   cls:'eq',   rho:0.5,  bench:'VTI',   color:'#e86ca8'}
};
const DEFAULTS = {ticker:'',value:500000,basis:300000,vests:100000,vestYears:4,sellVests:'1',sellYears:3,keepPct:10,horizon:10,fedRate:'20',niit:'1',stateRate:5,stkMu:10,stkVol:30,sims:'5000',dests:[{k:'vti',w:100}]};

// Fallback volatility when price history can't be loaded.
const VOL_PRESETS = [
  {vol:30, group:'large-cap tech stocks', tickers:['GOOG','GOOGL','AAPL','MSFT','AMZN','META','ORCL','CRM','ADBE','CSCO','IBM']},
  {vol:55, group:'high-volatility growth stocks', tickers:['NVDA','TSLA','AMD','PLTR','COIN','SHOP','SNOW','NET','MSTR']},
  {vol:20, group:'utility stocks', tickers:['NEE','DUK','SO','D','AEP','EXC','XEL','SRE','ED','PCG','XLU']},
];

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const num = v => { const n = parseFloat(String(v??'').replace(/[$,%\s]/g,'')); return isFinite(n) ? n : NaN; };
const fmt = n => { if (!isFinite(n)) return '—'; const a=Math.abs(n), s=n<0?'-':''; if (a>=1e6) return s+'$'+(a/1e6).toFixed(a>=1e7?1:2)+'M'; if (a>=1e4) return s+'$'+Math.round(a/1e3)+'K'; return s+'$'+Math.round(a).toLocaleString(); };
const pctf = (n,d=0) => isFinite(n) ? (n*100).toFixed(d)+'%' : '—';
const cssv = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('on'); clearTimeout(toast.t); toast.t=setTimeout(()=>t.classList.remove('on'),2200); }
const FIELDS = ['ticker','value','basis','vests','vestYears','sellVests','sellYears','keepPct','horizon','fedRate','niit','stateRate','stkMu','stkVol','sims'];
let dests = DEFAULTS.dests.map(d=>({...d}));
let lastStats = null;      // measured stats for the current ticker, if any
let pendingLookup = null;  // in-flight ticker lookup, awaited before a run

/* ---------- ticker lookup ---------- */
function rhoFor(k){
  const b = DEST[k].bench;
  if (lastStats && b && isFinite(lastStats.corr?.[b])) return {rho:lastStats.corr[b], src:'measured'};
  return {rho:DEST[k].rho, src:'typical'};
}
function resetRhos(){ dests.forEach(d=>{ const r=rhoFor(d.k); d.rho=r.rho; d.rhoSrc=r.src; }); renderDests(); }
function setVolNote(html){ $('volNote').innerHTML = html; }

function applyFallback(T, reason){
  lastStats = null;
  const preset = VOL_PRESETS.find(p=>p.tickers.includes(T));
  $('stkVol').value = preset ? preset.vol : DEFAULTS.stkVol;
  setVolNote(`${reason} Using ${preset ? `a typical value for ${preset.group}` : 'a generic single-stock default'}.`);
  resetRhos();
}

async function lookupTicker(){
  const T = $('ticker').value.trim().toUpperCase();
  if (!T) { lastStats=null; setVolNote(''); return; }
  setVolNote('Looking up price history…');
  const ctl = new AbortController(), timer = setTimeout(()=>ctl.abort(), 8000);
  try {
    // Only the ticker symbol leaves the browser.
    const res = await fetch(`${STATS_URL}?symbol=${encodeURIComponent(T)}`, {signal:ctl.signal});
    if ($('ticker').value.trim().toUpperCase() !== T) return; // ticker changed while we waited
    const s = await res.json().catch(()=>({}));
    if (!res.ok || !isFinite(s.vol)) {
      const why = s.error==='unknown_symbol' ? `Couldn't find "${esc(T)}".`
        : s.error==='insufficient_history' ? `${esc(T)} has less than a year of price history.`
        : s.error==='rate_limited' ? 'Too many lookups, try again in a minute.'
        : `Couldn't load price history for ${esc(T)}.`;
      return applyFallback(T, why);
    }
    lastStats = s;
    $('stkVol').value = Math.round(s.vol*100);
    const tr = s.trailingReturn;
    setVolNote(`Based on ${s.years} years of weekly price history (to ${esc(s.asOf)}).` +
      (isFinite(tr) ? ` ${esc(T)} returned ${tr>=0?'+':''}${(tr*100).toFixed(1)}%/yr over that time. That's shown for context only and isn't used as the expected return, because past winners rarely repeat at the same pace.` : ''));
    resetRhos();
  } catch(_) {
    if ($('ticker').value.trim().toUpperCase() === T) applyFallback(T, `Couldn't load price history for ${esc(T)}.`);
  } finally { clearTimeout(timer); }
}
$('ticker').addEventListener('change', () => { pendingLookup = lookupTicker().finally(()=>{ pendingLookup=null; }); });

/* ---------- destinations UI ---------- */
function weightSum(){ const sum = dests.reduce((s,d)=>s+(num(d.w)||0),0); const el=$('wsum'); el.textContent=`Total: ${Math.round(sum)}%`; el.classList.toggle('bad', Math.abs(sum-100)>0.5); }
function renderDests(){
  $('dests').innerHTML = dests.map((d,i)=>`
    <div class="dest"><select data-di="${i}" data-f="k" aria-label="Destination">${Object.entries(DEST).map(([k,v])=>`<option value="${k}" ${k===d.k?'selected':''}>${v.label}</option>`).join('')}</select>
      <input data-di="${i}" data-f="w" inputmode="decimal" value="${esc(d.w)}" aria-label="Weight percent">
      <button type="button" class="x" data-del="${i}" aria-label="Remove" ${dests.length<2?'disabled':''}>✕</button></div>
    ${d.k==='custom' ? `<div class="destcustom"><label class="f">Expected return %<input data-di="${i}" data-f="mu" inputmode="decimal" value="${esc(d.mu??DEST.custom.mu)}"></label><label class="f">Volatility %<input data-di="${i}" data-f="vol" inputmode="decimal" value="${esc(d.vol??DEST.custom.vol)}"></label></div>`:''}`).join('');
  $('rhoList').innerHTML = dests.map((d,i)=>{ if (d.rho===undefined){ const r=rhoFor(d.k); d.rho=r.rho; d.rhoSrc=r.src; }
    return `<label class="f rho">${esc(DEST[d.k].label.split(' (')[0])} <small>${d.rhoSrc==='measured'?'Measured':d.rhoSrc==='user'?'Your value':'Typical'}</small><input data-di="${i}" data-f="rho" inputmode="decimal" value="${esc(d.rho)}" aria-label="Correlation with your stock"></label>`; }).join('');
  weightSum();
}
function onDestInput(e){ const i=e.target.dataset.di; if (i===undefined) return; const f=e.target.dataset.f; dests[i][f]=e.target.value; if (f==='rho') dests[i].rhoSrc='user'; if (f==='w') weightSum(); }
$('dests').addEventListener('input', onDestInput);
$('rhoList').addEventListener('input', onDestInput);
$('dests').addEventListener('change', e => { if (e.target.dataset.f==='k'){ const d=dests[e.target.dataset.di]; d.k=e.target.value; const r=rhoFor(d.k); d.rho=r.rho; d.rhoSrc=r.src; renderDests(); } });
$('dests').addEventListener('click', e => { const b=e.target.closest('[data-del]'); if (!b) return; dests.splice(+b.dataset.del,1); renderDests(); });
$('addDest').onclick = () => { if (dests.length>=5) return toast('Up to 5 destinations'); const used=new Set(dests.map(d=>d.k)); const k=['intl','gold','bond','div','cash','voo','bal'].find(x=>!used.has(x))||'custom'; dests.push({k,w:0}); renderDests(); };

/* ---------- state: URL, storage ---------- */
function readForm(){ const o={}; FIELDS.forEach(f=>o[f]=$(f).value); o.dests=dests.map(d=>({...d})); o.volNote=$('volNote').innerHTML; return o; }
function fillForm(o){
  FIELDS.forEach(f=>{ if (o[f]!==undefined && o[f]!==null) $(f).value = (typeof o[f]==='number' && Math.abs(o[f])>=1000) ? o[f].toLocaleString() : o[f]; });
  if (Array.isArray(o.dests) && o.dests.length) dests=o.dests.filter(d=>DEST[d.k]).slice(0,5);
  // The note is our own escaped HTML from an earlier lookup; links don't carry it.
  if (typeof o.volNote==='string') $('volNote').innerHTML = o.volNote;
  renderDests();
}
function toQuery(o){ const p=new URLSearchParams(); FIELDS.forEach(f=>{ if (o[f]!=='' && o[f]!==undefined) p.set(f,String(o[f]).replace(/,/g,'')); }); p.set('d',o.dests.map(d=>[d.k,num(d.w)||0,d.k==='custom'?num(d.mu):'',d.k==='custom'?num(d.vol):'',isFinite(num(d.rho))?num(d.rho):''].join(':')).join('|')); return p.toString(); }
function fromQuery(){ try { const p=new URLSearchParams(location.search); if (!p.has('value')) return null; const o={}; FIELDS.forEach(f=>{ if (p.has(f)) o[f]=p.get(f); }); if (p.has('d')) o.dests=p.get('d').split('|').map(s=>{ const [k,w,mu,vol,rho]=s.split(':'); const d={k,w:num(w)||0}; if (k==='custom'){ d.mu=num(mu); d.vol=num(vol); } if (isFinite(num(rho))){ d.rho=num(rho); d.rhoSrc='user'; } return d; }); return o; } catch(_){ return null; } }
const LS='finnpath-rsu-selldown-v1';
function save(o){ try{ localStorage.setItem(LS, JSON.stringify(o)); }catch(_){} }
function load(){ try{ return JSON.parse(localStorage.getItem(LS)||'null'); }catch(_){ return null; } }

/* ---------- validation ---------- */
function params(){
  const o=readForm(), errs=[]; document.querySelectorAll('.rsu input.bad').forEach(x=>x.classList.remove('bad'));
  const need = (id,min,max,label) => { const v=num($(id).value); if (!isFinite(v) || v<min || v>max){ $(id).classList.add('bad'); errs.push(label); return null; } return v; };
  const p = {
    value:need('value',1,1e10,'position value'), basis:need('basis',0,1e10,'cost basis'),
    vests:isFinite(num($('vests').value)) ? need('vests',0,1e9,'vests per year') : 0,
    vestYears:isFinite(num($('vestYears').value)) ? need('vestYears',0,40,'vest years') : 0,
    sellVests:$('sellVests').value==='1', sellYears:need('sellYears',1,20,'selldown years'), keepPct:isFinite(num($('keepPct').value))?need('keepPct',0,100,'keep %'):0,
    horizon:need('horizon',1,40,'look-ahead years'), stkMu:need('stkMu',-20,40,'stock return')/100, stkVol:need('stkVol',1,150,'stock volatility')/100, sims:+$('sims').value,
    tax:(+$('fedRate').value + ($('niit').value==='1'?3.8:0) + (isFinite(num($('stateRate').value))?Math.max(0,Math.min(15,num($('stateRate').value))):0))/100
  };
  const wsum = dests.reduce((s,d)=>s+(num(d.w)||0),0);
  if (Math.abs(wsum-100)>0.5) errs.push('destination weights must add to 100%');
  document.querySelectorAll('#rhoList input').forEach(el=>{ const v=num(el.value); if (!isFinite(v)||v<-1||v>1){ el.classList.add('bad'); if (!errs.includes('correlations (−1 to 1)')) errs.push('correlations (−1 to 1)'); } });
  p.dests = dests.filter(d=>(num(d.w)||0)>0).map(d=>{ const base=DEST[d.k]; const mu=d.k==='custom'&&isFinite(num(d.mu))?num(d.mu):base.mu, vol=d.k==='custom'&&isFinite(num(d.vol))?num(d.vol):base.vol; const rho=isFinite(num(d.rho))?Math.max(-1,Math.min(1,num(d.rho))):base.rho; return {key:d.k,label:base.label,color:base.color,cls:base.cls,rho,w:(num(d.w)||0)/100,mu:mu/100,vol:Math.max(.1,vol)/100}; });
  if (!p.dests.length) errs.push('at least one destination');
  if (p.value && p.basis!==null && p.basis > p.value*5) errs.push('cost basis looks too high');
  $('formErr').textContent = errs.length ? 'Check: '+errs.join(', ') : '';
  $('formErr').classList.toggle('bad', errs.length>0);
  if (errs.length) return null;
  p.startAfterTax = p.value - Math.max(0,p.value-p.basis)*p.tax;
  p.putIn = p.startAfterTax + p.vests*Math.min(p.vestYears,p.horizon);
  p.raw = o; return p;
}

/* ---------- charts ---------- */
const charts={};
function mk(id,cfg){ if (charts[id]) charts[id].destroy(); if (!window.Chart) return; charts[id]=new Chart($(id),cfg); }
function opts(extra={}){ const m=cssv('--muted'), l=cssv('--line'); return Object.assign({responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},
  plugins:{legend:{labels:{color:m,boxWidth:10,font:{size:12}}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${fmt(c.parsed.y)}`}}},
  scales:{x:{ticks:{color:m},grid:{color:l}},y:{ticks:{color:m,callback:v=>fmt(v)},grid:{color:l}}}},extra); }

/* ---------- render ---------- */
function render(p, r){
  const name = esc((p.raw.ticker||'').toUpperCase()) || 'your stock';
  const n = Math.round(p.sellYears), C = {hold:cssv('--hold'),plan:cssv('--plan'),now:cssv('--now')};
  const L = {hold:`Hold all ${name}`, plan:`Sell over ${n} yr${n>1?'s':''}${p.keepPct?`, keep ${p.keepPct}%`:''}`, now:`Sell now${p.keepPct?`, keep ${p.keepPct}%`:''}`};
  document.querySelectorAll('.hz').forEach(e=>e.textContent=p.horizon);
  const protect = r.plan.p10 - r.hold.p10, giveUp = r.hold.p90 - r.plan.p90;
  $('verdict').innerHTML = `In ${pctf(r.planBeats)} of simulated markets your plan ended with as much or more than holding. In a bad market (worst 10%), diversifying left you <b>${fmt(Math.abs(protect))} ${protect>=0?'better':'worse'} off</b>. In a great market (best 10%), holding came out ${fmt(Math.abs(giveUp))} ${giveUp>=0?'ahead':'behind'}. That's the trade-off: some upside for a much smaller downside.`;
  $('kpis').innerHTML = [
    ['Plan matches or beats holding', pctf(r.planBeats), 'of simulated markets', 'hero'],
    ['Bad case: plan vs hold', `<span class="${protect>=0?'good':'bad'}">${protect>=0?'+':''}${fmt(protect)}</span>`, 'after tax, worst 10%'],
    ['Chance of a 50%+ drop: hold', `<span class="bad">${pctf(r.hold.dd50)}</span>`, 'from a peak, at some point'],
    ['Chance of a 50%+ drop: plan', pctf(r.plan.dd50), 'from a peak, at some point']
  ].map(([l,v,s,c])=>`<div class="kpi ${c||''}"><div class="l">${l}</div><div class="v">${v}</div><div class="n">${s}</div></div>`).join('');
  $('outTable').innerHTML = `<tr><th>Strategy</th><th>Bad case</th><th>Typical</th><th>Great case</th><th>Ends below what you put in</th></tr>` +
    ['hold','plan','now'].map(k=>`<tr><td><span class="dot" style="background:${C[k]}"></span>${L[k]}</td><td>${fmt(r[k].p10)}</td><td>${fmt(r[k].p50)}</td><td>${fmt(r[k].p90)}</td><td>${pctf(r[k].loss)}</td></tr>`).join('') +
    `<tr><td colspan="5" class="foot">Today's after-tax value: ${fmt(p.startAfterTax)}. ${p.vests && p.vestYears ? `Plus ${fmt(p.vests)}/yr of new vests for ${Math.min(p.vestYears,p.horizon)} years, ${fmt(p.putIn)} put in overall.` : ''}</td></tr>`;

  const yrs = Array.from({length:p.horizon},(_,i)=>`Yr ${i+1}`), ds=[];
  ['hold','plan','now'].forEach(k=>{ ds.push({label:L[k],data:r[k].byYear.map(b=>b.p50),borderColor:C[k],backgroundColor:C[k],pointRadius:0,borderWidth:2.5,tension:.25}); ds.push({label:L[k]+' (bad case)',data:r[k].byYear.map(b=>b.p10),borderColor:C[k],borderDash:[5,4],pointRadius:0,borderWidth:1.5,tension:.25}); });
  const po = opts(); po.plugins.legend.labels.filter = it => !it.text.includes('(bad case)'); mk('chPaths',{type:'line',data:{labels:yrs,datasets:ds},options:po});

  const all = r.hold.raw.concat(r.plan.raw).sort((a,b)=>a-b), lo = pct(all,.01), hi = pct(all,.97), bins=30, w=(hi-lo)/bins;
  const hist = k => { const h=Array(bins).fill(0); r[k].raw.forEach(v=>{ const i=Math.min(bins-1,Math.max(0,Math.floor((v-lo)/w))); h[i]++; }); return h.map(x=>x/r[k].raw.length*100); };
  const ho = opts({interaction:{mode:'index',intersect:false}}); ho.scales.y.ticks.callback = v=>v+'%'; ho.scales.x.ticks.maxTicksLimit = 6; ho.plugins.tooltip={callbacks:{title:c=>{ const i=c[0].dataIndex; return i===0 ? `${fmt(lo+w)} or less` : i===bins-1 ? `${fmt(lo+i*w)} or more` : `${fmt(lo+i*w)}–${fmt(lo+(i+1)*w)}`; },label:c=>`${c.dataset.label}: ${c.parsed.y.toFixed(1)}% of markets`}};
  mk('chHist',{type:'bar',data:{labels:Array.from({length:bins},(_,i)=>fmt(lo+(i+.5)*w)),datasets:[{label:L.hold,data:hist('hold'),backgroundColor:C.hold+'aa',barPercentage:1,categoryPercentage:1},{label:L.plan,data:hist('plan'),backgroundColor:C.plan+'aa',barPercentage:1,categoryPercentage:1}]},options:ho});

  // deterministic schedule at today's price
  const keepAmt = p.value*p.keepPct/100; let Sv=p.value, Sb=p.basis; const rows=[]; const Y=new Date().getFullYear();
  for (let y=0;y<Math.max(n, p.sellVests ? Math.min(p.vestYears,p.horizon) : 0);y++){
    let sale=0, gain=0, tax=0;
    if (y<n && Sv>keepAmt){ sale=(Sv-keepAmt)/(n-y); const bs=Sb*(sale/Sv); gain=sale-bs; tax=Math.max(0,gain)*p.tax; Sv-=sale; Sb-=bs; }
    const vest = (p.sellVests && y<p.vestYears) ? p.vests : 0;
    if (!sale && !vest) continue;
    rows.push({yr:Y+y, sale, vest, gain, tax, invest:sale-tax+vest});
  }
  const tot = k => rows.reduce((s,x)=>s+x[k],0);
  $('sched').innerHTML = `<tr><th>Year</th><th>Sell existing</th><th>Sell new vests</th><th>Gain</th><th>Est. tax</th><th>Invested</th></tr>` +
    rows.map(x=>`<tr><td>${x.yr}</td><td>${fmt(x.sale)}</td><td>${fmt(x.vest)}</td><td>${fmt(x.gain)}</td><td>${fmt(x.tax)}</td><td>${fmt(x.invest)}</td></tr>`).join('') +
    `<tr><td><b>Total</b></td><td><b>${fmt(tot('sale'))}</b></td><td><b>${fmt(tot('vest'))}</b></td><td><b>${fmt(tot('gain'))}</b></td><td><b>${fmt(tot('tax'))}</b></td><td><b>${fmt(tot('invest'))}</b></td></tr>` +
    p.dests.map(d=>`<tr><td class="sub-row"><span class="dot" style="background:${d.color}"></span>→ ${esc(d.label.split(' (')[0])} (${Math.round(d.w*100)}%)</td><td colspan="4"></td><td>${fmt(tot('invest')*d.w)}</td></tr>`).join('');

  const fo = opts(); fo.scales.x.stacked=true; fo.scales.y.stacked=true;
  mk('chFlow',{type:'bar',data:{labels:rows.map(x=>x.yr),datasets:[
    ...p.dests.map(d=>({label:'→ '+d.label.split(' (')[0],data:rows.map(x=>(x.sale-x.tax)*d.w + x.vest*d.w),backgroundColor:d.color})),
    {label:'Tax paid',data:rows.map(x=>x.tax),backgroundColor:cssv('--tax')}]},options:fo});
  const B = r.blend;
  $('mixSub').innerHTML = `Blended assumption: ${(B.mu*100).toFixed(1)}% expected return, ${(B.vol*100).toFixed(1)}% volatility. It tends to move ${B.rho>.6?'closely':B.rho>.3?'somewhat':'only loosely'} with ${name} (correlation ${B.rho.toFixed(2)}). A lower correlation means it diversifies more.`;
  mk('chMix',{type:'doughnut',data:{labels:p.dests.map(d=>d.label.split(' (')[0]),datasets:[{data:p.dests.map(d=>d.w*100),backgroundColor:p.dests.map(d=>d.color),borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,cutout:'60%',plugins:{legend:{position:'bottom',labels:{color:cssv('--muted'),boxWidth:10}},tooltip:{callbacks:{label:c=>`${c.label}: ${c.parsed.toFixed(0)}%`}}}}});
}

/* ---------- events ---------- */
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  if (pendingLookup) { $('run').textContent='Looking up…'; await pendingLookup; }
  const p=params(); if (!p) { $('run').textContent='Run the simulation'; return; }
  $('run').textContent='Running…';
  setTimeout(()=>{ const r=runSelldown(p); $('results').style.display='block'; render(p,r); save(p.raw); $('run').textContent='Run the simulation'; $('results').scrollIntoView({behavior:'smooth',block:'start'}); }, 30);
});
$('share').onclick = async () => { const url = location.origin + location.pathname + '?' + toQuery(readForm()); try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone with it sees this scenario.'); } catch(_){ toast('Copy failed. Your browser blocked the clipboard.'); } };
document.querySelectorAll('.rsu input[inputmode="decimal"]').forEach(el=>el.addEventListener('blur',()=>{ const v=num(el.value); if (isFinite(v) && Math.abs(v)>=1000) el.value=Math.round(v).toLocaleString(); }));
$('ctaLink').href = SUBSCRIBE_URL;

/* ---------- mobile nav (same behavior as the other site pages) ---------- */
(function(){
  const burger=document.querySelector('.nav-burger'), links=document.querySelector('.nav-links'), backdrop=document.querySelector('.nav-backdrop');
  if (!burger || !links) return;
  const closeNav = () => { links.classList.remove('open'); burger.classList.remove('open'); backdrop && backdrop.classList.remove('open'); document.body.classList.remove('nav-open'); };
  burger.addEventListener('click', () => { const open=links.classList.toggle('open'); burger.classList.toggle('open',open); backdrop && backdrop.classList.toggle('open',open); document.body.classList.toggle('nav-open',open); });
  backdrop && backdrop.addEventListener('click', closeNav);
  links.querySelectorAll('a').forEach(a=>a.addEventListener('click', closeNav));
  const checkPos = () => { if (window.innerWidth<=720){ if (links.parentNode!==document.body) document.body.appendChild(links); } else if (links.parentNode===document.body){ document.querySelector('nav').insertBefore(links, burger); closeNav(); } };
  checkPos(); window.addEventListener('resize', () => { if (window.innerWidth>720) closeNav(); checkPos(); });
})();

/* ---------- init ---------- */
const fromLink = fromQuery();
fillForm(Object.assign({}, DEFAULTS, load()||{}, fromLink||{}));
if (fromLink) { setVolNote(''); $('form').requestSubmit(); }
