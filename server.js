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
    await supabase.from('transactions').update({ final_shopify_order_id: finalOrderId.toString() }).eq('id', transactionDbId);
    return finalOrderId;
  } catch (error) {
    console.error('❌ Shopify complete error:', error.response?.data || error.message);
    return null;
  }
}

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

app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;
  if (!draftOrderId || !draftOrderName || !amountInRupees || !locationId) {
    return res.status(400).json({ success: false, error: 'Missing required fields: draftOrderId, draftOrderName, amountInRupees, locationId' });
  }
  try {
    const { data: store, error: storeError } = await supabase.from('stores').select('*').eq('shopify_location_id', parseInt(locationId)).single();
    if (storeError || !store) {
      return res.status(404).json({ success: false, error: `No terminal mapped for location ID: ${locationId}` });
    }
    const amountInPaisa = Math.round(parseFloat(amountInRupees) * 100);
    const { data: txn, error: txnError } = await supabase.from('transactions').insert([{
      shopify_draft_id: draftOrderId.toString(),
      draft_order_name: draftOrderName,
      location_id: store.id,
      amount_paisa: amountInPaisa,
      status: 'PENDING'
    }]).select().single();
    if (txnError) {
      console.error('DB insert error:', txnError);
      return res.status(500).json({ success: false, error: 'Failed to log transaction in database', detail: txnError.message });
    }
    const pinePayload = {
      TransactionNumber: draftOrderName,
      SequenceNumber: 1,
      AllowedPaymentMode: "0",
      Amount: amountInPaisa,
      UserID: "System",
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: parseInt(store.pine_client_id),
      StoreId: parseInt(store.pine_store_id),
      TotalInvoiceAmount: amountInPaisa,
      AutoCancelDurationInMinutes: 10
    };
    res.status(200).json({ success: true, message: 'Transaction logged. Sending to terminal...', transactionId: txn.id });
    axios.post(`${process.env.PINE_LABS_API_URL}/UploadBilledTransaction`, pinePayload, { timeout: 8000 })
      .then(async (pineResponse) => {
        const responseCode = parseInt(pineResponse.data.ResponseCode);
        const ptrid = pineResponse.data.PlutusTransactionReferenceID || null;
        const newStatus = responseCode === 0 ? 'PUSHED_TO_TERMINAL' : 'FAILED';
        console.log(`Pine Labs UploadBilledTransaction: code=${responseCode}, PTRID=${ptrid}`);
        await supabase.from('transactions').update({ status: newStatus, pine_ref_id: ptrid ? ptrid.toString() : null }).eq('id', txn.id);
      }).catch(async (err) => {
        console.error('Pine Labs call failed:', err.message);
        await supabase.from('transactions').update({ status: 'PINE_UNREACHABLE' }).eq('id', txn.id);
      });
  } catch (error) {
    console.error('Push-to-terminal error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pine-postback', async (req, res) => {
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
    let txnRows;
    if (ptrid) {
      const result = await supabase.from('transactions').select('*').eq('pine_ref_id', ptrid.toString()).order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) {
      const result = await supabase.from('transactions').select('*').eq('draft_order_name', draftOrderName).in('status', ['PENDING', 'PUSHED_TO_TERMINAL']).order('created_at', { ascending: false }).limit(1);
      txnRows = result.data;
    }
    if (!txnRows || txnRows.length === 0) {
      console.error('PostBack: No matching transaction found for PTRID:', ptrid, 'or order:', draftOrderName);
      return;
    }
    const transaction = txnRows[0];
    const newStatus = responseCode === 0 ? 'PAID' : 'FAILED';
    const paymentMode = data['PaymenMode'] || data['PaymentMode'] || null;
    await supabase.from('transactions').update({ status: newStatus, pine_ref_id: ptrid ? ptrid.toString() : transaction.pine_ref_id, payment_mode: paymentMode }).eq('id', transaction.id);
    console.log(`✅ Transaction ${transaction.id} (${draftOrderName}) updated to ${newStatus}`);
    if (newStatus === 'PAID' && transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }
  } catch (error) {
    console.error('PostBack processing error:', error.message);
  }
});

app.post('/api/pine-webhook', async (req, res) => {
  const pineData = req.body;
  console.log('Pine Labs webhook (JSON/test) received:', JSON.stringify(pineData));
  res.status(200).send('OK');
  try {
    if (pineData.transactionId) {
      const { data: transaction, error } = await supabase.from('transactions').select('*').eq('id', parseInt(pineData.transactionId)).single();
      if (error || !transaction) {
        console.error('Webhook: Transaction not found for ID:', pineData.transactionId);
        return;
      }
      await supabase.from('transactions').update({ status: 'PAID', pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id || 'TEST' }).eq('id', transaction.id);
      console.log(`✅ Test webhook: Transaction ${transaction.id} marked PAID`);
      if (transaction.shopify_draft_id) {
        await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      }
      return;
    }
    const responseCode = parseInt(pineData.ResponseCode);
    const draftOrderName = pineData.TransactionNumber;
    if (responseCode !== 0) {
      console.log(`Payment failed/cancelled for order: ${draftOrderName}`);
      await supabase.from('transactions').update({ status: 'FAILED' }).eq('draft_order_name', draftOrderName).in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']);
      return;
    }
    const { data: txnRows } = await supabase.from('transactions').select('*').eq('draft_order_name', draftOrderName).in('status', ['PENDING', 'PUSHED_TO_TERMINAL', 'PINE_UNREACHABLE']).order('created_at', { ascending: false }).limit(1);
    if (!txnRows || txnRows.length === 0) {
      console.error('Webhook: No active transaction found for:', draftOrderName);
      return;
    }
    const transaction = txnRows[0];
    await supabase.from('transactions').update({ status: 'PAID', pine_ref_id: pineData.PlutusTransactionReferenceID?.toString() || transaction.pine_ref_id }).eq('id', transaction.id);
    console.log(`✅ Test webhook: Transaction ${transaction.id} (${draftOrderName}) marked PAID`);
    if (transaction.shopify_draft_id) {
      await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
    }
  } catch (error) {
    console.error('Webhook processing error:', error.response?.data || error.message);
  }
});

