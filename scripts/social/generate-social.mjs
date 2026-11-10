// Turns a newly published Finnpath article into a ready-to-post reel, swipe
// slides and captions (Instagram, TikTok, YouTube Shorts, X), and emails them
// so you can add a trending sound in-app and post by hand.
//
//   node scripts/social/generate-social.mjs <article-id> [<article-id> ...] [--out DIR] [--no-email]
//   node scripts/social/generate-social.mjs --new-since <old-blog.html> [--list-only] [--out DIR]
//
// --new-since compares the ARTICLES array in an older copy of blog.html with the
// current one and processes only articles whose id is new. --list-only prints
// those ids and exits.
//
// Writes with Claude when ANTHROPIC_API_KEY is set, otherwise Gemini (GEMINI_API_KEY).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const SITE = 'https://finnpath.com'
const CLAUDE_MODEL = 'claude-opus-4-8'
const GEMINI_MODEL = 'gemini-3.8-flash'
const BG = '#0a1628'      // Finnpath navy
const ACCENT = '#e8604c'  // Finnpath coral
const FFMPEG = process.env.REEL_FFMPEG || 'ffmpeg'
const DISCLAIMER = 'Education only, not financial advice. Talk to a licensed advisor about your situation.'

// ---- args ------------------------------------------------------------------------
const args = process.argv.slice(2)
const flagValue = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const outRoot = resolve(flagValue('--out') || join(REPO, 'social-out'))
const sinceFile = flagValue('--new-since')
const sendEmail = !args.includes('--no-email')
const valueArgs = new Set([flagValue('--out'), flagValue('--new-since')])
let ids = args.filter(a => !a.startsWith('--') && !valueArgs.has(a))

// ---- articles --------------------------------------------------------------------
function loadArticles(html) {
  const start = html.indexOf('const ARTICLES = [')
  if (start === -1) throw new Error('ARTICLES array not found in blog.html')
  let i = html.indexOf('[', start), depth = 0, end = -1
  for (let j = i; j < html.length; j++) {
    if (html[j] === '[') depth++
    else if (html[j] === ']' && --depth === 0) { end = j; break }
  }
  if (end === -1) throw new Error('Could not find end of ARTICLES array')
  // Same approach as build_blog_pages.js: the array is our own committed source.
  return (0, eval)(html.slice(i, end + 1)).filter(a => a && a.id)
}

const articles = loadArticles(readFileSync(join(REPO, 'blog.html'), 'utf8'))

if (sinceFile) {
  const old = existsSync(sinceFile) ? loadArticles(readFileSync(sinceFile, 'utf8')) : []
  const oldIds = new Set(old.map(a => a.id))
  ids = articles.filter(a => !oldIds.has(a.id)).map(a => a.id)
  if (args.includes('--list-only')) {
    console.log(ids.join(' '))
    process.exit(0)
  }
  console.log(`New articles: ${ids.join(' ') || 'none'}`)
  if (!ids.length) process.exit(0)
}

if (!ids.length) {
  console.error('usage: generate-social.mjs <article-id> [...] [--out DIR] [--no-email] | --new-since <old-blog.html>')
  process.exit(1)
}

const htmlToText = html => String(html)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(p|h[1-6]|li|div|tr)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()

function readArticle(id) {
  const a = articles.find(x => x.id === id)
  if (!a) throw new Error(`Article not found in blog.html: ${id}`)
  return { ...a, body: htmlToText(a.content), url: `${SITE}/blog/${a.id}` }
}

// ---- model -----------------------------------------------------------------------
const SCHEMA = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: { big: { type: 'string' }, small: { type: 'string' } },
        required: ['big', 'small'],
        additionalProperties: false,
      },
    },
    instagram_caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    youtube_title: { type: 'string' },
    youtube_description: { type: 'string' },
    tiktok_caption: { type: 'string' },
    x_post: { type: 'string' },
    x_thread: { type: 'array', items: { type: 'string' } },
  },
  required: ['slides', 'instagram_caption', 'hashtags', 'youtube_title', 'youtube_description',
    'tiktok_caption', 'x_post', 'x_thread'],
  additionalProperties: false,
}

