'use strict';
// Offline test: the repo's own modules are real; core/* and integrations are faked, nothing dials out.
const assert = require('assert');
const Module = require('module');

const rows = [];
const updates = [];
const deleted = [];
let minted = null;
// Per-test state: the member's ledger points, their live codes, and redemptions looked up by code.
const db = { points: 0, pending: [], byCode: {} };
const builder = (table) => {
  let code = null;
  let patchRow = null;
  const b = new Proxy({}, { get: (_, k) => {
    if (k === 'then') {
      const data = patchRow ? null : table === 'loyalty_ledger' ? [{ points: db.points }] : db.pending;
      if (patchRow) updates.push(patchRow);
      return (res) => res({ data, count: 0, error: null });
    }
    if (k === 'single') return () => Promise.resolve({ data: { id: 1 }, error: null });
    if (k === 'maybeSingle') return () => Promise.resolve({ data: db.byCode[code] || null, error: null });
    if (k === 'insert') return (row) => { rows.push(row); return b; };
    if (k === 'update') return (p) => { patchRow = { ...p }; return b; };
    if (k === 'eq') return (col, v) => { if (col === 'code') code = v; if (patchRow && col === 'id') patchRow.id = v; return b; };
    return () => b;
  } });
  return b;
};
const fakeSupabase = { from: (table) => builder(table) };
const fakeGraphql = async (q, vars) => {
  if (q.includes('shop {')) return { shop: { metafield: null } };               // -> default config
  if (q.includes('nodes(ids')) return { nodes: [
    { id: 'gid://shopify/ProductVariant/11', sku: 'R100', price: '100000', diamond: { value: '80000' }, making: { value: '20000' }, jewel: { value: 'R100' }, product: { title: 'Ring', productType: 'Ring', tags: [], collections: { nodes: [] } } },
    { id: 'gid://shopify/ProductVariant/22', sku: 'SCOIN|S|999', price: '9000', diamond: { value: '500' }, jewel: null, product: { title: 'Coin', productType: 'Coin', tags: [], collections: { nodes: [] } } },
  ] };
  if (q.includes('discountCodeBasicCreate')) { minted = vars.d; return { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } }; }
  if (q.includes('discountCodeDelete')) { deleted.push(vars.id); return { discountCodeDelete: { userErrors: [] } }; }
  // Customer 7 is a member; anyone else is not found.
  if (q.includes('customer(id')) return { customer: vars.id === 'gid://shopify/Customer/7' ? { id: vars.id, firstName: 'Test', tags: [] } : null };
  return {};
};
const quiet = new Proxy(function () {}, { get: () => quiet, apply: () => quiet });
const stubs = {
  '../../core/shopify': { graphql: fakeGraphql },
  '../../core/supabase': { supabase: fakeSupabase },
  '../../core/logger': { log: { info() {}, warn() {}, error() {} } },
  '../../core/metafields': { updateOrderMetafields: async () => {} },
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
const online = require('./online');
const earn = require('./earn');
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

  // Promo + loyalty STACK (founder, 2026-10-26): one code worth both.
  const cart = [{ variant_id: 11, quantity: 1 }, { variant_id: 22, quantity: 1 }];
  db.points = 600000; // Gold: 7% of diamond + 20% of making, making cut capped at 5,000
  await t('a Gold member typing ISB10 gets ONE code: 8,000 promo + 5,600 + 4,000 loyalty = 17,600 + GST = 18,128', async () => {
    const r = await promo.createPromoCode('7', 'ISB10', cart);
    assert.ok(r.ok, JSON.stringify(r)); assert.ok(r.code.startsWith('PRM-'));
    assert.strictEqual(r.amount, 18128);
    assert.strictEqual(r.promo_amount, 8240);
    assert.deepStrictEqual(r.loyalty, { tier: 'Gold', rate: 7, making_pct: 20, amount: 9888 });
    assert.strictEqual(minted.customerGets.value.discountAmount.amount, '18128.00');
    assert.deepStrictEqual(minted.customerGets.items.products.productVariantsToAdd, ['gid://shopify/ProductVariant/11']);
    const row = rows[rows.length - 1];
    assert.strictEqual(row.promo_code, 'ISB10'); assert.strictEqual(row.tier, 'T2'); assert.strictEqual(row.rate, 7);
    assert.strictEqual(row.discount_pre_tax, 17600);
    assert.deepStrictEqual(row.lines.promo, { code: 'ISB10', pct: 10, pre_tax: 8000 });
    assert.strictEqual(row.lines.loyalty.pre_tax, 9600);
    assert.deepStrictEqual([row.lines.perLine[0].discount, row.lines.perLine[0].loyalty_discount, row.lines.perLine[0].making_discount], [8000, 5600, 4000]);
  });
  await t('below the first tier ISB10 still works alone', async () => {
    db.points = 1000;
    const r = await promo.createPromoCode('7', 'ISB10', cart);
    assert.strictEqual(r.amount, 8240); assert.strictEqual(r.loyalty, null); assert.strictEqual(rows[rows.length - 1].tier, undefined);
    db.points = 600000;
  });
  await t('loyalty applied while ISB10 is on the cart re-mints ONE combined code and retires the old one', async () => {
    db.pending = [{ id: 99, code: 'PRM-OLD', promo_code: 'ISB10', discount_node_id: 'gid://shopify/DiscountCodeNode/99', discount_incl_tax: 8240,
      expires_at: new Date(Date.now() + 3600e3).toISOString(), status: 'pending', lines: { signature: '11x1,22x1' } }];
    deleted.length = 0; updates.length = 0;
    const r = await online.createCartCode('7', cart);
    assert.ok(r.ok, JSON.stringify(r)); assert.ok(r.code.startsWith('PRM-')); assert.strictEqual(r.amount, 18128);
    assert.strictEqual(r.tier, 'Gold'); assert.strictEqual(r.rate, 7);
    assert.deepStrictEqual(deleted, ['gid://shopify/DiscountCodeNode/99']);
    assert.ok(updates.some(u => u.id === 99 && u.status === 'expired'), JSON.stringify(updates));
  });
  await t('ISB10 typed while a loyalty code is on the cart retires the loyalty code', async () => {
    db.pending = [{ id: 98, code: 'LOY-OLD', tier: 'T2', discount_node_id: 'gid://shopify/DiscountCodeNode/98', discount_incl_tax: 9888,
      expires_at: new Date(Date.now() + 3600e3).toISOString(), status: 'pending', lines: { signature: '11x1,22x1' } }];
    deleted.length = 0;
    const r = await promo.createPromoCode('7', 'ISB10', cart);
    assert.strictEqual(r.amount, 18128);
    assert.deepStrictEqual(deleted, ['gid://shopify/DiscountCodeNode/98']);
    db.pending = [];
  });
  await t('the order settles a stacked PRM- code as the loyalty code: member credited, plain promo settlement skips it', async () => {
    db.byCode['PRM-BOTH'] = { id: 50, code: 'PRM-BOTH', customer_id: '7', tier: 'T2', rate: 7, promo_code: 'ISB10', status: 'pending', discount_incl_tax: 18128, discount_node_id: 'n50' };
    updates.length = 0;
    const order = { id: 1, name: '#2000', customer: { id: 7 }, discount_codes: [{ code: 'PRM-BOTH', amount: '18128.00' }] };
    await earn.settlePromoCode(order);
    assert.strictEqual(updates.length, 0, 'settlePromoCode leaves a stacked code alone');
    const who = await earn.settleOnlineCode(order, normalizeConfig(DEFAULT_CONFIG));
    assert.strictEqual(who, '7');
    assert.ok(updates.some(u => u.id === 50 && u.status === 'used'));
  });
  await t('a plain PRM- code is still settled as a promo and credits nobody', async () => {
    db.byCode['PRM-ONLY'] = { id: 51, code: 'PRM-ONLY', customer_id: 'guest', promo_code: 'ISB10', status: 'pending', discount_incl_tax: 8240 };
    updates.length = 0;
    const order = { id: 2, name: '#2001', discount_codes: [{ code: 'PRM-ONLY', amount: '8240.00' }] };
    assert.strictEqual(await earn.settleOnlineCode(order, normalizeConfig(DEFAULT_CONFIG)), null);
    await earn.settlePromoCode(order);
    assert.ok(updates.some(u => u.id === 51 && u.status === 'used'));
  });
  console.log(`\n${n} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
