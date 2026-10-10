'use strict';


const GROSS_PROP = 'Gross Value';
const TAX_MULT   = 1.03;  
const r2 = (v) => Math.round(v * 100) / 100;


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

function preTaxBase(item, recalc) {
  if (recalc && Number.isFinite(recalc.newPreTaxGross) && recalc.newPreTaxGross > 0) {
    return { base: r2(recalc.newPreTaxGross), source: 'components' };
  }
  const gross = rupees(propsOf(item)[GROSS_PROP]);
  if (gross > 0) return { base: r2(gross / TAX_MULT), source: 'gross-prop' };
  const price = parseFloat(item && item.price);
  return { base: r2((Number.isFinite(price) ? price : 0) * (item.quantity || 1) / TAX_MULT), source: 'price' };
}

const AUTO_DIAMOND_TIERS = [
  { upTo: 20, discountPct: 5  },
  { upTo: 40, discountPct: 10 },
  { upTo: 60, discountPct: 15 },
  { upTo: 80, discountPct: 20 },
];

const AUTO_STACKS_WITH_MANUAL = true;

function diamondShare(diamond, base) {
  if (!(base > 0) || !(diamond > 0)) return 0;
  return r2((diamond / base) * 100);
}
function autoDiamondDiscount({ diamond = 0, base = 0, alreadyOnDiamond = 0 } = {}) {
  const share = diamondShare(diamond, base);
  const tier  = share > 0 ? AUTO_DIAMOND_TIERS.find((t) => share <= t.upTo) : null;
  const pct   = tier ? tier.discountPct : 0;
  const room  = Math.max(0, diamond - Math.max(0, alreadyOnDiamond));
  const amount = r2(Math.min(diamond * (pct / 100), room));
  return { share, pct, amount };
}
function addAutoDiamond(d, { enabled = true, diamond = 0, base = 0 } = {}) {
  const none = { ...d, auto: 0 };
  if (!enabled) return none;
  if (!AUTO_STACKS_WITH_MANUAL && d.total > 0) return none;
  const a   = autoDiamondDiscount({ diamond, base, alreadyOnDiamond: d.dia });
  // Never take the line below zero, even beside a whole-line (native) discount.
  const add = r2(Math.min(a.amount, Math.max(0, base - d.total)));
  if (!(add > 0)) return none;
  return { total: r2(d.total + add), dia: r2(d.dia + add), mk: d.mk, tot: d.tot, auto: add };
}

module.exports = {
  preTaxBase, rupees, GROSS_PROP, TAX_MULT,
  autoDiamondDiscount, addAutoDiamond, diamondShare, AUTO_DIAMOND_TIERS, AUTO_STACKS_WITH_MANUAL,
};
