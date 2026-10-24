process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

const assert = require('assert');
const { payToken, readPayToken } = require('./links');
const { draftInput } = require('./restore');
const { whatsappUrl } = require('./notify');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('pay-page token');
t('round-trips the plan id', () => assert.strictEqual(readPayToken(payToken(42)), 42));
t('a tampered token is refused', () => {
  const tok = payToken(42);
  const [body, sig] = tok.split('.');
  const other = payToken(43).split('.')[0];
  assert.strictEqual(readPayToken(`${other}.${sig}`), null);
  assert.strictEqual(readPayToken(`${body}.${sig.slice(0, -1)}x`), null);
});
t('an expired token is refused', () => {
  const tok = payToken(42, Date.now() - 400 * 86400 * 1000);
  assert.strictEqual(readPayToken(tok), null);
});
t('garbage is refused', () => {
  assert.strictEqual(readPayToken(''), null);
  assert.strictEqual(readPayToken('abc'), null);
  assert.strictEqual(readPayToken(null), null);
});

console.log('restore: draftInput');
t('rebuilds lines at their LOCKED prices and keeps the plan tags', () => {
  const input = draftInput({
    line_items: [
      { variant_id: 5, quantity: 1, price: '120000', properties: [{ name: 'Gold', value: '80000' }] },
      { title: 'Engraving', quantity: 1, price: '500', properties: [] },
    ],
    tags: ['buy-plan', 'rate-locked'], customer_id: '9', email: 'a@b.in',
    metafields: { installment_1_value: '20000', plan_total: '120500', line_discounts: '[[{"t":"dia"}]]', repair_inspection: '{}' },
  });
  assert.strictEqual(input.lineItems[0].priceOverride.amount, '120000.00');
  assert.strictEqual(input.lineItems[0].customAttributes[0].key, 'Gold');
  assert.strictEqual(input.lineItems[1].originalUnitPriceWithCurrency.amount, '500.00');
  assert.deepStrictEqual(input.tags, ['buy-plan', 'rate-locked']);
  assert.strictEqual(input.purchasingEntity.customerId, 'gid://shopify/Customer/9');
  const keys = input.metafields.map(m => m.key).sort();
  assert.deepStrictEqual(keys, ['installment_1_value', 'plan_total']);   // long JSON records are not carried
  assert.strictEqual(input.metafields.find(m => m.key === 'installment_1_value').type, 'number_decimal');
});

console.log('staff WhatsApp link');
t('prefills a message to the customer\'s Indian number', () => {
  const url = whatsappUrl({ phone: '+91 98300 00000', customerName: 'Asha', k: 2, draftName: '#D300', amount: 16000, due: '2026-11-24' });
  assert.match(url, /^https:\/\/wa\.me\/919830000000\?text=/);
  assert.match(decodeURIComponent(url), /Installment 2 of your buy plan \(#D300\), Rs16,000, is due on 24 Nov 2026/);
});
t('no phone, no link', () => assert.strictEqual(whatsappUrl({ phone: '' }), null));

console.log(`\n${n} passed`);
