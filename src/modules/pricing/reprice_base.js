'use strict';

/**
 * The BASE a reprice prices off — the line's pre-tax, PRE-DISCOUNT value.
 *
 * WHY THIS FILE EXISTS
 * The no-weights reprice branch used to infer the base from the line's current price
 * (`price / 1.03`). That is the price AFTER the last run took the discount off, so re-running the
 * engine subtracted the same discount from a base that already had it subtracted, and every pass
 * cut the line again. #D218 lost Rs2,379.30 on one line per reprice — a 2,310 discount plus its 3%
 * GST — while `Discount Applied` sat unchanged at 2,310, so nothing about the line looked wrong.
 *
 * It stayed invisible for two months because without a discount the old base is a true no-op:
 * price / 1.03 * 1.03 is the price again. It became lossy only when per-line discounts landed.
 *
 * The rule here: NEVER derive the base from the current price. Build it bottom-up from the
 * components (gold + diamond + making + gemstone), and where a line cannot be rebuilt, read the
 * pre-discount figure the previous run already recorded in the `Gross Value` prop. Both are
 * discount-free by construction, so repricing twice lands on the same number.
 *
 * Rounding deliberately mirrors the engine's own `r2` (Math.round, half-up on positives) rather
 * than core/tax's epsilon-nudged one. A base that rounds differently from the Gross Value it is
 * read back out of would drift a paisa per reprice — small, but the same class of bug.
 */

const GROSS_PROP = 'Gross Value';
const TAX_MULT   = 1.03;   // jewellery GST, tax-inclusive convention — see core/tax.js

const r2 = (v) => Math.round(v * 100) / 100;

/** "Rs1,234.56" → 1234.56. Anything unparseable → 0. */
function rupees(value) {
  if (value == null) return 0;
  const n = parseFloat(String(value).replace(/Rs/i, '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function propsOf(item) {
  const out = {};
  for (const p of (item && item.properties) || []) out[p.name] = p.value;
  return out;
}

/**
 * The pre-tax, pre-discount base for one line, and where it came from.
 *
 * `recalc` is the component rebuild for this line ({ newPreTaxGross }) or null when the line
 * carries no usable gold figure. `source` is returned for the log line and the tests — a line
 * falling through to 'price' is the case worth knowing about, because it is the only one left that
 * cannot prove it is discount-free.
 */
function preTaxBase(item, recalc) {
  if (recalc && Number.isFinite(recalc.newPreTaxGross) && recalc.newPreTaxGross > 0) {
    return { base: r2(recalc.newPreTaxGross), source: 'components' };
  }
  // Recorded by the previous run as the PRE-discount, tax-inclusive line value. Reading it back is
  // what keeps an unrebuildable line stable instead of compounding.
  const gross = rupees(propsOf(item)[GROSS_PROP]);
  if (gross > 0) return { base: r2(gross / TAX_MULT), source: 'gross-prop' };
  // Last resort: a line the engine has never priced, so there is no discount baked into its price
  // to subtract twice. The filter in handleRecalculatePriceTag admits a line only with a Gold prop
  // or a variant_id, so in practice one of the two branches above answers first.
  const price = parseFloat(item && item.price);
  return { base: r2((Number.isFinite(price) ? price : 0) * (item.quantity || 1) / TAX_MULT), source: 'price' };
}

module.exports = { preTaxBase, rupees, GROSS_PROP, TAX_MULT };
