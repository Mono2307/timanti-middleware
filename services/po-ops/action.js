'use strict';

const axios = require('axios');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

const VALID_ACTIONS = ['acknowledge', 'ordered', 'qc_passed', 'shipped'];

const ACTION_TO_STATUS = {
  acknowledge: 'acknowledged',
  ordered:     'ordered',
  qc_passed:   'qc_passed',
  shipped:     'shipped'
};

const ACTION_TO_SHEETS_COL = {
  acknowledge: 'acknowledged_at',
  ordered:     'ordered_at',
  qc_passed:   'qc_at',
  shipped:     'shipped_at'
};

const CARD_STYLE = 'body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}.card{background:#fff;padding:40px;border-radius:8px;text-align:center;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1);}h2{margin-bottom:8px;}p{color:#555;}';

function successPage(poName, action) {
  const label = { acknowledge: 'acknowledged', ordered: 'marked as ordered', qc_passed: 'marked QC passed', shipped: 'marked as shipped to store' };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PO Updated</title><style>${CARD_STYLE}h2{color:#27AE60;}</style></head><body><div class="card"><h2>✓ Done</h2><p><strong>${poName}</strong> has been ${label[action] || action}.</p><p style="color:#999;font-size:13px;margin-top:20px;">You can close this tab.</p></div></body></html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title><style>${CARD_STYLE}h2{color:#E74C3C;}</style></head><body><div class="card"><h2>Something went wrong</h2><p>${message}</p></div></body></html>`;
}

async function handlePoAction(req, res, { supabase, getShopifyToken, shopifyStoreUrl }) {
  const action = req.query.action;
  const token  = req.query.token;

  if (!action || !token)          return res.status(400).send(errorPage('Missing action or token.'));
  if (!VALID_ACTIONS.includes(action)) return res.status(400).send(errorPage(`Unknown action: ${action}`));

  const { data: record } = await supabase
    .from('po_records')
    .select('*')
    .eq('action_token', token)
    .maybeSingle();

  if (!record) return res.status(404).send(errorPage('Purchase order not found or link is invalid.'));

  const { draft_order_id: draftOrderId, draft_order_name: poName } = record;
  const newStatus  = ACTION_TO_STATUS[action];
  const sheetsCol  = ACTION_TO_SHEETS_COL[action];
  const timestamp  = new Date().toISOString();

  let shopifyToken;
  try { shopifyToken = await getShopifyToken(); } catch (e) { console.error('PO action: no Shopify token'); }

  if (shopifyToken) {
    try {
      const headers = { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' };
      const { data: metaData } = await axios.get(
        `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
        { headers, timeout: 10000 }
      );
      const statusMf = (metaData.metafields || []).find(m => m.namespace === 'custom' && m.key === 'po_status');
      if (statusMf) {
        await axios.put(
          `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields/${statusMf.id}.json`,
          { metafield: { id: statusMf.id, value: newStatus, type: 'single_line_text_field' } },
          { headers, timeout: 10000 }
        );
      }
    } catch (e) {
      console.error('Shopify metafield update failed:', e.message);
    }
  }

  try {
    await axios.post(APPS_SCRIPT_URL, {
      action: 'update', po_number: poName, column: sheetsCol, value: timestamp
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  } catch (e) {
    console.error('Sheets update error:', e.message);
  }

  await supabase.from('po_records').update({ status: newStatus }).eq('action_token', token);

  if (action === 'shipped' && shopifyToken) {
    try {
      await axios.delete(
        `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
        { headers: { 'X-Shopify-Access-Token': shopifyToken }, timeout: 10000 }
      );
    } catch (e) {
      console.error('Draft order delete failed:', e.message);
    }
  }

  return res.send(successPage(poName, action));
}

module.exports = { handlePoAction };
