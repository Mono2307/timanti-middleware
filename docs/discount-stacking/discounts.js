'use strict';

// ─────────────────────────────────────────
// Order-level discount codes — pure helpers
//
// STACKING (founder's call, 2026-10-07; the loyalty programme depends on it):
//   1. Several order-level codes can sit on one draft. Applying a second code APPENDS it.
//   2. Order-level codes ADD ON TOP of per-line discounts (custom.line_discounts). They used to be
//      replaced by them line by line, so a code on a draft with any per-line entry silently added Rs0.
//
// The arithmetic is ADDITIVE, never compounding: every code is evaluated against the PRE-discount base
// (custom → pre-tax diamond value; code → Shopify's tax-inclusive line total, ÷1.03 to pre-tax), and the
// rupees are summed. Two 10% codes are 20%, not 19%. Order of application therefore does not matter.
//
// Caps, per line:
//   - all order-level codes together, plus the per-line diamond cut, never exceed the line's diamond
//     (order-level codes are diamond-only, as they always were);
//   - the line's whole discount never exceeds its taxable value.
//
// STORAGE
//   custom.discount_codes  JSON [{ code, kind: 'code'|'custom', mode: 'pct'|'flat', rate }] — the list
//   custom.discount_code   comma-joined labels, display only
//   custom.discount_rate / _mode / _kind  the most recently applied code, kept for any older reader
//   custom.discount_applied  the resolved pre-tax total of EVERY cut on the draft (reprice writes it)
//
// A draft discounted before this shipped has only the single-slot fields; readDiscountCodes reads
// that slot as a one-entry list, so the next code applied stacks onto it instead of replacing it.
// ─────────────────────────────────────────

const r2 = (v) => Math.round(v * 100) / 100;

const normKind = (k) => (String(k || 'custom').toLowerCase() === 'code' ? 'code' : 'custom');
const normMode = (m) => (String(m || 'flat').toLowerCase() === 'pct' ? 'pct' : 'flat');
const sameCode = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

// One code against its own base. lines: [{ diamond, grossIncl }] — PRE-discount diamond value and
// PRE-discount tax-inclusive line total. Returns { perLine: [preTaxRs], total }, each line capped at
// its diamond.
function resolveDiscount({ kind, mode, rate, lines }) {
  const zero = { perLine: lines.map(() => 0), total: 0 };
  const r = Math.abs(parseFloat(rate) || 0);
  if (!(r > 0) || !lines.length) return zero;

  const diaTotal   = lines.reduce((s, l) => s + (l.diamond   || 0), 0);
  const grossTotal = lines.reduce((s, l) => s + (l.grossIncl || 0), 0);
  if (!(diaTotal > 0)) return zero;   // nothing to discount

  let perLine;
  if (kind === 'code') {
    // Shopify quotes a code against TAX-INCLUSIVE prices, order-wide: prorate by line total (as Shopify
    // allocates), then ÷1.03 to land each share in pre-tax rupees. The 1.03 is a unit conversion.
    const inclTotal = mode === 'pct' ? (r / 100) * grossTotal : r;
    perLine = lines.map(l => (grossTotal > 0 ? inclTotal * ((l.grossIncl || 0) / grossTotal) : 0) / 1.03);
  } else {
    // Pre-tax diamond basis → prorate by diamond value.
    const preTaxTotal = mode === 'pct' ? (r / 100) * diaTotal : r;
    perLine = lines.map(l => preTaxTotal * ((l.diamond || 0) / diaTotal));
  }

  perLine = perLine.map((d, i) => Math.min(Math.max(0, d), lines[i].diamond || 0));
  return { perLine, total: perLine.reduce((s, d) => s + d, 0) };
}

// The order-level codes on a draft, as a list. Precedence: the discount_codes list; else the legacy
// single slot (discount_rate set); else the pre-rate-migration frozen rupee figure (discount_applied
// with no rate) — but ONLY on a draft that has never carried per-line discounts or a code list. The
// reprice writes discount_applied as the total of EVERY cut, per-line included, so on any newer draft
// reading it back as a flat order-level discount would count the per-line cut twice.
function readDiscountCodes(mfMap) {
  const map = mfMap || {};
  if (map.discount_codes !== undefined && map.discount_codes !== null && String(map.discount_codes).trim() !== '') {
    let arr = [];
    try { arr = typeof map.discount_codes === 'string' ? JSON.parse(map.discount_codes) : map.discount_codes; } catch { arr = []; }
    return (Array.isArray(arr) ? arr : [])
      .map(c => ({ code: String(c?.code || '').trim(), kind: normKind(c?.kind), mode: normMode(c?.mode), rate: Math.abs(parseFloat(c?.rate) || 0) }))
      .filter(c => c.rate > 0);
  }
  const rate = parseFloat(map.discount_rate);
  if (rate > 0) {
    return [{ code: String(map.discount_code || '').trim(), kind: normKind(map.discount_kind), mode: normMode(map.discount_mode), rate }];
  }
  const legacy = Math.abs(parseFloat(map.discount_applied || 0)) || 0;
  const everPerLine = map.line_discounts !== undefined && map.line_discounts !== null;
  if (legacy > 0 && !everPerLine) return [{ code: '', kind: 'custom', mode: 'flat', rate: legacy, legacy: true }];
  return [];
}

