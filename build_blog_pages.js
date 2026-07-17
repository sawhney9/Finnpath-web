#!/usr/bin/env node
/*
 * build_blog_pages.js — turn the blog.html ARTICLES array into indexable pages.
 *
 * Each article lived only inside a JS modal on blog.html, so it had no URL, could
 * not be shared, and Google saw one page instead of dozens. This emits one static
 * SEO-complete page per article, plus sitemap.xml and robots.txt.
 *
 * Source of truth is the ARTICLES array in blog.html. The chart <script> is lifted
 * verbatim from blog.html so chart behaviour never drifts between the two.
 *
 * Run: node build_blog_pages.js   (safe to re-run; overwrites blog/ pages)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SITE = 'https://finnpath.com';
const BLOG = path.join(ROOT, 'blog.html');
const OUT_DIR = path.join(ROOT, 'blog');

const html = fs.readFileSync(BLOG, 'utf8');

// ── Parse the ARTICLES array by letting Node's own parser eval it ──────────────
function extractArticles(src) {
  const marker = 'const ARTICLES = [';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('ARTICLES array not found in blog.html');
  // Walk from the opening [ to its matching ] so array contents can't fool us.
  let i = src.indexOf('[', start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end === -1) throw new Error('Could not find end of ARTICLES array');
  // eslint-disable-next-line no-eval
  return eval(src.slice(i, end + 1));
}

// ── Lift the chart script (CHART_SERIES + money + renderArticleCharts) ─────────
function extractChartScript(src) {
  const start = src.indexOf('const CHART_SERIES');
  if (start === -1) return '';
  const end = src.indexOf('</script>', start);
  return src.slice(start, end).trim();
}

const articles = extractArticles(html);
const chartScript = extractChartScript(html);

// ── Small helpers ─────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const NAV = `<nav>
  <a href="../index.html" class="logo">Finnpath<span class="logo-dot">.</span></a>
  <ul class="nav-links">
    <li><a href="../index.html">Home</a></li>
    <li><a href="../learn.html">Learn</a></li>
    <li class="nav-dropdown">
      <a href="#" class="nav-dropdown-toggle">Tools <span class="nav-caret">▾</span></a>
      <div class="nav-dropdown-menu">
        <a href="../calculator.html">🧮 Calculator</a>
        <a href="../simulator.html">📈 Portfolio Tracker</a>
        <a href="../401k.html">📄 401k Decoder</a>
        <a href="../roth.html">🏦 Roth IRA Guide</a>
        <a href="../tool-debt.html">💳 Debt Planner</a>
      </div>
    </li>
    <li><a href="../paths.html">Your Path</a></li>
    <li><a href="../blog.html">Money Moves</a></li>
  </ul>
  <a href="../simulator.html" class="nav-cta">Track Portfolio →</a>
</nav>`;

const FOOTER = `<footer class="site-footer">
  <div class="footer-inner">
    <div>
      <div class="f-logo">Finnpath<span>.</span></div>
      <p class="f-tagline">Financial education for every stage of life.</p>
    </div>
    <nav class="footer-nav">
      <a href="../index.html">Home</a>
      <a href="../learn.html">Learn</a>
      <a href="../calculator.html">Calculator</a>
      <a href="../simulator.html">Simulator</a>
      <a href="../blog.html">Money Moves</a>
      <a href="../paths.html">Your Path</a>
      <a href="../compete.html">Compete</a>
    </nav>
  </div>
  <div class="footer-bottom">
    <span class="footer-copy">© 2025 Finnpath · finnpath.com</span>
    <p class="disclaimer">For educational and informational purposes only. Not financial, investment, or tax advice. Always consult a qualified financial advisor before making investment decisions.</p>
  </div>
</footer>`;

// Article-body + chart CSS, matched to blog.html's modal styling.
const STYLE = `<style>
  .article-wrap { max-width: 760px; margin: 0 auto; padding: 120px 24px 60px; }
  .article-back { display:inline-block; color:var(--white-dim); font-size:.8rem; text-decoration:none; margin-bottom:24px; }
  .article-back:hover { color:var(--coral); }
  .article-hero-img { width:100%; height:280px; object-fit:cover; border-radius:var(--radius); margin-bottom:28px; }
  .article-head .cat-tag { font-size:.7rem; padding:4px 10px; border-radius:20px; }
  .article-head h1 { font-size:2rem; line-height:1.2; color:var(--white); margin:14px 0 12px; font-weight:700; }
  .article-excerpt { font-size:1.05rem; color:var(--white-dim); line-height:1.6; margin-bottom:20px; font-weight:300; }
  .article-byline { display:flex; align-items:center; gap:10px; font-size:.8rem; color:var(--white-dim); padding-bottom:20px; margin-bottom:28px; border-bottom:1px solid var(--border); }
  .article-byline .avatar { width:34px; height:34px; border-radius:50%; background:var(--navy-card); display:flex; align-items:center; justify-content:center; font-size:1.05rem; }
  .article-content { display:flex; flex-direction:column; gap:20px; }
  .article-content h3 { font-size:1.15rem; color:var(--white); font-weight:600; margin-top:8px; }
  .article-content p { font-size:.98rem; color:var(--white-dim); line-height:1.85; font-weight:300; }
  .article-content p strong { color:var(--white); font-weight:600; }
  .article-content p em { font-style:italic; color:var(--coral); }
  .article-callout { background:var(--coral-glow); border-left:3px solid var(--coral); padding:16px 18px; border-radius:8px; }
  .article-callout p { margin:0; font-size:.92rem !important; }
  .article-list { list-style:none; display:flex; flex-direction:column; gap:8px; padding:0; }
  .article-list li { display:flex; gap:10px; font-size:.95rem; color:var(--white-dim); line-height:1.7; font-weight:300; }
  .article-list li::before { content:'→'; color:var(--coral); font-weight:700; flex-shrink:0; margin-top:2px; }
  .article-list li strong { color:var(--white); font-weight:600; }
  .article-disclaimer { margin-top:36px; padding-top:20px; border-top:1px solid var(--border); font-size:.72rem; color:var(--white-dim); font-style:italic; }
  .article-chart { margin:28px 0; padding:18px 16px 12px; background:var(--navy-card); border:1px solid var(--border); border-radius:var(--radius); }
  .article-chart-title { font-size:.82rem; font-weight:600; color:var(--white); margin-bottom:2px; }
  .article-chart-note { font-size:.7rem; color:var(--white-dim); margin-bottom:14px; }
  .article-chart-canvas { position:relative; height:280px; }
  .article-chart table { width:100%; border-collapse:collapse; margin-top:14px; font-size:.72rem; color:var(--white-dim); }
  .article-chart th, .article-chart td { padding:5px 8px; text-align:right; border-top:1px solid var(--border); }
  .article-chart th:first-child, .article-chart td:first-child { text-align:left; }
  .article-chart details { margin-top:10px; }
  .article-chart summary { font-size:.72rem; color:var(--white-dim); cursor:pointer; }
  .related { margin-top:48px; }
  .related h4 { font-size:.9rem; color:var(--white); margin-bottom:14px; }
  .related a { display:block; color:var(--white-dim); text-decoration:none; padding:10px 0; border-top:1px solid var(--border); font-size:.9rem; }
  .related a:hover { color:var(--coral); }
</style>`;

function relatedLinks(article, all) {
  const same = all.filter(a => a.category === article.category && a.id !== article.id).slice(0, 4);
  const pool = same.length ? same : all.filter(a => a.id !== article.id).slice(0, 4);
  if (!pool.length) return '';
  return `<div class="related"><h4>Keep reading</h4>${
    pool.map(a => `<a href="${a.id}.html">${esc(a.title)}</a>`).join('')
  }</div>`;
}

function page(article, all) {
  const url = `${SITE}/blog/${article.id}.html`;
  const img = article.imageUrl || `${SITE}/finnpath-logo.svg`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.excerpt,
    image: img,
    datePublished: article.date,
    author: { '@type': 'Person', name: article.author || 'Finnpath Team' },
    publisher: {
      '@type': 'Organization', name: 'Finnpath',
      logo: { '@type': 'ImageObject', url: `${SITE}/finnpath-logo.svg` },
    },
    mainEntityOfPage: url,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(article.title)} — Finnpath</title>
<meta name="description" content="${esc(article.excerpt)}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:type" content="article"/>
<meta property="og:title" content="${esc(article.title)}"/>
<meta property="og:description" content="${esc(article.excerpt)}"/>
<meta property="og:image" content="${esc(img)}"/>
<meta property="og:url" content="${url}"/>
<meta property="og:site_name" content="Finnpath"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(article.title)}"/>
<meta name="twitter:description" content="${esc(article.excerpt)}"/>
<meta name="twitter:image" content="${esc(img)}"/>
<link rel="icon" href="../favicon.svg"/>
<link rel="stylesheet" href="../shared.css"/>
${STYLE}
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
${NAV}
<article class="article-wrap">
  <a href="../blog.html" class="article-back">← Money Moves</a>
  ${article.imageUrl ? `<img class="article-hero-img" src="${esc(article.imageUrl)}" alt="${esc(article.title)}"/>` : ''}
  <div class="article-head">
    <span class="cat-tag ${esc(article.catClass)}">${esc(article.catLabel)}</span>
    <h1>${esc(article.title)}</h1>
    <p class="article-excerpt">${esc(article.excerpt)}</p>
    <div class="article-byline">
      <span class="avatar">${esc(article.authorEmoji)}</span>
      <span><strong style="color:var(--white)">${esc(article.author)}</strong> · ${esc(article.authorRole)} · ${esc(article.date)} · ${esc(article.readTime)}</span>
    </div>
  </div>
  <div class="article-content">${article.content}</div>
  <div class="article-disclaimer">This article is for educational purposes only and does not constitute financial, investment, or tax advice. Always consult a qualified financial advisor for personalized guidance.</div>
  ${relatedLinks(article, all)}
</article>
${FOOTER}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
${chartScript}
document.addEventListener('DOMContentLoaded', () => renderArticleCharts(document));
</script>
<script src="../newsletter.js"></script>
</body>
</html>`;
}

// ── Emit pages ────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
let written = 0;
for (const a of articles) {
  if (!a.id) continue;
  fs.writeFileSync(path.join(OUT_DIR, `${a.id}.html`), page(a, articles));
  written++;
}

// ── sitemap.xml (main pages + every article) ──────────────────────────────────
const staticPages = [
  '', 'blog.html', 'learn.html', 'paths.html', 'calculator.html',
  'simulator.html', 'compete.html', '401k.html', 'roth.html',
  'tool-debt.html', 'tool-dca.html', 'tool-index.html', 'tool-save.html', 'tools.html',
];
const today = new Date().toISOString().slice(0, 10);
const urls = [
  ...staticPages.map(p => ({ loc: `${SITE}/${p}`, pri: p === '' ? '1.0' : '0.7' })),
  ...articles.filter(a => a.id).map(a => ({ loc: `${SITE}/blog/${a.id}.html`, pri: '0.6' })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);

fs.writeFileSync(path.join(ROOT, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built ${written} article pages + sitemap.xml (${urls.length} urls) + robots.txt`);
