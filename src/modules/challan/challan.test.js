// Delivery challan admin action — what must be in place before a number is drawn.

const assert = require('assert');
const { missingForMake, STORES } = require('./rules');

const addr = { name: 'A Customer', line: '1 Road, Pune, MH', province: 'MH' };
const base = { origin: 'KA-HSR', deliveryCode: 'MH-HQ', shipOutside: false, address: null, productLines: 1 };
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

ok('the template knows exactly two stores', () => assert.deepStrictEqual(Object.keys(STORES).sort(), ['KA-HSR', 'MH-HQ']));
ok('store to store with everything set', () => assert.deepStrictEqual(missingForMake(base), []));
ok('no From store blocks it', () => assert.strictEqual(missingForMake({ ...base, origin: '' }).length, 1));
ok('an unknown From store blocks it (KAHSR would draw from a different counter)', () =>
  assert.match(missingForMake({ ...base, origin: 'KAHSR' })[0], /not KA-HSR or MH-HQ/));
ok('no destination blocks it', () => assert.deepStrictEqual(missingForMake({ ...base, deliveryCode: '' }), ['the destination store']));
ok('a store cannot send to itself', () => assert.match(missingForMake({ ...base, deliveryCode: 'KA-HSR' })[0], /different/));
ok('ship outside needs a customer address', () => assert.match(missingForMake({ ...base, shipOutside: true })[0], /customer/));
ok('ship outside ignores the destination store', () =>
  assert.deepStrictEqual(missingForMake({ ...base, shipOutside: true, deliveryCode: '', address: addr }), []));
ok('an empty draft blocks it', () => assert.match(missingForMake({ ...base, productLines: 0 })[0], /product line/));

console.log(`challan: ${n} passed`);
