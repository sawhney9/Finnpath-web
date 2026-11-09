#!/usr/bin/env python3
"""GitHub Actions entry point — replaces the local `stock_news_agent/main.py` loop.

Finds a trending finance story on Google News, writes an article with Gemini (same
prompt and ARTICLES schema as before), and instead of injecting it into blog.html and
pushing directly, saves it as a draft in Cloudflare KV and emails a review link.
Approve/Edit/Skip are handled by the `finnpath-approval` Cloudflare Worker — see
cloudflare-worker/approval/index.js.

Required env vars: GEMINI_API_KEY, UNSPLASH_ACCESS_KEY, RESEND_API_KEY, REVIEW_EMAIL,
APPROVAL_WORKER_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_KV_NAMESPACE_ID.
"""
import os
import re
import sys
import json
import random
import hashlib
import tempfile
import subprocess
import urllib.request
import urllib.parse
import uuid
from datetime import datetime, timedelta

import feedparser
import requests
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

# ─── Config (unchanged from the local agent) ─────────────────────────────────
# The local agent could run against Reddit (fetch_top_posts) or Google News RSS
# (fetch_rss_posts) via NEWS_SOURCE. Its Reddit app was never actually approved
# for API access — NEWS_SOURCE has been 'rss' in production the whole time — so
# only the RSS path is ported here.
RSS_BASE = 'https://news.google.com/rss/search?q='

# Each run picks distinct feeds (weighted) and takes one story from each, so a
# single hot topic can no longer fill every draft slot.
TOPIC_FEEDS = [
    # (source key → CATEGORY_MAP, Google News query, weight)
    ('budgeting',  'budgeting OR "cost of living" OR "saving money" OR "high-yield savings"', 3),
    ('credit',     '"credit card" OR "credit score" OR "student loans" OR "debt payoff"',    3),
    ('retirement', '401k OR "Roth IRA" OR "retirement savings" OR "employer match"',         3),
    ('firstjob',   '"first job" OR "entry-level salary" OR "salary negotiation" OR "open enrollment" OR "job offer"', 3),
    ('everyday',   '"buy now pay later" OR "car loan" OR "car insurance" OR "subscription prices" OR "grocery prices" OR "wedding costs"', 3),
    ('sidehustle', '"side hustle" OR "gig workers" OR freelancers OR "creator economy"',     2),
    ('tax',        '"tax refund" OR "tax bracket" OR IRS OR "tax deduction"',                2),
    ('investing',  '"index funds" OR ETF OR "dollar cost averaging" OR "stock market"',      2),
    ('housing',    'mortgage rates OR "first-time homebuyer" OR rent prices',                2),
    ('equity',     '"restricted stock units" OR RSUs OR ESPP OR "stock options" OR "equity compensation" OR "tech layoffs"', 2),
    ('CryptoCurrency', 'bitcoin OR ethereum OR crypto regulation',                           1),
    ('venturecapital', '"private equity" OR "venture capital" OR IPO',                       1),
]
STORIES_PER_RUN = 1

# A feed can't produce another draft until its cooldown has passed, so one hot
# topic can't fill the blog. Niche feeds wait longer.
DEFAULT_COOLDOWN_DAYS = 10
NICHE_COOLDOWN_DAYS = {'venturecapital': 21, 'CryptoCurrency': 21}
RECENT_DRAFTS_KEY = 'recent-drafts'
RECENT_DRAFTS_KEEP = 20
TITLE_OVERLAP_LOOKBACK = 6
TITLE_OVERLAP_MAX = 2

# Two lengths: quick takes on the news, and evergreen guides that fully answer
# a reader's question. Deep Guides only come from evergreen feeds.
EVERGREEN_SOURCES = {'budgeting', 'credit', 'retirement', 'firstjob', 'everyday',
                     'sidehustle', 'tax', 'investing', 'housing', 'equity'}

# Who each feed is written for. Most posts stay early-career; equity posts are
# for readers a few years further along who've started getting stock as pay.
DEFAULT_AUDIENCE = {
    'who': "a 22–30 year old",
    'moments': "first paycheck, a job offer, rent and roommates, a car payment, a friend's wedding, a side gig, moving out, a surprise bill",
    'numbers': "salaries of $40k–$90k, a few hundred dollars a month to save or invest",
    'investable': "$500–$5,000",
}
AUDIENCE_BY_SOURCE = {
    'equity': {
        'who': "a 24–38 year old at a tech or growth company who has started getting RSUs, ESPP or options",
        'moments': "a first RSU vest showing up on a pay stub, an offer letter with an equity grant, a refresher grant, a layoff announcement, a tax bill bigger than expected, watching the company stock swing",
        'numbers': "salaries of $90k–$200k, an RSU grant of $40k–$200k vesting over four years, quarterly vests of a few thousand to $15k",
        'investable': "$5,000–$50,000",
    },
}

