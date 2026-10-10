'use strict';

/**
 * Loyalty programme — routes.
 *
 * The programme itself: loyalty/planning/LOYALTY_PLAN_A_MIDDLEWARE.md. Rules: ./engine.js.
 *
 * ENTRY POINT
 *   register(app, ctx)
 *
 * ENDPOINTS
 *   Storefront, through the Shopify app proxy (signed by Shopify; /apps/loyalty/* on the store):
 *     GET  /api/loyalty/proxy/benefits      the logged-in customer's tier, rate and open vouchers
 *     POST /api/loyalty/proxy/apply         one-time diamond-only code for the cart's pieces
 *   Staff panel (Shopify admin session token):
 *     GET  /api/loyalty/draft-preview?draft=<id>   what "Apply loyalty" would do on this draft
 *   Operator (x-admin-secret header or ?secret=):
 *     POST /api/loyalty/setup               metafield definitions + seed the config metafield
 *     POST /api/loyalty/backfill            start the lifetime backfill ({ commit: true } to write)
 *     GET  /api/loyalty/backfill            progress; ?format=csv for the per-customer CSV
 *     GET  /api/loyalty/customer/:id        ledger, points, tier for one customer
 *     POST /api/loyalty/customer/:id/refresh   recompute and republish one customer
 *     POST /api/loyalty/adjust              manual points adjustment { customerId, points, note, key }
 *     GET  /api/loyalty/redemptions         redemptions; ?mismatch=1 for GoKwik phone mismatches
 *     POST /api/loyalty/voucher-combos      let open voucher codes sit beside a loyalty code
 *     POST /api/loyalty/sweep               run the daily sweep now (?dryRun=1)
 *
 * Everything except /setup answers 503 while LOYALTY_ENABLED is off.
 */

const axios = require('axios');
const { config } = require('../../core/config');
const { supabase } = require('../../core/supabase');
const { getJson, graphql, getShopifyToken, shopifyHeaders } = require('../../core/shopify');
const { log } = require('../../core/logger');
const { verifySessionToken } = require('../after-sales/session_token');
const creditInstruments = require('../adjustments/credit_instruments');
const ledger = require('./ledger');
const E = require('./engine');
const { loadConfig, DEFAULT_CONFIG, NAMESPACE, KEY, _resetCache } = require('./config');
const { readCustomer, refreshCustomer } = require('./customer');
const { evaluateDraft, readDraftMetafields, APPLIED_KEY, NOTE_KEY } = require('./draft');
const online = require('./online');
const backfill = require('./backfill');
const { runLoyaltySweep } = require('./sweep');

function requireAdmin(req, res, next) {
  const expected = config.adminApiSecret;
  if (!expected) return res.status(503).json({ success: false, error: 'ADMIN_API_SECRET is not configured.' });
  const given = req.headers['x-admin-secret'] || (req.query || {}).secret || (req.body || {}).secret;
  if (given !== expected) return res.status(401).json({ success: false, error: 'Unauthorized' });
  return next();
}

function requireEnabled(req, res, next) {
  if (!config.loyalty.enabled) return res.status(503).json({ success: false, error: 'Loyalty is switched off on this deployment (LOYALTY_ENABLED).' });
  return next();
}

function requireProxy(req, res, next) {
  if (!online.verifyProxySignature(req.query, config.loyalty.proxySecrets)) {
    return res.status(401).json({ ok: false, reason: 'Invalid request.' });
  }
  return next();
}

function requireStaffSession(req, res, next) {
  try {
    const h = String(req.headers.authorization || '');
    verifySessionToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '', {
      clientId: config.loyalty.mfmClientId,
      clientSecrets: config.loyalty.proxySecrets,
      shopDomain: config.shopify.storeUrl,
    });
    return next();
  } catch (e) {
    return res.status(e.message === 'not configured' ? 503 : 401).json({ success: false, error: `auth: ${e.message}` });
  }
}

