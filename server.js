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
// Pine Labs GetStatus Response Handling
//
// Per official docs (section 6.2):
//   ResponseCode 0  = Success ("TXN APPROVED")
//   ResponseCode ≠0 = Failure — no exceptions
//
// HOWEVER: In practice, Pine Labs returns code=1001 with message
// "TXN UPLOADED" when a transaction has been uploaded to the cloud
// but the terminal hasn't picked it up yet. This is NOT in the docs
// but is a real observed in-between state. We handle it by message.
//
// Rule: if code=0 → PAID
//       if message contains a known "still in progress" phrase → no change (keep polling)
//       everything else non-zero → FAILED
//
// This means code=1 "INVALID PLUTUS TXN REF ID" → FAILED (correct)
// This means code=1001 "TXN UPLOADED" → pending (keep polling)
// ─────────────────────────────────────────

const PINE_PENDING_MESSAGES = [
  'TXN UPLOADED',      // code 1001 — uploaded, terminal hasn't picked up yet
  'TXN PENDING',       // terminal waiting for customer action
  'IN PROGRESS',       // customer interacting with terminal
];

function getPineStatusResult(responseCode, responseMessage) {
  const msg = (responseMessage || '').toUpperCase().trim();

  if (responseCode === 0) {
    return { newStatus: 'PAID', cashierMessage: 'Payment confirmed!' };
  }

  // Check if message matches a known "still processing" state
  const isPending = PINE_PENDING_MESSAGES.some(p => msg.includes(p));
  if (isPending) {
    return { newStatus: null, cashierMessage: `Terminal: ${responseMessage}` };
  }

  // All other non-zero codes are failures per Pine Labs docs
  return { newStatus: 'FAILED', cashierMessage: `Payment failed: ${responseMessage}` };
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function parsePineCSV(rawBody) {
  const data = {};
  rawBody.split(',').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex !== -1) {
      const key = pair.substring(0, eqIndex).trim();
      const value = pair.substring(eqIndex + 1).trim();
      data[key] = value;
    }
  });
  return data;
}

// Pine Labs rejects duplicate TransactionNumbers across all attempts — even
// after the original attempt fails or is cancelled. We make each attempt
// unique by appending a timestamp. e.g. "#D7" → "#D7-1740123456789"
function makePineTransactionNumber(draftOrderName) {
  return `${draftOrderName}-${Date.now()}`;
}

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
        timeout: 10000
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
// Background Poller
// Runs every 30s — checks all active transactions
// and updates DB based on Pine Labs GetStatus response
// ─────────────────────────────────────────

let isPolling = false;

async function pollActiveTxns() {
  if (isPolling) return;
  isPolling = true;
  try {
    const { data: activeTxns, error } = await supabase
      .from('transactions')
      .select('*, stores(*)')
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE'])
      .not('pine_ref_id', 'is', null);

    if (error) {
      console.error('Poller: DB fetch error:', error.message);
      return;
    }
    if (!activeTxns || activeTxns.length === 0) return;

    console.log(`Poller: checking ${activeTxns.length} active transaction(s)`);

    for (const txn of activeTxns) {
      try {
        const store = txn.stores;
        if (!store) {
          console.error(`Poller: no store found for txn ${txn.id}`);
          continue;
        }

        // Invalid or negative PTRID means Pine rejected the upload — mark failed immediately
        const ptrid = parseInt(txn.pine_ref_id);
        if (!ptrid || ptrid <= 0) {
          console.log(`Poller: txn ${txn.id} has invalid PTRID=${txn.pine_ref_id} — marking FAILED`);
          await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', txn.id);
          continue;
        }

        const statusPayload = {
          MerchantID: parseInt(store.pine_merchant_id),
          SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
          ClientID: parseInt(store.pine_client_id),
          StoreID: parseInt(store.pine_store_id),
          PlutusTransactionReferenceID: ptrid
        };

        const pineResponse = await axios.post(
          `${process.env.PINE_LABS_API_URL}/V1/GetCloudBasedTxnStatus`,
          statusPayload,
          { timeout: 8000 }
        );

        const pineResponseCode = parseInt(pineResponse.data.ResponseCode);
        const pineMessage = pineResponse.data.ResponseMessage || '';
        const { newStatus } = getPineStatusResult(pineResponseCode, pineMessage);

        console.log(`Poller: txn ${txn.id} PTRID=${ptrid}: code=${pineResponseCode} msg=${pineMessage}${newStatus ? ` → ${newStatus}` : ' (no change)'}`);

        if (newStatus && newStatus !== txn.status) {
          await supabase
            .from('transactions')
            .update({ status: newStatus })
            .eq('id', txn.id);

          if (newStatus === 'PAID' && txn.shopify_draft_id) {
            await completeShopifyOrder(txn.shopify_draft_id, txn.id);
          }
        }
      } catch (err) {
        console.error(`Poller: error checking txn ${txn.id}:`, err.message);
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
    supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'MISSING',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
    pineUrl: process.env.PINE_LABS_API_URL ? 'SET' : 'MISSING',
    shopifyUrl: process.env.SHOPIFY_STORE_URL ? 'SET' : 'MISSING'
  });
});