# Evergreen equity questions used when the equity feed has no fresh news.
EQUITY_GUIDE_TOPICS = [
    "Your first RSU vest: what actually happens to the shares and the taxes",
    "Sell at vest or hold? How to decide what to do with vested RSUs",
    "Why your RSU tax withholding is probably too low (and how to avoid an April surprise)",
    "How much of your net worth should be in your employer's stock?",
    "ESPP explained: the discount, the lookback, and when to sell",
    "Got laid off with unvested RSUs: what happens to your equity",
    "Stock options vs. RSUs: what's the difference when you get an offer",
    "Turning RSUs into a diversified portfolio: a simple selldown plan",
    "Cost basis on RSUs: how to avoid paying tax twice when you sell",
    "Wash sales and RSUs: the 30-day trap when you sell at a loss",
    "Comparing job offers with equity: how to value the stock part honestly",
    "What to do with RSU money: emergency fund, debt, or index funds first?",
]
EQUITY_TOPICS_USED_KEY = 'equity-topics-used'

# Headlines that are SEC filings or insider-trade notices, not stories a reader
# can learn from. Skipped so the equity feed falls back to a guide topic.
FEED_TITLE_EXCLUDE = {
    'equity': re.compile(r'\bForm 4\b|\b8-K\b|\b10-Q\b|\bSEC filing\b|insider|was granted|received [\d,]+|'
                         r'(sells|buys|acquires|disposes of) [\d,.]+[kKmM]? (shares|RSUs)|'
                         r'\b(executive|director|officer|CEO|CFO)\b.*\b(granted|awarded|received)\b', re.I),
}
DEEP_GUIDE_SHARE = 0.4
LENGTH_TIERS = {
    'News Take': {'min': 700, 'max': 900, 'sections': '3–4', 'rules': """  • A focused take on the news: what happened in one or two sentences, why it matters to the reader described under REAL LIFE FIRST, and what to do about it."""},
    'Deep Guide': {'min': 1200, 'max': 1800, 'sections': '5–7', 'rules': """  • Answer the reader's underlying question completely, so they don't need to Google anything else.
  • Right after the hook paragraph, add a TL;DR as <div class="article-callout"><p><strong>TL;DR:</strong> point one · point two · point three</p></div>.
  • Include ONE worked example with real dollar amounts that fit the reader described under REAL LIFE FIRST, e.g. "$300/month for 10 years…". Show the simple math so the reader can check it.
  • Include an h3 section on a common mistake people make with this.
  • Include an h3 section called "What to do this week" with 2–4 concrete steps as an <ul class="article-list">.
  • End with a short FAQ: 2–3 questions, each as its own <h3> followed by one <p> answer.
  • Length must come from substance — examples, trade-offs, steps — never from repeating points."""},
}
WORDS_PER_MINUTE = 230
SHORT_RETRY_RATIO = 0.85

DISCLAIMER_HTML = ('<div class="article-callout"><p><strong>For educational purposes only.</strong> '
                   'This isn\'t financial advice. Consult a licensed financial advisor before '
                   'making financial decisions.</p></div>')

# (weight, prompt rules). One is picked per article.
ARTICLE_TYPES = {
    'History Rhymes': (4, """  • Build the article around ONE historical parallel chosen from the VETTED HISTORY FACTS below — the episode that best matches today's news.
  • Include one h3 section on what happened then, and one h3 section comparing it to today: what's genuinely similar, and what's different now (rates, policy, who owns what, how people invest).
  • Show what an ordinary person who kept investing, saving or paying down debt through that period experienced, and what someone who panicked or chased the hype experienced.
  • Every historical number, date or percentage MUST come from the VETTED HISTORY FACTS. If a fact you want isn't listed, describe it in words without a number. Never invent quotes, dates or statistics.
  • Do not claim history will repeat — the point is perspective, not prediction."""),
    'Practical Lesson': (6, """  • Use the news as a hook, then focus on one concrete money principle and what the reader can do this week.
  • Avoid historical statistics unless they appear in the VETTED HISTORY FACTS."""),
}

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'history_facts.json')) as _f:
    HISTORY_EPISODES = json.load(_f)['episodes']


