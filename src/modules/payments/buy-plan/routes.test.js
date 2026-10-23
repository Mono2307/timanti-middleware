process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

const assert = require('assert');
const { startBlockers, snapshotOf, lockedGoldRate } = require('./routes');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

const base = (over = {}) => ({
  id: '1', mf: {}, tags: ['ch:offline'], total: 120000, legs: [],
  customer: { id: '9', name: 'Test', email: 'a@b.in', phone: '9830000000' },
  draft: { name: '#D1', status: 'open', line_items: [] },
  ...over,
});

console.log('startBlockers');
t('a ready draft has none', () => assert.deepStrictEqual(startBlockers(base()), []));
t('needs a customer, phone and email', () => {
  const b = startBlockers(base({ customer: { id: null, name: '', email: '', phone: '' } }));
  assert.strictEqual(b.length, 3);
});
t('refuses a completed draft', () => assert.match(startBlockers(base({ draft: { name: '#D1', status: 'completed' } }))[0], /completed/));
t('refuses nothing-to-collect and fully-paid drafts', () => {
  assert.match(startBlockers(base({ total: 0 })).join(), /nothing to collect/);
  assert.match(startBlockers(base({ legs: [{ value: 120000 }] })).join(), /fully paid/);
});

console.log('lockedGoldRate');
t('draft-level custom.gold_rate wins', () => assert.strictEqual(lockedGoldRate(base({ mf: { gold_rate: '9713,10200' } })), '9713,10200'));
t('else each line\'s _gold_rate, in order', () => {
  const d = base({ draft: { name: '#D1', status: 'open', line_items: [
    { properties: [{ name: '_gold_rate', value: '9713.00' }] },
    { properties: [] },
    { properties: [{ name: '_gold_rate', value: '7285.00' }] },
  ] } });
  assert.strictEqual(lockedGoldRate(d), '9713.00,7285.00');
});
t('null when nothing records a rate', () => assert.strictEqual(lockedGoldRate(base()), null));

console.log('snapshotOf');
t('keeps lines at their prices, the customer and the tags', () => {
  const s = snapshotOf(base({ draft: { name: '#D1', status: 'open', line_items: [
    { variant_id: 5, title: 'Ring', quantity: 1, price: '120000.00', properties: [{ name: '_gold_rate', value: '1' }], id: 99, admin_graphql_api_id: 'x' },
  ] } }));
  assert.strictEqual(s.line_items[0].price, '120000.00');
  assert.strictEqual(s.line_items[0].id, undefined);
  assert.strictEqual(s.customer_id, '9');
  assert.deepStrictEqual(s.tags, ['ch:offline']);
});

console.log(`\n${n} passed`);
