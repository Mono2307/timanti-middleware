'use strict';

const assert = require('assert');
// config.js pulls in core/shopify, which builds a Supabase client at load. Nothing here dials out.
process.env.SUPABASE_URL         ||= 'https://loyalty-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://loyalty-test.invalid';
const E = require('./engine');
const { DEFAULT_CONFIG, normalizeConfig } = require('./config');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const cfg = normalizeConfig(DEFAULT_CONFIG);
// 15 March 2026, midday IST.
const MARCH = new Date('2026-03-15T06:30:00Z');

console.log('tiers');
t('below the first threshold (and its 1% tolerance) has no tier', () => {
  const r = E.tierFor(197999, cfg);
  assert.strictEqual(r.tier, null);
  assert.strictEqual(r.next.key, 'T1');
  assert.strictEqual(r.gapToNext, 2001, 'the gap is to the published ₹2L, not the tolerance line');
});
t('1% tolerance: ₹2,000 / ₹5,000 / ₹10,000 short still qualifies (founder, 2026-10-21)', () => {
  assert.strictEqual(E.tierFor(198000, cfg).tier.key, 'T1');
  assert.strictEqual(E.tierFor(495000, cfg).tier.key, 'T2');
  assert.strictEqual(E.tierFor(494999, cfg).tier.key, 'T1');
  assert.strictEqual(E.tierFor(990000, cfg).tier.key, 'T3');
  assert.strictEqual(E.tierFor(989999, cfg).tier.key, 'T2');
});
t('inside the tolerance the next tier is the one after', () => {
  const r = E.tierFor(496000, cfg);
  assert.strictEqual(r.next.key, 'T3');
  assert.strictEqual(r.gapToNext, 504000);
});
t('tolerance 0 restores the strict thresholds; a config without the key gets 1%', () => {
  const strict = normalizeConfig({ ...DEFAULT_CONFIG, tier_tolerance_pct: 0 });
  assert.strictEqual(E.tierFor(199999, strict).tier, null);
  const { tier_tolerance_pct, ...old } = DEFAULT_CONFIG;
  assert.strictEqual(normalizeConfig(old).tier_tolerance_pct, 1);
  assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, tier_tolerance_pct: 50 }), /tolerance/);
});
t('exactly on a threshold qualifies', () => {
  assert.strictEqual(E.tierFor(200000, cfg).tier.key, 'T1');
  assert.strictEqual(E.tierFor(500000, cfg).tier.key, 'T2');
  assert.strictEqual(E.tierFor(1000000, cfg).tier.key, 'T3');
});
t('top tier has no next tier', () => {
  const r = E.tierFor(5000000, cfg);
  assert.strictEqual(r.next, null);
  assert.strictEqual(r.gapToNext, 0);
});

console.log('occasion bonus');
t('birthday month gives 2%', () => {
  assert.deepStrictEqual(E.occasionBonus({ birthday: '1990-03-02' }, MARCH, cfg), { pct: 2, occasions: ['birthday'] });
});
t('birthday and anniversary in the same month give 2% once', () => {
  const r = E.occasionBonus({ birthday: '1990-03-02', anniversary: '2015-03-28' }, MARCH, cfg);
  assert.strictEqual(r.pct, 2);
  assert.deepStrictEqual(r.occasions, ['birthday', 'anniversary']);
});
t('stacking switch adds them', () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, occasion_bonus_stacks: true });
  assert.strictEqual(E.occasionBonus({ birthday: '1990-03-02', anniversary: '2015-03-28' }, MARCH, c).pct, 4);
});
t('another month gives nothing', () => {
  assert.strictEqual(E.occasionBonus({ birthday: '1990-04-02' }, MARCH, cfg).pct, 0);
});
t('month is read in IST: 31 Mar 20:00 UTC is already April in India', () => {
  const lateMarchUtc = new Date('2026-03-31T20:00:00Z');
  assert.strictEqual(E.istMonth(lateMarchUtc), 4);
  assert.strictEqual(E.occasionBonus({ birthday: '2000-04-10' }, lateMarchUtc, cfg).pct, 2);
});
t('bonus is withheld once this month\'s has been used, the tier rate is not', () => {
  const lines = [{ sku: 'R1', diamond: 10000 }];
  const fresh = E.computeLoyalty({ points: 620000, birthday: '1990-03-02', lines, now: MARCH, cfg });
  assert.strictEqual(fresh.rate, 9);
  const used = E.computeLoyalty({ points: 620000, birthday: '1990-03-02', lines, now: MARCH, cfg, occasionUsed: { order_name: '#1101', channel: 'store' } });
  assert.strictEqual(used.rate, 7);
  assert.strictEqual(used.occasion.pct, 0);
  assert.deepStrictEqual(used.occasion.used, { occasions: ['birthday'], by: { order_name: '#1101', channel: 'store' } });
});
t('the IST month starts at midnight IST on the 1st', () => {
  assert.strictEqual(E.istMonthStartIso(new Date('2026-03-31T20:00:00Z')), '2026-04-01T00:00:00+05:30');
  assert.strictEqual(E.istMonthStartIso(MARCH), '2026-03-01T00:00:00+05:30');
});
t('a bare date is never shifted by timezone', () => {
  assert.strictEqual(E.monthOf('1990-01-01'), 1);
  assert.strictEqual(E.monthOf('garbage'), null);
});

