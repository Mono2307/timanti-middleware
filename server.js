require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { sendEmail, sendDepositEmail } = require('./emailService');
const { recalculate: recalculatePricing } = require('./services/pricing-engine');
const { handlePoWebhook } = require('./services/po-ops/webhook');
const { handlePoAction }  = require('./services/po-ops/action');
const { createPaymentLink: createGokwikLink, cancelPaymentLink: cancelGokwikLink } = require('./services/gokwik');
const { sendSMS } = require('./services/sms');

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.text({ type: '*/*' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const AUTO_PUSH_TO_TERMINAL       = process.env.AUTO_PUSH_TO_TERMINAL       === 'true';
const AUTO_CONVERT_DRAFT_TO_ORDER = process.env.AUTO_CONVERT_DRAFT_TO_ORDER === 'true';
const AUTO_SEND_DRAFT_INVOICE     = process.env.AUTO_SEND_DRAFT_INVOICE     === 'true';
const AUTO_SEND_DEPOSIT_EMAIL     = process.env.AUTO_SEND_DEPOSIT_EMAIL     === 'true';

function getPinePaymentMode() {
  const mode = (process.env.PINE_PAYMENT_MODE || 'integer').toLowerCase();
  if (mode === 'pipe') return '1|8|10|11|4|20|21';
  return 0;
}

function getPineApiUrl(store) {
  return store.is_uat
    ? process.env.PINE_LABS_UAT_API_URL
    : process.env.PINE_LABS_API_URL;
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
  if (terminalTag !== null && terminalTag !== undefined && terminalTag !== '') {
    const isNumericId = !isNaN(terminalTag) && String(terminalTag).trim() !== '';
    const { data: store } = isNumericId
      ? await supabase.from('stores').select('*').eq('id', parseInt(terminalTag)).single()
      : await supabase.from('stores').select('*').eq('location_ref', terminalTag).single();
    if (store) { console.log(`Terminal resolved: "${terminalTag}" → store "${store.store_name}"`); return store; }
    console.warn(`terminalTag "${terminalTag}" found but no matching store`);
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

function extractPineTransactionData(transactionDataArray) {
  const map = {};
  for (const item of (transactionDataArray || [])) map[item.Tag] = item.Value;
  return {
    utr:         map['RRN'] || null,
    paymentMode: (map['PaymentMode'] || '').toLowerCase() || null
  };
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
      .split(',').map(t => t.trim())
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
    console.error(`❌ Shopify tag update failed for draft ${shopifyDraftId}:`, JSON.stringify(err.response?.data) || err.message);
  }
}

function getMetafieldType(key) {
  if (key === 'amount_paid' || key === 'amount_pending') return 'number_decimal';
  if (key === 'is_finalized') return 'boolean';
  return 'single_line_text_field';
}

async function updateDraftOrderMetafields(draftOrderId, fields) {
  try {
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    // Fetch existing metafields so we can UPDATE by ID rather than create (Shopify 422s on duplicate key)
    const { data: existing } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const existingById = {};
    for (const mf of (existing.metafields || [])) {
      if (mf.namespace === 'custom') existingById[mf.key] = mf.id;
    }

    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined || String(value).trim() === '') continue;
      const existingId = existingById[key];
      if (existingId) {
        await axios.put(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/metafields/${existingId}.json`,
          { metafield: { id: existingId, value: String(value), type: getMetafieldType(key) } },
          { headers, timeout: 10000 }
        );
      } else {
        await axios.post(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
          { metafield: { namespace: 'custom', key, value: String(value), type: getMetafieldType(key) } },
          { headers, timeout: 10000 }
        );
      }
    }
    console.log(`✅ Metafields updated for draft ${draftOrderId}`, Object.keys(fields));
  } catch (err) {
    console.error('❌ Metafield update failed for draft', draftOrderId, ':', err.response?.data || err.message);
  }
}

async function sendDraftOrderInvoice(draftOrderId) {
  try {
    const token = await getShopifyToken();
    await axios.post(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/send_invoice.json`,
      { draft_order_invoice: {} },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`✅ Draft invoice sent for ${draftOrderId}`);
  } catch (err) {
    console.error('❌ Draft invoice send failed:', err.response?.data || err.message);
  }
}

async function convertDraftToOrder(draftOrderId, transactionDbId) {
  if (!AUTO_CONVERT_DRAFT_TO_ORDER) {
    console.log(`⏸️  AUTO_CONVERT off — draft ${draftOrderId} ready for manual conversion`);
    return null;
  }
  return completeShopifyOrder(draftOrderId, transactionDbId);
}

// ─────────────────────────────────────────
// Payment Completion Handler
// ─────────────────────────────────────────

async function handlePaymentCompletion(transaction, overrides = {}) {
  if (!transaction.shopify_draft_id) return;
  const { utr = null, paymentSource = 'pine', paymentModeOverride = null } = overrides;
  const paymentMode = paymentModeOverride || transaction.payment_mode || 'card';

  if (transaction.is_partial) {
    console.log(`Partial payment confirmed — draft ${transaction.shopify_draft_id} source=${paymentSource}`);
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

    const installmentType  = deposit.payment_status === 'unpaid' ? 'advance' : 'final';
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
      deposit_id:       deposit.id,
      draft_order_id:   transaction.shopify_draft_id,
      amount:           amountPaidRupees,
      payment_mode:     paymentMode,
      notes:            `${paymentSource} txn ${transaction.id}`,
      pine_ptrid:       transaction.pine_ref_id || null,
      recorded_by:      paymentSource,
      installment_type: installmentType,
      utr:              utr,
      payment_source:   paymentSource,
      created_at:       new Date().toISOString()
    });

    await tagShopifyDraftOrder(transaction.shopify_draft_id, newAmountPaid, Math.max(0, newAmountPending), newStatus);

    const metafieldUpdate = {
      payment_status:  newStatus === 'paid' ? 'full' : 'partial',
      amount_paid:     newAmountPaid.toFixed(2),
      amount_pending:  Math.max(0, newAmountPending).toFixed(2)
    };
    if (installmentType === 'advance') {
      metafieldUpdate.payment_mode_advance = paymentMode;
    }
    if (installmentType === 'final') metafieldUpdate.payment_mode_final = paymentMode;
    if (newStatus === 'paid')        metafieldUpdate.is_finalized = 'true';
    await updateDraftOrderMetafields(transaction.shopify_draft_id, metafieldUpdate);

    const { data: updatedDeposit } = await supabase
      .from('store_deposits').select('*').eq('id', deposit.id).single();

    if (AUTO_SEND_DEPOSIT_EMAIL) {
      await sendDepositEmail(
        transaction.shopify_draft_id, transaction.draft_order_name,
        newAmountPaid, Math.max(0, newAmountPending), newStatus, updatedDeposit, getShopifyToken
      );
    } else {
      console.log(`⏸️  AUTO_SEND_DEPOSIT_EMAIL off — skipping deposit email for draft ${transaction.shopify_draft_id}`);
    }

    if (newStatus === 'partial' && AUTO_SEND_DRAFT_INVOICE) {
      await sendDraftOrderInvoice(transaction.shopify_draft_id);
    }

    if (newStatus === 'paid') {
      console.log(`✅ Fully paid — draft ${transaction.shopify_draft_id}`);
      await convertDraftToOrder(transaction.shopify_draft_id, transaction.id);
    } else {
      console.log(`⏳ ${installmentType} recorded — Rs${Math.max(0, newAmountPending).toFixed(2)} pending`);
    }

  } else {
    await convertDraftToOrder(transaction.shopify_draft_id, transaction.id);
  }
}

// ─────────────────────────────────────────
// Core Push Logic
// ─────────────────────────────────────────

async function pushDraftOrderToTerminal({
  draftOrderId, draftOrderName, amountInRupees,
  shopifyLocationId, terminalTag,
  isPartial = false, totalAmountInRupees = null, customerName = ''
}) {
  const store = await resolveStoreForLocation(shopifyLocationId, terminalTag);
  if (!store) return { success: false, httpStatus: 404, error: 'No Pine terminal configured.' };

  const { data: existing } = await supabase.from('transactions').select('id, status')
    .eq('shopify_draft_id', draftOrderId.toString())
    .in('status', ['PENDING', 'PUSHED_TO_TERMINAL']).maybeSingle();

  if (existing) {
    return { success: false, httpStatus: 409,
      error: 'This draft order already has an active payment in progress. Cancel it first.',
      existingTransactionId: existing.id };
  }

  const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);
  if (amountInPaisa < 100) {
    return { success: false, httpStatus: 400, error: 'Transaction amount must be at least Rs.1.' };
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

  const pinePayload = {
    TransactionNumber:           pineTransactionNumber,
    SequenceNumber:              1,
    AllowedPaymentMode:          getPinePaymentMode(),
    Amount:                      amountInPaisa,
    UserID:                      'System',
    MerchantID:                  parseInt(store.pine_merchant_id),
    SecurityToken:               store.security_token || process.env.PINE_LABS_SECURITY_TOKEN,
    ClientId:                    parseInt(store.pine_client_id),
    StoreId:                     parseInt(store.pine_store_id),
    TotalInvoiceAmount:          amountInPaisa,
    AutoCancelDurationInMinutes: 2
  };

  console.log(`UploadBilledTransaction txn ${txn.id} → "${store.store_name}" isPartial=${isPartial}`);

  axios.post(`${getPineApiUrl(store)}/V1/UploadBilledTransaction`, pinePayload, { timeout: 30000 })
    .then(async (pineResponse) => {
      console.log(`UploadBilledTransaction txn ${txn.id} FULL RESPONSE:`, JSON.stringify(pineResponse.data));
      const responseCode = parseInt(pineResponse.data.ResponseCode);
      const ptrid        = pineResponse.data.PlutusTransactionReferenceID || null;
      const ptridNum     = ptrid ? parseInt(ptrid) : null;
      const newStatus    = (responseCode === 0 && ptridNum && ptridNum > 0) ? 'PUSHED_TO_TERMINAL' : 'FAILED';
      console.log(`UploadBilledTransaction txn ${txn.id}: code=${responseCode} PTRID=${ptrid} → ${newStatus}`);
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
          `${getPineApiUrl(store)}/V1/GetCloudBasedTxnStatus`,
          { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: store.security_token || process.env.PINE_LABS_SECURITY_TOKEN,
            ClientID: parseInt(store.pine_client_id), StoreID: parseInt(store.pine_store_id),
            PlutusTransactionReferenceID: ptrid },
          { timeout: 15000 }
        );

        const responseCode    = parseInt(pineResponse.data.ResponseCode);
        const responseMessage = pineResponse.data.ResponseMessage || '';
        const { newStatus }   = getPineStatusResult(responseCode, responseMessage);
        console.log(`Poller: txn ${txn.id} PTRID=${ptrid}: code=${responseCode} msg="${responseMessage}"${newStatus ? ` → ${newStatus}` : ' (no change)'}`);

        if (newStatus && newStatus !== txn.status) {
          const { utr, paymentMode } = extractPineTransactionData(pineResponse.data.TransactionData);
          await supabase.from('transactions').update({
            status: newStatus,
            ...(utr         ? { utr }          : {}),
            ...(paymentMode ? { payment_mode: paymentMode } : {})
          }).eq('id', txn.id);
          if (newStatus === 'PAID') await handlePaymentCompletion(txn, { utr, paymentSource: 'pine' });
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
    const token = await getShopifyToken();
    const statusFilter = req.query.status || 'open';
    const allOrders = [];
    let pageInfo = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: 250,
        status: statusFilter,
        order: 'created_at desc'
      });
      if (pageInfo) params.set('page_info', pageInfo);

      const url = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json?${params}`;
      const response = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token }, timeout: 30000 });

      allOrders.push(...response.data.draft_orders);

      const linkHeader = response.headers['link'] || '';
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      } else {
        hasMore = false;
      }
    }

    return res.json({ draft_orders: allOrders });
  } catch (err) {
    return res.status(err.response?.status || 500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId, terminalTag,
    isPartial = false, totalAmountInRupees = null, customerName = '' } = req.body;
  if (!draftOrderId || !draftOrderName || !amountInRupees) {
    return res.status(400).json({ success: false, error: 'Missing: draftOrderId, draftOrderName, amountInRupees' });
  }
  try {
    const result = await pushDraftOrderToTerminal({
      draftOrderId, draftOrderName, amountInRupees,
      shopifyLocationId: locationId || null, terminalTag: terminalTag || null,
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

    // Run recalculation on every draft creation to lock gold rate as line item properties
    try {
      const token = await getShopifyToken();
      await recalculatePricing({
        draftOrderId:    draft.id,
        shopifyToken:    token,
        shopifyStoreUrl: process.env.SHOPIFY_STORE_URL
      });
      console.log(`Draft created: gold rate locked for ${draftOrderName}`);
    } catch (recalcErr) {
      console.error(`Draft created: recalculation failed for ${draftOrderName}:`, recalcErr.message);
    }

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
      `${getPineApiUrl(store)}/V1/GetCloudBasedTxnStatus`,
      { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: store.security_token || process.env.PINE_LABS_SECURITY_TOKEN,
        ClientID: parseInt(store.pine_client_id), StoreID: parseInt(store.pine_store_id),
        PlutusTransactionReferenceID: ptridNum },
      { timeout: 15000 }
    );
    const pineResponseCode              = parseInt(pineStatusResponse.data.ResponseCode);
    const pineMessage                   = pineStatusResponse.data.ResponseMessage || '';
    const { newStatus, cashierMessage } = getPineStatusResult(pineResponseCode, pineMessage);
    if (newStatus && newStatus !== transaction.status) {
      const { utr, paymentMode } = extractPineTransactionData(pineStatusResponse.data.TransactionData);
      await supabase.from('transactions').update({
        status: newStatus,
        ...(utr         ? { utr }          : {}),
        ...(paymentMode ? { payment_mode: paymentMode } : {})
      }).eq('id', transactionId);
      if (newStatus === 'PAID') await handlePaymentCompletion(transaction, { utr, paymentSource: 'pine' });
    }
    return res.json({ success: true, status: newStatus || transaction.status, message: cashierMessage,
      calledPine: true, pineResponseCode, pineResponseMessage: pineMessage,
      transactionId: transaction.id, pineRefId: transaction.pine_ref_id });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not reach Pine Labs.', detail: error.message });
  }
});

app.post('/api/cancel-transaction', async (req, res) => {
  console.log('Cancel request received. Body:', JSON.stringify(req.body));
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId required' });
  try {
    const { data: transaction, error: txnError } = await supabase.from('transactions').select('*').eq('id', transactionId).single();
    console.log(`Cancel txn ${transactionId}: status=${transaction?.status} pine_ref_id=${transaction?.pine_ref_id}`);
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
        `${getPineApiUrl(store)}/V1/CancelTransaction`,
        { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: store.security_token || process.env.PINE_LABS_SECURITY_TOKEN,
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
    const utr         = data['RRN'] || null;
    await supabase.from('transactions').update({
      status: newStatus, pine_ref_id: ptrid?.toString() || transaction.pine_ref_id, payment_mode: paymentMode,
      ...(utr ? { utr } : {})
    }).eq('id', transaction.id);
    console.log(`✅ PostBack: txn ${transaction.id} → ${newStatus}`);
    if (newStatus === 'PAID') await handlePaymentCompletion(transaction, { utr, paymentSource: 'pine', paymentModeOverride: paymentMode });
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

// ─────────────────────────────────────────
// Pricing Engine — helpers
// ─────────────────────────────────────────

async function removeTagFromDraft(draftOrderId, tagToRemove) {
  try {
    const token = await getShopifyToken();
    const { data: draftData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const existingTags = draftData.draft_order.tags || '';
    const tagList = existingTags.split(',').map(t => t.trim());
    if (!tagList.some(t => t.toLowerCase() === tagToRemove.toLowerCase())) return;
    const newTags = tagList.filter(t => t && t.toLowerCase() !== tagToRemove.toLowerCase()).join(', ');
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { draft_order: { id: draftOrderId, tags: newTags } },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`✅ Tag "${tagToRemove}" removed from draft ${draftOrderId}`);
  } catch (err) {
    console.error(`❌ removeTagFromDraft failed for draft ${draftOrderId}:`, err.response?.data || err.message);
  }
}

// Tag format: send-link-AMOUNT  e.g. send-link-5000 or send-link-5000.50
// Phone + name + email come from draft.customer; total from draft.total_price
async function handleSendLinkTag(draft) {
  const tags = (draft.tags || '').split(',').map(t => t.trim());
  const sendLinkTag = tags.find(t => /^send-link-(\d+(?:\.\d+)?)$/i.test(t));
  if (!sendLinkTag) return;

  const amount = parseFloat(sendLinkTag.replace(/^send-link-/i, ''));
  if (!amount || amount <= 0) {
    console.warn(`Draft ${draft.id}: invalid send-link tag "${sendLinkTag}", removing`);
    await removeTagFromDraft(draft.id, sendLinkTag);
    return;
  }

  const customer = draft.customer || {};
  const rawPhone = customer.phone || draft.billing_address?.phone || draft.shipping_address?.phone || '';
  const customerPhone = rawPhone.replace(/\D/g, '').slice(-10);
  if (!customerPhone || customerPhone.length < 10) {
    console.warn(`Draft ${draft.id}: send-link tag but no valid customer phone, removing tag`);
    await removeTagFromDraft(draft.id, sendLinkTag);
    return;
  }

  const customerName  = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
  const customerEmail = customer.email || null;
  const draftOrderName = draft.name || draft.id.toString();
  const totalAmount    = parseFloat(draft.total_price) || null;

  const { data: existingDeposit } = await supabase
    .from('store_deposits').select('payment_status')
    .eq('draft_order_id', draft.id.toString()).maybeSingle();
  const installmentType = existingDeposit?.payment_status === 'partial' ? 'final' : 'advance';

  const { gokwikLinkId, shortUrl, expiresAt } = await createGokwikLink({
    draftOrderId: draft.id, amount, customerPhone, customerName, customerEmail
  });

  await supabase.from('payment_links').insert({
    draft_order_id:   draft.id.toString(),
    draft_order_name: draftOrderName,
    gokwik_link_id:   gokwikLinkId,
    short_url:        shortUrl,
    amount,
    total_amount:     totalAmount,
    installment_type: installmentType,
    status:           'created',
    customer_phone:   customerPhone,
    expires_at:       expiresAt
  });

  const smsMessage = `Your Timanti payment link: ${shortUrl} — Amount: Rs${amount}. Valid 7 days.`;
  await sendSMS(customerPhone, smsMessage);

  if (customerEmail) {
    await sendEmail({
      to:      customerEmail,
      subject: `Timanti Payment Link — Rs${amount}`,
      html:    `<p>Please use the link below to complete your payment of Rs${amount}:</p><p><a href="${shortUrl}">${shortUrl}</a></p><p>This link is valid for 7 days.</p>`
    });
  }

  console.log(`✅ GoKwik link created via tag for draft ${draft.id}: ${gokwikLinkId} (${installmentType})`);
  await removeTagFromDraft(draft.id, sendLinkTag);
}

// Tag: recalculate-price
// Reads jewel metafields (net_wt, gross_wt, diamond_cts, diamond_pcs, jewel_code) from draft,
// computes weight delta against _gold_rate from line item properties,
// reprices if delta > 5%, always stores _jewel_data hidden property.
// Removes tag atomically in the same PUT as any line item update (loop prevention).
async function handleRecalculatePriceTag(draft) {
  const tags = (draft.tags || '').split(',').map(t => t.trim());
  if (!tags.some(t => t.toLowerCase() === 'recalculate-price')) return;

  const draftOrderId = draft.id;
  const token = await getShopifyToken();
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const tagsWithoutRecalc = tags.filter(t => t && t.toLowerCase() !== 'recalculate-price').join(', ');

  // Fetch jewel metafields set manually by staff
  const { data: mfData } = await axios.get(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const mfMap = {};
  for (const mf of (mfData.metafields || [])) {
    if (mf.namespace === 'custom') mfMap[mf.key] = mf.value;
  }

  const newNetWt   = parseFloat(mfMap.net_wt);
  const newGrossWt = parseFloat(mfMap.gross_wt) || 0;
  const diamondCts = parseFloat(mfMap.diamond_cts) || 0;
  const diamondPcs = parseInt(mfMap.diamond_pcs)   || 0;
  const jewel_code = mfMap.jewel_code || '';

  if (!newNetWt) {
    console.warn(`Draft ${draftOrderId}: recalculate-price tag but net_wt metafield missing or zero`);
    await removeTagFromDraft(draftOrderId, 'recalculate-price');
    return;
  }

  // Find the priced product line item — identified by Gold property set by pricing engine
  const lineItem = (draft.line_items || []).find(item =>
    !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0) &&
    (item.properties || []).some(p => p.name === 'Gold')
  );

  if (!lineItem) {
    console.warn(`Draft ${draftOrderId}: no priced line item with Gold property, skipping`);
    await removeTagFromDraft(draftOrderId, 'recalculate-price');
    return;
  }

  const props = {};
  for (const p of (lineItem.properties || [])) props[p.name] = p.value;

  // _gold_rate on the line item is the rate locked at order creation time.
  // For drafts that predate this feature, bootstrap from variant once and lock it.
  let goldRate = parseFloat(props['_gold_rate']);
  let bootstrapGoldRate = false;

  if (!goldRate && lineItem.variant_id) {
    const { data: varMfData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/variants/${lineItem.variant_id}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const gRateMf = (varMfData.metafields || []).find(
      m => m.namespace === 'custom' && m.key === 'gold_rate'
    );
    if (gRateMf) {
      goldRate = parseFloat(gRateMf.value);
      bootstrapGoldRate = true;
      console.log(`Draft ${draftOrderId}: bootstrapping _gold_rate=${goldRate} from variant — will lock to line item`);
    }
  }

  const oldGold = parseFloat((props['Gold'] || '0').replace('Rs', '').trim());

  if (!goldRate || !oldGold) {
    console.warn(`Draft ${draftOrderId}: gold rate (${goldRate}) or Gold value (${oldGold}) missing — ensure variant has custom.gold_rate metafield`);
    await removeTagFromDraft(draftOrderId, 'recalculate-price');
    return;
  }

  const oldNetWt = oldGold / goldRate;
  const delta    = Math.abs(newNetWt - oldNetWt) / oldNetWt;

  if (delta <= 0.05) {
    // Below threshold: only remove tag — no line item changes, no jewel properties written
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { draft_order: { id: draftOrderId, tags: tagsWithoutRecalc } },
      { headers, timeout: 15000 }
    );
    console.log(`Draft ${draftOrderId}: delta=${(delta*100).toFixed(2)}% ≤ 5% — tag removed, no line item changes`);
    return;
  }

  // Above threshold: full reprice
  const newGoldValue  = newNetWt * goldRate;
  const deltaGold     = newGoldValue - oldGold;
  const oldGrossValue = parseFloat((props['Gross Value'] || lineItem.price).toString().replace('Rs', '').trim());

  // Prefer live applied_discount; fall back to Discount Applied property (if discount was already absorbed by a prior reprice)
  let discountAmount = parseFloat(draft.applied_discount?.amount || 0);
  if (!discountAmount) {
    const discProp = (lineItem.properties || []).find(p => p.name === 'Discount Applied');
    if (discProp) discountAmount = parseFloat((discProp.value || '0').replace('Rs', '').trim()) || 0;
  }

  const newGrossValue   = oldGrossValue + deltaGold;
  const newFinalValue   = newGrossValue - discountAmount;
  const newTaxableValue = newFinalValue / 1.03;
  const newGst          = newTaxableValue * 0.03;
  const newPrice        = parseFloat(newFinalValue.toFixed(2));

  const metal    = (lineItem.variant_title || '').split(' / ')[0] || '';
  const category = lineItem.title || '';

  const jewel_data = JSON.stringify({
    jewel_code,
    gross_wt:         newGrossWt,
    net_wt:           newNetWt,
    diamond_cts:      diamondCts,
    diamond_pcs:      diamondPcs,
    metal,
    category,
    gold_rate_locked: goldRate,
    weight_delta_pct: parseFloat((delta * 100).toFixed(2)),
    repriced:         true
  });

  const repricedProps = {
    'Gold':             `Rs${newGoldValue.toFixed(2)}`,
    'Gross Value':      `Rs${newGrossValue.toFixed(2)}`,
    'Taxable Value':    `Rs${newTaxableValue.toFixed(2)}`,
    'GST':              `Rs${newGst.toFixed(2)}`,
    'Discount Applied': `Rs${discountAmount.toFixed(2)}`,
    '_gross_wt':        newGrossWt.toFixed(3),
    '_net_wt':          newNetWt.toFixed(3),
    '_diamond_cts':     diamondCts.toFixed(2),
    '_diamond_pcs':     diamondPcs.toString(),
    '_jewel_code':      jewel_code,
    '_jewel_data':      jewel_data
  };
  if (bootstrapGoldRate) repricedProps['_gold_rate'] = goldRate.toString();

  const updatedProperties = (lineItem.properties || []).filter(p => !(p.name in repricedProps));
  for (const [name, value] of Object.entries(repricedProps)) {
    updatedProperties.push({ name, value });
  }

  // applied_discount: null absorbs the discount into the line item price, preventing
  // the shopify-draft-updated webhook from re-running recalculatePricing and overwriting our repriced values.
  await axios.put(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    {
      draft_order: {
        id:               draftOrderId,
        tags:             tagsWithoutRecalc,
        applied_discount: null,
        line_items: draft.line_items.map(item => {
          const base = {
            id:         item.id,
            variant_id: item.variant_id,
            quantity:   item.quantity,
            price:      item.price,
            properties: item.properties || []
          };
          if (item.id === lineItem.id) {
            return { ...base, price: newPrice.toFixed(2), properties: updatedProperties };
          }
          return base;
        })
      }
    },
    { headers, timeout: 15000 }
  );
  console.log(`✅ Repriced draft ${draftOrderId}: delta=${(delta*100).toFixed(2)}%, new gold=Rs${newGoldValue.toFixed(2)}, new final=Rs${newFinalValue.toFixed(2)}, discount absorbed`);
}

// ─────────────────────────────────────────
// Pricing Engine — routes
// ─────────────────────────────────────────

app.post('/api/shopify-draft-updated', async (req, res) => {
  res.status(200).send('OK');
  try {
    const draft = req.body;
    if (!draft?.id) return;

    // Tag-based handlers (fire independently, each removes its own tag)
    await handleSendLinkTag(draft);
    await handleRecalculatePriceTag(draft);

    // Existing: discount-driven recalculation
    const discountObj = draft.applied_discount;
    let discountAmount = 0;
    if (discountObj) {
      const rawAmount = parseFloat(discountObj.amount || 0);
      const rawValue  = parseFloat(discountObj.value  || 0);
      discountAmount  = rawAmount > 0 ? rawAmount : rawValue;
    }

    if (!discountAmount || discountAmount <= 0) {
      console.log(`Draft updated webhook: #${draft.name} — no discount, skipping`);
      return;
    }

    // Skip if properties already reflect this exact discount (loop prevention)
    const productItems = (draft.line_items || []).filter(
      item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
    );
    const existingRecalcDiscount = productItems.reduce((sum, item) => {
      const prop = (item.properties || []).find(p => p.name === 'Discount Applied');
      return sum + (prop ? parseFloat((prop.value || '0').replace('Rs', '')) : 0);
    }, 0);
    if (Math.abs(existingRecalcDiscount - discountAmount) < 0.01) {
      console.log(`Draft updated webhook: #${draft.name} — already recalculated for Rs${discountAmount}, skipping`);
      return;
    }

    console.log(`Draft updated webhook: #${draft.name} — discount Rs${discountAmount}, triggering recalculation`);
    const token = await getShopifyToken();
    const pricing = await recalculatePricing({
      draftOrderId:    draft.id,
      shopifyToken:    token,
      shopifyStoreUrl: process.env.SHOPIFY_STORE_URL
    });
    console.log(`Draft updated webhook: #${draft.name} recalculated — finalTotal Rs${pricing.finalTotal}`);
  } catch (err) {
    console.error('Draft updated webhook error:', err.message);
  }
});

