/**
 * Cloudflare Worker — Gemini API Proxy for Finnpath Portfolio Pulse
 *
 * This worker keeps the Gemini API key on the server side.
 * Deploy with: wrangler deploy
 * Set the secret with: wrangler secret put GEMINI_API_KEY
 *
 * The key is NEVER in this source file — it is injected by Cloudflare
 * at runtime via `wrangler secret put GEMINI_API_KEY`.
 */

const ALLOWED_ORIGINS = [
  'https://finnpath.co',
  'https://www.finnpath.co',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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

    const { prompt } = body;
    if (!prompt || typeof prompt !== 'string') {
      return corsResponse(JSON.stringify({ error: 'Missing prompt' }), 400, origin);
    }

    // Enforce prompt length to prevent abuse
    if (prompt.length > 2000) {
      return corsResponse(JSON.stringify({ error: 'Prompt too long' }), 400, origin);
    }

    // Call Gemini — key comes from Cloudflare secret, never from source
    let geminiRes;
    try {
      geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 120, temperature: 0.4 },
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
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://finnpath.co',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  return new Response(body, { status, headers });
}
