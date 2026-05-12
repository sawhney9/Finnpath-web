/**
 * Finnpath × Beehiiv API v2 Integration
 * 
 * Usage:
 *   node beehiiv-api.js
 * 
 * Setup:
 *   npm install node-fetch
 *   export BEEHIIV_API_KEY="your_api_key_here"
 */

const fs = require('fs');
require('dotenv').config();

// ── CONFIG ──────────────────────────────────────────────────
const PUBLICATION_ID = 'pub_5caff2cc-3591-49a4-80b4-4707255b2f7b';
const API_BASE = 'https://api.beehiiv.com/v2';
const API_KEY = process.env.BEEHIIV_API_KEY; // Never hardcode this

if (!API_KEY) {
  console.error('❌  Missing BEEHIIV_API_KEY env variable');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

// ── HELPERS ─────────────────────────────────────────────────
async function apiCall(method, path, body = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`API Error ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ── FUNCTIONS ────────────────────────────────────────────────

/**
 * Create a new draft post
 * @param {Object} issue - Newsletter issue data
 */
async function createDraft(issue) {
  const {
    subject,
    previewText,
    htmlBody,
    audienceType = 'free',   // 'free' | 'premium' | 'all'
  } = issue;

  const payload = {
    publication_id: PUBLICATION_ID,
    title: subject,
    subject,
    preview_text: previewText,
    content_html: htmlBody,
    status: 'draft',          // Always draft first — review before sending
    audience: audienceType,
    content_tags: ['newsletter', 'finnpath'],
  };

  const result = await apiCall('POST', `/publications/${PUBLICATION_ID}/posts`, payload);
  console.log(`✅  Draft created: ${result.data?.id}`);
  console.log(`   Preview at: https://app.beehiiv.com/posts/${result.data?.id}`);
  return result.data;
}

/**
 * Get publication stats
 */
async function getStats() {
  const result = await apiCall('GET', `/publications/${PUBLICATION_ID}`);
  const pub = result.data;
  
  // Fetch subscriber count separately since it's not in the main pub object
  let subs = 'N/A';
  try {
    const subResult = await apiCall('GET', `/publications/${PUBLICATION_ID}/subscriptions?limit=1`);
    if (subResult.total_results !== undefined) {
      subs = subResult.total_results;
    } else if (subResult.data) {
      subs = subResult.data.length + (subResult.has_more ? '+' : '');
    }
  } catch (e) { /* ignore */ }

  const createdDate = pub.created ? new Date(pub.created * 1000).toLocaleDateString() : 'Unknown';

  console.log('\n📊  Publication Stats:');
  console.log(`   Name:        ${pub.name}`);
  console.log(`   Subscribers: ${subs}`);
  console.log(`   Created:     ${createdDate}`);
  return pub;
}

/**
 * List recent posts
 */
async function listPosts(limit = 5) {
  const result = await apiCall('GET', `/publications/${PUBLICATION_ID}/posts?limit=${limit}&order_by=created&direction=desc`);
  console.log(`\n📋  Recent Posts (${result.data?.length}):`);
  result.data?.forEach(post => {
    const createdDate = post.created ? new Date(post.created * 1000).toLocaleDateString() : 'Unknown';
    const title = post.subject_line || post.title || 'Untitled';
    console.log(`   [${post.status}] ${title} — ${createdDate}`);
  });
  return result.data;
}

/**
 * Get subscriber count
 */
async function getSubscriberCount() {
  const result = await apiCall('GET', `/publications/${PUBLICATION_ID}/subscriptions?limit=1`);
  console.log(`\n👥  Total subscriptions: ${result.total_results ?? 'N/A'}`);
  return result.total_results;
}

// ── FILL TEMPLATE ────────────────────────────────────────────

/**
 * Fill the HTML template with issue data
 * @param {string} templatePath - Path to HTML template
 * @param {Object} vars - Template variables
 */
function fillTemplate(templatePath, vars) {
  let html = fs.readFileSync(templatePath, 'utf8');

  Object.entries(vars).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, value || '');
  });

  return html;
}

// ── EXAMPLE ISSUE ────────────────────────────────────────────

async function publishExampleIssue() {
  // ── v2 template: navy/coral theme matching finnpath.com ──
  const templatePath = './finnpath-newsletter-v2.html';

  // Fill in your issue content here
  const vars = {
    issue_number: '001',
    date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    read_time: '4',
    subscriber_count: '250',
    issue_topic: 'Investing Basics',

    // Header headline — split across two lines; line2 renders italic coral
    headline_line1: 'Real money knowledge.',
    headline_line2: 'Zero fluff.',
    subheadline: 'Why most 20-somethings wait too long to start investing — and what to do instead.',

    opening_paragraph: `This week we're talking about the one financial move that separates people who build wealth from people who always feel behind. Hint: it's not your salary. It's when you start.`,

    // Feature article — title split: line1 + accent (italic coral) + line2
    feature_kicker: 'Investing Basics',
    feature_read_time: '8',
    feature_title_line1: 'Why starting to invest at 22 makes you',
    feature_title_accent: '4× richer',
    feature_title_line2: 'than starting at 32',
    feature_body: `The math is uncomfortable. Someone who invests $100/month starting at 22 ends up with significantly more than someone who invests $500/month starting at 32 — even though the second person puts in way more money. That's compound interest. And most people learn this too late.`,
    feature_url: 'https://finnpath.com/blog/compound-interest',

    stat_number: '$1.7M',
    stat_label: '<strong>What $200/month invested at age 22 becomes by 65</strong>, assuming 8% average annual return. Starting at 32? You\'d have $651K.',

    hit1_title: 'The Fed held rates steady — here\'s what that means for you',
    hit1_desc: 'High-yield savings accounts are still paying 4–5%. If your money is in a big bank\'s 0.01% account, you\'re leaving hundreds on the table.',
    hit1_url: 'https://finnpath.com/blog',
    hit2_title: 'Roth IRA vs Traditional IRA: The 5-minute breakdown',
    hit2_desc: 'Tax now or tax later? The answer depends on where you think your income is headed.',
    hit2_url: 'https://finnpath.com/blog',
    hit3_title: 'Why your credit score matters before you think it does',
    hit3_desc: 'Landlords, employers, and lenders all check it. Build it now while the stakes are low.',
    hit3_url: 'https://finnpath.com/blog',

    quote_text: 'Do not save what is left after spending, but spend what is left after saving.',
    quote_source: 'Warren Buffett',

    tool_title: 'Finnpath Portfolio Simulator',
    tool_desc: 'See how different investment strategies play out over 10, 20, and 30 years. Adjust contributions, expected returns, and time horizons interactively. Free, no signup required.',
    tool_url: 'https://finnpath.com/tools',

    sponsor_body: 'Open a high-yield savings account with SoFi and earn 4.6% APY — 10x the national average. No account fees, no minimums.',
    sponsor_cta_text: 'Earn 4.6% APY →',
    sponsor_url: 'https://finnpath.com',

    unsubscribe_url: '{{unsubscribe_url}}', // Beehiiv auto-fills this
  };

  const htmlBody = fillTemplate(templatePath, vars);

  await createDraft({
    subject: 'Why starting to invest at 22 makes you 4× richer than starting at 32',
    previewText: 'The math behind why starting now beats starting later — every time.',
    htmlBody,
  });
}

// ── MAIN ─────────────────────────────────────────────────────

(async () => {
  try {
    await getStats();
    await listPosts();
    // Uncomment to create a draft:
    await publishExampleIssue();
  } catch (err) {
    console.error('❌  Error:', err.message);
  }
})();
