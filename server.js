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

// ─────────────────────────────────────────
// CONFIG FLAGS
//
// Flip on Fly.io without redeploying:
//   fly secrets set AUTO_PUSH_TO_TERMINAL=true   -a timanti-middleware
//   fly secrets set AUTO_PUSH_TO_TERMINAL=false  -a timanti-middleware
//   fly secrets set PINE_PAYMENT_MODE=integer    -a timanti-middleware
//   fly secrets set PINE_PAYMENT_MODE=pipe       -a timanti-middleware
// ─────────────────────────────────────────

const AUTO_PUSH_TO_TERMINAL = process.env.AUTO_PUSH_TO_TERMINAL === 'true';

function getPinePaymentMode() {
  const mode = (process.env.PINE_PAYMENT_MODE || 'integer').toLowerCase();
  if (mode === 'pipe') {
    return '1|8|10|11|4|20|21'; // Card|PhonePe|UPI|BharatQR|Wallets|BankEMI|AmazonPay
  }
  return 0; // integer 0 = all modes enabled on terminal (Pine docs)
}

// ─────────────────────────────────────────
// TERMINAL TAG PARSER
//
// Cashier adds a tag to the Shopify draft order to route it to the right terminal.
// Tag format: terminal:LOCATION_REF  (must match location_ref in stores table)
//
// Examples:
//   terminal:HSR-BLR-STORE  → routes to HSR Bangalore terminal
//   terminal:SHOP-LOCATION  → routes to Shop terminal
//
// If no tag is present → falls back to Shopify location ID → then first store.
// ─────────────────────────────────────────

function parseTerminalTag(tags) {
  if (!tags) return null;
  const tagList = typeof tags === 'string' ? tags.split(',') : tags;
  for (const tag of tagList) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.startsWith('terminal:')) {
      return trimmed.replace('terminal:', '').toUpperCase().trim();
    }
  }
  return null;
}

// ─────────────────────────────────────────
// LOCATION → STORE RESOLVER
//
// Priority order:
//   1. Tag  (terminal:LOCATION_REF)  — most explicit, cashier sets this
//   2. Shopify location_id           — only set if Shopify API creates the order
//   3. First store fallback          — safe for single-terminal setups
//
// To add a new location+terminal in future:
//   1. Add row to locations table with Shopify location ID
//   2. Add row to stores table with Pine credentials + location_ref matching step 1
//   No code changes needed.
// ─────────────────────────────────────────

async function resolveStoreForLocation(shopifyLocationId, terminalTag) {

  // PRIORITY 1: Tag wins — most explicit
  if (terminalTag) {
    const { data: store } = await supabase
      .from('stores')
      .select('*')
      .eq('location_ref', terminalTag)
      .single();
    if (store) {
      console.log(`Tag resolved: terminal:${terminalTag} → store "${store.store_name}"`);
      return store;
    }
    console.warn(`Tag "terminal:${terminalTag}" found but no matching store in DB — falling through`);
  }

  // PRIORITY 2: Shopify location ID
  if (shopifyLocationId) {
    const { data: location } = await supabase
      .from('locations')
      .select('location_id')
      .eq('shopify_location_id', shopifyLocationId.toString())
      .eq('is_active', true)
      .single();
    if (location?.location_id) {
      const { data: store } = await supabase
        .from('stores')
        .select('*')
        .eq('location_ref', location.location_id)
        .single();
      if (store) {
        console.log(`Location resolved: Shopify ${shopifyLocationId} → "${store.store_name}"`);
        return store;
      }
      console.warn(`Location ${location.location_id} found but no store linked to it`);
    }
  }

  // PRIORITY 3: Fallback — first store (single terminal)
  const { data: store } = await supabase
    .from('stores')
    .select('*')
    .order('id', { ascending: true })
    .limit(1)
    .single();

  if (store) {
    console.log(`Fallback: using first store "${store.store_name}" (no tag, no location match)`);
    return store;
  }

  console.error('No stores configured in DB at all');
  return null;
}

