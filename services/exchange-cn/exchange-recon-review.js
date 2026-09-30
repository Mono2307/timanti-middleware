#!/usr/bin/env node
//
// Exchange recon review — what the sheet will do with every line ever sold
// ========================================================================
// Loads the Apps Script itself (EXCHANGE-CALCULATOR-FULL.gs.txt) into a sandbox and runs its own
// resolveExchangeUnit_ over every order line in exchange-orders-snapshot.json against the live
// catalogue in exchange-catalogue-live.json. So this table is not a description of the sheet's
// rules — it is the sheet's output. Change the rules in the .gs file and this changes with them.
//
//   node services/exchange-cn/exchange-recon-review.js            write the CSV + print a summary
//   node services/exchange-cn/exchange-recon-review.js --check    also fail (exit 1) on any invariant breach
//   node services/exchange-cn/exchange-recon-review.js #1045      print one order in full
//
// DEVELOPER TOOL ONLY. The sheet never reads this file or its CSV; nobody at the counter runs it.
//
// Output: exchange-legacy-recon.csv — one row per order line, per PIECE figures.
//
// Deduction figures use the catalogue snapshot's date, not today. The diamond price and gold rate
// move; what cannot move is whether a line is allowed, capped, and where each input came from.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const GS = path.join(DIR, 'EXCHANGE-CALCULATOR-FULL.gs.txt');

// ── Load the Apps Script. Only its top-level declarations run; nothing touches SpreadsheetApp until
// a function is called, and we call only the pure resolver.
const sandbox = { console, Logger: { log() {} } };
vm.createContext(sandbox);
const src = fs.readFileSync(GS, 'utf8')
  // top-level const/let are not visible on the context object — expose the ones we need
  + '\n;this.__x = { resolveExchangeUnit_, aggregateExchangeUnits_, exchangeIssuesFor_ };';
vm.runInContext(src, sandbox, { filename: 'EXCHANGE-CALCULATOR-FULL.gs.txt' });
const { resolveExchangeUnit_, exchangeIssuesFor_ } = sandbox.__x;

const snap = JSON.parse(fs.readFileSync(path.join(DIR, 'exchange-orders-snapshot.json'), 'utf8'));
const cat = JSON.parse(fs.readFileSync(path.join(DIR, 'exchange-catalogue-live.json'), 'utf8'));
const rates = cat._gold_rate_config;

function liveFor(li) {
  if (!li.variant_id) return { status: 'none' };
  const v = cat.variants[String(li.variant_id)];
  if (!v) return { status: 'error', code: 'not in snapshot' };
  if (v.status !== 'ok') return { status: v.status, code: v.code };
  return { status: 'ok', variant: v.variant };
}

