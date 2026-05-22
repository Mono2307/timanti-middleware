'use strict';

const axios = require('axios');

const PO_QUEUE_SCRIPT_URL = process.env.PO_QUEUE_SCRIPT_URL;

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function getCustomerName(order) {
  const first = order.customer?.first_name || order.billing_address?.first_name || order.shipping_address?.first_name || '';
  const last  = order.customer?.last_name  || order.billing_address?.last_name  || order.shipping_address?.last_name  || '';
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
    await axios.post(PO_QUEUE_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' }, timeout: 15000
    });
  } catch (e) {
    console.error('[SYNC] Apps Script error:', e.message);
  }
}

async function syncDraftOrderToSheet(draftOrder, shopifyToken, shopifyStoreUrl) {
  const metas     = await fetchMetafields('draft_orders', draftOrder.id, shopifyToken, shopifyStoreUrl);
  const orderType = metas.find(m => m.namespace === 'custom' && m.key === 'order_type')?.value;

  if (!orderType || !['mto', 'in-stock'].includes(orderType)) {
    console.log(`[SYNC] ${draftOrder.name}: custom.order_type="${orderType || 'unset'}" — skipping`);
    return;
  }

  const tab       = orderType === 'mto' ? 'MTO' : 'InStock';
  const lineItems = draftOrder.line_items || [];
  if (!lineItems.length) return;

  const rows = [];
  for (const item of lineItems) {
    let jewelCode = '';
    if (item.variant_id) {
      const varMetas = await fetchMetafields('variants', item.variant_id, shopifyToken, shopifyStoreUrl);
      jewelCode = varMetas.find(m => m.namespace === 'custom' && m.key === 'jewel_code')?.value || '';
    }

    rows.push({
      draft_order_id:       String(draftOrder.id),
      draft_order_name:     draftOrder.name,
      customer_name:        getCustomerName(draftOrder),
      line_item_id:         String(item.id),
      variant_id:           String(item.variant_id || ''),
      product_title:        item.title || '',
      sku:                  item.sku || '',
      original_qty:         item.quantity,
      jewel_code:           jewelCode,
      line_item_properties: JSON.stringify((item.properties || []).filter(p => !p.name.startsWith('_'))),
      synced_at:            new Date().toISOString()
    });
  }

  await postToPoQueue({ action: 'upsertRows', tab, rows });
  console.log(`[SYNC] ${draftOrder.name} → ${tab} (${rows.length} rows)`);
}

async function syncAllDraftOrders(shopifyToken, shopifyStoreUrl) {
  console.log('[SYNC] starting full draft order sync');
  let url   = `${shopifyStoreUrl}/admin/api/2024-01/draft_orders.json?limit=250&status=open`;
  let count = 0;

  while (url) {
    const res    = await axios.get(url, { headers: shopifyHeaders(shopifyToken), timeout: 30000 });
    const orders = res.data.draft_orders || [];

    for (const order of orders) {
      await syncDraftOrderToSheet(order, shopifyToken, shopifyStoreUrl);
      count++;
    }

    // Follow Shopify's Link header for cursor pagination
    const link = res.headers['link'] || '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }

  console.log(`[SYNC] complete — ${count} draft orders processed`);
}

module.exports = { syncDraftOrderToSheet, syncAllDraftOrders };