app.post('/pricing/recalculate', async (req, res) => {
  const { draftOrderId } = req.body;
  if (!draftOrderId) {
    return res.status(400).json({ success: false, error: 'draftOrderId required' });
  }
  try {
    const token  = await getShopifyToken();
    const pricing = await recalculatePricing({
      draftOrderId,
      shopifyToken:    token,
      shopifyStoreUrl: process.env.SHOPIFY_STORE_URL
    });
    return res.json({ success: true, pricing });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger for jewel weight repricing (same logic as recalculate-price tag).
// Requires jewel metafields (net_wt, gross_wt, diamond_cts, diamond_pcs, jewel_code) already set on the draft.
app.post('/api/recalculate-price', async (req, res) => {
  const { draftOrderId } = req.body;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    const token = await getShopifyToken();
    const { data: draftData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    // Inject the tag so handleRecalculatePriceTag processes it
    const draft = { ...draftData.draft_order };
    const existingTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!existingTags.some(t => t.toLowerCase() === 'recalculate-price')) {
      draft.tags = [...existingTags, 'recalculate-price'].join(', ');
    }
    await handleRecalculatePriceTag(draft);
    return res.json({ success: true, draftOrderId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, detail: err.response?.data });
  }
});

// ─────────────────────────────────────────
// GoKwik Payment Links
// ─────────────────────────────────────────

app.post('/api/generate-payment-link', async (req, res) => {
  const { draftOrderId, draftOrderName, amount, totalAmount, customerPhone, customerName, customerEmail } = req.body;
  if (!draftOrderId || !amount || !customerPhone) {
    return res.status(400).json({ success: false, error: 'Missing: draftOrderId, amount, customerPhone' });
  }
  try {
    const { data: existingDeposit } = await supabase
      .from('store_deposits').select('payment_status')
      .eq('draft_order_id', draftOrderId.toString()).maybeSingle();
    const installmentType = existingDeposit?.payment_status === 'partial' ? 'final' : 'advance';

    const { gokwikLinkId, shortUrl, expiresAt } = await createGokwikLink({
      draftOrderId, amount, customerPhone, customerName, customerEmail
    });

    await supabase.from('payment_links').insert({
      draft_order_id:   draftOrderId.toString(),
      draft_order_name: draftOrderName || draftOrderId.toString(),
      gokwik_link_id:   gokwikLinkId,
      short_url:        shortUrl,
      amount,
      total_amount:     totalAmount || null,
      installment_type: installmentType,
      status:           'created',
      customer_phone:   customerPhone,
      expires_at:       expiresAt
    });

    const smsMessage = `Your Timanti payment link: ${shortUrl} — Amount: Rs${amount}. Valid 7 days.`;
    await sendSMS(customerPhone, smsMessage);

    if (customerEmail) {
      await sendEmail({
        to:      customerEmail,
        subject: `Timanti Payment Link — Rs${amount}`,
        html:    `<p>Please use the link below to complete your payment of Rs${amount}:</p><p><a href="${shortUrl}">${shortUrl}</a></p><p>This link is valid for 7 days.</p>`
      });
    }

    console.log(`✅ GoKwik link created for draft ${draftOrderId}: ${gokwikLinkId} (${installmentType})`);
    return res.json({ success: true, shortUrl, gokwikLinkId, installmentType });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Generate payment link error:', detail);
    return res.status(500).json({ success: false, error: err.message, detail });
  }
});

app.post('/api/cancel-payment-link', async (req, res) => {
  const { gokwikLinkId } = req.body;
  if (!gokwikLinkId) return res.status(400).json({ success: false, error: 'gokwikLinkId required' });
  try {
    const result = await cancelGokwikLink(gokwikLinkId);
    await supabase.from('payment_links').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('gokwik_link_id', gokwikLinkId);
    return res.json({ success: true, ...result });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Cancel payment link error:', detail);
    return res.status(500).json({ success: false, error: err.message, detail });
  }
});

// Cancel by draft order ID — looks up the active link so staff don't need the GoKwik link ID
app.post('/api/cancel-active-link', async (req, res) => {
  const { draftOrderId } = req.body;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    const { data: link } = await supabase
      .from('payment_links').select('gokwik_link_id, amount, installment_type')
      .eq('draft_order_id', draftOrderId.toString())
      .eq('status', 'created')
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (!link) return res.status(404).json({ success: false, error: 'No active link found for this draft' });
    const result = await cancelGokwikLink(link.gokwik_link_id);
    await supabase.from('payment_links').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('gokwik_link_id', link.gokwik_link_id);
    return res.json({ success: true, cancelledLinkId: link.gokwik_link_id, ...result });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Cancel active link error:', detail);
    return res.status(500).json({ success: false, error: err.message, detail });
  }
});

app.post('/api/gokwik-webhook', async (req, res) => {
  res.status(200).json({ success: true });
  try {
    const { status, gokwik_oid, transaction_id, gateway_reference_id } = req.body;
    // merchant_reference_id is "{draftOrderId}-{timestamp}" — strip the suffix
    const draftOrderId = gokwik_oid ? gokwik_oid.toString().replace(/-\d+$/, '') : null;
    console.log(`GoKwik webhook: status=${status} oid=${gokwik_oid} draft=${draftOrderId} txn=${transaction_id}`);

    if (status === 'success') {
      const { data: link } = await supabase
        .from('payment_links').select('*')
        .eq('draft_order_id', draftOrderId)
        .eq('status', 'created')
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle();

      if (!link) { console.error(`GoKwik webhook: no active link for draft ${draftOrderId}`); return; }

      await supabase.from('payment_links').update({
        status: 'success', gokwik_txn_id: transaction_id,
        utr: gateway_reference_id, updated_at: new Date().toISOString()
      }).eq('gokwik_link_id', link.gokwik_link_id);

      await handlePaymentCompletion({
        shopify_draft_id:   draftOrderId,
        draft_order_name:   link.draft_order_name || gokwik_oid.toString(),
        amount_paisa:       Math.round(link.amount * 100),
        total_amount_paisa: link.total_amount ? Math.round(link.total_amount * 100) : null,
        is_partial:         true,
        pine_ref_id:        null,
        id:                 `gk-${transaction_id}`
      }, { utr: gateway_reference_id, paymentSource: 'gokwik', paymentModeOverride: 'gokwik_link' });
    }

    if (status === 'cancelled' || status === 'expired') {
      await supabase.from('payment_links').update({ status, updated_at: new Date().toISOString() })
        .eq('draft_order_id', draftOrderId).eq('status', 'created');
    }
  } catch (err) {
    console.error('GoKwik webhook error:', err.message);
  }
});

app.post('/api/log-cash-payment', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, totalAmountInRupees, customerName, notes } = req.body;
  if (!draftOrderId || !amountInRupees) {
    return res.status(400).json({ success: false, error: 'Missing: draftOrderId, amountInRupees' });
  }
  try {
    await handlePaymentCompletion({
      shopify_draft_id:   draftOrderId.toString(),
      draft_order_name:   draftOrderName || draftOrderId.toString(),
      amount_paisa:       Math.round(parseFloat(amountInRupees) * 100),
      total_amount_paisa: totalAmountInRupees ? Math.round(parseFloat(totalAmountInRupees) * 100) : null,
      is_partial:         true,
      pine_ref_id:        null,
      customer_name:      customerName || '',
      id:                 `cash-${Date.now()}`
    }, { utr: null, paymentSource: 'cash', paymentModeOverride: 'cash' });

    return res.json({ success: true, message: 'Cash payment recorded.' });
  } catch (err) {
    console.error('Log cash payment error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/send-draft-invoice', async (req, res) => {
  const { draftOrderId } = req.body;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    await sendDraftOrderInvoice(draftOrderId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/convert-to-order', async (req, res) => {
  const { draftOrderId } = req.body;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    const orderId = await completeShopifyOrder(draftOrderId, null);
    if (!orderId) return res.status(500).json({ success: false, error: 'Shopify conversion failed — check logs' });
    return res.json({ success: true, orderId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/draft-order-metafields', async (req, res) => {
  const { draftOrderId } = req.query;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    const token = await getShopifyToken();
    const { data } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    return res.json({ success: true, metafields: data.metafields });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/draft-order-metafields', async (req, res) => {
  const { draftOrderId, fields } = req.body;
  if (!draftOrderId || !fields || typeof fields !== 'object') {
    return res.status(400).json({ success: false, error: 'draftOrderId and fields object required' });
  }
  const blankKeys = Object.entries(fields)
    .filter(([, v]) => v === null || v === undefined || String(v).trim() === '')
    .map(([k]) => k);
  if (blankKeys.length) {
    return res.status(400).json({ success: false, error: `Blank values for: ${blankKeys.join(', ')} — did 8a run first?` });
  }
  try {
    await updateDraftOrderMetafields(draftOrderId, fields);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/draft-order-line-items', async (req, res) => {
  const { draftOrderId } = req.query;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    const token = await getShopifyToken();
    const { data } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const { line_items, tags, name } = data.draft_order;

    // For product line items without a locked _gold_rate, inject the current variant rate
    // so callers (e.g. 8a) can compute thresholds. handleRecalculatePriceTag will lock it on first reprice.
    const enriched = await Promise.all(line_items.map(async (item) => {
      const hasLock = (item.properties || []).some(p => p.name === '_gold_rate');
      if (!hasLock && item.variant_id && (item.properties || []).some(p => p.name === 'Gold')) {
        try {
          const { data: varMf } = await axios.get(
            `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/variants/${item.variant_id}/metafields.json`,
            { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
          );
          const gRateMf = (varMf.metafields || []).find(
            m => m.namespace === 'custom' && m.key === 'gold_rate'
          );
          if (gRateMf) {
            return {
              ...item,
              properties: [...(item.properties || []), { name: '_gold_rate', value: gRateMf.value, _source: 'variant_bootstrap' }]
            };
          }
        } catch (_) {}
      }
      return item;
    }));

    return res.json({ success: true, draftOrderId, name, tags, line_items: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/payment-links', async (req, res) => {
  const { draftOrderId } = req.query;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  const { data, error } = await supabase
    .from('payment_links').select('*')
    .eq('draft_order_id', draftOrderId.toString())
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, links: data || [] });
});

// ─────────────────────────────────────────
// PO Operations
// ─────────────────────────────────────────

const PO_DEPS = () => ({ supabase, getShopifyToken, shopifyStoreUrl: process.env.SHOPIFY_STORE_URL });

app.post('/api/po-webhook', (req, res) => handlePoWebhook(req, res, PO_DEPS()));
app.get('/api/po-action',   (req, res) => handlePoAction(req, res, PO_DEPS()));

// ─────────────────────────────────────────
// Price Update Diagnostics
// ─────────────────────────────────────────

app.get('/api/price-update-diag', (req, res) => {
  const { execFile } = require('child_process');
  const script = [
    'import sys, os',
    'print("python:", sys.version)',
    'import requests; print("requests: OK")',
    'import resend; print("resend: OK")',
    'from pathlib import Path',
    'print("orchestrator:", Path("/app/price_update/orchestrator.py").exists())',
    'print("snapshot:", Path("/app/price_update/shopify_snapshot.py").exists())',
    'print("importer:", Path("/app/price_update/import_from_preview.mjs").exists())',
    'print("SUPABASE_KEY set:", bool(os.environ.get("SUPABASE_SERVICE_KEY")))',
    'print("RESEND_API_KEY set:", bool(os.environ.get("RESEND_API_KEY")))',
    'print("FROM_EMAIL set:", bool(os.environ.get("FROM_EMAIL")))',
  ].join('\n');

  execFile('python3', ['-c', script], { timeout: 10000 }, (err, stdout, stderr) => {
    res.json({
      ok:     !err,
      stdout: stdout || '',
      stderr: stderr || '',
      error:  err ? err.message : null,
    });
  });
});

// ─────────────────────────────────────────
// Price Update Trigger
// ─────────────────────────────────────────

let _priceUpdateRunning = false;

app.post('/api/trigger-price-update', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!process.env.PRICE_UPDATE_WEBHOOK_SECRET || secret !== process.env.PRICE_UPDATE_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (_priceUpdateRunning) {
    console.warn('Price update already running — duplicate trigger ignored');
    return res.status(409).json({ success: false, error: 'A price update is already running. Wait for it to finish.' });
  }

  const pure = parseFloat(req.body.pure_rate);
  if (isNaN(pure) || pure < 1000 || pure > 200000) {
    return res.status(400).json({ success: false, error: 'pure_rate must be between 1000 and 200000' });
  }

  const setAt   = new Date().toISOString();
  const payload = JSON.stringify({ pure, set_at: setAt });

  const { error: dbErr } = await supabase.from('config').upsert({
    key:        'gold_rate',
    value:      payload,
    updated_at: setAt,
  });

  if (dbErr) {
    console.error('Price update trigger: Supabase write failed:', dbErr.message);
    return res.status(500).json({ success: false, error: 'Failed to save gold rate to Supabase' });
  }

  const { spawn } = require('child_process');
  const testGati = (req.body.test_gati || '').toString().trim().toUpperCase();
  const args     = ['/app/price_update/orchestrator.py'];
  if (testGati) args.push('--test', testGati);

  _priceUpdateRunning = true;
  const proc = spawn('python3', args, {
    detached: false,
    stdio:    ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => console.log(`[price-update] ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`[price-update ERR] ${d.toString().trim()}`));
  proc.on('close', code => {
    _priceUpdateRunning = false;
    console.log(`[price-update] exited with code ${code}`);
  });

  const rate18k = (pure * 0.771).toFixed(2);
  const rate14k = (pure * 0.604).toFixed(2);
  const mode    = testGati ? `TEST (${testGati})` : 'FULL RUN';
  console.log(`Price update triggered [${mode}] — pure Rs${pure}/g | 18K Rs${rate18k} | 14K Rs${rate14k} | PID ${proc.pid}`);

  return res.json({
    success:   true,
    message:   'Gold rate saved. Price update started — results emailed when complete.',
    pure_rate: pure,
    rate_18k:  parseFloat(rate18k),
    rate_14k:  parseFloat(rate14k),
    set_at:    setAt,
    mode:      testGati ? `test:${testGati}` : 'full',
  });
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`\n🚀 Timanti Middleware on port ${PORT}`);
  console.log(`⚙️  AUTO_PUSH=${AUTO_PUSH_TO_TERMINAL} | AUTO_CONVERT=${AUTO_CONVERT_DRAFT_TO_ORDER} | AUTO_INVOICE=${AUTO_SEND_DRAFT_INVOICE} | PINE_MODE=${process.env.PINE_PAYMENT_MODE || 'integer'}`);
  console.log('  GET  /api/test-db');
  console.log('  GET  /api/draft-orders');
  console.log('  POST /api/push-to-terminal');
  console.log('  POST /api/shopify-draft-created');
  console.log('  POST /api/check-status');
  console.log('  POST /api/cancel-transaction');
  console.log('  POST /api/pine-postback');
  console.log('  POST /api/pine-webhook');
  console.log('  POST /pricing/recalculate');
  console.log('  POST /api/generate-payment-link');
  console.log('  POST /api/cancel-payment-link');
  console.log('  POST /api/gokwik-webhook');
  console.log('  POST /api/log-cash-payment');
  console.log('  POST /api/send-draft-invoice');
  console.log('  POST /api/convert-to-order');
  console.log('  POST /api/po-webhook');
  console.log('  GET  /api/po-action');
  console.log('  POST /api/trigger-price-update');
  await initShopifyToken();
  console.log('🔄 Background poller started (30s)');
  setInterval(pollActiveTxns, 30000);
});
