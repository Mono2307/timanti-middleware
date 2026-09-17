'use strict';

/**
 * Shopify access: the token, and the REST/GraphQL call helpers everything else builds on.
 *
 * WHY THE TOKEN IS NOT JUST AN ENV VAR
 * Shopify client-credentials tokens expire. The service mints a fresh one from
 * SHOPIFY_CLIENT_ID/SECRET, caches it in memory for 23h, and mirrors it into the Supabase
 * `config` table so a restarting instance (or another tool) can read the live token without
 * re-minting. SHOPIFY_ACCESS_TOKEN is only a last-resort fallback — the repo-root .env copy is
 * routinely stale, which is why anything needing real Shopify data should go through here.
 *
 * Resolution order: memory cache → mint fresh → Supabase → env fallback → throw.
 */

const axios = require('axios');
const { config } = require('./config');
const { supabase } = require('./supabase');
const { log } = require('./logger');

const TOKEN_TTL_MS  = 23 * 60 * 60 * 1000;
const BUY_TABLE_TTL = 60 * 60 * 1000;
const API_VERSION   = '2024-01';

let cachedToken = null;
let tokenFetchedAt = null;

async function getShopifyToken() {
  const now = Date.now();
  if (cachedToken && tokenFetchedAt && (now - tokenFetchedAt) < TOKEN_TTL_MS) return cachedToken;

  if (config.shopify.clientId && config.shopify.clientSecret) {
    try {
      const response = await axios.post(
        `${config.shopify.storeUrl}/admin/oauth/access_token`,
        { client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, grant_type: 'client_credentials' },
        { timeout: 10000 }
      );
      const newToken = response.data.access_token;
      if (newToken) {
        cachedToken = newToken; tokenFetchedAt = now;
        await supabase.from('config').upsert({ key: 'shopify_access_token', value: newToken, updated_at: new Date().toISOString() });
        log.info('shopify', 'token refreshed');
        return newToken;
      }
    } catch (err) { log.error('shopify', 'token refresh failed:', err.response?.data || err.message); }
  }

  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'shopify_access_token').single();
    if (data?.value) { cachedToken = data.value; tokenFetchedAt = now; return data.value; }
  } catch (err) { log.warn('shopify', 'Supabase token load failed:', err.message); }

  if (config.shopify.accessToken) return config.shopify.accessToken;
  throw new Error('No Shopify token available');
}

/**
 * Diagnostic view of the token cache, for /api/test-db.
 *
 * Exposed as a function rather than the raw `cachedToken` / `tokenFetchedAt` variables: those are
 * module-private, and a caller holding a reference would see a stale snapshot after a refresh.
 * (server.js read them directly before the extraction, which is how /api/test-db came to throw
 * a ReferenceError once they moved here.)
 */
function getTokenState() {
  return {
    cached: !!cachedToken,
    ageMinutes: tokenFetchedAt ? Math.round((Date.now() - tokenFetchedAt) / 60000) : null,
  };
}

async function initShopifyToken() {
  log.info('shopify', 'initialising token...');
  try {
    await getShopifyToken();
    setInterval(async () => { cachedToken = null; tokenFetchedAt = null; await getShopifyToken(); }, TOKEN_TTL_MS);
  } catch (err) { log.error('shopify', 'token init failed:', err.message); }
}

// ── Rate-limit retry ─────────────────────────────────────────────────────────
//
// Shopify's REST bucket refills at ~2 calls/second. This middleware routinely exceeds that, because
// one staff action fans out: nearly every handler in the draft-updated chain writes a tag or a
// metafield to the very draft whose webhook it is handling, and each write makes Shopify deliver the
// webhook again. #D223 (2026-09-17 17:19) took ONE product being added and turned it into ten
// deliveries in nine seconds, each running sixteen handlers, each making its own calls.
//
// Nothing retried any of it. Every 429 was final, and the handlers that came last in the chain were
// the ones that never got served: `sync-net` and `payment-sync` failed with 429 on all ten passes, so
// amount_to_be_collected, amount_pending and payment_status were left describing a draft that no
// longer existed — it still read "fully paid" after a product had raised the total. Each pass logged
// "tag handlers complete" while this happened, because per-handler failures are caught by design.
//
// Retrying is the fix rather than a patch over one: a 429 means the request was REFUSED, not that it
// half-applied, so replaying it is safe for every verb.
//
// This is installed as a global axios interceptor rather than being built into `rest()` below,
// because most of server.js still calls axios directly — an interceptor covers those call sites
// without touching them, which is what makes this a fix for the whole system rather than for the
// handful of places that happen to use the helpers.
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS      = 500;
const RETRY_CAP_MS       = 8000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Scoped to the Admin API on purpose: a 429 from Apps Script or a payment gateway is not ours to retry. */
function isShopifyAdminUrl(url) {
  const store = config.shopify.storeUrl;
  return !!(url && store && url.startsWith(store) && url.includes('/admin/'));
}

