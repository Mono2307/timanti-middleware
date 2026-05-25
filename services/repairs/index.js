'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { createPaymentLink } = require('../gokwik');
const {
  sendEmail,
  buildRepairEstimateHtml,
  buildRepairPaymentConfirmedHtml,
  buildRepairCompleteHtml,
  buildCreditNoteHtml,
  buildRepairIntakeHtml,
  buildRepairAcknowledgementHtml,
  buildRepairFreeHtml,
  buildRepairHqCompleteReadyHtml
} = require('../../emailService');

function generateEstimateToken(draftId) {
  return crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(String(draftId)).digest('hex').slice(0, 32);
}

function generateCompleteToken(draftId) {
  return crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(`complete:${draftId}`).digest('hex').slice(0, 32);
}

// Verify and update SEQUEL_TRACKING_BASE in Fly.io secrets if the URL format changes
const SEQUEL_TRACKING_BASE = process.env.SEQUEL_TRACKING_BASE || 'https://www.sequellogistics.in/track-shipment?awb=';

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
  const amount        = Math.round(parseFloat(draft.total_price)).toString();

  if (customerEmail) {
    await sendEmail({
      to:      customerEmail,
      subject: `Payment Confirmed — Repair in Progress (${draft.name})`,
      html:    buildRepairPaymentConfirmedHtml({
        customerName,
        draftRef:      draft.name,
        amount,
        transactionId: transactionId || gatewayRef || 'N/A',
        paymentMethod: 'GoKwik Link'
      })
    });
  }

  const hqEmail = process.env.HQ_EMAIL;
  if (hqEmail) {
    const serverUrl     = process.env.SERVER_URL || 'https://timanti-middleware.fly.dev';
    const completeToken = generateCompleteToken(draft.id);
    const completeUrl   = `${serverUrl}/repairs/set-complete?d=${draft.id}&t=${completeToken}`;
    await sendEmail({
      to:      hqEmail,
      cc:      process.env.HQ_CC_EMAIL,
      subject: `Payment Received — ${draft.name} — ${customerName}`,
      html:    buildRepairHqCompleteReadyHtml({ customerName, draftRef: draft.name, amount, completeUrl })
    }).catch(err => console.error(`❌ HQ complete-link email failed for ${draft.name}:`, err.message));
  }

  console.log(`✅ Repair payment recorded: ${draft.name} txn=${transactionId}`);
}