// ─────────────────────────────────────────
// SHOPIFY TOKEN MANAGER
//
// Tokens expire every 24h. Auto-refreshes using client credentials,
// persists to Supabase config table, serves fresh tokens to all API calls.
//
// One-time Fly.io setup:
//   fly secrets set SHOPIFY_CLIENT_ID=your_api_key        -a timanti-middleware
//   fly secrets set SHOPIFY_CLIENT_SECRET=your_secret_key -a timanti-middleware
//
// Find in: Shopify Admin → Apps → App and sales channel settings
//   → your custom app → API credentials tab
//
// Supabase config table (run once in SQL editor if not done):
//   CREATE TABLE IF NOT EXISTS config (
//     key TEXT PRIMARY KEY,
//     value TEXT NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT NOW()
//   );
// ─────────────────────────────────────────

let cachedToken = null;
let tokenFetchedAt = null;

async function getShopifyToken() {
  const now = Date.now();

  // Use in-memory cache if < 23h old
  if (cachedToken && tokenFetchedAt && (now - tokenFetchedAt) < 23 * 60 * 60 * 1000) {
    return cachedToken;
  }

  // Refresh using OAuth client credentials
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    try {
      const response = await axios.post(
        `${process.env.SHOPIFY_STORE_URL}/admin/oauth/access_token`,
        {
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          grant_type: 'client_credentials'
        },
        { timeout: 10000 }
      );
      const newToken = response.data.access_token;
      if (newToken) {
        cachedToken = newToken;
        tokenFetchedAt = now;
        await supabase
          .from('config')
          .upsert({ key: 'shopify_access_token', value: newToken, updated_at: new Date().toISOString() });
        console.log('✅ Shopify token refreshed and saved to Supabase');
        return newToken;
      }
    } catch (err) {
      console.error('⚠️  Shopify token refresh failed:', err.response?.data || err.message);
    }
  } else {
    console.warn('⚠️  SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not set — cannot auto-refresh');
  }

  // Fallback: last known good token from Supabase
  try {
    const { data } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'shopify_access_token')
      .single();
    if (data?.value) {
      cachedToken = data.value;
      tokenFetchedAt = now;
      console.log('✅ Shopify token loaded from Supabase');
      return data.value;
    }
  } catch (err) {
    console.warn('Supabase token load failed:', err.message);
  }

  // Last resort: env var
  if (process.env.SHOPIFY_ACCESS_TOKEN) {
    console.warn('⚠️  Using SHOPIFY_ACCESS_TOKEN env var — may be expired');
    return process.env.SHOPIFY_ACCESS_TOKEN;
  }

  throw new Error('No Shopify token available. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET on Fly.io');
}

async function initShopifyToken() {
  console.log('🔑 Initialising Shopify token...');
  try {
    await getShopifyToken();
    setInterval(async () => {
      cachedToken = null;
      tokenFetchedAt = null;
      await getShopifyToken();
    }, 23 * 60 * 60 * 1000);
  } catch (err) {
    console.error('❌ Shopify token init failed:', err.message);
  }
}

// ─────────────────────────────────────────
// Pine Labs Helpers
// ─────────────────────────────────────────

const PINE_PENDING_MESSAGES = ['TXN UPLOADED', 'TXN PENDING', 'IN PROGRESS'];

function getPineStatusResult(responseCode, responseMessage) {
  const msg = (responseMessage || '').toUpperCase().trim();
  if (responseCode === 0) {
    return { newStatus: 'PAID', cashierMessage: 'Payment confirmed!' };
  }
  const isPending = PINE_PENDING_MESSAGES.some(p => msg.includes(p));
  if (isPending) {
    return { newStatus: null, cashierMessage: `Terminal: ${responseMessage}` };
  }
  return { newStatus: 'FAILED', cashierMessage: `Payment failed: ${responseMessage}` };
}

function parsePineCSV(rawBody) {
  const data = {};
  rawBody.split(',').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex !== -1) {
      data[pair.substring(0, eqIndex).trim()] = pair.substring(eqIndex + 1).trim();
    }
  });
  return data;
}