app.post('/api/check-status', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'transactionId required' });
  }
  try {
    const { data: transaction, error: txnError } = await supabase.from('transactions').select('*').eq('id', transactionId).single();
    if (txnError || !transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    if (['PAID', 'CANCELLED', 'FAILED'].includes(transaction.status)) {
      return res.json({ success: true, status: transaction.status, message: `Transaction already ${transaction.status}.`, transactionId: transaction.id, pineRefId: transaction.pine_ref_id });
    }
    if (!transaction.pine_ref_id) {
      return res.json({ success: true, status: transaction.status, message: 'Transaction not yet sent to terminal. Please wait a moment and try again.', transactionId: transaction.id });
    }
    const { data: store, error: storeError } = await supabase.from('stores').select('*').eq('id', transaction.location_id).single();
    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }
    const statusPayload = {
      MerchantID: parseInt(store.pine_merchant_id),
      SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
      ClientId: parseInt(store.pine_client_id),
      StoreId: parseInt(store.pine_store_id),
      PlutusTransactionReferenceID: parseInt(transaction.pine_ref_id)
    };
    // FIX: Correct endpoint name per Pine Labs documentation
    const pineStatusResponse = await axios.post(
      `${process.env.PINE_LABS_API_URL}/GetStatus`,
      statusPayload,
      { timeout: 8000 }
    );
    const pineResponseCode = parseInt(pineStatusResponse.data.ResponseCode);
    const pineMessage = pineStatusResponse.data.ResponseMessage || '';
    console.log(`GetStatus txn ${transactionId}: code=${pineResponseCode}, msg=${pineMessage}`);
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
    if (newStatus !== transaction.status) {
      await supabase.from('transactions').update({ status: newStatus }).eq('id', transactionId);
      if (newStatus === 'PAID' && transaction.shopify_draft_id) {
        await completeShopifyOrder(transaction.shopify_draft_id, transaction.id);
      }
    }
    return res.json({ success: true, status: newStatus, message: cashierMessage, pineResponseCode, transactionId: transaction.id, pineRefId: transaction.pine_ref_id });
  } catch (error) {
    console.error('Check-status error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: 'Could not reach Pine Labs. Check your terminal connectivity.', detail: error.message });
  }
});

app.post('/api/cancel-transaction', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'transactionId required' });
  }
  try {
    const { data: transaction, error: txnError } = await supabase.from('transactions').select('*').eq('id', transactionId).single();
    if (txnError || !transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    if (['PAID', 'CANCELLED'].includes(transaction.status)) {
      return res.status(400).json({ success: false, error: `Cannot cancel — transaction is already ${transaction.status}.` });
    }
    const { data: store, error: storeError } = await supabase.from('stores').select('*').eq('id', transaction.location_id).single();
    if (storeError || !store) {
      return res.status(500).json({ success: false, error: 'Store config not found' });
    }
    await supabase.from('transactions').update({ status: 'CANCELLED' }).eq('id', transactionId);
    res.status(200).json({ success: true, message: 'Transaction cancelled. The draft order is still open — you can edit it and push again.', transactionId: transaction.id });
    if (transaction.pine_ref_id) {
      const cancelPayload = {
        MerchantID: parseInt(store.pine_merchant_id),
        SecurityToken: process.env.PINE_LABS_SECURITY_TOKEN,
        StoreId: parseInt(store.pine_store_id),
        ClientId: parseInt(store.pine_client_id),
        PlutusTransactionReferenceID: parseInt(transaction.pine_ref_id),
        Amount: transaction.amount_paisa
      };
      // FIX: Correct endpoint name per Pine Labs documentation
      axios.post(`${process.env.PINE_LABS_API_URL}/CancelTransactionForced`, cancelPayload, { timeout: 8000 })
        .then(pineResponse => {
          console.log(`✅ Pine Labs CancelTransactionForced for txn ${transactionId}:`, pineResponse.data);
        }).catch(err => {
          console.error(`⚠️ Pine Labs cancel failed for txn ${transactionId}:`, err.message);
        });
    } else {
      console.log(`Txn ${transactionId} cancelled locally (never reached Pine Labs terminal)`);
    }
  } catch (error) {
    console.error('Cancel-transaction error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

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
