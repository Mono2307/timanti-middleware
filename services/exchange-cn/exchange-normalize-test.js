#!/usr/bin/env node
//
// Does the calculator logic hold under DATA PARITY?
// ================================================
// The hypothesis under test: the exchange calculator is correct, and every defect found on live
// orders is a DATA defect caused by line-item properties being added to the pricing engine over
// time rather than all at once. If that is true, then normalising every order to the schema a
// current order carries should make every invariant pass — without touching the calculator.
//
//   node services/exchange-cn/exchange-normalize-test.js            full report
//   node services/exchange-cn/exchange-normalize-test.js --quiet     summary only
//
// It needs a dump of the orders. Fetch once, then run offline as often as you like:
//   curl -s -H "X-Shopify-Access-Token: $TOK" \
//     "https://auracarat.myshopify.com/admin/api/2026-07/orders.json?status=any&limit=250" \
//     -o orders.json
//   node services/exchange-cn/exchange-normalize-test.js ./orders.json
//
// NOTHING HERE WRITES TO SHOPIFY. It cannot: line-item properties are immutable on an existing
// order (PUT with modified line_items returns 200 and changes nothing). Normalisation is therefore
// a READ-TIME adapter — which is also why it is safe to develop against live data.

'use strict';

const fs = require('fs');
const path = require('path');