// Pine permanently blacklists reused TransactionNumbers.
// Timestamp suffix makes every push unique.
function makePineTransactionNumber(draftOrderName) {
  return `${draftOrderName}-${Date.now()}`;
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
      {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    const finalOrderId = shopifyResponse.data.draft_order.order_id;
    console.log(`✅ Shopify order completed: ${finalOrderId}`);
    await supabase
      .from('transactions')
      .update({ final_shopify_order_id: finalOrderId.toString() })
      .eq('id', transactionDbId);
    return finalOrderId;
  } catch (error) {
    console.error('❌ Shopify complete error:', error.response?.data || error.message);
    return null;
  }
}

// ─────────────────────────────────────────
// Core Push Logic
// (shared by manual Retool button + auto-push webhook)
// ─────────────────────────────────────────

async function pushDraftOrderToTerminal({ draftOrderId, draftOrderName, amountInRupees, shopifyLocationId, terminalTag }) {
  const store = await resolveStoreForLocation(shopifyLocationId, terminalTag);
  if (!store) {
    return { success: false, httpStatus: 404, error: 'No Pine terminal configured. Add a row to the stores table.' };
  }

  // Block duplicate pushes
  const { data: existing } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('shopify_draft_id', draftOrderId.toString())
    .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
    .maybeSingle();

  if (existing) {
    return {
      success: false, httpStatus: 409,
      error: 'This draft order already has an active payment in progress. Cancel it first.',
      existingTransactionId: existing.id
    };
  }

  const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);
  const pineTransactionNumber = makePineTransactionNumber(draftOrderName);

  const { data: txn, error: txnError } = await supabase
    .from('transactions')
    .insert([{
      shopify_draft_id: draftOrderId.toString(),
      draft_order_name: draftOrderName,
      pine_transaction_number: pineTransactionNumber,
      location_id: store.id,
      amount_paisa: amountInPaisa,
      status: 'PENDING'
    }])
    .select()
    .single();

  if (txnError) {
    console.error('DB insert error:', txnError);
    return { success: false, httpStatus: 500, error: 'DB error', detail: txnError.message };
  }

  const paymentMode = getPinePaymentMode();
  const pinePayload = {
    TransactionNumber: pineTransactionNumber,
    SequenceNumber: 1,
    AllowedPaymentMode: paymentMode,
    Amount: amountInPaisa,
    UserID: 'System',
    MerchantID: parseInt(store.pine_merchant_id),
    SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
    ClientId: parseInt(store.pine_client_id),
    StoreId: parseInt(store.pine_store_id),
    TotalInvoiceAmount: amountInPaisa,
    AutoCancelDurationInMinutes: 10
  };

  console.log(`UploadBilledTransaction txn ${txn.id} → store "${store.store_name}" REQUEST (AllowedPaymentMode=${JSON.stringify(paymentMode)}):`, JSON.stringify(pinePayload));

  axios.post(
    `${process.env.PINE_LABS_API_URL}/V1/UploadBilledTransaction`,
    pinePayload,
    { timeout: 30000 }
  )
  .then(async (pineResponse) => {
    console.log(`UploadBilledTransaction txn ${txn.id} FULL RESPONSE:`, JSON.stringify(pineResponse.data));
    const responseCode = parseInt(pineResponse.data.ResponseCode);
    const ptrid = pineResponse.data.PlutusTransactionReferenceID || null;
    const ptridNum = ptrid ? parseInt(ptrid) : null;
    const newStatus = (responseCode === 0 && ptridNum && ptridNum > 0) ? 'PUSHED_TO_TERMINAL' : 'FAILED';
    console.log(`UploadBilledTransaction txn ${txn.id}: code=${responseCode} PTRID=${ptrid} → ${newStatus}`);
    await supabase
      .from('transactions')
      .update({ status: newStatus, pine_ref_id: ptrid ? ptrid.toString() : null })
      .eq('id', txn.id);
  })
  .catch(async (err) => {
    console.error(`UploadBilledTransaction timed out for txn ${txn.id}: ${err.message}`);
    await supabase
      .from('transactions')
      .update({ status: 'PINE_UNREACHABLE', pine_ref_id: null })
      .eq('id', txn.id);
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
      .from('transactions')
      .select('*, stores(*)')
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']);

    if (error) { console.error('Poller DB error:', error.message); return; }
    if (!activeTxns || activeTxns.length === 0) return;

    console.log(`Poller: checking ${activeTxns.length} active transaction(s)`);

    for (const txn of activeTxns) {
      try {
        if (!txn.pine_ref_id) {
          console.log(`Poller: txn ${txn.id} — no PTRID yet.`);
          continue;
        }
        const ptrid = parseInt(txn.pine_ref_id);
        if (ptrid <= 0) {
          await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', txn.id);
          continue;
        }
        const store = txn.stores;
        if (!store) { console.error(`Poller: no store config for txn ${txn.id}`); continue; }

        const pineResponse = await axios.post(
          `${process.env.PINE_LABS_API_URL}/V1/GetCloudBasedTxnStatus`,
          {
            MerchantID: parseInt(store.pine_merchant_id),
            SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
            ClientID: parseInt(store.pine_client_id),
            StoreID: parseInt(store.pine_store_id),
            PlutusTransactionReferenceID: ptrid
          },
          { timeout: 15000 }
        );

        const responseCode = parseInt(pineResponse.data.ResponseCode);
        const responseMessage = pineResponse.data.ResponseMessage || '';
        const { newStatus } = getPineStatusResult(responseCode, responseMessage);
        console.log(`Poller: txn ${txn.id} PTRID=${ptrid}: code=${responseCode} msg="${responseMessage}"${newStatus ? ` → ${newStatus}` : ' (no change)'}`);

        if (newStatus && newStatus !== txn.status) {
          await supabase.from('transactions').update({ status: newStatus }).eq('id', txn.id);
          if (newStatus === 'PAID' && txn.shopify_draft_id) {
            await completeShopifyOrder(txn.shopify_draft_id, txn.id);
          }
        }
      } catch (err) {
        console.error(`Poller: error on txn ${txn.id}:`, err.message);
      }
    }
  } finally {
    isPolling = false;
  }
}