def history_facts_block():
    lines = []
    for ep in HISTORY_EPISODES:
        lines.append(f"[{ep['name']}]")
        lines.extend(f"  - {f['fact']}" for f in ep['facts'])
    return '\n'.join(lines)


ARTICLE_FETCH_CHARS = 6000

SITE = 'https://finnpath.com'
UNSPLASH_KEY = os.getenv('UNSPLASH_ACCESS_KEY', '')

CATEGORY_MAP = {
    'stocks':          ('news',   '📰 Market News',      'cat-news'),
    'investing':       ('basics', '📘 Investing Basics',  'cat-basics'),
    'personalfinance': ('basics', '📘 Investing Basics',  'cat-basics'),
    'CryptoCurrency':  ('crypto', '⚡ Crypto Markets',   'cat-crypto'),
    'startups':        ('news',   '🚀 Startup News',     'cat-news'),
    'venturecapital':  ('news',   '💸 VC & Private Equity', 'cat-news'),
    'budgeting':       ('basics', '💡 Budgeting & Saving', 'cat-basics'),
    'firstjob':        ('basics', '💼 First Job & Paycheck', 'cat-basics'),
    'everyday':        ('basics', '🛒 Everyday Money',     'cat-basics'),
    'sidehustle':      ('basics', '🧑‍💻 Side Hustles',      'cat-basics'),
    'equity':          ('tax',    '📈 Equity & RSUs',      'cat-tax'),
    'credit':          ('basics', '💳 Credit & Debt',      'cat-basics'),
    'housing':         ('basics', '🏠 Housing & Rent',     'cat-basics'),
    'retirement':      ('tax',    '🧾 401k & Retirement',  'cat-tax'),
    'tax':             ('tax',    '🧾 Taxes',              'cat-tax'),
}

EMOJIS_BY_CAT = {
    'news':   ['📈', '📊', '💹', '🏦', '📰'],
    'basics': ['📘', '💡', '🎯', '🔑', '💰'],
    'crypto': ['₿', '🎯', '⚡', '🔗', '💎'],
    'tax':    ['🧾', '💸', '🏛️', '📋', '💼'],
}

DRY_RUN = '--dry-run' in sys.argv

KV_NAMESPACE_ID = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID', '')
WORKER_URL = os.environ.get('APPROVAL_WORKER_URL', '').rstrip('/')
if not DRY_RUN and not (KV_NAMESPACE_ID and WORKER_URL):
    raise SystemExit('CLOUDFLARE_KV_NAMESPACE_ID and APPROVAL_WORKER_URL are required')

client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))
MODEL = 'gemini-3.8-flash'


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
    if DRY_RUN:
        return set()
    return set(kv_get('processed-ids') or [])


def save_processed(post_id):
    ids = load_processed()
    ids.add(post_id)
    kv_put('processed-ids', sorted(ids))


# ─── Topic history (cooldowns + repeat-title guard) ──────────────────────────
TITLE_STOPWORDS = {'the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on', 'at',
                   'by', 'for', 'with', 'and', 'or', 'but', 'if', 'it', 'its', 'this', 'that',
                   'what', 'how', 'why', 'when', 'your', 'you', 'my', 'we', 'our', 'even',
                   'just', 'more', 'than', 'about', 'still', 'does', 'it\'s', 'you\'re', 'from',
                   'matters', 'matter', 'means', 'mean', 'should', 'need', 'actually', 'really'}


def title_keywords(title):
    words = re.sub(r"[^\w\s]", ' ', title.lower()).split()
    keys = set()
    for w in words:
        if w in TITLE_STOPWORDS or len(w) <= 2:
            continue
        keys.add(w[:-1] if w.endswith('s') and len(w) > 4 else w)
    return keys


