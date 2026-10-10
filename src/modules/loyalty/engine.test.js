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
t('below the first threshold has no tier', () => {
  const r = E.tierFor(199999, cfg);
  assert.strictEqual(r.tier, null);
  assert.strictEqual(r.next.key, 'T1');
  assert.strictEqual(r.gapToNext, 1);
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
t('a bare date is never shifted by timezone', () => {
  assert.strictEqual(E.monthOf('1990-01-01'), 1);
  assert.strictEqual(E.monthOf('garbage'), null);
});

console.log('eligibility');
const line = (o = {}) => ({ sku: 'R100', productType: 'Ring', tags: [], collections: [], jewelCode: 'R100', diamond: 50000, ...o });
t('an ordinary diamond piece is eligible', () => assert.ok(E.lineEligibility(line(), cfg).eligible));
t('excluded SKU (gold coin) is not', () => assert.ok(!E.lineEligibility(line({ sku: 'SCOIN' }), cfg).eligible));
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
t('gold tier takes 5% of the diamond only', () => {
  const r = E.computeLoyalty({ points: 600000, lines: [line({ diamond: 80000 })], now: MARCH, cfg });
  assert.ok(r.ok);
  assert.strictEqual(r.tier.key, 'T2');
  assert.strictEqual(r.rate, 5);
  assert.strictEqual(r.perLine[0].discount, 4000);
  assert.strictEqual(r.total, 4000);
});
t('birthday month adds 2% to the tier rate', () => {
  const r = E.computeLoyalty({ points: 600000, birthday: '1991-03-20', lines: [line({ diamond: 80000 })], now: MARCH, cfg });
  assert.strictEqual(r.rate, 7);
  assert.strictEqual(r.total, 5600);
});
t('ineligible lines get nothing, eligible ones still do', () => {
  const r = E.computeLoyalty({ points: 1200000, lines: [line({ diamond: 10000 }), line({ sku: 'SCOIN', diamond: 0 })], now: MARCH, cfg });
  assert.strictEqual(r.perLine[0].discount, 700);
  assert.strictEqual(r.perLine[1].discount, 0);
  assert.strictEqual(r.perLine[1].eligible, false);
  assert.strictEqual(r.total, 700);
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
t('an exchange note issued against an order comes off it, like a refund (Santosh #1060)', () => {
  const o = { name: '#1060', total_price: '47041.90', tags: 'deposit:fully-paid, exc-given, exc-num:EXC27-KAHSR-0001, exc-val:47041.00, paid:Rs47041' };
  assert.strictEqual(E.earnPoints(o, cfg).points, 0);
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
t('another code on the draft blocks loyalty', () => {
  assert.ok(E.otherDiscountOnDraft({ discount_rate: '5' }));
  assert.ok(E.otherDiscountOnDraft({ discount_codes: '[{"code":"FNF5"}]' }));
  assert.ok(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"dia","m":"pct","v":3}]]' }));
});
t('vouchers and exchange notes do not block it', () => {
  assert.strictEqual(E.otherDiscountOnDraft({ voucher_value: '5000', exchange_note_value: '2000' }), '');
  assert.strictEqual(E.otherDiscountOnDraft({ line_discounts: '[[{"t":"dia","m":"pct","v":5,"src":"loyalty"}],[]]' }), '');
});
t('loyalty entries land on eligible variants only, by variant not position', () => {
  const items = [{ variant_id: 22 }, { variant_id: 11 }, { variant_id: 33 }];
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

console.log('config validation');
t('a percentage over 100 is refused', () => {
  assert.throws(() => normalizeConfig({ tiers: [{ key: 'T1', min: 1, pct: 150 }] }), /pct/);
});
t('tiers are sorted by threshold whatever order they are typed in', () => {
  const c = normalizeConfig({ tiers: [{ key: 'B', min: 500, pct: 5 }, { key: 'A', min: 100, pct: 3 }] });
  assert.deepStrictEqual(c.tiers.map(x => x.key), ['A', 'B']);
});

console.log(`\n${n} assertions passed`);
