'use strict';

/**
 * Pine Labs card terminals — the whole integration.
 *
 * Pushes a draft order to a physical terminal, polls it for the result, and handles the two
 * callbacks Pine can send back. Lifted out of server.js unchanged; this is a relocation, not a
 * rewrite, so behaviour is identical line for line.
 *
 * ENTRY POINTS
 *   register(app, ctx)        mounts the five routes
 *   pollActiveTxns(ctx)       one pass of the 30s poller (server.js owns the interval)
 *   pushDraftOrderToTerminal  the push itself — also called by the draft-created webhook
 *   parseTerminalTag          reads `terminal:XX` off draft tags
 *   getPinePaymentMode        exported for /api/test-db's diagnostics
 *
 * ROUTES
 *   POST /api/push-to-terminal     push an amount to a terminal
 *   POST /api/check-status         ask Pine where a transaction got to
 *   POST /api/cancel-transaction   cancel a pushed transaction
 *   POST /api/pine-postback        Pine's CSV callback (`a=1,b=2` in the body)
 *   POST /api/pine-webhook         Pine's JSON callback, plus a test shape
 *
 * THE ONE INJECTED DEPENDENCY
 * ctx.handlePaymentCompletion — what happens once money is confirmed (deposits, tags, emails).
 * That is payment logic, not terminal logic, and it still lives in the bootstrap. It is passed in
 * rather than referenced by name: this module is meant to be liftable into the admin actions app,
 * and a bare reference to a bootstrap-scoped function is exactly the bug that took the daily
 * price job down for five days after the last refactor.
 *
 * NOT MOVED, DELIBERATELY
 *   /api/shopify-draft-created  — a draft-created webhook that hydrates line items AND may
 *                                 auto-push. Mixed concern, majority not Pine. It calls in here.
 *   /api/test-db                — diagnostics for the whole server; reads getPinePaymentMode().
 *
 * Reads config.pine rather than process.env: the module contract test asserts the set of modules
 * touching process.env directly only ever shrinks.
 */

const axios = require('axios');

const { config }   = require('../../core/config');
const { supabase } = require('../../core/supabase');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPinePaymentMode() {
  const mode = (config.pine.mode || 'integer').toLowerCase();
  if (mode === 'pipe') return '1|8|10|11|4|20|21';
  return 0;
}

function getPineApiUrl(store) {
  return store.is_uat ? config.pine.uatApiUrl : config.pine.apiUrl;
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

/** Security token is per-store, falling back to the account-wide one. */
function securityTokenFor(store) {
  return store.security_token || config.pine.securityToken;
}

// ─── Push ────────────────────────────────────────────────────────────────────

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
    SecurityToken:               securityTokenFor(store),
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

// ─── Background poller (server.js owns the 30s interval) ─────────────────────

let isPolling = false;

async function pollActiveTxns(ctx = {}) {
  const { handlePaymentCompletion } = ctx;
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
          { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: securityTokenFor(store),
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
          if (newStatus === 'PAID' && handlePaymentCompletion) await handlePaymentCompletion(txn, { utr, paymentSource: 'pine' });
        }
      } catch (err) { console.error(`Poller: error on txn ${txn.id}:`, err.message); }
    }
  } finally { isPolling = false; }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function register(app, ctx = {}) {
  const { handlePaymentCompletion } = ctx;

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
      { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: securityTokenFor(store),
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
      if (newStatus === 'PAID' && handlePaymentCompletion) await handlePaymentCompletion(transaction, { utr, paymentSource: 'pine' });
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
        { MerchantID: parseInt(store.pine_merchant_id), SecurityToken: securityTokenFor(store),
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
    if (newStatus === 'PAID' && handlePaymentCompletion) await handlePaymentCompletion(transaction, { utr, paymentSource: 'pine', paymentModeOverride: paymentMode });
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
      if (handlePaymentCompletion) await handlePaymentCompletion(transaction);
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
    if (handlePaymentCompletion) await handlePaymentCompletion(transaction);
  } catch (error) { console.error('Webhook error:', error.message); }
});

}

module.exports = {
  register,
  pollActiveTxns,
  pushDraftOrderToTerminal,
  parseTerminalTag,
  getPinePaymentMode,
  // Exported for tests and for the eventual lift into the admin actions app.
  getPineApiUrl, getPineStatusResult, parsePineCSV,
  makePineTransactionNumber, extractPineTransactionData, resolveStoreForLocation,
};