def published_history():
    """Recent published posts from blog.html, newest first, as {source, title, date}."""
    label_to_source = {label: src for src, (_, label, _) in CATEGORY_MAP.items()
                       if label not in ('📰 Market News', '📘 Investing Basics', '🚀 Startup News')}
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'blog.html')
    try:
        with open(path, encoding='utf-8') as f:
            html = f.read()
    except OSError:
        return []
    out = []
    pattern = re.compile(r"catLabel: '((?:[^'\\]|\\.)*)'.*?title: '((?:[^'\\]|\\.)*)'.*?date: '([^']*)'", re.S)
    for m in list(pattern.finditer(html))[:RECENT_DRAFTS_KEEP]:
        try:
            date = datetime.strptime(m.group(3), '%B %d, %Y').strftime('%Y-%m-%d')
        except ValueError:
            continue
        title = m.group(2).replace("\\'", "'")
        source = label_to_source.get(m.group(1).replace("\\'", "'"))
        if not source:
            # Older posts used the generic "Market News" label; infer niche topics from the title.
            if re.search(r'venture|\bVC\b|\bIPOs?\b|private equity|startup', title, re.I):
                source = 'venturecapital'
            elif re.search(r'crypto|bitcoin|ethereum', title, re.I):
                source = 'CryptoCurrency'
        out.append({'source': source, 'title': title, 'date': date})
    return out


def load_recent():
    drafts = [] if DRY_RUN else (kv_get(RECENT_DRAFTS_KEY) or [])
    combined = drafts + published_history()
    combined.sort(key=lambda r: r.get('date', ''), reverse=True)
    return combined


def save_recent(source, title):
    recent = kv_get(RECENT_DRAFTS_KEY) or []
    recent.insert(0, {'source': source, 'title': title, 'date': datetime.now().strftime('%Y-%m-%d')})
    kv_put(RECENT_DRAFTS_KEY, recent[:RECENT_DRAFTS_KEEP])


def feed_cooldowns(recent):
    """Return {source: days_left} for feeds still cooling down, and {source: last_date}."""
    today = datetime.now().date()
    last_used = {}
    for r in recent:
        src = r.get('source')
        if src and src not in last_used:
            last_used[src] = r['date']
    cooling = {}
    for src, date in last_used.items():
        wait = NICHE_COOLDOWN_DAYS.get(src, DEFAULT_COOLDOWN_DAYS)
        days_left = wait - (today - datetime.strptime(date, '%Y-%m-%d').date()).days
        if days_left > 0:
            cooling[src] = days_left
    return cooling, last_used


def too_similar(title, recent):
    new_keys = title_keywords(title)
    for r in recent[:TITLE_OVERLAP_LOOKBACK]:
        shared = new_keys & title_keywords(r['title'])
        if len(shared) >= TITLE_OVERLAP_MAX:
            return r['title'], shared
    return None, None


def next_equity_topic(recent):
    used = set() if DRY_RUN else set(kv_get(EQUITY_TOPICS_USED_KEY) or [])
    for topic in EQUITY_GUIDE_TOPICS:
        if topic in used or too_similar(topic, recent)[0]:
            continue
        print('  · No fresh equity news — using an evergreen equity guide topic')
        return {
            'id':        'topic-' + hashlib.md5(topic.encode('utf-8')).hexdigest(),
            'source':    'equity',
            'title':     topic,
            'body':      '',
            'url':       '',
            'evergreen': True,
        }
    return None


def mark_equity_topic_used(topic):
    used = kv_get(EQUITY_TOPICS_USED_KEY) or []
    if topic not in used:
        kv_put(EQUITY_TOPICS_USED_KEY, used + [topic])


# ─── Google News RSS fetching ────────────────────────────────────────────────
def pick_feeds(n, cooling, last_used):
    force_feed = os.getenv('FORCE_FEED', '').strip()
    if force_feed:
        forced = [f for f in TOPIC_FEEDS if f[0] == force_feed]
        if not forced:
            raise SystemExit(f'FORCE_FEED must be one of {[f[0] for f in TOPIC_FEEDS]}')
        print(f'  Forced feed: {force_feed}')
        return forced
    available = [f for f in TOPIC_FEEDS if f[0] not in cooling]
    if not available:
        # Every feed is cooling down: fall back to the least recently used ones.
        print('  ⚠ All feeds on cooldown — using least recently used')
        return sorted(TOPIC_FEEDS, key=lambda f: last_used.get(f[0], ''))[:n]
    pool = list(available)
    picked = []
    while pool and len(picked) < n:
        choice = random.choices(pool, weights=[w for _, _, w in pool])[0]
        picked.append(choice)
        pool.remove(choice)
    return picked


