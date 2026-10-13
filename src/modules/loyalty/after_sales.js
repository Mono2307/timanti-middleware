'use strict';

/**
 * After-sales credit (vouchers and exchange notes) as the loyalty engine sees it.
 *
 * Founder's rule (2026-10-13): a voucher or exchange note issued against an order counts like a
 * refund of that order ONLY once it has been REDEEMED, i.e. spent on another order that actually
 * converted. Issued, applied-to-a-draft, voided or expired notes change nothing. The source of truth
 * is the credit-instrument ledger (status 'redeemed'); order tags such as exc-given/exc-val are not
 * read, so editing a tag cannot move anyone's points.
 *
 * The order the credit is spent on earns its full value: the note or voucher is tender there and
 * engine.orderEarnValue already adds it back.
 */

const TABLE = 'credit_instruments';
const TYPES = ['voucher', 'exchange_note'];

/** Rupees of redeemed vouchers / exchange notes issued against one order (by its name, "#1060"). */
async function redeemedAgainst(supabase, orderName) {
  if (!orderName) return 0;
  const { data, error } = await supabase.from(TABLE).select('value')
    .eq('status', 'redeemed').eq('source_order_name', String(orderName)).in('instrument_type', TYPES);
  if (error) throw new Error(`redeemed after-sales for ${orderName}: ${error.message}`);
  return (data || []).reduce((s, r) => s + (Number(r.value) || 0), 0);
}

/** { "#1060": 47041, ... } for every order with redeemed after-sales credit — for the backfill. */
async function redeemedAgainstMap(supabase) {
  const { data, error } = await supabase.from(TABLE).select('source_order_name, value')
    .eq('status', 'redeemed').in('instrument_type', TYPES).not('source_order_name', 'is', null);
  if (error) throw new Error(`redeemed after-sales map: ${error.message}`);
  const out = {};
  for (const r of data || []) out[r.source_order_name] = (out[r.source_order_name] || 0) + (Number(r.value) || 0);
  return out;
}

/** Source orders of every redeemed voucher / exchange note — re-checked by the nightly sweep. */
async function sourceOrdersWithRedemptions(supabase) {
  return Object.keys(await redeemedAgainstMap(supabase));
}

/** The source order of one instrument, when it is a redeemed voucher / exchange note. */
async function redeemedSource(supabase, { instrumentType, serialCode }) {
  if (!TYPES.includes(instrumentType) || !serialCode) return null;
  const { data, error } = await supabase.from(TABLE).select('status, source_order_name')
    .eq('instrument_type', instrumentType).eq('serial_code', serialCode).maybeSingle();
  if (error) throw new Error(`instrument ${serialCode}: ${error.message}`);
  return data && data.status === 'redeemed' ? data.source_order_name || null : null;
}

module.exports = { redeemedAgainst, redeemedAgainstMap, sourceOrdersWithRedemptions, redeemedSource, TYPES };
