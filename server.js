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
// All of these can be changed on Fly.io without touching code:
//   fly secrets set AUTO_PUSH_TO_TERMINAL=true
//   fly secrets set AUTO_PUSH_TO_TERMINAL=false
//   fly secrets set PINE_PAYMENT_MODE=integer    ← sends AllowedPaymentMode: 0  (integer)
//   fly secrets set PINE_PAYMENT_MODE=pipe       ← sends AllowedPaymentMode: "1|8|10|11|4|20|21" (string)
//
// AUTO_PUSH_TO_TERMINAL:
//   true  → new Shopify draft orders auto-push to terminal immediately
//   false → cashier must manually click Push to POS in Retool (default)
//
// PINE_PAYMENT_MODE:
//   integer → AllowedPaymentMode sent as integer 0 (Pine docs say 0 = all modes)
//   pipe    → AllowedPaymentMode sent as pipe-separated string of explicit modes
//             Use this if integer 0 is restricting to card only
// ─────────────────────────────────────────

const AUTO_PUSH_TO_TERMINAL = process.env.AUTO_PUSH_TO_TERMINAL === 'true';

function getPinePaymentMode() {
  const mode = (process.env.PINE_PAYMENT_MODE || 'integer').toLowerCase();
  if (mode === 'pipe') {
    // Explicit modes: Card|PhonePe|UPI Sale|UPI BharatQR|Wallets|Bank EMI|Amazon Pay
    return '1|8|10|11|4|20|21';
  }
  // Default: integer 0 = all modes enabled on terminal per Pine docs
  return 0;
}

console.log(`\n⚙️  Config: AUTO_PUSH_TO_TERMINAL=${AUTO_PUSH_TO_TERMINAL}, PINE_PAYMENT_MODE=${process.env.PINE_PAYMENT_MODE || 'integer'}`);

// ─────────────────────────────────────────
// Pine Labs Response Handling
//
// Docs: ResponseCode 0 = success, non-zero = failure.
// Observed undocumented: code=1001 msg "TXN UPLOADED" = still uploading, keep polling.
// All other non-zero = FAILED.
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

// Pine permanently rejects reused TransactionNumbers even across separate
// attempts. Append timestamp so every push is unique to Pine.
function makePineTransactionNumber(draftOrderName) {
  return `${draftOrderName}-${Date.now()}`;
}

// ─────────────────────────────────────────
// Shopify Token Health Check (every 23h)
//
// Shopify private app tokens do NOT expire — but custom OAuth "online" tokens
// expire after 24h. This check catches that early and logs a clear warning.
//
// If you see "⚠️ SHOPIFY TOKEN INVALID" in Fly logs, you need to regenerate
// the access token in your Shopify custom app and update the Fly secret:
//   fly secrets set SHOPIFY_ACCESS_TOKEN=new_token_here
//
// Long-term fix: switch your Shopify app to "offline" token type so it
// never expires. Ask your Shopify partner to change the access mode.
// ─────────────────────────────────────────