def fetch_rss_posts(processed_ids, recent):
    candidates = []
    cooling, last_used = feed_cooldowns(recent)
    if cooling:
        print('  Cooling down: ' + ', '.join(f'{s} ({d}d left)' for s, d in sorted(cooling.items())))

    for source, query, _ in pick_feeds(len(TOPIC_FEEDS), cooling, last_used):
        feed = feedparser.parse(RSS_BASE + urllib.parse.quote_plus(query))
        picked = None
        for entry in feed.entries:
            entry_id = hashlib.md5(entry.link.encode('utf-8')).hexdigest()
            if entry_id in processed_ids:
                continue
            if FEED_TITLE_EXCLUDE.get(source) and FEED_TITLE_EXCLUDE[source].search(entry.title):
                print(f'  ↷ [{source}] skipping filing/insider headline "{entry.title[:60]}"')
                continue
            similar_to, shared = too_similar(entry.title, recent)
            if similar_to:
                print(f'  ↷ [{source}] skipping "{entry.title[:60]}" — overlaps "{similar_to[:50]}" on {sorted(shared)}')
                continue
            picked = {
                'id':      entry_id,
                'source':  source,
                'title':   entry.title,
                'body':    f"Summary: {entry.get('summary', '')} Source Link: {entry.link}",
                'url':     entry.link,
            }
            break  # one story per topic
        if not picked and source == 'equity':
            picked = next_equity_topic(recent)
        if picked:
            print(f'  ✓ Picked feed "{source}": {picked["title"][:70]}')
            candidates.append(picked)
        else:
            print(f'  · No usable story in feed "{source}"')
        if len(candidates) >= STORIES_PER_RUN:
            break

    return candidates


# ─── Full article text (best effort; falls back to the RSS summary) ─────────
def fetch_article_text(google_news_url):
    try:
        from googlenewsdecoder import gnewsdecoder
        import trafilatura

        decoded = gnewsdecoder(google_news_url, interval=1)
        if not decoded.get('success'):
            print(f"  ⚠ Could not decode Google News link: {decoded.get('message')}")
            return '', ''
        real_url = decoded['decoded_url']

        res = requests.get(real_url, timeout=15, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        })
        res.raise_for_status()
        text = trafilatura.extract(res.text, include_comments=False, include_tables=False) or ''
        if len(text) < 500:
            print(f'  ⚠ Article text too short ({len(text)} chars) — likely paywalled')
            return real_url, ''
        print(f'  ✓ Fetched article text ({len(text)} chars) from {real_url}')
        return real_url, text[:ARTICLE_FETCH_CHARS]
    except Exception as e:
        print(f'  ⚠ Article fetch failed: {e}')
        return '', ''


