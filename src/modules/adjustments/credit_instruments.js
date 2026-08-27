// Credit-instrument ledger helper — the joinable system of record for Exchange Notes and Vouchers.
// serial_code is the only link to serial_ledger (no FK); mintSerial/cancelSerial remain the number
// authority. All writers are non-authoritative bookkeeping — callers wrap them in try/catch so a
// ledger hiccup never breaks the Shopify-facing flow. updated_at is set here (like the other tables).
//
// Every function takes the supabase client as its first arg (mirrors the deps pattern, minimal form).

const TABLE = 'credit_instruments';

// Record an ISSUED instrument. Idempotent — no-op if (instrument_type, serial_code) already exists.
async function upsertIssued(supabase, p) {
  const row = {
    instrument_type:   p.instrumentType,
    serial_code:       p.serialCode,
    value:             p.value,
    customer_id:       p.customerId != null ? String(p.customerId) : null,
    customer_name:     p.customerName || null,
    source_order_id:   p.sourceOrderId != null ? String(p.sourceOrderId) : null,
    source_order_name: p.sourceOrderName || null,
    state_code:        p.stateCode || null,
    expires_at:        p.expiresAt || null,
    price_rule_id:     p.priceRuleId != null ? String(p.priceRuleId) : null,
    status:            'open',
    updated_at:        new Date().toISOString(),
  };
  const { error } = await supabase.from(TABLE)
    .upsert(row, { onConflict: 'instrument_type,serial_code', ignoreDuplicates: true });
  if (error) throw new Error(`upsertIssued ${p.serialCode}: ${error.message}`);
  return true;
}

// Mark an instrument REDEEMED against a target draft/order. Lazily inserts a redeemed row if no issued
// row exists (legacy caller / online voucher never pre-issued) so a redemption is never lost.
async function redeem(supabase, p) {
  const now = new Date().toISOString();
  const patch = { status: 'redeemed', redeemed_at: now, updated_at: now };
  if (p.targetDraftId)   patch.target_draft_id   = String(p.targetDraftId);
  if (p.targetOrderId)   patch.target_order_id   = String(p.targetOrderId);
  if (p.targetOrderName) patch.target_order_name = p.targetOrderName;

  const { data, error } = await supabase.from(TABLE).update(patch)
    .eq('instrument_type', p.instrumentType).eq('serial_code', p.serialCode).select('id');
  if (error) throw new Error(`redeem ${p.serialCode}: ${error.message}`);
  if (data && data.length) return true;

  // No issued row — insert a redeemed one (value must be > 0 per the check constraint).
  const value = Number(p.value) > 0 ? Number(p.value) : null;
  if (value == null) { console.warn(`[ledger] redeem ${p.serialCode}: no issued row and no value — skipped`); return false; }
  const { error: insErr } = await supabase.from(TABLE).insert({
    instrument_type:   p.instrumentType,
    serial_code:       p.serialCode,
    value,
    status:            'redeemed',
    target_draft_id:   p.targetDraftId ? String(p.targetDraftId) : null,
    target_order_id:   p.targetOrderId ? String(p.targetOrderId) : null,
    target_order_name: p.targetOrderName || null,
    redeemed_at:       now,
    updated_at:        now,
  });
  if (insErr) throw new Error(`redeem-insert ${p.serialCode}: ${insErr.message}`);
  return true;
}

// Mark an instrument APPLIED to a draft (pending, reversible) — NOT a true redemption yet. A voucher/
// exchange note applied to a draft reserves it; it becomes 'redeemed' only when the draft converts to
// an order (promoteApplied). Lazily inserts an applied row if none exists (mirrors redeem's fallback).
async function apply(supabase, p) {
  const now = new Date().toISOString();
  const patch = { status: 'applied', applied_at: now, updated_at: now };
  if (p.targetDraftId) patch.target_draft_id = String(p.targetDraftId);
  // A CAD advance consumed on its OWN draft (Path A) is terminal at conversion, not a reservation —
  // it knows its order there and then, so it records it. Vouchers/notes pass neither and are
  // unaffected: for them 'applied' still means reserved until promoteApplied.
  if (p.targetOrderId)   patch.target_order_id   = String(p.targetOrderId);
  if (p.targetOrderName) patch.target_order_name = p.targetOrderName;

  const { data, error } = await supabase.from(TABLE).update(patch)
    .eq('instrument_type', p.instrumentType).eq('serial_code', p.serialCode).select('id');
  if (error) throw new Error(`apply ${p.serialCode}: ${error.message}`);
  if (data && data.length) return true;

  const value = Number(p.value) > 0 ? Number(p.value) : null;
  if (value == null) { console.warn(`[ledger] apply ${p.serialCode}: no issued row and no value — skipped`); return false; }
  const { error: insErr } = await supabase.from(TABLE).insert({
    instrument_type: p.instrumentType, serial_code: p.serialCode, value,
    status: 'applied', target_draft_id: p.targetDraftId ? String(p.targetDraftId) : null,
    applied_at: now, updated_at: now,
  });
  if (insErr) throw new Error(`apply-insert ${p.serialCode}: ${insErr.message}`);
  return true;
}