console.log('eligibility');
const line = (o = {}) => ({ sku: 'R100', productType: 'Ring', tags: [], collections: [], jewelCode: 'R100', diamond: 50000, ...o });
t('an ordinary diamond piece is eligible', () => assert.ok(E.lineEligibility(line(), cfg).eligible));
t('excluded SKU (silver coin) is not', () => assert.ok(!E.lineEligibility(line({ sku: 'SCOIN' }), cfg).eligible));
t('gold coin (GCOIN) is excluded even with a diamond value', () => assert.ok(!E.lineEligibility(line({ sku: 'GCOIN|Y|24|NA|H|NA|NA|NA', diamond: 500 }), cfg).eligible));
t('excluded by design code inside the full catalogue SKU', () => assert.ok(!E.lineEligibility(line({ sku: 'SCOIN|S|999|NA|H|NA|NA|NA', diamond: 500 }), cfg).eligible));
t('no-loyalty tag is not', () => assert.ok(!E.lineEligibility(line({ tags: ['No-Loyalty'] }), cfg).eligible));
t('no diamond value is not', () => assert.ok(!E.lineEligibility(line({ diamond: 0 }), cfg).eligible));
t('exchange-note line is not', () => assert.ok(!E.lineEligibility(line({ isExchange: true }), cfg).eligible));
t('include list limits to the listed types', () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, eligibility: { ...DEFAULT_CONFIG.eligibility, include: { product_types: ['Ring'] } } });
  assert.ok(E.lineEligibility(line(), c).eligible);
  assert.ok(!E.lineEligibility(line({ productType: 'Earring' }), c).eligible);
});
t('exclude beats include', () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, eligibility: { include: { tags: ['solitaire'] }, exclude: { tags: ['solitaire'] } } });
  assert.ok(!E.lineEligibility(line({ tags: ['solitaire'] }), c).eligible);
});
t('jewel-code prefix exclusion', () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, eligibility: { exclude: { jewel_code_prefixes: ['cad'] } } });
  assert.ok(!E.lineEligibility(line({ jewelCode: 'CAD-0012' }), c).eligible);
});

