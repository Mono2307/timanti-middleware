// ─────────────────────────────────────────
// Payment installments — pure helpers
//
// Up to MAX_INSTALLMENTS legs, each stored as three FLAT metafields:
//   custom.installment_N_value  (number_decimal)
//   custom.installment_N_mode   (text + choices enum)
//   custom.installment_N_date   (date)
// plus custom.installment_N_type ('payment' | 'cad_advance') on every slot.
//
// Flat scalars rather than one JSON array so staff can type into them in the native Shopify editor
// (and Metafields Guru), each field gets a real widget in the admin extension, and Liquid renders
// the invoice payment table without parsing.
//
// custom.amount_paid stays the single cumulative figure every downstream reader already consumes
// (invoices, sales/adjustment reports, recon, the CAD capture gate) — it is now the SUM of these
// legs rather than one of two named slots.
//
// A cad_advance row is SETTLEMENT, not decoration — it counts toward amount_paid like any other leg.
// Path A: the design advance is real money received on this same draft (its mode is the real tender).
// Path B: it is the advance from an earlier order, absorbed onto this sale (its mode is 'CAD Advance',
// because no money moves on this document).
//
// It does not collide with the post-tax custom.advance deduction, because that deduction only applies
// while the CAD Advance LINE ITEM is still on the document — i.e. exactly when the advance is a CHARGE
// on this bill that the deduction cancels, rather than a RECEIPT against it. See syncAmountToCollect
// in server.js and §1 of CAD_ADVANCE_TRACKING_SPEC.md.
//
// No I/O here — everything takes a plain { key: value } map over the custom namespace so it can be
// unit tested and reused by the backfill script.
// ─────────────────────────────────────────

const MAX_INSTALLMENTS = 4;

// Sparse-safe: a draft may have slots 1 and 3 populated with 2 empty. Legs come back in slot order.
function readInstallments(mfMap) {
  const map = mfMap || {};
  const rows = [];
  for (let n = 1; n <= MAX_INSTALLMENTS; n++) {
    const value = parseFloat(map[`installment_${n}_value`]);
    if (!Number.isFinite(value) || value <= 0) continue;
    rows.push({
      slot:  n,
      value,
      mode: String(map[`installment_${n}_mode`] || '').trim(),
      date: String(map[`installment_${n}_date`] || '').trim(),
      // ANY slot can carry a CAD design advance. Path A puts it in slot 1 (it absorbs the first
      // payment by definition), but a Path B advance absorbed onto a later sale lands in whatever
      // slot is free at redemption time — often after a deposit already taken on that sale.
      type: String(map[`installment_${n}_type`] || '').trim() || 'payment',
    });
  }
  return rows;
}

// What has been SETTLED on this document — every leg, cad_advance included (see the note above).
function sumInstallments(rows) {
  return (rows || []).reduce((s, r) => s + r.value, 0);
}

// Distinct modes across all legs, in slot order. Feeds the aggregate `pmodes:` tag that replaces
// pmode-advance:/pmode-final: — recon reads modes off tags to disambiguate same-amount candidates.
function installmentModes(rows) {
  return [...new Set((rows || []).map(r => r.mode).filter(Boolean))];
}

// A document paid BEFORE installments existed carries amount_paid with no legs behind it. The
// moment one leg appears, every recompute starts trusting the leg sum — and silently writes the
// balance down by the un-legged amount. Seen live on #D194: Rs10,000 recorded the old way, a
// Rs5,000 leg added, and the next sync reset amount_paid from 15,000 to 5,000.
//
// So before anything reads the legs as authoritative, fold that residue into its own leg. The date
// is left blank because it is genuinely unknown — inventing today's date would print a false
// receipt date on the customer's invoice. Mode falls back to the legacy two-slot fields.
//
// ONLY fires when there are NO legs yet — i.e. the document has never been touched by the
// installment model. Once a single leg exists the legs are authoritative and amount_paid follows
// them, including DOWNWARD. Folding on a document that already has legs would make corrections
// impossible: blank a leg to remove a payment and the difference would just reappear as a new
// leg, pinning the order permanently at its old total and at "fully paid".
//
// Returns the effective rows plus the patch needed to persist the synthetic leg ({} when none).
function materializeLegacyLeg(mfMap, rows) {
  if ((rows || []).length) return { rows, patch: {} };
  const recorded = parseFloat((mfMap || {}).amount_paid) || 0;
  const residue  = recorded - sumInstallments(rows);
  if (!(residue >= 0.5)) return { rows, patch: {} };

  const used = new Set((rows || []).map(r => r.slot));
  let slot = 0;
  for (let n = 1; n <= MAX_INSTALLMENTS; n++) { if (!used.has(n)) { slot = n; break; } }
  // No free slot: leave it alone. Losing the audit trail beats losing the money.
  if (!slot) {
    console.warn(`[payments] Rs${residue.toFixed(2)} recorded before installments has no free slot — amount_paid left as-is`);
    return { rows, patch: {} };
  }

  const mode = String((mfMap.payment_mode_advance || mfMap.payment_mode_final || '')).trim();
  const patch = { [`installment_${slot}_value`]: residue.toFixed(2) };
  if (mode) patch[`installment_${slot}_mode`] = mode;
  console.log(`[payments] folded Rs${residue.toFixed(2)} of pre-installment payment into slot ${slot}${mode ? ` (${mode})` : ''}`);

  return {
    rows: rows.concat([{ slot, value: residue, mode, date: '', type: 'payment' }]).sort((a, b) => a.slot - b.slot),
    patch,
  };
}

// Metafield patch placing one new leg in the next free slot.
// Slots exhausted → fold the overflow into the last slot rather than dropping the payment; the
// money must never disappear just because someone took a 5th instalment.
//
// `type` ('cad_advance') is written only when the leg lands in a slot of its own. A folded leg is
// deliberately left at whatever type the slot already had: merging an absorbed advance into a leg of
// real collected money and calling the result an advance would mislabel the money, and the reverse
// would hide the advance. The warning below is the signal that a human has to split it by hand.
function installmentLegPatch(rows, { value, mode, date, type }) {
  const used = new Set((rows || []).map(r => r.slot));
  let slot = 0;
  for (let n = 1; n <= MAX_INSTALLMENTS; n++) { if (!used.has(n)) { slot = n; break; } }
  if (!slot) {
    slot = MAX_INSTALLMENTS;
    const existing = (rows || []).find(r => r.slot === slot);
    const merged = (existing?.value || 0) + value;
    console.warn(`[payments] installment slots exhausted — folding Rs${value.toFixed(2)} into slot ${slot} (now Rs${merged.toFixed(2)})`);
    return {
      [`installment_${slot}_value`]: merged.toFixed(2),
      [`installment_${slot}_mode`]:  mode || existing?.mode || '',
      [`installment_${slot}_date`]:  date,
    };
  }
  const patch = {
    [`installment_${slot}_value`]: value.toFixed(2),
    [`installment_${slot}_mode`]:  mode || '',
    [`installment_${slot}_date`]:  date,
  };
  if (type && type !== 'payment') patch[`installment_${slot}_type`] = type;
  return patch;
}

module.exports = {
  MAX_INSTALLMENTS,
  readInstallments,
  sumInstallments,
  installmentModes,
  installmentLegPatch,
  materializeLegacyLeg,
};
