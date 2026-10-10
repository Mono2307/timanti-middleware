const assert = require('assert');
const { isCommsTag, commsTagsFromMetafields } = require('./comms_tags');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('commsTagsFromMetafields');
t('mirrors all three routing fields, lowercased', () => {
  assert.deepStrictEqual(
    commsTagsFromMetafields({ channel: 'Offline', order_type: 'mto', shipment: 'No' }),
    ['ch:offline', 'ot:mto', 'ship:no']);
});
t('in-stock keeps its hyphen', () => {
  assert.deepStrictEqual(commsTagsFromMetafields({ order_type: 'in-stock' }), ['ot:in-stock']);
});
t('blank or missing fields emit nothing', () => {
  assert.deepStrictEqual(commsTagsFromMetafields({ channel: '  ', shipment: null }), []);
  assert.deepStrictEqual(commsTagsFromMetafields({}), []);
  assert.deepStrictEqual(commsTagsFromMetafields(null), []);
});
t('ignores unrelated metafields', () => {
  assert.deepStrictEqual(commsTagsFromMetafields({ in_store_sale: 'Yes', state_code: 'KA-HSR' }), []);
});

console.log('isCommsTag');
t('matches only the three prefixes', () => {
  for (const tag of ['ch:offline', 'OT:mto', ' ship:yes']) assert.ok(isCommsTag(tag), tag);
  for (const tag of ['in-store-sale', 'pmodes:card', 'channel-offline', 'chq:1', 'i1:100@card@']) assert.ok(!isCommsTag(tag), tag);
});

console.log(`\n${n} passed`);
