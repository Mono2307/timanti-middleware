require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const AUTO_PUSH_TO_TERMINAL = process.env.AUTO_PUSH_TO_TERMINAL === 'true';

function getPinePaymentMode() {
  const mode = (process.env.PINE_PAYMENT_MODE || 'integer').toLowerCase();
  if (mode === 'pipe') return '1|8|10|11|4|20|21';
  return 0;
}

function parseTerminalTag(tags) {
  if (!tags) return null;
  const tagList = typeof tags === 'string' ? tags.split(',') : tags;
  for (const tag of tagList) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.startsWith('terminal:')) return trimmed.replace('terminal:', '').toUpperCase().trim();
  }
  return null;
}

async function resolveStoreForLocation(shopifyLocationId, terminalTag) {
  if (terminalTag) {
    const { data: store } = await supabase.from('stores').select('*').eq('location_ref', terminalTag).single();
    if (store) { console.log(`Tag resolved: terminal:${terminalTag} → store "${store.store_name}"`); return store; }
    console.warn(`Tag "terminal:${terminalTag}" found but no matching store`);
  }
  if (shopifyLocationId) {
    const { data: location } = await supabase.from('locations').select('location_id')
      .eq('shopify_location_id', shopifyLocationId.toString()).eq('is_active', true).single();
    if (location?.location_id) {
      const { data: store } = await supabase.from('stores').select('*').eq('location_ref', location.location_id).single();
      if (store) { console.log(`Location resolved: Shopify ${shopifyLocationId} → "${store.store_name}"`); return store; }
    }
  }
  const { data: store } = await supabase.from('stores').select('*').order('id', { ascending: true }).limit(1).single();
  if (store) { console.log(`Fallback: using first store "${store.store_name}"`); return store; }
  console.error('No stores configured in DB');
  return null;
}

// ─────────────────────────────────────────
// Shopify Token Manager
// ─────────────────────────────────────────

let cachedToken = null;
let tokenFetchedAt = null;

async function getShopifyToken() {
  const now = Date.now();
  if (cachedToken && tokenFetchedAt && (now - tokenFetchedAt) < 23 * 60 * 60 * 1000) return cachedToken;
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    try {
      const response = await axios.post(
        `${process.env.SHOPIFY_STORE_URL}/admin/oauth/access_token`,
        { client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' },
        { timeout: 10000 }
      );
      const newToken = response.data.access_token;
      if (newToken) {
        cachedToken = newToken; tokenFetchedAt = now;
        await supabase.from('config').upsert({ key: 'shopify_access_token', value: newToken, updated_at: new Date().toISOString() });
        console.log('✅ Shopify token refreshed');
        return newToken;
      }
    } catch (err) { console.error('⚠️ Shopify token refresh failed:', err.response?.data || err.message); }
  }
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'shopify_access_token').single();
    if (data?.value) { cachedToken = data.value; tokenFetchedAt = now; return data.value; }
  } catch (err) { console.warn('Supabase token load failed:', err.message); }
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  throw new Error('No Shopify token available');
}

async function initShopifyToken() {
  console.log('🔑 Initialising Shopify token...');
  try {
    await getShopifyToken();
    setInterval(async () => { cachedToken = null; tokenFetchedAt = null; await getShopifyToken(); }, 23 * 60 * 60 * 1000);
  } catch (err) { console.error('❌ Shopify token init failed:', err.message); }
}

// ─────────────────────────────────────────
// Pine Helpers
// ─────────────────────────────────────────

const PINE_PENDING_MESSAGES = ['TXN UPLOADED', 'TXN PENDING', 'IN PROGRESS'];

function getPineStatusResult(responseCode, responseMessage) {
  const msg = (responseMessage || '').toUpperCase().trim();
  if (responseCode === 0) return { newStatus: 'PAID', cashierMessage: 'Payment confirmed!' };
  const isPending = PINE_PENDING_MESSAGES.some(p => msg.includes(p));
  if (isPending) return { newStatus: null, cashierMessage: `Terminal: ${responseMessage}` };
  return { newStatus: 'FAILED', cashierMessage: `Payment failed: ${responseMessage}` };
}

function parsePineCSV(rawBody) {
  const data = {};
  rawBody.split(',').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex !== -1) data[pair.substring(0, eqIndex).trim()] = pair.substring(eqIndex + 1).trim();
  });
  return data;
}

function makePineTransactionNumber(draftOrderName) {
  return `${draftOrderName}-${Date.now()}`;
}

// ─────────────────────────────────────────
// Email Builder
// ─────────────────────────────────────────