console.log('computeLoyalty');
t('gold tier takes 7% of the diamond', () => {
  const r = E.computeLoyalty({ points: 600000, lines: [line({ diamond: 80000 })], now: MARCH, cfg });
  assert.ok(r.ok);
  assert.strictEqual(r.tier.key, 'T2');
  assert.strictEqual(r.rate, 7);
  assert.strictEqual(r.perLine[0].discount, 5600);
  assert.strictEqual(r.total, 5600);
});
t('birthday month adds 2% to the diamond rate, not to making', () => {
  const r = E.computeLoyalty({ points: 600000, birthday: '1991-03-20', lines: [line({ diamond: 80000, making: 10000 })], now: MARCH, cfg });
  assert.strictEqual(r.rate, 9);
  assert.strictEqual(r.makingPct, 20);
  assert.strictEqual(r.diamondTotal, 7200);
  assert.strictEqual(r.makingTotal, 2000);
  assert.strictEqual(r.total, 9200);
});
t('ineligible lines get nothing, eligible ones still do', () => {
  const r = E.computeLoyalty({ points: 1200000, lines: [line({ diamond: 10000 }), line({ sku: 'SCOIN', diamond: 0, making: 5000 })], now: MARCH, cfg });
  assert.strictEqual(r.perLine[0].discount, 1000);
  assert.strictEqual(r.perLine[1].discount, 0);
  assert.strictEqual(r.perLine[1].makingDiscount, 0);
  assert.strictEqual(r.perLine[1].eligible, false);
  assert.strictEqual(r.total, 1000);
});
t('the 2026-10-24 grid: 5/7/10% diamond, 15/20/30% making capped at 2,000/5,000/10,000', () => {
  assert.deepStrictEqual(cfg.tiers.map(x => [x.pct, x.making_pct, x.making_cap]), [[5, 15, 2000], [7, 20, 5000], [10, 30, 10000]]);
});
t('silver: 15% of making until the cap, then exactly 2,000 for the whole transaction', () => {
  const under = E.computeLoyalty({ points: 250000, lines: [line({ diamond: 40000, making: 8000 })], now: MARCH, cfg });
  assert.strictEqual(under.perLine[0].discount, 2000);
  assert.strictEqual(under.perLine[0].makingDiscount, 1200);
  assert.strictEqual(under.total, 3200);
  // 15% of 12,000 + 15% of 8,000 = 3,000 > 2,000 → both scaled by 2/3.
  const over = E.computeLoyalty({ points: 250000, lines: [line({ diamond: 40000, making: 12000 }), line({ diamond: 20000, making: 8000 })], now: MARCH, cfg });
  assert.strictEqual(over.perLine[0].makingDiscount, 1200);
  assert.strictEqual(over.perLine[1].makingDiscount, 800);
  assert.strictEqual(over.makingTotal, 2000);
  assert.strictEqual(over.diamondTotal, 3000);
});
t('platinum: cap 10,000 never exceeded, even by a paisa of rounding', () => {
  const r = E.computeLoyalty({ points: 1100000, lines: [1, 2, 3].map(() => line({ making: 33333.33 })), now: MARCH, cfg });
  assert.ok(r.makingTotal <= 10000 && r.makingTotal > 9999.9, String(r.makingTotal));
});
t('below tier gets nothing and says why', () => {
  const r = E.computeLoyalty({ points: 1000, lines: [line()], now: MARCH, cfg });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'below the first tier');
  assert.strictEqual(r.total, 0);
});
t('no eligible lines is refused', () => {
  const r = E.computeLoyalty({ points: 600000, lines: [line({ diamond: 0 })], now: MARCH, cfg });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no eligible pieces');
});
t('switched-off programme gives nothing', () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, enabled: false });
  assert.strictEqual(E.computeLoyalty({ points: 9e6, lines: [line()], now: MARCH, cfg: c }).ok, false);
});
t('online amount is grossed up for GST', () => {
  assert.strictEqual(E.onlineAmount(4000), 4120);
});

console.log('earning');
t('plain order earns its total, floored', () => {
  assert.strictEqual(E.orderEarnValue({ total_price: '103000.75', line_items: [] }), 103000);
});
t('cancelled order earns nothing', () => {
  assert.strictEqual(E.orderEarnValue({ total_price: '50000', cancelled_at: '2026-01-01' }), 0);
});
t('an online VCH voucher is tender and is added back', () => {
  const order = {
    total_price: '90000',
    discount_applications: [{ code: 'VCH-KA-0001' }, { code: 'LOY-ABC' }],
    line_items: [{ price: '100000', quantity: 1, discount_allocations: [
      { discount_application_index: 0, amount: '5000' },
      { discount_application_index: 1, amount: '5000' },
    ] }],
  };
  // 90,000 paid + 5,000 voucher tender; the 5,000 loyalty discount stays deducted.
  assert.strictEqual(E.orderEarnValue(order), 95000);
});
t('an exchange-note line is tender and is added back', () => {
  const order = { total_price: '70000', line_items: [
    { title: 'Ring', price: '100000', quantity: 1 },
    { title: 'Exchange Note EXC-1', price: '-30000', quantity: 1 },
  ] };
  assert.strictEqual(E.orderEarnValue(order), 100000);
});
t('refunds come off — the larger of Shopify and the middleware record', () => {
  const order = { total_price: '100000', line_items: [], refunds: [{ transactions: [{ kind: 'refund', status: 'success', amount: '10000' }] }] };
  assert.strictEqual(E.orderEarnValue(order), 90000);
  assert.strictEqual(E.orderEarnValue(order, { amountRefunded: 25000 }), 75000);
});

