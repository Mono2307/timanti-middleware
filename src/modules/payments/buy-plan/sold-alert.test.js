process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

// A piece on an active buy plan sold to someone else → the store is told to reorder.
const assert = require('assert');
const { plansHit } = require('./sold-alert');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const plan = { id: 3, draft_name: '#D327', customer_id: '9', snapshot: { line_items: [{ variant_id: 777, title: 'Abyss Enamel Ring' }] } };
const order = (over = {}) => ({ id: 1, name: '#1100', tags: '', customer: { id: '5' }, line_items: [{ variant_id: 777, title: 'Abyss Enamel Ring' }], ...over });

console.log('sold piece alert');
t('another customer buying a plan piece is a hit', () => {
  assert.deepStrictEqual(plansHit(order(), [plan]).map(h => h.pieces), [['Abyss Enamel Ring']]);
});
t('a different piece is not', () => {
  assert.deepStrictEqual(plansHit(order({ line_items: [{ variant_id: 8, title: 'Other' }] }), [plan]), []);
});
t("the plan's own order (same customer, or tagged buy-plan) is not", () => {
  assert.deepStrictEqual(plansHit(order({ customer: { id: '9' } }), [plan]), []);
  assert.deepStrictEqual(plansHit(order({ tags: 'ch:offline, buy-plan' }), [plan]), []);
});

console.log('tracker sheet row');
const { rowFor, COLUMNS } = require('./sheet');
const col = (row, name) => row[COLUMNS.indexOf(name)];
const d327 = { draft_name: '#D327', status: 'active', mode: 'equal', total: 76520, start_date: '2026-11-04', installments: 6,
  price_changes: [{ date: '2026-11-04', total: 90922 }], draft_order_id: '1' };
t('on track: paid, balance, next due and amount', () => {
  const r = rowFor(d327, [{ value: 12754, date: '2026-11-04' }], '2026-11-06');
  assert.deepStrictEqual([col(r, 'Paid'), col(r, 'Balance'), col(r, 'Next due'), col(r, 'Next amount'), col(r, 'Status'), col(r, 'Closes on')],
    [12754, 78168, '2026-12-04', 15634, 'Active: on track', '']);
});
t('missed installment: overdue with the close date', () => {
  const r = rowFor(d327, [{ value: 12754, date: '2026-11-04' }], '2026-12-10');
  assert.strictEqual(col(r, 'Status'), 'Active: overdue');
  assert.strictEqual(col(r, 'Closes on'), '2027-02-02');
});

console.log(`\n${n} passed`);