// Honour Retry-After when Shopify sends one; otherwise exponential backoff.
//
// The jitter is load-bearing, not decoration. The failure this addresses is a THUNDERING HERD: ten
// concurrent passes hit the limit at the same instant, so a fixed backoff would send all ten back in
// lockstep to be refused together, and again, until attempts ran out. Spreading each retry randomly
// across its window is what lets the bucket drain them a few at a time.
function retryDelayMs(err, attempt) {
  const raSec = parseFloat(err.response?.headers?.['retry-after']);
  if (Number.isFinite(raSec) && raSec > 0) {
    // Jittered even here: Shopify hands every queued caller the SAME Retry-After, so obeying it
    // exactly reconvenes the herd at one moment.
    const base = Math.min(raSec * 1000, RETRY_CAP_MS);
    return base + Math.random() * RETRY_BASE_MS;
  }
  const window = Math.min(RETRY_BASE_MS * (2 ** attempt), RETRY_CAP_MS);
  return window / 2 + Math.random() * (window / 2);
}

function shouldRetry(err) {
  const status = err.response?.status;
  const method = String(err.config?.method || 'get').toLowerCase();
  if (!isShopifyAdminUrl(err.config?.url)) return false;
  // Refused outright — nothing was applied, so any verb may be replayed.
  if (status === 429) return true;
  // Shopify 5xx and dropped connections. Restricted to idempotent verbs: a POST that failed this way
  // may well have been applied server-side, and replaying it would mint a second metafield, a second
  // ledger row or a second serial. Losing a call is recoverable; silently doubling a write is not.
  const idempotent = method === 'get' || method === 'put' || method === 'delete';
  if (!idempotent) return false;
  if (status >= 500 && status < 600) return true;
  return !err.response && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT');
}

// Per-instance, not a module-level boolean: the guard exists to stop the same instance stacking
// duplicate interceptors, and a single flag would silently refuse to arm a SECOND instance (the
// tests create their own) while reporting success.
const _retryInstalled = new WeakSet();

/**
 * Install the retry interceptor on the shared axios instance. Idempotent — safe to call from more
 * than one entry point (server.js and the test harness both do).
 */
function installShopifyRetry(axiosInstance = axios) {
  // The smoke tests replace axios with a stub that has no interceptor chain. Retry is an
  // optimisation on top of working calls, never a precondition for them, so a host that cannot
  // accept it must still boot — crashing here would take the whole server down to install a
  // resilience feature.
  if (!axiosInstance?.interceptors?.response?.use) {
    log.warn('shopify', 'axios instance has no interceptors — 429 retry NOT installed');
    return;
  }
  if (_retryInstalled.has(axiosInstance)) return;
  _retryInstalled.add(axiosInstance);
  axiosInstance.interceptors.response.use(undefined, async (err) => {
    const cfg = err.config;
    if (!cfg || !shouldRetry(err)) throw err;
    cfg.__shopifyRetries = (cfg.__shopifyRetries || 0) + 1;
    if (cfg.__shopifyRetries > RETRY_MAX_ATTEMPTS) {
      log.error('shopify', `gave up after ${RETRY_MAX_ATTEMPTS} retries: ${cfg.method?.toUpperCase()} ${cfg.url} (${err.response?.status || err.code})`);
      throw err;
    }
    const wait = retryDelayMs(err, cfg.__shopifyRetries - 1);
    log.warn('shopify', `${err.response?.status || err.code} on ${cfg.method?.toUpperCase()} ${cfg.url} — retry ${cfg.__shopifyRetries}/${RETRY_MAX_ATTEMPTS} in ${Math.round(wait)}ms`);
    await sleep(wait);
    return axiosInstance(cfg);
  });
  log.info('shopify', `429/5xx retry installed (max ${RETRY_MAX_ATTEMPTS} attempts)`);
}