// Promote every instrument APPLIED to a draft to a TRUE redemption once that draft converts to an
// order. Returns the serials promoted. Only touches status='applied' rows for the draft.
async function promoteApplied(supabase, { targetDraftId, targetOrderId, targetOrderName }) {
  const now = new Date().toISOString();
  const patch = { status: 'redeemed', redeemed_at: now, updated_at: now };
  if (targetOrderId)   patch.target_order_id   = String(targetOrderId);
  if (targetOrderName) patch.target_order_name = targetOrderName;
  const { data, error } = await supabase.from(TABLE).update(patch)
    .eq('status', 'applied').eq('target_draft_id', String(targetDraftId)).select('serial_code');
  if (error) throw new Error(`promoteApplied draft ${targetDraftId}: ${error.message}`);
  return (data || []).map(r => r.serial_code);
}

// Revert instruments APPLIED to a draft back to 'open' (draft deleted/abandoned or voucher removed) —
// so a reservation that never converted stops counting as used. Returns the serials reverted.
async function revertApplied(supabase, { targetDraftId }) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from(TABLE)
    .update({ status: 'open', target_draft_id: null, applied_at: null, updated_at: now })
    .eq('status', 'applied').eq('target_draft_id', String(targetDraftId)).select('serial_code');
  if (error) throw new Error(`revertApplied draft ${targetDraftId}: ${error.message}`);
  return (data || []).map(r => r.serial_code);
}

// Reopen an instrument back to 'open' — used when a voucher/note is removed from a draft BEFORE it
// converts, so it becomes available and re-addable again (as opposed to voidInstrument, which kills it).
// Clears every draft/order linkage. Caller must ensure it isn't already truly redeemed on an order.
async function reopen(supabase, p) {
  const now = new Date().toISOString();
  const { error } = await supabase.from(TABLE).update({
    status: 'open', target_draft_id: null, applied_at: null,
    redeemed_at: null, target_order_id: null, target_order_name: null, updated_at: now,
  }).eq('instrument_type', p.instrumentType).eq('serial_code', p.serialCode);
  if (error) throw new Error(`reopen ${p.serialCode}: ${error.message}`);
  return true;
}

// Mark an instrument VOIDED.
async function voidInstrument(supabase, p) {
  const now = new Date().toISOString();
  const { error } = await supabase.from(TABLE).update({ status: 'voided', voided_at: now, updated_at: now })
    .eq('instrument_type', p.instrumentType).eq('serial_code', p.serialCode);
  if (error) throw new Error(`voidInstrument ${p.serialCode}: ${error.message}`);
  return true;
}

// Open instruments for a customer (drives the offline "pick a voucher" dropdown). Expired-on-read
// rows (open past expires_at) are excluded.
async function listOpenForCustomer(supabase, { customerId, instrumentType } = {}) {
  let q = supabase.from(TABLE)
    .select('instrument_type,serial_code,value,customer_name,source_order_name,issued_at,expires_at')
    .eq('status', 'open');
  if (instrumentType) q = q.eq('instrument_type', instrumentType);
  if (customerId != null) q = q.eq('customer_id', String(customerId));
  const { data, error } = await q.order('issued_at', { ascending: true });
  if (error) throw new Error(`listOpenForCustomer: ${error.message}`);
  const now = Date.now();
  return (data || []).filter(r => !(r.expires_at && new Date(r.expires_at).getTime() < now));
}

