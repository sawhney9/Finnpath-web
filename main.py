import os
import re
import json
import praw
import time
import random
import hashlib
import psycopg2
import feedparser
import subprocess
from datetime import datetime
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv()

# ─── Config ───────────────────────────────────────────────────────────────────
BLOG_PATH = os.getenv(
    'BLOG_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'finnpath-web', 'blog.html')
)
SUBREDDITS    = ['stocks', 'investing', 'personalfinance', 'CryptoCurrency', 'startups', 'venturecapital']
MIN_UPVOTES   = 300
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL_SECONDS', '3600'))  # default 1 hour
NEWS_SOURCE   = os.getenv('NEWS_SOURCE', 'reddit')

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

# ─── Init clients ─────────────────────────────────────────────────────────────
reddit = praw.Reddit(
    client_id=os.getenv('REDDIT_CLIENT_ID'),
    client_secret=os.getenv('REDDIT_CLIENT_SECRET'),
    user_agent=os.getenv('REDDIT_USER_AGENT', 'FinnpathAgent/1.0'),
)

genai.configure(api_key=os.getenv('GEMINI_API_KEY'))
model = genai.GenerativeModel('gemini-2.5-flash')

db = psycopg2.connect(os.getenv('NEON_DATABASE_URL'))
db.autocommit = True


# ─── DB setup ─────────────────────────────────────────────────────────────────
def init_db():
    with db.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS processed_posts (
                reddit_id TEXT PRIMARY KEY,
                processed_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS articles (
                id          TEXT PRIMARY KEY,
                reddit_id   TEXT,
                category    TEXT,
                cat_label   TEXT,
                cat_class   TEXT,
                emoji       TEXT,
                title       TEXT,
                excerpt     TEXT,
                read_time   TEXT,
                author      TEXT,
                author_emoji TEXT,
                author_role TEXT,
                date        TEXT,
                content     TEXT,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)


# ─── State helpers ────────────────────────────────────────────────────────────
def load_processed():
    with db.cursor() as cur:
        cur.execute("SELECT reddit_id FROM processed_posts")
        return set(row[0] for row in cur.fetchall())


def save_processed(reddit_id):
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO processed_posts (reddit_id) VALUES (%s) ON CONFLICT DO NOTHING",
            (reddit_id,)
        )


def save_article(article, reddit_id):
    with db.cursor() as cur:
        cur.execute("""
            INSERT INTO articles
              (id, reddit_id, category, cat_label, cat_class, emoji, title,
               excerpt, read_time, author, author_emoji, author_role, date, content)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO NOTHING
        """, (
            article['id'], reddit_id, article['category'], article['catLabel'],
            article['catClass'], article['emoji'], article['title'],
            article['excerpt'], article['readTime'], article['author'],
            article['authorEmoji'], article['authorRole'], article['date'],
            article['content']
        ))


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


def fetch_rss_posts(processed_ids):
    candidates = []
    url = "https://news.google.com/rss/search?q=crypto+OR+startups+OR+venture+capital+OR+private+equity+OR+stocks"
    feed = feedparser.parse(url)
    
    for entry in feed.entries:
        entry_id = hashlib.md5(entry.link.encode('utf-8')).hexdigest()
        if entry_id in processed_ids:
            continue
            
        candidates.append({
            'id':           entry_id,
            'subreddit':    'stocks',
            'title':        entry.title,
            'body':         f"Summary: {entry.get('summary', '')} Source Link: {entry.link}",
            'url':          entry.link,
            'score':        999,
            'num_comments': 0,
        })
        
    return candidates[:3]


# ─── Article generation ───────────────────────────────────────────────────────
def slugify(title):
    slug = re.sub(r'[^\w\s-]', '', title.lower())
    slug = re.sub(r'[\s_]+', '-', slug)
    return re.sub(r'-+', '-', slug).strip('-')[:60]


def generate_article(post):
    cat, cat_label, cat_class = CATEGORY_MAP.get(
        post['subreddit'], ('news', '📰 Market News', 'cat-news')
    )

    source_context = f"Based on this Reddit discussion from r/{post['subreddit']}:" if NEWS_SOURCE == 'reddit' else "Based on this recent financial news:"

    prompt = f"""You are writing for Finnpath — a financial literacy blog aimed at 18–30 year olds. Tone: clear, honest, no hype, slightly conversational. Explain jargon plainly.

{source_context}
Title: {post['title']}
Body: {post['body'] or '(link post — use the title as the topic)'}

Write a high-quality financial article for young adults.
CRUCIAL: Do not just summarize the news. You must extract a core investing or economic lesson from this event. For example, if the news is about a crisis or war, explain the macro-economic effects, why certain commodities might rise, what market sectors might see growth or decline, and how a young investor should think about this in their portfolio (e.g., diversification, ignoring short-term noise, etc.). Use the news as a hook to teach them how the financial world actually works.

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


def push_to_git():
    repo_dir = os.path.dirname(os.path.abspath(BLOG_PATH))
    try:
        print("  → Committing and pushing changes to Git...")
        
        github_token = os.getenv('GITHUB_TOKEN')
        if github_token:
            subprocess.run(['git', 'config', 'user.email', 'bot@finnpath.com'], cwd=repo_dir, capture_output=True)
            subprocess.run(['git', 'config', 'user.name', 'Railway Agent Bot'], cwd=repo_dir, capture_output=True)
            subprocess.run(['git', 'remote', 'set-url', 'origin', f'https://sawhney9:{github_token}@github.com/sawhney9/Finnpath-web.git'], cwd=repo_dir, capture_output=True)

        # Add all changes
        subprocess.run(['git', 'add', '.'], cwd=repo_dir, check=True, capture_output=True)
        # Try to commit
        commit_res = subprocess.run(
            ['git', 'commit', '-m', 'Auto-update: added new financial articles on schedule'], 
            cwd=repo_dir, capture_output=True
        )
        if b"nothing to commit" in commit_res.stdout or b"nothing to commit" in commit_res.stderr:
            print("  ✓ No changes to commit.")
        else:
            commit_res.check_returncode() # Will raise CalledProcessError if failed
            subprocess.run(['git', 'push'], cwd=repo_dir, check=True, capture_output=True)
            print("  ✓ Successfully pushed updates to GitHub!")
    except subprocess.CalledProcessError as e:
        print(f"  ✗ Git command failed: {e.stderr.decode('utf-8', errors='ignore')}")
    except Exception as e:
        print(f"  ✗ Error running git logic: {e}")


# ─── Main loop ────────────────────────────────────────────────────────────────
def run_once():
    processed = load_processed()
    if NEWS_SOURCE == 'rss':
        posts = fetch_rss_posts(processed)
    else:
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
            save_article(article, post['id'])
            save_processed(post['id'])
        except Exception as e:
            print(f'  ✗ Failed ({post["id"]}): {e}')

    push_to_git()


def main():
    init_db()
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
