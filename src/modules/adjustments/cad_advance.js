'use strict';

// CAD advance — shared vocabulary.
//
// A CAD (design) advance is money taken up front so a customer's piece can be rendered. It reaches a
// draft as a custom line item titled "CAD Advance" (or a variant whose SKU starts CAD-ADV), and the
// presence of that line is how every part of the system knows a document carries one.
//
// These predicates live here rather than in server.js because three unrelated callers need exactly
// the same answer and must never drift apart: the draft webhook chain (capture/redeem/conversion),
// the serial minter (an advance-only order must never be given an invoice number), and the sweeps.
//
// See CAD_ADVANCE_TRACKING_SPEC.md for the model these encode.

const CAD_ADVANCE_MODE = 'CAD Advance';   // installment mode for a Path B absorbed leg (no tender moves)
const CAD_ADVANCE_DAYS = 365;             // validity, from custom.advance_date (the day payment landed)
const CAD_STALE_DAYS   = 60;              // an untouched advance-only draft converts after this
// The customer reminder goes out 11 calendar months after the payment — roughly a month before the
// advance lapses, which is enough notice to come in and use it. Calendar months, not 335 days, so
// the mail lands on the same day-of-month the money was taken.
const CAD_REMINDER_MONTHS = 11;

// Add whole calendar months to a YYYY-MM-DD date, clamping to the end of a short month (31 Mar + 11
// months → 28/29 Feb, never 3 Mar). Returns YYYY-MM-DD.
function addMonths(dateStr, months) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

function isCadAdvanceLine(li) {
  return /cad advance/i.test(String(li.title || '')) || /^CAD-ADV/i.test(String(li.sku || ''));
}

// Shopify carries a manual discount as a negative-priced line. It is not a product, so it can never
// be what makes a document "more than just an advance".
function isNegativeDiscountLine(li) {
  return (li.title || '').toLowerCase().includes('discount') && parseFloat(li.price) < 0;
}

function hasCadAdvanceLine(doc) {
  return (doc.line_items || []).some(isCadAdvanceLine);
}

// A real product sits alongside the advance — this document is a SALE the advance settles against,
// not a bare advance receipt.
function hasProductLineBesidesCad(doc) {
  return (doc.line_items || []).some(li => !isCadAdvanceLine(li) && !isNegativeDiscountLine(li));
}

// Nothing but the advance on it. This is what the stale-draft sweep converts, and what must never be
// given an invoice serial.
//
// Returns false for a document with no line items at all: some webhook payloads and API reads arrive
// without them, and "I could not see any lines" must never be mistaken for "there is only an
// advance here" — that mistake would suppress a real invoice number, which is unrecoverable.
function isCadAdvanceOnly(doc) {
  const lines = (doc.line_items || []).filter(li => !isNegativeDiscountLine(li));
  return lines.length > 0 && lines.every(isCadAdvanceLine);
}

function cadAdvanceLineTotal(doc) {
  return (doc.line_items || []).filter(isCadAdvanceLine)
    .reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 0), 0);
}

// Ledger key. Nothing is minted for a CAD advance (it is not an invoice), so the document's own name
// IS the identifier. The row opens under the draft name at capture — all that exists then — and is
// rekeyed to the order name at conversion, because the order name is what staff type into
// intake.advance_ref later and what every report prints. An advance whose draft never converts keeps
// the draft name, which is correct: there is nothing else to call it.
function cadLedgerKey(docName) { return String(docName || '').trim(); }

module.exports = {
  CAD_ADVANCE_MODE, CAD_ADVANCE_DAYS, CAD_STALE_DAYS, CAD_REMINDER_MONTHS, addMonths,
  isCadAdvanceLine, isNegativeDiscountLine, hasCadAdvanceLine,
  hasProductLineBesidesCad, isCadAdvanceOnly, cadAdvanceLineTotal, cadLedgerKey,
};
