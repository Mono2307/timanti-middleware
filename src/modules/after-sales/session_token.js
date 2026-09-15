'use strict';

/**
 * Shopify admin session ("ID") token verification.
 *
 * WHY THIS EXISTS
 * The "Pieces in for Repair" picker in the Metafield Manager extension could not read any order
 * older than 60 days. That app holds `read_orders`, and Shopify does not error on an order past
 * that window -- it silently drops it from the result set, so an order from March came back as an
 * empty list and read on screen as a mistyped order number. This service reads those orders
 * happily, because its own token carries `read_all_orders`, so the picker now asks us instead of
 * the Admin API.
 *
 * That moves the lookup onto OUR surface, and our surface has to prove who is calling: an
 * unauthenticated endpoint here would hand anyone the contents of any order given its number.
 * `shopify.auth.idToken()` in the extension mints a short-lived JWT for exactly this purpose.
 *
 * FAILS CLOSED, matching the precedent in core/auth.js: an unset secret returns 503 rather than
 * opening the route. An unconfigured deployment must not be an unlocked one.
 *
 * ALGORITHM NOTE
 * Shopify session tokens are HS256, signed with the app's client secret. Verify below refuses any
 * other algorithm and names what it saw, rather than skipping the check -- `alg: none` and
 * algorithm-confusion are the two classic ways a hand-rolled JWT check becomes an auth bypass.
 * If Shopify ever mints these as RS256 this arrives as one clear log line, not a silent hole.
 */

const crypto = require('crypto');

/** Decode one base64url JWT segment to a Buffer. */
function decodeSegment(seg) {
  return Buffer.from(String(seg).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Decode one base64url JWT segment to parsed JSON, or null if it is not JSON. */
function decodeJson(seg) {
  try { return JSON.parse(decodeSegment(seg).toString('utf8')); } catch { return null; }
}

/**
 * Strip scheme and trailing slash so "https://x.myshopify.com/" and "x.myshopify.com" compare
 * equal. `dest` is a bare host, `iss` is an admin URL, and config carries a full store URL --
 * three spellings of the same shop, and comparing them raw rejects every valid token.
 */
function normalizeHost(value) {
  return String(value || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

/** Thrown for every rejection, so the route can answer 401 without leaking which check failed. */
class SessionTokenError extends Error {
  constructor(reason) { super(reason); this.name = 'SessionTokenError'; }
}

/**
 * Verify a Shopify admin session token.
 *
 * Takes its configuration as arguments rather than reading process.env, so this file stays off
 * the env-reader ratchet in tools/module-contract.test.js.
 *
 * @returns the decoded payload on success; throws SessionTokenError on any failure.
 */
function verifySessionToken(token, { clientId, clientSecret, clientSecrets, shopDomain, now = Date.now() } = {}) {
  // A LIST, because the secret this app was built with may already be on the host under another
  // name. Trying each candidate costs one HMAC apiece and can save a trip to the Partner
  // Dashboard; it weakens nothing, since a secret that does not sign the token still fails.
  const secrets = (clientSecrets || [clientSecret]).filter(Boolean);
  if (!secrets.length) throw new SessionTokenError('not configured');
  if (!token) throw new SessionTokenError('missing token');

  const parts = String(token).split('.');
  if (parts.length !== 3) throw new SessionTokenError('malformed token');
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  const header = decodeJson(headerSeg);
  if (!header) throw new SessionTokenError('unreadable header');
  // Explicitly refuse anything but HS256. Accepting the token's own choice of algorithm is the
  // bug that turns a JWT check into a formality.
  if (header.alg !== 'HS256') throw new SessionTokenError(`unsupported alg ${header.alg}`);

  const actual = decodeSegment(signatureSeg);
  const signedByAny = secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${headerSeg}.${payloadSeg}`).digest();
    // timingSafeEqual throws on a length mismatch, so length is checked first.
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
  if (!signedByAny) throw new SessionTokenError('bad signature');

  const payload = decodeJson(payloadSeg);
  if (!payload) throw new SessionTokenError('unreadable payload');

  // Seconds, per JWT. A little leeway absorbs clock skew between Shopify and this machine;
  // these tokens live about a minute, so the window stays short either way.
  const SKEW = 5;
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp === 'number' && nowSec > payload.exp + SKEW) throw new SessionTokenError('expired');
  if (typeof payload.nbf === 'number' && nowSec + SKEW < payload.nbf) throw new SessionTokenError('not yet valid');

  // aud is the app the token was minted for. Without this, a token from any other Shopify app
  // installed on the same shop would open this route.
  if (clientId && payload.aud !== clientId) throw new SessionTokenError('wrong audience');

  // dest/iss both name the shop. Pinning them stops a token from another merchant's store being
  // replayed here to read Timanti's orders.
  if (shopDomain) {
    const want = normalizeHost(shopDomain);
    const dest = normalizeHost(payload.dest);
    const iss  = normalizeHost(payload.iss);
    if (dest !== want && iss !== want) throw new SessionTokenError('wrong shop');
  }

  return payload;
}

module.exports = { verifySessionToken, SessionTokenError, normalizeHost };
