import os
import json
import re
import praw
import time
import random
from datetime import datetime
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────
BLOG_PATH = os.getenv(
    'BLOG_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'finnpath-web', 'blog.html')
)
PROCESSED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'processed_posts.json')
SUBREDDITS    = ['stocks', 'investing', 'personalfinance']
MIN_UPVOTES   = 300
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL_SECONDS', '3600'))  # default 1 hour

CATEGORY_MAP = {
    'stocks':          ('news',   '📰 Market News',      'cat-news'),
    'investing':       ('basics', '📘 Investing Basics',  'cat-basics'),
    'personalfinance': ('basics', '📘 Investing Basics',  'cat-basics'),
}

EMOJIS_BY_CAT = {
    'news':   ['📈', '📊', '💹', '🏦', '📰'],
    'basics': ['📘', '💡', '🎯', '🔑', '💰'],
    'crypto': ['₿', '🎯', '⚡', '🔗', '💎'],
    'tax':    ['🧾', '💸', '🏛️', '📋', '💼'],
}

# ─── Init clients ─────────────────────────────────────────────────────────────
reddit = praw.Reddit(
    client_id=os.getenv('REDDIT_CLIENT_ID'),
    client_secret=os.getenv('REDDIT_CLIENT_SECRET'),
    user_agent=os.getenv('REDDIT_USER_AGENT', 'FinnpathAgent/1.0'),
)

genai.configure(api_key=os.getenv('GEMINI_API_KEY'))
model = genai.GenerativeModel('gemini-1.5-flash')


# ─── State helpers ────────────────────────────────────────────────────────────
def load_processed():
    if os.path.exists(PROCESSED_PATH):
        with open(PROCESSED_PATH) as f:
            return set(json.load(f))
    return set()


def save_processed(ids):
    with open(PROCESSED_PATH, 'w') as f:
        json.dump(list(ids), f)


# ─── Reddit fetching ──────────────────────────────────────────────────────────
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
    return candidates[:3]  # process up to 3 per run


# ─── Article generation ───────────────────────────────────────────────────────
def slugify(title):
    slug = re.sub(r'[^\w\s-]', '', title.lower())
    slug = re.sub(r'[\s_]+', '-', slug)
    return re.sub(r'-+', '-', slug).strip('-')[:60]


def generate_article(post):
    cat, cat_label, cat_class = CATEGORY_MAP.get(
        post['subreddit'], ('news', '📰 Market News', 'cat-news')
    )

    prompt = f"""You are writing for Finnpath — a financial literacy blog aimed at 18–30 year olds. Tone: clear, honest, no hype, slightly conversational. Explain jargon plainly.

Based on this Reddit discussion from r/{post['subreddit']}:
Title: {post['title']}
Body: {post['body'] or '(link post — use the title as the topic)'}

Write a high-quality financial article for young adults.

Return ONLY valid JSON (no markdown, no code fences). Use these exact fields:
{{
  "title": "compelling article title — not clickbait, max 80 chars",
  "excerpt": "2–3 sentence plain-language summary, max 200 chars",
  "readTime": "X min read",
  "author": "pick one: Finnpath Team | Maya Chen | Marcus Reid | Priya Sharma | James Okafor",
  "authorEmoji": "single emoji for the author avatar",
  "authorRole": "short role title e.g. 'Investing Writer'",
  "emoji": "single emoji for the article card image",
  "content": "full article HTML — use ONLY: <h3>, <p>, <ul class=\\"article-list\\">, <li><strong>Label:</strong> explanation</li>, <div class=\\"article-callout\\"><p>key takeaway</p></div>. Minimum 3 sections with <h3> headers. Minimum 350 words."
}}"""

    response = model.generate_content(prompt)
    text = response.text.strip()

    # Strip markdown code fences if Gemini wraps in them
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*```$', '', text, flags=re.MULTILINE)

    data = json.loads(text)

    return {
        'id':         slugify(data['title']),
        'category':   cat,
        'catLabel':   cat_label,
        'catClass':   cat_class,
        'emoji':      data.get('emoji', random.choice(EMOJIS_BY_CAT.get(cat, ['📊']))),
        'title':      data['title'],
        'excerpt':    data['excerpt'],
        'readTime':   data.get('readTime', '5 min read'),
        'author':     data.get('author', 'Finnpath Team'),
        'authorEmoji': data.get('authorEmoji', '🏦'),
        'authorRole': data.get('authorRole', 'Finnpath Editorial'),
        'date':       datetime.now().strftime('%B %-d, %Y'),
        'large':      False,
        'content':    data['content'],
    }


# ─── Blog injection ───────────────────────────────────────────────────────────
def inject_article(article):
    blog_path = os.path.abspath(BLOG_PATH)
    with open(blog_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # Escape backticks and template literal syntax inside the JS template literal
    content = article['content'].replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

    title   = article['title'].replace("'", "\\'")
    excerpt = article['excerpt'].replace("'", "\\'")

    js_obj = f"""  {{
    id: '{article['id']}',
    category: '{article['category']}',
    catLabel: '{article['catLabel']}',
    catClass: '{article['catClass']}',
    emoji: '{article['emoji']}',
    title: '{title}',
    excerpt: '{excerpt}',
    readTime: '{article['readTime']}',
    author: '{article['author']}',
    authorEmoji: '{article['authorEmoji']}',
    authorRole: '{article['authorRole']}',
    date: '{article['date']}',
    large: false,
    content: `{content}`
  }},\n"""

    marker = 'const ARTICLES = [\n'
    if marker not in html:
        raise ValueError('ARTICLES array marker not found in blog.html')

    html = html.replace(marker, marker + js_obj, 1)

    with open(blog_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f'  ✓ Injected: "{article["title"]}"')


# ─── Main loop ────────────────────────────────────────────────────────────────
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
            inject_article(article)
            processed.add(post['id'])
            save_processed(processed)
        except Exception as e:
            print(f'  ✗ Failed ({post["id"]}): {e}')


def main():
    print('Finnpath Agent — polling Reddit for financial content')
    print(f'  Blog path   : {os.path.abspath(BLOG_PATH)}')
    print(f'  Subreddits  : {", ".join(f"r/{s}" for s in SUBREDDITS)}')
    print(f'  Min upvotes : {MIN_UPVOTES}')
    print(f'  Poll interval: {POLL_INTERVAL // 60} min\n')

    while True:
        print(f'[{datetime.now().strftime("%Y-%m-%d %H:%M")}] Polling...')
        run_once()
        print(f'\nSleeping {POLL_INTERVAL // 60} min until next poll...')
        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    main()