console.log('earning rules (founder, 2026-10-10)');
t('orders before #1038 earn nothing', () => {
  assert.deepStrictEqual(E.earnPoints({ name: '#1037', total_price: '50000' }, cfg), { points: 0, excluded: 'before #1038' });
  assert.strictEqual(E.earnPoints({ name: '#1038', total_price: '50000' }, cfg).points, 50000);
});
t('a REDEEMED exchange note issued against an order comes off it, like a refund (Santosh #1060)', () => {
  const o = { name: '#1060', total_price: '47041.90', tags: 'deposit:fully-paid, exc-given, exc-num:EXC27-KAHSR-0001, exc-val:47041.00, paid:Rs47041' };
  assert.strictEqual(E.earnPoints(o, cfg, { redeemedAgainst: 47041 }).points, 0);
});
t('exchange tags alone change nothing: only a redemption in the ledger counts', () => {
  const o = { name: '#1060', total_price: '47041.90', tags: 'exc-given, exc-val:47041.00' };
  assert.strictEqual(E.earnPoints(o, cfg).points, 47041);
});
t('a redeemed voucher issued for a return comes off its source order too', () => {
  assert.strictEqual(E.earnPoints({ name: '#1073', total_price: '100000' }, cfg, { redeemedAgainst: 13664 }).points, 86336);
});
t('the order the note is spent on earns its full value (Santosh #1063)', () => {
  const o = { name: '#1063', total_price: '44686.41', tags: 'exc-applied, exc-num:EXC27-KAHSR-0001, exc-original:#1060, exc-val:47041.00' };
  assert.strictEqual(E.earnPoints(o, cfg).points, 44686, 'exc-val without exc-given is not an issued note');
});
t('a replaced invoice earns nothing (Vandana #1052 → #1057)', () => {
  assert.deepStrictEqual(E.earnPoints({ name: '#1052', total_price: '546550.96' }, cfg), { points: 0, excluded: 'replaced by #1057' });
  assert.strictEqual(E.earnPoints({ name: '#1057', total_price: '529924.86' }, cfg).points, 529924);
});
t('a config saved before the earning rules existed still applies them', () => {
  const c = normalizeConfig({ tiers: DEFAULT_CONFIG.tiers });
  assert.strictEqual(c.earning.min_order_number, 1038);
  assert.strictEqual(c.earning.superseded_orders['#1052'], '#1057');
});

console.log('draft discount state');
t('an order-level code on the draft blocks loyalty', () => {
  assert.ok(E.otherDiscountOnDraft({ discount_rate: '5' }));
  assert.ok(E.otherDiscountOnDraft({ discount_codes: '[{"code":"FNF5"}]' }));
});
t('a manual per-line discount does NOT block loyalty: they stack (founder, 2026-10-21)', () => {
  assert.strictEqual(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"dia","m":"pct","v":3}]]' }), '');
  assert.strictEqual(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"mk","m":"pct","v":10}]]' }), '');
});
t('vouchers and exchange notes do not block it', () => {
  assert.strictEqual(E.otherDiscountOnDraft({ voucher_value: '5000', exchange_note_value: '2000' }), '');
  assert.strictEqual(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"dia","m":"pct","v":5,"src":"loyalty"}],[]]' }), '');
});
t('loyalty entries land on eligible variants only, by variant not position', () => {
  const items = [{ variant_id: 22 }, { variant_id: 11 }, { variant_id: 33 }];
  const withMk = E.withLoyaltyEntries([], [{ variant_id: 11 }], { rate: 5, mk: 15, mkcap: 2000, eligible_variants: ['11'] });
  assert.deepStrictEqual(withMk[0], [{ t: 'dia', m: 'pct', v: 5, src: 'loyalty' }, { t: 'mk', m: 'pct', v: 15, src: 'loyalty', cap: 2000 }]);
  const out = E.withLoyaltyEntries([], items, { rate: 5, eligible_variants: ['11', '33'] });
  assert.deepStrictEqual(out[0], []);
  assert.deepStrictEqual(out[1], [{ t: 'dia', m: 'pct', v: 5, src: 'loyalty' }]);
  assert.deepStrictEqual(out[2], [{ t: 'dia', m: 'pct', v: 5, src: 'loyalty' }]);
});
t('re-applying never doubles the loyalty entry', () => {
  const items = [{ variant_id: 11 }];
  const once = E.withLoyaltyEntries([], items, { rate: 5, eligible_variants: [11] });
  const twice = E.withLoyaltyEntries(once, items, { rate: 7, eligible_variants: [11] });
  assert.deepStrictEqual(twice[0], [{ t: 'dia', m: 'pct', v: 7, src: 'loyalty' }]);
});
t('no loyalty applied leaves the list untouched', () => {
  const arr = [[{ t: 'mk', m: 'flat', v: 100 }]];
  assert.strictEqual(E.withLoyaltyEntries(arr, [{ variant_id: 1 }], null), arr);
});
t('readApplied rejects junk', () => {
  assert.strictEqual(E.readApplied('{oops'), null);
  assert.strictEqual(E.readApplied('{"rate":0}'), null);
  assert.strictEqual(E.readApplied('{"rate":5,"tier":"T2"}').tier, 'T2');
});

