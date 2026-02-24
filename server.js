require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
// Also parse plain text (Pine Labs PostBack sends CSV, not JSON)
app.use(express.text({ type: '*/*' }));

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==========================================
// HELPER: Parse Pine Labs CSV PostBack
// Pine Labs sends: "ResponseCode=0,ResponseMessage=APPROVED,PlutusTransactionReferenceID=701409,..."
// ==========================================
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

// ==========================================
// HELPER: Complete Shopify Draft Order → Final Order
// Called after both PostBack and Check Status confirm PAID
// ==========================================
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


// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/test-db', async (req, res) => {
  const { data, error } = await supabase.from('stores').select('*');
  return res.json({
    data,
    error,
    supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'MISSING',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
    pineUrl: process.env.PINE_LABS_API_URL ? 'SET' : 'MISSING',
    shopifyUrl: process.env.SHOPIFY_STORE_URL ? 'SET' : 'MISSING'
  });
});


// ==========================================
// ENDPOINT 1: PUSH TO TERMINAL (unchanged from working version)
// ==========================================
app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;

  if (!draftOrderId || !draftOrderName || !amountInRupees || !locationId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: draftOrderId, draftOrderName, amountInRupees, locationId' 
    });
  }

  try {
    // Step A: Find the store/terminal for this Shopify location
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('shopify_location_id', parseInt(locationId))
      .single();

    if (storeError || !store) {
      return res.status(404).json({ 
        success: false, 
        error: `No terminal mapped for location ID: ${locationId}` 
      });
    }

    // Step B: Convert Rupees to Paisa
    const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);

    // Step C: Log PENDING transaction
    const { data: txn, error: txnError } = await supabase
      .from('transactions')
      .insert([{
        shopify_draft_id: draftOrderId.toString(),
        draft_order_name: draftOrderName,
        location_id: store.id,
        amount_paisa: amountInPaisa,
        status: 'PENDING'
      }])
      .select()
      .single();

    if (txnError) {
      console.error('DB insert error:', txnError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to log transaction in database',
        detail: txnError.message 
      });
    }

    // Step D: Build Pine Labs payload
    // AllowedPaymentMode: "0" = all modes enabled on terminal, customer picks at machine
    const pinePayload = {
      TransactionNumber: draftOrderName,
      SequenceNumber: 1,
      AllowedPaymentMode: "0",
      Amount: amountInPaisa,
      UserID: "System",
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: parseInt(store.pine_client_id),
      StoreId: parseInt(store.pine_store_id),       // required for Cancel & GetStatus
      TotalInvoiceAmount: amountInPaisa,
      AutoCancelDurationInMinutes: 10               // terminal auto-resets after 10 mins if no payment
    };

    // Step E: Return success to Retool immediately, call Pine Labs in background
    res.status(200).json({
      success: true,
      message: 'Transaction logged. Sending to terminal...',
      transactionId: txn.id
    });

    // Fire and forget — don't block the response
    axios.post(
      `${process.env.PINE_LABS_API_URL}/UploadBilledTransaction`,
      pinePayload,
      { timeout: 8000 }
    ).then(async (pineResponse) => {
      const responseCode = parseInt(pineResponse.data.ResponseCode);
      const ptrid = pineResponse.data.PlutusTransactionReferenceID || null;
      const newStatus = responseCode === 0 ? 'PUSHED_TO_TERMINAL' : 'FAILED';

      console.log(`Pine Labs UploadBilledTransaction: code=${responseCode}, PTRID=${ptrid}`);

      await supabase.from('transactions').update({ 
        status: newStatus,
        pine_ref_id: ptrid ? ptrid.toString() : null
      }).eq('id', txn.id);

    }).catch(async (err) => {
      console.error('Pine Labs call failed:', err.message);
      await supabase.from('transactions').update({ 
        status: 'PINE_UNREACHABLE' 
      }).eq('id', txn.id);
    });

  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// ENDPOINT 2A: PINE LABS POSTBACK — production path