const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, tol) => Math.abs(a - b) < (tol === undefined ? 0.02 : tol);
const money = (v) => (v === null || v === undefined) ? '—' :
  (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Parses "Rs48000.00" / "48,000" / 48000. null when there is nothing to parse, so a missing
// property stays distinguishable from a genuine zero. Mirrors rsProp_ in the Apps Script.
const rs = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isNaN(raw) ? null : raw;
  const n = parseFloat(String(raw).replace(/rs\.?/i, '').replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
};

const GST_RATE = 0.03;   // every line in the store reconciles at 3%

// Net weights recovered from variant metafields for lines that never recorded _net_wt. Kept as a
// sidecar rather than fetched, so this test needs no token and no network.
let RECOVERED_WT = {};
try {
  RECOVERED_WT = JSON.parse(fs.readFileSync(path.join(__dirname, 'exchange-netwt-recovered.json'), 'utf8'));
} catch (e) { /* optional — the test still runs, those lines just stay unrecovered */ }

// ── THE CANONICAL SCHEMA ─────────────────────────────────────────────────────────
// What a CURRENT order (#1069, #1072, #1073) carries. Everything older is missing some of it.
//
//   gold, dia, making          components, PRE-discount
//   disc                       Discount Applied
//   diaPaid, makingPaid        the same components AFTER discount — diaPaid is the cap
//   gst                        GST as charged
//   netWt, goldRate            _net_wt, _gold_rate
//   invoice                    the line's own tax-inclusive total
//
// ── THE NORMALISER ───────────────────────────────────────────────────────────────
// Read-time only. Each rule states what it recovers and from what. A rule that cannot recover a
// value returns a reason instead of guessing — a guessed cap under-credits a real customer, which
// is the whole reason paidComponents_ refuses to reconstruct one.
function normalise_(li, lineInvoice) {
  const p = {};
  (li.properties || []).forEach((x) => { p[x.name] = x.value; });

  const raw = {
    gold:       rs(p['Gold']),
    dia:        rs(p['Diamond']),
    making:     rs(p['Making'] !== undefined ? p['Making'] : p['Making Charges']),
    disc:       rs(p['Discount Applied']),
    gst:        rs(p['GST']),
    diaPaid:    rs(p['Diamond (After Discount)']),
    makingPaid: rs(p['Making (After Discount)']),
    taxable:    rs(p['Taxable Value']),
    gross:      rs(p['Gross Value']),
    netWt:      rs(p['_net_wt']),
    goldRate:   rs(p['_gold_rate']),
  };

  const fixes = [];
  const n = Object.assign({}, raw);
  n.disc = n.disc || 0;

  const comps = r2((n.gold || 0) + (n.dia || 0) + (n.making || 0));

  // RULE 1 — recover a missing GST.
  // On a tax-inclusive store Shopify writes no tax_lines, so a missing GST property leaves the row
  // blank and the paid column short by exactly the tax. Recoverable two ways, both exact.
  if (n.gst === null) {
    if (raw.gross !== null && raw.taxable !== null) {
      n.gst = r2(raw.gross - raw.taxable - n.disc);
      fixes.push('GST recovered from Gross − Taxable − Discount');
    } else {
      // The taxable base is the components as recorded, whichever era they are from — that is what
      // the 3% was charged on. Verified against every line in the store.
      n.gst = r2(comps * GST_RATE);
      fixes.push('GST recovered as 3% of the components');
    }
  }

  // RULE 2 — decide which era the components belong to, by asking which reading foots.
  // This is the whole inconsistency in one test. No order states its own era, so it is inferred
  // from the only thing that cannot lie: the amount the customer was actually charged.
  const asPost = r2(comps + n.gst);              // components already net of the discount
  const asPre  = r2(comps - n.disc + n.gst);     // components gross, discount its own row
  if (near(asPost, lineInvoice) && near(asPre, lineInvoice)) n.era = 'either';   // disc == 0
  else if (near(asPost, lineInvoice))                        n.era = 'post';
  else if (near(asPre,  lineInvoice))                        n.era = 'pre';
  else                                                       n.era = 'unreconciled';

  // RULE 3 — recover the cap, `Diamond (After Discount)`.
  // Three of the four routes are exact. The fourth is refused on purpose.
  if (n.diaPaid === null) {
    if (n.disc === 0) {
      n.diaPaid = n.dia;
      fixes.push('cap = Diamond (no discount on this line)');
    } else if (n.era === 'post') {
      // The components are ALREADY net of the discount, so the Diamond property IS the after-
      // discount figure. Nothing to compute — it was there all along under a different meaning.
      n.diaPaid = n.dia;
      fixes.push('cap = Diamond (components are already post-discount)');
    } else if (n.era === 'pre' && n.makingPaid !== null && n.making !== null) {
      // We know what making absorbed, so the rest came off the stone. Exact, not a guess.
      const absorbedByMaking = r2(n.making - n.makingPaid);
      n.diaPaid = r2(n.dia - (n.disc - absorbedByMaking));
      fixes.push('cap = Diamond − (discount not absorbed by making)');
    } else {
      n.capUnknown = 'pre-discount components, a real discount, and no record of how it was split';
    }
  }

  // RULE 4 — normalise the components to PRE-discount, so both eras mean the same thing.
  // On a post-discount line the split across gold/diamond/making is unrecoverable, but the
  // calculator never needs it: Deduction reads only netWt and the cap, and Full Value needs the
  // column to FOOT. So the discount row is dropped to zero and the components stand as charged.
  if (n.era === 'post' && n.disc > 0) {
    n.discRow = 0;
    fixes.push('discount row zeroed — it is already inside the components');
  } else {
    n.discRow = n.disc;
  }

  // RULE 5 — recover a missing net weight from the catalogue's own arithmetic.
  // Cannot be done from the order alone. The variant knows it though: custom.price_breakup_gold is
  // custom.gold_rate × the weight, so the weight is their quotient, and the rate cancels out — it
  // does not matter that today's rate differs from the one locked at purchase. Pre-computed into
  // exchange-netwt-recovered.json so this test runs offline.
  if (n.netWt === null) {
    const rec = RECOVERED_WT[String(li.variant_id)];
    if (rec && rec.netWt) {
      n.netWt = rec.netWt;
      fixes.push('net wt = price_breakup_gold ÷ gold_rate on the variant');
    } else {
      n.wtUnknown = rec ? ('variant has no price_breakup metafields either — ' + (rec.note || ''))
                        : 'no _net_wt on the line and the variant was not sampled';
    }
  }

  n.comps = comps;
  n.invoice = lineInvoice;
  n.fixes = fixes;
  n.raw = raw;            // the untouched properties, so the BEFORE column reports the real state
  return n;
}

// ── THE INVARIANTS, RUN ON THE NORMALISED RECORD ─────────────────────────────────
// Same questions the scenario harness asks, but now over every diamond line in the store.
function invariants_(n) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });

  // 1. The paid column foots to what the customer was charged.
  const paidTotal = r2(n.comps - n.discRow + n.gst);
  add('paid column foots', near(paidTotal, n.invoice),
    `${money(paidTotal)} vs ${money(n.invoice)}`);

  // 2. There is a cap at all. This is the one that decides whether a credit can be trusted.
  add('cap is known', !n.capUnknown, n.capUnknown || `cap = ${money(n.diaPaid)}`);

  // 3. The cap never exceeds what the stone cost. Vacuous where we derived it FROM the stone, but
  //    it catches a derivation that went wrong.
  if (!n.capUnknown && n.dia !== null) {
    add('cap ≤ diamond as recorded', n.diaPaid <= n.dia + 0.005,
      `${money(n.diaPaid)} vs ${money(n.dia)}`);
  }

  // 4. The gold leg is computable. Without a net weight the leg silently reads zero, which looks
  //    like a deliberate value rather than missing data.
  add('gold leg computable', !n.wtUnknown, n.wtUnknown || `net wt ${n.netWt}g`);

  return out;
}

// ── RUN ──────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const dumpArg = args.find((a) => !a.startsWith('--'));

const CANDIDATES = [
  dumpArg,
  path.join(__dirname, 'orders.json'),
  path.join(process.env.TEMP || '/tmp', 'orders.json'),
].filter(Boolean);