// ─────────────────────────────────────────
// Routes
// ─────────────────────────────────────────

// ── Health / Debug ──

app.get('/api/test-db', async (req, res) => {
  const { data: stores } = await supabase.from('stores').select('*');
  const { data: locations } = await supabase.from('locations').select('*');
  return res.json({
    stores,
    locations,
    config: {
      autoPushToTerminal: AUTO_PUSH_TO_TERMINAL,
      pinePaymentMode: process.env.PINE_PAYMENT_MODE || 'integer',
      pinePaymentModeValue: getPinePaymentMode(),
      shopifyTokenCached: !!cachedToken,
      shopifyTokenAgeMinutes: tokenFetchedAt ? Math.round((Date.now() - tokenFetchedAt) / 60000) : null
    },
    env: {
      supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'MISSING',
      serviceKey: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
      pineUrl: process.env.PINE_LABS_API_URL ? 'SET' : 'MISSING',
      shopifyUrl: process.env.SHOPIFY_STORE_URL ? 'SET' : 'MISSING',
      shopifyClientId: process.env.SHOPIFY_CLIENT_ID ? 'SET' : 'MISSING ⚠️',
      shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET ? 'SET' : 'MISSING ⚠️'
    }
  });
});

// ── Draft Orders Proxy ──
//
// Retool: update getdraftorders query to:
//   URL:     https://timanti-middleware.fly.dev/api/draft-orders
//   Method:  GET
//   Params:  keep ?status=open
//   Headers: DELETE X-Shopify-Access-Token entirely
//
// Token handled automatically here — Retool never needs it again.