// Pine Labs calls THIS automatically after every payment (success or fail)
// Format: CSV form-data, NOT JSON
// Register this URL with Pine Labs during onboarding: https://your-server.onrender.com/api/pine-postback
// ==========================================
app.post('/api/pine-postback', async (req, res) => {
  // Acknowledge immediately — Pine Labs will retry if we don't respond fast
  res.status(200).send('OK');

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const data = parsePineCSV(rawBody);
    console.log('Pine PostBack received:', data);

    const responseCode = parseInt(data['ResponseCode']);
    const ptrid = data['PlutusTransactionReferenceID'];
    const draftOrderName = data['TransactionNumber'];

    if (!ptrid && !draftOrderName) {
      console.error('PostBack missing both PTRID and TransactionNumber — cannot match transaction');
      return;
    }

    // Find the transaction — prefer PTRID match, fall back to draft order name
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
        .eq('draft_order_name', draftOrderName)
        .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
        .order('created_at', { ascending: false })
        .limit(1);
      txnRows = result.data;
    }

    if (!txnRows || txnRows.length === 0) {
      console.error('PostBack: No matching transaction found for PTRID:', ptrid, 'or order:', draftOrderName);
      return;
    }

    const transaction = txnRows[0];
    const newStatus = responseCode === 0 ? 'PAID' : 'FAILED';

    // Note: Pine Labs has a typo in their CSV field — "PaymenMode" not "PaymentMode"
    const paymentMode = data['PaymenMode'] || data['PaymentMode'] || null;

    await supabase.from('transactions').update({
      status: newStatus,
      pine_ref_id: ptrid ? ptrid.toString() : transaction.pine_ref_id,
      payment_mode: paymentMode
    }).eq('id', transaction.id);

    console.log(`✅ Transaction ${transaction.id} (${draftOrderName}) updated to ${newStatus}`);

    if (newStatus === 'PAID' && transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }

  } catch (error) {
    console.error('PostBack processing error:', error.message);
  }
});


