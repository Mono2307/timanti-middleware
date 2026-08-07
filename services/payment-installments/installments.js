// ─────────────────────────────────────────
// Payment installments — pure helpers
//
// Up to MAX_INSTALLMENTS legs, each stored as three FLAT metafields:
//   custom.installment_N_value  (number_decimal)
//   custom.installment_N_mode   (text + choices enum)
//   custom.installment_N_date   (date)
// plus custom.installment_1_type ('payment' | 'cad_advance').
//
// Flat scalars rather than one JSON array so staff can type into them in the native Shopify editor
// (and Metafields Guru), each field gets a real widget in the admin extension, and Liquid renders
// the invoice payment table without parsing.
//
// custom.amount_paid stays the single cumulative figure every downstream reader already consumes
// (invoices, sales/adjustment reports, recon, the CAD capture gate) — it is now the SUM of these
// legs rather than one of two named slots.
//
// A cad_advance row is DISPLAY ONLY. custom.advance already reduces amount_to_be_collected as a
// post-tax adjustment, so counting it as money paid too would deduct the same rupees twice.
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
      // Only slot 1 can carry a CAD design advance — it absorbs the FIRST payment by definition.
      type: n === 1 ? (String(map.installment_1_type || '').trim() || 'payment') : 'payment',
    });
  }
  return rows;
}

// What was actually COLLECTED. Excludes cad_advance — see the double-deduction note above.
function sumInstallments(rows) {
  return (rows || []).reduce((s, r) => s + (r.type === 'cad_advance' ? 0 : r.value), 0);
}

// Distinct modes across all legs, in slot order. Feeds the aggregate `pmodes:` tag that replaces
// pmode-advance:/pmode-final: — recon reads modes off tags to disambiguate same-amount candidates.
function installmentModes(rows) {
  return [...new Set((rows || []).map(r => r.mode).filter(Boolean))];
}

// Metafield patch placing one new leg in the next free slot.
// Slots exhausted → fold the overflow into the last slot rather than dropping the payment; the
// money must never disappear just because someone took a 5th instalment.
function installmentLegPatch(rows, { value, mode, date }) {
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
  return {
    [`installment_${slot}_value`]: value.toFixed(2),
    [`installment_${slot}_mode`]:  mode || '',
    [`installment_${slot}_date`]:  date,
  };
}

module.exports = {
  MAX_INSTALLMENTS,
  readInstallments,
  sumInstallments,
  installmentModes,
  installmentLegPatch,
};
