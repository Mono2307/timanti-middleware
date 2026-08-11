'use strict';

/**
 * Procurement (PO Ops) — purchase orders driven from a Google Sheet.
 *
 * Buying runs on a spreadsheet: staff raise purchase orders there, and this module keeps the
 * sheet and Shopify in step. Drafts and orders are mirrored into the sheet, POs are raised in
 * batches, and prices can be pushed back from the sheet onto the drafts.
 *
 * ENTRY POINT
 *   register(app, ctx)
 *
 * ENDPOINTS
 *   POST /api/po-webhook                  Shopify draft/order webhook -> sheet sync
 *   GET  /api/po-action                   action links clicked from inside the sheet
 *   POST /api/po-ops/sync-all             full re-sync of drafts and orders, prunes orphans
 *   POST /api/po-ops/batch-raise-po       raise POs for a batch
 *   POST /api/po-ops/reprice-from-sheet   push sheet prices back onto drafts
 *
 * EXIT POINTS
 *   modules/procurement/{webhook,action,sync,batch}.js   the PO Ops engine
 *   modules/serialization                                 PO numbering
 *   core/shopify, core/supabase
 *
 * ctx.handleRecalculatePriceTag — TEMPORARY COUPLING. reprice-from-sheet re-runs the pricing
 * engine after writing sheet prices, and that engine is still inside server.js. It is injected
 * through ctx rather than required directly, so this module never imports the bootstrap. When
 * pricing moves to src/modules/pricing this becomes a normal require and the ctx entry goes away.
 */

const axios = require('axios');

const { config }   = require('../../core/config');
const { supabase } = require('../../core/supabase');
const { getShopifyToken } = require('../../core/shopify');
const { log } = require('../../core/logger');

const serialization = require('../serialization');
const { handlePoWebhook } = require('./webhook');
const { handlePoAction }  = require('./action');
const { syncAllDraftOrders, syncAllOrders, pruneOrphans } = require('./sync');
const { batchRaisePo } = require('./batch');

const SERIAL_PO = config.serial.po;

/** Dependency bundle for the PO Ops engine. */
const PO_DEPS = () => ({
  supabase,
  getShopifyToken,
  shopifyStoreUrl: config.shopify.storeUrl,
  serialization,
  serialPo: SERIAL_PO,
});

