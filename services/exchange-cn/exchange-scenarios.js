#!/usr/bin/env node
//
// Exchange calculator — scenario harness
// ======================================
// Renders the BEFORE / AFTER table exactly as the sheet builds it, for a matrix of scenarios,
// and asserts the invariants that make the numbers trustworthy.
//
//   node services/exchange-cn/exchange-scenarios.js            all scenarios + checks
//   node services/exchange-cn/exchange-scenarios.js --quiet    summary only
//   node services/exchange-cn/exchange-scenarios.js --real     only the real-order scenarios
//   node services/exchange-cn/exchange-scenarios.js 4          one scenario by number
//
// The functions below MIRROR the Apps Script. If you change either side, change both:
//   paidColumn_      ← paidComponents_ + writePaidColumn_   (column B)
//   exchangeColumn_  ← refreshExchangeColumn_               (column C)
//   valueToIssue_    ← the VALUE TO ISSUE writer            (C52)
// Everything else here is presentation and assertions.
//
// See DIAMOND_CAP_EXPLAINED.md for the reasoning behind the diamond leg.
//
// ── SYNTHETIC vs REAL ────────────────────────────────────────────────────────────
// Scenarios 1-7 are SYNTHETIC. They hold the catalogue flat and move one variable at a time, which
// is the only way to see the cap mechanics on their own. Their invoiceTotal is DERIVED from their
// own components, so the footing check on them is near-tautological and proves little.
//
// Scenarios 8+ are REAL, pulled from the Timanti store (auracarat.myshopify.com) on 2026-09-17.
// Every figure is quoted from the API — line-item properties for the paid column, variant
// metafields (custom.price_breakup_diamond / custom.gold_rate) for today's catalogue — and
// invoiceTotal is the order's own total_price, STATED, never derived. That is what makes the
// footing check on them mean something, and three of them fail it. Those failures are declared
// via expectFoot so the harness stays green on KNOWN breakage and goes red the moment it changes.

'use strict';

const r2 = (n) => Math.round(n * 100) / 100;
const BLANK = null;                    // a blank cell — deliberately NOT zero. See note below.

// ── COLUMN B — PAID AT ORDER ─────────────────────────────────────────────────────
// The Rs-prefixed line-item properties frozen at purchase. `dia` is taken as PRE-discount and the
// discount is its own row, held NEGATIVE because it reduced the invoice. Gemstone is always blank:
// the pricing engine knows only gold, diamond and making, so there is no gemstone money anywhere.
//
// NOTE the word "taken as". paidComponents_ ASSUMES Gold/Diamond/Making are pre-discount. On orders
// up to #1047 (April 2026) they are already NET of the discount, so subtracting it again
// double-counts. Scenarios 12-13 are real instances. This mirror reproduces the bug rather than
// fixing it, because the harness's job is to describe the sheet as it actually behaves.
function paidColumn_(s) {
  const rows = {
    gold:   s.gold   !== undefined ? s.gold   : BLANK,
    dia:    s.dia,
    gem:    BLANK,
    making: s.making,
    ship:   s.ship   !== undefined ? s.ship   : BLANK,
    igi:    s.igi    !== undefined ? s.igi    : BLANK,
    disc:   s.disc ? -Math.abs(s.disc) : BLANK,
    tax:    s.gst !== undefined && s.gst !== null ? s.gst : BLANK,
    custom: BLANK,
  };
  rows.total = r2(Object.keys(rows).reduce((a, k) => a + (rows[k] || 0), 0));
  return rows;
}

