'use strict';

const crypto = require('crypto');
const { createPaymentLink } = require('../gokwik');
const {
  sendEmail,
  buildRepairEstimateHtml,
  buildRepairPaymentConfirmedHtml,
  buildRepairCompleteHtml
} = require('../../emailService');

function verifyShopifyHmac(rawBody, hmacHeader) {
  try {
    const computed = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
  } catch (_) { return false; }
}

async function shopifyGet(path, token) {
  const res = await fetch(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/${path}`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function shopifyPut(path, body, token) {
  const res = await fetch(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/${path}`,
    {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  return res.ok;
}

async function updateDraftOrder(draftOrderId, { tags, metafields }, token) {
  const payload = { draft_order: { id: draftOrderId } };
  if (tags)       payload.draft_order.tags = tags.join(', ');
  if (metafields) payload.draft_order.metafields = metafields.map(m => ({
    namespace: 'timanti', type: 'single_line_text_field', ...m
  }));
  return shopifyPut(`draft_orders/${draftOrderId}.json`, payload, token);
}

// Called from server.js GoKwik webhook when draft has repair tags
async function handleRepairPayment(draft, { transactionId, gatewayRef }, getShopifyToken) {
  const token     = await getShopifyToken();
  const existingTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const newTags   = existingTags
    .filter(t => t !== 'repair-estimate-ready' && t !== 'repair-estimate-sent')
    .concat(['repair-paid']);

  await updateDraftOrder(draft.id, {
    tags: newTags,
    metafields: [
      { key: 'payment_status',        value: 'paid' },
      { key: 'gokwik_transaction_id', value: transactionId || '' },
      { key: 'payment_amount',        value: draft.total_price },
      { key: 'payment_method',        value: 'gokwik_link' },
      { key: 'payment_date',          value: new Date().toISOString() }
    ]
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

  console.log(`Repair payment recorded: ${draft.name} txn=${transactionId}`);
}

function registerRepairRoutes(app, getShopifyToken) {

  // Trigger 1 + Trigger 3 — both fire on draft_orders/update
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

      // ── Trigger 1: estimate ready ────────────────────────────────────────
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
          console.error(`GoKwik link failed for ${draft.name}:`, err.message);
          return; // no tag added — staff can retry by re-saving draft
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
          console.error(`Resend failed for ${draft.name}:`, err.message);
          return; // no tag added — allows retry
        }

        await updateDraftOrder(draft.id, {
          tags: [...tags, 'repair-estimate-sent'],
          metafields: [{ key: 'repair_estimate_sent_at', value: new Date().toISOString() }]
        }, token);

        console.log(`Repair estimate sent: ${draft.name}`);
        return;
      }

      // ── Trigger 3: repair complete ───────────────────────────────────────
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
          console.error(`Resend failed (complete) for ${draft.name}:`, err.message);
          return;
        }

        await updateDraftOrder(draft.id, {
          tags: [...tags, 'repair-completion-notified'],
          metafields: [{ key: 'repair_completed_at', value: new Date().toISOString() }]
        }, token);

        console.log(`Repair completion notified: ${draft.name}`);
      }

    } catch (err) {
      console.error('Repair draft-order webhook error:', err.message);
    }
  });
}

module.exports = { registerRepairRoutes, handleRepairPayment };
