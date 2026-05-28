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
      const varMetas = await fetchMetafields('variants', item.variant_id, shopifyToken, shopifyStoreUrl);
      jewelCode = varMetas.find(m => m.namespace === 'custom' && m.key === 'jewel_code')?.value || '';
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

async function syncDraftOrderToSheet(draftOrder, shopifyToken, shopifyStoreUrl) {
  // Skip vendor PO draft orders created by the batch raise
  const tags = (draftOrder.tags || '').toLowerCase().split(',').map(t => t.trim());
  if (tags.some(t => t.startsWith('po-') || t === 'po-draft')) return;

  const lineItems = draftOrder.line_items || [];
  if (!lineItems.length) return;

  const metas     = await fetchMetafields('draft_orders', draftOrder.id, shopifyToken, shopifyStoreUrl);
  const orderType = metas.find(m => m.namespace === 'custom' && m.key === 'order_type')?.value;
  const tab       = orderTypeToTab(orderType);

  const rows = await buildRows(
    String(draftOrder.id), draftOrder.name, 'draft_order',
    getCustomerName(draftOrder), lineItems, shopifyToken, shopifyStoreUrl, {}
  );

  await postToPoQueue({ action: 'upsertRows', tab, rows });
  console.log(`[SYNC] ${draftOrder.name} → ${tab} (${rows.length} rows)`);
}

async function syncOrderToSheet(order, shopifyToken, shopifyStoreUrl) {
  const lineItems = order.line_items || [];
  if (!lineItems.length) return;

  const metas     = await fetchMetafields('orders', order.id, shopifyToken, shopifyStoreUrl);
  const orderType = metas.find(m => m.namespace === 'custom' && m.key === 'order_type')?.value;
  const tab       = orderTypeToTab(orderType);

  // If this order was converted from a draft, pass the draft name for deduplication in the sheet
  const extra = (order.source_name === 'draft_orders' && order.source_identifier)
    ? { source_draft_name: order.source_identifier }
    : {};

  const rows = await buildRows(
    String(order.id), order.name, 'order',
    getCustomerName(order), lineItems, shopifyToken, shopifyStoreUrl, extra
  );

  await postToPoQueue({ action: 'upsertRows', tab, rows });
  console.log(`[SYNC] ${order.name} → ${tab} (${rows.length} rows)`);
}

async function removeDraftFromSheet(draftId) {
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
      await syncDraftOrderToSheet(order, shopifyToken, shopifyStoreUrl);
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

module.exports = { syncDraftOrderToSheet, syncOrderToSheet, syncAllDraftOrders, syncAllOrders, removeDraftFromSheet, pruneOrphans };