function buildDepositEmailHtml({ draft_order_name, customer_name, total_price, amount_paid, amount_pending, deposit_status, pdf_url }) {
  const isPartial = deposit_status === 'partial';
  const bannerBg  = isPartial ? '#fff3cd' : '#d4edda';
  const bannerText = isPartial
    ? `PARTIAL PAYMENT RECEIVED — Rs.${amount_paid} paid | Rs.${amount_pending} pending before dispatch`
    : `FULLY PAID — Rs.${amount_paid} received in full`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width">
  <style>
    body, p, td, span { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 300; margin: 0; padding: 0; }
    h2, h3, h4 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 500; margin: 0 0 10px 0; }
    a { color: #fc7d27; text-decoration: none; }
    .footer-link { color: #000000 !important; }
  </style>
</head>
<body style="background:#f4f4f4; padding: 20px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    <tr>
      <td>

        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #eeeeee;">
          <tr>
            <td style="text-align:center; padding:24px 20px;">
              <img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti" width="150">
            </td>
          </tr>
        </table>

        <!-- Payment banner -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background:${bannerBg}; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #dddddd;">
              ${bannerText}
            </td>
          </tr>
        </table>

        <!-- Greeting -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:28px 30px 10px 30px; text-align:center;">
              <p style="font-size:13px; color:#999999; margin-bottom:8px;">Order ${draft_order_name}</p>
              <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">${isPartial ? 'Deposit received — thank you!' : 'Full payment received — thank you!'}</h2>
              <p style="font-size:14px; color:#444444; line-height:1.6;">
                Hi <strong>${customer_name}</strong>,
                ${isPartial
                  ? `your deposit of <strong>Rs.${amount_paid}</strong> has been received. Your jewellery is being held for you. The remaining balance of <strong>Rs.${amount_pending}</strong> is due before dispatch.`
                  : `your full payment of <strong>Rs.${amount_paid}</strong> has been received. Your jewellery is being prepared and you will be notified when it is dispatched.`
                }
              </p>
            </td>
          </tr>
        </table>

        <!-- Payment summary -->
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px;">
          <tr>
            <td>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9; margin:20px 0;">
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:13px; color:#666666; padding:5px 0;">Order Total</td>
                        <td style="font-size:13px; color:#666666; text-align:right; padding:5px 0;">Rs.${total_price}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px; color:#006630; font-weight:bold; padding:5px 0;">Amount Received</td>
                        <td style="font-size:14px; color:#006630; font-weight:bold; text-align:right; padding:5px 0;">Rs.${amount_paid}</td>
                      </tr>
                      ${isPartial ? `
                      <tr><td colspan="2" style="border-top:1px solid #dddddd; padding-top:5px;"></td></tr>
                      <tr>
                        <td style="font-size:14px; color:#cc4400; font-weight:bold; padding:5px 0;">Balance Pending</td>
                        <td style="font-size:14px; color:#cc4400; font-weight:bold; text-align:right; padding:5px 0;">Rs.${amount_pending}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Download button -->
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 10px 30px;">
          <tr>
            <td style="text-align:center;">
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background:#000000; border-radius:4px; text-align:center;">
                    <a href="${pdf_url}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:14px 28px; font-size:14px;">
                      Download Proforma Invoice
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Info box -->
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px 20px 30px;">
          <tr>
            <td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
              <h4 style="color:#000000; margin-bottom:8px;">${isPartial ? 'Next steps' : 'What happens next'}</h4>
              ${isPartial
                ? `<p style="font-size:13px; color:#444444; margin:4px 0;">Your piece is being held. Please complete the balance of <strong>Rs.${amount_pending}</strong> to proceed to dispatch.</p>
                   <p style="font-size:13px; color:#444444; margin:4px 0;">Call or WhatsApp us at <strong>+91-7738868305</strong> or visit the store.</p>`
                : `<p style="font-size:13px; color:#444444; margin:4px 0;">Your jewellery is being prepared and quality checked.</p>
                   <p style="font-size:13px; color:#444444; margin:4px 0;">You will receive a shipping confirmation with your tax invoice once dispatched.</p>`
              }
            </td>
          </tr>
        </table>

        <!-- Support -->
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
          <tr>
            <td style="border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
              <h3 style="color:#000000; margin-bottom:12px;">Need Help?</h3>
              <p style="color:#666666; font-size:13px; margin-bottom:12px;">Our team is here to assist you</p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="padding:0 20px; font-size:13px;">
                    <strong>Phone/WhatsApp</strong><br>
                    <a href="tel:+917738868305" class="footer-link">+91-7738868305</a>
                  </td>
                  <td style="padding:0 20px; font-size:13px;">
                    <strong>Email</strong><br>
                    <a href="mailto:info@timanti.in" class="footer-link">info@timanti.in</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- WhatsApp consent -->
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
          <tr>
            <td style="background:#F6F6F6; border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
              <h4 style="color:#000000; margin-bottom:8px;">Stay Connected with Timanti</h4>
              <p style="font-size:13px; color:#444444; margin-bottom:12px;">Get exclusive updates on new collections, special offers, and jewelry care tips.</p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background:#000000; border-radius:4px;">
                    <a href="https://wa.me/917738868305?text=Yes%2C%20I%20want%20to%20receive%20WhatsApp%20updates%20from%20Timanti" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:10px 20px; font-size:13px;">
                      Join WhatsApp Updates
                    </a>
                  </td>
                </tr>
              </table>
              <p style="font-size:11px; color:#999999; margin-top:12px;">By clicking above, you consent to receive marketing messages from Timanti. You can unsubscribe anytime.</p>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
          <tr>
            <td style="text-align:center; font-size:12px; color:#666666;">
              <p>Questions? <a href="mailto:info@timanti.in" style="color:#fc7d27;">info@timanti.in</a> | <a href="tel:+917738868305" style="color:#fc7d27;">+91-7738868305</a></p>
              <p style="margin-top:8px;">
                <a href="https://timanti.in/pages/return-refund-policy" style="color:#fc7d27;">Returns &amp; Refunds</a> &nbsp;|&nbsp;
                <a href="https://timanti.in/pages/exchange-and-buyback" style="color:#fc7d27;">Exchange &amp; Buyback</a> &nbsp;|&nbsp;
                <a href="https://timanti.in/pages/shipping" style="color:#fc7d27;">Shipping Policy</a>
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────
// Deposit Email Sender (called internally)
// ─────────────────────────────────────────

async function sendDepositEmail(shopifyDraftId, draftOrderName, newAmountPaid, newAmountPending, newStatus, deposit) {
  try {
    const token = await getShopifyToken();
    const draftRes = await fetch(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const draftData = await draftRes.json();
    const draftOrder = draftData.draft_order;

    if (!draftOrder?.email) {
      console.log(`sendDepositEmail: no email on draft order ${shopifyDraftId}, skipping`);
      return;
    }

    // Dedup check
    if (deposit) {
      if (newStatus === 'partial' && deposit.email_sent_partial) {
        console.log(`Deposit email already sent (partial) for ${draftOrderName}`);
        return;
      }
      if (newStatus === 'paid' && deposit.email_sent_paid) {
        console.log(`Deposit email already sent (paid) for ${draftOrderName}`);
        return;
      }
    }

    const pdfUrl = `https://timanti.in/apps/download-pdf/orders/91013a1d4c9b2beea028/${draftOrder.id * 5255}/${draftOrderName.replace('#', '').toLowerCase()}.pdf`;

    const subject = newStatus === 'paid'
      ? `Your Timanti order ${draftOrderName} — payment received in full`
      : `Your Timanti order ${draftOrderName} — deposit of Rs.${Math.round(newAmountPaid)} confirmed`;

    const html = buildDepositEmailHtml({
      draft_order_name: draftOrderName,
      customer_name:    draftOrder.billing_address?.first_name || 'there',
      total_price:      draftOrder.total_price,
      amount_paid:      Math.round(newAmountPaid).toString(),
      amount_pending:   Math.round(Math.max(0, newAmountPending)).toString(),
      deposit_status:   newStatus,
      pdf_url:          pdfUrl
    });

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    'Timanti <onboarding@resend.dev>',
        to:      draftOrder.email,
        subject,
        html
      })
    });

    const resendData = await resendRes.json();
    console.log(`📧 Deposit email sent to ${draftOrder.email} (${newStatus}):`, resendData.id || resendData);

    // Mark sent in store_deposits
    if (deposit?.id) {
      const flag = newStatus === 'paid' ? { email_sent_paid: true } : { email_sent_partial: true };
      await supabase.from('store_deposits').update(flag).eq('id', deposit.id);
    }
  } catch (err) {
    console.error('❌ sendDepositEmail failed:', err.message);
  }
}

