require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==========================================
// HEALTH CHECK - Test DB connection
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
// ENDPOINT 1: PUSH TO TERMINAL
// ==========================================
app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;

  // Validate all required fields are present
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

    // Step B: Convert Rupees to Paisa (Pine Labs requires paisa)
    const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);

    // Step C: Log PENDING transaction — store draftOrderId so webhook can use it later
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
    const pinePayload = {
      TransactionNumber: draftOrderName,
      SequenceNumber: 1,
      AllowedPaymentMode: "0",
      Amount: amountInPaisa,
      UserID: "System",
      MerchantID: store.pine_merchant_id,
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: store.pine_client_id,
      TotalInvoiceAmount: amountInPaisa
    };

    // Step E: Send to Pine Labs (UAT/sandbox for now)
   res.status(200).json({
  success: true,
  message: 'Transaction logged. Sending to terminal...',
  transactionId: txn.id
});

// Fire and forget - don't await this
axios.post(
  `${process.env.PINE_LABS_API_URL}/UploadBilledTransaction`,
  pinePayload,
  { timeout: 5000 }
).then(async (pineResponse) => {
  const responseCode = parseInt(pineResponse.data.ResponseCode);
  const newStatus = responseCode === 0 ? 'PUSHED_TO_TERMINAL' : 'FAILED';
  await supabase.from('transactions').update({ status: newStatus }).eq('id', txn.id);
}).catch(async (err) => {
  console.error('Pine Labs call failed:', err.message);
  await supabase.from('transactions').update({ status: 'PINE_UNREACHABLE' }).eq('id', txn.id);
});

    // Step F: Handle Pine Labs response
    const responseCode = parseInt(pineResponse.data.ResponseCode);

    if (responseCode === 0) {
      // Success — update DB with Pine reference ID
      await supabase
        .from('transactions')
        .update({ 
          pine_ref_id: pineResponse.data.PlutusTransactionReferenceID, 
          status: 'PUSHED_TO_TERMINAL' 
        })
        .eq('id', txn.id);

      return res.status(200).json({ 
        success: true, 
        message: 'Transaction sent to terminal successfully',
        pineRef: pineResponse.data.PlutusTransactionReferenceID,
        transactionId: txn.id
      });

    } else {
      // Pine Labs rejected it
      await supabase
        .from('transactions')
        .update({ status: 'FAILED' })
        .eq('id', txn.id);

      return res.status(400).json({ 
        success: false, 
        error: pineResponse.data.ResponseMessage || 'Terminal rejected the transaction',
        responseCode 
      });
    }

  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// ENDPOINT 2: PINE LABS WEBHOOK (fires when customer swipes card)
// ==========================================
app.post('/api/pine-webhook', async (req, res) => {
  const pineData = req.body;
  console.log('Pine Labs webhook received:', JSON.stringify(pineData));

  // Always acknowledge immediately so Pine Labs doesn't retry
  res.status(200).send('OK');

  const responseCode = parseInt(pineData.ResponseCode);
  const draftOrderName = pineData.TransactionNumber;

  if (responseCode !== 0) {
    console.log(`Payment failed/cancelled on terminal for order: ${draftOrderName}`);
    await supabase
      .from('transactions')
      .update({ status: 'FAILED' })
      .eq('draft_order_name', draftOrderName);
    return;
  }

  try {
    // Step A: Fetch the transaction from DB to get the real Shopify draft order ID
const { data: txn, error: txnError } = await supabase
  .from('transactions')
  .select('*')
  .eq('draft_order_name', draftOrderName)
  .eq('status', 'PENDING')
  .order('created_at', { ascending: false })
  .limit(1);

if (txnError || !txn || txn.length === 0) {
  console.error('Could not find PENDING transaction for:', draftOrderName);
  return;
}

const transaction = txn[0]; // take the most recent one

    // Step B: Mark as PAID in our DB
    await supabase
      .from('transactions')
      .update({ 
        status: 'PAID',
        pine_ref_id: pineData.PlutusTransactionReferenceID 
      })
      .eq('id', txn.id);

    // Step C: Complete the Draft Order in Shopify using the stored ID
    const shopifyResponse = await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${txn.shopify_draft_id}/complete.json`,
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
    console.log(`Shopify order completed: ${finalOrderId}`);

    // Step D: Store the final Shopify order ID
    await supabase
      .from('transactions')
      .update({ final_shopify_order_id: finalOrderId.toString() })
      .eq('id', txn.id);

  } catch (error) {
    console.error('Webhook processing error:', error.response?.data || error.message);
  }
});


// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Timanti Middleware running on port ${PORT}`);
});
