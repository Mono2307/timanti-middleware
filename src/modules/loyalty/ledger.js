'use strict';

/**
 * Supabase reads and writes for the loyalty ledger and redemptions (schema: ./migration.sql).
 * Every function takes the supabase client first, the same minimal deps pattern as
 * adjustments/credit_instruments.js, so tests can hand in a fake.
 */

const LEDGER = 'loyalty_ledger';
const REDEMPTIONS = 'loyalty_redemptions';

/**
 * Record what one order earns. Upsert keyed by order, so repeated webhook deliveries and later
 * refunds simply overwrite the order's figure.
 *
 * Returns { changed, previousCustomerId } — changed is false when the stored row already says the
 * same thing, which lets the caller skip the Shopify customer write on the duplicate deliveries.
 */
async function upsertOrderEntry(supabase, { customerId, orderId, orderName, points, kind = 'earn', channel = null }) {
  const entryKey = `order:${orderId}`;
  const { data: prior, error: readErr } = await supabase.from(LEDGER)
    .select('customer_id, points').eq('entry_key', entryKey).maybeSingle();
  if (readErr) throw new Error(`loyalty ledger read ${entryKey}: ${readErr.message}`);
  if (prior && String(prior.customer_id) === String(customerId) && Number(prior.points) === Number(points)) {
    return { changed: false, previousCustomerId: prior.customer_id };
  }
  const row = {
    entry_key: entryKey,
    customer_id: String(customerId),
    order_id: String(orderId),
    order_name: orderName || null,
    kind,
    channel,
    points: Math.max(0, Math.floor(Number(points) || 0)),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from(LEDGER).upsert(row, { onConflict: 'entry_key' });
  if (error) throw new Error(`loyalty ledger write ${entryKey}: ${error.message}`);
  return { changed: true, previousCustomerId: prior ? prior.customer_id : null };
}

/** A manual adjustment (positive or negative). entryKey must be unique per adjustment. */
async function addAdjustment(supabase, { customerId, entryKey, points, note }) {
  const { error } = await supabase.from(LEDGER).upsert({
    entry_key: `adjust:${entryKey}`,
    customer_id: String(customerId),
    kind: 'adjust',
    points: Math.floor(Number(points) || 0),
    note: note || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'entry_key' });
  if (error) throw new Error(`loyalty adjustment: ${error.message}`);
}

/** Lifetime points for a customer: the sum of their ledger rows. */
async function customerPoints(supabase, customerId) {
  const { data, error } = await supabase.from(LEDGER)
    .select('points').eq('customer_id', String(customerId));
  if (error) throw new Error(`loyalty points read ${customerId}: ${error.message}`);
  return (data || []).reduce((s, r) => s + (Number(r.points) || 0), 0);
}

/** All ledger rows for a customer, newest first — for the admin lookup. */
async function customerEntries(supabase, customerId) {
  const { data, error } = await supabase.from(LEDGER)
    .select('*').eq('customer_id', String(customerId)).order('updated_at', { ascending: false });
  if (error) throw new Error(`loyalty entries read ${customerId}: ${error.message}`);
  return data || [];
}

async function insertRedemption(supabase, row) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from(REDEMPTIONS)
    .insert({ ...row, created_at: now, updated_at: now }).select('id').single();
  if (error) throw new Error(`loyalty redemption insert: ${error.message}`);
  return data;
}

async function getRedemptionByCode(supabase, code) {
  const { data, error } = await supabase.from(REDEMPTIONS)
    .select('*').eq('code', String(code)).maybeSingle();
  if (error) throw new Error(`loyalty redemption read ${code}: ${error.message}`);
  return data || null;
}

async function updateRedemption(supabase, id, patch) {
  const { error } = await supabase.from(REDEMPTIONS)
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`loyalty redemption update ${id}: ${error.message}`);
}

/** Pending online codes for a customer that have not expired yet. */
async function pendingCodesFor(supabase, customerId) {
  const { data, error } = await supabase.from(REDEMPTIONS)
    .select('*').eq('customer_id', String(customerId)).eq('channel', 'online').eq('status', 'pending')
    .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false });
  if (error) throw new Error(`loyalty pending codes ${customerId}: ${error.message}`);
  return data || [];
}

/** Pending online codes whose time is up — for the sweep to delete. */
async function expiredPendingCodes(supabase) {
  const { data, error } = await supabase.from(REDEMPTIONS)
    .select('*').eq('channel', 'online').eq('status', 'pending')
    .lt('expires_at', new Date().toISOString()).limit(200);
  if (error) throw new Error(`loyalty expired codes: ${error.message}`);
  return data || [];
}

/** How many codes a customer asked for in the last hour (abuse guard). */
async function codesIssuedSince(supabase, customerId, sinceIso) {
  const { count, error } = await supabase.from(REDEMPTIONS)
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', String(customerId)).eq('channel', 'online').gte('created_at', sinceIso);
  if (error) throw new Error(`loyalty code count ${customerId}: ${error.message}`);
  return count || 0;
}

/** The store redemption already recorded for a draft, if any (makes conversion idempotent). */
async function storeRedemptionForDraft(supabase, draftId) {
  const { data, error } = await supabase.from(REDEMPTIONS)
    .select('id').eq('channel', 'store').eq('draft_id', String(draftId)).maybeSingle();
  if (error) throw new Error(`loyalty store redemption read ${draftId}: ${error.message}`);
  return data || null;
}

module.exports = {
  upsertOrderEntry, addAdjustment, customerPoints, customerEntries,
  insertRedemption, getRedemptionByCode, updateRedemption,
  pendingCodesFor, expiredPendingCodes, codesIssuedSince, storeRedemptionForDraft,
};
