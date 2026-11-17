'use strict';

// Savings plan — a deleted plan draft (founder, 16 Nov 2026). Shopify cannot stop a staff member
// deleting a draft, and on a savings plan the draft is the record of the customer's money.
//
//   money on it       → rebuilt from the plan's snapshot, as a buy plan is (buy-plan/restore.js): the
//                       same "Savings Plan" line (not taxable), the customer, the payment slots and the
//                       savings_* fields, the tags. The plan row follows the new draft id. The store AND
//                       HQ are emailed. Open links on the old draft are cancelled (GoKwik names the draft
//                       a link was raised for); staff send a fresh one.
//   nothing paid      → a demo or a mistake: the plan is cancelled quietly, as Cancel plan would.
//   money, no snapshot (a plan started before snapshots existed) → cannot be rebuilt: the store and HQ
//                       are emailed the amount so it is rebuilt by hand.
//
// Runs from the draft_orders/delete webhook, and from the sweep when it finds the draft gone.
// The snapshot is taken at start and refreshed by the sweep and every recorded payment (takeSnapshot).

const { graphql } = require('../../../core/shopify');
const { supabase } = require('../../../core/supabase');
const { config } = require('../../../core/config');
const { log } = require('../../../core/logger');
const { readInstallments } = require('../installments');
const { cancelOpenLinks } = require('../buy-plan/links');
const { snapshotOf, GQL_VERSION } = require('../buy-plan/draft');
const { draftInput } = require('../buy-plan/restore');
const store = require('./store');
const notify = require('./notify');

// What a savings draft is rebuilt with: its money and the plan's own fields.
const SAVINGS_RESTORE_KEYS = /^(installment_(10|[1-9])_(value|mode|date|type)|amount_paid|amount_paid_final|amount_to_be_collected|amount_pending|payment_status|is_finalized|channel|order_type|shipment|employee_name|in_store_sale|state_code|savings_[a-z_]+)$/;

const r0 = (v) => Math.round(Number(v) || 0);

// Keep the rebuild copy current. Never throws: a plan whose table has no snapshot column yet (the
// migration not run) just logs it.
async function takeSnapshot(plan, d) {
  if (!plan?.id || !d) return false;
  const { error } = await supabase.from('savings_plans').update({ snapshot: snapshotOf(d) }).eq('id', plan.id);
  if (error) { log.warn('savings-plan', `${plan.draft_name}: snapshot not saved (${error.message})`); return false; }
  return true;
}

// Money on the deleted draft, from every record that outlives it: the snapshot's payment slots, the
// deposit row (links and payments recorded on the savings screen), and what the customer was thanked for.
async function paidOnDeleted(plan, draftId) {
  const legs = plan.snapshot ? readInstallments(plan.snapshot.metafields || {}).filter(l => l.type !== 'cad_advance') : [];
  const fromSnap = legs.reduce((s, l) => s + r0(l.value), 0);
  const { data: dep } = await supabase.from('store_deposits').select('amount_paid').eq('draft_order_id', String(draftId)).maybeSingle();
  return Math.max(fromSnap, r0(dep?.amount_paid), r0(plan.acknowledged_paid));
}

async function restoreDeletedSavingsDraft(oldDraftId, deps = {}) {
  if (!config.savingsPlan.enabled && !deps.force) return null;
  const s = deps.store || store;
  const plan = await s.getPlanByDraft(String(oldDraftId));
  if (!plan || ['cancelled', 'redeemed'].includes(plan.status)) return null;

  const paid = await paidOnDeleted(plan, oldDraftId);
  await cancelOpenLinks(oldDraftId).catch(e => log.warn('savings-plan', `${plan.draft_name}: cancel links: ${e.message}`));

  if (paid <= 0 && plan.status === 'active') {
    await s.updatePlan(plan.id, {
      status: 'cancelled', closed_at: new Date().toISOString(),
      closed_reason: 'draft deleted before any payment (cancelled automatically)',
      draft_order_id: `${oldDraftId}-deleted-${plan.id}`,
    });
    log.info('savings-plan', `${plan.draft_name} was deleted with nothing paid — plan cancelled`);
    return { cancelled: true };
  }

  if (!plan.snapshot) {
    // Once: the sweep finds the draft gone every 6 hours.
    if (await s.wasSent(plan.id, 0, 'staff', 'missing')) return { rebuilt: false, paid, alreadyTold: true };
    await notify.toHq(plan, {
      subject: `the draft was deleted with Rs${paid.toLocaleString('en-IN')} paid — rebuild it by hand`,
      heading: 'savings draft deleted, could not be rebuilt',
      body: `The savings plan draft was deleted. It held Rs${paid.toLocaleString('en-IN')} of the customer's money and there was no copy to rebuild it from. Make a new draft for the customer with the custom item "Savings Plan" at Rs${r0(plan.total).toLocaleString('en-IN')}, type the payments back in from the payment records, and tell HQ the new draft number so the plan can be moved onto it.`,
      facts: [{ label: 'Paid', value: `Rs${paid.toLocaleString('en-IN')}` }],
    }).catch(e => log.error('savings-plan', `restore alert: ${e.message}`));
    await s.markSent(plan.id, 0, 'staff', 'missing');
    log.error('savings-plan', `${plan.draft_name} was deleted with Rs${paid} paid and no snapshot — store and HQ told`);
    return { rebuilt: false, paid };
  }

  const gql = deps.graphql || graphql;
  const res = await gql(
    `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) {
       draftOrder { id legacyResourceId name } userErrors { field message } } }`,
    { input: draftInput(plan.snapshot, SAVINGS_RESTORE_KEYS) }, { apiVersion: GQL_VERSION });
  const errs = res?.draftOrderCreate?.userErrors || [];
  if (errs.length) throw new Error(`draftOrderCreate: ${JSON.stringify(errs)}`);
  const created = res.draftOrderCreate.draftOrder;
  const newId = String(created.legacyResourceId);

  const was = { ...plan };
  await s.updatePlan(plan.id, { draft_order_id: newId, draft_name: created.name });
  await supabase.from('store_deposits').update({ draft_order_id: newId }).eq('draft_order_id', String(oldDraftId));
  // A voucher already issued on the plan names the draft it came from.
  if (was.voucher_code && was.voucher_code !== 'ISSUING') {
    await supabase.from('credit_instruments').update({ source_order_id: newId, source_order_name: `SAVINGS ${created.name} (restored from ${was.draft_name})` })
      .eq('instrument_type', 'voucher').eq('serial_code', was.voucher_code);
  }

  log.info('savings-plan', `${was.draft_name} was deleted — restored as ${created.name} (${newId}), Rs${paid} on it`);
  await notify.toHq({ ...was, draft_order_id: newId, draft_name: created.name }, {
    subject: `the draft ${was.draft_name} was deleted and restored as ${created.name}`,
    heading: `restored from ${was.draft_name}`,
    body: `The savings plan draft ${was.draft_name} was deleted. It held the customer's money, so it has been rebuilt as ${created.name} with the same line, payments and tags. Use ${created.name} from now on. Any payment link sent before the delete no longer works: send a fresh one from the Savings plan screen if one is due. Savings plan drafts must never be deleted.`,
    facts: [{ label: 'Paid', value: `Rs${paid.toLocaleString('en-IN')}` }, { label: 'Old draft', value: was.draft_name }, { label: 'New draft', value: created.name }],
  }).catch(e => log.error('savings-plan', `restore alert: ${e.message}`));
  return { rebuilt: true, newId, newName: created.name, paid };
}

module.exports = { restoreDeletedSavingsDraft, takeSnapshot, SAVINGS_RESTORE_KEYS };
