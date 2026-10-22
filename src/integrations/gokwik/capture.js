'use strict';

// GoKwik webhook capture — store every delivery verbatim in gokwik_webhook_log.
//
// The webhook was wired recently and nobody has looked at a real payload: which fields arrive,
// what the status values are, whether there is a signature header and how it is computed. The buy
// plan will record money off this webhook automatically, so that has to be known first. This only
// observes; it never changes what the handler does, and a failure here is logged and swallowed.

const crypto = require('crypto');
const { config } = require('../../core/config');

// Headers that could carry credentials of ours are never stored. GoKwik's status callback sends OUR
// app secret back in `app-secret` (that is its only proof of origin), so it is replaced by whether it
// matched GOKWIK_APP_SECRET — the evidence we need, without the secret.
const DROP_HEADERS   = new Set(['authorization', 'cookie', 'gk-app-secret', 'x-webhook-secret']);
const SECRET_HEADERS = new Set(['app-secret']);

function secretMatches(value) {
  const expected = config.gokwik.appSecret || '';
  const got = String(value || '');
  if (!expected || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

async function captureGokwikWebhook(supabase, req) {
  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const key = k.toLowerCase();
      if (DROP_HEADERS.has(key)) continue;
      headers[k] = SECRET_HEADERS.has(key) ? (secretMatches(v) ? '[matches GOKWIK_APP_SECRET]' : '[MISMATCH]') : v;
    }
    const { error } = await supabase.from('gokwik_webhook_log').insert({
      headers,
      body: req.body || null,
      raw_body: typeof req.rawBody === 'string' ? req.rawBody : null,
    });
    if (error) console.warn(`[gokwik-capture] insert failed: ${error.message}`);
  } catch (err) {
    console.warn(`[gokwik-capture] ${err.message}`);
  }
}

module.exports = { captureGokwikWebhook, secretMatches };