const SYSTEM = 'You turn Finnpath articles into short social posts. Finnpath is a plain-spoken personal-finance ' +
  'publication for people in their 20s and 30s building their first real money habits. Accurate, specific, ' +
  'warm, never hype. You never give personalized investment advice.'

function prompt(a) {
  return `Turn this article into a 5-slide reel plus captions for Instagram, TikTok, YouTube Shorts and X.

SLIDES (exactly 5)
- Slide 1: the hook. The most surprising true thing in the article, readable in under 2 seconds.
- Slides 2 to 4: the three most useful points, one per slide.
- Slide 5: the practical takeaway: what a reader could look into or do next.
- "big": at most 6 words. Use a line break (\\n) to split it into two lines when longer than 3 words. A striking number on its own is fine ("$40,000").
- "small": ONE plain sentence, at most 16 words, backing up the headline.
- No hashtags and no "link in bio" on the slides (added automatically).

ACCURACY
- Use ONLY facts, numbers, dates and claims that appear in the article. Do not add any new fact, statistic, study, fund, ticker or name.
- Keep the article's hedging ("historically", "on average", "could").
- Never tell the reader to buy, sell or hold a specific security, never promise returns, and never predict markets.
- Do not write a disclaimer; one is added automatically.

CAPTIONS
- instagram_caption: first line is a hook that works on its own before "more". Then 2 to 3 short paragraphs. End with: "Full breakdown: link in bio." No hashtags inside it.
- hashtags: 3 to 5 specific hashtags, each starting with #. No generic spam like #money #fyp.
- youtube_title: under 70 characters, curiosity-driven but accurate, ending with " #shorts".
- youtube_description: 2 to 3 sentences, then a line "Read more: ${SITE}/blog".
- tiktok_caption: one or two punchy sentences plus 3 hashtags, under 220 characters.
- x_post: a standalone post for X under 260 characters. Hook plus one concrete number or fact from the article, written like a person, not a brand. No hashtags, no link, no emojis.
- x_thread: 4 or 5 posts, each under 260 characters. Post 1 is the hook and must make people want the rest. The middle posts each carry one specific point from the article. The last post ends with a question that invites replies. No links, no hashtags, no numbering like "1/".
- Plain text only. No emojis except at most one in the Instagram hook line.

ARTICLE
Title: ${a.title}
Category: ${a.catLabel || a.category}

${a.body}`
}

async function askClaude(p) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: p }],
    }),
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const text = data.content?.find(b => b.type === 'text')?.text
  if (!text) throw new Error(`No text in Claude response (stop_reason: ${data.stop_reason})`)
  return JSON.parse(text)
}

async function askGemini(p) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: p }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, temperature: 0.4 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('')
  if (!text) throw new Error('No text in Gemini response')
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
}

const writer = process.env.ANTHROPIC_API_KEY ? 'Claude' : process.env.GEMINI_API_KEY ? 'Gemini' : null
const ask = p => {
  if (!writer) throw new Error('Set ANTHROPIC_API_KEY or GEMINI_API_KEY')
  return writer === 'Claude' ? askClaude(p) : askGemini(p)
}

// Any number in the generated copy that doesn't appear in the article gets flagged.
function unmatchedNumbers(texts, source) {
  const norm = s => s.replace(/,/g, '')
  const src = norm(source)
  const found = new Set()
  for (const t of texts) {
    for (const m of norm(t).matchAll(/\d+(?:\.\d+)?/g)) {
      if (!new RegExp(`(^|[^\\d.])${m[0].replace('.', '\\.')}(?![\\d])`).test(src)) found.add(m[0])
    }
  }
  return [...found]
}

// X counts every character; flag anything that won't fit in a free account's 280.
const overLimit = (label, t) => (t.length > 280 ? [`${label} is ${t.length} characters (X allows 280)`] : [])

