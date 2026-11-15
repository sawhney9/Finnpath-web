// Cloudflare Worker — HTTP-based approval flow for finnpath blog drafts.
// GET  /approve/{token} → splices the article into blog.html's ARTICLES array
//                         and commits directly to GitHub (Cloudflare Pages
//                         picks up the push; a separate GH Action rebuilds the
//                         static /blog/*.html SEO pages).
// GET  /skip/{token}    → discards the draft
// GET  /edit/{token}    → serves a change-request form
// POST /edit/{token}    → asks Gemini to revise the draft, emails it again
//
// Modeled on the SelfHealthLiving shl-approval Worker.

import MODELS from '../../config/models.json';

// Fill in after the first `wrangler deploy` (it prints this URL) — or your own
// custom route/domain if you set one up for this Worker.
const WORKER_URL = 'https://finnpath-approval.rimas2043.workers.dev'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const action = parts[0]
    const token = parts[1]

    if (!action || !token) return page('<h1>Finnpath Content Review</h1><p>Nothing here.</p>')

    const draft = await env.DRAFTS.get(`draft:${token}`, 'json')
    if (!draft) return page('<h1>Not Found</h1><p>This link has already been used or expired.</p>', 404)

    if (action === 'approve') return request.method === 'POST' ? handleApprove(draft, token, env) : serveApproveConfirm(draft)
    if (action === 'skip') return handleSkip(draft, token, env)
    if (action === 'edit') {
      if (request.method === 'POST') return handleEditPost(request, draft, token, env)
      return serveEditForm(draft, token)
    }

    return page('Unknown action', 400)
  },
}

// ── base64 helpers that round-trip UTF-8 (emoji, etc.) correctly ────────────
function b64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// ── serialize an article object exactly like the old agent's inject_article() ──
// Both escape '<' as \x3C so text like "</script>" can't close blog.html's <script> block.
function jsString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n').replace(/</g, '\\x3C')}'`
}

function jsTemplate(s) {
  return `\`${String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/</g, '\\x3C')}\``
}

function serializeArticle(a) {
  return `  {
    id: ${jsString(a.id)},
    category: ${jsString(a.category)},
    catLabel: ${jsString(a.catLabel)},
    catClass: ${jsString(a.catClass)},
    emoji: ${jsString(a.emoji)},
    title: ${jsString(a.title)},
    excerpt: ${jsString(a.excerpt)},
    readTime: ${jsString(a.readTime)},
    author: ${jsString(a.author)},
    authorEmoji: ${jsString(a.authorEmoji)},
    authorRole: ${jsString(a.authorRole)},
    date: ${jsString(a.date)},
    large: false,
    imageUrl: ${jsString(a.imageUrl || '')},
    content: ${jsTemplate(a.content)}
  },\n`
}

async function githubGetFile(path, env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Finnpath-Content-Agent/1.0',
      },
    }
  )
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function githubPutFile(path, content, sha, message, env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Finnpath-Content-Agent/1.0',
      },
      body: JSON.stringify({ message, content: utf8ToB64(content), sha }),
    }
  )
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function handleApprove(draft, token, env) {
  const article = await sanitizeArticle(draft.article)
  const MARKER = 'const ARTICLES = [\n'

  try {
    const file = await githubGetFile('blog.html', env)
    const html = b64ToUtf8(file.content)

    const idx = html.indexOf(MARKER)
    if (idx === -1) throw new Error('ARTICLES array marker not found in blog.html')

    const insertAt = idx + MARKER.length
    const updated = html.slice(0, insertAt) + serializeArticle(article) + html.slice(insertAt)

    await githubPutFile('blog.html', updated, file.sha, `content: publish "${article.title}"`, env)
  } catch (err) {
    console.error(`Publish failed: ${err.message}`)
    return page(`<h1>Publish Failed</h1><p>${escHtml(err.message)}</p>`, 500)
  }

  await env.DRAFTS.delete(`draft:${token}`)

  return page(`
    <h1 style="color:#16a34a">✅ Published!</h1>
    <p><strong>${escHtml(article.title)}</strong></p>
    <p>Committed to blog.html. Cloudflare Pages will redeploy in ~1 minute, and the
    SEO page rebuild Action will follow shortly after.</p>
    <p><a href="https://finnpath.com/blog/${article.id}">View live post →</a></p>
  `)
}

async function handleSkip(draft, token, env) {
  await env.DRAFTS.delete(`draft:${token}`)
  return page(`<h1>Skipped</h1><p>"${escHtml(draft.article.title)}" has been discarded.</p>`)
}