// Every order-level code resolved and summed per line (additive), then capped at the line's diamond.
function resolveOrderCodes(codes, lines) {
  const perLine = lines.map(() => 0);
  for (const c of (codes || [])) {
    const one = resolveDiscount({ kind: c.kind, mode: c.mode, rate: c.rate, lines });
    one.perLine.forEach((d, i) => { perLine[i] += d; });
  }
  const capped = perLine.map((d, i) => Math.min(d, Math.max(0, lines[i].diamond || 0)));
  return { perLine: capped, total: capped.reduce((s, d) => s + d, 0) };
}

// One line's final cut: its per-line entries (pl, from resolveLineDiscount, or null) PLUS its share of
// the order-level codes (ol, pre-tax Rs, diamond-only). Returns { total, dia, mk, tot } in pre-tax Rs,
// with dia + mk + tot === total.
function stackLineDiscount(pl, ol, { diamond = 0, taxable = 0 } = {}) {
  const orderShare = Math.max(0, ol || 0);
  const base = pl
    ? { dia: pl.diaPortion || 0, mk: pl.mkPortion || 0, tot: pl.totalPortion || 0 }
    : { dia: 0, mk: 0, tot: 0 };
  const dia = Math.min(base.dia + orderShare, Math.max(0, diamond));
  const cap = Math.max(0, taxable);
  let total = dia + base.mk + base.tot;
  if (total <= cap) return { total, dia, mk: base.mk, tot: base.tot };
  // Over the line's taxable value: trim the whole-line cut first, then making, then diamond, so the
  // split still adds up to the capped total.
  let over = total - cap;
  const tot = Math.max(0, base.tot - over); over -= base.tot - tot;
  const mk  = Math.max(0, base.mk - over);  over -= base.mk - mk;
  const d   = Math.max(0, dia - over);
  total = d + mk + tot;
  return { total, dia: d, mk, tot };
}

// Add a code to the list. Re-applying a code already on the draft refreshes its rate rather than
// stacking it twice. Returns { codes, duplicate }.
function addCode(codes, entry) {
  // A pre-migration frozen-rupee discount becomes an ordinary flat custom entry the moment the list is
  // written, so stacking a code onto it keeps it instead of dropping it.
  const list = (codes || []).map(c => (c.legacy
    ? { code: `CUSTOM Rs${r2(c.rate)}`, kind: 'custom', mode: 'flat', rate: c.rate }
    : c));
  const e = { code: String(entry.code || '').trim(), kind: normKind(entry.kind), mode: normMode(entry.mode), rate: Math.abs(parseFloat(entry.rate) || 0) };
  const at = list.findIndex(c => c.code && sameCode(c.code, e.code));
  if (at >= 0) {
    const next = list.slice();
    next[at] = e;
    return { codes: next, duplicate: true };
  }
  return { codes: list.concat([e]), duplicate: false };
}

// Remove one code by label, or every code with 'all'. Returns { codes, removed }.
function removeCode(codes, label) {
  const list = codes || [];
  if (String(label || '').trim().toLowerCase() === 'all') return { codes: [], removed: list.length };
  const next = list.filter(c => !sameCode(c.code, label));
  return { codes: next, removed: list.length - next.length };
}

// The metafields that describe the list. `null` means "delete this key" (an empty list clears all of them).
function codeFields(codes) {
  const list = (codes || []).filter(c => !c.legacy);
  if (!list.length) {
    return { discount_codes: null, discount_code: null, discount_rate: null, discount_mode: null, discount_kind: null };
  }
  const last = list[list.length - 1];
  return {
    discount_codes: JSON.stringify(list.map(({ code, kind, mode, rate }) => ({ code, kind, mode, rate: r2(rate) }))),
    discount_code:  list.map(c => c.code).filter(Boolean).join(', '),
    discount_rate:  last.rate.toFixed(2),
    discount_mode:  last.mode,
    discount_kind:  last.kind,
  };
}

module.exports = {
  resolveDiscount, readDiscountCodes, resolveOrderCodes, stackLineDiscount, addCode, removeCode, codeFields,
};
