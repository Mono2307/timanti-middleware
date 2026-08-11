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

/** Buy-back rate for a (possibly fractional) karat: karat/24 × pure × (1 − haircut). */
function buyingRateFor(table, purity) {
  if (!table || !(purity > 0) || purity > 24) return null;
  return +((purity / 24) * table.base_24k * (1 - table.haircut_pct / 100)).toFixed(2);
}

module.exports = {
  API_VERSION,
  getShopifyToken, initShopifyToken, getTokenState,
  shopifyHeaders, restUrl, rest, getJson, postJson, putJson, deleteJson, graphql,
  getBuyingRateTable, buyingRateFor,
};