app.get('/api/draft-orders', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const queryString = new URLSearchParams(req.query).toString();
    const shopifyUrl = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json${queryString ? `?${queryString}` : ''}`;
    const response = await axios.get(shopifyUrl, {
      headers: { 'X-Shopify-Access-Token': token },
      timeout: 15000
    });
    return res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('Draft orders proxy error:', err.response?.data || err.message);
    return res.status(status).json({ success: false, error: err.response?.data || err.message });
  }
});

// ── Push to Terminal (manual — Retool button) ──
//
// locationId is optional — resolver handles fallback.
// When you have multiple stores, pass the locationId from the selected row.

app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;
  if (!draftOrderId || !draftOrderName || !amountInRupees) {
    return res.status(400).json({ success: false, error: 'Missing: draftOrderId, draftOrderName, amountInRupees' });
  }
  try {
    const result = await pushDraftOrderToTerminal({
      draftOrderId,
      draftOrderName,
      amountInRupees,
      shopifyLocationId: locationId || null,
      terminalTag: null  // manual push doesn't use tags — uses location or fallback
    });
    return res.status(result.httpStatus || 200).json(result);
  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── Shopify Draft Order Webhook (auto-push) ──
//
// Registered in Shopify Admin → Settings → Notifications → Webhooks:
//   Event:  Draft order creation
//   URL:    https://timanti-middleware.fly.dev/api/shopify-draft-created
//   Format: JSON
//
// Routing priority:
//   1. Tag on draft order: terminal:HSR-BLR-STORE or terminal:SHOP-LOCATION
//   2. Shopify location_id (if set via API)
//   3. First store fallback (single terminal)
//
// When AUTO_PUSH_TO_TERMINAL=false → logs only, no push. Cashier uses Retool.
// When AUTO_PUSH_TO_TERMINAL=true  → pushes immediately on draft creation.

app.post('/api/shopify-draft-created', async (req, res) => {
  res.status(200).send('OK'); // respond fast — Shopify times out at 5s

  try {
    const draft = req.body;
    if (!draft || !draft.id) { console.error('Shopify webhook: empty payload'); return; }

    const draftOrderId      = draft.id.toString();
    const draftOrderName    = draft.name || `#${draftOrderId}`;
    const amountInRupees    = draft.total_price;
    const shopifyLocationId = draft.location_id?.toString() || null;
    const terminalTag       = parseTerminalTag(draft.tags);

    console.log(`Shopify draft created: ${draftOrderName} ₹${amountInRupees} | shopifyLocation: ${shopifyLocationId || 'none'} | tag: ${terminalTag || 'none'}`);

    if (!AUTO_PUSH_TO_TERMINAL) {
      console.log(`Auto-push OFF — ${draftOrderName} received. Cashier pushes manually in Retool.`);
      return;
    }
    if (!amountInRupees || parseFloat(amountInRupees) <= 0) {
      console.error(`Auto-push: ${draftOrderName} zero amount — skipping.`);
      return;
    }

    const result = await pushDraftOrderToTerminal({
      draftOrderId,
      draftOrderName,
      amountInRupees,
      shopifyLocationId,
      terminalTag
    });
    console.log(`Auto-push result for ${draftOrderName}:`, JSON.stringify(result));

  } catch (err) {
    console.error('Shopify draft webhook error:', err.message);
  }
});

// ── Check Status ──────────────────────────