// ==========================================
// ENDPOINT 2B: PINE LABS WEBHOOK — JSON testing path (Postman)
// Use this to test without hardware using Postman
// Expects JSON body with ResponseCode, TransactionNumber, PlutusTransactionReferenceID
// ==========================================
app.post('/api/pine-webhook', async (req, res) => {
  const pineData = req.body;
  console.log('Pine Labs webhook (JSON/test) received:', JSON.stringify(pineData));

  res.status(200).send('OK');

  const responseCode = parseInt(pineData.ResponseCode);
  const draftOrderName = pineData.TransactionNumber;

  if (responseCode !== 0) {
    console.log(`Payment failed/cancelled for order: ${draftOrderName}`);
    await supabase
      .from('transactions')
      .update({ status: 'FAILED' })
      .eq('draft_order_name', draftOrderName)
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL']);
    return;
  }

  try {
    const { data: txnRows } = await supabase
      .from('transactions')
      .select('*')
      .eq('draft_order_name', draftOrderName)
      .in('status', ['PENDING', 'PUSHED_TO_TERMINAL'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (!txnRows || txnRows.length === 0) {
      console.error('Webhook: No active transaction found for:', draftOrderName);
      return;
    }

    const transaction = txnRows[0];

    await supabase.from('transactions').update({ 
      status: 'PAID',
      pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id
    }).eq('id', transaction.id);

    if (transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }

  } catch (error) {
    console.error('Webhook processing error:', error.response?.data || error.message);
  }
});


// ==========================================
// ENDPOINT 3: CHECK STATUS
// Cashier clicks "Check Status" button on dashboard
// Polls Pine Labs GetTransactionStatus using the PTRID stored when we pushed
// ==========================================
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

    // Already in a final state — return immediately without calling Pine Labs
    if (['PAID', 'CANCELLED', 'FAILED'].includes(transaction.status)) {
      return res.json({
        success: true,
        status: transaction.status,
        message: `Transaction already ${transaction.status}.`,
        transactionId: transaction.id,
        pineRefId: transaction.pine_ref_id
      });
    }

    // No PTRID yet means Pine Labs hasn't acknowledged the push — too early to poll
    if (!transaction.pine_ref_id) {
      return res.json({
        success: true,
        status: transaction.status,
        message: 'Transaction not yet sent to terminal. Please wait a moment and try again.',
        transactionId: transaction.id
      });
    }

    // Get store credentials for the Pine Labs API call
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', transaction.location_id)
      .single();

    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }

    // Call Pine Labs GetTransactionStatus
    const statusPayload = {
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: parseInt(store.pine_client_id),
      StoreId: parseInt(store.pine_store_id),
      PlutusTransactionReferenceID: parseInt(transaction.pine_ref_id)
    };

    const pineStatusResponse = await axios.post(
      `${process.env.PINE_LABS_API_URL}/GetTransactionStatus`,
      statusPayload,
      { timeout: 8000 }
    );

    const pineResponseCode = parseInt(pineStatusResponse.data.ResponseCode);
    const pineMessage = pineStatusResponse.data.ResponseMessage || '';

    console.log(`GetStatus txn ${transactionId}: code=${pineResponseCode}, msg=${pineMessage}`);

    // Pine Labs response codes:
    // 0  = APPROVED (payment complete)
    // 1  = Transaction still open on terminal (customer hasn't paid yet)
    // Other = declined or error
    let newStatus = transaction.status;
    let cashierMessage = 'Payment still pending on terminal.';

    if (pineResponseCode === 0) {
      newStatus = 'PAID';
      cashierMessage = 'Payment confirmed!';
    } else if (pineResponseCode === 1) {
      cashierMessage = 'Waiting for customer to pay on terminal.';
    } else {
      newStatus = 'FAILED';
      cashierMessage = `Payment declined or failed: ${pineMessage}`;
    }

    // Update DB only if something changed
    if (newStatus !== transaction.status) {
      await supabase.from('transactions').update({ status: newStatus }).eq('id', transactionId);

      if (newStatus === 'PAID' && transaction.shopify_draft_id) {
        await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      }
    }

    return res.json({
      success: true,
      status: newStatus,
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


// ==========================================
// ENDPOINT 4: CANCEL TRANSACTION
// Cashier clicks "Cancel" on dashboard
// Resets the physical terminal + marks our DB as CANCELLED
// Draft order in Shopify is intentionally left OPEN so cashier can edit and re-push
// ==========================================
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

    // Block cancellation if payment already done or already cancelled
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

    // Mark CANCELLED in DB immediately — cashier sees feedback right away
    await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);

    // Return success to the cashier
    res.status(200).json({
      success: true,
      message: 'Transaction cancelled. The draft order is still open — you can edit it and push again.',
      transactionId: transaction.id
    });

    // Only call Pine Labs CancelTransaction if we have a PTRID
    // (means the transaction was successfully sent to Pine Labs and is open on terminal)
    if (transaction.pine_ref_id) {
      const cancelPayload = {
        MerchantID: parseInt(store.pine_merchant_id),
        SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
        StoreId: parseInt(store.pine_store_id),
        ClientId: parseInt(store.pine_client_id),
        PlutusTransactionReferenceID: parseInt(transaction.pine_ref_id),
        Amount: transaction.amount_paisa
      };

      axios.post(
        `${process.env.PINE_LABS_API_URL}/CancelTransaction`,
        cancelPayload,
        { timeout: 8000 }
      ).then(pineResponse => {
        console.log(`✅ Pine Labs CancelTransaction for txn ${transactionId}:`, pineResponse.data);
      }).catch(err => {
        // Not fatal — DB is already CANCELLED
        // Terminal will auto-reset after AutoCancelDurationInMinutes anyway
        console.error(`⚠️ Pine Labs cancel failed for txn ${transactionId}:`, err.message);
      });

    } else {
      // Transaction was PENDING or PINE_UNREACHABLE — never reached terminal
      console.log(`Txn ${transactionId} cancelled locally (never reached Pine Labs terminal)`);
    }

  } catch (error) {
    console.error('Cancel-transaction error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});


// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 Timanti Middleware running on port ${PORT}`);
  console.log('Endpoints:');
  console.log('  GET  /api/test-db');
  console.log('  POST /api/push-to-terminal');
  console.log('  POST /api/check-status');
  console.log('  POST /api/cancel-transaction');
  console.log('  POST /api/pine-postback   (Pine Labs production postback — CSV)');
  console.log('  POST /api/pine-webhook    (Postman testing — JSON)\n');
});
