'use strict';

/**
 * The staff catalog lookbook: a password-gated, swipeable view of the catalog for the shop floor.
 *
 *   GET  /lookbook               the app (or the password form when there is no session)
 *   POST /lookbook/login         password -> signed session cookie
 *   POST /lookbook/logout        drop the cookie
 *   GET  /lookbook/catalog.json  the nightly snapshot, ETag'd
 *   GET  /lookbook/live?ids=     live price + stock for up to 100 variants
 *   POST /lookbook/refresh       force a rebuild (session, or the operator admin secret)
 *
 * Read-only with respect to Shopify: this module never writes a product, variant or metafield.
 */

const auth = require('../../core/auth');
const store = require('./store');
const { fetchLive, MAX_IDS } = require('./live');
const { loginPage, appPage } = require('./page');
const { log } = require('../../core/logger');

/**
 * server.js mounts express.text() with a wildcard content type, so a urlencoded form body arrives
 * here as a STRING, not an object. Every HTML form in this service unpacks it by hand for that
 * reason -- see after-sales/index.js:891. Forgetting it is a silent "the password never works".
 */
function formBody(req) {
  if (typeof req.body === 'string') return Object.fromEntries(new URLSearchParams(req.body));
  return req.body || {};
}

function register(app) {
  // ── The page ───────────────────────────────────────────────────────────────
  app.get('/lookbook', (req, res) => {
    if (!auth.isConfigured()) return res.status(503).send(loginPage({ configured: false }));
    if (!auth.hasSession(req)) return res.send(loginPage({}));
    return res.send(appPage());
  });

  app.post('/lookbook/login', (req, res) => {
    if (!auth.isConfigured()) return res.status(503).send(loginPage({ configured: false }));

    const { password } = formBody(req);
    if (!auth.checkPassword(password)) {
      log.warn('lookbook', 'failed sign-in attempt');
      // Re-render rather than redirect: a redirect would need the error in the query string, and
      // that string ends up in the address bar of a device a customer can see.
      return res.status(401).send(loginPage({ error: 'That password did not work.' }));
    }

    res.setHeader('Set-Cookie', auth.loginCookie(req));
    return res.redirect('/lookbook');
  });

  app.post('/lookbook/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.logoutCookie(req));
    return res.redirect('/lookbook');
  });

  // ── Data ───────────────────────────────────────────────────────────────────
  app.get('/lookbook/catalog.json', auth.requireLookbookJson, (req, res) => {
    const snapshot = store.get();

    // No snapshot yet means the first build is still walking the catalog. Answer with a valid,
    // empty payload so the page renders its own "still building" state instead of an error.
    if (!snapshot) {
      return res.json({ building: true, builtAt: null, productCount: 0, facets: {}, items: [] });
    }

    // The snapshot changes once a day and is the largest thing this service sends. A shop-floor
    // device that reopens the page ten times a day should download it once.
    const tag = store.etag();
    if (tag) {
      res.setHeader('ETag', tag);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      if (req.headers && req.headers['if-none-match'] === tag) return res.status(304).end();
    }

    // Serve the pre-gzipped bytes when the client can take them. Typically a 5-10x reduction on a
    // catalog this size, which is the difference between a usable and an unusable first load on
    // shop wifi. Image bytes are untouched - those come from Shopify's CDN, not from here.
    const packed = store.gzipped();
    const accepts = String((req.headers && req.headers['accept-encoding']) || '');
    if (packed && /gzip/.test(accepts)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', packed.length);
      return res.end(packed);
    }
    return res.json(snapshot);
  });

  app.get('/lookbook/live', auth.requireLookbookJson, async (req, res) => {
    const ids = String((req.query && req.query.ids) || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ success: false, error: 'ids is required' });
    if (ids.length > MAX_IDS) return res.status(400).json({ success: false, error: `at most ${MAX_IDS} ids` });

    try {
      const variants = await fetchLive(ids);
      return res.json({ success: true, variants });
    } catch (err) {
      // The page falls back to the snapshot price on a failure here, so this must not be fatal.
      log.error('lookbook', 'live lookup failed:', err.message);
      return res.status(502).json({ success: false, error: err.message });
    }
  });

  // ── Maintenance ────────────────────────────────────────────────────────────
  app.post('/lookbook/refresh', async (req, res) => {
    if (!auth.isConfigured() && !auth.hasAdminSecret(req)) {
      return res.status(503).json({ success: false, error: auth.NOT_CONFIGURED });
    }
    if (!auth.hasSession(req) && !auth.hasAdminSecret(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      const snapshot = await store.refresh();
      return res.json({
        success: true,
        builtAt: snapshot.builtAt,
        productCount: snapshot.productCount,
        variantCount: snapshot.variantCount,
        buildMs: snapshot.buildMs,
      });
    } catch (err) {
      log.error('lookbook', 'manual refresh failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { register, start: store.start };