// ── COLUMN C — EXCHANGE VALUE ────────────────────────────────────────────────────
// Deduction  = a REVALUATION. Never looks at the invoice.
// Full Value = a COPY OF THE INVOICE. Never looks at today's rates.
function exchangeColumn_(s, paid) {
  if (s.mode === 'full') {
    // =IF(B41="","",B41) for every row — blank stays blank, it does not become zero.
    const c = {};
    for (const k of ['gold', 'dia', 'gem', 'making', 'ship', 'igi', 'disc', 'tax']) c[k] = paid[k];
    c.custom = s.custom !== undefined ? s.custom : BLANK;
    c.net = r2(Object.keys(c).reduce((a, k) => a + (c[k] || 0), 0));
    return c;
  }

  // Deduction. The diamond leg is the whole point of this harness:
  //   =IF(B35="", C34*0.8, MIN(C34*0.8, B35))
  const haircut = r2(s.liveDia * 0.8);
  const dia = (s.diaPaid === undefined || s.diaPaid === null)
    ? haircut                                   // no cap recorded — legacy order
    : Math.min(haircut, s.diaPaid);

  // Gold = B29 × C33. B29 is the _net_wt property; on an order that never recorded one the cell is
  // blank and the product is zero. Scenario 13 is a real order in exactly that state.
  const goldLeg = (s.netWt === undefined || s.netWt === null) ? 0 : r2(s.netWt * s.goldRateEff);

  const c = {
    gold:   goldLeg,
    dia:    r2(dia),
    gem:    0,
    making: 0,
    ship:   0,
    igi:    0,
    disc:   BLANK,                              // absorbed by the haircut — never deducted here
    tax:    0,
    custom: s.custom !== undefined ? s.custom : BLANK,
  };
  c.net = r2(Object.keys(c).reduce((a, k) => a + (c[k] || 0), 0));
  c._haircut = haircut;
  c._capBound = (s.diaPaid !== undefined && s.diaPaid !== null) && s.diaPaid < haircut;
  return c;
}

// ── VALUE TO ISSUE (C52) ─────────────────────────────────────────────────────────
// Normally =C51, the NET of the exchange column. On Old Gold it is weight × buy-back rate and the
// whole before/after table is BYPASSED — see the SOURCE_OLD_GOLD branch. The table above it still
// renders (isFullValue_ forces Deduction for Old Gold), so the sheet shows a NET that is NOT the
// number being issued. That gap is scenario 14.
function valueToIssue_(s, exch) {
  if (s.mode === 'oldgold') return r2(s.ogWeight * s.ogRate);
  return exch.net;
}

// ── PRESENTATION ─────────────────────────────────────────────────────────────────
const LABELS = {
  gold: 'Gold Value (100%)', dia: 'Diamond Value (80%)', gem: 'Gemstone Value',
  making: 'Making / Labour', ship: 'Shipping', igi: 'IGI Re-Certification',
  disc: 'Discount Applied', tax: 'GST', custom: 'Custom deductions',
};
const WHY_DED = {
  gold: "revalued at today's gold rate", dia: '80% of current diamond value, capped at what was paid',
  gem: 'not credited on an exchange', making: 'not credited on an exchange',
  ship: 'not credited on an exchange', igi: 'not credited on an exchange',
  disc: 'not deducted — the 80% haircut already absorbs it', tax: 'not credited on an exchange',
  custom: 'manual — enter as a negative',
};
const WHY_FULL = Object.fromEntries(Object.keys(LABELS).map((k) =>
  [k, k === 'disc' ? 'deducted, as it was on the invoice'
    : k === 'tax' ? 'credited — Full Value is tax-inclusive'
    : k === 'custom' ? 'manual — enter as a negative' : 'as charged on the invoice']));

