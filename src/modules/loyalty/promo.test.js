'use strict';
// Offline test: the repo's own modules are real; core/* and integrations are faked, nothing dials out.
const assert = require('assert');
const Module = require('module');

const rows = [];
let minted = null;
const builder = (result) => {
  const b = new Proxy({}, { get: (_, k) => {
    if (k === 'then') return (res) => res(result);
    if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve({ data: { id: 1 }, error: null });
    if (k === 'insert') return (row) => { rows.push(row); return b; };
    return () => b;
  } });
  return b;
};
const fakeSupabase = { from: () => builder({ data: [], count: 0, error: null }) };
const fakeGraphql = async (q, vars) => {
  if (q.includes('shop {')) return { shop: { metafield: null } };               // -> default config
  if (q.includes('nodes(ids')) return { nodes: [
    { id: 'gid://shopify/ProductVariant/11', sku: 'R100', price: '100000', diamond: { value: '80000' }, jewel: { value: 'R100' }, product: { title: 'Ring', productType: 'Ring', tags: [], collections: { nodes: [] } } },
    { id: 'gid://shopify/ProductVariant/22', sku: 'SCOIN|S|999', price: '9000', diamond: { value: '500' }, jewel: null, product: { title: 'Coin', productType: 'Coin', tags: [], collections: { nodes: [] } } },
  ] };
  if (q.includes('discountCodeBasicCreate')) { minted = vars.d; return { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } }; }
  return {};
};
const quiet = new Proxy(function () {}, { get: () => quiet, apply: () => quiet });
const stubs = {
  '../../core/shopify': { graphql: fakeGraphql },
  '../../core/supabase': { supabase: fakeSupabase },
  '../../core/logger': { log: { info() {}, warn() {}, error() {} } },
};
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (stubs[req]) return stubs[req];
  if (/^\.\.\/\.\.\/|^\.\.\/adjustments/.test(req)) return quiet;
  return orig.apply(this, arguments);
};

const E = require('./engine');
const { DEFAULT_CONFIG, normalizeConfig } = require('./config');
const promo = require('./promo');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

(async () => {
  const cfg = normalizeConfig(DEFAULT_CONFIG);
  await t('default config carries ISB10 at 10%', () => assert.strictEqual(cfg.promos.ISB10.pct, 10));
  await t('a config saved before promos existed still gets ISB10', () => assert.strictEqual(normalizeConfig({ tiers: DEFAULT_CONFIG.tiers }).promos.ISB10.pct, 10));
  await t('promos: {} switches every promo off', () => assert.deepStrictEqual(normalizeConfig({ ...DEFAULT_CONFIG, promos: {} }).promos, {}));
  await t('a bad promo is skipped, tiers untouched', () => {
    const c = normalizeConfig({ ...DEFAULT_CONFIG, promos: { isb10: { pct: 10 }, BAD: { pct: 500 } } });
    assert.deepStrictEqual(Object.keys(c.promos), ['ISB10']);
    assert.strictEqual(c.tiers.length, 3);
  });

  const line = (o = {}) => ({ sku: 'R100', productType: 'Ring', tags: [], collections: [], jewelCode: 'R100', diamond: 80000, ...o });
  await t('10% of the diamond only, not of the price', () => {
    const r = promo.computePromo({ promo: cfg.promos.ISB10, lines: [line()], cfg });
    assert.ok(r.ok); assert.strictEqual(r.total, 8000);
  });
  await t('ineligible lines (SCOIN, no diamond) get nothing', () => {
    const r = promo.computePromo({ promo: cfg.promos.ISB10, lines: [line({ diamond: 10000 }), line({ sku: 'SCOIN', diamond: 500 }), line({ diamond: 0 })], cfg });
    assert.deepStrictEqual(r.perLine.map(l => l.discount), [1000, 0, 0]);
  });
  await t('nothing eligible -> not ok', () => assert.strictEqual(promo.computePromo({ promo: cfg.promos.ISB10, lines: [line({ diamond: 0 })], cfg }).ok, false));

  await t('unknown code is passed back to the drawer as a normal Shopify code', async () => {
    assert.deepStrictEqual(await promo.createPromoCode('5', 'FNF5', [{ variant_id: 11, quantity: 1 }]), { ok: false, notPromo: true });
  });
  await t('ISB10 (any case) mints one PRM- code: 10% of 80,000 = 8,000 + GST = 8,240, ring only', async () => {
    const r = await promo.createPromoCode('5', ' isb10 ', [{ variant_id: 11, quantity: 1 }, { variant_id: 22, quantity: 1 }]);
    assert.ok(r.ok, JSON.stringify(r)); assert.ok(r.code.startsWith('PRM-')); assert.strictEqual(r.amount, 8240); assert.strictEqual(r.label, 'ISB10');
    assert.strictEqual(minted.customerGets.value.discountAmount.amount, '8240.00');
    assert.deepStrictEqual(minted.customerGets.items.products.productVariantsToAdd, ['gid://shopify/ProductVariant/11']);
    assert.strictEqual(minted.usageLimit, 1);
    assert.deepStrictEqual(minted.combinesWith, { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true });
    assert.strictEqual(rows[0].promo_code, 'ISB10'); assert.strictEqual(rows[0].channel, 'online');
  });
  await t('a guest can use it too', async () => {
    const r = await promo.createPromoCode('', 'ISB10', [{ variant_id: 11, quantity: 2 }]);
    assert.ok(r.ok); assert.strictEqual(r.amount, 16480); assert.strictEqual(rows[1].customer_id, 'guest');
  });
  await t('quantity multiplies the diamond value', async () => assert.strictEqual(rows[1].diamond_base, 160000));
  await t('an empty cart is refused', async () => assert.strictEqual((await promo.createPromoCode('5', 'ISB10', [])).ok, false));
  console.log(`\n${n} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
