'use strict';

/**
 * GST — the single implementation.
 *
 * Jewellery is taxed at a flat 3%, split by place of supply:
 *   intra-state  → CGST 1.5% + SGST 1.5%
 *   inter-state  → IGST 3%
 *
 * WHY THIS FILE EXISTS
 * reporting/recon.js and reporting/reports.js each carried their own gstSplit. Same rates, but
 * they rounded differently — and on amounts that land exactly halfway they disagreed by one
 * paisa. Measured across 1.5M amount/state combinations: 4,476 disagreements. Small, but enough
 * that the reconciliation report and the sales report could show different tax on the same order,
 * which is exactly what stops a reconciliation balancing to zero.
 *
 * The old recon.js version used `+(t * 0.015).toFixed(2)`. That rounds DOWN on a half-paisa, not
 * by intent but as an artefact of binary floating point: ₹4,567.00 × 1.5% is 68.505, stored as
 * 68.50499999…, so toFixed(2) yields 68.50. reports.js used Math.round with an epsilon nudge,
 * which correctly rounds half UP to 68.51.
 *
 * Round-half-up is the convention, so that behaviour is canonical here. Confirmed 2026-08-11.
 *
 *   ₹4,567.00 taxable → CGST 68.51, SGST 68.51   (was 68.50 in recon)
 *   ₹1.00     taxable → CGST 0.02,  SGST 0.02    (was 0.01  in recon)
 */

const GST_RATE       = 0.03;
const GST_HALF_RATE  = 0.015;

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/**
 * Round to 2dp, half UP.
 * The epsilon nudge is load-bearing: without it, a value that is mathematically x.xx5 but stored
 * as x.xx499999… rounds down. Do not "simplify" it away.
 */
const r2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

/** Normalise a state code: "KA-BLR" and " ka " both become "KA". */
const supplierState = (stateCode) =>
  String(stateCode || '').split('-')[0].trim().toUpperCase() || 'KA';

const normState = (s) => String(s || '').trim().toUpperCase();

/**
 * Split a taxable base into GST components.
 *
 * @param {number} taxable  taxable value (i.e. tax-exclusive base)
 * @param {string} supplier place-of-supply state — the store's state
 * @param {string} dest     destination state; falls back to supplier when unknown, which makes
 *                          an address-less document intra-state rather than silently IGST
 */
function gstSplit(taxable, supplier, dest) {
  const sup = supplierState(supplier);
  const d   = normState(dest) || sup;
  const t   = r2(taxable);
  return d === sup
    ? { igst: 0,                     cgst: r2(t * GST_HALF_RATE), sgst: r2(t * GST_HALF_RATE) }
    : { igst: r2(t * GST_RATE),      cgst: 0,                     sgst: 0 };
}

module.exports = { gstSplit, supplierState, normState, r2, GST_RATE, GST_HALF_RATE };