const money = (v) => (v === null || v === undefined) ? '' :
  (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render_(s, paid, exch) {
  const why = s.mode === 'full' ? WHY_FULL : WHY_DED;
  const pad = (t, w) => String(t).padEnd(w);
  const rpad = (t, w) => String(t).padStart(w);
  const out = [];
  out.push('  ' + pad('', 24) + rpad('PAID AT ORDER', 16) + rpad('EXCHANGE VALUE', 16) + '   WHY');
  out.push('  ' + '-'.repeat(24 + 16 + 16 + 3 + 46));
  for (const k of Object.keys(LABELS)) {
    out.push('  ' + pad(LABELS[k], 24) + rpad(money(paid[k]), 16) + rpad(money(exch[k]), 16) + '   ' + why[k]);
  }
  out.push('  ' + '-'.repeat(24 + 16 + 16 + 3 + 46));
  out.push('  ' + pad('TOTAL / NET', 24) + rpad(money(paid.total), 16) + rpad(money(exch.net), 16));
  if (s.mode === 'oldgold') {
    out.push('  ' + pad('VALUE TO ISSUE', 24) + rpad('', 16) + rpad(money(valueToIssue_(s, exch)), 16) +
             '   Old Gold — weight x buy-back rate, table above NOT used');
  }
  return out.join('\n');
}

// ── INVARIANTS — the data-sanctity checks ────────────────────────────────────────
// Each returns null when it holds, or a string describing the breach.
function checks_(s, paid, exch) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  const issue = valueToIssue_(s, exch);

  // 1. The paid column must foot to what the customer was actually charged, tax inclusive.
  //    On a real scenario invoiceTotal is the order's own total_price, so this can genuinely fail.
  //    expectFoot declares the KNOWN state: false means "this order is known not to foot, and the
  //    reason is recorded in `footNote`". Flipping either way turns the check red.
  const foots = r2(paid.total) === r2(s.invoiceTotal);
  const wantFoot = s.expectFoot !== undefined ? s.expectFoot : true;
  add(wantFoot ? 'paid column foots to the invoice' : 'paid column KNOWN not to foot (declared)',
    foots === wantFoot,
    `sum ${money(paid.total)} vs invoice ${money(s.invoiceTotal)}` +
    (foots ? '' : ` — short by ${money(r2(s.invoiceTotal - paid.total))}`) +
    (s.footNote ? ` [${s.footNote}]` : ''));

  if (s.mode === 'full') {
    // 2. Full Value credits exactly the invoice — no more, no less.
    //    Only meaningful where the paid column foots in the first place.
    if (wantFoot) {
      add('Full Value NET equals the invoice', r2(exch.net) === r2(s.invoiceTotal),
        `net ${money(exch.net)} vs invoice ${money(s.invoiceTotal)}`);
    } else {
      add('Full Value NET inherits the footing break', r2(exch.net) !== r2(s.invoiceTotal),
        `net ${money(exch.net)} vs invoice ${money(s.invoiceTotal)} — Full Value mirrors column B, ` +
        'so a paid column that does not foot issues the wrong credit');
    }
    // 3. The discount is deducted once, on its own row.
    if (s.disc) {
      add('discount deducted once on Full Value', exch.disc !== null && exch.disc <= 0,
        `discount row = ${money(exch.disc)}`);
    }
  } else if (s.mode === 'oldgold') {
    // 4. Old Gold bypasses the table entirely. The point of the check is that the NET on screen is
    //    NOT the number issued, which is a trap for anyone reading the sheet.
    add('Old Gold issues weight x rate, not the table NET', issue !== exch.net,
      `issue ${money(issue)} vs table NET ${money(exch.net)} — the table is decoration here`);
    add('Old Gold issue equals weight x buy-back rate', r2(issue) === r2(s.ogWeight * s.ogRate),
      `${s.ogWeight}g x ${money(s.ogRate)} = ${money(issue)}`);
  } else {
    // 5. The diamond leg may never exceed what was paid for the stone — when we know it.
    if (s.diaPaid !== undefined && s.diaPaid !== null) {
      add('diamond leg never exceeds the stone as paid', exch.dia <= s.diaPaid + 0.005,
        `leg ${money(exch.dia)} vs paid ${money(s.diaPaid)}`);
    } else {
      add('diamond leg is UNCAPPED (no Diamond (After Discount) on this order)', true,
        `leg ${money(exch.dia)} — nothing to cap against`);
    }
    // 6. The discount row must be BLANK, not zero. Blank says "deliberately not applied";
    //    zero would read as "there was no discount", which is a different statement.
    add('discount row blank on Deduction', exch.disc === null,
      `discount row = ${exch.disc === null ? 'blank' : money(exch.disc)}`);
    // 7. Everything that is not metal or stone is worth nothing on an exchange.
    const zeroes = ['gem', 'making', 'ship', 'igi', 'tax'].filter((k) => exch[k] !== 0);
    add('gem/making/ship/igi/GST all zero on Deduction', zeroes.length === 0,
      zeroes.length ? `non-zero: ${zeroes.join(', ')}` : 'all zero');
    // 8. The credit must never climb above the invoice.
    add('credit does not exceed the invoice', exch.net <= s.invoiceTotal + 0.005,
      `net ${money(exch.net)} vs invoice ${money(s.invoiceTotal)}`);

    // 9. THE ONE THAT MATTERS. Check 5 only fires when the cap cell is populated, which is exactly
    //    the case where a breach is impossible — MIN() cannot exceed its own argument. On a legacy
    //    order there is no cap cell, so check 5 waves it through and the real exposure goes unseen.
    //    stonePaid is what the customer actually paid for the STONE, read off the order by hand,
    //    and it is the only way to see the over-credit the explainer warns about.
    if (s.stonePaid !== undefined && s.stonePaid !== null) {
      const breach = exch.dia > s.stonePaid + 0.005;
      const wantBreach = s.expectStoneBreach === true;
      const mult = (exch.dia / s.stonePaid).toFixed(2);
      add(wantBreach
          ? 'diamond credit KNOWN to exceed the stone as paid (declared)'
          : 'diamond credit within what the stone cost',
        breach === wantBreach,
        `leg ${money(exch.dia)} vs stone paid ${money(s.stonePaid)} (${mult}x)` +
        (breach ? ` — OVER-CREDIT of ${money(r2(exch.dia - s.stonePaid))}` : ''));
    }
  }

  // 10. Declared expectation for the cap, where the scenario states one.
  if (s.expectCapBinds !== undefined) {
    add(`cap ${s.expectCapBinds ? 'binds' : 'does not bind'} (as declared)`,
      !!exch._capBound === s.expectCapBinds, `capBound = ${!!exch._capBound}`);
  }
  // 11. Declared expected diamond leg, where the scenario states one.
  if (s.expectDia !== undefined) {
    add('diamond leg matches expected', r2(exch.dia) === r2(s.expectDia),
      `got ${money(exch.dia)}, expected ${money(s.expectDia)}`);
  }
  // 12. Independent cross-check: the gold leg the sheet computes (net wt x today's rate) must equal
  //     custom.price_breakup_gold on the variant, which the catalogue computed the same way from
  //     the same two numbers. Two systems agreeing is worth more than either agreeing with itself.
  if (s.expectGoldFromMetafield !== undefined) {
    add('gold leg matches custom.price_breakup_gold', r2(exch.gold) === r2(s.expectGoldFromMetafield),
      `sheet ${money(exch.gold)} vs catalogue ${money(s.expectGoldFromMetafield)}`);
  }
  return out;
}

