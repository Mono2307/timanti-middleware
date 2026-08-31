// ─────────────────────────────────────────
// Payment refunds — pure helpers
//
// Up to MAX_REFUNDS legs, each stored as four FLAT metafields:
//   custom.refund_N_value  (number_decimal)
//   custom.refund_N_mode   (text + choices enum, shares the payment_mode list)
//   custom.refund_N_date   (date)
//   custom.refund_N_ref    (text — the gateway UTR / reference for the transfer)
// plus the derived cumulative custom.amount_refunded.
//
// Same flat-scalar shape as the installment legs, and for the same reason: staff type into them in
// the native Shopify editor, each field gets a real widget in the admin extension, and Liquid renders
// the refund row on the invoice without parsing.
//
// A REFUND IS NOT A NEGATIVE INSTALLMENT LEG. Two things in installments.js make that impossible:
// readInstallments skips any slot whose value is <= 0, so a negative leg is silently dropped on the
// next read; and there are only 4 slots, with overflow folded into the last one, so refunds would
// compete with payments for space. They get their own dimension instead.
//
// The consequence is the rule the whole feature rests on: custom.amount_paid stays GROSS collected
// and is never written down. What the customer has actually settled is derived —
//   netPaid        = amount_paid - amount_refunded
//   amount_pending = amount_to_be_collected - amount_paid + amount_refunded
// This matters because reconcileDepositPaid (server.js) deliberately takes the HIGHER of the deposit
// row and the leg sum so a payment can never shrink. A refund that wrote amount_paid down would lose
// that fight on the next recompute, and the pre-refund figure would silently win.
//
// No I/O here — everything takes a plain { key: value } map over the custom namespace so it can be
// unit tested and reused by the handlers.
// ─────────────────────────────────────────

const MAX_REFUNDS = 2;

// Sparse-safe, mirroring readInstallments: a draft may have slot 2 populated with 1 empty.
// Legs come back in slot order.
function readRefunds(mfMap) {
  const map = mfMap || {};
  const rows = [];
  for (let n = 1; n <= MAX_REFUNDS; n++) {
    const value = parseFloat(map[`refund_${n}_value`]);
    if (!Number.isFinite(value) || value <= 0) continue;
    rows.push({
      slot: n,
      value,
      mode: String(map[`refund_${n}_mode`] || '').trim(),
      date: String(map[`refund_${n}_date`] || '').trim(),
      ref:  String(map[`refund_${n}_ref`]  || '').trim(),
    });
  }
  return rows;
}

// What has been RETURNED on this document. Always positive — the sign lives in the arithmetic that
// consumes it, never in the stored value, so the value > 0 check on the ledger row holds.
function sumRefunds(rows) {
  return (rows || []).reduce((s, r) => s + r.value, 0);
}

// Ledger key for one refund leg: the document's own name plus the slot.
//
// A refund mints nothing, so — exactly like a CAD advance (see cadLedgerKey in
// adjustments/cad_advance.js) — the document name IS the identifier. The slot suffix is what keeps
// two refunds on the same draft from colliding, and it makes the credit_instruments unique
// constraint on (instrument_type, serial_code) the idempotency guard for free: the draft webhook
// fires repeatedly, and a replayed pass must not write a second row.
function refundLedgerKey(docName, slot) {
  return `${String(docName || '').trim()}-R${slot}`;
}

// Metafield patch placing one new refund leg in the next free slot.
// Slots exhausted → fold the overflow into the last slot rather than dropping the refund; money that
// left the bank must never disappear just because someone refunded a third time. The merged leg keeps
// the newer mode/date/ref, because that is the transfer a customer chasing it would be asking about.
function refundLegPatch(rows, { value, mode, date, ref }) {
  const used = new Set((rows || []).map(r => r.slot));
  let slot = 0;
  for (let n = 1; n <= MAX_REFUNDS; n++) { if (!used.has(n)) { slot = n; break; } }
  if (!slot) {
    slot = MAX_REFUNDS;
    const existing = (rows || []).find(r => r.slot === slot);
    const merged = (existing?.value || 0) + value;
    console.warn(`[refunds] refund slots exhausted — folding Rs${value.toFixed(2)} into slot ${slot} (now Rs${merged.toFixed(2)})`);
    return {
      [`refund_${slot}_value`]: merged.toFixed(2),
      [`refund_${slot}_mode`]:  mode || existing?.mode || '',
      [`refund_${slot}_date`]:  date || existing?.date || '',
      [`refund_${slot}_ref`]:   ref  || existing?.ref  || '',
    };
  }
  const patch = { [`refund_${slot}_value`]: value.toFixed(2) };
  // Blank values are SKIPPED by core/metafields, never written as empty — so sending '' here would
  // silently leave whatever the slot held before. Only set what we actually have.
  if (mode) patch[`refund_${slot}_mode`] = mode;
  if (date) patch[`refund_${slot}_date`] = date;
  if (ref)  patch[`refund_${slot}_ref`]  = ref;
  return patch;
}

// The one place the refund arithmetic lives, so the four call sites that derive a balance
// (applyPaymentTagsToOrder, applyPaymentTagsToDraftOrder, handlePaymentCompletion,
// handleCashPaymentTag) cannot drift from one another.
//
// `epsilon` is server.js's PAID_EPSILON — the 1-rupee tolerance that stops float dust reading as an
// outstanding balance.
//
// The THIRD state is the one refunds introduce. Before this a document was full or partial, and
// `isPartial` was just `amountPaid > 0`. After a full refund the gross amountPaid is still 50,000
// while netPaid is 0 — so that test stays true forever and the draft keeps advertising
// "deposit:partial, paid:Rs50000" over money that has already gone back. isUnpaid is what breaks it.
function paymentState({ amountPaid, amountRefunded = 0, collectionBase, epsilon = 1 }) {
  const paid     = Number(amountPaid) || 0;
  const refunded = Number(amountRefunded) || 0;
  const netPaid  = paid - refunded;
  const amountPending = (Number(collectionBase) || 0) - netPaid;
  const isUnpaid  = netPaid < epsilon;
  const isFull    = !isUnpaid && amountPending < epsilon;
  const isPartial = !isUnpaid && !isFull;
  return { netPaid, amountPending, isUnpaid, isFull, isPartial };
}

module.exports = {
  MAX_REFUNDS,
  readRefunds,
  sumRefunds,
  refundLedgerKey,
  refundLegPatch,
  paymentState,
};
