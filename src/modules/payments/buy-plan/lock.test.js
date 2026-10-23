const assert = require('assert');
const { isRateLocked, RATE_LOCK_TAG, BUY_PLAN_TAG } = require('./lock');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('isRateLocked');
t('rate-locked tag locks', () => assert.strictEqual(isRateLocked(`card, ${RATE_LOCK_TAG}, reprice`), true));
t('buy-plan alone locks', () => assert.strictEqual(isRateLocked([BUY_PLAN_TAG]), true));
t('case and spacing do not matter', () => assert.strictEqual(isRateLocked(' Rate-Locked ,x'), true));
t('an ordinary draft is not locked', () => assert.strictEqual(isRateLocked('ot:in-stock, reprice, ch:offline'), false));
t('ot:buy-plan is not the marker (ot: is the order-type routing tag)', () => assert.strictEqual(isRateLocked('ot:buy-plan'), false));
t('empty / missing tags are not locked', () => {
  assert.strictEqual(isRateLocked(''), false);
  assert.strictEqual(isRateLocked(null), false);
  assert.strictEqual(isRateLocked([]), false);
});
t('a tag merely containing the words does not lock', () => assert.strictEqual(isRateLocked('not-rate-locked'), false));

console.log(`\n${n} passed`);