function register(app, ctx) {
  const { handleRecalculatePriceTag } = ctx;


app.post('/api/po-webhook', async (req, res) => {
  const deps  = PO_DEPS();
  const topic = req.headers['x-shopify-topic'] || '';
  if (topic.startsWith('draft_orders') && req.body?.id) {
    getShopifyToken()
      .then(token => syncDraftOrderToSheet(req.body, token, deps.shopifyStoreUrl))
      .catch(e => console.error('[SYNC] draft webhook error:', e.message));
  } else if (topic.startsWith('orders/') && req.body?.id) {
    getShopifyToken()
      .then(token => syncOrderToSheet(req.body, token, deps.shopifyStoreUrl))
      .catch(e => console.error('[SYNC] order webhook error:', e.message));
  } else if (topic === 'draft_orders/delete' && req.body?.id) {
    removeDraftFromSheet(req.body.id)
      .catch(e => console.error('[SYNC] delete webhook error:', e.message));
    // Draft abandoned → free any credit instruments that were only APPLIED to it (never converted).
    creditInstruments.revertApplied(supabase, { targetDraftId: String(req.body.id) })
      .then(r => { if (r.length) console.log(`[ledger] draft ${req.body.id} deleted → reverted ${r.join(', ')} to open`); })
      .catch(e => console.error('[ledger] revert on draft delete:', e.message));
  }
  return handlePoWebhook(req, res, deps);
});
app.get('/api/po-action',   (req, res) => handlePoAction(req, res, PO_DEPS()));


// ── PO Queue routes ───────────────────────────────────────────────

app.post('/api/po-ops/sync-all', async (req, res) => {
  try {
    const token = await getShopifyToken();
    res.json({ ok: true, message: 'Sync Started' });
    Promise.all([
      syncAllDraftOrders(token, process.env.SHOPIFY_STORE_URL),
      syncAllOrders(token, process.env.SHOPIFY_STORE_URL)
    ]).then(([draftIds, orderIds]) => pruneOrphans([...draftIds, ...orderIds]))
      .catch(e => console.error('[SYNC-ALL]', e.message));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/po-ops/batch-raise-po', async (req, res) => {
  const { po_type, rows, store_code } = req.body;
  if (!po_type || !rows?.length) return res.status(400).json({ ok: false, error: 'po_type and rows required' });
  try {
    const token  = await getShopifyToken();
    const result = await batchRaisePo({ po_type, rows, store_code, shopifyToken: token, shopifyStoreUrl: process.env.SHOPIFY_STORE_URL, supabase });
    return res.json(result);
  } catch (e) {
    console.error('[BATCH-PO]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/po-ops/reprice-from-sheet', async (req, res) => {
  const { draft_order_id, line_item_id, net_wt, gross_wt, dia_cts, gemstone_cts, gold_rate, gold_rate_date } = req.body;
  if (!draft_order_id)    return res.status(400).json({ ok: false, error: 'draft_order_id required' });
  if (!net_wt || !gross_wt) return res.status(400).json({ ok: false, error: 'net_wt and gross_wt required' });
  try {
    const token   = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const baseUrl = process.env.SHOPIFY_STORE_URL;

    // 1. Write weight metafields (same keys as handleRecalculatePriceTag reads)
    const mfRes = await axios.get(`${baseUrl}/admin/api/2024-01/draft_orders/${draft_order_id}/metafields.json`, { headers, timeout: 10000 });
    const existingMf = {};
    for (const mf of (mfRes.data.metafields || [])) if (mf.namespace === 'custom') existingMf[mf.key] = mf;

    const mfMap = {
      jewelcode_net_weight:      String(net_wt),
      jewelcode_gross_weight:    String(gross_wt),
      jewelcode_diamond_carats:  String(dia_cts || 0),
      jewelcode_gemstone_weight: String(gemstone_cts || 0),
      ...(gold_rate ? { gold_rate: String(gold_rate) } : {})
    };

    await Promise.all(Object.entries(mfMap).map(async ([key, value]) => {
      const payload = { metafield: { namespace: 'custom', key, value, type: 'single_line_text_field' } };
      if (existingMf[key]) {
        await axios.put(`${baseUrl}/admin/api/2024-01/draft_orders/${draft_order_id}/metafields/${existingMf[key].id}.json`, payload, { headers, timeout: 10000 });
      } else {
        await axios.post(`${baseUrl}/admin/api/2024-01/draft_orders/${draft_order_id}/metafields.json`, payload, { headers, timeout: 10000 });
      }
    }));

    // 2. Fetch draft and inject reprice tag locally (same pattern as /api/reprice)
    const { data: draftData } = await axios.get(`${baseUrl}/admin/api/2024-01/draft_orders/${draft_order_id}.json`, { headers, timeout: 10000 });
    const draft = draftData.draft_order;
    const existingTags = (draft.tags || '').split(',').map(t => t.trim()).filter(t => t && t.toLowerCase() !== 'reprice');
    const draftWithTag = { ...draft, tags: [...existingTags, 'reprice'].join(', ') };

    // 3. Force reprice (bypasses 5% threshold)
    await handleRecalculatePriceTag(draftWithTag, { force: true });

    // 4. Override _gold_updated_at if gold_rate_date was supplied
    if (gold_rate_date && line_item_id) {
      const { data: repriced } = await axios.get(`${baseUrl}/admin/api/2024-01/draft_orders/${draft_order_id}.json`, { headers, timeout: 10000 });
      const allItems    = repriced.draft_order.line_items || [];
      const patchedItems = allItems.map(li => {
        if (String(li.id) !== String(line_item_id)) {
          return { variant_id: li.variant_id, quantity: li.quantity, price: li.price, properties: li.properties || [], title: li.title };
        }
        const props = (li.properties || []).map(p =>
          p.name === '_gold_updated_at' ? { ...p, value: String(gold_rate_date) } : p
        );
        if (!props.find(p => p.name === '_gold_updated_at')) props.push({ name: '_gold_updated_at', value: String(gold_rate_date) });
        return { variant_id: li.variant_id, quantity: li.quantity, price: li.price, properties: props, title: li.title };
      });
      await gqlSetDraftLineItems(draft_order_id, patchedItems, token, {});
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[REPRICE-FROM-SHEET]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});


}

module.exports = { register, PO_DEPS };