// ── Push to Terminal ──────────────────────

app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;
  if (!draftOrderId || !draftOrderName || !amountInRupees || !locationId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: draftOrderId, draftOrderName, amountInRupees, locationId'
    });
  }
  try {
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('shopify_location_id', parseInt(locationId))
      .single();

    if (storeError || !store) {
      return res.status(404).json({ success: false, error: `No terminal mapped for location ID: ${locationId}` });
    }

    // Block duplicate active transactions — only PENDING or PUSHED_TO_TERMINAL count
    // FAILED / CANCELLED / PAID transactions allow a fresh push
    const { data: existing } = await supabase
      .from('transactions')
      .select('id, status')
      .eq('shopify_draft_id', draftOrderId.toString())
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'This draft order already has an active payment in progress. Cancel it first.',
        existingTransactionId: existing.id
      });
    }

    const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);

    // Unique per-attempt name sent to Pine Labs
    // Pine permanently rejects reused TransactionNumbers even if prior attempt failed
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
      return res.status(500).json({ success: false, error: 'Failed to log transaction in database', detail: txnError.message });
    }

    const pinePayload = {
      TransactionNumber: pineTransactionNumber,
      SequenceNumber: 1,
      AllowedPaymentMode: '0',
      Amount: amountInPaisa,
      UserID: 'System',
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: parseInt(store.pine_client_id),
      StoreId: parseInt(store.pine_store_id),
      TotalInvoiceAmount: amountInPaisa,
      AutoCancelDurationInMinutes: 10
    };

    res.status(200).json({
      success: true,
      message: 'Transaction logged. Sending to terminal...',
      transactionId: txn.id
    });

    axios.post(`${process.env.PINE_LABS_API_URL}/V1/UploadBilledTransaction`, pinePayload, { timeout: 8000 })
      .then(async (pineResponse) => {
        const responseCode = parseInt(pineResponse.data.ResponseCode);
        const ptrid = pineResponse.data.PlutusTransactionReferenceID || null;
        const ptridNum = ptrid ? parseInt(ptrid) : null;

        // Pine returns negative PTRID (e.g. -5) when TransactionNumber is rejected
        const newStatus = (responseCode === 0 && ptridNum && ptridNum > 0) ? 'PUSHED_TO_TERMINAL' : 'FAILED';

        console.log(`UploadBilledTransaction txn ${txn.id}: code=${responseCode} PTRID=${ptrid} → ${newStatus}`);
        await supabase
          .from('transactions')
          .update({ status: newStatus, pine_ref_id: ptrid ? ptrid.toString() : null })
          .eq('id', txn.id);
      })
      .catch(async (err) => {
        console.error('Pine Labs UploadBilledTransaction failed:', err.message);
        await supabase.from('transactions').update({ status: 'PINE_UNREACHABLE' }).eq('id', txn.id);
      });

  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── Check Status (manual) ─────────────────

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

    if (['PAID', 'CANCELLED', 'FAILED'].includes(transaction.status)) {
      return res.json({
        success: true,
        status: transaction.status,
        message: `Transaction is ${transaction.status}.`,
        transactionId: transaction.id,
        pineRefId: transaction.pine_ref_id
      });
    }

    if (!transaction.pine_ref_id) {
      return res.json({
        success: true,
        status: transaction.status,
        message: 'Transaction not yet sent to terminal. Please wait and try again.',
        transactionId: transaction.id
      });
    }

    const ptridNum = parseInt(transaction.pine_ref_id);
    if (!ptridNum || ptridNum <= 0) {
      await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', transactionId);
      return res.json({
        success: true,
        status: 'FAILED',
        message: 'Transaction was rejected by Pine Labs (invalid PTRID). Please push again.',
        transactionId: transaction.id,
        pineRefId: transaction.pine_ref_id
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', transaction.location_id)
      .single();

    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }

    const statusPayload = {
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientID: parseInt(store.pine_client_id),
      StoreID: parseInt(store.pine_store_id),
      PlutusTransactionReferenceID: ptridNum
    };

    console.log(`CheckStatus txn ${transactionId}: calling Pine Labs for PTRID=${ptridNum}`);
    const pineStatusResponse = await axios.post(
      `${process.env.PINE_LABS_API_URL}/V1/GetCloudBasedTxnStatus`,
      statusPayload,
      { timeout: 8000 }
    );

    const pineResponseCode = parseInt(pineStatusResponse.data.ResponseCode);
    const pineMessage = pineStatusResponse.data.ResponseMessage || '';
    console.log(`CheckStatus txn ${transactionId}: code=${pineResponseCode} msg=${pineMessage}`);

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
      pineResponseCode,
      transactionId: transaction.id,
      pineRefId: transaction.pine_ref_id
    });

  } catch (error) {
    console.error('Check-status error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: 'Could not reach Pine Labs. Check your terminal connectivity.',
      detail: error.message
    });
  }
});

