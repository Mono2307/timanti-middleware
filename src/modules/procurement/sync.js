'use strict';

const axios = require('axios');

const PO_QUEUE_SCRIPT_URL = process.env.PO_QUEUE_SCRIPT_URL;

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function getCustomerName(record) {
  const first = record.customer?.first_name || record.billing_address?.first_name || record.shipping_address?.first_name || '';
  const last  = record.customer?.last_name  || record.billing_address?.last_name  || record.shipping_address?.last_name  || '';
  return `${first} ${last}`.trim();
}

async function fetchMetafields(resource, id, token, shopifyStoreUrl) {
  try {
    const res = await axios.get(
      `${shopifyStoreUrl}/admin/api/2024-01/${resource}/${id}/metafields.json`,
      { headers: shopifyHeaders(token), timeout: 10000 }
    );
    return res.data.metafields || [];
  } catch (e) {
    console.error(`[SYNC] metafield fetch failed for ${resource}/${id}:`, e.message);
    return [];
  }
}

// ── Variant jewel_code cache ─────────────────────────────────────────────────
//
// buildRows reads jewel_code from each line's variant, one REST call per line, every time it runs.
// That made this module the single largest consumer of the Shopify REST budget during a webhook
// burst: five lines is six calls per pass, and #D223 ran ten passes in nine seconds. The log for it is
// wall-to-wall `[SYNC] metafield fetch failed for variants/... 429`, and those 429s were also starving
// the collection recompute at the end of the chain.
//
// jewel_code is catalog data — it is assigned once when the piece is created and does not change
// while a draft is being edited. Re-reading it per pass bought nothing. A short TTL keeps a genuine
// catalog edit from going unnoticed for long, while collapsing a burst to one read per variant.
const JEWEL_CODE_TTL_MS = 10 * 60 * 1000;
const _jewelCodeCache = new Map();   // variantId -> { code, at }

async function getJewelCode(variantId, token, shopifyStoreUrl) {
  const key = String(variantId);
  const hit = _jewelCodeCache.get(key);
  if (hit && (Date.now() - hit.at) < JEWEL_CODE_TTL_MS) return hit.code;

  const metas = await fetchMetafields('variants', variantId, token, shopifyStoreUrl);
  const code  = metas.find(m => m.namespace === 'custom' && m.key === 'jewel_code')?.value || '';
  // A failed fetch returns [] and would cache an empty code as though the variant had none. Only
  // cache a real answer; a miss should be retried on the next pass, not remembered for ten minutes.
  if (metas.length) _jewelCodeCache.set(key, { code, at: Date.now() });
  return code;
}

// ── Trailing debounce ────────────────────────────────────────────────────────
//
// One staff edit delivers the draft webhook many times over, and each delivery used to run a full
// sheet sync: every variant re-read, then an Apps Script POST with a 15-second timeout. Five of those
// timed out in the #D223 window alone, holding connections open while the rest of the chain was being
// rate-limited.
//
// Only the LAST delivery's data matters — the sheet is upserted wholesale, so intermediate passes
// write rows that the next pass immediately overwrites. Trailing edge on purpose: fire after the burst
// settles, with the freshest payload, rather than on the first delivery with the stalest.
//
// Safe because every caller is fire-and-forget (procurement/routes.js runs this off a .then with a
// .catch and never awaits it), so returning before the work happens changes nothing for them. The
// full-resync entry points below deliberately bypass this and call the underlying function directly.
const SYNC_DEBOUNCE_MS = 2500;
const _syncTimers = new Map();   // key -> timeout

function debounceSync(key, fn) {
  const existing = _syncTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _syncTimers.delete(key);
    Promise.resolve(fn()).catch(e => console.error(`[SYNC] debounced sync failed for ${key}:`, e.message));
  }, SYNC_DEBOUNCE_MS);
  // Do not hold the process open for a pending sheet write during shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  _syncTimers.set(key, timer);
}

