'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { sendEmail } = require('../../emailService');

const WEBHOOK_SECRET  = process.env.SHOPIFY_WEBHOOK_SECRET;
const HQ_EMAIL        = process.env.HQ_EMAIL;      // operations@timanti.in
const HQ_CC_EMAIL     = process.env.HQ_CC_EMAIL;   // shweta@timanti.in
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const MIDDLEWARE_URL  = process.env.MIDDLEWARE_BASE_URL;

// ─── HMAC ─────────────────────────────────────────────────────────────────────

function verifyHmac(rawBody, signature, secret) {
  try {
    const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSpecialInstructions(item) {
  return (item.properties || [])
    .filter(p => !p.name.startsWith('_'))
    .map(p => `${p.name}: ${p.value}`)
    .join(' | ');
}

function buildLink(token, action) {
  return `${MIDDLEWARE_URL}/api/po-action?action=${action}&token=${token}`;
}

// ─── Create PO draft order ───────────────────────────────────────────────────

async function createPoDraftOrder({ order, lineItems, poType, sourceOrderName, sourceOrderId, shopifyToken, shopifyStoreUrl }) {
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
      ]
    }
  };

  if (poType === 'mto') {
    if (order.shipping_address) body.draft_order.shipping_address = order.shipping_address;
    if (order.billing_address)  body.draft_order.billing_address  = order.billing_address;
    if (order.email)            body.draft_order.email            = order.email;
  }

  const res = await axios.post(
    `${shopifyStoreUrl}/admin/api/2024-01/draft_orders.json`,
    body,
    { headers: shopifyHeaders(shopifyToken), timeout: 15000 }
  );

  return { draftOrder: res.data.draft_order, token };
}

// ─── HQ email (no PDF — action links embedded in body) ───────────────────────

async function sendPoEmail({ draftOrder, poType, sourceOrderName }) {
  const priority = (draftOrder.line_items?.[0]?.properties || []).find(p => p.name === '_po_priority')?.value || 'standard';
  const attrs    = Object.fromEntries((draftOrder.note_attributes || []).map(na => [na.name, na.value]));
  const items    = (draftOrder.line_items || []).map(i => `${i.title} × ${i.quantity}`).join('<br>');
  const isUrgent = priority === 'urgent';

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
  <tr><td style="padding:0 30px 24px;">
    <p style="font-size:13px;color:#555;margin:0 0 12px;">Update PO status using the links below:</p>
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
    cc:      HQ_CC_EMAIL || undefined,
    subject: `${isUrgent ? '🔴 URGENT — ' : ''}New PO — ${draftOrder.name} — ${poType} — ${sourceOrderName}`,
    html
  });
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

async function writeToSheets(row) {
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

  if (WEBHOOK_SECRET && hmacHeader && !verifyHmac(rawBody, hmacHeader, WEBHOOK_SECRET)) {
    return res.status(401).send('Unauthorized');
  }

  const order = req.body;
  if (!order?.id) return res.status(200).send('OK');

  res.status(200).send('OK'); // respond to Shopify immediately

  const sourceOrderId   = String(order.id);
  const sourceOrderName = order.name || `#${order.id}`;

  const groups = {};
  for (const item of (order.line_items || [])) {
    const prop = (item.properties || []).find(p => p.name === '_po_type');
    if (!prop?.value) continue;
    const type = prop.value.toLowerCase().trim();
    if (!['mto', 'replenishment'].includes(type)) continue;
    if (!groups[type]) groups[type] = [];
    groups[type].push(item);
  }

  if (Object.keys(groups).length === 0) return;

  let shopifyToken;
  try { shopifyToken = await getShopifyToken(); } catch (e) { console.error('PO webhook: no Shopify token'); return; }

  for (const [poType, items] of Object.entries(groups)) {
    const { data: existing } = await supabase
      .from('po_records')
      .select('id')
      .eq('source_order_id', sourceOrderId)
      .eq('po_type', poType)
      .maybeSingle();

    if (existing) { console.log(`PO already exists for ${sourceOrderName}/${poType} — skipping`); continue; }

    const { draftOrder, token } = await createPoDraftOrder({
      order, lineItems: items, poType,
      sourceOrderName, sourceOrderId,
      shopifyToken, shopifyStoreUrl
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
      customer_name:    poType === 'mto' ? `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim() : '',
      item_description: items.map(i => i.title).join(', '),
      gati_id:          '',
      sku:              items.map(i => i.sku || '').join(', '),
      priority:         (first.properties || []).find(p => p.name === '_po_priority')?.value || 'standard',
      target_dispatch:  (first.properties || []).find(p => p.name === '_target_dispatch')?.value || '',
      customer_promise: (first.properties || []).find(p => p.name === '_customer_promise')?.value || '',
      po_sent_at:       new Date().toISOString()
    });

    console.log(`PO created: ${draftOrder.name} for ${sourceOrderName}/${poType}`);
  }
}

module.exports = { handlePoWebhook };