app.post('/api/check-status', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId required' });
  try {
    const { data: transaction, error: txnError } = await supabase
      .from('transactions').select('*').eq('id', transactionId).single();
    if (txnError || !transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });

    if (!transaction.pine_ref_id) {
      return res.json({
        success: true, status: transaction.status, calledPine: false, transactionId: transaction.id,
        message: transaction.status === 'PINE_UNREACHABLE'
          ? 'Upload timed out — cancel and push again.'
          : 'Transaction not yet sent to terminal.'
      });
    }

    const ptridNum = parseInt(transaction.pine_ref_id);
    if (ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', transactionId);
      return res.json({ success: true, status: 'FAILED', message: 'Pine rejected this transaction. Push again.', calledPine: false, transactionId: transaction.id });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores').select('*').eq('id', transaction.location_id).single();
    if (storeError || !store) return res.status(500).json({ success: false, error: 'Store config not found' });

    console.log(`CheckStatus txn ${transactionId}: calling Pine PTRID=${ptridNum} (DB: ${transaction.status})`);
    const pineStatusResponse = await axios.post(
      `${process.env.PINE_LABS_API_URL}/V1/GetCloudBasedTxnStatus`,
      {
        MerchantID: parseInt(store.pine_merchant_id),
        SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
        ClientID: parseInt(store.pine_client_id),
        StoreID: parseInt(store.pine_store_id),
        PlutusTransactionReferenceID: ptridNum
      },
      { timeout: 15000 }
    );

    const pineResponseCode = parseInt(pineStatusResponse.data.ResponseCode);
    const pineMessage = pineStatusResponse.data.ResponseMessage || '';
    console.log(`CheckStatus txn ${transactionId}: Pine code=${pineResponseCode} msg="${pineMessage}"`);
    const { newStatus, cashierMessage } = getPineStatusResult(pineResponseCode, pineMessage);

    if (newStatus && newStatus !== transaction.status) {
      await supabase.from('transactions').update({ status: newStatus }).eq('id', transactionId);
      if (newStatus === 'PAID' && transaction.shopify_draft_id) {
        await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      }
    }

    return res.json({
      success: true, status: newStatus || transaction.status, message: cashierMessage,
      calledPine: true, pineResponseCode, pineResponseMessage: pineMessage,
      transactionId: transaction.id, pineRefId: transaction.pine_ref_id
    });
  } catch (error) {
    console.error('Check-status error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Could not reach Pine Labs.', detail: error.message });
  }
});

// ── Cancel Transaction ────────────────────