async function validateShopifyToken() {
  try {
    const response = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/shop.json`,
      {
        headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
        timeout: 10000
      }
    );
    console.log(`✅ Shopify token valid — shop: ${response.data.shop?.name}`);
    return true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      console.error('⚠️  SHOPIFY TOKEN INVALID (401) — update SHOPIFY_ACCESS_TOKEN on Fly.io!');
      console.error('   Run: fly secrets set SHOPIFY_ACCESS_TOKEN=your_new_token -a timanti-middleware');
    } else {
      console.warn(`Shopify token check failed (HTTP ${status || 'N/A'}): ${err.message}`);
    }
    return false;
  }
}

function startTokenHealthCheck() {
  // Check immediately on startup, then every 23 hours
  validateShopifyToken();
  setInterval(validateShopifyToken, 23 * 60 * 60 * 1000);
}

// ─────────────────────────────────────────
// Shopify Helpers
// ─────────────────────────────────────────

async function completeShopifyOrder(shopifyDraftId, transactionDbId) {
  try {
    const shopifyResponse = await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}/complete.json`,
      { payment_pending: false },
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
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
// Core Push Logic (shared by manual + auto-push)
//
// Extracted so both the manual /api/push-to-terminal endpoint
// and the auto-push Shopify webhook can reuse the same code.
// ─────────────────────────────────────────

async function pushDraftOrderToTerminal({ draftOrderId, draftOrderName, amountInRupees, locationId }) {
  const { data: store, error: storeError } = await supabase
    .from('stores')
    .select('*')
    .eq('shopify_location_id', parseInt(locationId))
    .single();

  if (storeError || !store) {
    return { success: false, httpStatus: 404, error: `No terminal mapped for location ID: ${locationId}` };
  }

  // Block if already in-progress. FAILED/CANCELLED/PINE_UNREACHABLE allow a fresh push.
  const { data: existing } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('shopify_draft_id', draftOrderId.toString())
    .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
    .maybeSingle();

  if (existing) {
    return {
      success: false,
      httpStatus: 409,
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

  // Fire Pine upload in background — don't block the HTTP response
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

  console.log(`UploadBilledTransaction txn ${txn.id} REQUEST (AllowedPaymentMode=${JSON.stringify(paymentMode)}):`, JSON.stringify(pinePayload));

  // 30s timeout — Pine UAT can be slow getting the PTRID back
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
    console.log(`Txn ${txn.id} marked PINE_UNREACHABLE — if terminal shows nothing, cancel and push again`);
    await supabase
      .from('transactions')
      .update({ status: 'PINE_UNREACHABLE', pine_ref_id: null })
      .eq('id', txn.id);
  });

  return {
    success: true,
    message: 'Transaction logged. Sending to terminal...',
    transactionId: txn.id
  };
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
          console.log(`Poller: txn ${txn.id} (${txn.draft_order_name}) — no PTRID, upload may have timed out. Cancel and repush if terminal shows nothing.`);
          continue;
        }

        const ptrid = parseInt(txn.pine_ref_id);
        if (ptrid <= 0) {
          console.log(`Poller: txn ${txn.id} invalid PTRID=${txn.pine_ref_id} → FAILED`);
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

function startPoller() {
  console.log('🔄 Background poller started (30s interval)');
  setInterval(pollActiveTxns, 30000);
}

// ─────────────────────────────────────────
// Routes
// ─────────────────────────────────────────

app.get('/api/test-db', async (req, res) => {
  const { data, error } = await supabase.from('stores').select('*');
  return res.json({
    data, error,
    config: {
      autoPushToTerminal: AUTO_PUSH_TO_TERMINAL,
      pinePaymentMode: process.env.PINE_PAYMENT_MODE || 'integer',
      pinePaymentModeValue: getPinePaymentMode()
    },
    env: {
      supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'MISSING',
      serviceKey: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
      pineUrl: process.env.PINE_LABS_API_URL ? 'SET' : 'MISSING',
      shopifyUrl: process.env.SHOPIFY_STORE_URL ? 'SET' : 'MISSING',
      shopifyToken: process.env.SHOPIFY_ACCESS_TOKEN ? 'SET' : 'MISSING'
    }
  });
});

// ── Push to Terminal (manual — Retool button) ──

app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;
  if (!draftOrderId || !draftOrderName || !amountInRupees || !locationId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: draftOrderId, draftOrderName, amountInRupees, locationId'
    });
  }
  try {
    const result = await pushDraftOrderToTerminal({ draftOrderId, draftOrderName, amountInRupees, locationId });
    return res.status(result.httpStatus || 200).json(result);
  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── Shopify Draft Order Webhook (auto-push) ──
//
// Register this URL in Shopify:
//   Shopify Admin → Settings → Notifications → Webhooks
//   Event: Draft order creation
//   URL: https://timanti-middleware.fly.dev/api/shopify-draft-created
//   Format: JSON
//
// When AUTO_PUSH_TO_TERMINAL=true, every new draft order auto-pushes to the terminal.
// When AUTO_PUSH_TO_TERMINAL=false, webhook is received and logged but NOT pushed —
// cashier must click Push to POS manually in Retool.
//
// To flip the flag without redeploying:
//   fly secrets set AUTO_PUSH_TO_TERMINAL=true  -a timanti-middleware
//   fly secrets set AUTO_PUSH_TO_TERMINAL=false -a timanti-middleware

app.post('/api/shopify-draft-created', async (req, res) => {
  // Acknowledge immediately — Shopify times out if no fast response
  res.status(200).send('OK');

  try {
    const draft = req.body;
    if (!draft || !draft.id) {
      console.error('Shopify webhook: empty or invalid payload');
      return;
    }

    const draftOrderId   = draft.id.toString();
    const draftOrderName = draft.name || `#${draftOrderId}`;
    const amountInRupees = draft.total_price;
    const locationId     = draft.location_id?.toString() || null;

    console.log(`Shopify draft created: ${draftOrderName} (ID: ${draftOrderId}) amount: ₹${amountInRupees} location: ${locationId}`);

    if (!AUTO_PUSH_TO_TERMINAL) {
      console.log(`Auto-push is OFF — ${draftOrderName} received but not pushed. Cashier must push manually.`);
      return;
    }

    if (!locationId) {
      console.error(`Auto-push: ${draftOrderName} has no location_id — cannot find terminal. Skipping.`);
      return;
    }

    if (!amountInRupees || parseFloat(amountInRupees) <= 0) {
      console.error(`Auto-push: ${draftOrderName} has no amount — skipping.`);
      return;
    }

    console.log(`Auto-push ON — pushing ${draftOrderName} to terminal...`);
    const result = await pushDraftOrderToTerminal({ draftOrderId, draftOrderName, amountInRupees, locationId });
    console.log(`Auto-push result for ${draftOrderName}:`, JSON.stringify(result));

  } catch (err) {
    console.error('Shopify draft webhook error:', err.message);
  }
});

// ── Check Status ──────────────────────────
//
// Always calls Pine if a PTRID exists — Pine is source of truth, not DB.
// DB is only updated on an explicit Pine response.
// Only skips Pine call if there is no PTRID to query with.

app.post('/api/check-status', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'transactionId required' });
  }
  try {
    const { data: transaction, error: txnError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (txnError || !transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    // No PTRID — nothing to ask Pine about
    if (!transaction.pine_ref_id) {
      return res.json({
        success: true,
        status: transaction.status,
        message: transaction.status === 'PINE_UNREACHABLE'
          ? 'Upload timed out — Pine may or may not have received it. If terminal shows nothing, cancel and push again.'
          : 'Transaction not yet sent to terminal.',
        calledPine: false,
        transactionId: transaction.id
      });
    }

    const ptridNum = parseInt(transaction.pine_ref_id);
    if (ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', transactionId);
      return res.json({
        success: true,
        status: 'FAILED',
        message: 'Pine rejected this transaction (invalid PTRID). Push again.',
        calledPine: false,
        transactionId: transaction.id
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores').select('*').eq('id', transaction.location_id).single();

    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }

    console.log(`CheckStatus txn ${transactionId}: calling Pine PTRID=${ptridNum} (current DB status: ${transaction.status})`);

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
      success: true,
      status: newStatus || transaction.status,
      message: cashierMessage,
      calledPine: true,
      pineResponseCode,
      pineResponseMessage: pineMessage,
      transactionId: transaction.id,
      pineRefId: transaction.pine_ref_id
    });

  } catch (error) {
    console.error('Check-status error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: 'Could not reach Pine Labs.',
      detail: error.message
    });
  }
});