const args = process.argv.slice(2);
const only = args.find((a) => /^#?\d{4}$/.test(a));
const check = args.includes('--check');

const rows = [];
for (const o of snap.orders.slice().reverse()) {
  if (only && o.name !== (only.startsWith('#') ? only : '#' + only)) continue;
  for (const li of o.line_items) {
    const u = resolveExchangeUnit_(o, li, liveFor(li), rates);
    rows.push(u);
  }
}

const verdict = (u, full) => {
  const x = exchangeIssuesFor_(u.issues, full);
  if (x.blocks.length) return 'BLOCKED';
  if (x.confirms.length) return 'CONFIRM';
  return 'OK';
};

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────
const cols = [
  ['order', (u) => u.order], ['line_id', (u) => u.lineId], ['item', (u) => u.title], ['sku', (u) => u.sku],
  ['qty', (u) => u.qty], ['karat', (u) => u.karat], ['era', (u) => u.era],
  ['paid_gold', (u) => u.paid.gold], ['paid_diamond', (u) => u.paid.dia], ['paid_making', (u) => u.paid.making],
  ['paid_discount_row', (u) => u.paid.disc], ['paid_gst', (u) => u.paid.tax], ['gst_source', (u) => u.paid.gstSource],
  ['paid_total', (u) => u.paid.total], ['invoice_per_piece', (u) => u.invoice],
  ['stone_paid_cap', (u) => u.cap], ['cap_source', (u) => u.capSource],
  ['net_wt', (u) => u.netWt], ['net_wt_source', (u) => u.netWtSource],
  ['rate_today', (u) => u.rate], ['live_diamond', (u) => u.liveDia], ['live_diamond_source', (u) => u.liveDiaSource],
  ['gold_leg', (u) => u.goldLeg], ['diamond_leg', (u) => u.diaLeg],
  ['deduction', (u) => u.deduction], ['deduction_verdict', (u) => verdict(u, false)],
  ['full_value', (u) => u.fullValue], ['full_value_verdict', (u) => verdict(u, true)],
  ['blocks', (u) => u.issues.filter((i) => i.level === 'block').map((i) => `[${i.scope}] ${i.msg}`).join(' || ')],
  ['confirms', (u) => u.issues.filter((i) => i.level === 'confirm').map((i) => `[${i.scope}] ${i.msg}`).join(' || ')],
  ['info', (u) => u.issues.filter((i) => i.level === 'info').map((i) => `[${i.scope}] ${i.msg}`).join(' || ')],
];
const q = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
if (!only) {
  const out = [cols.map((c) => c[0]).join(',')].concat(rows.map((u) => cols.map((c) => q(c[1](u))).join(',')));
  fs.writeFileSync(path.join(DIR, 'exchange-legacy-recon.csv'), out.join('\n') + '\n');
}

// ── INVARIANTS — the properties that make an amount safe to issue ────────────────────────────────
const breaches = [];
const breach = (u, msg) => breaches.push(`${u.order}/${u.lineId} ${u.sku || u.title}: ${msg}`);
for (const u of rows) {
  const dedOk = verdict(u, false) !== 'BLOCKED';
  const fullOk = verdict(u, true) !== 'BLOCKED';
  if (dedOk) {
    if (u.deduction === null || !(u.deduction >= 0)) breach(u, 'Deduction allowed but no amount');
    if (u.metal === 'gold' && !(u.netWt > 0)) breach(u, 'Deduction allowed with no weight');
    if (u.metal === 'gold' && !(u.rate > 0)) breach(u, 'Deduction allowed with no rate');
    if (u.hasStones && u.cap === null) breach(u, 'Deduction allowed with an uncapped diamond');
    if (u.cap !== null && u.diaLeg > u.cap + 0.005) breach(u, `diamond leg ${u.diaLeg} exceeds the stone paid ${u.cap}`);
    if (u.deductionLimit != null && u.deduction > u.deductionLimit + 0.005) breach(u, `deduction ${u.deduction} above its limit ${u.deductionLimit}`);
    if (u.cap !== null && u.paid.dia !== null && u.cap > u.paid.dia + 0.005) breach(u, `cap ${u.cap} exceeds the diamond charged ${u.paid.dia}`);
  }
  if (fullOk) {
    if (!(u.fullValue > 0)) breach(u, 'Full Value allowed with no amount');
    if (Math.abs(u.fullValue - u.invoice) > 0.005) breach(u, 'Full Value differs from the invoice');
  }
  const o = snap.orders.find((x) => x.name === u.order);
  const hard = /test orders/.test(o.tags) || o.cancelled_at || /refunded|voided/.test(o.financial_status) ||
               /(^|, )(returned|exc-given)(,|$)/.test(o.tags);
  if (hard && (dedOk || fullOk)) breach(u, 'order is test/cancelled/refunded/returned/exchanged but an amount is allowed');
}

// ── REPORT ───────────────────────────────────────────────────────────────────────────────────────
const money = (v) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
if (only) {
  for (const u of rows) {
    console.log(`\n${u.order} line ${u.lineId}  ${u.title}  (${u.sku})  qty ${u.qty}  era ${u.era}`);
    console.log(`  paid/piece  gold ${money(u.paid.gold)}  diamond ${money(u.paid.dia)}  making ${money(u.paid.making)}  disc row ${money(u.paid.disc)}  gst ${money(u.paid.tax)} (${u.paid.gstSource})  = ${money(u.paid.total)}  invoice ${money(u.invoice)}`);
    console.log(`  weight ${u.netWt} g  [${u.netWtSource || 'none'}]   rate ${money(u.rate)}  [${u.rateSource || 'none'}]`);
    console.log(`  diamond live ${money(u.liveDia)} [${u.liveDiaSource}]  cap ${money(u.cap)} [${u.capSource || 'none'}]`);
    console.log(`  DEDUCTION ${money(u.deduction)} (gold ${money(u.goldLeg)} + diamond ${money(u.diaLeg)})  → ${verdict(u, false)}`);
    console.log(`  FULL VALUE ${money(u.fullValue)}  → ${verdict(u, true)}`);
    for (const i of u.issues) console.log(`    ${i.level.toUpperCase().padEnd(7)} [${i.scope}] ${i.msg}`);
  }
} else {
  const real = rows.filter((u) => !/test orders/.test(snap.orders.find((o) => o.name === u.order).tags));
  const tally = (full) => real.reduce((a, u) => { const v = verdict(u, full); a[v] = (a[v] || 0) + 1; return a; }, {});
  console.log(`\nLines: ${rows.length} (${real.length} real sales, ${rows.length - real.length} test)`);
  console.log('Real lines — Deduction :', JSON.stringify(tally(false)));
  console.log('Real lines — Full Value:', JSON.stringify(tally(true)));
  console.log('\nORDER  ITEM                                  DEDUCTION        VERDICT   FULL VALUE       VERDICT');
  for (const u of real) {
    console.log(`${u.order}  ${(u.title || '').slice(0, 36).padEnd(36)}  ${money(u.deduction).padStart(14)}  ${verdict(u, false).padEnd(8)}  ${money(u.fullValue).padStart(14)}  ${verdict(u, true)}`);
  }
  console.log('\nWrote exchange-legacy-recon.csv');
}
if (breaches.length) {
  console.log(`\nINVARIANT BREACHES: ${breaches.length}`);
  breaches.forEach((b) => console.log('  ✗ ' + b));
} else {
  console.log(`\nInvariants: all hold on ${rows.length} lines.`);
}
process.exit(check && breaches.length ? 1 : 0);
