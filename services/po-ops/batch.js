'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { sendEmail } = require('../../emailService');

const HQ_EMAIL        = process.env.HQ_EMAIL;
const HQ_CC_EMAIL     = process.env.HQ_CC_EMAIL;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const MIDDLEWARE_URL  = process.env.MIDDLEWARE_BASE_URL;

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildLink(token, action) {
  return `${MIDDLEWARE_URL}/api/po-action?action=${action}&token=${token}`;
}

function handleize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function batchRaisePo({ po_type, rows, shopifyToken, shopifyStoreUrl, supabase }) {
  if (!rows?.length) return { ok: false, error: 'No rows provided' };

  // Shopify needs each line item to have either a real variant_id or a non-empty title.
  // A row with neither 422s the WHOLE draft (creation is atomic), so catch it here with a
  // clear message instead of a generic Shopify error.
  const invalid = rows.filter(r => !Number(r.variant_id) && !String(r.product_title || '').trim());
  if (invalid.length) {
    const ids = invalid.map(r => r.line_item_id || r.sku || '(blank row)').join(', ');
    return { ok: false, error: `${invalid.length} row(s) have no variant and no product title — fill the Product column or remove them: ${ids}` };
  }

  const batchDate = new Date().toISOString().slice(0, 10);
  const batchId   = `${po_type}-${batchDate}-${Date.now()}`;
  const token     = generateToken();

  const lineItems = rows.map(row => {
    let extraProps = [];
    try { extraProps = JSON.parse(row.line_item_properties || '[]').filter(p => !p.name?.startsWith('_')); }
    catch { /* ignore malformed JSON */ }

    const item = {
      quantity:   Number(row.qty_to_raise) || 1,
      price:      '0.00',
      title:      row.product_title,
      properties: [
        { name: '_source_line_item_id', value: String(row.line_item_id) },
        { name: '_source_draft_order',  value: row.draft_order_name },
        { name: '_batch_id',            value: batchId },
        ...extraProps
      ].filter(p => p.value)
    };

    const vid = Number(row.variant_id);
    if (vid) item.variant_id = vid; // custom items without a variant omit this

    return item;
  });

  const body = {
    draft_order: {
      line_items: lineItems,
      note: `Batch PO — ${po_type.toUpperCase()} — ${batchDate}`,
      note_attributes: [
        { name: 'action_acknowledge', value: buildLink(token, 'acknowledge') },
        { name: 'action_ordered',     value: buildLink(token, 'ordered') },
        { name: 'action_qc_passed',   value: buildLink(token, 'qc_passed') },
        { name: 'action_shipped',     value: buildLink(token, 'shipped') },
        { name: 'action_cancelled',   value: buildLink(token, 'cancelled') },
        { name: 'batch_id',           value: batchId },
        { name: 'batch_date',         value: batchDate }
      ],
      tags: `po-draft, ${po_type}, batch-po`,
      metafields: [
        { namespace: 'custom', key: 'po_type',      value: po_type,   type: 'single_line_text_field' },
        { namespace: 'custom', key: 'po_status',    value: 'pending', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'batch_id',     value: batchId,   type: 'single_line_text_field' },
        { namespace: 'custom', key: 'batch_date',   value: batchDate, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'action_token', value: token,     type: 'single_line_text_field' }
      ]
    }
  };

  let draftOrder;
  try {
    const res = await axios.post(
      `${shopifyStoreUrl}/admin/api/2024-01/draft_orders.json`,
      body,
      { headers: shopifyHeaders(shopifyToken), timeout: 15000 }
    );
    draftOrder = res.data.draft_order;
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('[BATCH] Draft order creation failed:', detail);
    // Surface Shopify's actual reason (e.g. a deleted/archived variant) to the Apps Script
    // alert — the bare "status code 422" hid which line item was the problem.
    return { ok: false, error: 'Draft order creation failed: ' + detail };
  }

  console.log(`[BATCH] Created ${draftOrder.name} for batch ${batchId}`);

  // Store in po_records so the existing action.js handler works unchanged
  await supabase.from('po_records').insert({
    source_order_id:  batchId,
    po_type,
    draft_order_id:   String(draftOrder.id),
    draft_order_name: draftOrder.name,
    action_token:     token,
    status:           'pending',
    batch_id:         batchId
  });

  // Store in batch_po_records for batch-level tracking
  await supabase.from('batch_po_records').insert({
    batch_id:             batchId,
    batch_date:           batchDate,
    po_type,
    draft_order_id:       String(draftOrder.id),
    draft_order_name:     draftOrder.name,
    source_line_item_ids: rows.map(r => String(r.line_item_id))
  });

  await sendBatchPoEmail({ draftOrder, po_type, batchDate, batchId, rows });
  await writeToPoTracker({ draftOrder, po_type, batchDate, rows });

  const raised_at = new Date().toISOString();
  console.log(`[BATCH] Complete — ${draftOrder.name} raised_at=${raised_at}`);
  return { ok: true, batch_id: batchId, raised_at, draft_order_name: draftOrder.name };
}