// ── Called directly from the existing /api/shopify-draft-updated handler ──────
async function handleRepairDraftUpdate(draft, getShopifyToken) {
  const tags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);

  // ── Trigger 0: intake → HQ notification + customer acknowledgement ────────
  if (tags.includes('repair-intake') && !tags.includes('repair-hq-notified')) {
    console.log(`Repair intake trigger: ${draft.name}`);
    const hqEmail = process.env.HQ_EMAIL;
    if (!hqEmail) {
      console.warn(`⚠️  HQ_EMAIL not set — skipping intake email for ${draft.name}`);
      return;
    }
    const shopifyToken    = await getShopifyToken();
    const customerName    = draft.billing_address?.name || draft.email;
    const customerEmail   = draft.email;
    const customerPhone   = draft.billing_address?.phone || draft.phone || '';
    const itemDesc        = draft.line_items?.[0]?.title || 'Repair service';
    const notes           = draft.note || '';
    const hmacToken       = generateEstimateToken(draft.id);
    const serverUrl       = process.env.SERVER_URL || 'https://timanti-middleware.fly.dev';
    const approveUrl      = `${serverUrl}/repairs/set-estimate?d=${draft.id}&t=${hmacToken}`;

    try {
      await sendEmail({
        to:      hqEmail,
        cc:      process.env.HQ_CC_EMAIL,
        subject: `New Repair Intake — ${draft.name} — ${customerName}`,
        html:    buildRepairIntakeHtml({ customerName, customerEmail, customerPhone, draftRef: draft.name, itemDesc, notes, approveUrl })
      });
    } catch (err) {
      console.error(`❌ Intake HQ email failed for ${draft.name}:`, err.message);
      return;
    }

    if (customerEmail) {
      try {
        await sendEmail({
          to:      customerEmail,
          subject: `We've Received Your Item — ${draft.name}`,
          html:    buildRepairAcknowledgementHtml({ customerName, draftRef: draft.name, itemDesc })
        });
      } catch (err) {
        console.error(`❌ Intake ack email failed for ${draft.name}:`, err.message);
      }
    }

    await updateDraftOrderTags(draft.id, [...tags, 'repair-hq-notified'], shopifyToken);
    await writeDraftOrderMetafields(draft.id, { repair_intake_at: new Date().toISOString() }, shopifyToken);
    console.log(`✅ Repair intake: HQ notified + customer ack sent: ${draft.name}`);
    return;
  }

  // ── Trigger 0b: free repair confirmed → customer email + HQ complete link ─
  if (tags.includes('repair-free') && !tags.includes('repair-free-notified')) {
    console.log(`Repair free trigger: ${draft.name}`);
    const token         = await getShopifyToken();
    const customerEmail = draft.email;
    const customerName  = draft.billing_address?.name || customerEmail;
    const itemDesc      = draft.line_items?.[0]?.title || 'Repair service';
    const serverUrl     = process.env.SERVER_URL || 'https://timanti-middleware.fly.dev';
    const completeToken = generateCompleteToken(draft.id);
    const completeUrl   = `${serverUrl}/repairs/set-complete?d=${draft.id}&t=${completeToken}`;
    const hqEmail       = process.env.HQ_EMAIL;

    if (customerEmail) {
      try {
        await sendEmail({
          to:      customerEmail,
          subject: `Great News — Complimentary Repair Confirmed (${draft.name})`,
          html:    buildRepairFreeHtml({ customerName, draftRef: draft.name, itemDesc })
        });
      } catch (err) {
        console.error(`❌ Free repair customer email failed for ${draft.name}:`, err.message);
      }
    }

    if (hqEmail) {
      try {
        await sendEmail({
          to:      hqEmail,
          cc:      process.env.HQ_CC_EMAIL,
          subject: `Complimentary Repair — ${draft.name} — ${customerName}`,
          html:    buildRepairHqCompleteReadyHtml({ customerName, draftRef: draft.name, amount: null, completeUrl })
        });
      } catch (err) {
        console.error(`❌ Free repair HQ complete-link email failed for ${draft.name}:`, err.message);
      }
    }

    await updateDraftOrderTags(draft.id, [...tags, 'repair-free-notified'], token);
    console.log(`✅ Free repair confirmed: ${draft.name}`);
    return;
  }

  // ── Trigger 1: estimate ready ──────────────────────────────────────────────
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
      return;
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
      return;
    }

    await updateDraftOrderTags(draft.id, [...tags, 'repair-estimate-sent'], token);
    await writeDraftOrderMetafields(draft.id, {
      repair_estimate_sent_at: new Date().toISOString()
    }, token);

    console.log(`✅ Repair estimate sent: ${draft.name}`);
    return;
  }

  // ── Trigger 3: repair complete ─────────────────────────────────────────────
  if (tags.includes('repair-complete') && !tags.includes('repair-completion-notified')) {
    console.log(`Repair complete trigger: ${draft.name}`);
    const token         = await getShopifyToken();
    const customerEmail = draft.email;
    const customerName  = draft.billing_address?.name || customerEmail;

    // Read tracking metafield written by set-complete form
    let sequelId = null;
    let trackingUrl = null;
    try {
      const { data: mfData } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draft.id}/metafields.json`,
        { headers: shopifyHeaders(token), timeout: 10000 }
      );
      const mf = (mfData.metafields || []).find(m => m.namespace === 'timanti' && m.key === 'repair_tracking_id');
      if (mf?.value) {
        sequelId = mf.value;
        trackingUrl = `${SEQUEL_TRACKING_BASE}${sequelId}`;
      }
    } catch (err) {
      console.warn(`⚠️  Could not fetch metafields for ${draft.name}:`, err.message);
    }

    try {
      await sendEmail({
        to:      customerEmail,
        subject: `Your Repair is Ready — ${draft.name}`,
        html:    buildRepairCompleteHtml({ customerName, draftRef: draft.name, sequelId, trackingUrl })
      });
    } catch (err) {
      console.error(`❌ Resend failed (complete) for ${draft.name}:`, err.message);
      return;
    }

    await updateDraftOrderTags(draft.id, [...tags, 'repair-completion-notified'], token);
    await writeDraftOrderMetafields(draft.id, {
      repair_completed_at: new Date().toISOString()
    }, token);

    console.log(`✅ Repair completion notified: ${draft.name}${sequelId ? ` (Sequel: ${sequelId})` : ''}`);
  }
}

function registerRepairRoutes(app, getShopifyToken) {

  // ── Estimate approval form ─────────────────────────────────────────────────
  app.get('/repairs/set-estimate', async (req, res) => {
    const { d: draftId, t: hmacToken } = req.query;
    if (!draftId || hmacToken !== generateEstimateToken(draftId)) {
      return res.status(400).send('<h2 style="font-family:sans-serif;padding:40px;">Invalid or expired link.</h2>');
    }
    try {
      const shopifyToken = await getShopifyToken();
      const { data } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      );
      const d = data.draft_order;
      const customerName  = d.billing_address?.name || d.email || 'Customer';
      const customerEmail = d.email || '';
      const customerPhone = d.billing_address?.phone || d.phone || '';
      const itemDesc      = d.line_items?.[0]?.title || 'Repair service';
      const notes         = d.note || '';

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Set Estimate — ${d.name}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f4; margin: 0; padding: 40px 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 480px; margin: 0 auto; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo img { width: 120px; }
    h2 { font-size: 20px; margin: 0 0 4px 0; }
    .ref { font-size: 13px; color: #999; margin: 0 0 24px 0; }
    .info-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
    .info-table td { padding: 6px 0; vertical-align: top; }
    .info-table td:first-child { color: #888; width: 110px; }
    .info-table td:last-child { color: #222; }
    .divider { border: none; border-top: 1px solid #eee; margin: 16px 0; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    .prefix-input { display: flex; border: 1px solid #ccc; border-radius: 6px; overflow: hidden; }
    .prefix-input span { background: #f0f0f0; padding: 10px 12px; font-size: 15px; color: #555; border-right: 1px solid #ccc; }
    .prefix-input input { border: none; outline: none; padding: 10px 12px; font-size: 15px; width: 100%; }
    button { margin-top: 20px; width: 100%; background: #000; color: #fff; border: none; border-radius: 6px; padding: 14px; font-size: 15px; font-weight: 500; cursor: pointer; }
    button:hover { background: #222; }
    .notes-box { background: #f9f9f9; border-left: 3px solid #fc7d27; padding: 10px 14px; font-size: 13px; color: #444; margin-bottom: 0; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti"></div>
    <h2>Set Repair Estimate</h2>
    <p class="ref">${d.name}</p>
    <table class="info-table">
      <tr><td>Customer</td><td>${customerName}</td></tr>
      <tr><td>Email</td><td>${customerEmail}</td></tr>
      ${customerPhone ? `<tr><td>Phone</td><td>${customerPhone}</td></tr>` : ''}
      <tr><td>Item</td><td>${itemDesc}</td></tr>
    </table>
    ${notes ? `<hr class="divider"><label>Staff Notes</label><div class="notes-box">${notes.replace(/\n/g, '<br>')}</div><hr class="divider">` : '<hr class="divider">'}
    <form method="POST" action="/repairs/set-estimate">
      <input type="hidden" name="draftId" value="${draftId}">
      <input type="hidden" name="token" value="${hmacToken}">
      <div id="amountWrap">
        <label for="amount">Estimate Amount (₹)</label>
        <div class="prefix-input">
          <span>₹</span>
          <input id="amount" name="amount" type="number" min="1" step="0.01" placeholder="e.g. 1500" required>
        </div>
      </div>
      <div style="margin-top:16px; padding:12px 16px; background:#fff3cd; border-radius:6px; border:1px solid #ffc107;">
        <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:13px; font-weight:500; margin:0;">
          <input type="checkbox" name="free" value="true" id="freeCheck" onchange="toggleFree(this)" style="width:16px; height:16px; cursor:pointer;">
          This repair is our mistake — mark as free (no charge to customer)
        </label>
      </div>
      <button type="submit">Send Estimate to Customer</button>
    </form>
    <script>
    function toggleFree(cb) {
      var wrap = document.getElementById('amountWrap');
      var input = document.getElementById('amount');
      var btn = document.querySelector('button[type="submit"]');
      wrap.style.opacity = cb.checked ? '0.35' : '1';
      input.required = !cb.checked;
      if (cb.checked) input.value = '';
      btn.textContent = cb.checked ? 'Mark as Free & Notify Customer' : 'Send Estimate to Customer';
    }
    </script>
  </div>
</body>
</html>`);
    } catch (err) {
      console.error('set-estimate GET error:', err.response?.data || err.message);
      res.status(500).send('<h2 style="font-family:sans-serif;padding:40px;">Server error — try again.</h2>');
    }
  });

  app.post('/repairs/set-estimate', require('express').urlencoded({ extended: false }), async (req, res) => {
    const { draftId, token: hmacToken, amount, free } = req.body;
    if (!draftId || hmacToken !== generateEstimateToken(draftId)) {
      return res.status(400).send('<h2 style="font-family:sans-serif;padding:40px;">Invalid or expired link.</h2>');
    }
    const isFree = free === 'true';
    const parsedAmount = isFree ? 0 : parseFloat(amount);
    if (!isFree && (!parsedAmount || parsedAmount <= 0)) {
      return res.status(400).send('<h2 style="font-family:sans-serif;padding:40px;">Invalid amount.</h2>');
    }
    try {
      const shopifyToken = await getShopifyToken();

      const { data: fetchData } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      );
      const draft       = fetchData.draft_order;
      const currentTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);

      const firstItem = draft.line_items?.[0];
      const lineItems = firstItem
        ? [{ id: firstItem.id, title: firstItem.title, quantity: firstItem.quantity, price: parsedAmount.toFixed(2) },
           ...draft.line_items.slice(1).map(li => ({ id: li.id }))]
        : draft.line_items;

      if (isFree) {
        // Free path: add repair-free, skip GoKwik
        const newTags = currentTags.filter(t => t !== 'repair-free').concat(['repair-free']);
        await axios.put(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
          { draft_order: { id: Number(draftId), line_items: lineItems, tags: newTags.join(', ') } },
          { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
        );
        console.log(`✅ Free repair marked: ${draft.name} — repair-free added`);

        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Marked as Free</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f4; margin: 0; padding: 40px 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 420px; margin: 0 auto; padding: 40px 32px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .check { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 12px 0; font-size: 20px; }
    p { color: #555; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h2>Marked as complimentary repair</h2>
    <p>The customer will receive a "no charge" email for <strong>${draft.name}</strong> and your team will receive the "Mark Complete" link when the repair is ready.</p>
    <p style="margin-top:16px; font-size:12px; color:#999;">You can close this tab.</p>
  </div>
</body>
</html>`);
      }

      // Paid path: add repair-estimate-ready, GoKwik link fires via webhook
      const newTags = currentTags.filter(t => t !== 'repair-estimate-ready').concat(['repair-estimate-ready']);
      await axios.put(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
        { draft_order: { id: Number(draftId), line_items: lineItems, tags: newTags.join(', ') } },
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      );

      console.log(`✅ Estimate set for ${draft.name}: ₹${parsedAmount} — repair-estimate-ready added`);

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Estimate Sent</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f4; margin: 0; padding: 40px 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 420px; margin: 0 auto; padding: 40px 32px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .check { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 12px 0; font-size: 20px; }
    p { color: #555; font-size: 14px; line-height: 1.6; }
    .amount { font-size: 28px; font-weight: 600; color: #000; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h2>Estimate sent to customer</h2>
    <div class="amount">&#x20B9;${Math.round(parsedAmount).toLocaleString('en-IN')}</div>
    <p>The customer will receive their estimate email and payment link for <strong>${draft.name}</strong> shortly.</p>
    <p style="margin-top:16px; font-size:12px; color:#999;">You can close this tab.</p>
  </div>
</body>
</html>`);
    } catch (err) {
      console.error('set-estimate POST error:', err.response?.data || err.message);
      res.status(500).send('<h2 style="font-family:sans-serif;padding:40px;">Server error — try again.</h2>');
    }
  });

  // ── Mark repair complete form ──────────────────────────────────────────────
  app.get('/repairs/set-complete', async (req, res) => {
    const { d: draftId, t: hmacToken } = req.query;
    if (!draftId || hmacToken !== generateCompleteToken(draftId)) {
      return res.status(400).send('<h2 style="font-family:sans-serif;padding:40px;">Invalid or expired link.</h2>');
    }
    try {
      const shopifyToken = await getShopifyToken();
      const { data } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      );
      const d = data.draft_order;
      const customerName = d.billing_address?.name || d.email || 'Customer';
      const itemDesc     = d.line_items?.[0]?.title || 'Repair service';

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Mark Complete — ${d.name}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f4; margin: 0; padding: 40px 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 480px; margin: 0 auto; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo img { width: 120px; }
    h2 { font-size: 20px; margin: 0 0 4px 0; }
    .ref { font-size: 13px; color: #999; margin: 0 0 24px 0; }
    .info-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
    .info-table td { padding: 6px 0; vertical-align: top; }
    .info-table td:first-child { color: #888; width: 110px; }
    .info-table td:last-child { color: #222; }
    .divider { border: none; border-top: 1px solid #eee; margin: 16px 0; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    .opt-label { font-size: 12px; color: #999; font-weight: 400; }
    input[type="text"] { border: 1px solid #ccc; border-radius: 6px; padding: 10px 12px; font-size: 15px; width: 100%; outline: none; }
    input[type="text"]:focus { border-color: #000; }
    button { margin-top: 20px; width: 100%; background: #000; color: #fff; border: none; border-radius: 6px; padding: 14px; font-size: 15px; font-weight: 500; cursor: pointer; }
    button:hover { background: #222; }
    .hint { font-size: 12px; color: #999; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti"></div>
    <h2>Mark Repair Complete</h2>
    <p class="ref">${d.name}</p>
    <table class="info-table">
      <tr><td>Customer</td><td>${customerName}</td></tr>
      <tr><td>Item</td><td>${itemDesc}</td></tr>
    </table>
    <hr class="divider">
    <form method="POST" action="/repairs/set-complete">
      <input type="hidden" name="draftId" value="${draftId}">
      <input type="hidden" name="token" value="${hmacToken}">
      <label for="sequelId">Sequel Shipment ID <span class="opt-label">(optional)</span></label>
      <input id="sequelId" name="sequelId" type="text" placeholder="e.g. SQ123456789IN">
      <p class="hint">Leave blank if the customer is collecting in-store.</p>
      <button type="submit">Notify Customer &amp; Mark Complete</button>
    </form>
  </div>
</body>
</html>`);
    } catch (err) {
      console.error('set-complete GET error:', err.response?.data || err.message);
      res.status(500).send('<h2 style="font-family:sans-serif;padding:40px;">Server error — try again.</h2>');
    }
  });

  app.post('/repairs/set-complete', require('express').urlencoded({ extended: false }), async (req, res) => {
    const { draftId, token: hmacToken, sequelId } = req.body;
    if (!draftId || hmacToken !== generateCompleteToken(draftId)) {
      return res.status(400).send('<h2 style="font-family:sans-serif;padding:40px;">Invalid or expired link.</h2>');
    }
    try {
      const shopifyToken = await getShopifyToken();

      const { data: fetchData } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      );
      const draft       = fetchData.draft_order;
      const currentTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);

      // Write tracking ID metafield before adding repair-complete tag so webhook sees it
      if (sequelId && sequelId.trim()) {
        await writeDraftOrderMetafields(draft.id, { repair_tracking_id: sequelId.trim() }, shopifyToken);
      }

      const newTags = currentTags.filter(t => t !== 'repair-complete').concat(['repair-complete']);
      await axios.put(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftId}.json`,
        { draft_order: { id: Number(draftId), tags: newTags.join(', ') } },
        { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
      );

      console.log(`✅ Repair complete marked: ${draft.name}${sequelId ? ` Sequel: ${sequelId.trim()}` : ''}`);

      const trackingLine = sequelId && sequelId.trim()
        ? `<p>Sequel shipment ID <strong>${sequelId.trim()}</strong> has been saved — the customer will receive a tracking link in their email.</p>`
        : `<p>The customer will receive a "repair is ready" email for <strong>${draft.name}</strong>.</p>`;

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Marked Complete</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f4; margin: 0; padding: 40px 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 420px; margin: 0 auto; padding: 40px 32px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .check { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 12px 0; font-size: 20px; }
    p { color: #555; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h2>Repair marked as complete</h2>
    ${trackingLine}
    <p style="margin-top:16px; font-size:12px; color:#999;">You can close this tab.</p>
  </div>
</body>
</html>`);
    } catch (err) {
      console.error('set-complete POST error:', err.response?.data || err.message);
      res.status(500).send('<h2 style="font-family:sans-serif;padding:40px;">Server error — try again.</h2>');
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

module.exports = { registerRepairRoutes, handleRepairPayment, handleRepairDraftUpdate };