// ── Cancel Transaction ────────────────────
//
// Calls Pine synchronously. DB only updated if Pine returns ResponseCode 0.
// If Pine call fails for any reason, DB is untouched and error returned to client.
//
// Payload per docs section 7.1:
//   - Amount is MANDATORY
//   - ClientId / StoreId use lowercase 'd' (same as UploadBilledTransaction)
//   - MerchantID, SecurityToken, PlutusTransactionReferenceID also mandatory

app.post('/api/cancel-transaction', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'transactionId required' });
  }
  try {
    const { data: transaction, error: txnError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (txnError || !transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    if (['PAID', 'CANCELLED'].includes(transaction.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel — transaction is already ${transaction.status}.`
      });
    }

    // No PTRID — Pine never received it, safe to cancel in DB directly
    if (!transaction.pine_ref_id) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({
        success: true,
        message: 'Transaction cancelled (Pine had not received it).',
        transactionId: transaction.id,
        calledPine: false
      });
    }

    const ptridNum = parseInt(transaction.pine_ref_id);
    if (ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({
        success: true,
        message: 'Transaction cancelled (Pine had already rejected it).',
        transactionId: transaction.id,
        calledPine: false
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores').select('*').eq('id', transaction.location_id).single();

    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }

    // Docs section 7.1: Amount mandatory, ClientId/StoreId use lowercase 'd'
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
        error: `Pine Labs cancel call failed (HTTP ${httpStatus || 'N/A'}). Transaction NOT cancelled in DB.`,
        detail,
        transactionId: transaction.id
      });
    }

    if (pineResponseCode === 0) {
      await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
      return res.json({
        success: true,
        message: 'Transaction cancelled successfully.',
        transactionId: transaction.id,
        pineResponseCode,
        pineResponseMessage: pineMessage
      });
    } else {
      return res.status(400).json({
        success: false,
        error: `Pine rejected the cancel: ${pineMessage}`,
        pineResponseCode,
        pineResponseMessage: pineMessage,
        transactionId: transaction.id
      });
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

    if (!ptrid && !pineTransactionNumber) {
      console.error('PostBack: missing PTRID and TransactionNumber');
      return;
    }

    let txnRows;
    if (ptrid) {
      const result = await supabase
        .from('transactions').select('*')
        .eq('pine_ref_id', ptrid.toString())
        .order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) {
      const result = await supabase
        .from('transactions').select('*')
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
      const { data: transaction, error } = await supabase
        .from('transactions').select('*')
        .eq('id', parseInt(pineData.transactionId)).single();

      if (error || !transaction) {
        console.error('Webhook: transaction not found:', pineData.transactionId);
        return;
      }

      await supabase.from('transactions').update({
        status: 'PAID',
        pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id || 'TEST'
      }).eq('id', transaction.id);

      console.log(`✅ Test webhook: txn ${transaction.id} → PAID`);
      if (transaction.shopify_draft_id) {
        await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      }
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

    const { data: txnRows } = await supabase
      .from('transactions').select('*')
      .eq('draft_order_name', draftOrderName)
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE'])
      .order('created_at', { ascending: false }).limit(1);

    if (!txnRows || txnRows.length === 0) {
      console.error('Webhook: no active transaction for:', draftOrderName);
      return;
    }

    const transaction = txnRows[0];
    await supabase.from('transactions').update({
      status: 'PAID',
      pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id
    }).eq('id', transaction.id);

    console.log(`✅ Webhook: txn ${transaction.id} → PAID`);
    if (transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
  }
});

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Timanti Middleware running on port ${PORT}`);
  console.log('  GET  /api/test-db');
  console.log('  POST /api/push-to-terminal');
  console.log('  POST /api/shopify-draft-created   ← Shopify webhook (auto-push)');
  console.log('  POST /api/check-status');
  console.log('  POST /api/cancel-transaction');
  console.log('  POST /api/pine-postback');
  console.log('  POST /api/pine-webhook');
  console.log('');
  startPoller();
  startTokenHealthCheck();
});