function serveEditForm(draft, token) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Request Changes</title>
<style>
  body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 20px}
  h1{color:#111}p.sub{color:#666;font-size:14px;margin-bottom:20px}
  textarea{width:100%;height:160px;padding:12px;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
  button{background:#0B5FFF;color:white;border:none;padding:12px 28px;font-size:16px;border-radius:6px;cursor:pointer;margin-top:12px}
</style></head><body>
  <h1>Request Changes</h1>
  <p class="sub">Post: <strong>${escHtml(draft.article.title)}</strong></p>
  <form method="POST">
    <textarea name="notes" placeholder="e.g. Make the intro punchier, add a concrete dollar example, shorten the conclusion" required></textarea>
    <br><button type="submit">Send for Revision →</button>
  </form>
</body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  )
}

async function handleEditPost(request, draft, token, env) {
  const formData = await request.formData()
  const notes = formData.get('notes')?.trim()
  if (!notes) return page('No notes provided.', 400)

  const { article } = draft
  const revisionNumber = (draft.revisionNumber || 0) + 1

  const prompt = `Here is a Finnpath financial blog article draft:

Title: ${article.title}
Excerpt: ${article.excerpt}
Content: ${article.content}

Editor notes: "${notes}"

Return ONLY a JSON object with updated "title", "excerpt", "readTime", and "content" fields. Keep the same HTML tag restrictions as the original (only <h3>, <p>, <ul class="article-list">, <li>, <div class="article-callout"><p>...</p></div>).`

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini_writer}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  )

  if (!geminiRes.ok) {
    return page(`<h1>Revision Failed</h1><p>Gemini API error: ${geminiRes.status}</p>`, 500)
  }

  const geminiData = await geminiRes.json()
  let revised
  try {
    const text = geminiData.candidates[0].content.parts[0].text
    revised = JSON.parse(text)
  } catch {
    return page('<h1>Revision Failed</h1><p>Could not parse Gemini response.</p>', 500)
  }

  const updatedArticle = { ...article, ...revised }
  const updatedDraft = { ...draft, article: updatedArticle, revisionNumber }
  await env.DRAFTS.put(`draft:${token}`, JSON.stringify(updatedDraft))

  await sendRevisionEmail(updatedArticle, token, revisionNumber, env)

  return page(`<h1 style="color:#16a34a">✅ Revision Sent</h1><p>Check <strong>${env.REVIEW_EMAIL}</strong> for the updated draft.</p>`)
}

function actionButtons(token) {
  return `<div style="display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap;">
  <a href="${WORKER_URL}/approve/${token}" style="background:#16a34a;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">✅ Approve &amp; Publish</a>
  <a href="${WORKER_URL}/edit/${token}" style="background:#0B5FFF;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">✏️ Request Changes</a>
  <a href="${WORKER_URL}/skip/${token}" style="background:#6b7280;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Skip</a>
</div>`
}

async function sendRevisionEmail(article, token, revisionNumber, env) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;">
<h2 style="color:#0B5FFF">Revision ${revisionNumber}: ${article.title}</h2>
${actionButtons(token)}
<div style="line-height:1.7;">${article.content}</div>
<hr style="margin-top:32px;border-color:#e5e7eb">
<p style="color:#999;font-size:11px">Token: ${token}</p>
</body></html>`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Finnpath Content <content@finnpath.com>',
      to: env.REVIEW_EMAIL,
      subject: `[Finnpath v${revisionNumber}] ${article.title}`,
      html,
    }),
  })
}

function page(body, status = 200) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;max-width:640px;margin:60px auto;padding:0 20px}a{color:#0B5FFF}</style></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html' } }
  )
}

// Email link scanners can open links on their own, so a plain GET never publishes.
function serveApproveConfirm(draft) {
  return page(`<h1>Publish this post?</h1>
  <p><strong>${escHtml(draft.article.title)}</strong></p>
  <form method="POST"><button type="submit" style="background:#16a34a;color:#fff;border:0;padding:12px 26px;font-size:16px;border-radius:6px;cursor:pointer">Publish to finnpath.com</button></form>`)
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Article HTML comes from the model, so only the tags and attributes real posts use survive.
const KEEP_TAGS = new Set(['p', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'h3', 'h4', 'br', 'a', 'div', 'span', 'blockquote'])
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'form', 'textarea', 'select'])
const SAFE_CLASS = /^[a-z0-9 _-]{1,80}$/i
// Stat callouts color their number with a theme token, e.g. style="color:var(--sky)".
const SAFE_STYLE = /^color:\s*var\(--[a-z-]+\);?$/i
// http(s) links, or site-relative ones like "simulator.html" / "/tools/x" / "#id"; no other schemes.
const safeHref = v => { const h = v.trim(); return /^https?:\/\//i.test(h) || (!/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('//') && !/[\s"'<>]/.test(h)) }

async function sanitizeHtml(html) {
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase()
        if (DROP_WITH_CONTENT.has(tag)) return el.remove()
        if (!KEEP_TAGS.has(tag)) return el.removeAndKeepContent()
        for (const [name, value] of [...el.attributes]) {
          const ok = (name === 'class' && SAFE_CLASS.test(value))
            || (name === 'href' && tag === 'a' && safeHref(value))
            || (name === 'style' && SAFE_STYLE.test(value.trim()))
            || (name === 'data-chart' && tag === 'div')
          if (!ok) el.removeAttribute(name)
        }
        if (tag === 'a') el.setAttribute('rel', 'noopener')
      },
    })
    .onDocument({ comments(c) { c.remove() } })
  return rewriter.transform(new Response(String(html ?? ''))).text()
}

const plain = s => String(s ?? '').replace(/[<>]/g, '').trim()
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80)

async function sanitizeArticle(a) {
  return {
    ...a,
    id: slug(a.id), category: slug(a.category), catClass: slug(a.catClass),
    catLabel: plain(a.catLabel), emoji: plain(a.emoji), title: plain(a.title), excerpt: plain(a.excerpt),
    readTime: plain(a.readTime), author: plain(a.author), authorEmoji: plain(a.authorEmoji),
    authorRole: plain(a.authorRole), date: plain(a.date),
    imageUrl: /^https:\/\//i.test(String(a.imageUrl || '')) ? String(a.imageUrl).replace(/["'<>\s]/g, '') : '',
    content: await sanitizeHtml(a.content),
  }
}
