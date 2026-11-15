// ⓘ explainers shared by the tool pages. Markup: <button class="info" aria-controls="tip-x" aria-expanded="false"> + <span class="tip" id="tip-x" hidden>.
function closeTips(except){ document.querySelectorAll('button.info[aria-expanded="true"]').forEach(b=>{ if (b===except) return; b.setAttribute('aria-expanded','false'); document.getElementById(b.getAttribute('aria-controls')).hidden=true; }); }
document.addEventListener('click', e => {
  const b = e.target.closest('button.info');
  if (!b){ if (!e.target.closest('.tip[id^="tip-"]')) closeTips(); return; }
  e.preventDefault();
  const open = b.getAttribute('aria-expanded')!=='true';
  closeTips(b); b.setAttribute('aria-expanded', String(open)); document.getElementById(b.getAttribute('aria-controls')).hidden=!open;
});
document.addEventListener('keydown', e => { if (e.key==='Escape') closeTips(); });
