/**
 * Cloudflare Worker — Gemini API Proxy for Finnpath
 *
 * Routes:
 *   POST /       { prompt }   — Portfolio Pulse (simulator.html), short prompts only
 *   POST /401k   { docText }  — 401k plan analyzer (401k.html); the prompt is built
 *                               here so the proxy can't be used as a general LLM
 *   GET  /stats?symbol=GOOG   — price-history stats for the RSU planner (see stats.js);
 *                               rate-limited per IP and cached in KV
 *
 * This worker keeps the Gemini API key on the server side.
 * Deploy with: wrangler deploy
 * Set the secret with: wrangler secret put GEMINI_API_KEY
 *
 * The key is NEVER in this source file — it is injected by Cloudflare
 * at runtime via `wrangler secret put GEMINI_API_KEY`.
 */

import { getStats, normalizeSymbol } from './stats.js';
import { getHistory, RANGES } from './history.js';
import MODELS from '../../config/models.json';
import { DurableObject } from 'cloudflare:workers';

// Hard daily ceiling on Gemini usage across all visitors (the per-IP limiter is
// approximate and per-location). A 401k analysis costs more than a Pulse sentence.
const AI_DAILY_UNITS = 1000;
const AI_COST = { '/401k': 5, '/pulse': 1 };

// One instance holds today's count; Durable Objects give a single, exact counter.
export class AiBudget extends DurableObject {
  async take(units, limit) {
    const day = new Date().toISOString().slice(0, 10);
    const cur = (await this.ctx.storage.get('usage')) || {};
    const used = cur.day === day ? cur.used : 0;
    if (used + units > limit) return false;
    await this.ctx.storage.put('usage', { day, used: used + units });
    return true;
  }
}

const ALLOWED_ORIGINS = [
  'https://finnpath.com',
  'https://www.finnpath.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

// Branch previews of this site on Cloudflare Pages (only our own deployments get these hostnames).
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.finnpath-web\.pages\.dev$/;
const originAllowed = origin => ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin);

const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini_fast}:generateContent`;

const MAX_401K_DOC_CHARS = 15000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, origin);
    }

    if (request.method === 'GET' && new URL(request.url).pathname === '/stats') {
      return handleStats(request, env, origin);
    }

    if (request.method === 'GET' && new URL(request.url).pathname === '/history') {
      return handleHistory(request, env, origin);
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

    // Only our two AI features, each with a server-built prompt: no free-form prompts.
    const route = new URL(request.url).pathname;
    if (route !== '/401k' && route !== '/pulse') {
      return corsResponse(JSON.stringify({ error: 'Not found' }), 404, origin);
    }
    if (!originAllowed(origin)) {
      return corsResponse(JSON.stringify({ error: 'Forbidden' }), 403, origin);
    }
    if (env.AI_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.AI_LIMITER.limit({ key: ip });
      if (!success) return corsResponse(JSON.stringify({ error: 'rate_limited' }), 429, origin, { 'Retry-After': '60' });
    }

    let prompt, generationConfig;
    if (route === '/401k') {
      const { docText } = body;
      if (!docText || typeof docText !== 'string') {
        return corsResponse(JSON.stringify({ error: 'Missing docText' }), 400, origin);
      }
      prompt = build401kPrompt(docText.slice(0, MAX_401K_DOC_CHARS));
      generationConfig = { maxOutputTokens: 4096, temperature: 0.3, responseMimeType: 'application/json' };
    } else {
      prompt = buildPulsePrompt(body);
      if (!prompt) return corsResponse(JSON.stringify({ error: 'Invalid request' }), 400, origin);
      // Output budget includes the model's (minimal) thinking tokens
      generationConfig = { maxOutputTokens: 512, temperature: 0.4 };
    }

    if (env.AI_BUDGET) {
      const ok = await env.AI_BUDGET.get(env.AI_BUDGET.idFromName('global')).take(AI_COST[route], AI_DAILY_UNITS);
      if (!ok) return corsResponse(JSON.stringify({ error: 'daily_limit' }), 429, origin, { 'Retry-After': '3600' });
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

// Per-IP limit shared by the price routes. Returns a 429 response, or null to proceed.
async function priceLimit(request, env, origin) {
  if (!env.PRICE_LIMITER) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.PRICE_LIMITER.limit({ key: ip });
  return success ? null : corsResponse(JSON.stringify({ error: 'rate_limited' }), 429, origin, { 'Retry-After': '60' });
}

async function handleHistory(request, env, origin) {
  const params = new URL(request.url).searchParams;
  const sym = normalizeSymbol(params.get('symbol')), range = params.get('range') || '1mo';
  if (!sym || !RANGES[range]) {
    return corsResponse(JSON.stringify({ error: 'invalid_request' }), 400, origin);
  }
  const limited = await priceLimit(request, env, origin);
  if (limited) return limited;

  try {
    const [status, body] = await getHistory(env, sym, range);
    return corsResponse(JSON.stringify(body), status, origin, { 'Cache-Control': 'public, max-age=3600' });
  } catch (err) {
    console.error('history error:', sym, err.message);
    return corsResponse(JSON.stringify({ error: 'upstream_unavailable' }), 502, origin);
  }
}

async function handleStats(request, env, origin) {
  const sym = normalizeSymbol(new URL(request.url).searchParams.get('symbol'));
  if (!sym) {
    return corsResponse(JSON.stringify({ error: 'invalid_symbol' }), 400, origin);
  }
  const limited = await priceLimit(request, env, origin);
  if (limited) return limited;

  try {
    const [status, body] = await getStats(env, sym);
    return corsResponse(JSON.stringify(body), status, origin, {
      'Cache-Control': status === 200 ? 'public, max-age=43200' : 'public, max-age=3600',
    });
  } catch (err) {
    console.error('stats error:', sym, err.message);
    return corsResponse(JSON.stringify({ error: 'upstream_unavailable' }), 502, origin);
  }
}

function corsResponse(body, status, origin, extraHeaders = {}) {
  const isAllowed = originAllowed(origin);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://finnpath.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    ...extraHeaders,
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

// Portfolio Pulse: one-sentence explanation of a holding's move from recent headlines.
// Input is structured (ticker, direction, up to 4 short headlines); the prompt is built here.
function buildPulsePrompt(body) {
  const ticker = normalizeSymbol(body?.ticker);
  const direction = ['up', 'down', 'roughly flat'].includes(body?.direction) ? body.direction : null;
  const headlines = Array.isArray(body?.headlines)
    ? body.headlines.filter(h => typeof h === 'string' && h.trim()).slice(0, 4).map(h => h.replace(/\s+/g, ' ').slice(0, 200))
    : [];
  if (!ticker || !direction || !headlines.length) return null;
  return `You are a concise financial analyst. Based on these recent headlines for ${ticker} (which is trading ${direction} today), write ONE plain-English sentence (max 25 words) explaining why the stock is moving. Be direct, no jargon. Don't start with "${ticker}".

Headlines:
${headlines.map(h => `- ${h}`).join('\n')}

Respond with ONLY a JSON object: {"sentiment": "bullish"|"bearish"|"neutral", "synopsis": "your one sentence here"}`;
}
