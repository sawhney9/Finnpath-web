// Mobile nav for pages that load ES modules (same behavior as the inline script on the other site pages).
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
