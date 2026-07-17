// ── Cloudflare Web Analytics ──
// One place to set the token, loaded on every page.
// Get yours (2 min): Cloudflare dashboard → Analytics & Logs → Web Analytics
//   → "Add a site" → enter finnpath.com → copy the token from the snippet it shows.
// Paste it below (replace REPLACE_WITH_YOUR_CF_TOKEN). Until then this no-ops,
// so it's safe to ship — no failed requests, nothing recorded.
(function () {
  var TOKEN = "REPLACE_WITH_YOUR_CF_TOKEN";
  if (TOKEN.indexOf("REPLACE_WITH") === 0) return; // not configured yet
  var s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: TOKEN }));
  document.head.appendChild(s);
})();
