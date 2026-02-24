require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json()); // Allows server to read JSON bodies

// 1. Initialize Supabase Database Connection
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ==========================================
// ENDPOINT 1: PUSH TO TERMINAL (Triggered by your App/Retool)
// ==========================================
app.post('/api/push-to-terminal', async (req, res) => {
  const { draftOrderId, draftOrderName, amountInRupees, locationId } = req.body;

  try {
    // Step A: Look up the Pine Labs Terminal info for this specific store location
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('shopify_location_id', locationId)
      .single();

    if (storeError || !store) throw new Error('Store routing not found for this location');

    // Step B: Convert Rupees to Paisa (Pine Labs requirement)
    const amountInPaisa = Math.round(amountInRupees * 100);

    // Step C: Log the "PENDING" transaction in our database
    const { data: txn, error: txnError } = await supabase
      .from('transactions')
      .insert([
        { 
          draft_order_name: draftOrderName, 
          location_id: store.id, 
          amount_paisa: amountInPaisa,
          status: 'PENDING' 
        }
      ])
      .select().single();

    if (txnError) throw new Error('Failed to log transaction locally');

    // Step D: Build the Pine Labs API Payload based on their documentation
    const pinePayload = {
      TransactionNumber: draftOrderName, // e.g., "#D-1024"
      SequenceNumber: 1,
      AllowedPaymentMode: "0", // 0 = Allow all modes (Card, UPI)
      Amount: amountInPaisa,
      UserID: "System",
      MerchantID: store.pine_merchant_id, // From DB
      SecurityToken: "PLACEHOLDER_PINE_SECRET_TOKEN", // Will be in .env later
      ClientId: store.pine_client_id, // The physical terminal ID from DB
      TotalInvoiceAmount: amountInPaisa
    };

    // Step E: Send request to Pine Labs Cloud
    // NOTE: Using UAT (Sandbox) URL for testing
    const pineResponse = await axios.post(`${process.env.PINE_LABS_API_URL}/UploadBilledTransaction`, pinePayload);

    // Step F: Handle Pine Labs Response
    if (pineResponse.data.ResponseCode === 0 || pineResponse.data.ResponseCode === "0") {
      // Success! Update DB with the Pine Reference ID
      await supabase
        .from('transactions')
        .update({ pine_ref_id: pineResponse.data.PlutusTransactionReferenceID, status: 'PUSHED_TO_TERMINAL' })
        .eq('id', txn.id);

      return res.status(200).json({ 
        success: true, 
        message: 'Sent to terminal successfully!',
        pineRef: pineResponse.data.PlutusTransactionReferenceID 
      });
    } else {
      // Terminal rejected it (e.g., offline, bad amount)
      await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', txn.id);
      return res.status(400).json({ success: false, error: pineResponse.data.ResponseMessage });
    }

  } catch (error) {
    console.error("Push Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});


// ==========================================
// ENDPOINT 2: POSTBACK / WEBHOOK (Triggered by Pine Labs upon swipe)
// ==========================================
app.post('/api/pine-webhook', async (req, res) => {
  const pineData = req.body;
  console.log("Received Webhook from Pine Labs:", pineData);

  // Always return 200 OK immediately so Pine Labs knows we got it
  res.status(200).send('OK'); 

  // Check if payment was actually approved (ResponseCode 0)
  if (pineData.ResponseCode !== 0 && pineData.ResponseCode !== "0") {
    console.log("Transaction failed or cancelled on terminal.");
    // Optionally update DB to 'CANCELLED' or 'FAILED'
    return;
  }

  const draftOrderName = pineData.TransactionNumber; // e.g. "#D-1024"

  try {
    // Step A: Mark transaction as PAID in our database
    await supabase
      .from('transactions')
      .update({ status: 'PAID' })
      .eq('draft_order_name', draftOrderName);

    // Step B: Tell Shopify to Complete the Draft Order
    // Note: You must retrieve the actual Draft Order ID from Shopify using the Name first, 
    // or store the Draft Order ID in your DB in Endpoint 1. Assuming we have the ID:
    
    // Placeholder function to get Draft ID from Name
    const shopifyDraftOrderId = await getShopifyDraftIdByName(draftOrderName);

    if (shopifyDraftOrderId) {
      const shopifyResponse = await axios.put(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftOrderId}/complete.json`,
        { payment_pending: false },
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`Successfully completed Shopify order: ${shopifyResponse.data.draft_order.order_id}`);
      
      // Step C: Update DB with final Shopify Order ID
      await supabase
        .from('transactions')
        .update({ final_shopify_order_id: shopifyResponse.data.draft_order.order_id.toString() })
        .eq('draft_order_name', draftOrderName);
    }

  } catch (error) {
    console.error("Webhook processing error:", error.response ? error.response.data : error.message);
  }
});

// Helper Function for Shopify Lookup
async function getShopifyDraftIdByName(draftOrderName) {
  // In reality, you'd hit Shopify's GraphQL or REST API to search Draft Orders by name
  // OR just save the draftOrderId in your Supabase 'transactions' table in Endpoint 1
  return "PLACEHOLDER_ID"; 
}

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Retail Middleware is running on port ${PORT}`);
});