app.post('/api/cancel-transaction', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId required' });
  try {
    const { data: transaction, error: txnError } = await supabase
      .from('transactions').select('*').eq('id', transactionId).single();
    if (txnError || !transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });

    if (['PAID', 'CANCELLED'].includes(transaction.status)) {
      return res.status(400).json({ success: false, error: `Cannot cancel — already ${transaction.status}.` });
    }
    if (!transaction.pine_ref_id) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({ success: true, message: 'Cancelled (Pine had not received it).', transactionId: transaction.id, calledPine: false });
    }

    const ptridNum = parseInt(transaction.pine_ref_id);
    if (ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({ success: true, message: 'Cancelled (Pine had rejected it).', transactionId: transaction.id, calledPine: false });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores').select('*').eq('id', transaction.location_id).single();
    if (storeError || !store) return res.status(500).json({ success: false, error: 'Store config not found' });

    const cancelPayload = {
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: parseInt(store.pine_client_id),
      StoreId: parseInt(store.pine_store_id),
      PlutusTransactionReferenceID: ptridNum,
      Amount: transaction.amount_paisa
    };

    console.log(`CancelTransaction txn ${transactionId} PTRID=${ptridNum} Amount=${transaction.amount_paisa}: calling Pine...`);

    let pineResponseCode, pineMessage;
    try {
      const pineResponse = await axios.post(
        `${process.env.PINE_LABS_API_URL}/V1/CancelTransaction`,
        cancelPayload,
        { timeout: 15000 }
      );
      pineResponseCode = parseInt(pineResponse.data.ResponseCode);
      pineMessage = pineResponse.data.ResponseMessage || '';
      console.log(`CancelTransaction txn ${transactionId}: Pine code=${pineResponseCode} msg="${pineMessage}"`);
    } catch (pineError) {
      const httpStatus = pineError.response?.status;
      const detail = JSON.stringify(pineError.response?.data) || pineError.message;
      console.error(`CancelTransaction txn ${transactionId}: Pine HTTP ${httpStatus} — ${detail}`);
      return res.status(502).json({
        success: false,
        error: `Pine cancel failed (HTTP ${httpStatus || 'N/A'}). NOT cancelled in DB.`,
        detail, transactionId: transaction.id
      });
    }

    if (pineResponseCode === 0) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({ success: true, message: 'Transaction cancelled.', transactionId: transaction.id, pineResponseCode, pineResponseMessage: pineMessage });
    } else {
      return res.status(400).json({ success: false, error: `Pine rejected: ${pineMessage}`, pineResponseCode, pineResponseMessage: pineMessage, transactionId: transaction.id });
    }
  } catch (error) {
    console.error('Cancel-transaction error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── Pine PostBack (CSV — production) ────────

app.post('/api/pine-postback', async (req, res) => {
  res.status(200).send('OK');
  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const data = parsePineCSV(rawBody);
    console.log('Pine PostBack received:', data);

    const responseCode = parseInt(data['ResponseCode']);
    const ptrid = data['PlutusTransactionReferenceID'];
    const pineTransactionNumber = data['TransactionNumber'];

    if (!ptrid && !pineTransactionNumber) { console.error('PostBack: missing PTRID and TransactionNumber'); return; }

    let txnRows;
    if (ptrid) {
      const result = await supabase.from('transactions').select('*')
        .eq('pine_ref_id', ptrid.toString())
        .order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) {
      const result = await supabase.from('transactions').select('*')
        .eq('pine_transaction_number', pineTransactionNumber)
        .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
        .order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) {
      console.error('PostBack: no matching transaction for PTRID:', ptrid, 'pineNum:', pineTransactionNumber);
      return;
    }

    const transaction = txnRows[0];
    const newStatus = responseCode === 0 ? 'PAID' : 'FAILED';
    const paymentMode = data['PaymenMode'] || data['PaymentMode'] || null;

    await supabase.from('transactions').update({
      status: newStatus,
      pine_ref_id: ptrid ? ptrid.toString() : transaction.pine_ref_id,
      payment_mode: paymentMode
    }).eq('id', transaction.id);

    console.log(`✅ PostBack: txn ${transaction.id} → ${newStatus}`);
    if (newStatus === 'PAID' && transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }
  } catch (error) {
    console.error('PostBack error:', error.message);
  }
});

// ── Pine Webhook (JSON — Postman testing) ──

app.post('/api/pine-webhook', async (req, res) => {
  const pineData = req.body;
  console.log('Pine webhook received:', JSON.stringify(pineData));
  res.status(200).send('OK');
  try {
    if (pineData.transactionId) {
      const { data: transaction, error } = await supabase.from('transactions').select('*')
        .eq('id', parseInt(pineData.transactionId)).single();
      if (error || !transaction) { console.error('Webhook: transaction not found:', pineData.transactionId); return; }
      await supabase.from('transactions').update({
        status: 'PAID',
        pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id || 'TEST'
      }).eq('id', transaction.id);
      console.log(`✅ Test webhook: txn ${transaction.id} → PAID`);
      if (transaction.shopify_draft_id) await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      return;
    }

    const responseCode = parseInt(pineData.ResponseCode);
    const draftOrderName = pineData.TransactionNumber;
    if (responseCode !== 0) {
      await supabase.from('transactions').update({ status: 'FAILED' })
        .eq('draft_order_name', draftOrderName)
        .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']);
      return;
    }

    const { data: txnRows } = await supabase.from('transactions').select('*')
      .eq('draft_order_name', draftOrderName)
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE'])
      .order('created_at', { ascending: false }).limit(1);
    if (!txnRows || txnRows.length === 0) { console.error('Webhook: no active transaction for:', draftOrderName); return; }

    const transaction = txnRows[0];
    await supabase.from('transactions').update({
      status: 'PAID',
      pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id
    }).eq('id', transaction.id);
    console.log(`✅ Webhook: txn ${transaction.id} → PAID`);
    if (transaction.shopify_draft_id) await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
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
  console.log('  GET  /api/draft-orders          ← Retool uses this now');
  console.log('  POST /api/push-to-terminal');
  console.log('  POST /api/shopify-draft-created ← Shopify webhook');
  console.log('  POST /api/check-status');
  console.log('  POST /api/cancel-transaction');
  console.log('  POST /api/pine-postback');
  console.log('  POST /api/pine-webhook');
  console.log('');
  await initShopifyToken();
  console.log('🔄 Background poller started (30s)');
  setInterval(pollActiveTxns, 30000);
});
