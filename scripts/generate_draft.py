#!/usr/bin/env python3
"""GitHub Actions entry point — replaces the local `stock_news_agent/main.py` loop.

Finds a trending finance post on Reddit, writes an article with Gemini (same prompt
and ARTICLES schema as before), and instead of injecting it into blog.html and
pushing directly, saves it as a draft in Cloudflare KV and emails a review link.
Approve/Edit/Skip are handled by the `finnpath-approval` Cloudflare Worker — see
cloudflare-worker/approval/index.js.

Required env vars: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, GEMINI_API_KEY,
UNSPLASH_ACCESS_KEY, RESEND_API_KEY, REVIEW_EMAIL, APPROVAL_WORKER_URL,
CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID.
"""
import os
import re
import json
import random
import tempfile
import subprocess
import urllib.request
import urllib.parse
import uuid
from datetime import datetime

import praw
import requests
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

# ─── Config (unchanged from the local agent) ─────────────────────────────────
SUBREDDITS = ['stocks', 'investing', 'personalfinance', 'CryptoCurrency', 'startups', 'venturecapital']
MIN_UPVOTES = 300
SITE = 'https://finnpath.com'
UNSPLASH_KEY = os.getenv('UNSPLASH_ACCESS_KEY', '')

CATEGORY_MAP = {
    'stocks':          ('news',   '📰 Market News',      'cat-news'),
    'investing':       ('basics', '📘 Investing Basics',  'cat-basics'),
    'personalfinance': ('basics', '📘 Investing Basics',  'cat-basics'),
    'CryptoCurrency':  ('crypto', '⚡ Crypto Markets',   'cat-crypto'),
    'startups':        ('news',   '🚀 Startup News',     'cat-news'),
    'venturecapital':  ('news',   '💸 VC & Private Equity', 'cat-news'),
}

EMOJIS_BY_CAT = {
    'news':   ['📈', '📊', '💹', '🏦', '📰'],
    'basics': ['📘', '💡', '🎯', '🔑', '💰'],
    'crypto': ['₿', '🎯', '⚡', '🔗', '💎'],
    'tax':    ['🧾', '💸', '🏛️', '📋', '💼'],
}

KV_NAMESPACE_ID = os.environ['CLOUDFLARE_KV_NAMESPACE_ID']
WORKER_URL = os.environ['APPROVAL_WORKER_URL'].rstrip('/')

reddit = praw.Reddit(
    client_id=os.getenv('REDDIT_CLIENT_ID'),
    client_secret=os.getenv('REDDIT_CLIENT_SECRET'),
    user_agent=os.getenv('REDDIT_USER_AGENT', 'FinnpathAgent/1.0'),
)

client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))
MODEL = 'gemini-2.5-flash'


# ─── Cloudflare KV (replaces the Neon Postgres processed-posts table) ────────
def _wrangler_kv(*args):
    return subprocess.run(
        ['npx', '--yes', 'wrangler@4', 'kv', 'key', *args, '--remote',
         '--namespace-id', KV_NAMESPACE_ID],
        capture_output=True, text=True, timeout=60,
    )


def kv_get(key):
    res = _wrangler_kv('get', key)
    if res.returncode != 0 or not res.stdout.strip():
        return None
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        return None


def kv_put(key, value):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(value, f)
        path = f.name
    try:
        res = _wrangler_kv('put', key, '--path', path)
        if res.returncode != 0:
            raise RuntimeError(f'wrangler kv put failed for "{key}": {res.stderr.strip()}')
    finally:
        os.unlink(path)


def load_processed():
    return set(kv_get('processed-ids') or [])


def save_processed(reddit_id):
    ids = load_processed()
    ids.add(reddit_id)
    kv_put('processed-ids', sorted(ids))


