'use strict';

// Buy plan — a deleted plan draft is rebuilt. Shopify cannot stop a staff member deleting a draft,
// and on a buy plan that draft is the customer's reserved piece, its locked price and their
// payments. So on draft_orders/delete (and as a fallback, whenever the sweep finds the draft gone)
// the draft is recreated from the plan's snapshot: the same lines at the same LOCKED prices, the
// same customer, the money metafields (installment legs included), and the plan tags. The plan and
// its deposit row follow the new draft id; the store is told.
//
// Open payment links on the OLD draft are cancelled rather than moved: GoKwik's webhook names the
// draft id the link was raised for, so a link on a deleted draft could never be matched again.
// Staff send a fresh one from the Buy plan screen (the alert says so).

const { graphql } = require('../../../core/shopify');
const { supabase } = require('../../../core/supabase');
const { getMetafieldType } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const { cancelPaymentLink } = require('../../../integrations/gokwik');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { readInstallments } = require('../installments');

// Only what the money and the invoice depend on. Long JSON records (repair inspection, per-line
// discounts) are not carried: their definitions vary and the price they produced is already on the lines.
const RESTORE_KEYS = /^(installment_[1-9]_(value|mode|date|type)|amount_paid|amount_paid_final|amount_to_be_collected|amount_pending|payment_status|is_finalized|plan_due_dates|plan_total|gold_rate|gold_rate_date|making|channel|order_type|shipment|employee_name|in_store_sale|state_code|jewelcode_[a-z_]+|exchange_note_value|voucher_value|old_gold_[a-z]+|advance)$/;

function addressInput(a) {
  if (!a) return undefined;
  const out = {
    firstName: a.first_name, lastName: a.last_name, company: a.company, phone: a.phone,
    address1: a.address1, address2: a.address2, city: a.city, zip: a.zip,
    provinceCode: a.province_code, countryCode: a.country_code,
  };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return Object.keys(out).length ? out : undefined;
}

function lineInput(li) {
  const attrs = (li.properties || []).map(p => ({ key: p.name, value: String(p.value) }));
  const price = { amount: parseFloat(li.price).toFixed(2), currencyCode: 'INR' };
  if (li.variant_id) {
    return { variantId: `gid://shopify/ProductVariant/${li.variant_id}`, quantity: li.quantity, priceOverride: price, customAttributes: attrs };
  }
  return { title: li.title, quantity: li.quantity, originalUnitPriceWithCurrency: price,
    taxable: li.taxable ?? true, requiresShipping: li.requires_shipping ?? false, customAttributes: attrs };
}

function draftInput(snap) {
  const metafields = Object.entries(snap.metafields || {})
    .filter(([k, v]) => RESTORE_KEYS.test(k) && String(v ?? '').trim() !== '')
    .map(([key, value]) => ({ namespace: 'custom', key, type: getMetafieldType(key), value: String(value) }));
  const input = {
    lineItems: (snap.line_items || []).map(lineInput),
    tags: snap.tags || [],
    note: snap.note || undefined,
    email: snap.email || undefined,
    metafields,
  };
  if (snap.customer_id) input.purchasingEntity = { customerId: `gid://shopify/Customer/${snap.customer_id}` };
  const bill = addressInput(snap.billing_address), ship = addressInput(snap.shipping_address);
  if (bill) input.billingAddress = bill;
  if (ship) input.shippingAddress = ship;
  return input;
}

async function restoreDeletedPlanDraft(oldDraftId) {
  const plan = await store.getPlanByDraft(oldDraftId);
  if (!plan || plan.status !== 'active' || !plan.snapshot) return null;

  const snap = plan.snapshot;
  const legs = readInstallments(snap.metafields || {}).filter(l => l.type !== 'cad_advance');
  // Fully paid means the draft converted to an order — deleting the spent draft is housekeeping.
  if (S.replay(plan.total, legs).balance <= 0) {
    await store.updatePlan(plan.id, { status: 'completed' });
    log.info('buy-plan', `${plan.draft_name} deleted after full payment — plan marked completed, not restored`);
    return null;
  }

  const res = await graphql(
    `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) {
       draftOrder { id legacyResourceId name } userErrors { field message } } }`,
    { input: draftInput(snap) });
  const errs = res?.draftOrderCreate?.userErrors || [];
  if (errs.length) throw new Error(`draftOrderCreate: ${JSON.stringify(errs)}`);
  const created = res.draftOrderCreate.draftOrder;
  const newId = String(created.legacyResourceId);

  await store.updatePlan(plan.id, { draft_order_id: newId, draft_name: created.name });
  await supabase.from('store_deposits').update({ draft_order_id: newId }).eq('draft_order_id', String(oldDraftId));

  const { data: open } = await supabase.from('payment_links').select('gokwik_link_id')
    .eq('draft_order_id', String(oldDraftId)).eq('status', 'created');
  for (const l of open || []) {
    try { await cancelPaymentLink(l.gokwik_link_id); } catch (e) { log.warn('buy-plan', `cancel ${l.gokwik_link_id}: ${e.message}`); }
    await supabase.from('payment_links').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('gokwik_link_id', l.gokwik_link_id);
  }

  log.info('buy-plan', `${plan.draft_name} was deleted — restored as ${created.name} (${newId})`);
  await notify.sendRestored({ plan, oldName: plan.draft_name, newName: created.name, newId, d: { legs } })
    .catch(e => log.error('buy-plan', `restore alert: ${e.message}`));
  return { newId, newName: created.name };
}

module.exports = { restoreDeletedPlanDraft, draftInput };
