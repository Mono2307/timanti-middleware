'use strict';

/**
 * Page authentication for staff-facing HTML.
 *
 * WHY THIS EXISTS
 * Until now the only access control in this service was `requireAdmin` inside
 * src/modules/serialization/routes.js — a shared secret pasted onto the URL. That is fine for an
 * operator clicking a maintenance endpoint once a month; it is wrong for a page a shop-floor
 * device keeps open, because the secret ends up in browser history, in the address bar in front
 * of a customer, and in any screenshot of the device.
 *
 * So: a password exchanged once for an HMAC-signed, HttpOnly cookie. The password never appears
 * in a URL, the cookie cannot be read by page scripts, and nothing is stored server-side — the
 * signature *is* the session, so a restart or a second Fly machine does not log anyone out.
 *
 * FAILS CLOSED, deliberately, matching requireAdmin's precedent: if the password or the signing
 * secret is unset the routes return 503 rather than opening. An unconfigured deployment must not
 * be an unlocked one — this service's report endpoints are already public, and this is the first
 * page gate; it should not be the first page gate that silently isn't one.
 */

const crypto = require('crypto');
const { config } = require('./config');

/** Cookie name. Short and non-descriptive; it identifies nothing on its own. */
const COOKIE = 'tl_lb';

const NOT_CONFIGURED =
  'The lookbook is not configured on this deployment. Set LOOKBOOK_PASSWORD and ' +
  'LOOKBOOK_SESSION_SECRET as Fly secrets; the page stays closed until you do.';

/** Both secrets present? Checked per-request rather than at boot so an unset var degrades this
 *  one feature to 503 instead of taking the whole service down at start-up. */
const isConfigured = () => !!(config.lookbook.password && config.lookbook.sessionSecret);

/**
 * Constant-time string compare.
 *
 * Digests first so both buffers are always 32 bytes: timingSafeEqual throws on a length mismatch,
 * and that throw would itself leak the length of the real password.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** `document.cookie`-style header → object. The repo has no cookie-parser and this does not
 *  warrant adding a dependency to a service with eight of them. */
function parseCookies(req) {
  const out = {};
  for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sign = (payload) =>
  crypto.createHmac('sha256', String(config.lookbook.sessionSecret)).update(`lookbook:${payload}`).digest('hex');

/** Session value: `<expiry-ms>.<hmac>`. Self-describing and self-verifying — no server state. */
function issueSession(days = config.lookbook.sessionDays) {
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;
  return `${exp}.${sign(exp)}`;
}

function verifySession(value) {
  if (!isConfigured() || !value) return false;
  const [exp, sig] = String(value).split('.');
  // Expiry is checked BEFORE the signature so an expired-but-authentic cookie is rejected too:
  // the signature covers the expiry, but a valid signature over a past date is still not a session.
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  try { return safeEqual(sig, sign(exp)); } catch { return false; }
}

const hasSession = (req) => verifySession(parseCookies(req)[COOKIE]);

const checkPassword = (given) => isConfigured() && safeEqual(given, config.lookbook.password);

/**
 * `Secure` is conditional on the request actually being HTTPS. Fly terminates TLS and forwards
 * x-forwarded-proto, so this is `Secure` in production — but hardcoding it would mean the cookie
 * is silently dropped by the browser on http://localhost, i.e. the page could never be tested
 * locally and the failure would look like "the password does not work".
 */
function sessionCookie(req, value, maxAgeSec) {
  const https = req.secure || String((req.headers || {})['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return [
    `${COOKIE}=${value}`,
    'Path=/lookbook',
    'HttpOnly',
    'SameSite=Lax',
    https ? 'Secure' : null,
    `Max-Age=${maxAgeSec}`,
  ].filter(Boolean).join('; ');
}

const loginCookie  = (req) => sessionCookie(req, issueSession(), config.lookbook.sessionDays * 24 * 60 * 60);
const logoutCookie = (req) => sessionCookie(req, '', 0);

/** JSON-endpoint gate: 503 unconfigured, 401 unauthenticated. */
function requireLookbookJson(req, res, next) {
  if (!isConfigured()) return res.status(503).json({ success: false, error: NOT_CONFIGURED });
  if (!hasSession(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  return next();
}

/** Operator override for maintenance endpoints, reusing the existing admin secret convention. */
const hasAdminSecret = (req) => {
  const expected = config.adminApiSecret;
  if (!expected) return false;
  const given = (req.headers || {})['x-admin-secret'] || (req.query || {}).secret;
  try { return !!given && safeEqual(given, expected); } catch { return false; }
};

module.exports = {
  COOKIE, NOT_CONFIGURED,
  isConfigured, parseCookies, issueSession, verifySession, hasSession,
  checkPassword, loginCookie, logoutCookie, requireLookbookJson, hasAdminSecret,
};
