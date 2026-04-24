'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { sendEmail } = require('../../emailService');

const WEBHOOK_SECRET  = process.env.SHOPIFY_WEBHOOK_SECRET;
const HQ_EMAIL        = process.env.HQ_EMAIL;
const HQ_CC_EMAIL     = process.env.HQ_CC_EMAIL;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const MIDDLEWARE_URL  = process.env.MIDDLEWARE_BASE_URL;

const ENABLE_CC = true; // set true once testing is done

// ─── HMAC ─────────────────────────────────────────────────────────────────────

function verifyHmac(rawBody, signature, secret) {
  try {
    const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch (_) { return false; }
}

// ─── Shopify helpers ──────────────────────────────────────────────────────────

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildLink(token, action) {
  return `${MIDDLEWARE_URL}/api/po-action?action=${action}&token=${token}`;
}

// ─── Read variant picker metafields → group line items by po_type ─────────────
// Staff uses Shopify's native variant search picker on the order/draft order page.
// Two metafield definitions needed (type: list.variant_reference) on Orders + Draft Orders:
//   custom.po_mto_variants          → variants to raise as MTO PO
//   custom.po_replenishment_variants → variants to raise as replenishment PO
//
// Shopify stores these as arrays of GIDs: ["gid://shopify/ProductVariant/12345", ...]
// We extract the numeric ID and match against line_item.variant_id.

function extractVariantId(gid) {
  return String(gid).split('/').pop();
}

async function getPoGroups(orderId, lineItems, isDraftOrder, shopifyToken, shopifyStoreUrl) {
  const resource = isDraftOrder ? 'draft_orders' : 'orders';

  let metas;
  try {
    const res = await axios.get(
      `${shopifyStoreUrl}/admin/api/2024-01/${resource}/${orderId}/metafields.json`,
      { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
    );
    metas = res.data.metafields || [];
  } catch (e) {
    console.error('Metafield fetch failed:', e.message);
    return {};
  }

  const find = key => metas.find(m => m.namespace === 'custom' && m.key === key);
  const mtoMf = find('po_mto_variants');
  const repMf = find('po_replenishment_variants');

  console.log(`[PO] metafields — mto: ${mtoMf?.value || 'none'} | rep: ${repMf?.value || 'none'}`);
  console.log(`[PO] line item variant_ids: ${lineItems.map(i => i.variant_id).join(', ')}`);

  if (!mtoMf?.value && !repMf?.value) {
    console.log('[PO] no po metafields set — skipping');
    return { groups: {}, comments: { mto: '', replenishment: '' } };
  }

  // Values come as JSON arrays of GIDs or already-parsed arrays
  const parseIds = mf => {
    if (!mf?.value) return [];
    const raw = typeof mf.value === 'string' ? JSON.parse(mf.value) : mf.value;
    return (Array.isArray(raw) ? raw : [raw]).map(extractVariantId);
  };

  const mtoIds = parseIds(mtoMf);
  const repIds = parseIds(repMf);

  console.log(`[PO] parsed IDs — mto: [${mtoIds}] | rep: [${repIds}]`);

  const groups = {};
  if (mtoIds.length) {
    const matched = lineItems.filter(i => mtoIds.includes(String(i.variant_id)));
    console.log(`[PO] mto matched ${matched.length}/${lineItems.length} items`);
    if (matched.length) groups.mto = matched;
  }
  if (repIds.length) {
    const matched = lineItems.filter(i => repIds.includes(String(i.variant_id)));
    console.log(`[PO] rep matched ${matched.length}/${lineItems.length} items`);
    if (matched.length) groups.replenishment = matched;
  }

  console.log(`[PO] groups to create: ${Object.keys(groups).join(', ') || 'none'}`);
  return {
    groups,
    comments: {
      mto:           find('mto_comments')?.value           || '',
      replenishment: find('replenishment_comments')?.value || ''
    }
  };
}

// ─── Create PO draft order ───────────────────────────────────────────────────

function getSpecialInstructions(item) {
  return (item.properties || [])
    .filter(p => !p.name.startsWith('_'))
    .map(p => `${p.name}: ${p.value}`)
    .join(' | ');
}

async function createPoDraftOrder({ order, lineItems, poType, sourceOrderName, sourceOrderId, shopifyToken, shopifyStoreUrl, poComments }) {
  const token = generateToken();

  const body = {
    draft_order: {
      line_items: lineItems.map(item => ({
        variant_id: item.variant_id,
        quantity:   item.quantity,
        price:      '0.00',
        title:      item.title,
        properties: [
          { name: 'Special Instructions', value: getSpecialInstructions(item) },
          { name: '_source_line_item_id', value: String(item.id) }
        ].filter(p => p.value)
      })),
      note: `Auto-generated ${poType} PO for ${sourceOrderName}`,
      note_attributes: [
        { name: 'action_acknowledge', value: buildLink(token, 'acknowledge') },
        { name: 'action_ordered',     value: buildLink(token, 'ordered') },
        { name: 'action_qc_passed',   value: buildLink(token, 'qc_passed') },
        { name: 'action_shipped',     value: buildLink(token, 'shipped') },
      ],
      metafields: [
        { namespace: 'custom', key: 'po_type',           value: poType,          type: 'single_line_text_field' },
        { namespace: 'custom', key: 'po_status',         value: 'pending',       type: 'single_line_text_field' },
        { namespace: 'custom', key: 'source_order_id',   value: sourceOrderId,   type: 'single_line_text_field' },
        { namespace: 'custom', key: 'source_order_name', value: sourceOrderName, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'action_token',      value: token,           type: 'single_line_text_field' },
        ...(poComments ? [{ namespace: 'custom', key: poType === 'mto' ? 'mto_comments' : 'replenishment_comments', value: poComments, type: 'multi_line_text_field' }] : [])
      ]
    }
  };

  // Always carry customer identity so PO shows who it's for
  if (order.email) body.draft_order.email = order.email;
  const custFirst = order.customer?.first_name || order.billing_address?.first_name || order.shipping_address?.first_name || '';
  const custLast  = order.customer?.last_name  || order.billing_address?.last_name  || order.shipping_address?.last_name  || '';
  if (custFirst || custLast) {
    body.draft_order.billing_address = {
      ...(order.billing_address || {}),
      first_name: custFirst,
      last_name:  custLast
    };
  }
  if (poType === 'mto' && order.shipping_address) {
    body.draft_order.shipping_address = order.shipping_address;
  }

  const res = await axios.post(
    `${shopifyStoreUrl}/admin/api/2024-01/draft_orders.json`,
    body,
    { headers: shopifyHeaders(shopifyToken), timeout: 15000 }
  );

  return { draftOrder: res.data.draft_order, token };
}

// ─── HQ email ─────────────────────────────────────────────────────────────────

// Mirrors Shopify's handleize Liquid filter: lowercase, non-alphanumeric → hyphens
function handleize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function sendPoEmail({ draftOrder, poType, sourceOrderName }) {
  const priority = (draftOrder.line_items?.[0]?.properties || []).find(p => p.name === '_po_priority')?.value || 'standard';
  const attrs    = Object.fromEntries((draftOrder.note_attributes || []).map(na => [na.name, na.value]));
  const items    = (draftOrder.line_items || []).map(i => `${i.title} × ${i.quantity}`).join('<br>');
  const isUrgent = priority === 'urgent';

  // OPP PDF link — same multiplier pattern as deposit receipt (id * 8108 for PO template)
  const pdfUrl = `https://timanti.in/apps/download-pdf/drafts/291a11815ae190ec88fb/${draftOrder.id * 8108}/${handleize(draftOrder.name)}.pdf`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="background:#f4f4f4;padding:20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="text-align:center;padding:24px 20px;border-bottom:1px solid #eee;">
    <img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti" width="130">
  </td></tr>
  ${isUrgent ? `<tr><td style="background:#c0392b;color:#fff;text-align:center;padding:10px;font-weight:bold;font-size:13px;">🔴 URGENT PO — action required promptly</td></tr>` : ''}
  <tr><td style="padding:28px 30px 16px;">
    <p style="font-size:13px;color:#999;margin:0 0 4px;">New Purchase Order</p>
    <h2 style="font-size:22px;margin:0 0 16px;">${draftOrder.name} &nbsp;<span style="font-size:14px;background:${poType === 'mto' ? '#E3F2FD' : '#E8F5E9'};color:${poType === 'mto' ? '#1565C0' : '#2E7D32'};padding:3px 10px;border-radius:3px;font-weight:600;">${poType.toUpperCase()}</span></h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;background:#f9f9f9;">
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#666;border-bottom:1px solid #eee;">Source Order</td>
        <td style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #eee;">${sourceOrderName}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#666;border-bottom:1px solid #eee;">Priority</td>
        <td style="padding:12px 16px;font-size:13px;font-weight:600;color:${isUrgent ? '#c0392b' : '#333'};border-bottom:1px solid #eee;">${priority}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#666;vertical-align:top;">Items</td>
        <td style="padding:12px 16px;font-size:13px;">${items}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 30px 16px;text-align:center;">
    <a href="${pdfUrl}" target="_blank" style="background:#000;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:500;display:inline-block;">Download Purchase Order PDF</a>
  </td></tr>
  <tr><td style="padding:0 30px 24px;">
    <p style="font-size:13px;color:#555;margin:0 0 12px;">Update PO status:</p>
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 8px 8px 0;"><a href="${attrs.action_acknowledge}" style="background:#2F5496;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">✓ Acknowledge</a></td>
        <td style="padding:0 8px 8px 0;"><a href="${attrs.action_ordered}"     style="background:#E67E22;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">📋 Ordered</a></td>
        <td style="padding:0 8px 8px 0;"><a href="${attrs.action_qc_passed}"   style="background:#8E44AD;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">✓ QC Passed</a></td>
        <td style="padding:0 0 8px 0;"  ><a href="${attrs.action_shipped}"     style="background:#27AE60;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">🚚 Shipped</a></td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="border-top:1px solid #eee;padding:16px 30px;text-align:center;font-size:11px;color:#999;">
    Timanti by Auracarat — internal PO notification
  </td></tr>
</table>
</body></html>`;

  await sendEmail({
    to:      HQ_EMAIL,
    cc:      ENABLE_CC ? HQ_CC_EMAIL : undefined,
    subject: `${isUrgent ? '🔴 URGENT — ' : ''}New PO — ${draftOrder.name} — ${poType} — ${sourceOrderName}`,
    html
  });
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function writeToSheets(row) {
  if (!APPS_SCRIPT_URL) return;
  try {
    await axios.post(APPS_SCRIPT_URL, { action: 'append', row }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 10000
    });
  } catch (e) {
    console.error('Sheets write error:', e.message);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handlePoWebhook(req, res, { supabase, getShopifyToken, shopifyStoreUrl }) {
  const rawBody    = req.rawBody || JSON.stringify(req.body);
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  console.log(`[PO] incoming — topic: ${req.headers['x-shopify-topic']} | hmac: ${hmacHeader ? 'present' : 'absent'} | body-len: ${rawBody.length}`);

  if (WEBHOOK_SECRET && hmacHeader && !verifyHmac(rawBody, hmacHeader, WEBHOOK_SECRET)) {
    console.log('[PO] HMAC verification failed — 401');
    return res.status(401).send('Unauthorized');
  }

  const order = req.body;
  if (!order?.id) return res.status(200).send('OK');

  res.status(200).send('OK'); // Shopify needs a response within 5s

  const topic           = req.headers['x-shopify-topic'] || '';
  const isDraftOrder    = topic.startsWith('draft_orders');
  const sourceOrderId   = String(order.id);
  const sourceOrderName = order.name || order.order_number ? `#${order.order_number}` : `#${order.id}`;
  const lineItems       = order.line_items || [];

  // Only process when staff explicitly adds the 'raise-po' tag
  const tags = (order.tags || '').split(',').map(t => t.trim());
  if (!tags.includes('raise-po')) return;

  console.log(`PO webhook: raise-po tag found on ${sourceOrderName} (raw name: ${order.name}, order_number: ${order.order_number}, id: ${order.id})`);

  let shopifyToken;
  try { shopifyToken = await getShopifyToken(); }
  catch (e) { console.error('PO webhook: no Shopify token'); return; }

  // Swap raise-po → raised-po synchronously before processing so retries don't double-fire
  const resource = isDraftOrder ? 'draft_orders' : 'orders';
  const newTags  = [...tags.filter(t => t !== 'raise-po'), 'raised-po'].join(', ');
  await axios.put(
    `${shopifyStoreUrl}/admin/api/2024-01/${resource}/${order.id}.json`,
    { [isDraftOrder ? 'draft_order' : 'order']: { id: order.id, tags: newTags } },
    { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
  ).catch(e => console.error('Failed to swap raise-po tag:', e.message));

  // Build groups from custom.po_mto_variants / custom.po_replenishment_variants metafields
  const { groups, comments } = await getPoGroups(order.id, lineItems, isDraftOrder, shopifyToken, shopifyStoreUrl);

  if (Object.keys(groups).length === 0) return;

  for (const [poType, items] of Object.entries(groups)) {
    // If PO already exists for this order+type, delete the old one first (clean re-raise)
    const { data: existing } = await supabase
      .from('po_records')
      .select('id, draft_order_id, draft_order_name')
      .eq('source_order_id', sourceOrderId)
      .eq('po_type', poType)
      .maybeSingle();

    if (existing) {
      console.log(`Re-raising PO for ${sourceOrderName}/${poType} — deleting old ${existing.draft_order_name}`);
      await axios.delete(
        `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${existing.draft_order_id}.json`,
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      ).catch(e => console.error('Failed to delete old draft order:', e.message));
      await supabase.from('po_records').delete().eq('id', existing.id);
    }

    const { draftOrder, token } = await createPoDraftOrder({
      order, lineItems: items, poType,
      sourceOrderName, sourceOrderId,
      shopifyToken, shopifyStoreUrl,
      poComments: comments[poType] || ''
    });

    if (!draftOrder) { console.error(`Draft order creation failed for ${sourceOrderName}/${poType}`); continue; }

    await supabase.from('po_records').insert({
      source_order_id:  sourceOrderId,
      po_type:          poType,
      draft_order_id:   String(draftOrder.id),
      draft_order_name: draftOrder.name,
      action_token:     token,
      status:           'pending'
    });

    await sendPoEmail({ draftOrder, poType, sourceOrderName });

    const first = items[0];
    await writeToSheets({
      po_number:        draftOrder.name,
      po_type:          poType,
      source_order:     sourceOrderName,
      customer_name:    `${order.customer?.first_name || order.shipping_address?.first_name || order.billing_address?.first_name || ''} ${order.customer?.last_name || order.shipping_address?.last_name || order.billing_address?.last_name || ''}`.trim(),
      item_description: items.map(i => i.title).join(', '),
      gati_id:          '',
      sku:              items.map(i => i.sku || '').join(', '),
      priority:         (first.properties || []).find(p => p.name === '_po_priority')?.value || 'standard',
      target_dispatch:  (first.properties || []).find(p => p.name === '_target_dispatch')?.value || '',
      customer_promise: (first.properties || []).find(p => p.name === '_customer_promise')?.value || '',
      po_comments:      comments[poType] || '',
      po_sent_at:       new Date().toISOString()
    });

    console.log(`PO created: ${draftOrder.name} for ${sourceOrderName}/${poType}`);
  }
}

module.exports = { handlePoWebhook };
