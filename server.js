require('dotenv').config();
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { config, flagOn } = require('./src/core/config');
const { log } = require('./src/core/logger');
const { getMetafieldType, updateDraftOrderMetafields, updateOrderMetafields } = require('./src/core/metafields');
const { sendEmail, sendDepositEmail, withStoreCc } = require('./src/integrations/email');
// Customer-facing voucher / exchange-note bodies use the v2 templates (2026-08-07 redesign).
const { buildVoucherV2Html, buildExchangeNoteV2Html } = require('./src/integrations/email/templates');
const { startVoucherExpirySweep } = require('./src/modules/adjustments/voucher_expiry_sweep');
const { handlePoWebhook } = require('./src/modules/procurement/webhook');
const { handlePoAction }  = require('./src/modules/procurement/action');
const { syncDraftOrderToSheet, syncOrderToSheet, syncAllDraftOrders, syncAllOrders, removeDraftFromSheet, pruneOrphans } = require('./src/modules/procurement/sync');
const { batchRaisePo } = require('./src/modules/procurement/batch');
const { createPaymentLink: createGokwikLink, cancelPaymentLink: cancelGokwikLink } = require('./src/integrations/gokwik');
const { sendSMS } = require('./src/integrations/sms');
const { registerRepairRoutes, handleRepairPayment, handleRepairDraftUpdate } = require('./src/modules/after-sales');
const serialization = require('./src/modules/serialization');
const creditInstruments = require('./src/modules/adjustments/credit_instruments');
const { handleTypeformWebhook } = require('./src/integrations/typeform');

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.text({ type: '*/*' }));

// Shared primitives live in src/core/ — one definition, one place to change.
const { supabase } = require('./src/core/supabase');
const {
  getShopifyToken, initShopifyToken, shopifyHeaders,
  getBuyingRateTable, buyingRateFor,
} = require('./src/core/shopify');

const AUTO_PUSH_TO_TERMINAL       = config.auto.pushToTerminal;
const AUTO_CONVERT_DRAFT_TO_ORDER = config.auto.convertDraftToOrder;
const AUTO_SEND_DRAFT_INVOICE     = config.auto.sendDraftInvoice;
const AUTO_SEND_DEPOSIT_EMAIL     = config.auto.sendDepositEmail;

// Serialization feature flags — wire one doc type at a time.
// Lenient parse so True/TRUE/1/yes/whitespace all count as on.
const SERIAL_CUSTOMER_ORDER = config.serial.customerOrder;
const SERIAL_REPAIR         = config.serial.repair;
const SERIAL_MEMO_TRANSFER  = config.serial.memoTransfer;
const SERIAL_PO             = config.serial.po;

// Customer-order serials only mint for orders created on/after this cutoff (IST).
// Overridable via env; default = 1 Aug 2026 so July (and earlier) orders are never auto-numbered.
const SERIAL_CUSTOMER_ORDER_START = config.serial.customerOrderStart;

// Typeform in-store customer capture -> Shopify customer + metafields.
app.post('/api/webhooks/typeform/customer-capture',
  (req, res) => handleTypeformWebhook(req, res, { supabase, getShopifyToken }));

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

