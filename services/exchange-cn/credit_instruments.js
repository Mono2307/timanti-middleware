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

// Effective status on read: an 'open' row past its expiry counts as 'expired' (derived, not stored).
function effectiveStatus(row, nowMs) {
  if (row.status === 'open' && row.expires_at && new Date(row.expires_at).getTime() < nowMs) return 'expired';
  return row.status;
}

module.exports = { upsertIssued, redeem, voidInstrument, getBySerial, listOpenForCustomer, fetchAll, effectiveStatus };
