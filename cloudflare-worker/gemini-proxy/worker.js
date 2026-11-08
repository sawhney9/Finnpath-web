/**
 * Cloudflare Worker — Gemini API Proxy for Finnpath
 *
 * Routes:
 *   POST /       { prompt }   — Portfolio Pulse (simulator.html), short prompts only
 *   POST /401k   { docText }  — 401k plan analyzer (401k.html); the prompt is built
 *                               here so the proxy can't be used as a general LLM
 *
 * This worker keeps the Gemini API key on the server side.
 * Deploy with: wrangler deploy
 * Set the secret with: wrangler secret put GEMINI_API_KEY
 *
 * The key is NEVER in this source file — it is injected by Cloudflare
 * at runtime via `wrangler secret put GEMINI_API_KEY`.
 */

const ALLOWED_ORIGINS = [
  'https://finnpath.com',
  'https://www.finnpath.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

const MAX_401K_DOC_CHARS = 15000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, origin);
    }

    if (request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400, origin);
    }

    let prompt, generationConfig;
    if (new URL(request.url).pathname === '/401k') {
      const { docText } = body;
      if (!docText || typeof docText !== 'string') {
        return corsResponse(JSON.stringify({ error: 'Missing docText' }), 400, origin);
      }
      prompt = build401kPrompt(docText.slice(0, MAX_401K_DOC_CHARS));
      generationConfig = { maxOutputTokens: 4096, temperature: 0.3, responseMimeType: 'application/json' };
    } else {
      ({ prompt } = body);
      if (!prompt || typeof prompt !== 'string') {
        return corsResponse(JSON.stringify({ error: 'Missing prompt' }), 400, origin);
      }

      // Enforce prompt length to prevent abuse
      if (prompt.length > 2000) {
        return corsResponse(JSON.stringify({ error: 'Prompt too long' }), 400, origin);
      }
      // Output budget includes the model's (minimal) thinking tokens
      generationConfig = { maxOutputTokens: 512, temperature: 0.4 };
    }

    // Call Gemini — key comes from Cloudflare secret, never from source
    let geminiRes;
    try {
      geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
      });
    } catch (err) {
      return corsResponse(JSON.stringify({ error: 'Upstream request failed' }), 502, origin);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini error:', geminiRes.status, errText);
      return corsResponse(JSON.stringify({ error: 'Gemini API error' }), 502, origin);
    }

    const geminiJson = await geminiRes.json();
    const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    return corsResponse(JSON.stringify({ text }), 200, origin);
  },
};

function corsResponse(body, status, origin) {
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://finnpath.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  return new Response(body, { status, headers });
}

function build401kPrompt(docText) {
  return `You are a financial education assistant for Finnpath, a platform that helps young adults (18-30) understand their workplace benefits.

A user has uploaded their 401k plan document. Analyze it and return ONLY valid JSON (no markdown, no code fences) with this EXACT structure:

{
  "planName": "Name of the 401k plan if found, or 'Your 401k Plan'",
  "summary": "2-3 sentence plain-English overview of the plan for a first-time employee",
  "keyFacts": [
    {"label": "Employer Match", "value": "e.g. 50% up to 6%", "note": "short plain-English note", "color": "green"},
    {"label": "Employee Contribution Limit", "value": "e.g. $23,500/yr (2025)", "note": "short note", "color": "sky"},
    {"label": "Vesting Schedule", "value": "e.g. 3-year graded", "note": "short note", "color": "gold"},
    {"label": "Eligible After", "value": "e.g. 90 days", "note": "short note", "color": "sky"}
  ],
  "allowed": [
    "plain-English list of things this plan allows (e.g. Roth after-tax contributions, loans, hardship withdrawals)",
    "add 3-6 items"
  ],
  "notAllowed": [
    "plain-English list of restrictions or things the plan does not allow",
    "add 3-5 items"
  ],
  "scenarios": [
    {
      "type": "best",
      "label": "Maximize Every Dollar",
      "title": "Contribute enough to capture the full employer match",
      "body": "Detailed hypothetical scenario (2-3 sentences) explaining exactly how much to contribute, how much the employer adds, and a rough estimate of long-term value. Use specific numbers from the plan if possible."
    },
    {
      "type": "moderate",
      "label": "Balance Growth & Cash Flow",
      "title": "Contribute comfortably while keeping take-home pay livable",
      "body": "Hypothetical scenario for someone contributing slightly less than max, still getting meaningful match. Focus on balance."
    },
    {
      "type": "conservative",
      "label": "Start Small, Build Up",
      "title": "Start with the minimum and increase contributions annually",
      "body": "Scenario for someone just starting out who increases contribution 1-2% per year. Motivating and realistic."
    }
  ],
  "watchOuts": [
    "1-2 sentence warning about something people commonly miss (e.g. forgetting to invest contributions, leaving before full vesting)"
  ]
}

If you cannot find specific values in the document for required fields, use reasonable 2025 defaults and note them as "Standard Plan Default". Keep all explanations under a 7th-grade reading level.

Here is the 401k plan document text:
---
${docText}
---`;
}