async function tagShopifyDraftOrder(shopifyDraftId, amountPaid, amountPending, status, paymentMode = null, installmentType = null) {
  try {
    const token = await getShopifyToken();
    const getResponse = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const existingTags = getResponse.data.draft_order.tags || '';
    const cleanedTags = existingTags
      .split(',').map(t => t.trim())
      .filter(t => {
        if (!t) return false;
        if (t.startsWith('paid:') || t.startsWith('pending:') || t.startsWith('deposit:')) return false;
        // On final: keep pmode-advance (advance mode must survive), strip only pmode-final
        if (installmentType === 'final') return !t.startsWith('pmode-final:');
        // On advance or unknown: clean slate for all pmode tags
        return !t.startsWith('pmode-advance:') && !t.startsWith('pmode-final:');
      })
      .join(', ');
    const newTag = status === 'paid'
      ? `deposit:fully-paid, paid:Rs${amountPaid.toFixed(0)}`
      : `deposit:partial, paid:Rs${amountPaid.toFixed(0)}, pending:Rs${amountPending.toFixed(0)}`;
    const pmodeTag = paymentMode && installmentType
      ? `, pmode-${installmentType}:${paymentMode}`
      : '';
    const finalTags = cleanedTags ? `${cleanedTags}, ${newTag}${pmodeTag}` : `${newTag}${pmodeTag}`;
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

// Rupees of outstanding balance below which an order counts as fully paid. ONE definition — the
// "fully paid" test used to differ by caller (<= 0.01 on the store_deposits path, < 1 on the
// metafield path, plus a "payment_status already says Full" latch), so the same order could be
// simultaneously fully paid and partially paid depending on which surface you asked.
const PAID_EPSILON = 1;

// Metafield read/write lives in src/core/metafields.js — one writer for both draft_orders
// and orders, which used to be two near-identical copies here.


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

// Mints a service serial for a repair draft via the v2 ledger, at the repair-complete trigger
// (not intake) so abandoned intakes never burn a number. Paid repairs use the customer_service
// counter (TS{FY}-{CODE}-{SEQ}, shared with CAD/design); free/complimentary repairs use a SEPARATE
// free_service counter (FS{FY}-{CODE}-{SEQ}) — pass opts.free to route there. Store code = the
// draft's staff-set custom.state_code (place of supply); blank → skip (staff hasn't set it). The
// ledger's (doc_type,resource_id) unique constraint makes this idempotent. Non-throwing.
// Accepts the draft object (preferred) or a bare draft id.
async function assignRepairSerial(draft, opts = {}) {
  if (!SERIAL_REPAIR) return null;
  const draftId = (draft && typeof draft === 'object') ? draft.id : draft;
  const docType = opts.free ? 'free_service' : 'customer_service';
  try {
    const deps  = SERIAL_DEPS();
    const token = await getShopifyToken();
    const mf = await serialization.readSerialMetafields(deps, 'draft_orders', String(draftId), token);
    const storeCode = (mf.state_code || '').toUpperCase().trim();
    if (!storeCode) {
      console.log(`[serial] repair ${draftId}: no state_code set — skipping mint`);
      return null;
    }
    const r = await serialization.mintSerial(deps, {
      docType, storeCode,
      resourceType: 'draft_order', resourceId: String(draftId),
      resourceName: (draft && typeof draft === 'object') ? draft.name : null,
      stamp: true,
    });
    if (r.minted) console.log(`[serial] ${docType} (repair) draft ${draftId} → ${r.serial_code}`);
    return r;
  } catch (err) {
    console.error(`[serial] repair assign failed for ${draftId}:`, err.message);
    return null;
  }
}

// Mints a per-store serial for a memo/transfer draft via the v2 ledger (Stage 4b).
// Store code: a `state:XX` tag → the draft's staff-set custom.state_code.
// Delivery code (destination): the draft's staff-set custom.delivery_code (required).
// Idempotent via the ledger's (doc_type,resource_id) constraint; once a serial exists the
// trigger tag is cleared so the draft-update webhook stops re-firing.
async function assignDocSerial(draft, docType, removeTag = null) {
  try {
    const deps  = SERIAL_DEPS();
    const token = await getShopifyToken();
    const mf = await serialization.readSerialMetafields(deps, 'draft_orders', String(draft.id), token);

    const stateTag  = (draft.tags || '').split(',').map(t => t.trim()).find(t => /^state:/i.test(t));
    const storeCode = (stateTag ? stateTag.split(':')[1] : (mf.state_code || '')).toUpperCase().trim();
    if (!storeCode) { console.log(`[serial] ${docType} draft ${draft.id}: no store code yet — skipping`); return; }

    // Destination is optional now — DC/b2b serials encode origin only; delivery_code (when set) is
    // still captured on the resource for the document body, just not required to mint.
    const deliveryCode = (mf.delivery_code || '').toUpperCase().trim();

    const r = await serialization.mintSerial(deps, {
      docType, storeCode, deliveryCode,
      resourceType: 'draft_order', resourceId: String(draft.id), resourceName: draft.name,
      stamp: true,
    });
    if (r.minted) console.log(`[serial] ${docType} draft ${draft.id} → ${r.serial_code}`);
    // Clear the trigger tag whether we just minted or it was already in the ledger — the doc is numbered.
    if (removeTag) await removeTagFromDraft(String(draft.id), removeTag);
  } catch (err) {
    console.error(`[serial] ${docType} assign failed for ${draft.id}:`, err.message);
  }
}

// Retires a delivery_challan/b2b serial when staff tag the draft cancel-challan / cancel-transfer.
// Number is marked cancelled in the ledger and never reused (GST-clean audit).
async function cancelDocSerial(draft, docType, removeTag = null) {
  try {
    const r = await serialization.cancelSerial(SERIAL_DEPS(), { docType, resourceId: String(draft.id) });
    if (r) console.log(`[serial] ${docType} draft ${draft.id} serial retired (cancelled)`);
    if (removeTag) await removeTagFromDraft(String(draft.id), removeTag);
  } catch (err) {
    console.error(`[serial] ${docType} cancel failed for ${draft.id}:`, err.message);
  }
}

// Detects draft-document trigger tags and mints/retires the matching serial.
//   make-challan     → delivery_challan (DC-…),  retire on cancel-challan
//   make-transfer    → b2b (AURA-… ; B2B tax invoice == inter-store transfer == sale), retire on cancel-transfer
//   make-memo-custom → memo_custom (MEMO-… ; gold + making + 50% diamond custom memo), retire on cancel-memo-custom
// (PO is no longer minted here — it mints at HQ acknowledge in handlePoAction.)
// Pricing for make-memo-custom and make-transfer is applied separately by handleWeightedDocReprice (runs earlier in the webhook).
async function handleDocumentSerialTags(draft) {
  if (!SERIAL_MEMO_TRANSFER) return;
  const tags = (draft.tags || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('make-challan'))          await assignDocSerial(draft, 'delivery_challan', 'make-challan');
  else if (tags.includes('make-transfer'))    await assignDocSerial(draft, 'b2b', 'make-transfer');
  else if (tags.includes('make-memo-custom')) await assignDocSerial(draft, 'memo_custom', 'make-memo-custom');
  else if (tags.includes('cancel-challan'))   await cancelDocSerial(draft, 'delivery_challan', 'cancel-challan');
  else if (tags.includes('cancel-transfer'))  await cancelDocSerial(draft, 'b2b', 'cancel-transfer');
  else if (tags.includes('cancel-memo-custom')) await cancelDocSerial(draft, 'memo_custom', 'cancel-memo-custom');
}

// Net-to-collect base for a draft = total − ALL post-tax adjustments (exchange/voucher/old-gold/advance),
// as frozen in custom.amount_to_be_collected by syncAmountToCollect on every draft change. Payment
// surfaces (amount_pending, deposit balance, tags, emails) must reconcile against THIS, not the gross
// total — otherwise a customer with adjustments is over-billed. Falls back to the raw total when the
// field is absent (legacy drafts / webhook race / pure-online). Always returns a finite number ≥ 0.
async function getCollectionBase(draftOrderId, fallbackTotal) {
  const fallback = parseFloat(fallbackTotal) || 0;
  try {
    const token = await getShopifyToken();
    const { data } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const m = (data.metafields || []).find(x => x.namespace === 'custom' && x.key === 'amount_to_be_collected');
    const v = m ? parseFloat(m.value) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch (e) {
    console.error(`getCollectionBase(${draftOrderId}) failed: ${e.message} — using raw total ${fallback}`);
    return fallback;
  }
}

// Payment installments — pure helpers live in src/modules/payments/installments.js so the
// backfill script and unit tests can use the same arithmetic. See that file for the data model.
const {
  MAX_INSTALLMENTS, readInstallments, sumInstallments, installmentModes, installmentLegPatch,
  materializeLegacyLeg,
} = require('./src/modules/payments/installments');
const backfillInstallments = require('./src/modules/payments/backfill-installments');

// What a draft has been paid, in Rs — read from the metafields. The metafields are the surface
// staff type into and the invoice reads, so they are the union of every payment route: the panel
// writes them directly, and the cash/gateway paths write them too.
//
// Legacy fallback: drafts predating installments carry only amount_paid (+ amount_paid_final).
// While dual-write is on, fall back to those so a mid-migration payment never resets a recorded
// balance to zero.
async function getInstallmentState(draftOrderId) {
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  try {
    const token = await getShopifyToken();
    const { data } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const map = {};
    for (const m of (data.metafields || [])) if (m.namespace === 'custom') map[m.key] = m.value;
    const rows = readInstallments(map);
    const legacyTotal = num(map.amount_paid) + num(map.amount_paid_final);
    return { rows, total: rows.length ? sumInstallments(rows) : legacyTotal, legacyTotal, map };
  } catch (e) {
    console.error(`getInstallmentState(${draftOrderId}) failed: ${e.message} — assuming 0`);
    return { rows: [], total: 0, legacyTotal: 0, map: {} };
  }
}

// Reconcile a store_deposits row against the metafields BEFORE recording a new payment.
//
// The panel writes amount_paid straight to the metafield and never touches Supabase, so a
// staff-entered payment is invisible to the deposit row. Without this, a draft with a panel-entered
// Rs10,000 advance and no deposit row would take a Rs37,573.19 cash payment, create the row at
// amount_paid 0, label the payment 'advance' (payment_status === 'unpaid'), and overwrite the
// staff-entered advance — silently destroying Rs10,000 of recorded collection.
//
// We take the HIGHER of the two as the base: money that either surface believes was collected is
// never dropped. A divergence means one side missed a write, so it is logged rather than swallowed.
//
// Returns the installment state alongside, so callers can place the new leg without re-fetching.
// installmentType is retained ONLY for the store_deposit_payments audit column and the legacy
// pmode-*/payment_mode_* dual-write; it no longer drives any balance arithmetic.
async function reconcileDepositPaid(draftOrderId, deposit) {
  const dbPaid = parseFloat(deposit?.amount_paid) || 0;
  const state = await getInstallmentState(draftOrderId);
  const mfPaid = state.total;
  const basePaid = Math.max(dbPaid, mfPaid);
  if (Math.abs(dbPaid - mfPaid) >= 0.5) {
    console.warn(`[payments] draft ${draftOrderId}: deposit/metafield divergence — store_deposits=Rs${dbPaid.toFixed(2)} metafields=Rs${mfPaid.toFixed(2)} → using Rs${basePaid.toFixed(2)}`);
  }
  return { basePaid, state, installmentType: basePaid > 0 ? 'final' : 'advance' };
}

// Metafield patch recording ONE new payment leg plus the derived cumulative total.
//
// amount_paid now carries the FULL cumulative figure, and amount_paid_final is pinned to 0.
// That keeps both generations of reader correct with no branching: readers that take amount_paid
// alone (all four invoice templates, the sales report) get the true total — which is the
// under-reporting bug fixed — and readers that sum amount_paid + amount_paid_final (the tag
// engine, the adjustment report) get total + 0. Splitting the value across both fields instead
// would make the summing readers double-count.
function paymentLegPatch(state, { value, mode, date }, cumulativePaid) {
  // Fold any pre-installment balance into its own leg FIRST, so the new payment lands in the next
  // free slot after it and the leg sum reconciles to amount_paid. Without this the older money has
  // no leg, and the next recompute writes the balance down by exactly that amount.
  const { rows, patch: legacyPatch } = materializeLegacyLeg(state.map, state.rows);
  const patch = Object.assign({}, legacyPatch, installmentLegPatch(rows, { value, mode, date }));
  patch.amount_paid = cumulativePaid.toFixed(2);
  patch.amount_paid_final = '0'; // legacy field, retired at rollout step 6
  return patch;
}

async function handlePaymentCompletion(transaction, overrides = {}) {
  if (!transaction.shopify_draft_id) return;
  const { utr = null, paymentSource = 'pine', paymentModeOverride = null } = overrides;
  const paymentMode = paymentModeOverride || transaction.payment_mode || 'pos';

  if (transaction.is_partial) {
    console.log(`Partial payment confirmed — draft ${transaction.shopify_draft_id} source=${paymentSource}`);
    const amountPaidRupees = transaction.amount_paisa / 100;

    let { data: deposit } = await supabase
      .from('store_deposits').select('*')
      .eq('draft_order_id', transaction.shopify_draft_id).maybeSingle();

    if (!deposit) {
      let totalRupees;
      try {
        const token = await getShopifyToken();
        const { data: draftData } = await axios.get(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${transaction.shopify_draft_id}.json`,
          { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
        );
        totalRupees = parseFloat(draftData.draft_order.total_price);
        console.log(`Draft ${transaction.shopify_draft_id}: order total from Shopify = Rs${totalRupees}`);
      } catch (fetchErr) {
        console.error(`Draft ${transaction.shopify_draft_id}: could not fetch order total — ${fetchErr.message}`);
        totalRupees = transaction.total_amount_paisa ? transaction.total_amount_paisa / 100 : amountPaidRupees;
      }
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

    // Base this payment on what EITHER surface already recorded — see reconcileDepositPaid.
    const { basePaid, installmentType, state } = await reconcileDepositPaid(transaction.shopify_draft_id, deposit);
    const newAmountPaid    = basePaid + amountPaidRupees;
    // Reconcile against the net-to-collect (refreshed here so adjustments applied AFTER the deposit
    // row was created still land), never the gross total.
    const collectionBase   = await getCollectionBase(transaction.shopify_draft_id, deposit.total_amount);
    const newAmountPending = collectionBase - newAmountPaid;
    const newStatus        = newAmountPending < PAID_EPSILON ? 'paid' : 'partial';

    await supabase.from('store_deposits').update({
      total_amount:   collectionBase,
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

    await tagShopifyDraftOrder(transaction.shopify_draft_id, newAmountPaid, Math.max(0, newAmountPending), newStatus, paymentMode, installmentType);

    const metafieldUpdate = {
      payment_status:  newStatus === 'paid' ? 'Full' : 'Partial',  // choice-list values: Partial|Full|None
      // Record this payment as its OWN installment leg (value + mode + date) and set amount_paid to
      // the cumulative sum. Payments arrive incrementally here, so we append rather than replace.
      ...paymentLegPatch(state, { value: amountPaidRupees, mode: paymentMode, date: new Date().toISOString().slice(0, 10) }, newAmountPaid),
      amount_pending:  Math.max(0, newAmountPending).toFixed(2)
    };
    // DUAL-WRITE (remove at rollout step 6): legacy two-slot modes, still read by unmigrated
    // invoice templates and the sales report until they move to the installment legs.
    if (installmentType === 'advance') {
      metafieldUpdate.payment_mode_advance = paymentMode;
    }
    if (installmentType === 'final') metafieldUpdate.payment_mode_final = paymentMode;
    // Track the balance both ways — is_finalized drives is_fully_paid on the tax invoice.
    metafieldUpdate.is_finalized = newStatus === 'paid' ? 'true' : 'false';
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
      resendApiKey:        process.env.RESEND_API_KEY        ? 'SET' : 'MISSING ⚠️',
      // Repair wallet refunds post the voucher-issue request to the sheet, and build their own
      // signed callback URL. Both fail SOFT (the customer sees "we're on it"), so a missing secret
      // is invisible in production unless it is surfaced here.
      appsScriptUrl:         process.env.APPS_SCRIPT_URL          ? 'SET' : 'MISSING ⚠️',  // PO Tracker web app
      exchangeAppsScriptUrl: process.env.EXCHANGE_APPS_SCRIPT_URL ? 'SET' : 'MISSING ⚠️',  // Exchange Calculator (CN Log) web app
      serverUrl:           process.env.SERVER_URL            ? 'SET' : 'defaulting to timanti-middleware.fly.dev'
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

// GET /api/draft-orders-report
// Query params (all optional):
//   from=YYYY-MM-DD         created_at_min
//   to=YYYY-MM-DD           created_at_max (inclusive — bumped to end of day)
//   paymentStatus=partial|fully-paid|unpaid
//   paymentMode=cash|upi|...  matches pmode-advance or pmode-final
//   nameFrom=1038  nameTo=1053
// Always fetches open + invoice_sent (active drafts only — completed = already an order)
app.get('/api/draft-orders-report', async (req, res) => {
  try {
    const token   = await getShopifyToken();
    const hdrs    = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };

    const filterPaymentStatus = (req.query.paymentStatus || '').toLowerCase();
    const filterPaymentMode   = (req.query.paymentMode   || '').toLowerCase();
    const filterNameFrom = req.query.nameFrom != null ? parseInt(req.query.nameFrom) : null;
    const filterNameTo   = req.query.nameTo   != null ? parseInt(req.query.nameTo)   : null;

    const baseQp = new URLSearchParams({ limit: '250' });
    if (req.query.from) baseQp.set('created_at_min', new Date(req.query.from).toISOString());
    if (req.query.to)   baseQp.set('created_at_max', new Date(req.query.to + 'T23:59:59Z').toISOString());

    // Fetch open and invoice_sent separately — Shopify has no multi-status param for draft orders
    const startUrls = ['open', 'invoice_sent'].map(s => {
      const qp = new URLSearchParams(baseQp);
      qp.set('status', s);
      return `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json?${qp}`;
    });

    const rows = [];

    for (const startUrl of startUrls) {
      let pageUrl = startUrl;
      while (pageUrl) {
        const { data, headers: respHeaders } = await axios.get(pageUrl, { headers: hdrs, timeout: 30000 });

      for (const d of (data.draft_orders || [])) {
        // Name range filter
        const nameNum = parseInt((d.name || '').replace(/\D/g, ''));
        if (filterNameFrom !== null && nameNum < filterNameFrom) continue;
        if (filterNameTo   !== null && nameNum > filterNameTo)   continue;

        const tags = (d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        const tag  = (prefix) => { const t = tags.find(t => t.startsWith(prefix)); return t ? t.slice(prefix.length) : ''; };

        const depositTag   = tag('deposit:');
        // `pmodes:` is the aggregate covering every installment leg; the two-slot tags are the
        // pre-migration fallback. Matching against the union means the filter sees a mode used in
        // ANY leg, not just the two that used to have named slots.
        const pmodesTag    = tag('pmodes:');
        const pmodeAdvance = tag('pmode-advance:');
        const pmodeFinal   = tag('pmode-final:');
        const allModes     = [...new Set(
          pmodesTag.split('/').concat([pmodeAdvance, pmodeFinal]).filter(Boolean).map(m => m.toLowerCase())
        )];

        const paymentStatus = depositTag === 'fully-paid' ? 'fully-paid'
                            : depositTag === 'partial'    ? 'partial'
                            : 'unpaid';

        if (filterPaymentStatus && paymentStatus !== filterPaymentStatus) continue;
        if (filterPaymentMode && !allModes.includes(filterPaymentMode)) continue;

        // Only relevant payment tags in a comma-separated list
        const paymentTags = tags
          .filter(t => t.startsWith('deposit:') || t.startsWith('paid:') ||
                       t.startsWith('pending:') || t.startsWith('pmode-') || t.startsWith('pmodes:'))
          .join(', ');

        const customer = d.customer
          ? `${d.customer.first_name || ''} ${d.customer.last_name || ''}`.trim()
          : (d.billing_address?.name || '');

        const day = d.created_at ? new Date(d.created_at).toLocaleDateString('en-IN') : '';

        // One row per non-discount line item
        const productItems = (d.line_items || []).filter(
          item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
        );

        for (const item of productItems) {
          const prop = (name) => {
            const p = (item.properties || []).find(p => p.name === name);
            return p ? parseFloat((p.value || '0').replace('Rs', '').trim()) || 0 : 0;
          };

          const grossValue = prop('Gross Value') || parseFloat(item.price) * item.quantity;
          const discount   = prop('Discount Applied');
          const grossSales = parseFloat((grossValue + discount).toFixed(2));
          const netSales   = parseFloat(grossValue.toFixed(2));
          const discounts  = discount > 0 ? parseFloat((-discount).toFixed(2)) : 0;

          rows.push({
            'Day':                    day,
            'Order name':             d.name || '',
            'Product title':          item.title || '',
            'Product variant title':  item.variant_title || '',
            'Customer name':          customer,
            'Gross sales':            grossSales,
            'Discounts':              discounts,
            'Returns':                0,
            'Net sales':              netSales,
            'Shipping charges':       0,
            'Return fees':            0,
            'Taxes':                  0,
            'Total sales':            netSales,
            'Payment Tags':           paymentTags,
          });
        }
      }

        const link = respHeaders['link'] || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        pageUrl = next ? next[1] : null;
      }
    }

    const csvCols = ['Day','Order name','Product title','Product variant title','Customer name',
                     'Gross sales','Discounts','Returns','Net sales','Shipping charges',
                     'Return fees','Taxes','Total sales','Payment Tags'];
    const escape  = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csvLines = [
      csvCols.join(','),
      ...rows.map(r => csvCols.map(c => escape(r[c])).join(',')),
    ];

    const filename = `draft-orders-report-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvLines.join('\r\n'));

  } catch (err) {
    console.error('draft-orders-report error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/serial-report
// Serial report read straight from the v2 serial_ledger (the source of truth — includes both
// active and cancelled/retired numbers, no Shopify GraphQL crawl). Returns JSON rows (default)
// for the reporting Apps Script, or CSV with ?format=csv.
//
// Query params (all optional):
//   docType=customer_order|repair|po|memo|transfer|credit_note
//   state=KA-HSR|MH-HQ|...                (matches ledger store_code)
//   status=active|cancelled|all          (default all — shows retired numbers too)
//   from=YYYY-MM-DD   to=YYYY-MM-DD       (ledger created_at range)
//   format=json|csv                       (default json)
app.get('/api/serial-report', async (req, res) => {
  try {
    const docType = (req.query.docType || '').toLowerCase();
    const state   = (req.query.state || '').toUpperCase();
    const status  = (req.query.status || 'all').toLowerCase();
    const from    = req.query.from || null;
    const to      = req.query.to || null;

    let q = supabase.from('serial_ledger').select('*').order('seq', { ascending: true }).limit(10000);
    if (docType)            q = q.eq('doc_type', docType);
    if (status !== 'all')   q = q.eq('status', status);
    if (from)               q = q.gte('created_at', new Date(from).toISOString());
    if (to)                 q = q.lte('created_at', new Date(to + 'T23:59:59Z').toISOString());

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // store_code may be FY-folded ("27|KA-HSR") for per-FY doc types; compare/show the bare store.
    const bareStore = (sc) => String(sc || '').split('|').pop();
    const filtered = state ? (data || []).filter(r => bareStore(r.store_code).toUpperCase() === state) : (data || []);

    const rows = filtered.map(r => ({
      resource:       r.resource_type || '',
      name:           r.resource_name || '',
      created_at:     r.created_at ? new Date(r.created_at).toLocaleDateString('en-IN') : '',
      customer:       '',   // not tracked in the ledger
      total:          '',   // not tracked in the ledger
      document_type:  r.doc_type || '',
      state_code:     bareStore(r.store_code),
      serial_no:      r.seq != null ? String(r.seq) : '',
      serial_code:    r.serial_code || '',
      serial_display: r.serial_code || '',
      status:         r.status || '',
      cancelled_at:   r.cancelled_at ? new Date(r.cancelled_at).toLocaleDateString('en-IN') : '',
    }));

    if ((req.query.format || 'json').toLowerCase() === 'csv') {
      const cols = ['resource','name','created_at','customer','total','document_type','state_code','serial_no','serial_code','serial_display','status','cancelled_at'];
      const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="serial-report-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }
    return res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('serial-report error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
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

    // Auto-hydrate line item properties (Gold, Diamond, Making, _gold_rate, weights) from variant metafields
    try {
      const token = await getShopifyToken();
      const variantItems = (draft.line_items || []).filter(item => item.variant_id);
      if (variantItems.length > 0) {
        const hydrated = await Promise.all(variantItems.map(item => hydrateItemFromVariant(item, token)));
        const allItems = (draft.line_items || []).map(item => {
          const h = hydrated.find(u => u.id === item.id);
          return h || { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
        });
        await gqlSetDraftLineItems(draft.id.toString(), allItems, token, {});
        console.log(`Draft created: properties hydrated for ${draftOrderName}`);
      }
    } catch (hydrateErr) {
      console.error(`Draft created: hydration failed for ${draftOrderName}:`, hydrateErr.message);
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

  // Label the link by what is already paid across BOTH surfaces (the panel writes the metafield and
  // never touches store_deposits), not by the deposit row's own status. Advisory only — the
  // authoritative stage is re-derived when the payment actually completes.
  const { data: existingDeposit } = await supabase
    .from('store_deposits').select('amount_paid')
    .eq('draft_order_id', draft.id.toString()).maybeSingle();
  const { installmentType } = await reconcileDepositPaid(draft.id.toString(), existingDeposit);

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

// Tag format: cash-AMOUNT  e.g. cash-10000 or cash-10000.50
// Cashier adds this tag in Shopify admin. Middleware records deposit, writes back payment tags,
// and strips the cash tag atomically in a single PUT to prevent webhook re-trigger loops.
async function handleCashPaymentTag(draft) {
  const tags = (draft.tags || '').split(',').map(t => t.trim());
  const cashTag = tags.find(t => /^cash-(\d+(?:\.\d+)?)$/i.test(t));
  if (!cashTag) return;

  const amountRupees = parseFloat(cashTag.replace(/^cash-/i, ''));
  if (!amountRupees || amountRupees <= 0) {
    console.warn(`Draft ${draft.id}: invalid cash tag "${cashTag}", removing`);
    await removeTagFromDraft(draft.id, cashTag);
    return;
  }

  const draftOrderId   = draft.id.toString();
  const draftOrderName = draft.name || draftOrderId;
  const customer       = draft.customer || {};
  const customerName   = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '';

  let totalRupees;
  try {
    const token = await getShopifyToken();
    const { data: draftData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    totalRupees = parseFloat(draftData.draft_order.total_price);
  } catch (fetchErr) {
    console.error(`Cash tag: could not fetch total for draft ${draftOrderId} — ${fetchErr.message}`);
    totalRupees = amountRupees;
  }

  let { data: deposit } = await supabase
    .from('store_deposits').select('*')
    .eq('draft_order_id', draftOrderId).maybeSingle();

  if (!deposit) {
    const { data: newDeposit } = await supabase.from('store_deposits').insert({
      draft_order_id:   draftOrderId,
      draft_order_name: draftOrderName,
      customer_name:    customerName,
      total_amount:     totalRupees,
      amount_paid:      0,
      amount_pending:   totalRupees,
      payment_status:   'unpaid'
    }).select().single();
    deposit = newDeposit;
  }

  if (!deposit) {
    console.error(`Cash tag: could not find or create store_deposits for draft ${draftOrderId}`);
    return;
  }

  // Base this payment on what EITHER surface already recorded — the panel writes the metafield without
  // touching Supabase, so deposit.amount_paid alone would miss a staff-entered advance and clobber it.
  const { basePaid, installmentType, state } = await reconcileDepositPaid(draftOrderId, deposit);
  const newAmountPaid    = basePaid + amountRupees;
  // Reconcile against the net-to-collect (refreshed here so adjustments applied AFTER the deposit
  // row was created still land), never the gross total.
  const collectionBase   = await getCollectionBase(draftOrderId, deposit.total_amount);
  const newAmountPending = collectionBase - newAmountPaid;
  const newStatus        = newAmountPending < PAID_EPSILON ? 'paid' : 'partial';

  await supabase.from('store_deposits').update({
    total_amount:   collectionBase,
    amount_paid:    newAmountPaid,
    amount_pending: Math.max(0, newAmountPending),
    payment_status: newStatus,
    updated_at:     new Date().toISOString()
  }).eq('id', deposit.id);

  await supabase.from('store_deposit_payments').insert({
    deposit_id:       deposit.id,
    draft_order_id:   draftOrderId,
    amount:           amountRupees,
    payment_mode:     'cash',
    notes:            `cash tag ${cashTag}`,
    pine_ptrid:       null,
    recorded_by:      'cash',
    installment_type: installmentType,
    utr:              null,
    payment_source:   'cash',
    created_at:       new Date().toISOString()
  });

  // Strip cashTag + old payment tags, write new payment tags — single atomic PUT prevents re-trigger
  const token = await getShopifyToken();
  const cleanedTags = (draft.tags || '').split(',').map(t => t.trim())
    .filter(t => {
      if (!t) return false;
      if (t.toLowerCase() === cashTag.toLowerCase()) return false;
      if (t.startsWith('paid:') || t.startsWith('pending:') || t.startsWith('deposit:')) return false;
      if (installmentType === 'final') return !t.startsWith('pmode-final:');
      return !t.startsWith('pmode-advance:') && !t.startsWith('pmode-final:');
    });

  const paymentTag = newStatus === 'paid'
    ? `deposit:fully-paid, paid:Rs${newAmountPaid.toFixed(0)}`
    : `deposit:partial, paid:Rs${newAmountPaid.toFixed(0)}, pending:Rs${Math.max(0, newAmountPending).toFixed(0)}`;
  const finalTags = [...cleanedTags, paymentTag, `pmode-${installmentType}:cash`].filter(Boolean).join(', ');

  await axios.put(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    { draft_order: { id: parseInt(draftOrderId), tags: finalTags } },
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 10000 }
  );

  const metafieldUpdate = {
    payment_status:  newStatus === 'paid' ? 'Full' : 'Partial',  // choice-list values: Partial|Full|None
    // Append this payment as its own installment leg — same helper as the gateway path, so the two
    // near-duplicate handlers can no longer drift on the arithmetic that matters.
    ...paymentLegPatch(state, { value: amountRupees, mode: 'cash', date: new Date().toISOString().slice(0, 10) }, newAmountPaid),
    amount_pending:  Math.max(0, newAmountPending).toFixed(2)
  };
  // DUAL-WRITE (remove at rollout step 6): legacy two-slot modes for unmigrated readers.
  if (installmentType === 'advance') metafieldUpdate.payment_mode_advance = 'cash';
  if (installmentType === 'final')   metafieldUpdate.payment_mode_final   = 'cash';
  // Track the balance both ways — is_finalized drives is_fully_paid on the tax invoice.
  metafieldUpdate.is_finalized = newStatus === 'paid' ? 'true' : 'false';
  await updateDraftOrderMetafields(draftOrderId, metafieldUpdate);

  console.log(`✅ Cash Rs${amountRupees} (${installmentType}) recorded for draft ${draftOrderId} — ${newStatus}`);

  if (AUTO_SEND_DEPOSIT_EMAIL) {
    const { data: updatedDeposit } = await supabase.from('store_deposits').select('*').eq('id', deposit.id).single();
    await sendDepositEmail(draftOrderId, draftOrderName, newAmountPaid, Math.max(0, newAmountPending), newStatus, updatedDeposit, getShopifyToken);
  }

  if (newStatus === 'partial' && AUTO_SEND_DRAFT_INVOICE) {
    await sendDraftOrderInvoice(draftOrderId);
  }

  if (newStatus === 'paid') {
    await convertDraftToOrder(draftOrderId, null);
  }
}

// Shared GraphQL helper — replaces all REST draft order line_items PUTs.
// Shopify REST always recreates variant line items and resets price to catalog;
// GraphQL priceOverride (API 2025-01) is the only supported way to set custom prices.
// lineItems: REST-format array { variant_id?, title?, quantity, price, properties, taxable?, requires_shipping? }
// opts: { clearDiscount?: bool, tags?: string, currencyCode?: string }
async function gqlSetDraftLineItems(draftOrderId, lineItems, token, opts = {}) {
  const currency = opts.currencyCode || 'INR';
  const gqlLineItems = lineItems.map(item => {
    const attrs = (item.properties || []).map(p => ({ key: p.name, value: p.value }));
    const priceStr = parseFloat(item.price).toFixed(2);
    if (item.variant_id) {
      return { variantId: `gid://shopify/ProductVariant/${item.variant_id}`, quantity: item.quantity, priceOverride: { amount: priceStr, currencyCode: currency }, customAttributes: attrs };
    }
    return { title: item.title, quantity: item.quantity, originalUnitPriceWithCurrency: { amount: priceStr, currencyCode: currency }, taxable: item.taxable ?? true, requiresShipping: item.requires_shipping ?? false, customAttributes: attrs };
  });
  const input = { lineItems: gqlLineItems };
  if (opts.clearDiscount) input.appliedDiscount = null;
  if (opts.tags !== undefined) input.tags = opts.tags;
  if (opts.noteAttributes) input.customAttributes = opts.noteAttributes.map(a => ({ key: a.name, value: String(a.value) }));
  const mutation = `mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { draftOrder { lineItems(first: 20) { nodes { id originalUnitPrice discountedUnitPrice } } } userErrors { field message } } }`;
  const resp = await axios.post(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2025-01/graphql.json`,
    { query: mutation, variables: { id: `gid://shopify/DraftOrder/${draftOrderId}`, input } },
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  const errors = resp.data?.data?.draftOrderUpdate?.userErrors || [];
  if (resp.data?.errors?.length || errors.length) throw new Error(`GraphQL draftOrderUpdate: ${JSON.stringify(resp.data?.errors || errors)}`);
  return resp.data?.data?.draftOrderUpdate?.draftOrder?.lineItems?.nodes || [];
}

// Fetches variant + product metafields for a line item.
async function fetchItemMeta(item, token) {
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const varMf  = {};
  const prodMf = {};
  if (item.variant_id) {
    const { data: vData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/variants/${item.variant_id}/metafields.json`,
      { headers, timeout: 10000 }
    );
    for (const m of (vData.metafields || [])) if (m.namespace === 'custom') varMf[m.key] = m.value;
  }
  if (item.product_id) {
    const { data: pData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/products/${item.product_id}/metafields.json`,
      { headers, timeout: 10000 }
    );
    for (const m of (pData.metafields || [])) if (m.namespace === 'custom') prodMf[m.key] = m.value;
  }
  return { varMf, prodMf };
}

// Stamps Gold/Diamond/Making/physical props from variant metafields onto a line item.
// Bootstraps _gold_rate from variant if not already locked. Does NOT change price.
async function hydrateItemFromVariant(item, token) {
  const { varMf, prodMf } = await fetchItemMeta(item, token);
  // Variant weight metafields. GROSS comes from gross_weight_g — that is the only key that means
  // gross. `gross_wt` is a legacy key most variants do not carry, and total_metal_weight_g is
  // frequently set equal to NET, so reading it as gross silently printed the net weight in the
  // gross column (order #1069: gross_weight_g 6.656, total_metal_weight_g 5.45, net 5.45 — the
  // invoice showed 5.45 for both). Prefer the explicit key, keep the others as fallbacks.
  const grossWt    = parseFloat(varMf.gross_weight_g || varMf.gross_wt || varMf.total_metal_weight_g || 0);
  const netWt      = parseFloat(varMf.net_wt   || varMf.net_metal_weight_g   || 0);
  const diaCts     = parseFloat(prodMf.totaldiamondweight || 0);
  const gemCts     = parseFloat(prodMf.gemstone_weight    || 0);
  const goldVal    = parseFloat(varMf.price_breakup_gold    || 0) * item.quantity;
  const diaVal     = parseFloat(varMf.price_breakup_diamond || 0) * item.quantity;
  const makingVal  = parseFloat(varMf.price_breakup_making  || 0) * item.quantity;
  const grossVal   = goldVal + diaVal + makingVal;
  const jewel_code = varMf.jewel_code || '';
  const goldRate   = varMf.gold_rate  || '';
  const hydratedProps = { '_jewel_code': jewel_code };
  if (grossWt > 0)   hydratedProps['_gross_wt']     = grossWt.toFixed(3);
  if (netWt > 0)     hydratedProps['_net_wt']       = netWt.toFixed(3);
  if (diaCts > 0)    hydratedProps['_diamond_cts']  = diaCts.toFixed(2);
  if (gemCts > 0)    hydratedProps['_gemstone_cts'] = gemCts.toFixed(2);
  // Taxable Value is written only by reprice/recalculate — its presence means the item has
  // already been through the pricing engine. Don't overwrite the computed Gold/Making/Gross Value
  // with the stale catalog values from the variant metafield (price_breakup_*).
  const alreadyPriced = (item.properties || []).some(p => p.name === 'Taxable Value');
  if (!alreadyPriced) {
    if (goldVal > 0)   hydratedProps['Gold']         = `Rs${goldVal.toFixed(2)}`;
    if (diaVal > 0)    hydratedProps['Diamond']      = `Rs${diaVal.toFixed(2)}`;
    if (makingVal > 0) hydratedProps['Making']       = `Rs${makingVal.toFixed(2)}`;
    if (grossVal > 0)  hydratedProps['Gross Value']  = `Rs${(grossVal * 1.03).toFixed(2)}`;  // tax-inclusive (components + 3% GST), matches the charged catalog price
  }
  const updatedProps = (item.properties || [])
    .filter(p => !(p.name in hydratedProps))
    .concat(Object.entries(hydratedProps).map(([n, v]) => ({ name: n, value: v })));
  // Bootstrap _gold_rate from variant only if not already locked on the line item
  const hasLockedRate = (item.properties || []).some(p => p.name === '_gold_rate');
  if (!hasLockedRate && goldRate) updatedProps.push({ name: '_gold_rate', value: goldRate });
  return { id: item.id, variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: updatedProps, title: item.title, varMf };
}

// Exchange Note line: a negative custom line item applied by /api/exc-redeem. It is a POST-tax
// trade-in adjustment, NOT a discount — it must be excluded from the pricing/GST engine (never
// counted into gross_total, never repriced) and always preserved verbatim on the draft. Identified
// by the title (human-guaranteed by /api/exc-redeem) or the durable _exc_ref machine marker.
function isExcLine(item) {
  return (item.title || '').startsWith('Exchange Note ') ||
         (item.properties || []).some(p => p.name === '_exc_ref');
}

// Hydrates Gold/Diamond/Making/_gold_rate properties from variant metafields on a freshly created draft.
// Fires on draft_orders/create webhook — never changes price, only populates breakdown properties.
async function handleDraftCreated(draft) {
  const draftOrderId = draft.id?.toString();
  if (!draftOrderId) return;

  const productItems = (draft.line_items || []).filter(item =>
    item.variant_id && !isExcLine(item) &&
    !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
  );
  if (productItems.length === 0) return;

  const token    = await getShopifyToken();
  const hydrated = await Promise.all(productItems.map(item => hydrateItemFromVariant(item, token)));

  const anyUseful = hydrated.some(h => (h.properties || []).some(p => p.name === 'Gold'));
  if (!anyUseful) return;

  const allUpdatedItems = (draft.line_items || []).map(item => {
    const h = hydrated.find(u => u.id === item.id);
    return h
      ? { variant_id: h.variant_id, quantity: h.quantity, price: h.price, properties: h.properties, title: item.title }
      : { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
  });

  await gqlSetDraftLineItems(draftOrderId, allUpdatedItems, token, {});
  console.log(`Draft ${draftOrderId}: created — hydrated ${hydrated.filter(h => (h.properties || []).some(p => p.name === 'Gold')).length}/${productItems.length} items`);
}

// ─────────────────────────────────────────
// Discount economics — the ONE place that resolves a discount to rupees.
// ─────────────────────────────────────────
// Every discount lands on the DIAMOND component only, PRE-tax. The two instruments differ only in
// how their rupee figure is derived — never in where it lands:
//
//   custom (staff-entered % or flat Rs)
//     The figure is already a reduction on the taxable diamond value. Base = PRE-tax diamond total,
//     prorated across lines by diamond value. No 1.03 anywhere.
//
//   code (a real Shopify code, e.g. FNF5)
//     Shopify computes it against TAX-INCLUSIVE prices (our prices are GST-inclusive), order-wide.
//     So: take the figure on the tax-inclusive line totals, prorate by LINE TOTAL (mirroring Shopify's
//     own allocation), then divide by 1.03 to convert each share into pre-tax rupees before it lands
//     on diamond. The 1.03 here is a UNIT CONVERSION at the boundary, not a tax rule.
//
// Resolving from the stored RATE (not a frozen rupee amount) on every reprice is what makes the
// discount independent of weights/carats/products: apply it before or after, the % re-derives against
// whatever the diamond is worth now. `discount_applied` is downstream-authoritative and ALWAYS pre-tax,
// so every reader uses one formula: taxable = gross/1.03 - discount_applied.
//
// lines: [{ diamond, grossIncl }] — diamond = PRE-discount diamond value, grossIncl = PRE-discount
// tax-inclusive line total. Returns { perLine: [preTaxRs], total } capped so no line goes negative.
function resolveDiscount({ kind, mode, rate, lines }) {
  const zero = { perLine: lines.map(() => 0), total: 0 };
  const r = Math.abs(parseFloat(rate) || 0);
  if (!(r > 0) || !lines.length) return zero;

  const diaTotal   = lines.reduce((s, l) => s + (l.diamond   || 0), 0);
  const grossTotal = lines.reduce((s, l) => s + (l.grossIncl || 0), 0);
  if (!(diaTotal > 0)) return zero;   // nothing to discount

  let perLine;
  if (kind === 'code') {
    // Tax-inclusive basis → prorate by line total → convert each share to pre-tax.
    const inclTotal = mode === 'pct' ? (r / 100) * grossTotal : r;
    perLine = lines.map(l => {
      const share = grossTotal > 0 ? inclTotal * ((l.grossIncl || 0) / grossTotal) : 0;
      return share / 1.03;
    });
  } else {
    // Pre-tax diamond basis → prorate by diamond value.
    const preTaxTotal = mode === 'pct' ? (r / 100) * diaTotal : r;
    perLine = lines.map(l => (diaTotal > 0 ? preTaxTotal * ((l.diamond || 0) / diaTotal) : 0));
  }

  // A discount can never exceed the diamond it lands on (per line, so no line can go negative).
  perLine = perLine.map((d, i) => Math.min(Math.max(0, d), lines[i].diamond || 0));
  const total = perLine.reduce((s, d) => s + d, 0);
  return { perLine, total };
}

// Per-line, stackable discounts entered per line item. Stored on the draft as custom.line_discounts —
// a JSON array indexed by product-line position; each element is an array of entries. An empty array /
// null for a line means "no per-line discount" so the caller falls back to the order-level discount
// (per-line replaces order-level). Tolerant of bad/empty JSON.
//   entry = { t, m, v, src? }
//     t (target): "dia" (diamond) | "mk" (making) | "total" (whole tax-inclusive product price)
//     m (mode):   "pct" | "flat"
//     v (value):  percent, or rupees (pre-tax for dia/mk which are already pre-tax; the "total" target
//                 is a tax-inclusive figure and is converted to pre-tax by ÷1.03 here)
//     src:        "native" for captured Shopify collection/code discounts (informational; treated same)
function parseLineDiscounts(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Resolve one line's stacked per-line discounts to PRE-TAX rupees, split by target and each capped at the
// base it lands on — dia ≤ diamond, mk ≤ making, total ≤ line taxable — so no component and no line can go
// negative. "total" entries (native collection/order discounts, which are on the tax-inclusive product
// price) are divided by 1.03 to reach pre-tax, matching every downstream reader. Returns null when the
// line carries no entries, signalling the caller to use the order-level discount instead.
//   base: { diamond, making, grossIncl } — PRE-discount component values, and the tax-inclusive line total.
// Returns { total, diaPortion, mkPortion, totalPortion } in pre-tax Rs.
function resolveLineDiscount(entries, { diamond = 0, making = 0, grossIncl = 0 }) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const taxable = grossIncl / 1.03;
  let diaCut = 0, mkCut = 0, totCut = 0;
  for (const e of entries) {
    if (!e) continue;
    const v = Math.abs(parseFloat(e.v) || 0);
    if (!(v > 0)) continue;
    const pct    = String(e.m || 'flat').toLowerCase() === 'pct';
    const target = String(e.t || 'dia').toLowerCase();
    if (target === 'mk' || target === 'making') {
      mkCut  += pct ? (v / 100) * making  : v;
    } else if (target === 'total' || target === 'line' || target === 'native') {
      // On the tax-inclusive product price → convert the resulting rupees to pre-tax.
      totCut += (pct ? (v / 100) * grossIncl : v) / 1.03;
    } else {
      diaCut += pct ? (v / 100) * diamond : v;
    }
  }
  const diaPortion   = Math.min(diaCut, Math.max(0, diamond));
  const mkPortion    = Math.min(mkCut,  Math.max(0, making));
  const totalPortion = Math.min(totCut, Math.max(0, taxable));
  // Final clamp: component + whole-line discounts together can't exceed the line's taxable value.
  const total = Math.min(diaPortion + mkPortion + totalPortion, Math.max(0, taxable));
  return { total, diaPortion, mkPortion, totalPortion };
}

// Read the stored discount intent off the draft's custom metafields. Falls back to the legacy
// frozen-rupee field (discount_applied with no rate) so drafts discounted before the rate migration
// still resolve — treated as a pre-tax flat amount, which is what that field always meant for custom.
function readDiscountIntent(mfMap) {
  const rate = parseFloat(mfMap['discount_rate']);
  if (rate > 0) {
    return {
      kind: (mfMap['discount_kind'] || 'custom').toLowerCase() === 'code' ? 'code' : 'custom',
      mode: (mfMap['discount_mode'] || 'flat').toLowerCase() === 'pct' ? 'pct' : 'flat',
      rate,
    };
  }
  const legacy = Math.abs(parseFloat(mfMap['discount_applied'] || 0)) || 0;
  return legacy > 0 ? { kind: 'custom', mode: 'flat', rate: legacy, legacy: true } : null;
}

// Tags: recalculate-price (threshold — reprice only if delta > 5%) | reprice (blanket — always reprices, or fixes discount/GST if no weights)
// Both modes always write jewel hidden props (_net_wt, _gross_wt, _jewel_data, etc.) to the line item.
// Gold rate override: if custom.gold_rate is set on the draft order metafields, it overrides _gold_rate and bypasses the 5% threshold.
// Tag is removed atomically in the same GraphQL call (loop prevention).
async function handleRecalculatePriceTag(draft, { force = false } = {}) {
  const tagToProcess = force ? 'reprice' : 'recalculate-price';
  console.log(`handleRecalculatePriceTag called — draft=${draft?.id}, force=${force}, tags="${draft?.tags}"`);
  const tags = (draft.tags || '').split(',').map(t => t.trim());
  if (!tags.some(t => t.toLowerCase() === tagToProcess)) {
    console.log(`handleRecalculatePriceTag: no ${tagToProcess} tag, skipping`);
    return;
  }

  const draftOrderId = draft.id;
  const token = await getShopifyToken();
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const tagsWithoutRecalc = tags.filter(t => t && t.toLowerCase() !== tagToProcess).join(', ');

  // Fetch jewel metafields set manually by staff
  const { data: mfData } = await axios.get(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const mfMap = {};
  for (const mf of (mfData.metafields || [])) {
    if (mf.namespace === 'custom') mfMap[mf.key] = mf.value;
  }

  // Draft metafield values can be comma-separated, positional per line item: "5.2, 3.8" → item[0]=5.2, item[1]=3.8
  const csvF = (key) => (mfMap[key] || '').split(',').map(s => { const f = parseFloat(s.trim()); return isNaN(f) ? null : f; });
  const csvI = (key) => (mfMap[key] || '').split(',').map(s => { const i = parseInt(s.trim());  return isNaN(i) ? null : i; });

  // Gold rate override: custom.gold_rate on the draft overrides the locked per-item _gold_rate and
  // bypasses the 5% threshold. It is STRICTLY POSITIONAL per product, comma-separated:
  //   "9713,10200" → item[0]@9713/g, item[1]@10200/g. A single value "9713" is item[0] ONLY (i.e. "9713,")
  //   — it does NOT broadcast to every line; other positions fall back to their locked _gold_rate. This
  //   matches every other positional field (net/gross weight, making): absence of a comma is not "apply to
  //   all", it's "only the first item is set". Enter rates WITHOUT thousands separators (comma = delimiter).
  const goldRateArr = csvF('gold_rate');
  const goldRateForIdx = (idx) => {
    if (!goldRateArr.some(r => r && r > 0)) return null;
    const r = goldRateArr[idx] ?? null;
    return (r && r > 0) ? r : null;
  };

  // Making (labour) override: custom.making sets a FLAT labour amount in Rs, replacing the variant's
  // price_breakup_making. STRICTLY POSITIONAL per product: "1900,2500" → item[0]=Rs1900, item[1]=Rs2500;
  // a single value "1900" is item[0] ONLY (equivalent to "1900,") and does NOT broadcast — other positions
  // fall back to the variant spec. A blank position ("1900,") leaves that item on the variant spec. It is
  // the whole labour for the line (already × qty) — not a per-gram rate — so it is used verbatim. 0 is a
  // legitimate value (labour waived), which is why this returns null-vs-number rather than falsy-checking.
  const makingArr = csvF('making');
  const makingForIdx = (idx) => {
    if (!makingArr.some(v => v !== null && v >= 0)) return null;
    const v = makingArr[idx] ?? null;
    return (v !== null && v >= 0) ? v : null;
  };

  const netWtArr   = csvF('jewelcode_net_weight');
  const grossWtArr = csvF('jewelcode_gross_weight');
  const diaCtsArr  = csvF('jewelcode_diamond_carats');
  const gemWtArr   = csvF('jewelcode_gemstone_weight');

  const hasAnyNetWt = netWtArr.some(v => v !== null && v > 0);

  // EXC lines are excluded here so they never enter gross_total / GST math and are never repriced.
  // The full-set rebuild below re-sends them verbatim (they're never in repricedMap), so the
  // post-tax trade-in deduction simply rides the draft total.
  const productItems = (draft.line_items || []).filter(item =>
    !isExcLine(item) &&
    !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0) &&
    ((item.properties || []).some(p => p.name === 'Gold') || !!item.variant_id)
  );

  const writeJewelcodeMetafield = async (jewel_data) => {
    try {
      const existingMf = (mfData.metafields || []).find(m => m.namespace === 'timanti' && m.key === 'jewelcode');
      const mfPayload  = { metafield: { namespace: 'timanti', key: 'jewelcode', value: jewel_data, type: 'json' } };
      if (existingMf) {
        await axios.put(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields/${existingMf.id}.json`,
          mfPayload, { headers, timeout: 10000 }
        );
      } else {
        await axios.post(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
          mfPayload, { headers, timeout: 10000 }
        );
      }
      console.log(`Draft ${draftOrderId}: timanti.jewelcode metafield written`);
    } catch (mfErr) {
      console.error(`Draft ${draftOrderId}: failed to write timanti.jewelcode — ${mfErr.message}`);
    }
  };

  // Fetch variant/product metafields for each item using the extracted top-level helper
  const fetchItemMetaLocal = (item) => fetchItemMeta(item, token);

  if (!hasAnyNetWt) {
    if (!force) {
      console.warn(`Draft ${draftOrderId}: recalculate-price tag but jewelcode_net_weight missing, skipping`);
      await removeTagFromDraft(draftOrderId, tagToProcess);
      return;
    }
    // reprice tag, no weight data: recalculate gold component per-item from custom.gold_rate (positional), then fix discount/GST math
    const r2 = (v) => Math.round(v * 100) / 100;

    // Hydrate all items first — this bootstraps _gold_rate and Gold from variant metafields
    // for fresh items that have never been repriced (no locked props yet)
    const hydratedBase = await Promise.all(productItems.map(item => hydrateItemFromVariant(item, token)));

    // When a per-item gold rate is set (goldRateForIdx), derive net weight per item using best available source:
    // 1. variant net_wt metafield (most reliable)
    // 2. variant price_breakup_gold / gold_rate (both written together by price-update service)
    // 3. locked item Gold / _gold_rate (written by a previous reprice)
    const itemRecalc = productItems.map((item, idx) => {
          const rateForItem = goldRateForIdx(idx);
          // A making override is a repricing trigger in its own right — staff can set labour on a draft
          // with no weights and no gold-rate change, and the line must still reprice. When only making
          // moved, gold is held at its locked value rather than re-derived.
          const mkOverride  = makingForIdx(idx);
          if (!rateForItem && mkOverride == null) return null;
          const vMf    = hydratedBase[idx].varMf || {};
          const iProps = {};
          for (const p of (item.properties || [])) iProps[p.name] = p.value;

          const varNetWt   = parseFloat(vMf.net_wt || vMf.net_metal_weight_g || 0);
          const varGoldPbp = parseFloat(vMf.price_breakup_gold || 0) * item.quantity;
          const varRate    = parseFloat(vMf.gold_rate || 0);
          const lockedGold = parseFloat((iProps['Gold'] || '').replace('Rs', '').trim()) || 0;
          const lockedRate = parseFloat((iProps['_gold_rate'] || '').trim()) || 0;
          // Fallback: use the variant-bootstrapped _gold_rate from hydratedBase when item has no locked rate.
          // This restores the pre-7a3556b behaviour where hProps was checked as a fallback.
          const hItemProps = {};
          for (const p of (hydratedBase[idx].properties || [])) hItemProps[p.name] = p.value;
          const bootstrappedRate = parseFloat((hItemProps['_gold_rate'] || '').trim()) || 0;
          const effectiveRate    = lockedRate || bootstrappedRate;

          // Printed _net_wt on the line item wins — it's the staff-confirmed weight. Only when it's
          // absent do we derive from variant net_wt, variant gold/rate, or locked Gold/rate.
          const lockedNetWt = parseFloat((iProps['_net_wt'] || '').trim()) || 0;
          let netWt = 0;
          if (lockedNetWt > 0)                          netWt = lockedNetWt;
          else if (varNetWt > 0)                        netWt = varNetWt * item.quantity;
          else if (varGoldPbp > 0 && varRate > 0)       netWt = varGoldPbp / varRate;
          else if (lockedGold > 0 && effectiveRate > 0) netWt = lockedGold / effectiveRate;

          if (netWt <= 0 && rateForItem) return null;

          const diaVal = parseFloat((iProps['Diamond'] || '').replace('Rs', '').trim()) || parseFloat(vMf.price_breakup_diamond || 0) * item.quantity;
          // custom.making wins; else whatever the line already carries; else the variant spec. Held flat
          // here — this is the NO-WEIGHTS branch (staff changed only the gold rate or labour), so there is
          // no new net weight to scale against. The weights path above is where labour scales per gram.
          const mkgVal = mkOverride != null
            ? mkOverride
            : (parseFloat((iProps['Making'] || iProps['Making Charges'] || '').replace('Rs', '').trim()) || parseFloat(vMf.price_breakup_making || 0) * item.quantity);

          // Gold: recompute only when a rate was given; otherwise hold the locked value.
          const newGold = rateForItem ? r2(netWt * rateForItem) : r2(lockedGold);
          if (!(newGold > 0)) return null;
          // newMaking is carried out so the Making PROP is rewritten to whatever fed the price math
          // (custom.making override, else the held value). Without this the no-weights branch moved
          // Taxable/Gross/price to the new labour but left the stale Making prop behind.
          return { newPreTaxGross: r2(newGold + diaVal + mkgVal), newGold, newMaking: mkgVal };
        });
    const anyGoldRecalc = itemRecalc.some(r => r !== null);

    // Pre-tax gross per item: use recalculated value when available, else back-calculate from current price
    // (items missing _gold_rate keep their existing price; items with it get repriced)
    const preTaxArr = productItems.map((item, i) =>
      itemRecalc[i] !== null ? itemRecalc[i].newPreTaxGross : r2(parseFloat(item.price) * item.quantity / 1.03)
    );
    const preTaxGrossTotal = preTaxArr.reduce((s, v) => s + v, 0);

    // A discount does NOT depend on weights — it must resolve here exactly as it does in the weights
    // path. (This branch previously read draft.applied_discount, which the reprice clears on every run,
    // so it was always 0 and a discount on a weightless draft silently did nothing.) The diamond value
    // is unchanged by this branch, so it comes straight off the line prop / variant breakup.
    const diaArr = productItems.map((item, idx) => {
      const iProps = {};
      for (const p of (item.properties || [])) iProps[p.name] = p.value;
      const vMf = hydratedBase[idx].varMf || {};
      return parseFloat((iProps['Diamond'] || '').replace('Rs', '').trim())
          || parseFloat(vMf.price_breakup_diamond || 0) * (item.quantity || 1)
          || 0;
    });
    const discIntent = readDiscountIntent(mfMap);
    const disc = discIntent
      ? resolveDiscount({
          ...discIntent,
          lines: productItems.map((item, i) => ({ diamond: diaArr[i], grossIncl: r2(preTaxArr[i] * 1.03) })),
        })
      : { perLine: productItems.map(() => 0), total: 0 };
    // Per-line, stackable discounts (dia / making / native-total) — same rule as the weights path: entries
    // REPLACE the order-level share for a line, else it falls back to the diamond-prorated amount above.
    // A per-line making discount needs the line's making value as its base, so resolve it here too.
    const lineDiscArr   = parseLineDiscounts(mfMap['line_discounts']);
    const makingBaseArr = productItems.map((item, idx) => {
      const rc = itemRecalc[idx];
      if (rc) return rc.newMaking || 0;
      const iProps = {};
      for (const p of (item.properties || [])) iProps[p.name] = p.value;
      return parseFloat((iProps['Making'] || iProps['Making Charges'] || '').replace('Rs', '').trim())
          || parseFloat((hydratedBase[idx].varMf || {}).price_breakup_making || 0) * (item.quantity || 1)
          || 0;
    });
    const discFinalByIdx = productItems.map((item, idx) => {
      const pl = resolveLineDiscount(lineDiscArr[idx], {
        diamond: diaArr[idx] || 0, making: makingBaseArr[idx] || 0, grossIncl: r2(preTaxArr[idx] * 1.03),
      });
      if (pl) return { total: pl.total, dia: pl.diaPortion, mk: pl.mkPortion, tot: pl.totalPortion };
      const ol = disc.perLine[idx] || 0;   // order-level fallback is diamond-only
      return { total: ol, dia: ol, mk: 0, tot: 0 };
    });

    const hydratedItems = productItems.map((item, idx) => {
      const h = hydratedBase[idx];
      // Same convention as the weights path: Gross Value is PRE-discount tax-inclusive,
      // Discount Applied is pre-tax rupees, Taxable = Gross/1.03 - Discount.
      const grossValue  = r2(preTaxArr[idx] * 1.03);
      const df          = discFinalByIdx[idx] || { total: 0, dia: 0, mk: 0, tot: 0 };
      const itemDisc    = r2(df.total);
      const itemTaxable = r2(Math.max(0, preTaxArr[idx] - itemDisc));
      const itemGst     = r2(itemTaxable * 0.03);
      const itemFinal   = r2(itemTaxable + itemGst);
      const unitPrice   = r2(itemFinal / (item.quantity || 1));
      // Strip financial fields; also strip Gold for this item when we have new gold data to replace it
      const thisItemRecalc = itemRecalc[idx];
      const FINANCIAL   = new Set(['Taxable Value', 'GST', 'Gross Value', 'Discount Applied', 'Diamond (After Discount)', 'Making (After Discount)', '_gold_rate', ...(thisItemRecalc ? ['Gold', 'Making'] : [])]);
      const filteredProps = h.properties.filter(p => !FINANCIAL.has(p.name));
      if (thisItemRecalc) {
        filteredProps.push({ name: 'Gold',   value: `Rs${thisItemRecalc.newGold.toFixed(2)}` });
        filteredProps.push({ name: 'Making', value: `Rs${thisItemRecalc.newMaking.toFixed(2)}` });
      }
      // Post-discount component values (display only); only the target-matched portion reduces each.
      const diaAfterDisc = r2(Math.max(0, (diaArr[idx] || 0) - df.dia));
      const mkAfterDisc  = r2(Math.max(0, (makingBaseArr[idx] || 0) - df.mk));
      filteredProps.push(
        { name: 'Taxable Value',    value: `Rs${itemTaxable.toFixed(2)}` },
        { name: 'GST',             value: `Rs${itemGst.toFixed(2)}` },
        { name: 'Gross Value',      value: `Rs${grossValue.toFixed(2)}` },
        { name: 'Discount Applied', value: `Rs${itemDisc.toFixed(2)}` },
        { name: 'Diamond (After Discount)', value: `Rs${diaAfterDisc.toFixed(2)}` },
        { name: 'Making (After Discount)',  value: `Rs${mkAfterDisc.toFixed(2)}` },
      );
      const idxRate = goldRateForIdx(idx);
      const effectiveRate = idxRate ? String(idxRate) : ((item.properties || []).find(p => p.name === '_gold_rate')?.value || h.properties.find(p => p.name === '_gold_rate')?.value || '');
      if (effectiveRate) filteredProps.push({ name: '_gold_rate', value: effectiveRate });
      return { ...h, price: unitPrice.toFixed(2), properties: filteredProps };
    });

    const allUpdatedItems = (draft.line_items || []).map(item => {
      const h = hydratedItems.find(u => u.id === item.id);
      // else-branch re-sends non-product lines verbatim — EXC lines pass through here untouched.
      return h
        ? { variant_id: h.variant_id, quantity: h.quantity, price: h.price, properties: h.properties, title: item.title }
        : { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
    });
    const appliedDiscountTotal = discFinalByIdx.reduce((s, d) => s + (d.total || 0), 0);
    await gqlSetDraftLineItems(draftOrderId, allUpdatedItems, token, { tags: tagsWithoutRecalc, clearDiscount: true });
    console.log(`Draft ${draftOrderId}: reprice (no weights${anyGoldRecalc ? ', gold rate recalc' : ''}) — ${hydratedItems.length} items updated${(discIntent || lineDiscArr.length) ? `, discount Rs${appliedDiscountTotal.toFixed(2)}` : ''}`);

    if (discIntent || lineDiscArr.length) {
      const prior = Math.abs(parseFloat(mfMap['discount_applied'] || 0)) || 0;
      if (Math.abs(prior - appliedDiscountTotal) >= 0.01) {
        await updateDraftOrderMetafields(draftOrderId, { discount_applied: appliedDiscountTotal.toFixed(2) });
        console.log(`Draft ${draftOrderId}: discount re-resolved — was Rs${prior.toFixed(2)}, now Rs${appliedDiscountTotal.toFixed(2)}`);
      }
    }
    return;
  }

  // Pass 1: compute new gross value per item (gold + diamond + making, no discount yet)
  const itemResults = await Promise.all(productItems.map(async (item, idx) => {
    const newNetWt = netWtArr[idx] ?? null;

    if (!newNetWt || newNetWt <= 0) {
      return { item, idx, hydrate: force, skip: !force };
    }

    const newGrossWt = grossWtArr[idx] ?? 0;
    const props = {};
    for (const p of (item.properties || [])) props[p.name] = p.value;

    const { varMf, prodMf } = await fetchItemMetaLocal(item);

    const mfRateForItem = goldRateForIdx(idx);
    let goldRate = mfRateForItem || parseFloat(props['_gold_rate']);
    let goldRateOverridden = !!(mfRateForItem && mfRateForItem > 0);
    let bootstrapGoldRate = false;
    if (!goldRate && varMf.gold_rate) {
      goldRate = parseFloat(varMf.gold_rate);
      bootstrapGoldRate = true;
      console.log(`Draft ${draftOrderId} item ${item.id}: bootstrapping _gold_rate=${goldRate} from variant`);
    }
    if (goldRateOverridden) console.log(`Draft ${draftOrderId} item ${item.id}: gold rate override from draft metafield: ${goldRate}`);

    const goldPropValue = parseFloat((props['Gold'] || '0').replace('Rs', '').trim());
    const oldGold = goldPropValue || parseFloat(varMf.price_breakup_gold || 0) * (item.quantity || 1);

    if (!goldRate || !oldGold) {
      console.warn(`Draft ${draftOrderId} item ${item.id}: gold rate (${goldRate}) or Gold value (${oldGold}) missing, skipping`);
      return { item, idx, skip: true };
    }

    // Prefer the stored net weight (what the current values were priced at) over back-deriving oldGold/goldRate,
    // which is wrong when the gold rate was changed — keeps the delta threshold and making fallback stable.
    const oldNetWt = parseFloat(props['_net_wt']) || (oldGold / goldRate);
    const delta    = Math.abs(newNetWt - oldNetWt) / oldNetWt;

    // Old stone carats from product metafields (fixed design spec)
    const oldDiaCts = parseFloat(prodMf.totaldiamondweight || 0);
    const oldGemCts = parseFloat(prodMf.gemstone_weight    || 0);
    const totalOldCts = oldDiaCts + oldGemCts;

    // New stone carats: draft metafield override → product fallback → 0
    const newDiaCts   = diaCtsArr[idx] ?? oldDiaCts;
    const newGemCts   = gemWtArr[idx]  ?? oldGemCts;
    const totalNewCts = (newDiaCts || 0) + (newGemCts || 0);

    // Gold: net weight × gold rate — already variant/rate-anchored (never re-derived from the moving Gold prop).
    const newGoldValue = newNetWt * goldRate;

    // Diamond+gemstone: the per-carat rate ALWAYS comes from the variant/product design spec
    // (price_breakup_diamond ÷ design carats), scaled to the entered carats. It is NEVER re-derived from
    // the moving Diamond prop — doing so compounds the value down (÷ product cts, × entered cts) on every
    // reprice. Falls back to the prop only when the variant carries no diamond breakup.
    const varDiamondValue = parseFloat(varMf.price_breakup_diamond || 0) * (item.quantity || 1);
    const oldDiamondValue = parseFloat((props['Diamond'] || '0').replace('Rs', '').trim());
    const stoneRateBasis  = varDiamondValue || oldDiamondValue;
    const perCtRate       = totalOldCts > 0 ? stoneRateBasis / totalOldCts : 0;
    const newDiamondValue = totalOldCts > 0 ? perCtRate * totalNewCts : stoneRateBasis;

    // Making (labour) is PER-GRAM — it scales with net weight, the same way gold does. Labour is quoted
    // per gram of metal, so a heavier piece of the same design costs more to make.
    //
    // The per-gram rate ALWAYS comes from the variant design spec (price_breakup_making ÷ variant net
    // weight), scaled to the entered net weight. Like the stone rate above, it is NEVER re-derived from
    // the moving Making prop — doing so would compound the value on every reprice (÷ catalogue weight,
    // × entered weight, again and again). Both sides of the ratio are put on a line-total basis (× qty)
    // so the arithmetic is dimensionally consistent for multi-quantity lines.
    //
    // Precedence:
    //   1. custom.making  — positional CSV override, per item ("1900,2500"). A FLAT rupee amount for the
    //      line, used verbatim: it is the staff-agreed labour, not a rate, so it never scales.
    //   2. the variant design spec, scaled per gram (the normal path)
    //   3. the existing Making prop (a line already priced, e.g. by the manual endpoint) — held flat,
    //      since without a catalogue weight there is no rate to scale by.
    const makingOverride  = makingForIdx(idx);
    const qty             = item.quantity || 1;
    const varMakingValue  = parseFloat(varMf.price_breakup_making || 0) * qty;
    const oldMakingValue  = parseFloat((props['Making'] || props['Making Charges'] || '0').replace('Rs', '').trim());
    const makingBasis     = varMakingValue || oldMakingValue || 0;                       // line-total Rs
    const catNetWtLine    = parseFloat(varMf.net_wt || varMf.net_metal_weight_g || 0) * qty; // line-total g
    const newMakingValue  = makingOverride != null
      ? makingOverride
      : (catNetWtLine > 0 ? (makingBasis / catNetWtLine) * newNetWt : makingBasis);

    // Gross = components, made GST-inclusive (unified convention: components + 3% GST, same as the catalog price).
    const newGrossValue = (newGoldValue + newDiamondValue + newMakingValue) * 1.03;

    return {
      item, idx, skip: false, hydrate: false,
      newNetWt, newGrossWt, newGoldValue, newDiamondValue, newMakingValue, newGrossValue,
      goldRate, bootstrapGoldRate, goldRateOverridden, oldNetWt, delta,
      newDiaCts: newDiaCts || 0, newGemCts: newGemCts || 0,
      metal: (item.variant_title || '').split(' / ')[0] || '',
      category: item.title || '',
      jewel_code: varMf.jewel_code || '',
      props,
    };
  }));

  // Total gross across all repriced items (reference only).
  const totalNewGross = itemResults.reduce((sum, r) => sum + (r?.newGrossValue || 0), 0);
  // Discount: re-resolved from the stored RATE against the diamond value we just recomputed, so it
  // tracks weight/carat/product changes instead of drifting (see resolveDiscount). Never Shopify's
  // native applied_discount, which is cleared on every reprice.
  const discIntent = readDiscountIntent(mfMap);
  const discLines  = itemResults.map(r => ({
    diamond:   r?.newDiamondValue || 0,
    grossIncl: r?.newGrossValue   || 0,   // PRE-discount tax-inclusive line total
  }));
  const disc = discIntent
    ? resolveDiscount({ ...discIntent, lines: discLines })
    : { perLine: discLines.map(() => 0), total: 0 };
  // Per-line, stackable discounts (dia / making / native-total) REPLACE the order-level share for any line
  // that carries entries; a line with none falls back to the order-level (diamond-prorated) amount above.
  // Portions are kept split so the component props stay honest: only the diamond-targeted cut reduces
  // 'Diamond (After Discount)', only the making-targeted cut reduces 'Making (After Discount)', while a
  // native/whole-line cut reduces the line taxable without being attributed to either component.
  const lineDiscArr = parseLineDiscounts(mfMap['line_discounts']);
  const discByIdx = new Map(itemResults.map((r, i) => {
    if (!r) return [undefined, { total: 0, dia: 0, mk: 0, tot: 0 }];
    const pl = resolveLineDiscount(lineDiscArr[r.idx], {
      diamond: r.newDiamondValue || 0, making: r.newMakingValue || 0, grossIncl: r.newGrossValue || 0,
    });
    if (pl) return [r.idx, { total: pl.total, dia: pl.diaPortion, mk: pl.mkPortion, tot: pl.totalPortion }];
    const ol = disc.perLine[i] || 0;   // order-level fallback is diamond-only
    return [r.idx, { total: ol, dia: ol, mk: 0, tot: 0 }];
  }));

  const allJewelData = [];
  const repricedMap  = new Map();

  await Promise.all(itemResults.map(async (result) => {
    if (!result) return;
    const { item, idx } = result;

    if (result.hydrate) {
      repricedMap.set(item.id, await hydrateItemFromVariant(item, token));
      return;
    }
    if (result.skip) return;

    const {
      newNetWt, newGrossWt, newGoldValue, newDiamondValue, newMakingValue, newGrossValue,
      goldRate, bootstrapGoldRate, goldRateOverridden, delta, newDiaCts, newGemCts,
      metal, category, jewel_code, props,
    } = result;

    // This line's discount, split by target (see discByIdx build). itemDiscount is the pre-tax total that
    // reduces Taxable; the dia/mk portions reduce only the component-level display props below.
    const df = discByIdx.get(idx) || { total: 0, dia: 0, mk: 0, tot: 0 };
    const itemDiscount = df.total;

    const jewelHiddenProps = {
      '_gross_wt':     newGrossWt.toFixed(3),
      '_net_wt':       newNetWt.toFixed(3),
      '_diamond_cts':  newDiaCts.toFixed(2),
      '_gemstone_cts': newGemCts.toFixed(2),
      '_jewel_code':   jewel_code,
    };

    if (!force && delta <= 0.05 && !goldRateOverridden) {
      const jewel_data = JSON.stringify({
        jewel_code, gross_wt: newGrossWt, net_wt: newNetWt,
        diamond_cts: newDiaCts, gemstone_cts: newGemCts,
        metal, category, gold_rate_locked: goldRate,
        weight_delta_pct: parseFloat((delta * 100).toFixed(2)), repriced: false,
      });
      const jewelProps   = { ...jewelHiddenProps, '_jewel_data': jewel_data };
      const updatedProps = (item.properties || [])
        .filter(p => !(p.name in jewelProps))
        .concat(Object.entries(jewelProps).map(([name, value]) => ({ name, value })));
      repricedMap.set(item.id, { id: item.id, variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: updatedProps });
      allJewelData.push(jewel_data);
      console.log(`Draft ${draftOrderId} item ${item.id}: delta=${(delta*100).toFixed(2)}% ≤ 5% — jewel props written, price unchanged`);
      return;
    }

    // Full reprice: force=true OR delta > 5%.
    // Convention (uniform across every path and reader):
    //   Gross Value      = PRE-discount, tax-inclusive        = (gold + diamond + making) * 1.03
    //   Discount Applied = pre-tax rupees, diamond-only
    //   Taxable Value    = Gross Value / 1.03 - Discount Applied
    //   GST              = Taxable Value * 0.03
    //   line price       = Taxable Value * 1.03
    // Gold/Diamond/Making stay PRE-discount so the components reconcile to Gross Value, and so
    // handleApplyDiscountTag (which reads the Diamond prop as its base) can't compound a second
    // discount onto an already-discounted stone.
    const newTaxableValue = Math.max(0, newGrossValue / 1.03 - itemDiscount);
    const newGst          = newTaxableValue * 0.03;
    const newFinalValue   = newTaxableValue + newGst;

    const jewel_data = JSON.stringify({
      jewel_code, gross_wt: newGrossWt, net_wt: newNetWt,
      diamond_cts: newDiaCts, gemstone_cts: newGemCts,
      metal, category, gold_rate_locked: goldRate,
      weight_delta_pct: parseFloat((delta * 100).toFixed(2)), repriced: true,
    });

    // Post-discount component values as display-only props. Only the target-matched portion reduces each
    // ('Diamond'/'Making' themselves stay PRE-discount — the discount engine reads Diamond as its base).
    // A native/whole-line ('total') cut reduces Taxable but is attributed to neither component here.
    const newDiamondAfterDiscount = Math.max(0, newDiamondValue - df.dia);
    const newMakingAfterDiscount  = Math.max(0, newMakingValue  - df.mk);

    const repricedProps = {
      'Gold':                   `Rs${newGoldValue.toFixed(2)}`,
      'Diamond':                `Rs${newDiamondValue.toFixed(2)}`,
      'Diamond (After Discount)': `Rs${newDiamondAfterDiscount.toFixed(2)}`,
      'Making':                 `Rs${newMakingValue.toFixed(2)}`,
      'Making (After Discount)': `Rs${newMakingAfterDiscount.toFixed(2)}`,
      'Gross Value':            `Rs${newGrossValue.toFixed(2)}`,
      'Taxable Value':          `Rs${newTaxableValue.toFixed(2)}`,
      'GST':                    `Rs${newGst.toFixed(2)}`,
      'Discount Applied':       `Rs${itemDiscount.toFixed(2)}`,
      ...jewelHiddenProps,
      '_jewel_data':            jewel_data,
    };
    if (bootstrapGoldRate || goldRateOverridden) repricedProps['_gold_rate'] = goldRate.toString();

    const updatedProperties = (item.properties || []).filter(p => !(p.name in repricedProps));
    for (const [name, value] of Object.entries(repricedProps)) updatedProperties.push({ name, value });

    repricedMap.set(item.id, { id: item.id, variant_id: item.variant_id || undefined, quantity: item.quantity, price: (newFinalValue / (item.quantity || 1)).toFixed(2), properties: updatedProperties });
    allJewelData.push(jewel_data);
    console.log(`Draft ${draftOrderId} item ${item.id}: repriced — delta=${(delta*100).toFixed(2)}%, gold=Rs${newGoldValue.toFixed(2)}, dia=Rs${newDiamondValue.toFixed(2)}, making=Rs${newMakingValue.toFixed(2)}, gross=Rs${newGrossValue.toFixed(2)}`);
  }));

  const allLineItems = (draft.line_items || []).map(item => {
    const r = repricedMap.get(item.id);
    if (r) return { variant_id: r.variant_id, quantity: r.quantity, price: r.price, properties: r.properties, title: r.title };
    // else-branch re-sends non-repriced lines verbatim — EXC lines pass through here untouched.
    return { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
  });

  await gqlSetDraftLineItems(draftOrderId, allLineItems, token, { tags: tagsWithoutRecalc, clearDiscount: true });
  console.log(`✅ Draft ${draftOrderId}: reprice done (GraphQL) — ${repricedMap.size} item(s) updated`);

  // Re-publish the ACTUAL applied discount (pre-tax) — the sum of every line's resolved cut, whether it
  // came from the order-level intent or per-line entries — so the invoice/reports read what we priced
  // against, not the value resolved when staff clicked Apply.
  const appliedDiscountTotal = [...discByIdx.values()].reduce((s, d) => s + (d.total || 0), 0);
  if (discIntent || lineDiscArr.length) {
    const prior = Math.abs(parseFloat(mfMap['discount_applied'] || 0)) || 0;
    if (Math.abs(prior - appliedDiscountTotal) >= 0.01) {
      await updateDraftOrderMetafields(draftOrderId, { discount_applied: appliedDiscountTotal.toFixed(2) });
      console.log(`Draft ${draftOrderId}: discount re-resolved — was Rs${prior.toFixed(2)}, now Rs${appliedDiscountTotal.toFixed(2)}`);
    }
  }

  if (allJewelData.length > 0) {
    const mfValue = allJewelData.length === 1
      ? allJewelData[0]
      : JSON.stringify(allJewelData.map(d => JSON.parse(d)));
    await writeJewelcodeMetafield(mfValue);
  }
}

// Weighted document reprice for make-memo-custom and make-transfer. Reprices each product line to a
// weighted sum of its components — gold×G% + diamond×D% + making×M% — and overwrites the Gross Value /
// Taxable Value / GST / Discount Applied props and the Shopify line price, so the printed document
// (which sums Gross Value) and the order total both reflect it, with no template math change. Reads the
// existing Gold / Diamond / Making props, falling back to the variant metafields custom.price_breakup_gold
// / _diamond / _making (per-unit × qty). No jewelcode net-weight metafields required. Percentages:
//   make-memo-custom → gold 100%, diamond 50%, making 100% (full metal + labour, half the stone value).
//   make-transfer    → per-draft custom.transfer_pct_gold / _dia / _making (each ≥0, in %, default 100).
// The Gold / Diamond / Making breakdown props are left intact for reference; only the totals change. The
// trigger tag is stripped in the same GraphQL write (loop prevention); the MEMO-/AURA- serial is minted
// separately by handleDocumentSerialTags. Gated on SERIAL_MEMO_TRANSFER so pricing + serial toggle together.
async function handleWeightedDocReprice(draft) {
  if (!SERIAL_MEMO_TRANSFER) return;
  const tags  = (draft.tags || '').split(',').map(t => t.trim());
  const lower = tags.map(t => t.toLowerCase());
  const isMemo     = lower.includes('make-memo-custom');
  const isTransfer = lower.includes('make-transfer');
  if (!isMemo && !isTransfer) return;
  const triggerTag = isMemo ? 'make-memo-custom' : 'make-transfer';

  try {
    const draftOrderId = draft.id;
    const token = await getShopifyToken();
    const rs = (v) => parseFloat(String(v || '0').replace('Rs', '').replace(/,/g, '').trim()) || 0;

    // Component weights (fractions). memo = full gold+making, half diamond; transfer = per-draft % overrides (default 100).
    let pctGold = 1, pctDia = isMemo ? 0.5 : 1, pctMaking = 1;
    if (isTransfer) {
      const { data: mfData } = await axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
      );
      const mf = {};
      for (const m of (mfData.metafields || [])) if (m.namespace === 'custom') mf[m.key] = m.value;
      const pctOf = (key) => { const v = parseFloat(mf[key]); return (isFinite(v) && v >= 0) ? v / 100 : 1; };
      pctGold = pctOf('transfer_pct_gold'); pctDia = pctOf('transfer_pct_dia'); pctMaking = pctOf('transfer_pct_making');
    }

    // Product lines only — skip EXC trade-in lines and negative discount lines; everything else is
    // re-sent verbatim below.
    const productItems = (draft.line_items || []).filter(item =>
      !isExcLine(item) &&
      !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0) &&
      ((item.properties || []).some(p => p.name === 'Gold') || !!item.variant_id)
    );

    // Resolve gold / diamond / making per item: prop → variant metafield (per-unit × qty).
    const resolved = await Promise.all(productItems.map(async (item) => {
      const props = {};
      for (const p of (item.properties || [])) props[p.name] = p.value;
      let gold   = rs(props['Gold']);
      let dia    = rs(props['Diamond']);
      let making = rs(props['Making'] || props['Making Charges']);
      if (!gold || !making || (!dia && pctDia > 0)) {
        const { varMf } = await fetchItemMeta(item, token);
        if (!gold)   gold   = parseFloat(varMf.price_breakup_gold    || 0) * (item.quantity || 1);
        if (!dia)    dia    = parseFloat(varMf.price_breakup_diamond || 0) * (item.quantity || 1);
        if (!making) making = parseFloat(varMf.price_breakup_making  || 0) * (item.quantity || 1);
      }
      const basis = (gold * pctGold + dia * pctDia + making * pctMaking) * 1.03;  // GST-inclusive, same convention as reprice/catalog
      return { item, basis };
    }));

    const totalBasis    = resolved.reduce((sum, r) => sum + r.basis, 0);
    const totalDiscount = parseFloat(draft.applied_discount?.amount || 0);

    const repricedMap = new Map();
    for (const { item, basis } of resolved) {
      // Prorate any order-level discount by this item's share of the weighted basis.
      const itemDiscount = totalBasis > 0 ? totalDiscount * (basis / totalBasis) : 0;
      const finalValue   = Math.max(0, basis - itemDiscount);   // tax-inclusive
      const taxableValue = finalValue / 1.03;
      const gst          = taxableValue * 0.03;

      const OVERWRITE = new Set(['Gross Value', 'Taxable Value', 'GST', 'Discount Applied']);
      const updatedProps = (item.properties || []).filter(p => !OVERWRITE.has(p.name));
      updatedProps.push(
        { name: 'Gross Value',      value: `Rs${basis.toFixed(2)}` },
        { name: 'Taxable Value',    value: `Rs${taxableValue.toFixed(2)}` },
        { name: 'GST',              value: `Rs${gst.toFixed(2)}` },
        { name: 'Discount Applied', value: `Rs${itemDiscount.toFixed(2)}` },
      );
      repricedMap.set(item.id, {
        variant_id: item.variant_id || undefined,
        quantity: item.quantity,
        price: (finalValue / (item.quantity || 1)).toFixed(2),
        properties: updatedProps,
      });
    }

    const allLineItems = (draft.line_items || []).map(item => {
      const r = repricedMap.get(item.id);
      // else-branch re-sends non-product / EXC lines verbatim.
      return r
        ? { variant_id: r.variant_id, quantity: r.quantity, price: r.price, properties: r.properties, title: item.title }
        : { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
    });

    // Strip the trigger tag here (loop prevention). handleDocumentSerialTags still mints off the
    // in-memory draft.tags in the same webhook pass, then no-op removes the (already gone) tag.
    const tagsWithout = tags.filter(t => t && t.toLowerCase() !== triggerTag).join(', ');
    await gqlSetDraftLineItems(draftOrderId, allLineItems, token, { tags: tagsWithout, clearDiscount: true });
    console.log(`✅ Draft ${draftOrderId}: ${triggerTag} reprice — G${Math.round(pctGold*100)}/D${Math.round(pctDia*100)}/M${Math.round(pctMaking*100)}%, ${repricedMap.size} item(s), basis=Rs${totalBasis.toFixed(2)}`);
  } catch (err) {
    console.error(`weighted reprice (${triggerTag}) failed for draft ${draft.id}:`, err.message);
  }
}

// Reads payment metafields and writes corresponding payment tags.
// Copies all custom metafields from a completed draft order to its resulting order.
async function copyDraftMetafieldsToOrder(draftOrderId, orderId, token) {
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const { data: mfData } = await axios.get(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
    { headers, timeout: 10000 }
  );
  const draftMfs = (mfData.metafields || []).filter(mf => mf.namespace === 'custom');
  if (!draftMfs.length) return 0;

  const { data: existingMfData } = await axios.get(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}/metafields.json`,
    { headers, timeout: 10000 }
  );
  const existingByKey = {};
  for (const mf of (existingMfData.metafields || [])) {
    if (mf.namespace === 'custom') existingByKey[mf.key] = mf.id;
  }

  let copied = 0;
  for (const mf of draftMfs) {
    const body = { metafield: { namespace: 'custom', key: mf.key, value: String(mf.value), type: mf.type } };
    try {
      const existingId = existingByKey[mf.key];
      if (existingId) {
        await axios.put(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}/metafields/${existingId}.json`,
          body, { headers, timeout: 10000 }
        );
      } else {
        await axios.post(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}/metafields.json`,
          body, { headers, timeout: 10000 }
        );
      }
      copied++;
    } catch (err) {
      console.error(`copyDraftMetafieldsToOrder: failed ${mf.key}:`, err.response?.data || err.message);
    }
  }
  return copied;
}

// Reads custom metafields from an order and writes payment tags to it.
// Tags written: deposit:fully-paid/partial, paid:Rs{n}, pending:Rs{n},
//               total:Rs{n}, pmodes:{m1}/{m2}/... (+ legacy pmode-advance:/pmode-final: while
//               dual-write is on).
//
// paid is the SUM of the installment legs (cad_advance excluded — custom.advance already reduces
// the net, so counting it again would deduct it twice). pending is derived against the net, never
// gross. Everything here is arithmetic only.
async function applyPaymentTagsToOrder(orderId, token) {
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const [{ data: orderData }, { data: mfData }] = await Promise.all([
    axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}.json`, { headers, timeout: 10000 }),
    axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}/metafields.json`, { headers, timeout: 10000 }),
  ]);

  const order      = orderData.order;
  const totalPrice = Math.round(parseFloat(order.total_price || 0));

  const mf = (key) => {
    const m = (mfData.metafields || []).find(m => m.namespace === 'custom' && m.key === key);
    return m ? m.value : null;
  };

  const paymentStatus = mf('payment_status');
  // REST returns a BOOLEAN metafield as a JSON boolean, not the string "true" — so comparing it
  // to a string was always false. is_finalized could be written true (the values differed) but
  // never written back to false (both read as false), making it a one-way latch: an order that
  // reopened a balance kept printing "fully paid" on its tax invoice, which is what is_finalized
  // drives there. String() normalises both shapes.
  const isFinalized   = String(mf('is_finalized')) === 'true';
  // Installment legs are the source of truth for what was collected. Legacy fallback covers orders
  // predating the migration, which carry only the two-slot pair.
  const mfMap = {};
  for (const m of (mfData.metafields || [])) if (m.namespace === 'custom') mfMap[m.key] = m.value;
  // Fold any pre-installment balance into its own leg before trusting the leg sum — otherwise a
  // document paid the old way has its balance written down by exactly the un-legged amount.
  const legsRaw     = readInstallments(mfMap);
  const legacyFold  = materializeLegacyLeg(mfMap, legsRaw);
  const legs        = legacyFold.rows;
  const legacyPaid  = (parseFloat(mf('amount_paid') || 0) || 0) + (parseFloat(mf('amount_paid_final') || 0) || 0);
  const amountPaid  = legs.length ? sumInstallments(legs) : legacyPaid;
  const modes       = legs.length ? installmentModes(legs)
                                  : [mf('payment_mode_advance'), mf('payment_mode_final')].filter(Boolean);
  const modeAdvance = mf('payment_mode_advance');
  const modeFinal   = mf('payment_mode_final');

  // Balance reconciles against the NET-to-collect (total − post-tax adjustments), never gross.
  // amount_pending is DERIVED. Fallback to gross when the net field is absent.
  const netRaw  = parseFloat(mf('amount_to_be_collected'));
  const netBase = Number.isFinite(netRaw) && netRaw >= 0 ? netRaw : totalPrice;
  const amountPending = Math.max(0, netBase - amountPaid);
  // "Fully paid" is ARITHMETIC ONLY — see the draft variant for why payment_status/is_finalized must
  // never feed back in as inputs here (one-way latch).
  const isFull    = amountPaid > 0 && amountPending < PAID_EPSILON;
  const isPartial = !isFull && amountPaid > 0;

  // Persist the derived balance + status on the order so re-downloads/reporting read them.
  // A cad_advance-only order has amountPaid 0 by design but still has a real balance to publish.
  if (isFull || isPartial || legs.length) {
    const patch = Object.assign({}, legacyFold.patch);
    // amount_paid is DERIVED from the legs. The admin panel writes legs but never the total (it is
    // read-only there), and the CAD flip changes the sum without touching any leg value — so
    // re-summing here is what keeps the figure the invoice prints actually true.
    if (legs.length) {
      const curPaid = parseFloat(mf('amount_paid'));
      if (!Number.isFinite(curPaid) || Math.abs(curPaid - amountPaid) >= 0.5) patch.amount_paid = amountPaid.toFixed(2);
      // Legacy field pinned to 0 so readers still summing the old pair get total + 0, never double.
      if ((parseFloat(mf('amount_paid_final')) || 0) !== 0) patch.amount_paid_final = '0';
    }
    const curPending = mf('amount_pending');
    if (curPending === null || Math.abs(parseFloat(curPending) - amountPending) >= 0.5) patch.amount_pending = amountPending.toFixed(2);
    const wantStatus = isFull ? 'Full' : 'Partial';  // choice-list values: Partial|Full|None
    if (paymentStatus !== wantStatus) patch.payment_status = wantStatus;
    // is_finalized drives is_fully_paid on the tax invoice, so it must track the balance BOTH ways —
    // a top-up that reopens a balance has to clear it, or the invoice keeps printing "fully paid".
    if (isFull !== isFinalized) patch.is_finalized = isFull ? 'true' : 'false';
    if (Object.keys(patch).length) await updateOrderMetafields(orderId, patch, token);
  }
  if (!isFull && !isPartial && !legs.length) return false;

  const existingTags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const cleanedTags  = existingTags.filter(t =>
    // sync-payment is the admin panel's nudge; consume it here exactly as the draft twin does.
    t.toLowerCase() !== 'sync-payment' &&
    !t.startsWith('deposit:') && !t.startsWith('paid:') && !t.startsWith('pending:') &&
    !t.startsWith('pmode-') && !t.startsWith('pmodes:') && !/^i[1-9]:/.test(t) && !t.startsWith('total:')
  );

  const paymentTags = [
    isFull ? 'deposit:fully-paid' : 'deposit:partial',
    `paid:Rs${Math.round(amountPaid)}`,
    ...(isPartial && amountPending > 0 ? [`pending:Rs${Math.round(amountPending)}`] : []),
    `total:Rs${totalPrice}`,
    // One aggregate mode tag covering every leg. Recon reads modes off tags to disambiguate
    // same-amount candidates, so it needs all of them without fetching metafields.
    ...(modes.length ? [`pmodes:${modes.join('/')}`] : []),
    // The whole installment table, encoded in ONE tag: value@mode@date, legs separated by ~.
    // Order Printer can hand a template empty order.metafields at print time — which is why every
    // other payment field here already has a tag fallback (deposit:/paid:/pending:/pmode-*). The
    // installment rows had none, so the payment table silently printed nothing. Well inside the
    // 255-char tag limit at 4 legs.
    ...legs.map(r => `i${r.slot}:${r.value}@${r.mode || ''}@${r.date || ''}${r.type === 'cad_advance' ? '@c' : ''}`),
    // DUAL-WRITE (remove at rollout step 6): the two-slot tags unmigrated readers still parse.
    ...(modeAdvance ? [`pmode-advance:${modeAdvance}`] : []),
    ...(modeFinal   ? [`pmode-final:${modeFinal}`]   : []),
  ];

  // Idempotence guard, mirroring the draft twin. This function now runs from the orders/update
  // webhook, and every tag PUT fires that webhook again — without this it would write, retrigger
  // itself, and loop forever. Skipping the no-op write breaks the cycle on the second pass.
  const proposedTags = [...cleanedTags, ...paymentTags];
  const proposedSet  = new Set(proposedTags.map(t => t.toLowerCase()));
  const existingSet  = new Set(existingTags.map(t => t.toLowerCase()));
  const unchanged = proposedSet.size === existingSet.size && [...proposedSet].every(t => existingSet.has(t));
  if (unchanged) {
    console.log(`Order ${orderId}: payment tags unchanged, skipping PUT`);
    return true;
  }

  await axios.put(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}.json`,
    { order: { id: parseInt(orderId), tags: proposedTags.join(', ') } },
    { headers, timeout: 10000 }
  );
  console.log(`Order ${orderId}: tags [${paymentTags.join(', ')}]${legs.length ? ` (${legs.length} installment${legs.length > 1 ? 's' : ''})` : ''}`);
  return true;
}

// Mirrors applyPaymentTagsToOrder exactly but writes to a draft order.
// Same logic: 1-rupee rounding tolerance, both pmode tags for installment-complete, total: tag.
async function applyPaymentTagsToDraftOrder(draftOrderId, token) {
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const [{ data: draftData }, { data: mfData }] = await Promise.all([
    axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`, { headers, timeout: 10000 }),
    axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`, { headers, timeout: 10000 }),
  ]);

  const draft      = draftData.draft_order;
  const totalPrice = Math.round(parseFloat(draft.total_price || 0));

  const mf = (key) => {
    const m = (mfData.metafields || []).find(m => m.namespace === 'custom' && m.key === key);
    return m ? m.value : null;
  };

  const paymentStatus = mf('payment_status');
  // REST returns a BOOLEAN metafield as a JSON boolean, not the string "true" — so comparing it
  // to a string was always false. is_finalized could be written true (the values differed) but
  // never written back to false (both read as false), making it a one-way latch: an order that
  // reopened a balance kept printing "fully paid" on its tax invoice, which is what is_finalized
  // drives there. String() normalises both shapes.
  const isFinalized   = String(mf('is_finalized')) === 'true';
  // Payments are recorded as up to MAX_INSTALLMENTS legs, each with its own value + mode + date.
  // What's been paid is their sum, with cad_advance legs excluded (custom.advance already reduces
  // amount_to_be_collected, so counting it here too would deduct the same rupees twice).
  // Legacy fallback covers drafts predating the migration, which carry only the two-slot pair.
  const mfMap = {};
  for (const m of (mfData.metafields || [])) if (m.namespace === 'custom') mfMap[m.key] = m.value;
  // Fold any pre-installment balance into its own leg before trusting the leg sum — otherwise a
  // document paid the old way has its balance written down by exactly the un-legged amount.
  const legsRaw     = readInstallments(mfMap);
  const legacyFold  = materializeLegacyLeg(mfMap, legsRaw);
  const legs        = legacyFold.rows;
  const legacyPaid  = (parseFloat(mf('amount_paid') || 0) || 0) + (parseFloat(mf('amount_paid_final') || 0) || 0);
  const amountPaid  = legs.length ? sumInstallments(legs) : legacyPaid;
  const modes       = legs.length ? installmentModes(legs)
                                  : [mf('payment_mode_advance'), mf('payment_mode_final')].filter(Boolean);
  const modeAdvance = mf('payment_mode_advance');
  const modeFinal   = mf('payment_mode_final');

  // Balance reconciles against the NET-to-collect (total − post-tax adjustments, frozen by
  // syncAmountToCollect), never the gross total. amount_pending is DERIVED here (staff set what was
  // paid, not what's pending). Fallback to gross when the net field is absent (legacy/online).
  const netRaw  = parseFloat(mf('amount_to_be_collected'));
  const netBase = Number.isFinite(netRaw) && netRaw >= 0 ? netRaw : totalPrice;
  const amountPending = Math.max(0, netBase - amountPaid);
  // "Fully paid" is ARITHMETIC ONLY: what is owed vs what is paid, right now.
  //
  // It previously read `isFinalized || payment_status === 'full' || ...`, which made payment_status
  // both an input and an output of its own derivation (it is written back as `isFull ? 'Full' :
  // 'Partial'` below) — a one-way latch. Any single moment of amountPending < 1 (e.g. amount_paid
  // entered while amount_to_be_collected was still 0 on a half-built draft) pinned the draft to Full
  // forever, and the is_finalized write below then sealed it. amount_pending kept correcting itself
  // while the status could not, which is how #D172 ended up reading Full at 10,000 paid of 47,573.19
  // owed — and why a later payment never re-registered as partial vs final.
  const isFull    = amountPaid > 0 && amountPending < PAID_EPSILON;
  const isPartial = !isFull && amountPaid > 0;

  // Persist the derived balance + status so the invoice/collection surfaces read them (not just tags).
  // Metafield writes don't fire the draft webhook → no loop.
  // A cad_advance-only draft has amountPaid 0 by design but still has a real balance to publish.
  if (isFull || isPartial || legs.length) {
    const patch = Object.assign({}, legacyFold.patch);
    // amount_paid is DERIVED from the legs. The admin panel writes legs but never the total (it is
    // read-only there), and the CAD flip changes the sum without touching any leg value — so
    // re-summing here is what keeps the figure the invoice prints actually true.
    if (legs.length) {
      const curPaid = parseFloat(mf('amount_paid'));
      if (!Number.isFinite(curPaid) || Math.abs(curPaid - amountPaid) >= 0.5) patch.amount_paid = amountPaid.toFixed(2);
      // Legacy field pinned to 0 so readers still summing the old pair get total + 0, never double.
      if ((parseFloat(mf('amount_paid_final')) || 0) !== 0) patch.amount_paid_final = '0';
    }
    const curPending = mf('amount_pending');
    if (curPending === null || Math.abs(parseFloat(curPending) - amountPending) >= 0.5) patch.amount_pending = amountPending.toFixed(2);
    const wantStatus = isFull ? 'Full' : 'Partial';  // choice-list values: Partial|Full|None
    if (paymentStatus !== wantStatus) patch.payment_status = wantStatus;
    // is_finalized drives is_fully_paid on the tax invoice (mto-invoice-template.liquid), so it must
    // track the balance in BOTH directions — otherwise a draft that reopens a balance (top-up, price
    // change, adjustment removed) keeps printing "fully paid" on a customer-facing invoice.
    if (isFull !== isFinalized) patch.is_finalized = isFull ? 'true' : 'false';
    if (Object.keys(patch).length) await updateDraftOrderMetafields(draftOrderId, patch);
  }
  if (!isFull && !isPartial && !legs.length) return false;

  const existingTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const cleanedTags  = existingTags.filter(t =>
    t.toLowerCase() !== 'sync-payment' &&
    !t.startsWith('deposit:') && !t.startsWith('paid:') && !t.startsWith('pending:') &&
    !t.startsWith('pmode-') && !t.startsWith('pmodes:') && !/^i[1-9]:/.test(t) && !t.startsWith('total:')
  );

  const paymentTags = [
    isFull ? 'deposit:fully-paid' : 'deposit:partial',
    `paid:Rs${Math.round(amountPaid)}`,
    ...(isPartial && amountPending > 0 ? [`pending:Rs${Math.round(amountPending)}`] : []),
    `total:Rs${totalPrice}`,
    // Aggregate mode tag — the draft-side sales report and recon both read modes off tags.
    ...(modes.length ? [`pmodes:${modes.join('/')}`] : []),
    // The whole installment table, encoded in ONE tag: value@mode@date, legs separated by ~.
    // Order Printer can hand a template empty order.metafields at print time — which is why every
    // other payment field here already has a tag fallback (deposit:/paid:/pending:/pmode-*). The
    // installment rows had none, so the payment table silently printed nothing. Well inside the
    // 255-char tag limit at 4 legs.
    ...legs.map(r => `i${r.slot}:${r.value}@${r.mode || ''}@${r.date || ''}${r.type === 'cad_advance' ? '@c' : ''}`),
    // DUAL-WRITE (remove at rollout step 6): the two-slot tags unmigrated readers still parse.
    ...(modeAdvance ? [`pmode-advance:${modeAdvance}`] : []),
    ...(modeFinal   ? [`pmode-final:${modeFinal}`]   : []),
  ];

  const proposedTags = [...cleanedTags, ...paymentTags];
  const proposedSet  = new Set(proposedTags.map(t => t.toLowerCase()));
  const existingSet  = new Set(existingTags.map(t => t.toLowerCase()));
  const unchanged = proposedSet.size === existingSet.size && [...proposedSet].every(t => existingSet.has(t));
  if (unchanged) {
    console.log(`Draft ${draftOrderId}: payment tags unchanged, skipping PUT`);
    return true;
  }

  await axios.put(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    { draft_order: { id: parseInt(draftOrderId), tags: proposedTags.join(', ') } },
    { headers, timeout: 10000 }
  );
  console.log(`Draft ${draftOrderId}: tags [${paymentTags.join(', ')}]`);
  return true;
}

// Runs on every draft_orders/update webhook — always rewrites payment tags from metafields.
async function handlePaymentMetafieldSync(draft) {
  const draftOrderId = draft?.id?.toString();
  if (!draftOrderId) return;
  const token = await getShopifyToken();
  await applyPaymentTagsToDraftOrder(draftOrderId, token);
}

// Universal net-to-collect: custom.amount_to_be_collected = draft total − ALL post-tax adjustments
// (exchange_note_value + voucher_value + old_gold_value + advance). Runs on every draft create/update so the
// field is correct in EVERY scenario (plain sale, discount, voucher, exchange, old-gold), not just
// exchange. Change-guarded so it never loops or writes a no-op. Metafield writes don't fire the
// draft webhook, so there's no recursion.
async function syncAmountToCollect(draft) {
  const draftOrderId = draft?.id?.toString();
  if (!draftOrderId) return;
  const token = await getShopifyToken();
  const { data: mfData } = await axios.get(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const mf  = (key) => { const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key); return m ? m.value : null; };
  const adj = (key) => Math.abs(parseFloat(mf(key)) || 0);
  const total = parseFloat(draft.total_price || 0);

  const patch = {};
  // Auto-value old gold from weight × buying rate — only when no human value is present (manual always wins).
  const oldGoldRaw = mf('old_gold_value');
  let   oldGoldVal = Math.abs(parseFloat(oldGoldRaw) || 0);
  if (!oldGoldRaw || oldGoldVal === 0) {
    const wt     = parseFloat(mf('old_gold_weight') || 0);
    const purity = parseFloat(mf('old_gold_purity') || 0);
    if (wt > 0 && purity > 0 && purity <= 24) {
      const rate = buyingRateFor(await getBuyingRateTable(), purity);
      if (rate != null) {
        oldGoldVal = +(wt * rate).toFixed(2);
        patch.old_gold_value = oldGoldVal.toFixed(2);
        console.log(`Draft ${draftOrderId}: old_gold_value auto = ${oldGoldVal} (${wt}g × ${rate}/g @ ${purity}kt)`);
      } else {
        console.warn(`Draft ${draftOrderId}: buying table unavailable or purity ${purity} out of range — old_gold_value left blank`);
      }
    }
  }

  const net = Math.max(0, total - adj('exchange_note_value') - adj('voucher_value') - oldGoldVal - adj('advance'));
  const current = mf('amount_to_be_collected');
  if (current === null || Math.abs(parseFloat(current) - net) >= 0.005) patch.amount_to_be_collected = net.toFixed(2);
  if (Object.keys(patch).length === 0) return; // nothing changed → skip (no-op guard)
  await updateDraftOrderMetafields(draftOrderId, patch);
  console.log(`Draft ${draftOrderId}: amount_to_be_collected = ${net.toFixed(2)} (total ${total} − adjustments)`);
}

// A draft carries a CAD advance if it has a "CAD Advance" line item (one product, fixed-price variants).
function hasCadAdvanceLine(draft) {
  return (draft.line_items || []).some(li =>
    /cad advance/i.test(String(li.title || '')) || /^CAD-ADV/i.test(String(li.sku || '')));
}

// CAD Advance CAPTURE (draft update): a draft carrying a CAD-Advance line + a recorded payment → stamp
// custom.advance / advance_date (starts the 365-day clock) / advance_status='open'. The draft stays open;
// syncAmountToCollect nets `advance` post-tax. Idempotent once advance_status is set. Never throws into
// the webhook chain.
//
// Path A also claims INSTALLMENT SLOT 1. The payment path has already recorded the collection as
// installment 1 (value + mode + date); when that leg is the advance, we flip its type to
// cad_advance. That leaves it visible on the invoice payment table as "Design Advance" — carrying
// the real mode and date, which the advance metafields themselves never captured — while removing
// it from amount_paid. Without the flip the same rupees are deducted twice: once by custom.advance
// reducing amount_to_be_collected, and again as money received.
//
// The flip only fires when the leg MATCHES the advance. A customer who paid more than the advance
// in one go has real collected money in that leg, and zeroing it would lose it — so we leave it as
// a payment leg and log for a human.
async function handleAdvanceCapture(draft) {
  try {
    if (!hasCadAdvanceLine(draft)) return;
    const draftOrderId = draft.id.toString();
    const token = await getShopifyToken();
    const { data: mfData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const mfMap = {};
    for (const m of (mfData.metafields || [])) if (m.namespace === 'custom') mfMap[m.key] = m.value;
    const mf = (key) => (mfMap[key] === undefined ? null : mfMap[key]);
    if (mf('advance_status')) return;                       // already captured
    if (!(parseFloat(mf('amount_paid') || 0) > 0)) return;  // advance is money collected, not intent
    const advanceAmount = (draft.line_items || [])
      .filter(li => /cad advance/i.test(String(li.title || '')) || /^CAD-ADV/i.test(String(li.sku || '')))
      .reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 0), 0);
    if (!(advanceAmount > 0)) return;
    const today = new Date().toISOString().slice(0, 10);
    const patch = { advance: advanceAmount.toFixed(2), advance_date: today, advance_status: 'open' };

    const legs = readInstallments(mfMap);
    const first = legs.find(r => r.slot === 1);
    if (first && first.type !== 'cad_advance' && Math.abs(first.value - advanceAmount) < 0.5) {
      patch.installment_1_type = 'cad_advance';
      // amount_paid must drop by the advance in the same write, or the balance is briefly wrong.
      patch.amount_paid = sumInstallments(legs.map(r => (r.slot === 1 ? { ...r, type: 'cad_advance' } : r))).toFixed(2);
      console.log(`[cad-advance] installment 1 (Rs${first.value.toFixed(2)} ${first.mode || 'mode unknown'}) reclassified as the design advance on draft ${draft.name || draftOrderId}`);
    } else if (first && first.type !== 'cad_advance') {
      console.warn(`[cad-advance] draft ${draft.name || draftOrderId}: installment 1 is Rs${first.value.toFixed(2)} but the CAD advance line is Rs${advanceAmount.toFixed(2)} — leaving it as a payment leg. Balance will net the advance once via custom.advance and count the full leg as paid; check this draft by hand.`);
    } else if (!first) {
      // Advance recorded without a payment leg (e.g. a panel-entered amount_paid). Synthesize the
      // leg so the invoice payment table still shows it; mode is unknown by construction.
      patch.installment_1_value = advanceAmount.toFixed(2);
      patch.installment_1_date  = today;
      patch.installment_1_type  = 'cad_advance';
    }

    await updateDraftOrderMetafields(draftOrderId, patch);
    console.log(`[cad-advance] captured ${advanceAmount.toFixed(2)} on draft ${draft.name || draftOrderId} (date ${today})`);
  } catch (e) {
    console.error(`[cad-advance] capture failed for draft ${draft?.id}:`, e.message);
  }
}

// CAD Advance REDEEM (Path B): staff put the advance order # in intake.advance_ref on a NEW sale draft.
// Resolve it, gate (advance_status==='open' AND ≤365 days from advance_date), then apply the advance
// POST-tax on the new draft (custom.advance → netted by syncAmountToCollect), mark the SOURCE order
// advance_status='redeemed' + redeemed_against, and clear the ref. On failure, tag advance-invalid:<why>.
// Transient lookup errors leave the ref in place to retry; never throws into the chain.
async function handleAdvanceRedeem(draft) {
  try {
    const draftOrderId = draft.id.toString();
    const base = process.env.SHOPIFY_STORE_URL;
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const { data: mfData } = await axios.get(
      `${base}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`, { headers, timeout: 10000 });
    const findMf = (ns, key) => (mfData.metafields || []).find(x => x.namespace === ns && x.key === key) || null;
    const refMf = findMf('intake', 'advance_ref');
    const ref = refMf ? String(refMf.value || '').trim() : '';
    if (!ref) return;

    const delRef = async () => {
      try { await axios.delete(`${base}/admin/api/2024-01/metafields/${refMf.id}.json`, { headers, timeout: 10000 }); }
      catch (e) { console.error(`[cad-advance] clear ref: ${e.message}`); }
    };
    const failTag = async (reason) => {
      const tags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean).concat([`advance-invalid: ${reason}`]);
      await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
        { draft_order: { id: draftOrderId, tags: [...new Set(tags)].join(', ') } }, { headers, timeout: 10000 });
      console.warn(`[cad-advance] ${draft.name || draftOrderId}: ${reason}`);
    };

    // Idempotent: advance already applied on this draft → just clear the ref.
    const already = findMf('custom', 'advance');
    if (already && parseFloat(already.value) > 0) { await delRef(); return; }

    // Resolve the advance ORDER by name ("#1042" or "1042"). Transient failure → keep ref, retry later.
    const name = ref.startsWith('#') ? ref : '#' + ref;
    let advOrder = null, lookupFailed = false;
    try {
      const { data } = await axios.get(
        `${base}/admin/api/2024-01/orders.json?status=any&name=${encodeURIComponent(name)}`, { headers, timeout: 15000 });
      advOrder = (data.orders || []).find(o => o.name === name) || (data.orders || [])[0] || null;
    } catch (e) { lookupFailed = true; console.error(`[cad-advance] resolve ${ref}: ${e.message}`); }
    if (lookupFailed) return;
    if (!advOrder) { await failTag(`not found ${ref}`); await delRef(); return; }

    const { data: aMfData } = await axios.get(
      `${base}/admin/api/2024-01/orders/${advOrder.id}/metafields.json`, { headers, timeout: 10000 });
    const a = {}; for (const m of (aMfData.metafields || [])) if (m.namespace === 'custom') a[m.key] = m.value;
    const advVal = parseFloat(a.advance || 0);
    if (!(advVal > 0))               { await failTag(`no advance on ${ref}`); await delRef(); return; }
    if (a.advance_status !== 'open') { await failTag(`already ${a.advance_status || 'used'}`); await delRef(); return; }
    const days = a.advance_date ? (Date.now() - new Date(a.advance_date).getTime()) / 864e5 : 1e9;
    if (days > 365)                  { await failTag(`expired ${a.advance_date}`); await delRef(); return; }

    // PASS — apply on the new draft, mark the source redeemed, clear the ref.
    await updateDraftOrderMetafields(draftOrderId, { advance: advVal.toFixed(2) });
    await updateOrderMetafields(String(advOrder.id), { advance_status: 'redeemed', redeemed_against: draft.name || draftOrderId }, token);
    await delRef();
    console.log(`[cad-advance] redeemed ${advVal.toFixed(2)} from ${ref} → ${draft.name || draftOrderId}`);
  } catch (e) {
    console.error(`[cad-advance] redeem failed for draft ${draft?.id}:`, e.message);
  }
}

// Strip a voucher / exchange-note adjustment off a draft — delete its value metafield, remove its tags,
// and recompute net-to-collect — WITHOUT touching the ledger. Used by the apply handlers for "latest-one-
// wins": an instrument re-applied to a new draft is removed from the one it was on. Never touches a
// converted order. Best-effort; callers wrap in try/catch.
async function stripInstrumentFromDraft(draftId, type, token) {
  const base = process.env.SHOPIFY_STORE_URL;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const valueKey   = type === 'voucher' ? 'voucher_value' : 'exchange_note_value';
  const codeKey    = type === 'voucher' ? 'voucher_code'  : 'exchange_note_code';
  const appliedTag = type === 'voucher' ? 'vch-applied'   : 'exc-applied';
  const numPrefix  = type === 'voucher' ? 'vch-num:'      : 'exc-num:';
  const [{ data }, { data: mfData }] = await Promise.all([
    axios.get(`${base}/admin/api/2024-01/draft_orders/${draftId}.json`, { headers, timeout: 10000 }),
    axios.get(`${base}/admin/api/2024-01/draft_orders/${draftId}/metafields.json`, { headers, timeout: 10000 }),
  ]);
  const draft = data.draft_order;
  if (!draft || draft.status === 'completed' || draft.order_id) return; // never touch a converted order
  const mfs = mfData.metafields || [];
  // Clear the code alongside the value — leaving a stale code behind would make the code-aware
  // apply guard reject the next instrument for a voucher/note the draft no longer holds.
  for (const k of [valueKey, codeKey]) {
    const m = mfs.find(x => x.namespace === 'custom' && x.key === k);
    if (m) await axios.delete(`${base}/admin/api/2024-01/metafields/${m.id}.json`, { headers, timeout: 10000 });
  }
  const adj = (key) => { const m = mfs.find(x => x.namespace === 'custom' && x.key === key); return m ? Math.abs(parseFloat(m.value) || 0) : 0; };
  const remaining = ['exchange_note_value', 'voucher_value', 'old_gold_value', 'advance']
    .filter(k => k !== valueKey).reduce((s, k) => s + adj(k), 0);
  const net = Math.max(0, parseFloat(draft.total_price || 0) - remaining).toFixed(2);
  await updateDraftOrderMetafields(draftId, { amount_to_be_collected: net });
  const tags = (draft.tags || '').split(',').map(t => t.trim())
    .filter(t => t && t !== appliedTag && !t.startsWith(numPrefix)).join(', ');
  await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftId}.json`,
    { draft_order: { id: Number(draftId), tags } }, { headers, timeout: 10000 });
  console.log(`[${type}] latest-one-wins: stripped off prior draft ${draftId}`);
}

// Apply a voucher from the metafield-manager admin action. Staff add an `apply-voucher:<code>` tag;
// this looks the voucher up in the ledger (value + validity — staff never type the amount), applies it
// POST-tax on the draft (voucher_value + net), records the redemption, deletes the online price rule,
// and removes the trigger tag. On failure it leaves a `voucher-invalid:<reason>` tag for the staff.
// Never throws into the webhook chain; stripping the trigger tag re-fires the webhook harmlessly.
async function handleApplyVoucherTag(draft) {
  try {
    const draftOrderId = draft.id.toString();
    const tags = (draft.tags || '').split(',').map(t => t.trim());
    const trigger = tags.find(t => /^apply-voucher:/i.test(t));
    if (!trigger) return;
    const vchNumber = trigger.slice(trigger.indexOf(':') + 1).trim();
    const base = process.env.SHOPIFY_STORE_URL;
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    // Strip the trigger (+ any stale invalid note); optionally add fresh linkage/invalid tags. One PUT.
    const finishTags = async (extra = []) => {
      const kept = tags.filter(t => t && !/^apply-voucher:/i.test(t) && !/^voucher-invalid:/i.test(t)).concat(extra);
      await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
        { draft_order: { id: draftOrderId, tags: [...new Set(kept)].join(', ') } }, { headers, timeout: 10000 });
    };
    if (!vchNumber) { await finishTags(); return; }

    const inst = await creditInstruments.getBySerial(supabase, { instrumentType: 'voucher', serialCode: vchNumber });
    if (!inst)                    { await finishTags([`voucher-invalid: ${vchNumber} not found`]); return; }
    const value = parseFloat(inst.value);
    if (!(value > 0))             { await finishTags([`voucher-invalid: ${vchNumber} no value`]); return; }
    const expired = inst.expires_at && new Date(inst.expires_at).getTime() < Date.now();
    if (inst.status === 'voided') { await finishTags([`voucher-invalid: ${vchNumber} voided`]); return; }
    if (inst.status === 'expired' || (inst.status === 'open' && expired)) { await finishTags([`voucher-invalid: ${vchNumber} expired`]); return; }
    // Lock-on-conversion: a voucher is only unusable once REDEEMED against a real (converted) order.
    // Until then it can move between drafts freely — the single-use lock happens at conversion.
    if (inst.status === 'redeemed') {
      await finishTags([`voucher-invalid: ${vchNumber} already redeemed on ${inst.target_order_name || inst.target_order_id || 'an order'}`]); return;
    }
    // Latest-one-wins: hold on ONE draft at a time. If it's currently applied to a DIFFERENT draft, strip
    // it off that draft first (tags + metafield + net recompute) so it can never be live on two drafts —
    // no double-spend. The apply() below re-points the ledger to this draft.
    if (inst.status === 'applied' && inst.target_draft_id && String(inst.target_draft_id) !== String(draftOrderId)) {
      try { await stripInstrumentFromDraft(inst.target_draft_id, 'voucher', token); }
      catch (e) { console.error(`[apply-voucher] strip prior draft ${inst.target_draft_id}:`, e.message); }
    }

    const { data: mfData } = await axios.get(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`, { headers, timeout: 10000 });
    const mfVal = (key) => { const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key); return m ? Math.abs(parseFloat(m.value) || 0) : 0; };
    // Already-applied guard, code-AWARE. The old test was `voucher_value > 0` alone, which is blind
    // to WHICH voucher is on the draft: applying VCH-B to a draft already holding VCH-A returned
    // success and re-tagged vch-num:VCH-B while the metafield still held A's value — the draft then
    // claimed a voucher it had not deducted, and B stayed 'open' in the ledger. One voucher per
    // draft is the rule (voucher_value is a single scalar), so a different code must be refused.
    // Read the code from the METAFIELD, not the tag: tags can be stripped by staff in the admin UI
    // (which would blind this guard again) and don't survive draft→order conversion. Fall back to
    // the tag for drafts written before voucher_code existed.
    const mfStr = (key) => { const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key); return m ? String(m.value || '').trim() : ''; };
    const appliedCode = mfStr('voucher_code') ||
      tags.map(t => /^vch-num:/i.test(t) ? t.slice(t.indexOf(':') + 1).trim() : null).find(Boolean);
    if (mfVal('voucher_value') > 0) {
      if (!appliedCode || appliedCode.toUpperCase() === vchNumber.toUpperCase()) {
        await finishTags(['vch-applied', `vch-num:${vchNumber}`]); return;   // same voucher re-applied: no-op
      }
      // Latest-one-wins WITHIN a draft, mirroring the existing across-drafts rule: applying B to a
      // draft holding A strips A and frees it back to 'open' rather than refusing. A is only
      // untouchable once redeemed — and a redeemed A can't be sitting on an open draft, because
      // redemption happens at conversion and a converted draft is never modified here.
      try {
        await stripInstrumentFromDraft(draftOrderId, 'voucher', token);
        await creditInstruments.reopen(supabase, { instrumentType: 'voucher', serialCode: appliedCode });
        console.log(`[apply-voucher] swapped ${appliedCode} → ${vchNumber} on draft ${draftOrderId}; ${appliedCode} reopened`);
      } catch (e) {
        console.error(`[apply-voucher] swap-out ${appliedCode}:`, e.message);
        await finishTags([`voucher-invalid: could not release ${appliedCode} — ${vchNumber} not applied`]);
        return;
      }
    }
    const adjustments  = value + mfVal('exchange_note_value') + mfVal('old_gold_value') + mfVal('advance');
    const netToCollect = Math.max(0, parseFloat(draft.total_price || 0) - adjustments).toFixed(2);
    // voucher_code rides alongside the value so the applied instrument is identifiable from the
    // metafields alone — the admin app renders it, the guard above reads it, and unlike a tag it
    // survives draft→order conversion so invoices can print it.
    await updateDraftOrderMetafields(draftOrderId, {
      voucher_code: vchNumber, voucher_value: value.toFixed(2), amount_to_be_collected: netToCollect });
    await finishTags(['vch-applied', `vch-num:${vchNumber}`]);

    try { await creditInstruments.apply(supabase, { instrumentType: 'voucher', serialCode: vchNumber, targetDraftId: draftOrderId, value }); }
    catch (e) { console.error('[apply-voucher] ledger:', e.message); }
    // The price rule is deliberately NOT deleted here. Applying to a draft is a reservation, not a
    // sale — the draft may be abandoned or deleted. Deletion happens at draft→order conversion (see
    // the lock-on-conversion block in the draft-completed handler), so an unconverted draft leaves
    // the voucher fully usable. Double-spend is already prevented by the ledger: a voucher held on
    // one draft is stripped from any other, and only the converting draft redeems it.
    console.log(`[apply-voucher] ${vchNumber} (${value}) applied to draft ${draft.name || draftOrderId}`);
  } catch (e) {
    console.error(`[apply-voucher] failed for draft ${draft?.id}:`, e.message);
  }
}

// Apply/reference an Exchange Note from the metafield-manager admin action. Staff add an
// `apply-exc:<number>` tag; this looks the note up in the credit-instrument ledger (value + validity —
// staff never type the amount), applies it POST-tax on the draft (exchange_note_value + net), records
// the redemption, and removes the trigger tag. On failure it leaves an `exc-invalid:<reason>` tag.
// Mirrors handleApplyVoucherTag; exchange notes carry no online price rule, so there's none to delete.
// syncAmountToCollect re-derives amount_to_be_collected right after, so the net is authoritative there.
async function handleApplyExcTag(draft) {
  try {
    const draftOrderId = draft.id.toString();
    const tags = (draft.tags || '').split(',').map(t => t.trim());
    const trigger = tags.find(t => /^apply-exc:/i.test(t));
    if (!trigger) return;
    const excNumber = trigger.slice(trigger.indexOf(':') + 1).trim();
    const base = process.env.SHOPIFY_STORE_URL;
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    // Strip the trigger (+ any stale invalid note); optionally add fresh linkage/invalid tags. One PUT.
    const finishTags = async (extra = []) => {
      const kept = tags.filter(t => t && !/^apply-exc:/i.test(t) && !/^exc-invalid:/i.test(t)).concat(extra);
      await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
        { draft_order: { id: draftOrderId, tags: [...new Set(kept)].join(', ') } }, { headers, timeout: 10000 });
    };
    if (!excNumber) { await finishTags(); return; }

    const inst = await creditInstruments.getBySerial(supabase, { instrumentType: 'exchange_note', serialCode: excNumber });
    if (!inst)                    { await finishTags([`exc-invalid: ${excNumber} not found`]); return; }
    const value = parseFloat(inst.value);
    if (!(value > 0))             { await finishTags([`exc-invalid: ${excNumber} no value`]); return; }
    const expired = inst.expires_at && new Date(inst.expires_at).getTime() < Date.now();
    if (inst.status === 'voided') { await finishTags([`exc-invalid: ${excNumber} voided`]); return; }
    if (inst.status === 'expired' || (inst.status === 'open' && expired)) { await finishTags([`exc-invalid: ${excNumber} expired`]); return; }
    // Lock-on-conversion (mirrors handleApplyVoucherTag): an exchange note only blocks once REDEEMED on a
    // converted order. Latest-one-wins between drafts; conversion locks it.
    if (inst.status === 'redeemed') {
      await finishTags([`exc-invalid: ${excNumber} already redeemed on ${inst.target_order_name || inst.target_order_id || 'an order'}`]); return;
    }
    // Latest-one-wins: strip off any prior draft it was applied to, so it holds on one draft at a time.
    if (inst.status === 'applied' && inst.target_draft_id && String(inst.target_draft_id) !== String(draftOrderId)) {
      try { await stripInstrumentFromDraft(inst.target_draft_id, 'exchange_note', token); }
      catch (e) { console.error(`[apply-exc] strip prior draft ${inst.target_draft_id}:`, e.message); }
    }

    const { data: mfData } = await axios.get(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}/metafields.json`, { headers, timeout: 10000 });
    const mfVal = (key) => { const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key); return m ? Math.abs(parseFloat(m.value) || 0) : 0; };
    // Code-aware guard (mirrors handleApplyVoucherTag): metafield first, tag as legacy fallback.
    // Blind `value > 0` let EXC-B silently no-op onto a draft already holding EXC-A while re-tagging
    // it as B — B's serial was already burnt, so its whole value was written off unnoticed.
    const mfStr = (key) => { const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key); return m ? String(m.value || '').trim() : ''; };
    const appliedExc = mfStr('exchange_note_code') ||
      tags.map(t => /^exc-num:/i.test(t) ? t.slice(t.indexOf(':') + 1).trim() : null).find(Boolean);
    if (mfVal('exchange_note_value') > 0) {
      if (!appliedExc || appliedExc.toUpperCase() === excNumber.toUpperCase()) {
        await finishTags(['exc-applied', `exc-num:${excNumber}`]); return;   // same note re-applied: no-op
      }
      // Latest-one-wins within the draft (see handleApplyVoucherTag for the rationale).
      try {
        await stripInstrumentFromDraft(draftOrderId, 'exchange_note', token);
        await creditInstruments.reopen(supabase, { instrumentType: 'exchange_note', serialCode: appliedExc });
        console.log(`[apply-exc] swapped ${appliedExc} → ${excNumber} on draft ${draftOrderId}; ${appliedExc} reopened`);
      } catch (e) {
        console.error(`[apply-exc] swap-out ${appliedExc}:`, e.message);
        await finishTags([`exc-invalid: could not release ${appliedExc} — ${excNumber} not applied`]);
        return;
      }
    }
    const adjustments  = value + mfVal('voucher_value') + mfVal('old_gold_value') + mfVal('advance');
    const netToCollect = Math.max(0, parseFloat(draft.total_price || 0) - adjustments).toFixed(2);
    await updateDraftOrderMetafields(draftOrderId, {
      exchange_note_code: excNumber, exchange_note_value: value.toFixed(2), amount_to_be_collected: netToCollect });
    await finishTags(['exc-applied', `exc-num:${excNumber}`]);

    try { await creditInstruments.apply(supabase, { instrumentType: 'exchange_note', serialCode: excNumber, targetDraftId: draftOrderId, value }); }
    catch (e) { console.error('[apply-exc] ledger:', e.message); }
    console.log(`[apply-exc] ${excNumber} (${value}) applied to draft ${draft.name || draftOrderId}`);
  } catch (e) {
    console.error(`[apply-exc] failed for draft ${draft?.id}:`, e.message);
  }
}

// Apply a PRE-TAX, DIAMOND-ONLY discount from the metafield-manager admin action. Staff add either:
//   apply-discount:<code>                 → resolve a real Shopify discount code (% or fixed ₹) via Admin API
//   apply-discount:custom:<value>:<pct|flat> → a custom order discount (% of diamond value, or flat ₹)
//
// This records the INTENT — discount_rate / discount_mode / discount_kind — and leaves the arithmetic to
// the reprice engine, which re-resolves it against the live diamond value on every run (see resolveDiscount).
// That is what makes the discount independent of weights: staff can discount before or after entering
// weights/carats, or swap the products entirely, and a % stays a %. (Previously the % was multiplied out to
// rupees here and frozen, so any later change to the diamond silently drifted the effective rate — e.g.
// #D172 held Rs11,240 from a 10% on a Rs112,400 diamond, still Rs11,240 after the products changed the
// diamond to Rs70,800: 15.9%.)
//
// We drop a `reprice` tag so the engine runs and bakes it in. Failure → discount-invalid tag.
async function handleApplyDiscountTag(draft) {
  try {
    const draftOrderId = draft.id.toString();
    const tags = (draft.tags || '').split(',').map(t => t.trim());
    const trigger = tags.find(t => /^apply-discount:/i.test(t));
    if (!trigger) return;
    const spec = trigger.slice(trigger.indexOf(':') + 1).trim();   // "<code>" | "custom:<v>:<pct|flat>"
    const base = process.env.SHOPIFY_STORE_URL;
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    const finishTags = async (extra = []) => {
      const kept = tags.filter(t => t && !/^apply-discount:/i.test(t) && !/^discount-invalid:/i.test(t)).concat(extra);
      await axios.put(`${base}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
        { draft_order: { id: draftOrderId, tags: [...new Set(kept)].join(', ') } }, { headers, timeout: 10000 });
    };
    if (!spec) { await finishTags(); return; }

    // Total diamond value across product lines (sum of the "Diamond" line prop, Rs). The discount base.
    const diaProp = (item) => {
      const p = (item.properties || []).find(x => x.name === 'Diamond');
      return p ? Math.abs(parseFloat(String(p.value).replace(/[^0-9.]/g, '')) || 0) : 0;
    };
    const diamondTotal = (draft.line_items || [])
      .filter(item => !isExcLine(item) && !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0))
      .reduce((sum, item) => sum + diaProp(item), 0);
    if (!(diamondTotal > 0)) { await finishTags(['discount-invalid: no diamond value to discount']); return; }

    // Resolve the input to a rate + mode + kind. `kind` is what tells the engine which basis the rate is
    // quoted against: custom → pre-tax diamond; code → Shopify's tax-inclusive prices (needs the /1.03
    // conversion). We deliberately do NOT multiply the rate out to rupees here — see the header.
    let rate = 0, mode = '', kind = '', label = '';
    if (/^custom:/i.test(spec)) {
      const parts = spec.split(':');                       // ["custom", "<v>", "<pct|flat>"]
      const v = Math.abs(parseFloat(parts[1]) || 0);
      const m = (parts[2] || 'flat').toLowerCase();
      if (!(v > 0)) { await finishTags(['discount-invalid: custom value missing']); return; }
      kind = 'custom';
      if (m === 'pct') { rate = v; mode = 'pct';  label = `CUSTOM ${v}%`; }
      else             { rate = v; mode = 'flat'; label = `CUSTOM Rs${v}`; }
    } else {
      // Real Shopify discount code → resolve its value via Admin GraphQL (percentage is a 0..1 fraction).
      const code = spec;
      const q = `query($code:String!){ codeDiscountNodeByCode(code:$code){ codeDiscount { __typename
        ... on DiscountCodeBasic { customerGets { value { __typename
          ... on DiscountPercentage { percentage }
          ... on DiscountAmount { amount { amount } } } } } } } }`;
      let node;
      try {
        const { data } = await axios.post(`${base}/admin/api/2024-01/graphql.json`,
          { query: q, variables: { code } }, { headers, timeout: 10000 });
        node = data?.data?.codeDiscountNodeByCode?.codeDiscount;
      } catch (e) { await finishTags([`discount-invalid: ${code} lookup failed`]); return; }
      if (!node) { await finishTags([`discount-invalid: ${code} not found`]); return; }
      const val = node?.customerGets?.value;
      kind = 'code';
      // percentage comes back as a 0..1 fraction; we store it as a percent so pct means the same in both kinds.
      if (val?.__typename === 'DiscountPercentage' && parseFloat(val.percentage) > 0) {
        rate = parseFloat(val.percentage) * 100; mode = 'pct';
      } else if (val?.__typename === 'DiscountAmount' && parseFloat(val.amount?.amount) > 0) {
        rate = parseFloat(val.amount.amount);    mode = 'flat';
      } else { await finishTags([`discount-invalid: ${code} unsupported`]); return; }
      label = code;
    }

    await updateDraftOrderMetafields(draftOrderId, {
      discount_rate: rate.toFixed(2),
      discount_mode: mode,
      discount_kind: kind,
      discount_code: label,
    });
    // Drop `reprice` so the engine resolves the rate and bakes it in dia-only, pre-tax.
    await finishTags(['discount-applied', 'reprice']);
    console.log(`[apply-discount] ${label} recorded (${kind}/${mode} rate=${rate}) on diamond base Rs${diamondTotal.toFixed(2)} — draft ${draft.name || draftOrderId}`);
  } catch (e) {
    console.error(`[apply-discount] failed for draft ${draft?.id}:`, e.message);
  }
}

// ─────────────────────────────────────────
// Pricing Engine — routes
// ─────────────────────────────────────────

app.post('/api/shopify-draft-updated', async (req, res) => {
  res.status(200).send('OK');
  try {
    const draft = req.body;
    if (!draft?.id) return;

    // Auto-hydrate line item properties from variant metafields on creation
    if ((req.headers['x-shopify-topic'] || '') === 'draft_orders/create') {
      await handleDraftCreated(draft);
      await handleWeightedDocReprice(draft);      // memo-custom / transfer weighted pricing (before serial + net-to-collect)
      await handleDocumentSerialTags(draft);      // PO/memo/transfer present at creation
      await syncAmountToCollect(draft);           // establish net-to-collect on every new draft
      return;
    }

    // When a draft is converted to an order, copy metafields and write payment tags
    if (draft.status === 'completed' && draft.order_id) {
      const draftOrderId = draft.id.toString();
      const orderId      = draft.order_id.toString();
      console.log(`Draft completed: #${draft.name} → order ${orderId}`);
      try {
        const token  = await getShopifyToken();
        const copied = await copyDraftMetafieldsToOrder(draftOrderId, orderId, token);
        console.log(`Draft completed: copied ${copied} metafields → order ${orderId}`);
        await applyPaymentTagsToOrder(orderId, token);
        // Lock-on-conversion: redeem the credit instruments actually carried on THIS converting draft, by
        // code (from its vch-num / exc-num tags) — NOT by draft reservation. This is what makes a voucher/
        // note single-use: it may sit on several in-progress drafts, but only the one that converts locks
        // it. Guard against double-spend if it's already redeemed on a different order.
        try {
          const { data: od } = await axios.get(
            `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${orderId}.json?fields=name`,
            { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
          const orderName = od?.order?.name || '';
          const dtags = (draft.tags || '').split(',').map(t => t.trim());
          const codeFrom = (re) => { const t = dtags.find(x => re.test(x)); return t ? t.slice(t.indexOf(':') + 1).trim() : ''; };
          const toRedeem = [
            { type: 'voucher',       code: codeFrom(/^vch-num:/i) },
            { type: 'exchange_note', code: codeFrom(/^exc-num:/i) },
          ].filter(x => x.code);
          for (const { type, code } of toRedeem) {
            try {
              const inst = await creditInstruments.getBySerial(supabase, { instrumentType: type, serialCode: code });
              if (inst && inst.status === 'redeemed' && String(inst.target_order_id || '') !== String(orderId)) {
                console.warn(`[ledger] ${type} ${code} already redeemed on ${inst.target_order_name || inst.target_order_id} — NOT double-redeeming on ${orderName || orderId}`);
                continue;
              }
              await creditInstruments.redeem(supabase, {
                instrumentType: type, serialCode: code,
                targetDraftId: draftOrderId, targetOrderId: orderId, targetOrderName: orderName, value: inst?.value,
              });
              console.log(`Draft completed: redeemed ${type} ${code} → ${orderName || orderId}`);
              // Destroy the Shopify discount code HERE, at conversion — the moment the voucher is
              // genuinely consumed. It used to be deleted at apply time, which stranded the credit:
              // if the draft was then abandoned or deleted, the ledger still said 'applied' but the
              // code was already gone, leaving the customer unable to redeem online and nothing
              // watching for it. Exchange notes carry no price rule.
              if (type === 'voucher' && inst && inst.price_rule_id) {
                try {
                  await axios.delete(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/price_rules/${inst.price_rule_id}.json`,
                    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 });
                } catch (e) { console.error(`[ledger] price-rule delete for ${code}:`, e.message); }
              }
            } catch (e) { console.error(`[ledger] redeem ${type} ${code} at conversion:`, e.message); }
          }
        } catch (e) { console.error('[ledger] conversion redeem:', e.message); }
      } catch (err) {
        console.error('Draft completed handler error:', err.message);
      }
      return;
    }

    // Auto-hydrate if any product line items are missing the Gold property (option 2: on update, not just create).
    // Exclude items that have _gold_rate — that property is written by reprice and preserved by hydrate,
    // so its presence with Gold absent means the item was repriced but the payload was truncated.
    const needsHydration = (draft.line_items || []).some(item =>
      item.variant_id &&
      !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0) &&
      !(item.properties || []).some(p => p.name === 'Gold') &&
      !(item.properties || []).some(p => p.name === '_gold_rate')
    );
    if (needsHydration) await handleDraftCreated(draft);

    // Tag-based handlers (fire independently, each removes its own tag).
    // Each is isolated: these handlers are unrelated to one another, so a throw in an early one
    // must not silently skip every handler after it. Order is still preserved.
    const step = async (name, fn) => {
      try { await fn(); }
      catch (err) { console.error(`Draft updated webhook — ${name} failed for #${draft.name}:`, err.message); }
    };
    await step('send-link',        () => handleSendLinkTag(draft));
    await step('cash-payment',     () => handleCashPaymentTag(draft));
    await step('recalc-price',     () => handleRecalculatePriceTag(draft, { force: false }));
    await step('recalc-price+force', () => handleRecalculatePriceTag(draft, { force: true }));
    await step('weighted-reprice', () => handleWeightedDocReprice(draft));   // memo-custom / transfer weighted pricing (before serial + net-to-collect)
    await step('advance-capture',  () => handleAdvanceCapture(draft));       // CAD: stamp advance metafields once a payment lands
    await step('advance-redeem',   () => handleAdvanceRedeem(draft));        // CAD: apply a referenced advance (Path B), gates + refs
    await step('apply-voucher',    () => handleApplyVoucherTag(draft));      // admin action: apply-voucher:<code> → redeem from ledger
    await step('apply-exc',        () => handleApplyExcTag(draft));          // admin action: apply-exc:<number> → redeem exchange note from ledger
    await step('apply-discount',   () => handleApplyDiscountTag(draft));     // admin action: apply-discount:<code>|custom → dia-only pre-tax discount (drops reprice)
    await step('repairs',          () => handleRepairDraftUpdate(draft, getShopifyToken, assignRepairSerial));
    await step('document-serial',  () => handleDocumentSerialTags(draft));   // PO/memo/transfer tags added after creation
    // Balance ordering matters: net-to-collect must be recomputed AFTER every adjustment above
    // (voucher / advance / exchange / old-gold), and amount_pending is DERIVED off that fresh net —
    // so the payment sync runs LAST. (Previously it ran before the adjustments, leaving pending stale.)
    await step('sync-net',         () => syncAmountToCollect(draft));        // recompute net-to-collect after ALL adjustments above
    await step('payment-sync',     () => handlePaymentMetafieldSync(draft)); // derive amount_pending off the FRESH net (must run last)

    console.log(`Draft updated webhook: #${draft.name} — tag handlers complete`);
  } catch (err) {
    console.error('Draft updated webhook error:', err.message);
  }
});

// Unified reprice endpoint — equivalent to adding the reprice or recalculate-price tag.
// threshold=false (default): full reprice — fixes discount/GST and jewel reprices if jewelcode_net_weight is set.
// threshold=true: guarded reprice — jewel reprice only if weight delta > 5% (requires jewelcode_net_weight).
app.post('/api/reprice', async (req, res) => {
  const { draftOrderId, threshold = false } = req.body;
  if (!draftOrderId) return res.status(400).json({ success: false, error: 'draftOrderId required' });
  try {
    const token = await getShopifyToken();
    const { data: draftData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
    const tagToInject = threshold ? 'recalculate-price' : 'reprice';
    const draft = { ...draftData.draft_order };
    const existingTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!existingTags.some(t => t.toLowerCase() === tagToInject)) {
      draft.tags = [...existingTags, tagToInject].join(', ');
    }
    await handleRecalculatePriceTag(draft, { force: !threshold });
    return res.json({ success: true, draftOrderId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, detail: err.response?.data });
  }
});

// Manually override per-unit prices for specific line items in a draft order.
// Clears applied_discount and updates display properties (Gross Value, Taxable Value, GST, Discount Applied).
// All other properties (Gold, Diamond, Making, hidden props) are preserved.
// Body: { draftOrderId, lineItems: [{ id: <lineItemId>, price: <perUnitINR> }] }
app.post('/api/set-line-prices', async (req, res) => {
  const { draftOrderId, lineItems } = req.body;
  if (!draftOrderId || !Array.isArray(lineItems) || lineItems.length === 0) {
    return res.status(400).json({ success: false, error: 'draftOrderId and lineItems[] required' });
  }

  const FINANCIAL_PROPS = new Set(['Gross Value', 'Discount Applied', 'Taxable Value', 'GST']);

  try {
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    const { data } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers, timeout: 10000 }
    );
    const draft = data.draft_order;

    const overrideMap = new Map(
      lineItems.map(li => [Number(li.id), parseFloat(li.price)]).filter(([, p]) => !isNaN(p) && p >= 0)
    );

    const updatedLineItems = (draft.line_items || []).map(item => {
      const newUnitPrice = overrideMap.get(item.id);
      if (newUnitPrice === undefined) {
        return { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
      }
      const qty       = item.quantity || 1;
      const lineTotal = newUnitPrice * qty;
      const taxable   = lineTotal / 1.03;
      const gst       = taxable * 0.03;
      const preserved = (item.properties || []).filter(p => !FINANCIAL_PROPS.has(p.name));
      const newProps = [
        { name: 'Gross Value',      value: `Rs${lineTotal.toFixed(2)}` },
        { name: 'Discount Applied', value: 'Rs0' },
        { name: 'Taxable Value',    value: `Rs${taxable.toFixed(2)}` },
        { name: 'GST',              value: `Rs${gst.toFixed(2)}` },
        ...preserved,
      ];
      return { variant_id: item.variant_id || undefined, quantity: qty, price: newUnitPrice.toFixed(2), properties: newProps, title: item.title };
    });

    await gqlSetDraftLineItems(draftOrderId, updatedLineItems, token, { clearDiscount: true });

    return res.json({ success: true, draftOrderId, updatedCount: overrideMap.size });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Unified form-driven reprice endpoint — called by the Google Form Apps Script.
// All value fields are comma-separated strings positionally mapped to product line items.
//
// mode="manual": Gold+Diamond+Making+Discount drive price. Gold can be auto-computed from goldRate×netWt.
//   gold, diamond, making, discount, netWeights, grossWeights, diamondCarats, diamondPcs, gemstoneWeights
//   goldRate (Rs/g for goldKarat), goldKarat (number e.g. 22)
//   Price = (Gold+Diamond+Making−Discount)/qty. GST auto-computed.
//   _gold_rate stored as rate for each item's own karat, locked to submission timestamp.
//
// mode="weights": gold-rate-driven reprice; price computed automatically from gold rate × net wt.
//   netWeights, grossWeights, diamondCarats, diamondPcs, gemstoneWeights, force
//   goldRate + goldKarat — if provided, _gold_rate is updated on line items BEFORE the reprice runs.
app.post('/api/form-reprice', async (req, res) => {
  const { draftOrderId, mode, netWeights, grossWeights, diamondCarats, diamondPcs, gemstoneWeights, force = false } = req.body;
  if (!draftOrderId || !mode) {
    return res.status(400).json({ success: false, error: 'draftOrderId and mode required' });
  }

  // Items separated by "/" so users can type Indian-formatted numbers freely (e.g. "21,165/26,422")
  const parseCsv = (val) => String(val || '').split('/').map(s => s.replace(/,/g, '').trim()).map(parseFloat);

  // Extract karat number from variant_title / title (e.g. "18Kt Yellow Gold" → 18)
  const itemKarat = (item) => {
    const text = [item.variant_title, item.title].filter(Boolean).join(' ');
    const m = text.match(/(\d+)\s*[Kk][Tt]?/);
    return m ? parseInt(m[1]) : null;
  };

  // Convert an input rate from inputKarat to targetKarat using simple proportional purity
  const convertRate = (rate, fromKt, toKt) => {
    if (!rate || !fromKt || !toKt || fromKt === toKt) return rate;
    return rate * (toKt / fromKt);
  };

  const writeJewelMfs = async (id, hdrs, mfMap) => {
    const { data: mfData } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${id}/metafields.json`,
      { headers: hdrs, timeout: 10000 }
    );
    const existing = {};
    for (const mf of (mfData.metafields || [])) if (mf.namespace === 'custom') existing[mf.key] = mf;
    await Promise.all(Object.entries(mfMap).filter(([, v]) => v).map(async ([key, value]) => {
      const payload = { metafield: { namespace: 'custom', key, value: String(value), type: 'single_line_text_field' } };
      if (existing[key]) {
        await axios.put(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${id}/metafields/${existing[key].id}.json`, payload, { headers: hdrs, timeout: 10000 });
      } else {
        await axios.post(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${id}/metafields.json`, payload, { headers: hdrs, timeout: 10000 });
      }
    }));
  };

  try {
    const token   = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    const { data } = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
      { headers, timeout: 10000 }
    );
    const draft = data.draft_order;

    const productItems = (draft.line_items || []).filter(
      item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
    );

    if (mode === 'manual') {
      // Every invoice field as comma-separated input, positionally applied per product line item.
      // Blank entry in a CSV position → fall back to the item's existing property value.
      const inputGoldRate  = parseFloat(req.body.goldRate) || 0;
      const inputGoldKt    = parseFloat(req.body.goldKarat) || 0;
      const invoiceDateRaw = String(req.body.invoiceDate || '').trim();
      const lockedAt = (() => {
        if (!invoiceDateRaw) return new Date().toISOString();
        const parts = invoiceDateRaw.split(/[-\/]/);
        const parsed = parts.length === 3 ? new Date(`${parts[2]}-${parts[1]}-${parts[0]}T12:00:00.000Z`) : null;
        return parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
      })();

      const goldArr   = parseCsv(req.body.gold);
      const diaArr    = parseCsv(req.body.diamond);
      const makingArr = parseCsv(req.body.making);
      const discArr   = parseCsv(req.body.discount);
      const netArr    = parseCsv(netWeights);
      const grossArr  = parseCsv(grossWeights);
      const diaCtsArr = parseCsv(diamondCarats);
      const diaPcsArr = parseCsv(req.body.diamondPcs || diamondPcs);
      const gemArr    = parseCsv(gemstoneWeights);

      const allArrays     = [goldArr, diaArr, makingArr, discArr, netArr, grossArr, diaCtsArr, diaPcsArr, gemArr];
      const overrideCount = Math.max(
        ...(inputGoldRate > 0 ? [1] : []),
        ...allArrays.map(arr => arr.filter(v => !isNaN(v)).length)
      );
      if (overrideCount === 0) {
        return res.status(400).json({ success: false, error: 'At least one field required for manual mode' });
      }

      const existingPropNum = (item, name) => {
        const p = (item.properties || []).find(p => p.name === name);
        return p ? parseFloat((p.value || '0').replace('Rs', '').trim()) || 0 : 0;
      };

      const pick = (arr, idx, fallback) => (!isNaN(arr[idx]) ? arr[idx] : fallback);

      const OVERWRITE_PROPS = new Set(['Gold', 'Diamond', 'Making', 'Gross Value', 'Discount Applied',
        'Taxable Value', 'GST', '_net_wt', '_gross_wt', '_diamond_cts', '_diamond_pcs',
        '_gemstone_cts', '_jewel_data', '_gold_rate', '_gold_updated_at']);

      const rate18kt = inputGoldRate && inputGoldKt ? convertRate(inputGoldRate, inputGoldKt, 18) : 0;

      // Compute target price + properties for each item to override
      const targets = new Map(); // original item.id → { qty, pricePerUnit, newProps }
      (draft.line_items || []).forEach(item => {
        const idx = productItems.findIndex(pi => pi.id === item.id);
        if (idx === -1 || idx >= overrideCount) return;
        const qty = item.quantity || 1;

        const ikt         = itemKarat(item) || inputGoldKt || 18;
        const rateForItem = inputGoldRate && inputGoldKt ? convertRate(inputGoldRate, inputGoldKt, ikt) : 0;

        const netWt  = pick(netArr,    idx, null);
        const grossWt= pick(grossArr,  idx, null);
        const diaCts = pick(diaCtsArr, idx, null);
        const diaPcs = pick(diaPcsArr, idx, null);
        const gemWt  = pick(gemArr,    idx, null);

        let gold;
        if (!isNaN(goldArr[idx])) {
          gold = goldArr[idx];
        } else if (rateForItem > 0 && netWt !== null && netWt > 0) {
          gold = rateForItem * netWt;
        } else {
          gold = existingPropNum(item, 'Gold');
        }

        const dia    = pick(diaArr,    idx, existingPropNum(item, 'Diamond'));
        const making = pick(makingArr, idx, existingPropNum(item, 'Making'));
        const disc   = pick(discArr,   idx, existingPropNum(item, 'Discount Applied'));
        const grossComponents = gold + dia + making;
        const taxable         = grossComponents - disc;
        const gst             = taxable * 0.03;
        const grossValue      = taxable + gst;

        const preserved = (item.properties || []).filter(p => !OVERWRITE_PROPS.has(p.name));
        const newProps  = [
          { name: 'Gold',             value: `Rs${gold.toFixed(2)}`          },
          { name: 'Diamond',          value: `Rs${dia.toFixed(2)}`           },
          { name: 'Making',           value: `Rs${making.toFixed(2)}`        },
          { name: 'Gross Value',      value: `Rs${grossValue.toFixed(2)}`    },
          { name: 'Discount Applied', value: `Rs${disc.toFixed(2)}`          },
          { name: 'Taxable Value',    value: `Rs${taxable.toFixed(2)}`       },
          { name: 'GST',             value: `Rs${gst.toFixed(2)}`            },
          ...preserved,
        ];
        if (netWt  !== null) newProps.push({ name: '_net_wt',       value: netWt.toFixed(3)   });
        if (grossWt!== null) newProps.push({ name: '_gross_wt',     value: grossWt.toFixed(3) });
        if (diaCts !== null) newProps.push({ name: '_diamond_cts',  value: diaCts.toFixed(2)  });
        if (diaPcs !== null) newProps.push({ name: '_diamond_pcs',  value: String(Math.round(diaPcs)) });
        if (gemWt  !== null) newProps.push({ name: '_gemstone_cts', value: gemWt.toFixed(2)   });
        if (rateForItem > 0) {
          newProps.push({ name: '_gold_rate',       value: rateForItem.toFixed(2) });
          newProps.push({ name: '_gold_updated_at', value: lockedAt               });
        } else {
          const existingRate = (item.properties || []).find(p => p.name === '_gold_rate');
          const existingTs   = (item.properties || []).find(p => p.name === '_gold_updated_at');
          if (existingRate) newProps.push({ name: '_gold_rate',       value: existingRate.value });
          if (existingTs)   newProps.push({ name: '_gold_updated_at', value: existingTs.value   });
        }
        const existingJd = (item.properties || []).find(p => p.name === '_jewel_data');
        let jd = {};
        try { jd = JSON.parse(existingJd?.value || '{}'); } catch (_) {}
        newProps.push({ name: '_jewel_data', value: JSON.stringify({ ...jd, repriced: true }) });

        targets.set(item.id, { qty, pricePerUnit: (grossValue / qty).toFixed(2), newProps });
      });

      const rate18ktResponse = rate18kt ? parseFloat(rate18kt.toFixed(2)) : undefined;

      console.log(`[form-reprice] manual draft=${draftOrderId} productItems=${productItems.length} overrideCount=${overrideCount}`);
      targets.forEach((t, id) => {
        console.log(`[form-reprice] target id=${id} price=${t.pricePerUnit} props=${t.newProps.filter(p => !p.name.startsWith('_')).map(p => `${p.name}=${p.value}`).join(' ')}`);
      });

      await writeJewelMfs(draftOrderId, headers, {
        jewelcode_net_weight:      String(netWeights     || '').trim(),
        jewelcode_gross_weight:    String(grossWeights   || '').trim(),
        jewelcode_diamond_carats:  String(diamondCarats  || '').trim(),
        jewelcode_gemstone_weight: String(gemstoneWeights|| '').trim(),
      });

      const lineItemsToSet = (draft.line_items || [])
        .filter(item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0))
        .map(item => {
          const t = targets.get(item.id);
          return { variant_id: item.variant_id || undefined, quantity: t ? t.qty : item.quantity, price: t ? t.pricePerUnit : item.price, properties: t ? t.newProps : (item.properties || []), title: item.title, taxable: item.taxable, requires_shipping: item.requires_shipping };
        });

      // Merge invoice_date override into existing note_attributes (order-level, read by invoice template)
      const mergedNoteAttrs = (draft.note_attributes || []).filter(a => a.name !== 'invoice_date');
      if (invoiceDateRaw) mergedNoteAttrs.push({ name: 'invoice_date', value: invoiceDateRaw });

      console.log(`[form-reprice] sending ${lineItemsToSet.length} items:`, JSON.stringify(lineItemsToSet.map(li => ({ v: li.variant_id || li.title, price: li.price }))));
      const gqlNodes = await gqlSetDraftLineItems(draftOrderId, lineItemsToSet, token, { clearDiscount: true, noteAttributes: mergedNoteAttrs });
      gqlNodes.forEach((li, i) => console.log(`[form-reprice] item[${i}] id=${li.id} originalUnitPrice=${li.originalUnitPrice} discountedUnitPrice=${li.discountedUnitPrice}`));
      return res.json({ success: true, draftOrderId, mode: 'manual', updatedCount: overrideCount, ...(rate18ktResponse ? { rate18kt: rate18ktResponse } : {}) });

    } else if (mode === 'weights') {
      if (!String(netWeights || '').trim()) {
        return res.status(400).json({ success: false, error: 'netWeights required for weights mode' });
      }

      // If a gold rate is provided, lock it onto each line item BEFORE the reprice runs
      // so handleRecalculatePriceTag picks up the new rate from _gold_rate props.
      const inputGoldRate = parseFloat(req.body.goldRate) || 0;
      const inputGoldKt   = parseFloat(req.body.goldKarat) || 0;
      const lockedAt = (() => {
        const raw = String(req.body.invoiceDate || '').trim();
        if (!raw) return new Date().toISOString();
        const parts = raw.split(/[-\/]/);
        const parsed = parts.length === 3 ? new Date(`${parts[2]}-${parts[1]}-${parts[0]}T12:00:00.000Z`) : null;
        return parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
      })();
      if (inputGoldRate > 0 && inputGoldKt > 0) {
        const ratePatched = (draft.line_items || []).map(item => {
          const ikt         = itemKarat(item) || inputGoldKt;
          const rateForItem = convertRate(inputGoldRate, inputGoldKt, ikt);
          const props = (item.properties || [])
            .filter(p => p.name !== '_gold_rate' && p.name !== '_gold_updated_at');
          props.push({ name: '_gold_rate',       value: rateForItem.toFixed(2) });
          props.push({ name: '_gold_updated_at', value: lockedAt               });
          return { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: props, title: item.title };
        });
        await gqlSetDraftLineItems(draftOrderId, ratePatched, token);
      }

      await writeJewelMfs(draftOrderId, headers, {
        jewelcode_net_weight:      String(netWeights     || '').trim(),
        jewelcode_gross_weight:    String(grossWeights   || '').trim(),
        jewelcode_diamond_carats:  String(diamondCarats  || '').trim(),
        jewelcode_gemstone_weight: String(gemstoneWeights|| '').trim(),
      });

      const tagToInject   = force ? 'reprice' : 'recalculate-price';
      const existingTags  = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const injectedDraft = { ...draft, tags: [...existingTags, tagToInject].join(', ') };
      await handleRecalculatePriceTag(injectedDraft, { force: !!force });

      // Patch _diamond_pcs onto line items if provided (reprice handler doesn't set this)
      const pcsStr = String(diamondPcs || '').trim();
      if (pcsStr) {
        const pcsArr = parseCsv(pcsStr);
        const { data: refreshed } = await axios.get(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
          { headers, timeout: 10000 }
        );
        const refreshedProductItems = (refreshed.draft_order.line_items || []).filter(
          item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
        );
        const patchedItems = (refreshed.draft_order.line_items || []).map(item => {
          const idx = refreshedProductItems.findIndex(pi => pi.id === item.id);
          if (idx === -1 || idx >= pcsArr.length || isNaN(pcsArr[idx])) {
            return { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: item.properties || [], title: item.title };
          }
          const props = (item.properties || []).filter(p => p.name !== '_diamond_pcs');
          props.push({ name: '_diamond_pcs', value: String(Math.round(pcsArr[idx])) });
          return { variant_id: item.variant_id || undefined, quantity: item.quantity, price: item.price, properties: props, title: item.title };
        });
        await gqlSetDraftLineItems(draftOrderId, patchedItems, token);
      }
      return res.json({ success: true, draftOrderId, mode: 'weights', force: !!force });

    } else {
      return res.status(400).json({ success: false, error: `Unknown mode "${mode}". Use "manual" or "weights"` });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
    // Label by what is already paid across BOTH surfaces — see reconcileDepositPaid. Advisory only;
    // the authoritative stage is re-derived when the payment completes.
    const { data: existingDeposit } = await supabase
      .from('store_deposits').select('amount_paid')
      .eq('draft_order_id', draftOrderId.toString()).maybeSingle();
    const { installmentType } = await reconcileDepositPaid(draftOrderId.toString(), existingDeposit);

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
      // Check if this is a repair draft before touching payment_links
      try {
        const repairToken = await getShopifyToken();
        const { data: repairData } = await axios.get(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
          { headers: { 'X-Shopify-Access-Token': repairToken }, timeout: 10000 }
        );
        const repairDraft = repairData?.draft_order;
        if (repairDraft) {
          const repairTags = (repairDraft.tags || '').split(',').map(t => t.trim());
          if (repairTags.includes('repair-estimate-sent') || repairTags.includes('repair-estimate-ready')) {
            await handleRepairPayment(repairDraft, { transactionId: transaction_id, gatewayRef: gateway_reference_id }, getShopifyToken);
            return;
          }
        }
      } catch (repairErr) {
        console.error('Repair branch check failed, falling through to deposit flow:', repairErr.message);
      }

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
      }, { utr: gateway_reference_id, paymentSource: 'gokwik', paymentModeOverride: 'online_link' });
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
  const { draftOrderId, draftOrderName, amountInRupees, totalAmountInRupees, customerName, notes, paymentMode } = req.body;
  if (!draftOrderId || !amountInRupees) {
    return res.status(400).json({ success: false, error: 'Missing: draftOrderId, amountInRupees' });
  }
  try {
    const resolvedMode = paymentMode || 'cash';
    await handlePaymentCompletion({
      shopify_draft_id:   draftOrderId.toString(),
      draft_order_name:   draftOrderName || draftOrderId.toString(),
      amount_paisa:       Math.round(parseFloat(amountInRupees) * 100),
      total_amount_paisa: totalAmountInRupees ? Math.round(parseFloat(totalAmountInRupees) * 100) : null,
      is_partial:         true,
      pine_ref_id:        null,
      customer_name:      customerName || '',
      id:                 `cash-${Date.now()}`
    }, { utr: null, paymentSource: resolvedMode === 'cash' ? 'cash' : 'manual', paymentModeOverride: resolvedMode });

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
    const { line_items, tags, name, total_price, applied_discount } = data.draft_order;

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

    return res.json({ success: true, draftOrderId, name, tags, total_price, applied_discount, line_items: enriched });
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

// PO Ops routes live in src/modules/procurement/routes.js.
// SERIAL_DEPS comes from the serialization module — five call sites below allocate or
// cancel serials outside its routes.
const { SERIAL_DEPS } = require('./src/modules/serialization/routes');


// Price-update lock + admin/backfill routes live in src/modules/admin/routes.js.

// Reporting routes now live in src/modules/reporting/routes.js — registered below.


// ─────────────────────────────────────────
// POST /api/cn-email
// Called by Apps Script after Voucher creation. (Route name kept for back-compat; cnNumber now
// carries the VCH-YYYY-NNNN code.) Sends the voucher email via Resend.
// ─────────────────────────────────────────
app.post('/api/cn-email', async (req, res) => {
  const { customerName, customerEmail, cnNumber, creditValue, validUntil, originalOrder } = req.body;
  if (!customerEmail || !cnNumber) {
    return res.status(400).json({ error: 'customerEmail and cnNumber are required' });
  }
  try {
    await sendEmail({
      to:      customerEmail,
      cc:      withStoreCc(),   // store inbox sees every voucher it issues
      subject: `Your Timanti Voucher — Rs.${creditValue} | Code: ${cnNumber}`,
      html:    buildVoucherV2Html({ customerName, cnNumber, creditValue, validUntil, originalOrder })
    });
    console.log(`Voucher email sent → ${customerEmail} | ${cnNumber}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Voucher email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/exc-email
// Called by Apps Script after an Exchange Note is applied to a new invoice.
// Confirmation only — there is no code to redeem and no expiry; the value is already deducted.
// ─────────────────────────────────────────
app.post('/api/exc-email', async (req, res) => {
  const { customerName, customerEmail, excNumber, excValue, oldOrder, newOrder } = req.body;
  if (!customerEmail || !excNumber) {
    return res.status(400).json({ error: 'customerEmail and excNumber are required' });
  }
  try {
    await sendEmail({
      to:      customerEmail,
      cc:      withStoreCc(),   // store inbox sees every exchange note it applies
      subject: `Your Timanti Exchange Note — Rs.${excValue} applied | ${excNumber}`,
      html:    buildExchangeNoteV2Html({ excNumber, excValue, oldOrder, newOrder })
    });
    console.log(`EXC email sent → ${customerEmail} | ${excNumber}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('EXC email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolves a draft-order reference to a numeric id. Accepts a numeric id (passed through) or a
// draft name like "#D123" / "D123" / "d123" (REST draft_orders can't filter by name, so we scan).
//
// Matching is EXACT but NORMALISED — case-insensitive, tolerant of a missing/extra "#" and of stray
// spaces. GraphQL's `name:` search is fuzzy and unreliable with "#" (it matched "#D1" for "#D139"),
// so we compare ourselves; but a literal `===` was too strict the other way — staff type "d186",
// Shopify stores "#D186", and the apply died as `draft "d186" not found` with nothing else logged.
//
// Scans OPEN first, then INVOICE_SENT: a draft whose invoice has already been emailed is still a
// draft and is a legitimate target for an exchange note / voucher. Only `completed` (already a real
// order) is excluded — credits must be applied before conversion.
async function resolveDraftId(ref, token) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/^#/, '').toUpperCase();
  const want = norm(raw);
  if (!want) return null;
  const headers = { 'X-Shopify-Access-Token': token };
  for (const status of ['open', 'invoice_sent']) {
    let url = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json?limit=250&status=${status}`;
    while (url) {
      const resp = await axios.get(url, { headers, timeout: 30000 });
      const node = (resp.data.draft_orders || []).find(d => norm(d.name) === want);
      if (node) return String(node.id).split('/').pop();
      const link = resp.headers['link'] || '';
      const m = link.match(/<([^>]*page_info=[^>&"]+[^>]*)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
  }
  return null;
}

// Maps a Shopify REST draft line item back to the gqlSetDraftLineItems input shape (verbatim
// pass-through — preserves custom prices, titles, and properties on re-send).
function draftLineToInput(li) {
  return {
    variant_id:        li.variant_id || undefined,
    title:             li.title,
    quantity:          li.quantity,
    price:             li.price,
    taxable:           li.taxable,
    requires_shipping: li.requires_shipping,
    properties:        (li.properties || []).map(p => ({ name: p.name, value: p.value })),
  };
}

// ─────────────────────────────────────────
// POST /api/exc-redeem
// Applies an Exchange Note as a POST-tax adjustment on a new draft order, stored in the
// custom.exchange_note_value metafield (Shopify rejects negative line items). Also writes
// custom.amount_to_be_collected = draft total − all post-tax adjustments (exchange_note_value +
// voucher_value + old_gold_value). The invoice template reads these and deducts after GST. The
// EXC value was already minted at /api/serial/allocate. Linkage (old order) lives in tags. Body:
//   { newDraftRef, excNumber, excValue, oldOrderNumber?, customerName? }
//   newDraftRef = numeric draft id OR a draft name like "#D123".
// NOTE: keying amount_to_be_collected INTO amount_paid/amount_pending is a separate consolidated step.
// ─────────────────────────────────────────
app.post('/api/exc-redeem', async (req, res) => {
  const { newDraftRef, excNumber, excValue, oldOrderNumber } = req.body || {};
  const value = parseFloat(excValue);
  if (!newDraftRef || !excNumber || !(value > 0)) {
    return res.status(400).json({ success: false, error: 'newDraftRef, excNumber and excValue>0 are required' });
  }
  try {
    const token = await getShopifyToken();
    const newDraftId = await resolveDraftId(newDraftRef, token);
    if (!newDraftId) return res.status(404).json({ success: false, error: `draft "${newDraftRef}" not found` });
    // 1. Fetch the draft (for tags) and its metafields (for idempotency).
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const [{ data }, { data: mfData }] = await Promise.all([
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`, { headers, timeout: 10000 }),
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}/metafields.json`, { headers, timeout: 10000 }),
    ]);
    const draft = data.draft_order;
    if (!draft) return res.status(404).json({ success: false, error: `draft ${newDraftId} not found` });

    // 2. Idempotency: bail if the exchange-note metafield is already set (Apps Script retry-safe).
    // Code-AWARE idempotency. Testing exchange_note_value alone was blind to WHICH note is on the
    // draft: sending EXC-B to a draft already holding EXC-A returned success, so the caller logged
    // B as applied and moved on while B was never deducted and its serial was already burnt at
    // allocate time — a silent write-off of the whole note value.
    // Prefer the metafield over the tag — tags are strippable and don't survive conversion.
    const excCodeMf = (mfData.metafields || []).find(m => m.namespace === 'custom' && m.key === 'exchange_note_code');
    const appliedExcTag = (excCodeMf ? String(excCodeMf.value || '').trim() : '') ||
      (draft.tags || '').split(',').map(t => t.trim())
        .map(t => /^exc-num:/i.test(t) ? t.slice(t.indexOf(':') + 1).trim() : null).find(Boolean);
    const alreadySet = (mfData.metafields || []).some(m =>
      m.namespace === 'custom' && m.key === 'exchange_note_value' && parseFloat(m.value) > 0);
    if (alreadySet) {
      if (appliedExcTag && appliedExcTag.toUpperCase() !== String(excNumber).toUpperCase()) {
        // Latest-one-wins: release the note already on the draft and continue with this one.
        try {
          await stripInstrumentFromDraft(newDraftId, 'exchange_note', token);
          await creditInstruments.reopen(supabase, { instrumentType: 'exchange_note', serialCode: appliedExcTag });
          console.log(`[exc-redeem] swapped ${appliedExcTag} → ${excNumber} on draft ${newDraftId}; ${appliedExcTag} reopened`);
        } catch (e) {
          console.error(`[exc-redeem] swap-out ${appliedExcTag}:`, e.message);
          return res.status(409).json({ success: false, draftId: newDraftId,
            error: `draft holds ${appliedExcTag} and it could not be released — ${excNumber} not applied` });
        }
      } else {
        return res.json({ success: true, alreadyApplied: true, draftId: newDraftId, excNumber });
      }
    }

    // 3. Write the post-tax adjustment as a metafield (NOT a line item — Shopify rejects negative
    //    lines), plus amount_to_be_collected = total − all post-tax adjustments (net to collect).
    const mfVal = (key) => {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key);
      return m ? Math.abs(parseFloat(m.value) || 0) : 0;
    };
    const adjustments = Math.abs(value) + mfVal('voucher_value') + mfVal('old_gold_value') + mfVal('advance');
    const netToCollect = Math.max(0, parseFloat(draft.total_price || 0) - adjustments).toFixed(2);
    await updateDraftOrderMetafields(newDraftId, {
      exchange_note_code:     String(excNumber),
      exchange_note_value:    Math.abs(value).toFixed(2),
      amount_to_be_collected: netToCollect,
    });

    // 4. Linkage stays in tags (no metafield bloat): exc-applied, exc-num, exc-original (old order).
    const newTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      .concat(['exc-applied', `exc-num:${excNumber}`, ...(oldOrderNumber ? [`exc-original:${oldOrderNumber}`] : [])]);
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`,
      { draft_order: { id: newDraftId, tags: [...new Set(newTags)].join(', ') } },
      { headers, timeout: 10000 }
    );

    // NOTE: the serial was already minted at /api/serial/allocate — do NOT mint again here.
    // Record the exchange note in the credit-instrument ledger (issue + immediate redemption).
    try {
      await creditInstruments.upsertIssued(supabase, {
        instrumentType: 'exchange_note', serialCode: excNumber, value: Math.abs(value),
        customerName: req.body.customerName, sourceOrderName: oldOrderNumber || null,
      });
      await creditInstruments.apply(supabase, {
        instrumentType: 'exchange_note', serialCode: excNumber, targetDraftId: newDraftId, value: Math.abs(value),
      });
    } catch (e) { console.error('[ledger] exc-redeem:', e.message); }
    return res.json({ success: true, draftId: newDraftId, excNumber, deducted: Math.abs(value).toFixed(2) });
  } catch (err) {
    console.error('exc-redeem error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/exc-void
// Removes an Exchange Note line from a (still-draft) order and cancels its ledger serial.
// Body: { newDraftId, excNumber }. Refuses (409) if the draft has already converted to an order.
// ─────────────────────────────────────────
app.post('/api/exc-void', async (req, res) => {
  const { newDraftId, excNumber, hardVoid } = req.body || {};
  if (!newDraftId || !excNumber) {
    return res.status(400).json({ success: false, error: 'newDraftId and excNumber are required' });
  }
  try {
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const [{ data }, { data: mfData }] = await Promise.all([
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`, { headers, timeout: 10000 }),
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}/metafields.json`, { headers, timeout: 10000 }),
    ]);
    const draft = data.draft_order;
    if (!draft) return res.status(404).json({ success: false, error: `draft ${newDraftId} not found` });
    if (draft.status === 'completed' || draft.order_id) {
      return res.status(409).json({ success: false, error: 'draft already completed — edit the order manually' });
    }

    // Delete the exchange-note metafield, recompute net-to-collect, and strip the exc-* tags.
    // Clear the code with the value — a stale exchange_note_code would make the code-aware apply
    // guard refuse the next note for one the draft no longer carries.
    for (const k of ['exchange_note_value', 'exchange_note_code']) {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === k);
      if (m) await axios.delete(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/metafields/${m.id}.json`, { headers, timeout: 10000 });
    }
    const mfVal = (key) => {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key);
      return m ? Math.abs(parseFloat(m.value) || 0) : 0;
    };
    // exchange_note_value is being removed; net-to-collect = total − remaining adjustments.
    const remaining   = mfVal('voucher_value') + mfVal('old_gold_value');
    const netToCollect = Math.max(0, parseFloat(draft.total_price || 0) - remaining).toFixed(2);
    await updateDraftOrderMetafields(newDraftId, { amount_to_be_collected: netToCollect });

    const tags = (draft.tags || '').split(',').map(t => t.trim())
      .filter(t => t && t !== 'exc-applied' && !t.startsWith('exc-num:') && !t.startsWith('exc-original:')).join(', ');
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`,
      { draft_order: { id: newDraftId, tags } },
      { headers, timeout: 10000 }
    );

    // Cancel the ledger serial by its full code (resource_id). seq is no longer unique now that the
    // exchange_note counter resets per FY, so EXC-27-0001 must be matched whole, not by seq alone.
    // Default = FREE the note (reopen to 'open', keep serial). hardVoid:true = TRUE void (retire the serial
    // counter + void the ledger) — rare, only to cancel a note that must never exist.
    if (!hardVoid) {
      try { await creditInstruments.reopen(supabase, { instrumentType: 'exchange_note', serialCode: excNumber }); }
      catch (e) { console.error('[ledger] exc-reopen:', e.message); }
      return res.json({ success: true, draftId: newDraftId, excNumber, freed: true });
    }
    const cancelled = await serialization.cancelSerial(SERIAL_DEPS(), { docType: 'exchange_note', resourceId: String(excNumber) });
    try { await creditInstruments.voidInstrument(supabase, { instrumentType: 'exchange_note', serialCode: excNumber }); }
    catch (e) { console.error('[ledger] exc-void:', e.message); }
    return res.json({ success: true, draftId: newDraftId, excNumber, serialCancelled: !!cancelled });
  } catch (err) {
    console.error('exc-void error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/voucher-redeem
// OFFLINE voucher redemption. A voucher is a Shopify discount CODE for ONLINE self-redeem, but when
// staff apply it at the counter we record it as a POST-tax metafield (custom.voucher_value) on the new
// draft — exactly like an Exchange Note — so the draft total stays FULL and syncAmountToCollect nets it.
// Staff must NOT also apply the discount code to the draft (that path is pre-tax and would double-count).
// Body: { newDraftRef, vchNumber, vchValue, oldOrderNumber?, customerName? }. Idempotent on voucher_value.
// The VCH serial was already minted at /api/serial/allocate. Linkage lives in tags.
// ─────────────────────────────────────────
app.post('/api/voucher-redeem', async (req, res) => {
  const { newDraftRef, vchNumber, vchValue, oldOrderNumber } = req.body || {};
  const value = parseFloat(vchValue);
  if (!newDraftRef || !vchNumber || !(value > 0)) {
    return res.status(400).json({ success: false, error: 'newDraftRef, vchNumber and vchValue>0 are required' });
  }
  try {
    const token = await getShopifyToken();
    const newDraftId = await resolveDraftId(newDraftRef, token);
    if (!newDraftId) return res.status(404).json({ success: false, error: `draft "${newDraftRef}" not found` });
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const [{ data }, { data: mfData }] = await Promise.all([
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`, { headers, timeout: 10000 }),
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}/metafields.json`, { headers, timeout: 10000 }),
    ]);
    const draft = data.draft_order;
    if (!draft) return res.status(404).json({ success: false, error: `draft ${newDraftId} not found` });

    // Idempotency, code-AWARE — mirrors the guard in handleApplyVoucherTag. A blind `voucher_value > 0`
    // test is blind to WHICH voucher sits on the draft: re-posting a DIFFERENT code returned success
    // while the metafield still held the first voucher's value, so the draft claimed a voucher it had
    // never deducted and the second one stayed 'open' in the ledger. Same code → idempotent no-op (the
    // Apps Script may retry). Different code → refuse and name the incumbent. Read the code from the
    // METAFIELD first (it survives draft→order conversion); fall back to the tag for older drafts.
    const mfStr = (key) => {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key);
      return m ? String(m.value || '').trim() : '';
    };
    if ((mfData.metafields || []).some(m => m.namespace === 'custom' && m.key === 'voucher_value' && parseFloat(m.value) > 0)) {
      const appliedCode = mfStr('voucher_code') ||
        (draft.tags || '').split(',').map(t => t.trim())
          .map(t => /^vch-num:/i.test(t) ? t.slice(t.indexOf(':') + 1).trim() : null).find(Boolean) || '';
      if (!appliedCode || appliedCode.toUpperCase() === String(vchNumber).trim().toUpperCase()) {
        return res.json({ success: true, alreadyApplied: true, draftId: newDraftId, vchNumber });
      }
      return res.status(409).json({ success: false,
        error: `draft ${draft.name || newDraftId} already has voucher ${appliedCode} applied — remove that one first` });
    }

    // Validity + single-use gate against the ledger. If the voucher was recorded at issue, enforce it's
    // still open and unexpired; a redemption on a DIFFERENT draft is rejected (single-use). No ledger
    // row (legacy / issue-hook not wired) → can't verify → allow.
    let inst = null;
    try {
      inst = await creditInstruments.getBySerial(supabase, { instrumentType: 'voucher', serialCode: vchNumber });
      if (inst) {
        const expired = inst.expires_at && new Date(inst.expires_at).getTime() < Date.now();
        if (inst.status === 'voided')
          return res.status(409).json({ success: false, error: `voucher ${vchNumber} was voided` });
        if (inst.status === 'expired' || (inst.status === 'open' && expired))
          return res.status(409).json({ success: false, error: `voucher ${vchNumber} expired` });
        if (inst.status === 'redeemed' && String(inst.target_draft_id || '') !== String(newDraftId))
          return res.status(409).json({ success: false, error: `voucher ${vchNumber} already redeemed on ${inst.target_order_name || inst.target_draft_id || 'another order'}` });
        // Applied to a DIFFERENT draft → latest-one-wins, the same rule the admin tag path follows:
        // strip it off that draft (metafields + tags + net recompute) so it can never be live on two
        // drafts at once. The apply() below re-points the ledger row at this draft. A voucher is only
        // untouchable once REDEEMED (draft converted), which the check above already rejects.
        if (inst.status === 'applied' && inst.target_draft_id && String(inst.target_draft_id) !== String(newDraftId)) {
          try { await stripInstrumentFromDraft(inst.target_draft_id, 'voucher', token); }
          catch (e) { console.error(`[voucher-redeem] strip prior draft ${inst.target_draft_id}:`, e.message); }
        }
      }
    } catch (e) { console.error('[voucher-redeem] ledger check:', e.message); }

    const mfVal = (key) => {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key);
      return m ? Math.abs(parseFloat(m.value) || 0) : 0;
    };
    // Inline net (metafield writes don't fire the draft webhook, so seed it here like exc-redeem;
    // syncAmountToCollect re-derives the canonical value — incl. advance — on the next draft edit).
    const adjustments  = Math.abs(value) + mfVal('exchange_note_value') + mfVal('old_gold_value');
    const netToCollect = Math.max(0, parseFloat(draft.total_price || 0) - adjustments).toFixed(2);
    // voucher_code rides alongside the value (same as the admin tag path) so the applied instrument is
    // identifiable from the metafields alone: the admin app renders it, the code-aware guard above
    // reads it, and unlike a tag it survives draft→order conversion so invoices can print it.
    await updateDraftOrderMetafields(newDraftId, {
      voucher_code:           String(vchNumber).trim(),
      voucher_value:          Math.abs(value).toFixed(2),
      amount_to_be_collected: netToCollect,
    });

    const newTags = (draft.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      .concat(['vch-applied', `vch-num:${vchNumber}`, ...(oldOrderNumber ? [`vch-original:${oldOrderNumber}`] : [])]);
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`,
      { draft_order: { id: newDraftId, tags: [...new Set(newTags)].join(', ') } },
      { headers, timeout: 10000 }
    );
    try {
      await creditInstruments.apply(supabase, {
        instrumentType: 'voucher', serialCode: vchNumber, targetDraftId: newDraftId, value: Math.abs(value),
      });
    } catch (e) { console.error('[ledger] voucher-redeem:', e.message); }
    // Cross-channel single-use: delete the online Shopify discount code so it can't ALSO be used at
    // checkout (Shopify's usage_limit doesn't see this metafield redemption). Needs price_rule_id,
    // recorded on the ledger at issue.
    let onlineCodeKilled = false;
    if (inst && inst.price_rule_id) {
      try {
        await axios.delete(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/price_rules/${inst.price_rule_id}.json`, { headers, timeout: 10000 });
        onlineCodeKilled = true;
        console.log(`[voucher-redeem] deleted online price rule ${inst.price_rule_id} for ${vchNumber}`);
      } catch (e) { console.error('[voucher-redeem] price-rule delete:', e.message); }
    }
    return res.json({ success: true, draftId: newDraftId, vchNumber, deducted: Math.abs(value).toFixed(2), onlineCodeKilled });
  } catch (err) {
    console.error('voucher-redeem error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/voucher-void
// Removes an offline voucher adjustment from a (still-draft) order. Always clears the metafield, tags,
// and recomputes net-to-collect. Then, per intent:
//   • default (TRUE VOID)  — retire the serial counter + void the ledger row. Use for a mis-issued
//     voucher that must never be usable again (kept as an auditable issued→voided event).
//   • free:true (FREE)     — reopen the ledger row to 'open' (available + re-addable) and KEEP the serial.
//     Use when it was simply added to the wrong draft and should return to the pool.
// Body: { newDraftId, vchNumber, free? }. Refuses (409) if the draft already converted (a redeemed
// voucher can't be freed/voided by editing a draft). Does NOT delete the Shopify discount code.
// ─────────────────────────────────────────
app.post('/api/voucher-void', async (req, res) => {
  const { newDraftId, vchNumber, hardVoid } = req.body || {};
  if (!newDraftId || !vchNumber) {
    return res.status(400).json({ success: false, error: 'newDraftId and vchNumber are required' });
  }
  try {
    const token = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    const [{ data }, { data: mfData }] = await Promise.all([
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`, { headers, timeout: 10000 }),
      axios.get(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}/metafields.json`, { headers, timeout: 10000 }),
    ]);
    const draft = data.draft_order;
    if (!draft) return res.status(404).json({ success: false, error: `draft ${newDraftId} not found` });
    if (draft.status === 'completed' || draft.order_id) {
      return res.status(409).json({ success: false, error: 'draft already completed — edit the order manually' });
    }

    // Clear the code with the value (see the exc-void counterpart for why a stale code is harmful).
    for (const k of ['voucher_value', 'voucher_code']) {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === k);
      if (m) await axios.delete(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/metafields/${m.id}.json`, { headers, timeout: 10000 });
    }
    const mfVal = (key) => {
      const m = (mfData.metafields || []).find(x => x.namespace === 'custom' && x.key === key);
      return m ? Math.abs(parseFloat(m.value) || 0) : 0;
    };
    const remaining    = mfVal('exchange_note_value') + mfVal('old_gold_value');
    const netToCollect = Math.max(0, parseFloat(draft.total_price || 0) - remaining).toFixed(2);
    await updateDraftOrderMetafields(newDraftId, { amount_to_be_collected: netToCollect });

    const tags = (draft.tags || '').split(',').map(t => t.trim())
      .filter(t => t && t !== 'vch-applied' && !t.startsWith('vch-num:') && !t.startsWith('vch-original:')).join(', ');
    await axios.put(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${newDraftId}.json`,
      { draft_order: { id: newDraftId, tags } },
      { headers, timeout: 10000 }
    );

    // Default = FREE the voucher (reopen to 'open', keep serial — available + re-addable). hardVoid:true =
    // TRUE void (retire the serial counter + void the ledger) — rare, only to cancel a credit that must
    // never exist (issued in error / refunded another way / fraud).
    if (!hardVoid) {
      try { await creditInstruments.reopen(supabase, { instrumentType: 'voucher', serialCode: vchNumber }); }
      catch (e) { console.error('[ledger] voucher-reopen:', e.message); }
      return res.json({ success: true, draftId: newDraftId, vchNumber, freed: true });
    }
    const cancelled = await serialization.cancelSerial(SERIAL_DEPS(), { docType: 'voucher', resourceId: String(vchNumber) });
    try { await creditInstruments.voidInstrument(supabase, { instrumentType: 'voucher', serialCode: vchNumber }); }
    catch (e) { console.error('[ledger] voucher-void:', e.message); }
    return res.json({ success: true, draftId: newDraftId, vchNumber, serialCancelled: !!cancelled });
  } catch (err) {
    console.error('voucher-void error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// Credit-instrument ledger — issue / open-lookup / reconciliation
// ─────────────────────────────────────────

// POST /api/credit-instrument/issue — record an issued instrument (called by the voucher Apps Script
// at creation, and by the log-backfill). Idempotent. Body: { instrumentType, serialCode, value,
// customerId?, customerName?, sourceOrderId?, sourceOrderName?, stateCode?, expiresAt?, status?,
// targetOrderName? }. status='redeemed'|'voided' lets the backfill replay historical states.
app.post('/api/credit-instrument/issue', async (req, res) => {
  const b = req.body || {};
  if (!b.instrumentType || !b.serialCode || !(parseFloat(b.value) > 0)) {
    return res.status(400).json({ success: false, error: 'instrumentType, serialCode and value>0 are required' });
  }
  try {
    await creditInstruments.upsertIssued(supabase, {
      instrumentType: b.instrumentType, serialCode: b.serialCode, value: parseFloat(b.value),
      customerId: b.customerId, customerName: b.customerName,
      sourceOrderId: b.sourceOrderId, sourceOrderName: b.sourceOrderName,
      stateCode: b.stateCode, expiresAt: b.expiresAt, priceRuleId: b.priceRuleId,
    });
    if (b.status === 'redeemed') await creditInstruments.redeem(supabase, { instrumentType: b.instrumentType, serialCode: b.serialCode, targetOrderName: b.targetOrderName, value: parseFloat(b.value) });
    if (b.status === 'voided')   await creditInstruments.voidInstrument(supabase, { instrumentType: b.instrumentType, serialCode: b.serialCode });
    return res.json({ success: true, serialCode: b.serialCode });
  } catch (err) {
    console.error('credit-instrument/issue error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// GET /api/credit-instrument/open?customerId=&type= — open instruments for a customer (drives the
// offline "pick a voucher" dropdown). type defaults to voucher.
app.get('/api/credit-instrument/open', async (req, res) => {
  try {
    const rows = await creditInstruments.listOpenForCustomer(supabase, {
      customerId: req.query.customerId, instrumentType: req.query.type || 'voucher',
    });
    return res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('credit-instrument/open error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/recon-ledger?view=detail|summary|outstanding|tieout&type=&from=&to=&format=json|csv
// The joinable reconciliation report over credit_instruments. (Distinct from the ad-hoc /api/recon
// CSV tool.) detail: EVERY instrument, one row, with its state + both order refs (issued-against /
// redeemed-against). state 'applied' = reserved on a draft (pending); 'redeemed' = draft converted to
// an order (true redemption). summary: issued = redeemed + applied + outstanding + voided + expired.
// outstanding: the open-credit liability register. tieout: redeemed instruments and their target order.
// ─────────────────────────────────────────
// GET /api/adjustment-report?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv
// Per-order SALES breakdown over a date range, read live off orders + their frozen custom metafields
// (gross · discount · voucher · exchange · old-gold · advance · net-to-collect · paid). Complements the
// credit-instrument /api/recon-ledger (that tracks each credit's lifecycle; this shows what was sold and
// what adjusted it). Uses GraphQL to pull orders + metafields in pages (efficient, low store volume).
// ─────────────────────────────────────────
// WITHOUT a sync-payment tag / webhook (metafield saves don't fire the draft webhook). Idempotent.
app.post('/api/recompute-payment', async (req, res) => {
  const { draftOrderId, orderId } = req.body || {};
  if (!draftOrderId && !orderId) {
    return res.status(400).json({ success: false, error: 'draftOrderId or orderId is required' });
  }
  try {
    const token = await getShopifyToken();
    const applied = draftOrderId
      ? await applyPaymentTagsToDraftOrder(String(draftOrderId), token)
      : await applyPaymentTagsToOrder(String(orderId), token);
    return res.json({ success: true, applied: !!applied });
  } catch (err) {
    console.error('recompute-payment error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Module registration ─────────────────────────────────────────────────────
// Each domain module owns its own routes and exposes a single register(app, ctx).
// ctx carries the shared primitives so modules never reach for process.env themselves.
// handleRecalculatePriceTag is injected because procurement's reprice-from-sheet route
// re-runs the pricing engine, which has not been extracted yet. Passing it through ctx keeps
// the dependency pointing the right way — no module requires this bootstrap file.
// applyPaymentTags* are injected for the same reason as handleRecalculatePriceTag: the admin
// backfills replay the live payment-tag logic, which has not been extracted yet.
const ctx = {
  config, supabase, getShopifyToken, log,
  handleRecalculatePriceTag,
  applyPaymentTagsToOrder, applyPaymentTagsToDraftOrder,
};

registerRepairRoutes(app, getShopifyToken);
require('./src/modules/reporting/routes').register(app, ctx);
require('./src/modules/serialization/routes').register(app, ctx);
require('./src/modules/procurement/routes').register(app, ctx);
const admin = require('./src/modules/admin/routes');
admin.register(app, ctx);
require('./src/modules/admin/version').register(app);

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
  console.log('  POST /api/reprice');
  console.log('  POST /api/generate-payment-link');
  console.log('  POST /api/cancel-payment-link');
  console.log('  POST /api/gokwik-webhook');
  console.log('  POST /api/log-cash-payment');
  console.log('  POST /api/send-draft-invoice');
  console.log('  POST /api/convert-to-order');
  console.log('  POST /api/po-webhook');
  console.log('  GET  /api/po-action');
  console.log('  POST /api/po-ops/sync-all');
  console.log('  POST /api/po-ops/batch-raise-po');
  console.log('  POST /api/po-ops/reprice-from-sheet');
  console.log('  POST /api/trigger-price-update');
  console.log('  POST /webhooks/shopify/draft-order-updated');
  console.log('  POST /webhooks/shopify/order-updated');
  // A deploy can kill a running reprice without releasing its lock file, which would block
  // every later run. Clear it on the way up.
  admin.clearStalePriceUpdateFlag();

  // Voucher expiry reminders: a daily sweep for vouchers 30 days from expiry. The module was
  // added and exported but never started, so no reminder could ever fire.
  startVoucherExpirySweep({
    supabase, getShopifyToken, sendEmail, withStoreCc,
    buildVoucherExpiryHtml: require('./src/integrations/email/templates').buildVoucherExpiryHtml,
    shopifyStoreUrl: config.shopify.storeUrl,
  });
  await initShopifyToken();
  console.log('🔄 Background poller started (30s)');
  setInterval(pollActiveTxns, 30000);
});
