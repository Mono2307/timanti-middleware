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
// syncDraftOrderToSheet / syncOrderToSheet / removeDraftFromSheet were used below but never
// imported — a ReferenceError on EVERY draft and order webhook since the src/ restructure, swallowed
// by the .catch() beside each call. 56 'syncDraftOrderToSheet is not defined' lines in one hour of
// production logs on 2026-08-29. The PO sheet has not been kept in step with Shopify since.
// Same class as the _buyingTableCache fault that once took the whole process down.
const { syncDraftOrderToSheet, syncOrderToSheet, removeDraftFromSheet,
        syncAllDraftOrders, syncAllOrders, pruneOrphans } = require('./sync');
const { batchRaisePo } = require('./batch');
// Same omission as the sync trio above, one branch further down: the draft-delete handler calls
// creditInstruments.revertApplied and this was never imported. It is a bare identifier, so the
// ReferenceError is thrown while EVALUATING the expression — before the trailing .catch() can ever
// attach — which aborts the whole else-if branch. Two consequences, both silent: a voucher applied
// to a deleted draft was never freed back to 'open', and the refund bookkeeping below it never ran.
const creditInstruments = require('../adjustments/credit_instruments');

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
  const { handleRecalculatePriceTag, gqlSetDraftLineItems, handleDraftDeletedRefunds,
          handleOrderRefundSync, handleOrderRefundEmail, applyPaymentTagsToOrder } = ctx;


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
    // This is the ONLY webhook this app receives for orders, so it is where the order-side refund
    // trigger tags get consumed. Both handlers no-op unless their tag is present, and each strips its
    // own tag, so an unrelated orders/updated (the great majority) costs one early return.
    //
    // Isolated from the sheet sync above and from each other: neither may take the other down.
    if (handleOrderRefundSync) {
      handleOrderRefundSync(req.body)
        .catch(e => console.error('[refunds] order sync on webhook:', e.message));
    }
    if (handleOrderRefundEmail) {
      handleOrderRefundEmail(req.body)
        .catch(e => console.error('[refunds] order email on webhook:', e.message));
    }
    // The panel adds sync-payment on an ORDER too (its payment fields apply to both), and until now
    // nothing on this side consumed it — so the tag sat there forever and the balance never
    // recomputed after an order-side edit. Run the same recompute the draft chain runs, AFTER the
    // refund sync above, so amount_pending derives off a fresh amount_refunded.
    //
    // Deliberately gated on the trigger tags rather than firing on every orders/updated: this webhook
    // is high volume, and a blanket recompute would rewrite tags across the whole store. The tag
    // writer's own idempotence guard ("payment tags unchanged, skipping PUT") stops the PUT it makes
    // from re-triggering this forever.
    const otags = (req.body.tags || '').split(',').map(t => t.trim().toLowerCase());
    if (applyPaymentTagsToOrder && (otags.includes('sync-payment') || otags.includes('sync-refund'))) {
      getShopifyToken()
        .then(token => applyPaymentTagsToOrder(String(req.body.id), token))
        .catch(e => console.error('[payments] order tag recompute on webhook:', e.message));
    }
  } else if (topic === 'draft_orders/delete' && req.body?.id) {
    removeDraftFromSheet(req.body.id)
      .catch(e => console.error('[SYNC] delete webhook error:', e.message));
    // Draft abandoned → free any credit instruments that were only APPLIED to it (never converted).
    creditInstruments.revertApplied(supabase, { targetDraftId: String(req.body.id) })
      .then(r => { if (r.length) console.log(`[ledger] draft ${req.body.id} deleted → reverted ${r.join(', ')} to open`); })
      .catch(e => console.error('[ledger] revert on draft delete:', e.message));
    // Refund rows must SURVIVE the delete — a refunded draft is usually deleted, and the money
    // having gone back stays true when the document is gone. revertApplied only matches
    // status='applied', so it already cannot reach them; this only records that the draft no longer
    // exists, so a later report can tell "outside the window" from "no longer there".
    if (handleDraftDeletedRefunds) {
      handleDraftDeletedRefunds(String(req.body.id))
        .catch(e => console.error('[ledger] refund bookkeeping on draft delete:', e.message));
    }
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
