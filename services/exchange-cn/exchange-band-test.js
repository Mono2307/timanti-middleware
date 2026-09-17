#!/usr/bin/env node
//
// Does the logic hold when the data is complete and correctly calculated?
// =======================================================================
// This is the narrow question, asked of the band where the answer is meaningful: orders from
// #1068 on, which carry the full property schema and were priced after the discount-compounding
// bug. NO NORMALISATION is applied. Every figure is read off the order exactly as the sheet reads
// it, and every invariant is asserted on the raw data.
//
//   node services/exchange-cn/exchange-band-test.js <orders.json>
//   node services/exchange-cn/exchange-band-test.js <orders.json> --from 1051
//
// Why the band starts at #1068 and not #1067:
//
//   #1067 is the last order priced before 6b70a8e "price off the components, never off the
//   discounted price" (2026-09-16). Both pricing identities fail on it, in the same direction:
//     Taxable Value  = components − discount            → is 72,124.92, should be 75,139.92
//     Gross Value    = components × 1.03 (PRE-discount) → is 77,394.12, should be 80,499.57
//   Taxable is short by exactly one extra discount (3,015), and Gross was computed off the
//   already-discounted base. That is the compounding bug, not an exchange-calculator fault, and it
//   is fixed at source. #1067 is also the only line in the band missing Making (After Discount).
//
// Everything below #1051 is a different pricing construct again and is out of scope here — order-
// level tax-inclusive discounts divided by 1.03, no per-line discount, no before/after properties.
// See exchange-normalize-test.js for what a read-time adapter can and cannot recover from those.

'use strict';

const fs = require('fs');
const path = require('path');

const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.02;
const money = (v) => (v === null || v === undefined) ? '—' :
  (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isNaN(raw) ? null : raw;
  const n = parseFloat(String(raw).replace(/rs\.?/i, '').replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
};

const GST_RATE = 0.03;
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(__dirname, 'exchange-catalogue-snapshot.json'), 'utf8'));

// The full schema a current order carries. Absence is a finding, not a shrug.
const REQUIRED = [
  'Gold', 'Making', 'Taxable Value', 'GST', 'Gross Value', 'Discount Applied',
  'Making (After Discount)', '_net_wt', '_gold_rate',
];
// Only meaningful on a line that has a stone. #1070 is a plain chain.
const REQUIRED_IF_DIAMOND = ['Diamond', 'Diamond (After Discount)'];

const args = process.argv.slice(2);
const dumpArg = args.find((a) => !a.startsWith('--'));
const fromIdx = args.indexOf('--from');
const FROM = fromIdx !== -1 ? parseInt(args[fromIdx + 1], 10) : 1068;

const CANDIDATES = [dumpArg, path.join(__dirname, 'orders.json'),
  path.join(process.env.TEMP || '/tmp', 'orders.json')].filter(Boolean);
const dumpPath = CANDIDATES.find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
if (!dumpPath) {
  console.error('No orders dump found. Looked in:\n  ' + CANDIDATES.join('\n  '));
  process.exit(2);
}

const orders = JSON.parse(fs.readFileSync(dumpPath, 'utf8')).orders || [];

console.log('');
console.log(`Orders dump : ${dumpPath}`);
console.log(`Band        : #${FROM} and later — full schema, priced after the compounding fix`);
console.log(`Normalisation: NONE. Raw properties, read exactly as the sheet reads them.`);

let pass = 0, fail = 0;
const failures = [];
let lineCount = 0;