/** Metafield definitions so the customer-account page, the cart Liquid and Flow can read loyalty.* */
const CUSTOMER_DEFINITIONS = [
  ['points', 'Loyalty points', 'number_integer', 'Lifetime spend in rupees (1 point per ₹1).'],
  ['tier', 'Loyalty tier key', 'single_line_text_field', 'T1 / T2 / T3, or none.'],
  ['tier_name', 'Loyalty tier', 'single_line_text_field', 'Display name of the tier.'],
  ['tier_since', 'Loyalty tier since', 'date', 'When the current tier was reached.'],
  ['discount_pct', 'Loyalty diamond discount %', 'number_decimal', 'Tier discount on diamond value, before occasion bonus.'],
  ['next_tier_name', 'Next loyalty tier', 'single_line_text_field', ''],
  ['next_tier_gap', 'Spend to next tier', 'number_integer', 'Rupees still to spend for the next tier.'],
];

/** GraphQL at a newer API version than the core helper, for definition access settings. */
async function graphqlAt(version, query, variables) {
  const token = await getShopifyToken();
  const { data } = await axios.post(`${config.shopify.storeUrl}/admin/api/${version}/graphql.json`,
    { query, variables }, { headers: shopifyHeaders(token), timeout: 20000 });
  if (data.errors && data.errors.length) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function setup() {
  const results = [];
  for (const [key, name, type, description] of CUSTOMER_DEFINITIONS) {
    const r = await graphqlAt('2025-01', `mutation($d: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { code message } } }`, {
      d: {
        name, namespace: NAMESPACE, key, type, description, ownerType: 'CUSTOMER', pin: true,
        access: { storefront: 'PUBLIC_READ', customerAccount: 'READ' },
      },
    });
    const errs = r.metafieldDefinitionCreate.userErrors || [];
    results.push({ key, created: !!r.metafieldDefinitionCreate.createdDefinition, note: errs.map(e => e.code || e.message).join(', ') });
  }
  // Seed the programme config on the shop if it is not there yet. Never overwrites an edited one.
  const shop = await graphql(`{ shop { id metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value } } }`);
  let seeded = false;
  let addedKeys = [];
  let value = null;
  if (!shop.shop.metafield) {
    value = DEFAULT_CONFIG;
  } else {
    // An existing config keeps every edit; only sections it does not have yet are added.
    let cur = {};
    try { cur = JSON.parse(shop.shop.metafield.value); } catch { cur = null; }
    if (cur) {
      addedKeys = Object.keys(DEFAULT_CONFIG).filter(k => !(k in cur));
      if (addedKeys.length) value = { ...cur, ...Object.fromEntries(addedKeys.map(k => [k, DEFAULT_CONFIG[k]])) };
    }
  }
  if (value) {
    const r = await graphql(`mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, {
      m: [{ ownerId: shop.shop.id, namespace: NAMESPACE, key: KEY, type: 'json', value: JSON.stringify(value, null, 2) }],
    });
    seeded = !(r.metafieldsSet.userErrors || []).length;
  }
  _resetCache();
  return { definitions: results, configSeeded: seeded, configKeysAdded: addedKeys };
}

/**
 * Let a voucher code sit beside a loyalty code on the cart: voucher codes are ORDER-class, the
 * loyalty code is PRODUCT-class, and Shopify only combines them if the voucher says it combines with
 * product discounts. Other settings on the voucher are left as they are.
 */
async function allowVoucherWithLoyalty(code) {
  const q = await graphql(`query($c: String!) { codeDiscountNodeByCode(code: $c) { id
      codeDiscount { __typename ... on DiscountCodeBasic { combinesWith { orderDiscounts productDiscounts shippingDiscounts } } } } }`, { c: code });
  const node = q.codeDiscountNodeByCode;
  if (!node || !node.codeDiscount || node.codeDiscount.__typename !== 'DiscountCodeBasic') return 'not found';
  const cw = node.codeDiscount.combinesWith || {};
  if (cw.productDiscounts) return 'already';
  const r = await graphql(`mutation($id: ID!, $d: DiscountCodeBasicInput!) {
      discountCodeBasicUpdate(id: $id, basicCodeDiscount: $d) { userErrors { message } } }`, {
    id: node.id,
    d: { combinesWith: { orderDiscounts: !!cw.orderDiscounts, productDiscounts: true, shippingDiscounts: !!cw.shippingDiscounts } },
  });
  const errs = r.discountCodeBasicUpdate.userErrors || [];
  if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
  return 'updated';
}

function register(app /* , ctx */) {
  // ── Storefront (app proxy) ────────────────────────────────────────────────────────────────────
  app.get('/api/loyalty/proxy/benefits', requireEnabled, requireProxy, async (req, res) => {
    const cid = String(req.query.logged_in_customer_id || '');
    if (!cid) return res.json({ loggedIn: false });
    try { return res.json(await online.benefitsFor(cid)); }
    catch (e) { log.error('loyalty', `benefits for ${cid}: ${e.message}`); return res.status(500).json({ loggedIn: true, error: 'unavailable' }); }
  });

  app.post('/api/loyalty/proxy/apply', requireEnabled, requireProxy, async (req, res) => {
    const cid = String(req.query.logged_in_customer_id || '');
    if (!cid) return res.json({ ok: false, reason: 'Please log in to use your loyalty benefit.' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    try { return res.json(await online.createCartCode(cid, (body || {}).lines)); }
    catch (e) { log.error('loyalty', `apply for ${cid}: ${e.message}`); return res.status(500).json({ ok: false, reason: 'We could not apply your benefit just now.' }); }
  });

  // ── Staff panel ───────────────────────────────────────────────────────────────────────────────
  app.get('/api/loyalty/draft-preview', requireEnabled, requireStaffSession, async (req, res) => {
    const draftId = String(req.query.draft || '').replace(/\D/g, '');
    if (!draftId) return res.status(400).json({ success: false, error: 'draft is required' });
    try {
      const { draft_order: draft } = await getJson(`draft_orders/${draftId}.json`);
      const { map } = await readDraftMetafields(draftId);
      const applied = E.readApplied(map[APPLIED_KEY]);
      // Evaluate as if loyalty were not there yet, so the preview shows what (re)applying would do.
      const evMap = { ...map };
      if (applied) delete evMap.discount_applied;
      const ev = await evaluateDraft(draft, evMap);
      return res.json({ success: true, applied, note: map[NOTE_KEY] || '', preview: ev });
    } catch (e) {
      log.error('loyalty', `draft-preview ${draftId}: ${e.message}`);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Operator ──────────────────────────────────────────────────────────────────────────────────
  app.post('/api/loyalty/setup', requireAdmin, async (req, res) => {
    try { return res.json({ success: true, ...(await setup()) }); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loyalty/backfill', requireEnabled, requireAdmin, (req, res) => {
    const commit = (req.body || {}).commit === true || String((req.query || {}).commit) === 'true';
    return res.json({ success: true, ...backfill.start({ commit }) });
  });

  app.get('/api/loyalty/backfill', requireEnabled, requireAdmin, (req, res) => {
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', 'attachment; filename="loyalty-backfill.csv"');
      return res.send(backfill.csv());
    }
    return res.json({ success: true, job: backfill.status() });
  });

  app.get('/api/loyalty/customer/:id', requireEnabled, requireAdmin, async (req, res) => {
    try {
      const cfg = await loadConfig();
      const id = String(req.params.id).replace(/\D/g, '');
      const [customer, entries] = await Promise.all([readCustomer(id), ledger.customerEntries(supabase, id)]);
      const points = entries.reduce((s, r) => s + (Number(r.points) || 0), 0);
      const t = E.tierFor(points, cfg);
      return res.json({ success: true, customer, points, tier: t.tier, next: t.next, gapToNext: t.gapToNext, entries });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loyalty/customer/:id/refresh', requireEnabled, requireAdmin, async (req, res) => {
    try { return res.json({ success: true, result: await refreshCustomer(String(req.params.id).replace(/\D/g, ''), { notify: false }) }); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loyalty/adjust', requireEnabled, requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!b.customerId || !Number.isFinite(Number(b.points)) || !b.key) {
      return res.status(400).json({ success: false, error: 'customerId, points and a unique key are required' });
    }
    try {
      await ledger.addAdjustment(supabase, { customerId: b.customerId, entryKey: b.key, points: Number(b.points), note: b.note });
      return res.json({ success: true, result: await refreshCustomer(String(b.customerId), { notify: false }) });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/loyalty/redemptions', requireEnabled, requireAdmin, async (req, res) => {
    try {
      let q = supabase.from('loyalty_redemptions').select('*').order('created_at', { ascending: false }).limit(500);
      if (req.query.mismatch) q = q.eq('customer_mismatch', true);
      if (req.query.status) q = q.eq('status', String(req.query.status));
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return res.json({ success: true, count: (data || []).length, rows: data || [] });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loyalty/voucher-combos', requireEnabled, requireAdmin, async (req, res) => {
    try {
      const open = await creditInstruments.listOpenForCustomer(supabase, { instrumentType: 'voucher' });
      const out = { updated: 0, already: 0, notFound: 0, failed: [] };
      for (const v of open) {
        try {
          const r = await allowVoucherWithLoyalty(v.serial_code);
          if (r === 'updated') out.updated++; else if (r === 'already') out.already++; else out.notFound++;
        } catch (e) { out.failed.push(`${v.serial_code}: ${e.message}`); }
      }
      return res.json({ success: true, vouchers: open.length, ...out });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  // Live acceptance self-test (loyalty/UAT_LOYALTY.md). Creates and deletes scratch drafts and its own
  // codes on a UAT test customer; never creates an order. Driven by tools/loyalty-uat.js.
  app.post('/api/loyalty/selftest', requireEnabled, requireAdmin, (req, res) => {
    const b = req.body || {};
    if (!b.customerId || !b.eligibleVariantId) return res.status(400).json({ success: false, error: 'customerId and eligibleVariantId are required' });
    return res.json({ success: true, ...require('./selftest').start(b) });
  });
  app.get('/api/loyalty/selftest', requireEnabled, requireAdmin, (req, res) => res.json({ success: true, job: require('./selftest').status() }));

  // Simulate the benefit on any cart and date without creating anything: the engine with real
  // catalogue facts and either a real customer or a made-up profile.
  //   { lines: [{variant_id, quantity}], customerId? | profile?: {points, birthday, anniversary}, date? }
  app.post('/api/loyalty/simulate/cart', requireEnabled, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const cfg = await loadConfig();
      let prof = b.profile || {};
      if (b.customerId) {
        const c = await readCustomer(String(b.customerId));
        prof = { points: await ledger.customerPoints(supabase, String(b.customerId)), birthday: c && c.birthday, anniversary: c && c.anniversary };
      }
      const facts = await online.cartLineFacts(b.lines || []);
      const lines = (b.lines || []).map(l => {
        const f = facts[String(l.variant_id)] || {};
        const q = Math.max(1, parseInt(l.quantity, 10) || 1);
        return { variant_id: String(l.variant_id), title: f.title, sku: f.sku, productType: f.productType, tags: f.tags,
          collections: f.collections, jewelCode: f.jewelCode, diamond: (f.diamondUnit || 0) * q };
      });
      const r = E.computeLoyalty({ ...prof, lines, cfg, now: b.date ? new Date(b.date) : new Date() });
      return res.json({ success: true, ...r, onlineAmount: E.onlineAmount(r.total), lines });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  // What an existing order earns under the rule, without writing anything. { orderId }
  app.post('/api/loyalty/simulate/order', requireEnabled, requireAdmin, async (req, res) => {
    try {
      const id = String((req.body || {}).orderId || '').replace(/\D/g, '');
      const { order } = await getJson(`orders/${id}.json`);
      const data = await graphql(`query($id: ID!) { order(id: $id) { r: metafield(namespace: "custom", key: "amount_refunded") { value } } }`, { id: `gid://shopify/Order/${id}` });
      const refunded = Number(data.order && data.order.r && data.order.r.value) || 0;
      const { data: row } = await supabase.from('loyalty_ledger').select('*').eq('entry_key', `order:${id}`).maybeSingle();
      return res.json({ success: true, order: order.name, customerId: order.customer && order.customer.id,
        earns: E.earnPoints(order, await loadConfig(), { amountRefunded: refunded }), ledger: row || null });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loyalty/sweep', requireEnabled, requireAdmin, async (req, res) => {
    try { return res.json({ success: true, ...(await runLoyaltySweep({ dryRun: !!req.query.dryRun })) }); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });
}

module.exports = { register, allowVoucherWithLoyalty, setup };