async function postToPoQueue(payload) {
  if (!PO_QUEUE_SCRIPT_URL) { console.warn('[SYNC] PO_QUEUE_SCRIPT_URL not set — skipping sheet sync'); return; }
  try {
    const res = await axios.post(PO_QUEUE_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' }, timeout: 15000
    });
    if (!res.data?.ok) console.warn('[SYNC] Apps Script returned error:', JSON.stringify(res.data));
  } catch (e) {
    console.error('[SYNC] Apps Script error:', e.message);
  }
}

function orderTypeToTab(orderType) {
  if (orderType === 'mto')       return 'mto';
  if (orderType === 'in-stock')  return 'InStock';
  return 'unclassified';
}

async function buildRows(sourceId, orderName, sourceType, customerName, lineItems, shopifyToken, shopifyStoreUrl, extra) {
  const rows = [];
  for (const item of lineItems) {
    let jewelCode = '';
    if (item.variant_id) {
      jewelCode = await getJewelCode(item.variant_id, shopifyToken, shopifyStoreUrl);
    }
    rows.push({
      source_id:            sourceId,
      source_type:          sourceType,
      order_name:           orderName,
      customer_name:        customerName,
      line_item_id:         String(item.id),
      variant_id:           String(item.variant_id || ''),
      product_title:        item.title || '',
      sku:                  item.sku || '',
      original_qty:         item.quantity,
      jewel_code:           jewelCode,
      line_item_properties: JSON.stringify((item.properties || []).filter(p => !p.name.startsWith('_'))),
      synced_at:            new Date().toISOString(),
      ...extra
    });
  }
  return rows;
}

async function syncDraftOrderToSheetNow(draftOrder, shopifyToken, shopifyStoreUrl) {
  // Skip completed drafts (converted to orders) — Shopify fires draft_orders/update
  // with status=completed when a draft is converted; without this guard the webhook
  // re-inserts stale rows that the orders/create handler just cleaned up.
  if (draftOrder.status === 'completed') return;
  // Skip vendor PO draft orders created by the batch raise
  const tags = (draftOrder.tags || '').toLowerCase().split(',').map(t => t.trim());
  if (tags.some(t => t.startsWith('po-') || t === 'po-draft')) return;

  const lineItems = draftOrder.line_items || [];
  if (!lineItems.length) return;

  const metas     = await fetchMetafields('draft_orders', draftOrder.id, shopifyToken, shopifyStoreUrl);
  const orderType = metas.find(m => m.namespace === 'custom' && m.key === 'order_type')?.value;
  const stateCode = metas.find(m => m.namespace === 'custom' && m.key === 'state_code')?.value || '';
  const tab       = orderTypeToTab(orderType);

  // Carry the source order's place of supply onto every row so the batch raise can split by
  // location (one PO + one serial per store code). Already in `metas` — no extra Shopify call.
  const rows = await buildRows(
    String(draftOrder.id), draftOrder.name, 'draft_order',
    getCustomerName(draftOrder), lineItems, shopifyToken, shopifyStoreUrl, { store_code: stateCode }
  );

  await postToPoQueue({ action: 'upsertRows', tab, rows });
  console.log(`[SYNC] ${draftOrder.name} → ${tab} (${rows.length} rows)`);
}

async function syncOrderToSheet(order, shopifyToken, shopifyStoreUrl) {
  const lineItems = order.line_items || [];
  if (!lineItems.length) return;

  const metas     = await fetchMetafields('orders', order.id, shopifyToken, shopifyStoreUrl);
  const orderType = metas.find(m => m.namespace === 'custom' && m.key === 'order_type')?.value;
  const stateCode = metas.find(m => m.namespace === 'custom' && m.key === 'state_code')?.value || '';
  const tab       = orderTypeToTab(orderType);

  // Carry the source order's place of supply onto every row so the batch raise can split by
  // location (one PO + one serial per store code). Already in `metas` — no extra Shopify call.
  const extra = { store_code: stateCode };
  // If this order was converted from a draft, pass the originating draft order id so the
  // sheet can drop the now-stale draft rows. Shopify sets source_name to 'shopify_draft_order'
  // (NOT 'draft_orders') and source_identifier to the draft order's numeric id.
  if (order.source_name === 'shopify_draft_order' && order.source_identifier) {
    extra.source_draft_name = String(order.source_identifier);
  }

  const rows = await buildRows(
    String(order.id), order.name, 'order',
    getCustomerName(order), lineItems, shopifyToken, shopifyStoreUrl, extra
  );

  await postToPoQueue({ action: 'upsertRows', tab, rows });
  console.log(`[SYNC] ${order.name} → ${tab} (${rows.length} rows)`);
}