# ─── Unsplash image fetch (unchanged)────────────────────────────────────────
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
        post['source'], ('news', '📰 Market News', 'cat-news')
    )

    author_voices = {
        "Maya Chen": "You write as Maya Chen — a 27-year-old who used to work in tech and started investing after watching her coworkers talk about stock options. You're skeptical of hype, slightly sarcastic, and always bring it back to 'what does this actually mean for my bank account'.",
        "Marcus Reid": "You write as Marcus Reid — a 30-year-old former college basketball player who got into finance after retirement. You use sports analogies when they genuinely help, but you don't force them. You're direct and practical.",
        "Priya Sharma": "You write as Priya Sharma — a first-generation immigrant who learned personal finance the hard way, no safety net. You're warm but serious, and you talk about money as a tool for freedom, not status.",
        "James Okafor": "You write as James Okafor — a 25-year-old who is still figuring it out. You ask the 'dumb' questions everyone is afraid to ask, and you normalize not knowing everything.",
        "Finnpath Team": "You write as the Finnpath editorial team — balanced, informative, and never condescending. You treat the reader like a smart adult who just hasn't had access to good financial education yet.",
    }
    chosen_author = random.choice(list(author_voices.keys()))
    article_type = random.choices(
        list(ARTICLE_TYPES.keys()),
        weights=[w for w, _ in ARTICLE_TYPES.values()],
    )[0]
    article_type_rules = ARTICLE_TYPES[article_type][1]
    author_voice = author_voices[chosen_author]

    evergreen = post.get('evergreen', False)
    if evergreen:
        article_type = 'Practical Lesson'
        article_type_rules = ARTICLE_TYPES[article_type][1]
    audience = AUDIENCE_BY_SOURCE.get(post['source'], DEFAULT_AUDIENCE)

    if post.get('force_tier'):
        tier_name = post['force_tier']
    elif evergreen:
        tier_name = 'Deep Guide'
    elif post['source'] in EVERGREEN_SOURCES and random.random() < DEEP_GUIDE_SHARE:
        tier_name = 'Deep Guide'
    else:
        tier_name = 'News Take'
    tier = LENGTH_TIERS[tier_name]
    print(f'  Tier: {tier_name} ({tier["min"]}–{tier["max"]} words) · Type: {article_type} · Author: {chosen_author}')

    if evergreen:
        source_block = f"""Write an evergreen guide answering this reader question (there is no news story for this piece):
Question: {post['title']}

Your job is to answer it completely and practically for the reader described under REAL LIFE FIRST. Don't cite news events, specific companies' stock prices, or current tax-year numbers you aren't certain of — explain the rules in general terms and show simple arithmetic instead. Where a rule depends on the person's situation or tax bracket, say so and suggest checking with a tax professional."""
    else:
        if post.get('article_text'):
            news_block = f"""Full article text (from {post.get('article_url') or 'the original source'}):
{post['article_text']}"""
        else:
            news_block = f"""{post['body']}
NOTE: Only this short summary is available. Do not add any details about this news story (names, numbers, dates, quotes) beyond what the summary says."""
        source_block = f"""Based on this recent financial news:
Title: {post['title']}
{news_block}

Your job is to write an article that teaches a real financial lesson using this news as the hook. Do NOT just summarize what happened. Dig into why it matters to someone who is building wealth."""

    prompt = f"""You are a human financial writer for Finnpath, a personal finance blog for people in their 20s and 30s — from first paycheck to first equity grant.

{author_voice}

{source_block}

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
  • Use callout boxes sparingly — max 1 per article, only for a genuinely important insight (a Deep Guide's TL;DR box doesn't count toward this). Don't add a disclaimer — one is appended automatically.

ARTICLE TYPE FOR THIS PIECE — {article_type}:
{article_type_rules}

LENGTH FOR THIS PIECE — {tier_name}: {tier['min']}–{tier['max']} words in the content field, {tier['sections']} h3 sections.
{tier['rules']}
  • Keep paragraphs to 4 sentences or fewer so it reads well on a phone.

REAL LIFE FIRST:
  • The reader for this piece is {audience['who']}.
  • Ground the article in a real moment from their life: {audience['moments']}.
  • Use realistic numbers for them ({audience['numbers']}), not millionaire examples.
  • Wall Street, venture capital or big-company news is only a hook — spend the article on what it means for the reader's own paycheck, debt, savings or investing.

CONTENT (CRUCIAL):
  • Don't summarize the news — extract the underlying financial principle
  • Always connect back to what someone with {audience['investable']} to invest should actually think or do
  • Be honest about uncertainty ("Nobody knows exactly when...", "This might not matter for years, or it might matter next month")
  • If something is complicated, say so — then explain one part of it clearly

ACCURACY:
  • Facts about the news story must come from the text above. Historical figures must come from VETTED HISTORY FACTS.
  • General, well-established principles (compound interest, diversification, how a 401k match works) are fine without a source, but don't attach specific numbers to them unless they are simple arithmetic you show.

VETTED HISTORY FACTS (the only historical numbers you may use):
{history_facts_block()}

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

    data = call_model_json(prompt)
    words = word_count(data['content'])
    floor = int(tier['min'] * SHORT_RETRY_RATIO)
    if words < floor:
        print(f'  ⚠ Draft came back at {words} words (target {tier["min"]}–{tier["max"]}) — regenerating once')
        retry_prompt = (prompt + f"\n\nIMPORTANT: Your previous draft was only {words} words. "
                        f"The content field MUST be {tier['min']}–{tier['max']} words. Add substance "
                        f"(examples, trade-offs, concrete steps), not filler.")
        retry = call_model_json(retry_prompt)
        retry_words = word_count(retry['content'])
        if retry_words > words:
            data, words = retry, retry_words
    print(f'  ✓ Draft: {words} words')

    content = data['content'].rstrip() + '\n' + DISCLAIMER_HTML
    minutes = max(1, round(word_count(content) / WORDS_PER_MINUTE))

    return {
        'id':          slugify(data['title']),
        'category':    cat,
        'catLabel':    cat_label,
        'catClass':    cat_class,
        'emoji':       data.get('emoji', random.choice(EMOJIS_BY_CAT.get(cat, ['📊']))),
        'title':       data['title'],
        'excerpt':     data['excerpt'],
        'readTime':    f'{minutes} min read',
        'author':      data.get('author', 'Finnpath Team'),
        'authorEmoji': data.get('authorEmoji', '🏦'),
        'authorRole':  data.get('authorRole', 'Finnpath Editorial'),
        'date':        datetime.now().strftime('%B %-d, %Y'),
        'large':       False,
        'content':     content,
        'imageUrl':    fetch_unsplash_image(data['title'], cat),
        'source':      post['source'],
        'tier':        tier_name,
        'wordCount':   words,
    }


def word_count(html_text):
    return len(re.sub(r'<[^>]+>', ' ', html_text).split())


def call_model_json(prompt):
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type='application/json',
                                           max_output_tokens=8192),
    )
    text = response.text.strip()
    cleaned_text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    cleaned_text = re.sub(r'\s*```$', '', cleaned_text, flags=re.MULTILINE)
    cleaned_text = cleaned_text.strip()

    try:
        return json.loads(cleaned_text)
    except json.JSONDecodeError:
        start = cleaned_text.find('{')
        end = cleaned_text.rfind('}')
        if start != -1 and end != -1:
            return json.loads(cleaned_text[start:end + 1])
        raise ValueError(f"Could not find JSON block in model output: {cleaned_text}")


# ─── Fact-check pass (shown in the review email only) ───────────────────────
def fact_check(article, post):
    plain = re.sub(r'<[^>]+>', ' ', article['content'])
    plain = re.sub(r'\s+', ' ', plain).strip()
    source_text = post.get('article_text') or post['body']

    prompt = f"""You are a strict fact-checker. List every specific factual claim in the ARTICLE below:
any number, percentage, dollar amount, date, year, named person, named company, named law, or historical event.
Skip opinions, advice, and general principles with no specifics.

For each claim, decide:
  "history"   — it matches a fact in VETTED HISTORY FACTS
  "source"    — it is stated in the NEWS SOURCE text
  "unverified" — it is in neither, or it contradicts them

Be conservative: if the number or date differs at all, it is "unverified".

VETTED HISTORY FACTS:
{history_facts_block()}

NEWS SOURCE:
{source_text}

ARTICLE:
{article['title']}
{plain}

Return ONLY JSON: {{"claims": [{{"claim": "short quote or paraphrase", "status": "history|source|unverified", "note": "why, max 15 words"}}]}}"""

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type='application/json', temperature=0),
        )
        claims = json.loads(response.text).get('claims', [])
        n_bad = sum(1 for c in claims if c.get('status') == 'unverified')
        print(f'  ✓ Fact-check: {len(claims)} claims, {n_bad} unverified')
        return claims
    except Exception as e:
        print(f'  ⚠ Fact-check failed: {e}')
        return None


def fact_check_html(claims):
    if claims is None:
        return ('<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:14px;">'
                '⚠️ Fact-check did not run for this draft — check every number by hand.</div>')
    if not claims:
        return ('<div style="background:#f0fdf4;border:1px solid #16a34a;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:14px;">'
                '✅ Fact-check: no specific factual claims found.</div>')

    order = {'unverified': 0, 'source': 1, 'history': 2}
    icons = {'unverified': '🔴', 'source': '🟢', 'history': '🟢'}
    labels = {'unverified': 'Unverified', 'source': 'In news source', 'history': 'In history facts'}
    n_bad = sum(1 for c in claims if c.get('status') == 'unverified')
    rows = ''.join(
        f'<li style="margin-bottom:6px;">{icons.get(c.get("status"), "🔴")} '
        f'<strong>{labels.get(c.get("status"), "Unverified")}:</strong> {c.get("claim", "")}'
        f'<span style="color:#666;"> — {c.get("note", "")}</span></li>'
        for c in sorted(claims, key=lambda c: order.get(c.get('status'), 0))
    )
    border, bg = ('#dc2626', '#fef2f2') if n_bad else ('#16a34a', '#f0fdf4')
    return (f'<div style="background:{bg};border:1px solid {border};border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:14px;">'
            f'<div style="font-weight:700;margin-bottom:8px;">Fact-check: {n_bad} of {len(claims)} claims unverified</div>'
            f'<ul style="margin:0;padding-left:18px;">{rows}</ul></div>')


# ─── Draft + review email (replaces inject_article/push_to_git/rebuild) ──────
def action_buttons(token):
    return f'''<div style="display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap;">
  <a href="{WORKER_URL}/approve/{token}" style="background:#16a34a;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">✅ Approve &amp; Publish</a>
  <a href="{WORKER_URL}/edit/{token}" style="background:#0080B0;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">✏️ Request Changes</a>
  <a href="{WORKER_URL}/skip/{token}" style="background:#6b7280;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Skip</a>
</div>'''


def send_review_email(article, token, claims):
    html_body = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;">
<div style="background:#F7FAF8;border:1px solid #e0e8e4;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
  <div style="display:inline-block;background:#0B5FFF;color:white;font-size:11px;font-weight:600;letter-spacing:.5px;padding:3px 10px;border-radius:20px;text-transform:uppercase;margin-bottom:8px;">{article['catLabel']}</div>
  <div style="font-size:22px;font-weight:700;margin:0 0 8px;">{article['emoji']} {article['title']}</div>
  <div style="font-size:13px;color:#666;">/blog/{article['id']} · {article['author']} · {article['readTime']}</div>
  <div style="font-size:13px;color:#666;margin-top:4px;">{article.get('tier', '')} · {article.get('wordCount', '?')} words · feed: {article.get('source', '?')}</div>
</div>
{action_buttons(token)}
{fact_check_html(claims)}
<div style="line-height:1.7;">{article['content']}</div>
<div style="margin-top:40px;font-size:11px;color:#999;border-top:1px solid #e5e7eb;padding-top:16px;">Finnpath Content Review · Token: {token}</div>
</body></html>'''

    res = requests.post(
        'https://api.resend.com/emails',
        headers={'Authorization': f"Bearer {os.environ['RESEND_API_KEY']}", 'Content-Type': 'application/json'},
        json={
            'from': 'Finnpath Content <content@finnpath.com>',
            'to': os.environ['REVIEW_EMAIL'],
            'subject': (f"[Finnpath Review] {article['title']}"
                        + (f" — ⚠️ {sum(1 for c in claims if c.get('status') == 'unverified')} unverified"
                           if claims and any(c.get('status') == 'unverified' for c in claims) else '')),
            'html': html_body,
        },
        timeout=15,
    )
    if not res.ok:
        raise RuntimeError(f'Resend send failed: {res.status_code} {res.text}')
    print(f"  ✓ Review email sent → {os.environ['REVIEW_EMAIL']}")


def save_draft_and_email(article, post_id, claims):
    token = str(uuid.uuid4())
    draft = {
        'token': token,
        'article': article,
        'postId': post_id,
        'factCheck': claims,
        'createdAt': datetime.utcnow().isoformat() + 'Z',
    }
    kv_put(f'draft:{token}', draft)
    print('  ✓ Draft saved to KV')
    send_review_email(article, token, claims)


# ─── Main ─────────────────────────────────────────────────────────────────────
def run_once():
    processed = load_processed()
    recent = load_recent()
    posts = fetch_rss_posts(processed, recent)

    if not posts:
        print('  No new qualifying posts found.')
        return

    force_tier = os.getenv('FORCE_TIER', '').strip()
    if force_tier and force_tier not in LENGTH_TIERS:
        raise SystemExit(f'FORCE_TIER must be one of {list(LENGTH_TIERS)}')

    succeeded = 0
    for post in posts:
        label = post['title'][:65]
        print(f'\n  → {label}...')
        try:
            if force_tier:
                post['force_tier'] = force_tier
            if post.get('evergreen'):
                post['article_url'], post['article_text'] = '', ''
            else:
                post['article_url'], post['article_text'] = fetch_article_text(post['url'])
            article = generate_article(post)
            claims = fact_check(article, post)
            if DRY_RUN:
                print(f"\n  [dry run] {article['title']} — {article['tier']}, {article['wordCount']} words, "
                      f"{article['readTime']}, feed {article['source']}")
                print(re.sub(r'<[^>]+>', '\n', article['content']).strip()[:3000])
                succeeded += 1
                continue
            save_draft_and_email(article, post['id'], claims)
            save_processed(post['id'])
            save_recent(post['source'], article['title'])
            if post.get('evergreen'):
                mark_equity_topic_used(post['title'])
            succeeded += 1
        except Exception as e:
            print(f'  ✗ Failed ({post["id"]}): {e}')

    # Exit non-zero when every post failed so the Actions run goes red and
    # GitHub emails a failure notice, instead of silently "succeeding".
    if succeeded == 0:
        raise SystemExit(f'\n✗ All {len(posts)} posts failed — no draft was created.')


if __name__ == '__main__':
    print('Finnpath draft generator — polling Google News for financial content')
    run_once()