// ---- rendering -------------------------------------------------------------------
// Short and snappy: about 2.5–5s per slide so the whole reel lands near 20s.
function readSeconds(s) {
  const words = `${s.big} ${s.small}`.split(/\s+/).length
  return Math.min(5, Math.max(2.5, 1.2 + words * 0.17))
}

function buildSlideReel(slides, slideDir, outFile) {
  const FADE = 0.35
  const durs = slides.map(readSeconds)
  durs[durs.length - 1] += 1.5 // hold the last slide
  const inputs = durs.flatMap((d, i) => [
    '-loop', '1', '-t', String(i < durs.length - 1 ? d + FADE : d), '-i', join(slideDir, `slide-${i + 1}.jpg`),
  ])
  const prep = durs
    .map((_, i) => `[${i}]scale=1080:1350,pad=1080:1920:0:285:color=0x${BG.slice(1)},setsar=1,format=yuv420p,fps=30[v${i}]`)
    .join(';')
  let chain = ''
  let last = 'v0'
  let offset = 0
  for (let i = 1; i < durs.length; i++) {
    offset += durs[i - 1]
    const outLabel = i === durs.length - 1 ? 'outv' : `x${i}`
    chain += `;[${last}][v${i}]xfade=transition=slideleft:duration=${FADE}:offset=${offset.toFixed(2)}[${outLabel}]`
    last = outLabel
  }
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', prep + chain, '-map', '[outv]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', outFile,
  ], { stdio: 'inherit' })
  return durs.reduce((a, b) => a + b, 0)
}

// ---- email -----------------------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function captionText(a, c) {
  return `INSTAGRAM REEL
${c.instagram_caption}

${c.hashtags.join(' ')}

TIKTOK
${c.tiktok_caption}

YOUTUBE SHORTS
Title: ${c.youtube_title}
Description:
${c.youtube_description}

X — SINGLE POST (attach the reel or slide 1)
${c.x_post}

X — REPLY TO YOUR OWN POST
${c.x_link_reply}

X — THREAD (optional, post instead of the single post)
${c.x_thread.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')}

ARTICLE
${a.url}
`
}

function block(label, text) {
  return `<div style="margin:0 0 18px;">
  <div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#6b7280;margin-bottom:6px;">${label}</div>
  <div style="white-space:pre-wrap;background:#f5f5f4;border:1px solid #e7e5e4;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.55;color:#1c1917;">${esc(text)}</div>
</div>`
}

async function email(a, c, files, flags) {
  if (!process.env.RESEND_API_KEY || !process.env.REVIEW_EMAIL) {
    console.log('  RESEND_API_KEY / REVIEW_EMAIL missing; skipping email.')
    return
  }
  const warn = flags.length
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px;margin-bottom:20px;font-size:14px;color:#991b1b;">
<strong>Check before posting:</strong><br>${flags.map(esc).join('<br>')}</div>`
    : ''

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#1c1917;">
<h2 style="margin:0 0 4px;font-size:20px;">Reel ready: ${esc(a.title)}</h2>
<p style="margin:0 0 18px;color:#6b7280;font-size:14px;"><a href="${a.url}" style="color:${ACCENT};">${a.url}</a></p>
${warn}
<ol style="font-size:14px;line-height:1.6;padding-left:20px;margin:0 0 22px;">
  <li>Save the attached <strong>${a.id}_reel.mp4</strong> on your phone.</li>
  <li>Instagram → new Reel → add a trending sound → paste the caption → post. Same file works for TikTok and YouTube Shorts.</li>
  <li>X: post the single post with the reel attached, then reply to it with the link line. Or post the thread instead.</li>
</ol>
${block('INSTAGRAM CAPTION', `${c.instagram_caption}\n\n${c.hashtags.join(' ')}`)}
${block('TIKTOK CAPTION', c.tiktok_caption)}
${block('YOUTUBE SHORTS TITLE', c.youtube_title)}
${block('YOUTUBE SHORTS DESCRIPTION', c.youtube_description)}
${block(`X POST (${c.x_post.length}/280)`, c.x_post)}
${block('X REPLY WITH LINK', c.x_link_reply)}
${c.x_thread.map((t, i) => block(`X THREAD ${i + 1}/${c.x_thread.length} (${t.length}/280)`, t)).join('\n')}
<p style="font-size:12px;color:#9ca3af;">The 5 slides are attached too, for an Instagram carousel or a 4-image X post. Everything is also in captions.txt. Written by ${writer}.</p>
</div>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Finnpath Content <content@finnpath.com>',
      to: process.env.REVIEW_EMAIL,
      subject: `[Finnpath Social] Reel ready: ${a.title}${flags.length ? ` (⚠️ check ${flags.length})` : ''}`,
      html,
      attachments: files.map(f => ({ filename: f.split('/').pop(), content: readFileSync(f).toString('base64') })),
    }),
  })
  if (!res.ok) throw new Error(`Email failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  const { id } = await res.json()
  console.log(`  ✓ Emailed (id ${id})`)
}