// Single instrument by (type, serial) — used to gate redemption (validity + single-use). null if none.
async function getBySerial(supabase, { instrumentType, serialCode }) {
  const { data, error } = await supabase.from(TABLE).select('*')
    .eq('instrument_type', instrumentType).eq('serial_code', serialCode).maybeSingle();
  if (error) throw new Error(`getBySerial ${serialCode}: ${error.message}`);
  return data || null;
}

// Fetch rows for the recon report (aggregation happens in the route).
async function fetchAll(supabase, { from, to, instrumentType } = {}) {
  let q = supabase.from(TABLE).select('*');
  if (instrumentType) q = q.eq('instrument_type', instrumentType);
  if (from) q = q.gte('issued_at', from);
  if (to)   q = q.lte('issued_at', to);
  const { data, error } = await q.order('issued_at', { ascending: true });
  if (error) throw new Error(`recon fetch: ${error.message}`);
  return data || [];
}

// Move a row to a new serial_code. Vouchers and exchange notes never need this — their code is
// minted once and is permanent. A CAD advance has no minted number at all: the row opens under the
// DRAFT name (the only identifier that exists when the money lands) and is rekeyed to the ORDER name
// when that draft converts, because the order name is what staff reference later. Extra columns can
// be set in the same write via `patch`.
// No-ops when the destination key already exists, so a replayed conversion webhook cannot collide.
async function rekey(supabase, { instrumentType, fromSerialCode, toSerialCode, patch = {} }) {
  if (!fromSerialCode || !toSerialCode || fromSerialCode === toSerialCode) return false;
  const existing = await getBySerial(supabase, { instrumentType, serialCode: toSerialCode });
  if (existing) return false;
  const { data, error } = await supabase.from(TABLE)
    .update({ ...patch, serial_code: toSerialCode, updated_at: new Date().toISOString() })
    .eq('instrument_type', instrumentType).eq('serial_code', fromSerialCode).select('id');
  if (error) throw new Error(`rekey ${fromSerialCode}→${toSerialCode}: ${error.message}`);
  return !!(data && data.length);
}

// Flip every still-open row past its expiry to a STORED 'expired'. effectiveStatus() already derives
// expiry on read, but derived state cannot gate a write: the redeem path reads advance_status off the
// Shopify document, so the expiry has to actually be written somewhere to refuse a redemption.
// Returns the rows it expired, which is what the accounts digest reports.
async function expireOverdue(supabase, { instrumentType, asOf } = {}) {
  const cutoff = asOf || new Date().toISOString().slice(0, 10);
  let q = supabase.from(TABLE)
    .select('instrument_type,serial_code,value,customer_name,source_order_name,issued_at,expires_at')
    .eq('status', 'open').lt('expires_at', cutoff);
  if (instrumentType) q = q.eq('instrument_type', instrumentType);
  const { data, error } = await q;
  if (error) throw new Error(`expireOverdue: ${error.message}`);
  const rows = data || [];
  if (!rows.length) return [];

  const now = new Date().toISOString();
  const { error: updErr } = await supabase.from(TABLE)
    .update({ status: 'expired', updated_at: now })
    .eq('status', 'open').lt('expires_at', cutoff)
    .in('serial_code', rows.map(r => r.serial_code));
  if (updErr) throw new Error(`expireOverdue update: ${updErr.message}`);
  return rows;
}

// Open rows whose expiry falls inside [from, to] — the "about to cross" half of the accounts digest.
async function listExpiringBetween(supabase, { instrumentType, from, to }) {
  let q = supabase.from(TABLE)
    .select('instrument_type,serial_code,value,customer_name,source_order_name,issued_at,expires_at')
    .eq('status', 'open').gte('expires_at', from).lte('expires_at', to);
  if (instrumentType) q = q.eq('instrument_type', instrumentType);
  const { data, error } = await q.order('expires_at', { ascending: true });
  if (error) throw new Error(`listExpiringBetween: ${error.message}`);
  return data || [];
}

// Effective status on read: an 'open' row past its expiry counts as 'expired' (derived, not stored).
function effectiveStatus(row, nowMs) {
  if (row.status === 'open' && row.expires_at && new Date(row.expires_at).getTime() < nowMs) return 'expired';
  return row.status;
}

module.exports = { upsertIssued, apply, promoteApplied, revertApplied, reopen, redeem, voidInstrument, getBySerial, listOpenForCustomer, fetchAll, effectiveStatus, rekey, expireOverdue, listExpiringBetween };