// ── Call helpers ─────────────────────────────────────────────────────────────
// server.js reconstructed the same URL + header + timeout triple at 80+ call sites. These
// collapse that to one line and give retries/logging a single place to live later.

/** Standard auth headers for the Admin API. */
const shopifyHeaders = (token) => ({ 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' });

/** Absolute Admin REST URL for a path like `draft_orders/123.json`. */
const restUrl = (p) => `${config.shopify.storeUrl}/admin/api/${API_VERSION}/${p.replace(/^\/+/, '')}`;

async function rest(method, p, { token, data, timeout = 10000, params } = {}) {
  const t = token || await getShopifyToken();
  const res = await axios({ method, url: restUrl(p), headers: shopifyHeaders(t), data, params, timeout });
  return res.data;
}

const getJson    = (p, opts) => rest('get',    p, opts);
const postJson   = (p, data, opts) => rest('post',   p, { ...opts, data });
const putJson    = (p, data, opts) => rest('put',    p, { ...opts, data });
const deleteJson = (p, opts) => rest('delete', p, opts);

/** GraphQL Admin API. Throws on userErrors so callers cannot silently ignore a failed write. */
async function graphql(query, variables = {}, { token, timeout = 15000 } = {}) {
  const t = token || await getShopifyToken();
  const { data } = await axios.post(
    `${config.shopify.storeUrl}/admin/api/${API_VERSION}/graphql.json`,
    { query, variables },
    { headers: shopifyHeaders(t), timeout }
  );
  if (data.errors?.length) throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// ── Old-gold buying rate table (Supabase config key 'buying_rate_table') ─────
// Rebuilt daily from the 24kt pure rate by /api/trigger-price-update; cached in memory for 1h.
let _buyingTableCache = null, _buyingTableAt = null;

async function getBuyingRateTable() {
  const now = Date.now();
  if (_buyingTableCache && _buyingTableAt && (now - _buyingTableAt) < BUY_TABLE_TTL) return _buyingTableCache;
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'buying_rate_table').single();
    if (!data?.value) return null;
    _buyingTableCache = JSON.parse(data.value); _buyingTableAt = now;
    return _buyingTableCache;
  } catch (err) { log.warn('shopify', 'buying rate table load failed:', err.message); return null; }
}

/**
 * Seed the cache with a table that was just written to Supabase, so the next read does not
 * serve the previous hour's rates.
 *
 * This exists because the writer and the cache ended up in different modules. The daily
 * trigger used to sit in server.js beside these two variables and primed them by direct
 * assignment; the cache moved here (07965ae) and the writer moved to modules/admin (075fec1),
 * which left `_buyingTableCache = ...` in admin/routes.js referring to nothing. That file is
 * 'use strict', so the assignment did not create a global — it threw ReferenceError, inside an
 * async Express handler, which Node turns into an unhandled rejection and a process exit.
 *
 * Net effect: POST /api/trigger-price-update saved the gold rate, saved the buying table, then
 * killed the web process before it ever spawned the reprice. 502 to the caller, machine restart,
 * no Python, no FATAL email, no trace. The daily job silently did not run from 2026-08-12 on.
 */
function primeBuyingRateTable(table) {
  if (!table) return;
  _buyingTableCache = table;
  _buyingTableAt = Date.now();
}

/** Buy-back rate for a (possibly fractional) karat: karat/24 × pure × (1 − haircut). */
function buyingRateFor(table, purity) {
  if (!table || !(purity > 0) || purity > 24) return null;
  return +((purity / 24) * table.base_24k * (1 - table.haircut_pct / 100)).toFixed(2);
}

module.exports = {
  API_VERSION,
  getShopifyToken, initShopifyToken, getTokenState,
  installShopifyRetry,
  shopifyHeaders, restUrl, rest, getJson, postJson, putJson, deleteJson, graphql,
  getBuyingRateTable, buyingRateFor, primeBuyingRateTable,
};