// ── SYNTHETIC SCENARIOS ──────────────────────────────────────────────────────────
// A flat catalogue (liveDia === dia) isolates the discount effect; 6-7 move the catalogue instead
// to isolate the second way the cap can bind.
const base = { gold: 50000, making: 10000, netWt: 5, goldRateEff: 10000, mode: 'deduction' };

// invoiceTotal = (gold + dia + making − disc) × 1.03, i.e. what the customer actually paid.
const inv = (g, d, m, disc) => r2((g + d + m - (disc || 0)) * 1.03);
const gstOf = (g, d, m, disc) => r2((g + d + m - (disc || 0)) * 0.03);

const SYNTHETIC = [
  { name: 'No discount, flat catalogue',
    ...base, dia: 100000, disc: 0, diaPaid: 100000, liveDia: 100000,
    expectDia: 80000, expectCapBinds: false },

  { name: '10% discount — under the 20% line',
    ...base, dia: 100000, disc: 10000, diaPaid: 90000, liveDia: 100000,
    expectDia: 80000, expectCapBinds: false },

  { name: '20% discount — exactly at the boundary',
    ...base, dia: 100000, disc: 20000, diaPaid: 80000, liveDia: 100000,
    expectDia: 80000, expectCapBinds: false },

  { name: '30% discount — CAP BINDS',
    ...base, dia: 100000, disc: 30000, diaPaid: 70000, liveDia: 100000,
    expectDia: 70000, expectCapBinds: true },

  { name: 'LEGACY order, 30% discount, no Diamond (After Discount) — uncapped',
    ...base, dia: 100000, disc: 30000, diaPaid: null, liveDia: 100000,
    stonePaid: 70000, expectStoneBreach: true,
    expectDia: 80000 },

  { name: 'Catalogue +20%, no discount — cap still slack',
    ...base, dia: 100000, disc: 0, diaPaid: 100000, liveDia: 120000,
    expectDia: 96000, expectCapBinds: false },

  { name: 'Catalogue +50%, no discount — CAP BINDS (trigger 2)',
    ...base, dia: 100000, disc: 0, diaPaid: 100000, liveDia: 150000,
    expectDia: 100000, expectCapBinds: true },
];

for (const s of SYNTHETIC) {
  s.synthetic = true;
  s.gst = gstOf(s.gold, s.dia, s.making, s.disc);
  s.invoiceTotal = inv(s.gold, s.dia, s.making, s.disc);
}