// Webhook-facing wrapper. The burst of deliveries behind one staff edit collapses into a single
// sync on the freshest payload. Callers never await this — see the note on debounceSync.
function syncDraftOrderToSheet(draftOrder, shopifyToken, shopifyStoreUrl) {
  if (!draftOrder?.id) return;
  debounceSync(`draft:${draftOrder.id}`, () => syncDraftOrderToSheetNow(draftOrder, shopifyToken, shopifyStoreUrl));
}

async function removeDraftFromSheet(draftId) {
  // Cancel any sync still waiting for this draft. Without this, a debounced upsert queued moments
  // before the delete would fire afterwards and resurrect the rows this call just removed.
  const key = `draft:${draftId}`;
  const pending = _syncTimers.get(key);
  if (pending) { clearTimeout(pending); _syncTimers.delete(key); }
  await postToPoQueue({ action: 'removeSource', sourceId: String(draftId) });
  console.log(`[SYNC] removed draft ${draftId} from sheet`);
}

async function pruneOrphans(validSourceIds) {
  await postToPoQueue({ action: 'pruneOrphans', validSourceIds });
  console.log(`[SYNC] pruned orphans — ${validSourceIds.length} valid source IDs`);
}

async function syncAllDraftOrders(shopifyToken, shopifyStoreUrl) {
  console.log('[SYNC] starting draft order sync');
  let url   = `${shopifyStoreUrl}/admin/api/2024-01/draft_orders.json?limit=250&status=open`;
  let count = 0;
  const syncedIds = [];

  while (url) {
    const res    = await axios.get(url, { headers: shopifyHeaders(shopifyToken), timeout: 30000 });
    const orders = res.data.draft_orders || [];
    for (const order of orders) {
      // Deliberately the undebounced worker: this loop is already serial and is the caller that
      // WANTS every draft written. Routing it through the debounce would schedule one timer per
      // draft and then fire them all at once 2.5s later — turning a paced walk into the burst the
      // debounce exists to prevent.
      await syncDraftOrderToSheetNow(order, shopifyToken, shopifyStoreUrl);
      syncedIds.push(String(order.id));
      count++;
    }
    const link = res.headers['link'] || '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }

  console.log(`[SYNC] draft orders complete — ${count} processed`);
  return syncedIds;
}

async function syncAllOrders(shopifyToken, shopifyStoreUrl) {
  console.log('[SYNC] starting order sync');
  let url   = `${shopifyStoreUrl}/admin/api/2024-01/orders.json?limit=250&status=open`;
  let count = 0;
  const syncedIds = [];

  while (url) {
    const res    = await axios.get(url, { headers: shopifyHeaders(shopifyToken), timeout: 30000 });
    const orders = res.data.orders || [];
    for (const order of orders) {
      await syncOrderToSheet(order, shopifyToken, shopifyStoreUrl);
      syncedIds.push(String(order.id));
      count++;
    }
    const link = res.headers['link'] || '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }

  console.log(`[SYNC] orders complete — ${count} processed`);
  return syncedIds;
}

module.exports = {
  syncDraftOrderToSheet,       // debounced — for webhook paths
  syncDraftOrderToSheetNow,    // immediate — for bulk resync and tests
  syncOrderToSheet, syncAllDraftOrders, syncAllOrders, removeDraftFromSheet, pruneOrphans,
};