// ─────────────────────────────────────────
// Shopify Helpers
// ─────────────────────────────────────────

async function completeShopifyOrder(shopifyDraftId, transactionDbId) {
  try {
    const token = await getShopifyToken();
    const shopifyResponse = await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}/complete.json`,
      { payment_pending: false },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const finalOrderId = shopifyResponse.data.draft_order.order_id;
    console.log(`✅ Shopify order completed: ${finalOrderId}`);
    await supabase.from('transactions').update({ final_shopify_order_id: finalOrderId.toString() }).eq('id', transactionDbId);
    return finalOrderId;
  } catch (error) {
    console.error('❌ Shopify complete error:', error.response?.data || error.message);
    return null;
  }
}

async function tagShopifyDraftOrder(shopifyDraftId, amountPaid, amountPending, status) {
  try {
    const token = await getShopifyToken();
    const getResponse = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const existingTags = getResponse.data.draft_order.tags || '';
    const cleanedTags = existingTags
      .split(',')
      .map(t => t.trim())
      .filter(t => t && !t.startsWith('paid:') && !t.startsWith('pending:') && !t.startsWith('deposit:'))
      .join(', ');
    const newTag = status === 'paid'
      ? `deposit:fully-paid, paid:Rs${amountPaid.toFixed(0)}`
      : `deposit:partial, paid:Rs${amountPaid.toFixed(0)}, pending:Rs${amountPending.toFixed(0)}`;
    const finalTags = cleanedTags ? `${cleanedTags}, ${newTag}` : newTag;
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}.json`,
      { draft_order: { id: shopifyDraftId, tags: finalTags } },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`✅ Shopify draft ${shopifyDraftId} tagged: ${newTag}`);
  } catch (err) {
    console.error('❌ Shopify tag update failed:', err.response?.data || err.message);
  }
}