// ── REAL SCENARIOS ───────────────────────────────────────────────────────────────
// Pulled from auracarat.myshopify.com on 2026-09-17, API 2026-07.
//   paid column   ← order line-item properties
//   liveDia       ← variant metafield custom.price_breakup_diamond
//   goldRateEff   ← variant metafield custom.gold_rate
//   invoiceTotal  ← order.total_price, STATED not derived
// Today's gold rate is 11,614 across the catalogue except where the variant has not been repriced.
const REAL = [
  // The flagship. Everything the explainer asserts about #1072 is confirmed against the API:
  // Diamond (After Discount) really is 210,000, the whole 20,000 came off the stone (Making After
  // Discount is unchanged at 7,880), and the catalogue diamond has not moved. The explainer's
  // net wt of 3.5 and rate of 10,799 were placeholders — the order says 3.940 and the variant
  // says 9,032 today, down from 9,593 at purchase, so the customer LOSES on gold here.
  { name: 'Real #1072 — Deduction (cap slack, discount off the stone)',
    mode: 'deduction', invoiceTotal: 263346.71,
    gold: 37796.42, dia: 230000, making: 7880, disc: 20000, gst: 7670.29,
    diaPaid: 210000, stonePaid: 210000,
    netWt: 3.940, goldRateEff: 9032.0, liveDia: 230000,
    expectDia: 184000, expectCapBinds: false, expectGoldFromMetafield: 35586.08 },

  { name: 'Real #1072 — Full Value',
    mode: 'full', invoiceTotal: 263346.71,
    gold: 37796.42, dia: 230000, making: 7880, disc: 20000, gst: 7670.29,
    diaPaid: 210000, netWt: 3.940, goldRateEff: 9032.0, liveDia: 230000 },

  // DISPROVES THE CODE COMMENT. paidComponents_ says "the discount engine takes diamond first and
  // then making". Here the discount is 31.1% of the diamond — comfortably over the 20% line that
  // the explainer says makes the cap bind — and yet Diamond (After Discount) is UNCHANGED at
  // 12,400 while Making went 8,560 -> 4,708. The entire discount came off MAKING.
  // The cap therefore stays slack, and the explainer's "trigger 1" never fires on this order.
  { name: 'Real #1073 — 31% discount taken entirely off MAKING, stone untouched',
    mode: 'deduction', invoiceTotal: 41336.23,
    gold: 23024.26, dia: 12400, making: 8560, disc: 3852, gst: 1203.97,
    diaPaid: 12400, stonePaid: 12400,
    netWt: 2.140, goldRateEff: 11614.0, liveDia: 12400,
    expectDia: 9920, expectCapBinds: false, expectGoldFromMetafield: 24853.96 },

  // A real instance of the exact 20% boundary the synthetic scenario 3 models. Discount 60,300 on
  // a 301,500 diamond, all of it off the stone, so diaPaid == liveDia x 0.8 to the rupee and MIN()
  // has two identical arguments. The cap does not "bind" by the strict test but there is nothing
  // left in it.
  { name: 'Real #1069 — 20% discount, cap sitting exactly on the boundary',
    mode: 'deduction', invoiceTotal: 322068.28,
    gold: 61677.65, dia: 301500, making: 9810, disc: 60300, gst: 9380.63,
    diaPaid: 241200, stonePaid: 241200,
    netWt: 5.450, goldRateEff: 11614.0, liveDia: 301500,
    expectDia: 241200, expectCapBinds: false, expectGoldFromMetafield: 63296.30 },

  // LEGACY + no GST property at all. paidComponents_ falls back to lineItemTax_, which finds no
  // tax_lines on this tax-inclusive store, so the GST row stays blank and the paid column lands
  // 2,591.11 short of the invoice. The Deduction credit is unaffected (it never reads column B),
  // but on Full Value this SAME break would issue the taxable value instead of the tax-inclusive
  // one — which is precisely what fullValueGuardPasses_ exists to catch.
  { name: 'Real #1065 — LEGACY, no GST property, paid column does not foot',
    mode: 'deduction', invoiceTotal: 88961.61,
    gold: 42877.50, dia: 39600, making: 3893, disc: 0, gst: null,
    diaPaid: null, stonePaid: 39600,
    netWt: 3.893, goldRateEff: 11614.0, liveDia: 39600,
    expectFoot: false, footNote: 'GST property absent, tax_lines empty',
    expectDia: 31680, expectGoldFromMetafield: 45213.30 },

  { name: 'Real #1065 — Full Value on the same broken paid column',
    mode: 'full', invoiceTotal: 88961.61,
    gold: 42877.50, dia: 39600, making: 3893, disc: 0, gst: null,
    diaPaid: null, netWt: 3.893, goldRateEff: 11614.0, liveDia: 39600,
    expectFoot: false, footNote: 'GST property absent — Full Value would issue the taxable value' },

  // THE HEADLINE. Legacy order, no cap cell, and the catalogue diamond has gone 12,759.59 ->
  // 37,000 (+190%) since April. 80% of today's value is 29,600 and there is nothing to hold it
  // down. The customer paid 12,759.59 for that stone. The credit is 2.32x what they paid for it.
  // This is the risk DIAMOND_CAP_EXPLAINED.md describes in the abstract, priced out on a real order.
  //
  // It also foots to nothing: on orders this old the Gold/Diamond/Making properties are ALREADY
  // net of the discount (they sum to Taxable Value exactly), so paidComponents_ subtracts the
  // 24,967.62 a second time and shows 15,532.38 against a 40,500.00 invoice.
  //
  // And _net_wt was never written, so the gold leg is zero — the one thing keeping the total down.
  { name: 'Real #1045 — LEGACY + catalogue +190%: 2.3x OVER-CREDIT on the stone',
    mode: 'deduction', invoiceTotal: 40500.00,
    gold: 24191.80, dia: 12759.59, making: 2369, disc: 24967.62, gst: 1179.61,
    diaPaid: null, stonePaid: 12759.59, expectStoneBreach: true,
    netWt: null, goldRateEff: 9032.0, liveDia: 37000,
    expectFoot: false, footNote: 'components already post-discount, so the discount is taken twice',
    expectDia: 29600 },

  // Old Gold has no invoice at all, so the source flag forces Deduction and then the VALUE TO ISSUE
  // cell ignores the table completely. The numbers below are a plausible counter transaction, not a
  // real order — there is nothing to pull, which is the point.
  { name: 'Old Gold — table on screen is NOT the number issued',
    mode: 'oldgold', invoiceTotal: 0,
    dia: 0, making: 0, disc: 0, gst: 0,
    diaPaid: null, netWt: null, goldRateEff: 0, liveDia: 0,
    ogWeight: 10.5, ogRate: 8500,
    expectFoot: true },
];