// ---- main ------------------------------------------------------------------------
async function run(id) {
  const a = readArticle(id)
  const out = join(outRoot, id)
  mkdirSync(out, { recursive: true })
  console.log(`\n→ ${a.title} (${writer})`)

  const c = await ask(prompt(a))
  if (c.slides.length < 5) throw new Error(`Expected 5 slides, got ${c.slides.length}`)
  const slides = c.slides.slice(0, 5)

  const cfg = {
    brand: 'FINNPATH', handle: 'finnpath.com', accent: ACCENT, bg: BG,
    slides: slides.map((s, i) => ({
      kicker: `${i + 1} / 5`, big: s.big.replace(/\\n/g, '\n'), small: s.small,
      ...(i === 4 ? { cta: 'Full breakdown → link in bio', disclaimer: DISCLAIMER } : {}),
    })),
  }
  const cfgPath = join(mkdtempSync(join(tmpdir(), 'social-')), 'slides.json')
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  execFileSync('python3', [join(__dirname, 'render_slides.py'), cfgPath, out], { stdio: 'inherit' })
  const reel = join(out, `${id}_reel.mp4`)
  const secs = buildSlideReel(cfg.slides, out, reel)
  console.log(`  ✓ Reel ${secs.toFixed(1)}s`)

  c.instagram_caption = `${c.instagram_caption.trim()}\n\n${DISCLAIMER}`
  c.youtube_description = `${c.youtube_description.trim()}\n\n${DISCLAIMER}`
  c.x_link_reply = `Full breakdown (not financial advice): ${a.url}`

  const flags = [
    ...unmatchedNumbers(
      [...slides.flatMap(s => [s.big, s.small]), c.instagram_caption, c.youtube_title, c.youtube_description,
        c.tiktok_caption, c.x_post, ...c.x_thread],
      `${a.title} ${a.body} ${SITE} ${DISCLAIMER} 1 2 3 4 5`
    ).map(n => `Number "${n}" isn't in the article`),
    ...overLimit('X post', c.x_post),
    ...c.x_thread.flatMap((t, i) => overLimit(`X thread post ${i + 1}`, t)),
  ]
  if (flags.length) console.log(`  ⚠ ${flags.join('; ')}`)

  const txt = join(out, 'captions.txt')
  writeFileSync(txt, captionText(a, c))
  const files = [reel, ...[1, 2, 3, 4, 5].map(i => join(out, `slide-${i}.jpg`)), txt]

  if (sendEmail) await email(a, c, files, flags)
}

let failed = 0
for (const id of ids) {
  try {
    await run(id)
  } catch (err) {
    failed++
    console.error(`  ✗ ${id}: ${err.message}`)
    console.log(`::error::Social reel failed for ${id}: ${String(err.message).slice(0, 300)}`)
  }
}
if (failed) process.exit(1)
