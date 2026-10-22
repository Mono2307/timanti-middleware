'use strict';

// GoKwik webhook capture — store every delivery verbatim in gokwik_webhook_log.
//
// The webhook was wired recently and nobody has looked at a real payload: which fields arrive,
// what the status values are, whether there is a signature header and how it is computed. The buy
// plan will record money off this webhook automatically, so that has to be known first. This only
// observes; it never changes what the handler does, and a failure here is logged and swallowed.

// Headers that could carry credentials of ours are never stored.
const DROP_HEADERS = new Set(['authorization', 'cookie', 'gk-app-secret', 'x-webhook-secret']);

async function captureGokwikWebhook(supabase, req) {
  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
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

module.exports = { captureGokwikWebhook };