for (const s of REAL) s.real = true;

const SCENARIOS = SYNTHETIC.concat(REAL);

// ── RUN ──────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const realOnly = args.includes('--real');
const only = args.find((a) => /^\d+$/.test(a));

let pass = 0, fail = 0;
const failures = [];
const notes = [];

SCENARIOS.forEach((s, i) => {
  const n = i + 1;
  if (only && String(n) !== only) return;
  if (realOnly && !s.real) return;

  const paid = paidColumn_(s);
  const exch = exchangeColumn_(s, paid);
  const res = checks_(s, paid, exch);

  if (s.expectFoot === false) notes.push(`S${n} ${s.name} — paid column does not foot: ${s.footNote}`);
  if (s.expectStoneBreach) notes.push(`S${n} ${s.name} — credits more than the stone cost`);

  if (!quiet) {
    console.log('');
    console.log(`SCENARIO ${n} — ${s.name}   [${s.real ? 'REAL ORDER' : 'synthetic'}]`);
    const modeName = s.mode === 'full' ? 'FULL VALUE' : s.mode === 'oldgold' ? 'OLD GOLD' : 'DEDUCTION';
    console.log(`  mode: ${modeName}   ` +
                `diamond paid: ${s.diaPaid === null || s.diaPaid === undefined ? '(not recorded)' : money(s.diaPaid)}   ` +
                `today's catalogue: ${money(s.liveDia)}   80% = ${money(r2(s.liveDia * 0.8))}`);
    console.log('');
    console.log(render_(s, paid, exch));
    console.log('');
  }

  res.forEach((c) => {
    if (c.ok) { pass++; if (!quiet) console.log(`    PASS  ${c.name}  (${c.detail})`); }
    else {
      fail++; failures.push(`S${n} ${s.name}: ${c.name} — ${c.detail}`);
      if (!quiet) console.log(`    FAIL  ${c.name}  (${c.detail})`);
    }
  });
});

console.log('');
console.log('='.repeat(78));
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log(''); failures.forEach((f) => console.log('  FAIL  ' + f)); }
if (notes.length) {
  console.log('');
  console.log('  KNOWN DATA DEFECTS ON REAL ORDERS — declared, not fixed:');
  notes.forEach((n) => console.log('    * ' + n));
}
console.log('='.repeat(78));
process.exit(fail ? 1 : 0);