// ── Cancel Transaction ────────────────────

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

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', transaction.location_id)
      .single();

    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }

    await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);

    res.status(200).json({
      success: true,
      message: 'Transaction cancelled. The draft order is still open — you can edit it and push again.',
      transactionId: transaction.id
    });

    // Only call Pine cancel if we have a valid PTRID
    const ptridNum = transaction.pine_ref_id ? parseInt(transaction.pine_ref_id) : 0;
    if (ptridNum > 0) {
      const cancelPayload = {
        MerchantID: parseInt(store.pine_merchant_id),
        SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
        StoreID: parseInt(store.pine_store_id),
        ClientID: parseInt(store.pine_client_id),
        PlutusTransactionReferenceID: ptridNum,
        Amount: transaction.amount_paisa
      };

      axios.post(`${process.env.PINE_LABS_API_URL}/V1/CancelTransaction`, cancelPayload, { timeout: 8000 })
        .then(pineResponse => {
          console.log(`✅ Pine CancelTransaction txn ${transactionId}:`, pineResponse.data);
        })
        .catch(err => {
          console.error(`⚠️ Pine CancelTransaction failed txn ${transactionId}:`, err.message);
        });
    } else {
      console.log(`Txn ${transactionId} cancelled locally (no valid PTRID)`);
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
      console.error('PostBack missing both PTRID and TransactionNumber');
      return;
    }

    let txnRows;
    if (ptrid) {
      const result = await supabase
        .from('transactions')
        .select('*')
        .eq('pine_ref_id', ptrid.toString())
        .order('created_at', { ascending: false })
        .limit(1);
      txnRows = result.data;
    }

    if (!txnRows || txnRows.length === 0) {
      const result = await supabase
        .from('transactions')
        .select('*')
        .eq('pine_transaction_number', pineTransactionNumber)
        .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
        .order('created_at', { ascending: false })
        .limit(1);
      txnRows = result.data;
    }

    if (!txnRows || txnRows.length === 0) {
      console.error('PostBack: No matching transaction for PTRID:', ptrid, 'pineNum:', pineTransactionNumber);
      return;
    }

    const transaction = txnRows[0];
    const newStatus = responseCode === 0 ? 'PAID' : 'FAILED';
    const paymentMode = data['PaymenMode'] || data['PaymentMode'] || null;

    await supabase
      .from('transactions')
      .update({
        status: newStatus,
        pine_ref_id: ptrid ? ptrid.toString() : transaction.pine_ref_id,
        payment_mode: paymentMode
      })
      .eq('id', transaction.id);

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
        .from('transactions')
        .select('*')
        .eq('id', parseInt(pineData.transactionId))
        .single();

      if (error || !transaction) {
        console.error('Webhook: Transaction not found for ID:', pineData.transactionId);
        return;
      }

      await supabase
        .from('transactions')
        .update({
          status: 'PAID',
          pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id || 'TEST'
        })
        .eq('id', transaction.id);

      console.log(`✅ Test webhook: txn ${transaction.id} → PAID`);
      if (transaction.shopify_draft_id) {
        await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      }
      return;
    }

    const responseCode = parseInt(pineData.ResponseCode);
    const draftOrderName = pineData.TransactionNumber;

    if (responseCode !== 0) {
      await supabase
        .from('transactions')
        .update({ status: 'FAILED' })
        .eq('draft_order_name', draftOrderName)
        .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']);
      return;
    }

    const { data: txnRows } = await supabase
      .from('transactions')
      .select('*')
      .eq('draft_order_name', draftOrderName)
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (!txnRows || txnRows.length === 0) {
      console.error('Webhook: No active transaction for:', draftOrderName);
      return;
    }

    const transaction = txnRows[0];
    await supabase
      .from('transactions')
      .update({
        status: 'PAID',
        pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id
      })
      .eq('id', transaction.id);

    console.log(`✅ Webhook: txn ${transaction.id} (${draftOrderName}) → PAID`);
    if (transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
  }
});

// ─────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Timanti Middleware running on port ${PORT}`);
  console.log('Endpoints:');
  console.log('  GET  /api/test-db');
  console.log('  POST /api/push-to-terminal');
  console.log('  POST /api/check-status');
  console.log('  POST /api/cancel-transaction');
  console.log('  POST /api/pine-postback   (Pine Labs postback — CSV)');
  console.log('  POST /api/pine-webhook    (Postman testing — JSON)');
  console.log('');
  startPoller();
});