async function sendDraftOrderInvoice(shopifyDraftId, paymentStatus, amountPaid, amountPending) {
  try {
    const token = await getShopifyToken();
    const subject = paymentStatus === 'paid'
      ? `Your Timanti order is confirmed — payment received in full`
      : `Timanti order confirmation — deposit of Rs.${amountPaid} received, Rs.${amountPending} pending`;
    const customMessage = paymentStatus === 'paid'
      ? `Your full payment of Rs.${amountPaid} has been received. We're preparing your jewellery and will notify you when it's dispatched.`
      : `Your deposit of Rs.${amountPaid} has been received. The remaining balance of Rs.${amountPending} is due before dispatch. Your proforma invoice is attached.`;
    await axios.post(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}/send_invoice.json`,
      { draft_order_invoice: { to: null, from: 'hello@timanti.in', subject, custom_message: customMessage } },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`📧 Draft order invoice sent for draft ${shopifyDraftId} (${paymentStatus})`);
  } catch (err) {
    console.error('❌ send_invoice failed:', err.response?.data || err.message);
  }
}

// ─────────────────────────────────────────
// Payment Completion Handler
// ─────────────────────────────────────────

async function handlePaymentCompletion(transaction) {
  if (!transaction.shopify_draft_id) return;

  if (transaction.is_partial) {
    console.log(`Partial payment confirmed for txn ${transaction.id} — updating store_deposits`);
    const amountPaidRupees = transaction.amount_paisa / 100;

    let { data: deposit } = await supabase
      .from('store_deposits').select('*')
      .eq('draft_order_id', transaction.shopify_draft_id).maybeSingle();

    if (!deposit) {
      const totalRupees = transaction.total_amount_paisa ? transaction.total_amount_paisa / 100 : amountPaidRupees;
      const { data: newDeposit } = await supabase.from('store_deposits').insert({
        draft_order_id:   transaction.shopify_draft_id,
        draft_order_name: transaction.draft_order_name,
        customer_name:    transaction.customer_name || '',
        total_amount:     totalRupees,
        amount_paid:      0,
        amount_pending:   totalRupees,
        payment_status:   'unpaid'
      }).select().single();
      deposit = newDeposit;
    }

    if (!deposit) { console.error(`Could not find or create store_deposits for draft ${transaction.shopify_draft_id}`); return; }

    const newAmountPaid    = parseFloat(deposit.amount_paid) + amountPaidRupees;
    const newAmountPending = parseFloat(deposit.total_amount) - newAmountPaid;
    const newStatus        = newAmountPending <= 0.01 ? 'paid' : 'partial';

    await supabase.from('store_deposits').update({
      amount_paid:    newAmountPaid,
      amount_pending: Math.max(0, newAmountPending),
      payment_status: newStatus,
      updated_at:     new Date().toISOString()
    }).eq('id', deposit.id);

    await supabase.from('store_deposit_payments').insert({
      deposit_id:    deposit.id,
      draft_order_id: transaction.shopify_draft_id,
      amount:         amountPaidRupees,
      payment_mode:   transaction.payment_mode || 'card',
      notes:          `Pine txn ${transaction.id}`,
      pine_ptrid:     transaction.pine_ref_id || null,
      recorded_by:    'pos_terminal',
      created_at:     new Date().toISOString()
    });

    await tagShopifyDraftOrder(
      transaction.shopify_draft_id,
      newAmountPaid,
      Math.max(0, newAmountPending),
      newStatus
    );

    // Re-fetch deposit with updated email_sent flags before sending email
    const { data: updatedDeposit } = await supabase
      .from('store_deposits').select('*')
      .eq('id', deposit.id).single();

    await sendDepositEmail(
      transaction.shopify_draft_id,
      transaction.draft_order_name,
      newAmountPaid,
      Math.max(0, newAmountPending),
      newStatus,
      updatedDeposit
    );

    if (newStatus === 'paid') {
      console.log(`✅ Fully paid — completing Shopify order for draft ${transaction.shopify_draft_id}`);
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    } else {
      console.log(`⏳ Partial recorded — Shopify NOT completed yet (Rs${newAmountPending.toFixed(2)} pending)`);
    }

  } else {
    await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
  }
}

// ─────────────────────────────────────────
// Core Push Logic
// ─────────────────────────────────────────

async function pushDraftOrderToTerminal({
  draftOrderId, draftOrderName, amountInRupees,
  shopifyLocationId, terminalTag,
  isPartial = false,
  totalAmountInRupees = null,
  customerName = ''
}) {
  const store = await resolveStoreForLocation(shopifyLocationId, terminalTag);
  if (!store) return { success: false, httpStatus: 404, error: 'No Pine terminal configured.' };

  const { data: existing } = await supabase.from('transactions').select('id, status')
    .eq('shopify_draft_id', draftOrderId.toString())
    .in('status', ['PENDING', 'PUSHED_TO_TERMINAL']).maybeSingle();

  if (existing) {
    return {
      success: false, httpStatus: 409,
      error: 'This draft order already has an active payment in progress. Cancel it first.',
      existingTransactionId: existing.id
    };
  }

  const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);

  if (amountInPaisa < 100) {
    return {
      success: false, httpStatus: 400,
      error: 'Transaction amount must be at least Rs.1. Please check the draft order amount.'
    };
  }

  const totalInPaisa          = totalAmountInRupees ? Math.round(parseFloat(totalAmountInRupees) * 100) : amountInPaisa;
  const pineTransactionNumber = makePineTransactionNumber(draftOrderName);

  const { data: txn, error: txnError } = await supabase.from('transactions').insert([{
    shopify_draft_id:        draftOrderId.toString(),
    draft_order_name:        draftOrderName,
    pine_transaction_number: pineTransactionNumber,
    location_id:             store.id,
    amount_paisa:            amountInPaisa,
    total_amount_paisa:      totalInPaisa,
    customer_name:           customerName,
    is_partial:              isPartial,
    status:                  'PENDING'
  }]).select().single();

  if (txnError) {
    console.error('DB insert error:', txnError);
    return { success: false, httpStatus: 500, error: 'DB error', detail: txnError.message };
  }

  const paymentMode = getPinePaymentMode();
  const pinePayload = {
    TransactionNumber:           pineTransactionNumber,
    SequenceNumber:              1,
    AllowedPaymentMode:          paymentMode,
    Amount:                      amountInPaisa,
    UserID:                      'System',
    MerchantID:                  parseInt(store.pine_merchant_id),
    SecurityToken:               process.env.PINE_LABS_SECURITY_TOKEN,
    ClientId:                    parseInt(store.pine_client_id),
    StoreId:                     parseInt(store.pine_store_id),
    TotalInvoiceAmount:          amountInPaisa,
    AutoCancelDurationInMinutes: 5
  };

  console.log(`UploadBilledTransaction txn ${txn.id} → "${store.store_name}" isPartial=${isPartial}`);

  axios.post(`${process.env.PINE_LABS_API_URL}/V1/UploadBilledTransaction`, pinePayload, { timeout: 30000 })
    .then(async (pineResponse) => {
      console.log(`UploadBilledTransaction txn ${txn.id} RESPONSE:`, JSON.stringify(pineResponse.data));
      const responseCode = parseInt(pineResponse.data.ResponseCode);
      const ptrid        = pineResponse.data.PlutusTransactionReferenceID || null;
      const ptridNum     = ptrid ? parseInt(ptrid) : null;
      const newStatus    = (responseCode === 0 && ptridNum && ptridNum > 0) ? 'PUSHED_TO_TERMINAL' : 'FAILED';
      await supabase.from('transactions').update({ status: newStatus, pine_ref_id: ptrid?.toString() || null }).eq('id', txn.id);
    })
    .catch(async (err) => {
      console.error(`UploadBilledTransaction timed out for txn ${txn.id}: ${err.message}`);
      await supabase.from('transactions').update({ status: 'PINE_UNREACHABLE', pine_ref_id: null }).eq('id', txn.id);
    });

  return { success: true, message: 'Transaction logged. Sending to terminal...', transactionId: txn.id };
}

// ─────────────────────────────────────────
// Background Poller (30s)
// ─────────────────────────────────────────

let isPolling = false;

async function pollActiveTxns() {
  if (isPolling) return;
  isPolling = true;
  try {
    const { data: activeTxns, error } = await supabase
      .from('transactions').select('*, stores(*)')
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']);
    if (error) { console.error('Poller DB error:', error.message); return; }
    if (!activeTxns || activeTxns.length === 0) return;
    console.log(`Poller: checking ${activeTxns.length} active transaction(s)`);

    for (const txn of activeTxns) {
      try {
        if (!txn.pine_ref_id) { console.log(`Poller: txn ${txn.id} — no PTRID yet`); continue; }
        const ptrid = parseInt(txn.pine_ref_id);
        if (ptrid <= 0) { await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', txn.id); continue; }
        const store = txn.stores;
        if (!store) { console.error(`Poller: no store config for txn ${txn.id}`); continue; }

        const pineResponse = await axios.post(
          `${process.env.PINE_LABS_API_URL}/V1/GetCloudBasedTxnStatus`,
          {
            MerchantID:                   parseInt(store.pine_merchant_id),
            SecurityToken:                process.env.PINE_LABS_SECURITY_TOKEN,
            ClientID:                     parseInt(store.pine_client_id),
            StoreID:                      parseInt(store.pine_store_id),
            PlutusTransactionReferenceID: ptrid
          },
          { timeout: 15000 }
        );

        const responseCode    = parseInt(pineResponse.data.ResponseCode);
        const responseMessage = pineResponse.data.ResponseMessage || '';
        const { newStatus }   = getPineStatusResult(responseCode, responseMessage);
        console.log(`Poller: txn ${txn.id} PTRID=${ptrid}: code=${responseCode} msg="${responseMessage}"${newStatus ? ` → ${newStatus}` : ' (no change)'}`);

        if (newStatus && newStatus !== txn.status) {
          await supabase.from('transactions').update({ status: newStatus }).eq('id', txn.id);
          if (newStatus === 'PAID') await handlePaymentCompletion(txn);
        }
      } catch (err) { console.error(`Poller: error on txn ${txn.id}:`, err.message); }
    }
  } finally { isPolling = false; }
}

// ─────────────────────────────────────────
// Routes
// ─────────────────────────────────────────

app.get('/api/test-db', async (req, res) => {
  const { data: stores }    = await supabase.from('stores').select('*');
  const { data: locations } = await supabase.from('locations').select('*');
  return res.json({
    stores, locations,
    config: {
      autoPushToTerminal:     AUTO_PUSH_TO_TERMINAL,
      pinePaymentMode:        process.env.PINE_PAYMENT_MODE || 'integer',
      pinePaymentModeValue:   getPinePaymentMode(),
      shopifyTokenCached:     !!cachedToken,
      shopifyTokenAgeMinutes: tokenFetchedAt ? Math.round((Date.now() - tokenFetchedAt) / 60000) : null
    },
    env: {
      supabaseUrl:         process.env.SUPABASE_URL          ? 'SET' : 'MISSING',
      serviceKey:          process.env.SUPABASE_SERVICE_KEY  ? 'SET' : 'MISSING',
      pineUrl:             process.env.PINE_LABS_API_URL     ? 'SET' : 'MISSING',
      shopifyUrl:          process.env.SHOPIFY_STORE_URL     ? 'SET' : 'MISSING',
      shopifyClientId:     process.env.SHOPIFY_CLIENT_ID     ? 'SET' : 'MISSING ⚠️',
      shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET ? 'SET' : 'MISSING ⚠️',
      resendApiKey:        process.env.RESEND_API_KEY        ? 'SET' : 'MISSING ⚠️'
    }
  });
});

app.get('/api/draft-orders', async (req, res) => {
  try {
    const token       = await getShopifyToken();
    const queryString = new URLSearchParams(req.query).toString();
    const shopifyUrl  = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json${queryString ? `?${queryString}` : ''}`;
    const response    = await axios.get(shopifyUrl, { headers: { 'X-Shopify-Access-Token': token }, timeout: 15000 });
    return res.json(response.data);
  } catch (err) {
    return res.status(err.response?.status || 500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/push-to-terminal', async (req, res) => {
  const {
    draftOrderId, draftOrderName, amountInRupees, locationId,
    isPartial = false,
    totalAmountInRupees = null,
    customerName = ''
  } = req.body;

  if (!draftOrderId || !draftOrderName || !amountInRupees) {
    return res.status(400).json({ success: false, error: 'Missing: draftOrderId, draftOrderName, amountInRupees' });
  }
  try {
    const result = await pushDraftOrderToTerminal({
      draftOrderId, draftOrderName, amountInRupees,
      shopifyLocationId: locationId || null,
      terminalTag: null,
      isPartial, totalAmountInRupees, customerName
    });
    return res.status(result.httpStatus || 200).json(result);
  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/shopify-draft-created', async (req, res) => {
  res.status(200).send('OK');
  try {
    const draft = req.body;
    if (!draft || !draft.id) { console.error('Shopify webhook: empty payload'); return; }
    const draftOrderId      = draft.id.toString();
    const draftOrderName    = draft.name || `#${draftOrderId}`;
    const amountInRupees    = draft.total_price;
    const shopifyLocationId = draft.location_id?.toString() || null;
    const terminalTag       = parseTerminalTag(draft.tags);
    console.log(`Shopify draft created: ${draftOrderName} Rs${amountInRupees}`);
    if (!AUTO_PUSH_TO_TERMINAL) { console.log(`Auto-push OFF — cashier pushes manually`); return; }
    if (!amountInRupees || parseFloat(amountInRupees) <= 0) { console.error(`Auto-push: zero amount — skipping`); return; }
    const result = await pushDraftOrderToTerminal({ draftOrderId, draftOrderName, amountInRupees, shopifyLocationId, terminalTag });
    console.log(`Auto-push result for ${draftOrderName}:`, JSON.stringify(result));
  } catch (err) { console.error('Shopify draft webhook error:', err.message); }
});

app.post('/api/check-status', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId required' });
  try {
    const { data: transaction, error: txnError } = await supabase.from('transactions').select('*').eq('id', transactionId).single();
    if (txnError || !transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (!transaction.pine_ref_id) {
      return res.json({ success: true, status: transaction.status, calledPine: false, transactionId: transaction.id,
        message: transaction.status === 'PINE_UNREACHABLE' ? 'Upload timed out — cancel and push again.' : 'Not yet sent to terminal.' });
    }
    const ptridNum = parseInt(transaction.pine_ref_id);
    if (ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', transactionId);
      return res.json({ success: true, status: 'FAILED', message: 'Pine rejected this transaction. Push again.', calledPine: false, transactionId: transaction.id });
    }
    const { data: store, error: storeError } = await supabase.from('stores').select('*').eq('id', transaction.location_id).single();
    if (storeError || !store) return res.status(500).json({ success: false, error: 'Store config not found' });

    const pineStatusResponse = await axios.post(
      `${process.env.PINE_LABS_API_URL}/V1/GetCloudBasedTxnStatus`,
      { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
        ClientID: parseInt(store.pine_client_id), StoreID: parseInt(store.pine_store_id),
        PlutusTransactionReferenceID: ptridNum },
      { timeout: 15000 }
    );
    const pineResponseCode              = parseInt(pineStatusResponse.data.ResponseCode);
    const pineMessage                   = pineStatusResponse.data.ResponseMessage || '';
    const { newStatus, cashierMessage } = getPineStatusResult(pineResponseCode, pineMessage);
    if (newStatus && newStatus !== transaction.status) {
      await supabase.from('transactions').update({ status: newStatus }).eq('id', transactionId);
      if (newStatus === 'PAID') await handlePaymentCompletion(transaction);
    }
    return res.json({ success: true, status: newStatus || transaction.status, message: cashierMessage,
      calledPine: true, pineResponseCode, pineResponseMessage: pineMessage,
      transactionId: transaction.id, pineRefId: transaction.pine_ref_id });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not reach Pine Labs.', detail: error.message });
  }
});

app.post('/api/cancel-transaction', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId required' });
  try {
    const { data: transaction, error: txnError } = await supabase.from('transactions').select('*').eq('id', transactionId).single();
    if (txnError || !transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (['PAID', 'CANCELLED'].includes(transaction.status)) return res.status(400).json({ success: false, error: `Cannot cancel — already ${transaction.status}.` });
    if (!transaction.pine_ref_id) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({ success: true, message: 'Cancelled (Pine had not received it).', transactionId: transaction.id, calledPine: false });
    }
    const ptridNum = parseInt(transaction.pine_ref_id);
    if (ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({ success: true, message: 'Cancelled (Pine had rejected it).', transactionId: transaction.id, calledPine: false });
    }
    const { data: store, error: storeError } = await supabase.from('stores').select('*').eq('id', transaction.location_id).single();
    if (storeError || !store) return res.status(500).json({ success: false, error: 'Store config not found' });

    let pineResponseCode, pineMessage;
    try {
      const pineResponse = await axios.post(
        `${process.env.PINE_LABS_API_URL}/V1/CancelTransaction`,
        { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
          ClientId: parseInt(store.pine_client_id), StoreId: parseInt(store.pine_store_id),
          PlutusTransactionReferenceID: ptridNum, Amount: transaction.amount_paisa },
        { timeout: 15000 }
      );
      pineResponseCode = parseInt(pineResponse.data.ResponseCode);
      pineMessage      = pineResponse.data.ResponseMessage || '';
    } catch (pineError) {
      return res.status(502).json({ success: false,
        error: `Pine cancel failed (HTTP ${pineError.response?.status || 'N/A'}). NOT cancelled in DB.`,
        detail: JSON.stringify(pineError.response?.data) || pineError.message, transactionId: transaction.id });
    }
    if (pineResponseCode === 0) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({ success: true, message: 'Transaction cancelled.', transactionId: transaction.id, pineResponseCode, pineResponseMessage: pineMessage });
    } else {
      return res.status(400).json({ success: false, error: `Pine rejected: ${pineMessage}`, pineResponseCode, pineResponseMessage: pineMessage, transactionId: transaction.id });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pine-postback', async (req, res) => {
  res.status(200).send('OK');
  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const data    = parsePineCSV(rawBody);
    console.log('Pine PostBack received:', data);
    const responseCode          = parseInt(data['ResponseCode']);
    const ptrid                 = data['PlutusTransactionReferenceID'];
    const pineTransactionNumber = data['TransactionNumber'];
    if (!ptrid && !pineTransactionNumber) { console.error('PostBack: missing PTRID and TransactionNumber'); return; }

    let txnRows;
    if (ptrid) {
      const result = await supabase.from('transactions').select('*').eq('pine_ref_id', ptrid.toString()).order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) {
      const result = await supabase.from('transactions').select('*').eq('pine_transaction_number', pineTransactionNumber)
        .in('status', ['PENDING', 'PUSHED_TO_TERMINAL']).order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) { console.error('PostBack: no matching transaction for PTRID:', ptrid); return; }

    const transaction = txnRows[0];
    const newStatus   = responseCode === 0 ? 'PAID' : 'FAILED';
    const paymentMode = data['PaymenMode'] || data['PaymentMode'] || null;
    await supabase.from('transactions').update({
      status: newStatus, pine_ref_id: ptrid?.toString() || transaction.pine_ref_id, payment_mode: paymentMode
    }).eq('id', transaction.id);
    console.log(`✅ PostBack: txn ${transaction.id} → ${newStatus}`);
    if (newStatus === 'PAID') await handlePaymentCompletion(transaction);
  } catch (error) { console.error('PostBack error:', error.message); }
});

app.post('/api/pine-webhook', async (req, res) => {
  const pineData = req.body;
  console.log('Pine webhook received:', JSON.stringify(pineData));
  res.status(200).send('OK');
  try {
    if (pineData.transactionId) {
      const { data: transaction, error } = await supabase.from('transactions').select('*').eq('id', parseInt(pineData.transactionId)).single();
      if (error || !transaction) { console.error('Webhook: transaction not found:', pineData.transactionId); return; }
      await supabase.from('transactions').update({
        status: 'PAID', pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id || 'TEST'
      }).eq('id', transaction.id);
      console.log(`✅ Test webhook: txn ${transaction.id} → PAID`);
      await handlePaymentCompletion(transaction);
      return;
    }
    const responseCode   = parseInt(pineData.ResponseCode);
    const draftOrderName = pineData.TransactionNumber;
    if (responseCode !== 0) {
      await supabase.from('transactions').update({ status: 'FAILED' })
        .eq('draft_order_name', draftOrderName).in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']);
      return;
    }
    const { data: txnRows } = await supabase.from('transactions').select('*')
      .eq('draft_order_name', draftOrderName).in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE'])
      .order('created_at', { ascending: false }).limit(1);
    if (!txnRows || txnRows.length === 0) { console.error('Webhook: no active transaction for:', draftOrderName); return; }
    const transaction = txnRows[0];
    await supabase.from('transactions').update({
      status: 'PAID', pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id
    }).eq('id', transaction.id);
    console.log(`✅ Webhook: txn ${transaction.id} → PAID`);
    await handlePaymentCompletion(transaction);
  } catch (error) { console.error('Webhook error:', error.message); }
});

app.post('/api/send-invoice-email', async (req, res) => {
  const { order_id, order_name, customer_email, customer_name } = req.body;

  if (!order_id || !order_name || !customer_email) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const pdfUrl = `https://timanti.in/apps/download-pdf/orders/91013a1d4c9b2beea028/${order_id * 5255}/${String(order_name).replace('#', '').toLowerCase()}.pdf`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width">
  <style>
    body, p, td, span { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 300; margin: 0; padding: 0; }
    h2, h3, h4 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 500; margin: 0 0 10px 0; }
    a { color: #fc7d27; text-decoration: none; }
    .footer-link { color: #000000 !important; }
  </style>
</head>
<body style="background:#f4f4f4; padding:20px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #eeeeee;">
        <tr><td style="text-align:center; padding:24px 20px;">
          <img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti" width="150">
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">Order ${order_name}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">Your order is on its way!</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customer_name || 'there'}</strong>, your jewellery has been dispatched. Your tax invoice with actual jewellery specifications is ready to download.</p>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 30px;">
        <tr><td style="text-align:center;">
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background:#000000; border-radius:4px; text-align:center;">
              <a href="${pdfUrl}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:14px 28px; font-size:14px;">Download Tax Invoice</a>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px;">Your tax invoice includes</h4>
          <p style="font-size:13px; color:#444444; margin:4px 0;">Jewellery code &middot; Actual gross &amp; net weight &middot; Diamond weight &amp; pieces</p>
          <p style="font-size:13px; color:#444444; margin:4px 0;">Metal details &middot; Full GST breakdown &middot; Hallmark certificate reference</p>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h3 style="color:#000000; margin-bottom:12px;">Need Help?</h3>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 20px; font-size:13px;"><strong>Phone/WhatsApp</strong><br><a href="tel:+917738868305" style="color:#000000;">+91-7738868305</a></td>
              <td style="padding:0 20px; font-size:13px;"><strong>Email</strong><br><a href="mailto:info@timanti.in" style="color:#000000;">info@timanti.in</a></td>
            </tr>
          </table>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px;">Stay Connected with Timanti</h4>
          <p style="font-size:13px; color:#444444; margin-bottom:12px;">Get exclusive updates on new collections, special offers, and jewelry care tips.</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background:#000000; border-radius:4px;">
              <a href="https://wa.me/917738868305?text=Yes%2C%20I%20want%20to%20receive%20WhatsApp%20updates%20from%20Timanti" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:10px 20px; font-size:13px;">Join WhatsApp Updates</a>
            </td></tr>
          </table>
          <p style="font-size:11px; color:#999999; margin-top:12px;">By clicking above, you consent to receive marketing messages from Timanti. You can unsubscribe anytime.</p>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Questions? <a href="mailto:info@timanti.in" style="color:#fc7d27;">info@timanti.in</a> | <a href="tel:+917738868305" style="color:#fc7d27;">+91-7738868305</a></p>
          <p style="margin-top:8px;">
            <a href="https://timanti.in/pages/return-refund-policy" style="color:#fc7d27;">Returns &amp; Refunds</a> &nbsp;|&nbsp;
            <a href="https://timanti.in/pages/exchange-and-buyback" style="color:#fc7d27;">Exchange &amp; Buyback</a> &nbsp;|&nbsp;
            <a href="https://timanti.in/pages/shipping" style="color:#fc7d27;">Shipping Policy</a> &nbsp;|&nbsp;
            <a href="https://timanti.in/pages/track-your-order" style="color:#fc7d27;">Track Order</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Timanti <onboarding@resend.dev>',
        to:      customer_email,
        subject: `Your Timanti order ${order_name} with invoice is shipped`,
        html
      })
    });
    const resendData = await resendResponse.json();
    console.log('Resend response:', JSON.stringify(resendData));
    if (!resendResponse.ok) {
      console.error('Resend error:', resendData);
      return res.status(500).json({ success: false, error: resendData });
    }
    res.json({ success: true, emailId: resendData.id });
  } catch (err) {
    console.error('Email send failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`\n🚀 Timanti Middleware on port ${PORT}`);
  console.log(`⚙️  AUTO_PUSH=${AUTO_PUSH_TO_TERMINAL} | PINE_MODE=${process.env.PINE_PAYMENT_MODE || 'integer'}`);
  console.log('  GET  /api/test-db');
  console.log('  GET  /api/draft-orders');
  console.log('  POST /api/push-to-terminal');
  console.log('  POST /api/shopify-draft-created');
  console.log('  POST /api/check-status');
  console.log('  POST /api/cancel-transaction');
  console.log('  POST /api/pine-postback');
  console.log('  POST /api/pine-webhook');
  console.log('  POST /api/send-invoice-email');
  await initShopifyToken();
  console.log('🔄 Background poller started (30s)');
  setInterval(pollActiveTxns, 30000);
});
