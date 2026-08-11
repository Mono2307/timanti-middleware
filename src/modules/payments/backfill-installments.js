'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Backfill installment legs onto documents that predate the installment model.
//
// Two sources, because per-leg history only exists for some payments:
//
//   drafts — store_deposit_payments, one row per payment received, carrying amount + payment_mode +
//            created_at. This is the ONLY place a true per-leg history exists, and until now it was
//            write-only (two inserts in server.js, zero reads anywhere). Grouped by draft_order_id
//            and replayed in chronological order into slots 1..4.
//
//   orders — no audit rows survive conversion, so legs are SYNTHESIZED from the two-slot pair the
//            order still carries: amount_paid (+ amount_paid_final) with payment_mode_advance /
//            payment_mode_final. Dates are unknown by construction and left blank rather than
//            invented — a wrong date would print on a customer's tax invoice.
//
// Idempotent: a document that already has installment_1_value is skipped. Never overwrites a leg.
// DRY RUN BY DEFAULT — pass apply:true to write.
//
// deps: { axios, storeUrl, token, supabase }
// ─────────────────────────────────────────────────────────────────────────────

const { MAX_INSTALLMENTS, readInstallments } = require('./installments');

const num = (v) => (parseFloat(v) || 0);
const dayOf = (ts) => (ts ? String(ts).slice(0, 10) : '');

// Replay an ordered list of payments into slots 1..MAX_INSTALLMENTS.
// Overflow folds into the last slot so a document with 5+ payments still totals correctly.
function legsFromPayments(payments) {
  const legs = [];
  for (const p of payments) {
    const value = num(p.amount);
    if (value <= 0) continue;
    if (legs.length < MAX_INSTALLMENTS) {
      legs.push({ value, mode: p.payment_mode || '', date: dayOf(p.created_at) });
    } else {
      const last = legs[legs.length - 1];
      last.value += value;
      last.date = dayOf(p.created_at) || last.date;
    }
  }
  return legs;
}

function patchFromLegs(legs) {
  const patch = {};
  legs.forEach((leg, i) => {
    const n = i + 1;
    patch[`installment_${n}_value`] = leg.value.toFixed(2);
    if (leg.mode) patch[`installment_${n}_mode`] = leg.mode;
    if (leg.date) patch[`installment_${n}_date`] = leg.date;
  });
  patch.amount_paid = legs.reduce((s, l) => s + l.value, 0).toFixed(2);
  return patch;
}

async function fetchMetafieldMap(deps, resource, id) {
  const { axios, storeUrl, token } = deps;
  const { data } = await axios.get(
    `${storeUrl}/admin/api/2024-01/${resource}/${id}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const map = {};
  for (const m of (data.metafields || [])) if (m.namespace === 'custom') map[m.key] = m.value;
  return map;
}

async function writeMetafields(deps, resource, id, patch) {
  const { axios, storeUrl, token } = deps;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const { data: existing } = await axios.get(
    `${storeUrl}/admin/api/2024-01/${resource}/${id}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const byKey = {};
  for (const m of (existing.metafields || [])) if (m.namespace === 'custom') byKey[m.key] = m.id;

  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const type = /_value$/.test(key) || key === 'amount_paid' ? 'number_decimal'
               : /_date$/.test(key) ? 'date'
               : 'single_line_text_field';
    if (byKey[key]) {
      await axios.put(`${storeUrl}/admin/api/2024-01/metafields/${byKey[key]}.json`,
        { metafield: { id: byKey[key], value: String(value), type } }, { headers, timeout: 10000 });
    } else {
      await axios.post(`${storeUrl}/admin/api/2024-01/${resource}/${id}/metafields.json`,
        { metafield: { namespace: 'custom', key, value: String(value), type } }, { headers, timeout: 10000 });
    }
  }
}

// ── Drafts: replay the real per-leg audit trail ──────────────────────────────
async function backfillDrafts(deps, { apply = false, draftIds = null, limit = 500 } = {}) {
  const { supabase } = deps;
  let q = supabase.from('store_deposit_payments')
    .select('draft_order_id, amount, payment_mode, created_at')
    .order('created_at', { ascending: true });
  if (draftIds && draftIds.length) q = q.in('draft_order_id', draftIds.map(String));
  const { data: rows, error } = await q;
  if (error) throw new Error(`store_deposit_payments read failed: ${error.message}`);

  const byDraft = new Map();
  for (const r of (rows || [])) {
    const key = String(r.draft_order_id);
    if (!byDraft.has(key)) byDraft.set(key, []);
    byDraft.get(key).push(r);
  }

  const results = [];
  let processed = 0;
  for (const [draftId, payments] of byDraft) {
    if (processed >= limit) { results.push({ draftId, status: 'skipped', reason: `limit ${limit} reached` }); continue; }
    processed++;
    try {
      const map = await fetchMetafieldMap(deps, 'draft_orders', draftId);
      if (readInstallments(map).length) { results.push({ draftId, status: 'exists' }); continue; }
      const legs = legsFromPayments(payments);
      if (!legs.length) { results.push({ draftId, status: 'no-legs' }); continue; }
      const patch = patchFromLegs(legs);
      // Loud rather than silent: the audit trail and the recorded balance disagreeing means one of
      // the two surfaces missed a write, and the operator needs to know before it becomes truth.
      const recorded = num(map.amount_paid) + num(map.amount_paid_final);
      const drift = Math.abs(recorded - num(patch.amount_paid));
      if (drift >= 1) {
        results.push({ draftId, status: 'drift', legs: legs.length,
          recorded: recorded.toFixed(2), fromAudit: patch.amount_paid,
          note: 'audit rows and recorded amount_paid disagree — review before applying' });
        continue;
      }
      if (apply) {
        patch.amount_paid_final = '0'; // legacy field, pinned so summing readers do not double-count
        await writeMetafields(deps, 'draft_orders', draftId, patch);
      }
      results.push({ draftId, status: apply ? 'written' : 'would-write', legs: legs.length, patch });
    } catch (e) {
      results.push({ draftId, status: 'error', error: e.message });
    }
  }
  return results;
}

// ── Orders: synthesize from the two-slot pair (no audit rows survive conversion) ─────────────
async function backfillOrders(deps, { apply = false, orderIds = [] } = {}) {
  const results = [];
  for (const orderId of orderIds) {
    try {
      const map = await fetchMetafieldMap(deps, 'orders', orderId);
      if (readInstallments(map).length) { results.push({ orderId, status: 'exists' }); continue; }
      const advance = num(map.amount_paid);
      const final   = num(map.amount_paid_final);
      const legs = [];
      // Dates are genuinely unknown here — left blank rather than stamped with today's date, which
      // would print a false receipt date on the customer's tax invoice.
      if (advance > 0) legs.push({ value: advance, mode: map.payment_mode_advance || '', date: '' });
      if (final   > 0) legs.push({ value: final,   mode: map.payment_mode_final   || '', date: '' });
      if (!legs.length) { results.push({ orderId, status: 'no-legs' }); continue; }
      const patch = patchFromLegs(legs);
      if (apply) {
        patch.amount_paid_final = '0';
        await writeMetafields(deps, 'orders', orderId, patch);
      }
      results.push({ orderId, status: apply ? 'written' : 'would-write', legs: legs.length, patch });
    } catch (e) {
      results.push({ orderId, status: 'error', error: e.message });
    }
  }
  return results;
}

module.exports = { backfillDrafts, backfillOrders, legsFromPayments, patchFromLegs };
