'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { createPaymentLink } = require('../gokwik');
const {
  sendEmail,
  buildRepairEstimateHtml,
  buildRepairPaymentConfirmedHtml,
  buildRepairCompleteHtml,
  buildCreditNoteHtml
} = require('../../emailService');

function verifyShopifyHmac(rawBody, hmacHeader) {
  try {
    const computed = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
  } catch (_) { return false; }
}

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

// GET /draft_orders/${id}/metafields.json → update by ID if exists, else POST
async function writeDraftOrderMetafields(draftOrderId, fields, token) {
  const hdrs = shopifyHeaders(token);
  const base = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01`;

  const { data: existing } = await axios.get(
    `${base}/draft_orders/${draftOrderId}/metafields.json`,
    { headers: hdrs, timeout: 10000 }
  );

  const byKey = {};
  for (const mf of (existing.metafields || [])) {
    if (mf.namespace === 'timanti') byKey[mf.key] = mf.id;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const existingId = byKey[key];
    if (existingId) {
      await axios.put(
        `${base}/metafields/${existingId}.json`,
        { metafield: { id: existingId, value: String(value), type: 'single_line_text_field' } },
        { headers: hdrs, timeout: 10000 }
      );
    } else {
      await axios.post(
        `${base}/draft_orders/${draftOrderId}/metafields.json`,
        { metafield: { namespace: 'timanti', key, value: String(value), type: 'single_line_text_field' } },
        { headers: hdrs, timeout: 10000 }
      );
    }
  }
}

// GET current draft tags then PUT with new set
async function updateDraftOrderTags(draftOrderId, newTags, token) {
  await axios.put(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    { draft_order: { id: draftOrderId, tags: newTags.join(', ') } },
    { headers: shopifyHeaders(token), timeout: 10000 }
  );
}

// ── Called from server.js GoKwik webhook when draft has repair tags ─────────
async function handleRepairPayment(draft, { transactionId, gatewayRef }, getShopifyToken) {
  const token      = await getShopifyToken();
  const existingTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const newTags    = existingTags
    .filter(t => t !== 'repair-estimate-ready' && t !== 'repair-estimate-sent')
    .concat(['repair-paid']);

  await updateDraftOrderTags(draft.id, newTags, token);

  await writeDraftOrderMetafields(draft.id, {
    payment_status:        'paid',
    gokwik_transaction_id: transactionId || '',
    payment_amount:        draft.total_price,
    payment_method:        'gokwik_link',
    payment_date:          new Date().toISOString()
  }, token);

  const customerEmail = draft.email;
  const customerName  = draft.billing_address?.name || 'Customer';

  if (customerEmail) {
    await sendEmail({
      to:      customerEmail,
      subject: `Payment Confirmed — Repair in Progress (${draft.name})`,
      html:    buildRepairPaymentConfirmedHtml({
        customerName,
        draftRef:      draft.name,
        amount:        Math.round(parseFloat(draft.total_price)).toString(),
        transactionId: transactionId || gatewayRef || 'N/A',
        paymentMethod: 'GoKwik Link'
      })
    });
  }

  console.log(`✅ Repair payment recorded: ${draft.name} txn=${transactionId}`);
}

// ── Route factory — call once from server.js ──────────────────────────────────
function registerRepairRoutes(app, getShopifyToken) {

  // Trigger 1 + Trigger 3 both arrive here
  app.post('/webhooks/shopify/draft-order-updated', async (req, res) => {
    res.status(200).send('OK');

    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (hmac && !verifyShopifyHmac(req.rawBody, hmac)) {
      console.warn('Repair webhook: invalid Shopify HMAC — rejected');
      return;
    }

    try {
      const draft = req.body;
      const tags  = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);

      // ── Trigger 1: estimate ready ──────────────────────────────────────
      if (tags.includes('repair-estimate-ready') && !tags.includes('repair-estimate-sent')) {
        console.log(`Repair estimate trigger: ${draft.name}`);
        const token         = await getShopifyToken();
        const customerEmail = draft.email;
        const customerName  = draft.billing_address?.name || customerEmail;
        const customerPhone = draft.billing_address?.phone || draft.phone || '';
        const amount        = parseFloat(draft.total_price);
        const itemDesc      = draft.line_items?.[0]?.title || 'Repair service';

        let shortUrl;
        try {
          const link = await createPaymentLink({
            draftOrderId: draft.id.toString(),
            amount,
            customerPhone,
            customerName,
            customerEmail
          });
          shortUrl = link.shortUrl;
        } catch (err) {
          console.error(`❌ GoKwik link failed for ${draft.name}:`, err.message);
          return; // don't add tag — allows retry by re-saving draft
        }

        try {
          await sendEmail({
            to:      customerEmail,
            subject: `Your Timanti Repair Estimate — ${draft.name}`,
            html:    buildRepairEstimateHtml({
              customerName,
              draftRef:        draft.name,
              itemDescription: itemDesc,
              amount:          Math.round(amount).toString(),
              paymentUrl:      shortUrl
            })
          });
        } catch (err) {
          console.error(`❌ Resend failed for ${draft.name}:`, err.message);
          return; // don't add tag — allows retry
        }

        await updateDraftOrderTags(draft.id, [...tags, 'repair-estimate-sent'], token);
        await writeDraftOrderMetafields(draft.id, {
          repair_estimate_sent_at: new Date().toISOString()
        }, token);

        console.log(`✅ Repair estimate sent: ${draft.name}`);
        return;
      }

      // ── Trigger 3: repair complete ─────────────────────────────────────
      if (tags.includes('repair-complete') && !tags.includes('repair-completion-notified')) {
        console.log(`Repair complete trigger: ${draft.name}`);
        const token         = await getShopifyToken();
        const customerEmail = draft.email;
        const customerName  = draft.billing_address?.name || customerEmail;

        try {
          await sendEmail({
            to:      customerEmail,
            subject: `Your Repair is Ready — ${draft.name}`,
            html:    buildRepairCompleteHtml({ customerName, draftRef: draft.name })
          });
        } catch (err) {
          console.error(`❌ Resend failed (complete) for ${draft.name}:`, err.message);
          return;
        }

        await updateDraftOrderTags(draft.id, [...tags, 'repair-completion-notified'], token);
        await writeDraftOrderMetafields(draft.id, {
          repair_completed_at: new Date().toISOString()
        }, token);

        console.log(`✅ Repair completion notified: ${draft.name}`);
      }

    } catch (err) {
      console.error('Repair draft-order webhook error:', err.response?.data || err.message);
    }
  });

  // ── CN issued email — flag-gated ──────────────────────────────────────────
  app.post('/webhooks/shopify/order-updated', async (req, res) => {
    res.status(200).send('OK');

    if (process.env.CN_EMAIL_ENABLED !== 'true') return;

    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (hmac && !verifyShopifyHmac(req.rawBody, hmac)) {
      console.warn('CN webhook: invalid Shopify HMAC — rejected');
      return;
    }

    try {
      const order = req.body;
      const tags  = (order.tags || '').split(',').map(t => t.trim());
      if (!tags.includes('cn-issued'))       return;
      if (tags.includes('cn-email-sent'))    return;

      const token = await getShopifyToken();
      const { data: mfData } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${order.id}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
      );

      const mf = {};
      for (const m of (mfData.metafields || [])) {
        if (m.namespace === 'timanti') mf[m.key] = m.value;
      }

      if (!mf.cn_number) {
        console.error(`CN email: no cn_number metafield on order ${order.name} — Apps Script may not have written it yet`);
        return;
      }

      await sendEmail({
        to:      order.email,
        subject: `Your Timanti Credit Note — ${mf.cn_number}`,
        html:    buildCreditNoteHtml({
          customerName:  order.billing_address?.name || order.email,
          cnNumber:      mf.cn_number,
          creditValue:   mf.cn_value,
          validUntil:    mf.cn_expiry,
          originalOrder: order.name
        })
      });

      // Tag order so this handler never fires twice for same CN
      const allTags = [...tags, 'cn-email-sent'].join(', ');
      await axios.put(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${order.id}.json`,
        { order: { id: order.id, tags: allTags } },
        { headers: shopifyHeaders(token), timeout: 10000 }
      );

      console.log(`✅ CN email sent: ${mf.cn_number} → ${order.email}`);
    } catch (err) {
      console.error('CN order webhook error:', err.response?.data || err.message);
    }
  });
}

module.exports = { registerRepairRoutes, handleRepairPayment };