console.log('stacking with the automatic diamond discount (founder, 2026-10-12)');
t('an auto-dia entry does not block loyalty', () => {
  assert.strictEqual(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"dia","m":"pct","v":15,"src":"auto-dia"}]]' }), '');
});
t('auto-dia plus a staff making discount does not block it either', () => {
  assert.strictEqual(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"dia","m":"pct","v":15,"src":"auto-dia"},{"t":"mk","m":"pct","v":10}]]' }), '');
});
t('loyalty is added beside the auto entry, so both reach the pricing engine', () => {
  const out = E.withLoyaltyEntries([[{ t: 'dia', m: 'pct', v: 15, src: 'auto-dia' }]], [{ variant_id: 11 }], { rate: 5, eligible_variants: ['11'] });
  assert.deepStrictEqual(out[0], [{ t: 'dia', m: 'pct', v: 15, src: 'auto-dia' }, { t: 'dia', m: 'pct', v: 5, src: 'loyalty' }]);
});

console.log('making cap in the reprice');
t('under the cap the entries are untouched', () => {
  const arr = [[{ t: 'mk', m: 'pct', v: 15, src: 'loyalty', cap: 2000 }]];
  assert.strictEqual(E.capLoyaltyMaking(arr, [10000]), arr);
});
t('over the cap each loyalty making entry becomes its scaled share, manual entries untouched', () => {
  const manual = { t: 'mk', m: 'pct', v: 10 };
  const arr = [[manual, { t: 'mk', m: 'pct', v: 15, src: 'loyalty', cap: 2000 }], [{ t: 'mk', m: 'pct', v: 15, src: 'loyalty', cap: 2000 }], []];
  const out = E.capLoyaltyMaking(arr, [12000, 8000, 5000]);
  assert.deepStrictEqual(out[0], [manual, { t: 'mk', m: 'flat', v: 1200, src: 'loyalty', cap: 2000 }]);
  assert.deepStrictEqual(out[1], [{ t: 'mk', m: 'flat', v: 800, src: 'loyalty', cap: 2000 }]);
  assert.strictEqual(arr[0][1].m, 'pct', 'input not mutated');
});
t('a resolved line still clamps the making cut at the making value', () => {
  const out = E.capLoyaltyMaking([[{ t: 'mk', m: 'pct', v: 30, src: 'loyalty', cap: 10000 }]], [50000]);
  assert.deepStrictEqual(out[0][0], { t: 'mk', m: 'flat', v: 10000, src: 'loyalty', cap: 10000 });
});

console.log('config validation');
t('a config still on the original 3/5/7 grid is read as the new grid, names and thresholds kept', () => {
  const c = normalizeConfig({ tiers: [{ key: 'T1', name: 'Club', min: 200000, pct: 3 }, { key: 'T2', name: 'Gold', min: 500000, pct: 5 }, { key: 'T3', name: 'Platinum', min: 1000000, pct: 7 }] });
  assert.deepStrictEqual(c.tiers.map(x => [x.name, x.pct, x.making_pct, x.making_cap]), [['Club', 5, 15, 2000], ['Gold', 7, 20, 5000], ['Platinum', 10, 30, 10000]]);
});
t('any other hand-edited grid is left as typed', () => {
  const c = normalizeConfig({ tiers: [{ key: 'T1', min: 200000, pct: 4 }] });
  assert.deepStrictEqual([c.tiers[0].pct, c.tiers[0].making_pct, c.tiers[0].making_cap], [4, 0, 0]);
});
t('a percentage over 100 is refused', () => {
  assert.throws(() => normalizeConfig({ tiers: [{ key: 'T1', min: 1, pct: 150 }] }), /pct/);
});
t('tiers are sorted by threshold whatever order they are typed in', () => {
  const c = normalizeConfig({ tiers: [{ key: 'B', min: 500, pct: 5 }, { key: 'A', min: 100, pct: 3 }] });
  assert.deepStrictEqual(c.tiers.map(x => x.key), ['A', 'B']);
});

console.log(`\n${n} assertions passed`);