for (const o of orders.slice().reverse()) {
  const num = parseInt(o.name.replace('#', ''), 10);
  if (!(num >= FROM)) continue;

  o.line_items.forEach((li, idx) => {
    const p = {}; (li.properties || []).forEach((x) => { p[x.name] = x.value; });
    if (rs(p['Gold']) === null) return;                  // not priced by the engine
    lineCount++;

    const gold = rs(p['Gold']), dia = rs(p['Diamond']) || 0, making = rs(p['Making']);
    const disc = rs(p['Discount Applied']) || 0, gst = rs(p['GST']);
    const diaPaid = rs(p['Diamond (After Discount)']);
    const taxable = rs(p['Taxable Value']), gross = rs(p['Gross Value']);
    const netWt = rs(p['_net_wt']);
    const comps = r2(gold + dia + making);

    const cat = CATALOGUE[String(li.variant_id)] || {};
    const liveDia = cat.dia === null || cat.dia === undefined ? 0 : cat.dia;
    const liveRate = cat.rate;

    // The line's own tax-inclusive total.
    const alloc = ((li.discount_allocations) || []).reduce((a, d) => a + parseFloat(d.amount || 0), 0);
    const invoice = r2(parseFloat(li.price) - (alloc || parseFloat(li.total_discount || 0) || 0));

    const tag = `${o.name}/${idx}`;
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    // ── A. Is the data actually complete? ────────────────────────────────────────
    const missing = REQUIRED.filter((k) => p[k] === undefined || p[k] === '');
    if (dia > 0 || p['Diamond'] !== undefined) {
      REQUIRED_IF_DIAMOND.forEach((k) => { if (p[k] === undefined || p[k] === '') missing.push(k); });
    }
    add('every schema property present', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED.length + (dia > 0 ? 2 : 0)} properties`);

    // ── B. Is the pricing internally consistent? ─────────────────────────────────
    add('Taxable Value = components − discount', near(taxable, r2(comps - disc)),
      `${money(taxable)} vs ${money(r2(comps - disc))}`);
    add('Gross Value = components × 1.03', near(gross, r2(comps * 1.03)),
      `${money(gross)} vs ${money(r2(comps * 1.03))}`);
    add('GST = 3% of taxable', near(gst, r2(taxable * GST_RATE)),
      `${money(gst)} vs ${money(r2(taxable * GST_RATE))}`);
    add('invoice = taxable + GST', near(invoice, r2(taxable + gst)),
      `${money(invoice)} vs ${money(r2(taxable + gst))}`);

    // ── C. Does the PAID column foot? (column B) ─────────────────────────────────
    const paidTotal = r2(comps - disc + gst);
    add('paid column foots to the invoice', near(paidTotal, invoice),
      `${money(paidTotal)} vs ${money(invoice)}`);

    // ── D. Is the cap sound? ─────────────────────────────────────────────────────
    add('cap (Diamond After Discount) is present', diaPaid !== null,
      diaPaid === null ? 'absent — leg would be uncapped' : money(diaPaid));
    if (diaPaid !== null) {
      add('cap never exceeds the diamond as charged', diaPaid <= dia + 0.005,
        `${money(diaPaid)} vs ${money(dia)}`);
      const absorbedByMaking = r2(making - (rs(p['Making (After Discount)']) || 0));
      add('discount fully accounted for across diamond + making',
        near(r2((dia - diaPaid) + absorbedByMaking), disc),
        `stone took ${money(r2(dia - diaPaid))}, making took ${money(absorbedByMaking)}, ` +
        `discount was ${money(disc)}`);
    }

    // ── E. The DEDUCTION column (column C) ───────────────────────────────────────
    const haircut = r2(liveDia * 0.8);
    const diaLeg = diaPaid === null ? haircut : Math.min(haircut, diaPaid);
    const goldLeg = netWt === null ? 0 : r2(netWt * liveRate);
    const dedNet = r2(goldLeg + diaLeg);

    add('gold leg computable', netWt !== null && liveRate !== undefined,
      netWt === null ? 'no _net_wt' : `${netWt}g × ${money(liveRate)}`);
    // Independent cross-check: the catalogue computed price_breakup_gold from the same two numbers.
    add('gold leg matches custom.price_breakup_gold', near(goldLeg, cat.gold),
      `sheet ${money(goldLeg)} vs catalogue ${money(cat.gold)}`);
    add('diamond leg never exceeds what the stone cost',
      diaPaid === null ? true : diaLeg <= diaPaid + 0.005,
      `leg ${money(diaLeg)} vs stone ${money(diaPaid)}`);
    add('Deduction credit does not exceed the invoice', dedNet <= invoice + 0.005,
      `${money(dedNet)} vs ${money(invoice)}`);

    // ── F. The FULL VALUE column ─────────────────────────────────────────────────
    // Every row mirrors column B, so its NET is the paid total. It must equal the invoice exactly.
    add('Full Value NET equals the invoice', near(paidTotal, invoice),
      `${money(paidTotal)} vs ${money(invoice)}`);

    const bad = checks.filter((c) => !c.ok);
    console.log('');
    console.log(`${tag}  ${o.created_at.slice(0, 10)}  ${li.title.slice(0, 44)}`);
    console.log(`    paid ${money(invoice)}   |   Deduction ${money(dedNet)} ` +
                `(gold ${money(goldLeg)} + diamond ${money(diaLeg)})   |   Full Value ${money(paidTotal)}`);
    checks.forEach((c) => {
      if (c.ok) { pass++; console.log(`      PASS  ${c.name}  (${c.detail})`); }
      else { fail++; failures.push(`${tag}: ${c.name} — ${c.detail}`); console.log(`      FAIL  ${c.name}  (${c.detail})`); }
    });
    if (!bad.length) { /* all good */ }
  });
}

console.log('');
console.log('='.repeat(96));
console.log(`  BAND #${FROM}+   ${lineCount} line item(s)   ${pass} passed, ${fail} failed`);
if (failures.length) { console.log(''); failures.forEach((f) => console.log('  FAIL  ' + f)); }
else {
  console.log('');
  console.log('  Every invariant holds on raw, un-normalised data.');
  console.log('  The calculator logic is sound where the schema is complete.');
}
console.log('='.repeat(96));
process.exit(fail ? 1 : 0);