# ─── Reddit fetching (unchanged) ─────────────────────────────────────────────
def fetch_top_posts(processed_ids):
    candidates = []
    for sub in SUBREDDITS:
        subreddit = reddit.subreddit(sub)
        for post in subreddit.hot(limit=15):
            if post.id in processed_ids:
                continue
            if post.score < MIN_UPVOTES:
                continue
            if post.is_self and len(post.selftext) < 80:
                continue
            candidates.append({
                'id':           post.id,
                'subreddit':    sub,
                'title':        post.title,
                'body':         post.selftext[:3000] if post.is_self else '',
                'url':          post.url,
                'score':        post.score,
                'num_comments': post.num_comments,
            })
    candidates.sort(key=lambda x: x['score'], reverse=True)
    return candidates[:3]  # up to 3 draft emails per run, same cadence as before


# ─── Unsplash image fetch (unchanged) ────────────────────────────────────────
def fetch_unsplash_image(title, category, fallback=False):
    if not UNSPLASH_KEY:
        return ''

    if fallback:
        query = urllib.parse.quote("finance money")
    else:
        STOPWORDS = {'the','a','an','is','are','was','were','be','been','being',
                     'have','has','had','do','does','did','will','would','could',
                     'should','may','might','shall','can','to','of','in','on',
                     'at','by','for','with','about','and','or','but','if','so',
                     'yet','not','no','its','it','this','that','what','how','why',
                     'when','your','you','my','i','we','our','their','there',
                     'just','even','ever','also','than','then','more','most',
                     'after','before','here','get','make','let','take','some',
                     'us','them','him','her','who','which','any','all','vs'}
        CAT_SEEDS = {
            'news':   'stock market finance investing',
            'basics': 'personal finance money savings',
            'crypto': 'cryptocurrency bitcoin digital finance',
            'tax':    'tax retirement 401k savings',
            'tools':  'financial tools calculator budget',
        }
        words = [w for w in re.sub(r"[^\w\s]", '', title.lower()).split()
                 if w not in STOPWORDS and len(w) > 3][:5]
        seed = CAT_SEEDS.get(category, 'finance money')
        query = urllib.parse.quote(' '.join(words) + ' ' + seed)

    url = (f'https://api.unsplash.com/photos/random'
           f'?query={query}&orientation=landscape&content_filter=high'
           f'&client_id={UNSPLASH_KEY}')
    try:
        req = urllib.request.Request(url, headers={'Accept-Version': 'v1'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
            return data['urls'].get('regular', '')
    except Exception as e:
        print(f'  ⚠ Unsplash fetch failed for query "{urllib.parse.unquote(query)}": {e}')
        if not fallback:
            print('  → Retrying with fallback query "finance money"...')
            return fetch_unsplash_image(title, category, fallback=True)
        return ''


# ─── Article generation (unchanged prompt/schema) ────────────────────────────
def slugify(title):
    slug = re.sub(r'[^\w\s-]', '', title.lower())
    slug = re.sub(r'[\s_]+', '-', slug)
    return re.sub(r'-+', '-', slug).strip('-')[:60]


def generate_article(post):
    cat, cat_label, cat_class = CATEGORY_MAP.get(
        post['subreddit'], ('news', '📰 Market News', 'cat-news')
    )

    author_voices = {
        "Maya Chen": "You write as Maya Chen — a 27-year-old who used to work in tech and started investing after watching her coworkers talk about stock options. You're skeptical of hype, slightly sarcastic, and always bring it back to 'what does this actually mean for my bank account'.",
        "Marcus Reid": "You write as Marcus Reid — a 30-year-old former college basketball player who got into finance after retirement. You use sports analogies when they genuinely help, but you don't force them. You're direct and practical.",
        "Priya Sharma": "You write as Priya Sharma — a first-generation immigrant who learned personal finance the hard way, no safety net. You're warm but serious, and you talk about money as a tool for freedom, not status.",
        "James Okafor": "You write as James Okafor — a 25-year-old who is still figuring it out. You ask the 'dumb' questions everyone is afraid to ask, and you normalize not knowing everything.",
        "Finnpath Team": "You write as the Finnpath editorial team — balanced, informative, and never condescending. You treat the reader like a smart adult who just hasn't had access to good financial education yet.",
    }
    chosen_author = random.choice(list(author_voices.keys()))
    author_voice = author_voices[chosen_author]

    prompt = f"""You are a human financial writer for Finnpath, a personal finance blog for 18–30 year olds.

{author_voice}

Based on this Reddit discussion from r/{post['subreddit']}:
Title: {post['title']}
Body: {post['body'] or '(link post — use the title as the topic)'}

Your job is to write an article that teaches a real financial lesson using this news as the hook. Do NOT just summarize what happened. Dig into why it matters to someone who is just starting to build wealth.

━━━ STRICT RULES — FOLLOW EVERY SINGLE ONE ━━━

OPENING — The first paragraph MUST do one of these (pick based on what fits the story):
  • Start with a relatable scenario ("You're scrolling through your portfolio app at 11pm...")
  • Start with a surprising or counterintuitive fact
  • Start with a short, punchy opinion ("Here's the thing about inflation no one tells you...")
  • Start with a question the reader is probably already asking
  Never open with a definition, a statistic dump, or "In today's..."

VOICE & TONE:
  • Write like you're explaining this to a smart friend over coffee — not giving a lecture
  • Use "you" and "your" naturally throughout
  • It's okay to show a small personal opinion or say "I think" occasionally
  • Use contractions freely (it's, you're, don't, isn't, etc.)
  • Mix short punchy sentences with longer ones. Vary your rhythm.
  • Occasionally use a one-sentence paragraph for emphasis. Like this.

BANNED WORDS & PHRASES — never use these, not even once:
  delve, navigate, landscape, realm, it's worth noting, it is important to note,
  game changer, game-changing, robust, leverage (as a verb), utilize, utilize,
  in conclusion, in summary, in today's world, in the current climate,
  at the end of the day, the fact of the matter is, needless to say,
  as we know, as mentioned above, as previously stated,
  actionable, takeaway, empower, unlock (as a metaphor),
  unpacking, deep dive, let's dive in, let's explore

STRUCTURE:
  • Do NOT use the same structure every time. Rotate between:
      - Story → Lesson → What to do
      - Myth vs. Reality sections
      - Before/After framing
      - Q&A style (pose a question as an h3, answer it in the paragraph)
  • Use callout boxes sparingly — max 1 per article, only for a genuinely important insight

CONTENT (CRUCIAL):
  • Don't summarize the news — extract the underlying financial principle
  • Always connect back to what someone with $500–$5,000 to invest should actually think or do
  • Be honest about uncertainty ("Nobody knows exactly when...", "This might not matter for years, or it might matter next month")
  • If something is complicated, say so — then explain one part of it clearly

Return ONLY valid JSON (no markdown, no code fences). Use these exact fields:
{{
  "title": "compelling article title — conversational, not clickbait, max 80 chars",
  "excerpt": "2–3 sentence hook that makes someone want to read it, max 200 chars",
  "readTime": "X min read",
  "author": "{chosen_author}",
  "authorEmoji": "single emoji that fits this author's personality",
  "authorRole": "short role title that fits this author (e.g. 'Money Realist', 'Investing Writer', 'Finance Skeptic')",
  "emoji": "single emoji for the article card",
  "content": "full article HTML using ONLY: <h3>, <p>, <ul class=\\"article-list\\">, <li><strong>Label:</strong> explanation</li>, <div class=\\"article-callout\\"><p>key insight</p></div>. Minimum 3 h3 sections. Minimum 400 words. First <p> must be the hook — no h3 before it."
}}"""

    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type='application/json'),
    )
    text = response.text.strip()
    cleaned_text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    cleaned_text = re.sub(r'\s*```$', '', cleaned_text, flags=re.MULTILINE)
    cleaned_text = cleaned_text.strip()

    try:
        data = json.loads(cleaned_text)
    except json.JSONDecodeError:
        start = cleaned_text.find('{')
        end = cleaned_text.rfind('}')
        if start != -1 and end != -1:
            data = json.loads(cleaned_text[start:end + 1])
        else:
            raise ValueError(f"Could not find JSON block in model output: {cleaned_text}")

    return {
        'id':          slugify(data['title']),
        'category':    cat,
        'catLabel':    cat_label,
        'catClass':    cat_class,
        'emoji':       data.get('emoji', random.choice(EMOJIS_BY_CAT.get(cat, ['📊']))),
        'title':       data['title'],
        'excerpt':     data['excerpt'],
        'readTime':    data.get('readTime', '5 min read'),
        'author':      data.get('author', 'Finnpath Team'),
        'authorEmoji': data.get('authorEmoji', '🏦'),
        'authorRole':  data.get('authorRole', 'Finnpath Editorial'),
        'date':        datetime.now().strftime('%B %-d, %Y'),
        'large':       False,
        'content':     data['content'],
        'imageUrl':    fetch_unsplash_image(data['title'], cat),
    }