async function sendBatchPoEmail({ draftOrder, po_type, batchDate, batchId, rows }) {
  const attrs     = Object.fromEntries((draftOrder.note_attributes || []).map(na => [na.name, na.value]));
  const itemsHtml = rows.map(r => `${r.product_title} × ${r.qty_to_raise} (${r.sku || '—'})`).join('<br>');
  const pdfUrl    = `https://timanti.in/apps/download-pdf/drafts/291a11815ae190ec88fb/${draftOrder.id * 8108}/${handleize(draftOrder.name)}.pdf`;
  const typeColor = po_type === 'mto' ? '#1565C0' : '#2E7D32';
  const typeBg    = po_type === 'mto' ? '#E3F2FD' : '#E8F5E9';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="background:#f4f4f4;padding:20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="text-align:center;padding:24px 20px;border-bottom:1px solid #eee;">
    <img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti" width="130">
  </td></tr>
  <tr><td style="padding:28px 30px 16px;">
    <p style="font-size:13px;color:#999;margin:0 0 4px;">Batch Purchase Order — ${batchDate}</p>
    <h2 style="font-size:22px;margin:0 0 16px;">${draftOrder.name} &nbsp;<span style="font-size:14px;background:${typeBg};color:${typeColor};padding:3px 10px;border-radius:3px;font-weight:600;">${po_type.toUpperCase()}</span></h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;background:#f9f9f9;">
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#666;border-bottom:1px solid #eee;">Batch ID</td>
        <td style="padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #eee;">${batchId || attrs.batch_id}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#666;border-bottom:1px solid #eee;">Items (${rows.length})</td>
        <td style="padding:12px 16px;font-size:13px;">${itemsHtml}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 30px 16px;text-align:center;">
    <a href="${pdfUrl}" target="_blank" style="background:#000;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:500;display:inline-block;">Download Purchase Order PDF</a>
  </td></tr>
  <tr><td style="padding:0 30px 24px;">
    <p style="font-size:13px;color:#555;margin:0 0 12px;">Update PO status:</p>
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding:0 8px 8px 0;"><a href="${attrs.action_acknowledge}" style="background:#2F5496;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">✓ Acknowledge</a></td>
      <td style="padding:0 8px 8px 0;"><a href="${attrs.action_ordered}"     style="background:#E67E22;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">📋 Ordered</a></td>
      <td style="padding:0 8px 8px 0;"><a href="${attrs.action_qc_passed}"   style="background:#8E44AD;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">✓ QC Passed</a></td>
      <td style="padding:0 0 8px 0;"  ><a href="${attrs.action_shipped}"     style="background:#27AE60;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">🚚 Shipped</a></td>
    </tr></table>
    <p style="font-size:11px;color:#aaa;margin:12px 0 8px;border-top:1px solid #eee;padding-top:12px;">Cancel this PO:</p>
    <a href="${attrs.action_cancelled}" style="background:#c0392b;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block;">✕ Cancel PO</a>
  </td></tr>
  <tr><td style="border-top:1px solid #eee;padding:16px 30px;text-align:center;font-size:11px;color:#999;">
    Timanti by Auracarat — internal PO notification
  </td></tr>
</table>
</body></html>`;

  await sendEmail({
    to:      HQ_EMAIL,
    cc:      [HQ_CC_EMAIL, 'hsrstore@timanti.in', 'monodeep.dutta@timanti.in'].filter(Boolean),
    subject: `New Batch PO — ${draftOrder.name} — ${po_type.toUpperCase()} — ${batchDate}`,
    html
  });
}

async function writeToPoTracker({ draftOrder, po_type, batchDate, rows }) {
  if (!APPS_SCRIPT_URL) return;
  const uniqueCustomers = [...new Set(rows.map(r => r.customer_name).filter(Boolean))].join(', ');
  const itemsSummary    = rows.map(r => `${r.product_title} × ${r.qty_to_raise}`).join(', ');
  try {
    await axios.post(APPS_SCRIPT_URL, {
      action: 'append',
      row: {
        po_number:        draftOrder.name,
        po_type,
        source_order:     `Batch ${batchDate}`,
        customer_name:    uniqueCustomers,
        item_description: itemsSummary,
        sku:              rows.map(r => r.sku).filter(Boolean).join(', '),
        gati_id:          '',
        priority:         'standard',
        target_dispatch:  '',
        customer_promise: '',
        po_comments:      `Batch ${batchDate} — ${rows.length} items`,
        po_sent_at:       new Date().toISOString()
      }
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  } catch (e) {
    console.error('[BATCH] PO Tracker write error:', e.message);
  }
}

module.exports = { batchRaisePo };
