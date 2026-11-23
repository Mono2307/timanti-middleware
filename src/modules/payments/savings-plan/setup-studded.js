'use strict';

// One-off: make the Shopify side of "studded jewellery only" for Savings Scheme Vouchers (founder,
// 23 Nov 2026; redeem.js STUDDED_HANDLE). Safe to run again: each step checks first.
//   1. the variant metafield custom.price_breakup_diamond ("Diamond Component (₹)") may be used in
//      automated collections (a capability switch on the definition)
//   2. an automated collection, handle savings-voucher-studded: variant diamond value > 0. It is not
//      published to any sales channel — it only scopes the discount codes.
//   3. every open Savings Scheme Voucher's code is limited to that collection.
//
//   node src/modules/payments/savings-plan/setup-studded.js           dry run: says what it would do
//   node src/modules/payments/savings-plan/setup-studded.js --apply   does it

const { graphql, putJson } = require('../../../core/shopify');
const { supabase } = require('../../../core/supabase');
const { STUDDED_HANDLE, studdedCollectionId } = require('./redeem');

const DEF = `metafieldDefinitions(first: 1, ownerType: PRODUCTVARIANT, namespace: "custom", key: "price_breakup_diamond") {
  nodes { id capabilities { smartCollectionCondition { enabled eligible } } } }`;

async function run({ apply = false } = {}) {
  const out = [];
  const d = (await graphql(`{ ${DEF} }`)).metafieldDefinitions.nodes[0];
  if (!d) throw new Error('no custom.price_breakup_diamond variant metafield definition');
  if (!d.capabilities.smartCollectionCondition.enabled) {
    out.push('enable the diamond value as a collection condition');
    if (apply) {
      await graphql(`mutation($d: MetafieldDefinitionUpdateInput!) { metafieldDefinitionUpdate(definition: $d) { userErrors { field message } } }`,
        { d: { namespace: 'custom', key: 'price_breakup_diamond', ownerType: 'PRODUCTVARIANT', capabilities: { smartCollectionCondition: { enabled: true } } } });
    }
  }
  let col = await studdedCollectionId({ graphql });
  if (!col) {
    out.push(`create the collection ${STUDDED_HANDLE} (variant diamond value > 0)`);
    if (apply) {
      const r = await graphql(`mutation($c: CollectionInput!) { collectionCreate(input: $c) { collection { legacyResourceId productsCount { count } } userErrors { field message } } }`,
        { c: { title: 'Savings voucher — studded jewellery', handle: STUDDED_HANDLE,
          descriptionHtml: '<p>Every product with a diamond value. Scopes Savings Scheme Voucher codes; not shown on the store.</p>',
          ruleSet: { appliedDisjunctively: false, rules: [{ column: 'VARIANT_METAFIELD_DEFINITION', relation: 'GREATER_THAN', condition: '0', conditionObjectId: d.id }] } } });
      col = String(r.collectionCreate.collection.legacyResourceId);
      out.push(`created ${col}`);
    }
  }
  const { data: open, error } = await supabase.from('credit_instruments').select('serial_code, price_rule_id, status')
    .eq('instrument_type', 'voucher').ilike('serial_code', 'SSV%').in('status', ['open', 'applied']);
  if (error) throw new Error(error.message);
  for (const v of open || []) {
    if (!v.price_rule_id) continue;
    out.push(`limit ${v.serial_code} to studded pieces`);
    if (apply && col) {
      await putJson(`price_rules/${v.price_rule_id}.json`, { price_rule: { id: Number(v.price_rule_id), target_selection: 'entitled', entitled_collection_ids: [Number(col)] } })
        .catch(e => out.push(`  ${v.serial_code}: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`));
    }
  }
  return { apply, collection: col, steps: out };
}

if (require.main === module) {
  run({ apply: process.argv.includes('--apply') })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e.response?.data ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
}

module.exports = { run };