# ─── Draft + review email (replaces inject_article/push_to_git/rebuild) ──────
def action_buttons(token):
    return f'''<div style="display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap;">
  <a href="{WORKER_URL}/approve/{token}" style="background:#16a34a;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">✅ Approve &amp; Publish</a>
  <a href="{WORKER_URL}/edit/{token}" style="background:#0080B0;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">✏️ Request Changes</a>
  <a href="{WORKER_URL}/skip/{token}" style="background:#6b7280;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Skip</a>
</div>'''


def send_review_email(article, token):
    html_body = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;">
<div style="background:#F7FAF8;border:1px solid #e0e8e4;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
  <div style="display:inline-block;background:#0B5FFF;color:white;font-size:11px;font-weight:600;letter-spacing:.5px;padding:3px 10px;border-radius:20px;text-transform:uppercase;margin-bottom:8px;">{article['catLabel']}</div>
  <div style="font-size:22px;font-weight:700;margin:0 0 8px;">{article['emoji']} {article['title']}</div>
  <div style="font-size:13px;color:#666;">/blog/{article['id']} · {article['author']} · {article['readTime']}</div>
</div>
{action_buttons(token)}
<div style="line-height:1.7;">{article['content']}</div>
<div style="margin-top:40px;font-size:11px;color:#999;border-top:1px solid #e5e7eb;padding-top:16px;">Finnpath Content Review · Token: {token}</div>
</body></html>'''

    res = requests.post(
        'https://api.resend.com/emails',
        headers={'Authorization': f"Bearer {os.environ['RESEND_API_KEY']}", 'Content-Type': 'application/json'},
        json={
            'from': 'Finnpath Content <content@finnpath.com>',
            'to': os.environ['REVIEW_EMAIL'],
            'subject': f"[Finnpath Review] {article['title']}",
            'html': html_body,
        },
        timeout=15,
    )
    if not res.ok:
        raise RuntimeError(f'Resend send failed: {res.status_code} {res.text}')
    print(f"  ✓ Review email sent → {os.environ['REVIEW_EMAIL']}")


def save_draft_and_email(article, reddit_id):
    token = str(uuid.uuid4())
    draft = {
        'token': token,
        'article': article,
        'redditId': reddit_id,
        'createdAt': datetime.utcnow().isoformat() + 'Z',
    }
    kv_put(f'draft:{token}', draft)
    print('  ✓ Draft saved to KV')
    send_review_email(article, token)


# ─── Main ─────────────────────────────────────────────────────────────────────
def run_once():
    processed = load_processed()
    posts = fetch_top_posts(processed)

    if not posts:
        print('  No new qualifying posts found.')
        return

    for post in posts:
        label = post['title'][:65]
        print(f'\n  → [{post["subreddit"]}] {label}...')
        try:
            article = generate_article(post)
            save_draft_and_email(article, post['id'])
            save_processed(post['id'])
        except Exception as e:
            print(f'  ✗ Failed ({post["id"]}): {e}')


if __name__ == '__main__':
    print('Finnpath draft generator — polling Reddit for financial content')
    print(f'  Subreddits  : {", ".join(f"r/{s}" for s in SUBREDDITS)}')
    print(f'  Min upvotes : {MIN_UPVOTES}\n')
    run_once()