const dumpPath = CANDIDATES.find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
if (!dumpPath) {
  console.error('No orders dump found. Looked in:\n  ' + CANDIDATES.join('\n  ') +
                '\n\nFetch one with the curl in the header comment, then pass its path.');
  process.exit(2);
}

const orders = JSON.parse(fs.readFileSync(dumpPath, 'utf8')).orders || [];
console.log(`Orders dump: ${dumpPath}`);
console.log(`Orders: ${orders.length}\n`);

const lines = [];
for (const o of orders) {
  for (const li of o.line_items) {
    const p = {}; (li.properties || []).forEach((x) => { p[x.name] = x.value; });
    if (rs(p['Diamond']) === null) continue;              // not priced by the engine — skip
    // The line's own tax-inclusive total. li.price is before any allocated order-level discount.
    const alloc = ((li.discount_allocations) || []).reduce((a, d) => a + parseFloat(d.amount || 0), 0);
    const fallback = parseFloat(li.total_discount || 0);
    const lineInvoice = r2(parseFloat(li.price) - (alloc || fallback || 0));
    lines.push({ order: o.name, date: o.created_at.slice(0, 10), n: normalise_(li, lineInvoice) });
  }
}

let before = { foot: 0, cap: 0, wt: 0 }, after = { foot: 0, cap: 0, wt: 0 };
const unresolved = [];

if (!quiet) {
  console.log('ORDER    DATE       ERA           CAP BEFORE   CAP AFTER    RECOVERED BY');
  console.log('-'.repeat(104));
}

for (const L of lines) {
  const n = L.n;
  const recoveredCap = n.fixes.find((f) => f.startsWith('cap '));

  // Before-normalisation state, i.e. exactly what the sheet does today: the raw properties, the
  // discount always subtracted, a missing GST left blank, and no cap unless the order carried one.
  const hadCap = n.raw.diaPaid !== null;
  const rawFoots = near(r2(n.comps - (n.raw.disc || 0) + (n.raw.gst || 0)), n.invoice);
  if (rawFoots) before.foot++;
  if (hadCap) before.cap++;
  if (n.raw.netWt !== null) before.wt++;

  const inv = invariants_(n);
  const byName = Object.fromEntries(inv.map((c) => [c.name, c]));
  if (byName['paid column foots'].ok) after.foot++;
  if (byName['cap is known'].ok) after.cap++;
  if (byName['gold leg computable'].ok) after.wt++;

  const failed = inv.filter((c) => !c.ok);
  if (failed.length) unresolved.push({ L, failed });

  if (!quiet) {
    console.log(
      `${L.order.padEnd(8)} ${L.date} ${String(n.era).padEnd(13)} ` +
      `${(hadCap ? money(n.diaPaid) : 'NONE').padStart(11)}  ` +
      `${(n.capUnknown ? 'STILL NONE' : money(n.diaPaid)).padStart(11)}  ` +
      `${recoveredCap || (hadCap ? 'already present' : '')}`);
  }
}

const pct = (a, b) => b ? ((a / b) * 100).toFixed(0) + '%' : '—';
console.log('');
console.log('='.repeat(104));
console.log(`  DIAMOND LINE ITEMS: ${lines.length}\n`);
console.log('  INVARIANT                      BEFORE NORMALISING      AFTER NORMALISING');
console.log('  ' + '-'.repeat(76));
console.log(`  paid column foots              ${String(before.foot + '/' + lines.length).padEnd(8)} ${pct(before.foot, lines.length).padEnd(13)} ${String(after.foot + '/' + lines.length).padEnd(8)} ${pct(after.foot, lines.length)}`);
console.log(`  diamond cap is known           ${String(before.cap + '/' + lines.length).padEnd(8)} ${pct(before.cap, lines.length).padEnd(13)} ${String(after.cap + '/' + lines.length).padEnd(8)} ${pct(after.cap, lines.length)}`);
console.log(`  gold leg computable            ${String(before.wt + '/' + lines.length).padEnd(8)} ${pct(before.wt, lines.length).padEnd(13)} ${String(after.wt + '/' + lines.length).padEnd(8)} ${pct(after.wt, lines.length)}`);

if (unresolved.length) {
  console.log('');
  console.log(`  NOT RECOVERABLE BY NORMALISATION — ${unresolved.length} line item(s):`);
  for (const u of unresolved) {
    console.log(`    ${u.L.order} (${u.L.date}, era=${u.L.n.era})`);
    u.failed.forEach((f) => console.log(`        ${f.name}: ${f.detail}`));
  }
  console.log('');
  console.log('  These are genuine data loss or genuine corruption, not schema drift. No read-time');
  console.log('  rule can recover them, because the information was never recorded.');
} else {
  console.log('\n  Every line item normalises cleanly.');
}
console.log('='.repeat(104));
