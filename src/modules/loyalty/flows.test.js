'use strict';

// Behaviour tests for the in-store draft step, the pricing hook and order earning, with Shopify and
// Supabase replaced by in-memory fakes. What is asserted is what staff and customers would see:
// tags, the stored loyalty decision, the per-line entries the pricing engine receives, ledger rows.

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_URL         ||= 'https://loyalty-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://loyalty-test.invalid';
process.env.LOYALTY_ENABLED = 'true';

const ROOT = path.join(__dirname, '..', '..', '..');
const stub = (rel, exports) => {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// ── fake Shopify ────────────────────────────────────────────────────────────────────────────────
const shop = { draftMf: {}, draftTags: {}, customers: {}, variants: {}, orderMf: {}, deleted: [], discountsDeleted: [] };
const mfList = (id) => Object.entries(shop.draftMf[id] || {}).map(([key, value], i) => ({ id: `${id}-${i}-${key}`, namespace: 'custom', key, value }));
stub('src/core/shopify.js', {
  API_VERSION: '2024-01',
  getShopifyToken: async () => 'tok',
  shopifyHeaders: () => ({}),
  restUrl: (p) => p,
  getJson: async (p) => {
    const m = p.match(/^draft_orders\/(\d+)\/metafields\.json$/);
    if (m) return { metafields: mfList(m[1]) };
    throw new Error('unexpected GET ' + p);
  },
  putJson: async (p, body) => {
    const m = p.match(/^draft_orders\/(\d+)\.json$/);
    if (m) { shop.draftTags[m[1]] = body.draft_order.tags; return {}; }
    throw new Error('unexpected PUT ' + p);
  },
  deleteJson: async (p) => {
    const m = p.match(/^draft_orders\/(\d+)\/metafields\/\d+-\d+-(\w+)\.json$/);
    if (m) { delete shop.draftMf[m[1]][m[2]]; shop.deleted.push(m[2]); return {}; }
    throw new Error('unexpected DELETE ' + p);
  },
  graphql: async (q, vars) => {
    if (/nodes\(ids/.test(q) && /ProductVariant/.test(q)) {
      return { nodes: vars.ids.map(g => { const id = g.split('/').pop(); const v = shop.variants[id]; return v ? { id: g, ...v } : null; }) };
    }
    if (/customer\(id/.test(q)) {
      const id = vars.id.split('/').pop();
      const c = shop.customers[id];
      return { customer: c ? { id: vars.id, email: 'a@b.c', firstName: 'Asha', lastName: 'R', displayName: 'Asha R', tags: c.tags || [],
        birthday: c.birthday ? { value: c.birthday } : null, anniversary: null,
        tier: c.tier ? { value: c.tier } : null, tierSince: null, points: c.points != null ? { value: String(c.points) } : null } : null };
    }
    if (/order\(id/.test(q)) return { order: { refunded: null } };
    if (/metafieldsSet/.test(q)) {
      for (const m of vars.m) {
        const id = m.ownerId.split('/').pop();
        shop.customers[id] = shop.customers[id] || { tags: [] };
        if (m.key === 'tier') shop.customers[id].tier = m.value;
        if (m.key === 'points') shop.customers[id].points = Number(m.value);
      }
      return { metafieldsSet: { userErrors: [] } };
    }
    if (/tagsAdd/.test(q)) { const id = vars.id.split('/').pop(); shop.customers[id].tags.push(...vars.tags); return { tagsAdd: { userErrors: [] } }; }
    if (/tagsRemove/.test(q)) { const id = vars.id.split('/').pop(); shop.customers[id].tags = shop.customers[id].tags.filter(t => !vars.tags.includes(t)); return { tagsRemove: { userErrors: [] } }; }
    if (/discountCodeDelete/.test(q)) { shop.discountsDeleted.push(vars.id); return { discountCodeDelete: { userErrors: [] } }; }
    if (/shop \{ metafield/.test(q) || /\{ shop \{/.test(q)) return { shop: { metafield: null } };
    throw new Error('unexpected GraphQL ' + q.slice(0, 60));
  },
});
stub('src/core/metafields.js', {
  getMetafieldType: () => 'single_line_text_field',
  updateDraftOrderMetafields: async (id, fields) => { shop.draftMf[id] = { ...(shop.draftMf[id] || {}), ...fields }; },
  updateOrderMetafields: async (id, fields) => { shop.orderMf[id] = { ...(shop.orderMf[id] || {}), ...fields }; },
  updateMetafields: async () => {},
});
stub('src/integrations/email/index.js', { sendEmail: async () => {}, withStoreCc: () => [] });

// ── fake ledger ─────────────────────────────────────────────────────────────────────────────────
const db = { ledger: {}, redemptions: [] };
stub('src/modules/loyalty/ledger.js', {
  upsertOrderEntry: async (_s, { customerId, orderId, orderName, points, kind }) => {
    const k = `order:${orderId}`;
    const prior = db.ledger[k];
    if (prior && prior.customer_id === String(customerId) && prior.points === points) return { changed: false, previousCustomerId: prior.customer_id };
    db.ledger[k] = { customer_id: String(customerId), points, kind, order_name: orderName };
    return { changed: true, previousCustomerId: prior ? prior.customer_id : null };
  },
  customerPoints: async (_s, cid) => Object.values(db.ledger).filter(r => r.customer_id === String(cid)).reduce((s, r) => s + r.points, 0),
  insertRedemption: async (_s, row) => { db.redemptions.push({ id: db.redemptions.length + 1, ...row }); return { id: db.redemptions.length }; },
  getRedemptionByCode: async (_s, code) => db.redemptions.find(r => r.code === code) || null,
  updateRedemption: async (_s, id, patch) => Object.assign(db.redemptions.find(r => r.id === id), patch),
  storeRedemptionForDraft: async (_s, d) => db.redemptions.find(r => r.channel === 'store' && r.draft_id === String(d)) || null,
  customerEntries: async () => [], addAdjustment: async () => {}, pendingCodesFor: async () => [],
  expiredPendingCodes: async () => [], codesIssuedSince: async () => 0,
});

const draftMod = require('./draft');
const earn = require('./earn');
const E = require('./engine');

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// A draft with one diamond ring, one gold coin (excluded SKU) and an exchange-note line.
const DRAFT_ID = '9001';
const makeDraft = (tags, extra = {}) => ({
  id: Number(DRAFT_ID), name: '#D900', tags, customer: { id: 501 },
  line_items: [
    { variant_id: 11, title: 'Solitaire Ring', quantity: 1, price: '103000', properties: [{ name: 'Gold', value: 'Rs40000' }, { name: 'Diamond', value: 'Rs60000' }, { name: '_jewel_code', value: 'R1' }] },
    { variant_id: 22, title: 'Gold Coin', quantity: 1, price: '10300', properties: [{ name: 'Gold', value: 'Rs10000' }] },
    { title: 'Exchange Note EXC-1', quantity: 1, price: '-5000', properties: [{ name: '_exc_ref', value: 'EXC-1' }] },
  ],
  ...extra,
});
shop.variants = {
  11: { sku: 'R1', diamond: { value: '60000' }, jewel: { value: 'R1' }, product: { productType: 'Ring', tags: [], collections: { nodes: [] } } },
  22: { sku: 'SCOIN', diamond: null, jewel: null, product: { productType: 'Coin', tags: [], collections: { nodes: [] } } },
};
shop.customers['501'] = { tags: [], birthday: null };
db.ledger['order:1'] = { customer_id: '501', points: 620000, kind: 'backfill' };   // Gold tier

t('apply: gold customer gets 5% on the ring only, tags and record written', async () => {
  shop.draftMf[DRAFT_ID] = {};
  await draftMod.handleLoyaltyStep(makeDraft('apply-loyalty'));
  const applied = E.readApplied(shop.draftMf[DRAFT_ID].loyalty_applied);
  assert.strictEqual(applied.tier, 'T2');
  assert.strictEqual(applied.rate, 5);
  assert.deepStrictEqual(applied.eligible_variants, ['11']);
  const tags = shop.draftTags[DRAFT_ID].split(', ');
  assert.ok(tags.includes('loyalty-applied') && tags.includes('reprice') && !tags.includes('apply-loyalty'));
});

t('pricing hook: the engine receives a 5% diamond entry on the ring and nothing on the coin', async () => {
  const mfMap = { ...shop.draftMf[DRAFT_ID], discount_applied: '3000' };
  draftMod.applyLoyaltyToPricingInputs(mfMap, makeDraft('loyalty-applied'));
  const arr = JSON.parse(mfMap.line_discounts);
  // Product lines only, in the engine's order: ring, coin. The exchange note is not a product line.
  assert.strictEqual(arr.length, 2);
  assert.deepStrictEqual(arr[0], [{ t: 'dia', m: 'pct', v: 5, src: 'loyalty' }]);
  assert.deepStrictEqual(arr[1], []);
  assert.strictEqual(mfMap.discount_applied, undefined, 'order-level keys are dropped while loyalty is on');
});

t('maintenance pass with nothing changed does nothing', async () => {
  const before = shop.draftTags[DRAFT_ID];
  shop.draftTags[DRAFT_ID] = 'untouched';
  await draftMod.handleLoyaltyStep(makeDraft('loyalty-applied'));
  assert.strictEqual(shop.draftTags[DRAFT_ID], 'untouched');
  shop.draftTags[DRAFT_ID] = before;
});

t('adding a piece re-evaluates and covers the new eligible line', async () => {
  shop.variants[33] = { sku: 'E1', diamond: { value: '20000' }, jewel: { value: 'E1' }, product: { productType: 'Earring', tags: [], collections: { nodes: [] } } };
  const d = makeDraft('loyalty-applied');
  d.line_items.push({ variant_id: 33, title: 'Studs', quantity: 1, price: '30000', properties: [] });
  await draftMod.handleLoyaltyStep(d);
  const applied = E.readApplied(shop.draftMf[DRAFT_ID].loyalty_applied);
  assert.deepStrictEqual(applied.eligible_variants.sort(), ['11', '33']);
  assert.ok(shop.draftTags[DRAFT_ID].includes('reprice'));
});

t('a discount code added on top takes loyalty off and says why', async () => {
  shop.draftMf[DRAFT_ID].discount_codes = '[{"code":"FNF5","kind":"code","mode":"pct","rate":5}]';
  await draftMod.handleLoyaltyStep(makeDraft('loyalty-applied'));
  assert.strictEqual(shop.draftMf[DRAFT_ID].loyalty_applied, undefined);
  const tags = shop.draftTags[DRAFT_ID];
  assert.ok(/loyalty-invalid: removed, other discount/.test(tags));
  assert.ok(!/loyalty-applied/.test(tags));
  assert.ok(/Loyalty was taken off/.test(shop.draftMf[DRAFT_ID].loyalty_note));
  delete shop.draftMf[DRAFT_ID].discount_codes;
});

t('apply is refused while another discount is on the draft', async () => {
  shop.draftMf[DRAFT_ID] = { discount_rate: '10' };
  await draftMod.handleLoyaltyStep(makeDraft('apply-loyalty'));
  assert.ok(/loyalty-invalid: other discount/.test(shop.draftTags[DRAFT_ID]));
  assert.strictEqual(shop.draftMf[DRAFT_ID].loyalty_applied, undefined);
});

t('apply is refused below the first tier, with the spend in the note', async () => {
  shop.draftMf[DRAFT_ID] = {};
  shop.customers['777'] = { tags: [] };
  await draftMod.handleLoyaltyStep(makeDraft('apply-loyalty', { customer: { id: 777 } }));
  assert.ok(/loyalty-invalid: below tier/.test(shop.draftTags[DRAFT_ID]));
  assert.ok(/below the first tier/.test(shop.draftMf[DRAFT_ID].loyalty_note));
});

t('apply is refused with no customer on the draft', async () => {
  shop.draftMf[DRAFT_ID] = {};
  await draftMod.handleLoyaltyStep(makeDraft('apply-loyalty', { customer: null }));
  assert.ok(/loyalty-invalid: no customer/.test(shop.draftTags[DRAFT_ID]));
});

t('every tag written fits Shopify\'s 40-character limit', async () => {
  for (const tag of String(shop.draftTags[DRAFT_ID]).split(', ')) assert.ok(tag.length <= 40, tag);
  assert.ok('loyalty-invalid: removed, other discount'.length <= 40);
});

t('remove-loyalty clears the record and the stale discount_applied', async () => {
  shop.draftMf[DRAFT_ID] = {};
  await draftMod.handleLoyaltyStep(makeDraft('apply-loyalty'));
  shop.draftMf[DRAFT_ID].discount_applied = '3000';
  await draftMod.handleLoyaltyStep(makeDraft('loyalty-applied, remove-loyalty'));
  assert.strictEqual(shop.draftMf[DRAFT_ID].loyalty_applied, undefined);
  assert.strictEqual(shop.draftMf[DRAFT_ID].discount_applied, undefined);
  const tags = shop.draftTags[DRAFT_ID];
  assert.ok(!/loyalty-applied|remove-loyalty/.test(tags) && /reprice/.test(tags));
});

t('conversion records one store redemption, once', async () => {
  shop.draftMf[DRAFT_ID] = {};
  await draftMod.handleLoyaltyStep(makeDraft('apply-loyalty'));
  shop.draftMf[DRAFT_ID].discount_applied = '3000.00';
  await draftMod.recordStoreRedemption(makeDraft('loyalty-applied'), 7001, '#1100');
  await draftMod.recordStoreRedemption(makeDraft('loyalty-applied'), 7001, '#1100');
  const rows = db.redemptions.filter(r => r.channel === 'store');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].discount_pre_tax, 3000);
  assert.strictEqual(rows[0].diamond_base, 60000);
});

t('earning: an in-store order lifts the customer from Gold to Platinum and tags them', async () => {
  await earn.processOrder({ id: 7001, name: '#1100', total_price: '400000', source_name: 'shopify_draft_order', customer: { id: 501 }, line_items: [{ title: 'Ring', price: '400000', quantity: 1 }] });
  assert.strictEqual(db.ledger['order:7001'].points, 400000);
  assert.strictEqual(shop.customers['501'].tier, 'T3');
  assert.deepStrictEqual(shop.customers['501'].tags, ['loyalty-T3']);
});

t('earning: a duplicate delivery changes nothing', async () => {
  const before = JSON.stringify(shop.customers['501']);
  await earn.processOrder({ id: 7001, name: '#1100', total_price: '400000', customer: { id: 501 }, line_items: [] });
  assert.strictEqual(JSON.stringify(shop.customers['501']), before);
});

t('earning: a refund brings the points down and the tier with them', async () => {
  await earn.processOrder({ id: 7001, name: '#1100', total_price: '400000', customer: { id: 501 }, line_items: [],
    refunds: [{ transactions: [{ kind: 'refund', status: 'success', amount: '400000' }] }] });
  assert.strictEqual(db.ledger['order:7001'].points, 0);
  assert.strictEqual(shop.customers['501'].tier, 'T2');
  assert.deepStrictEqual(shop.customers['501'].tags, ['loyalty-T2']);
});

t('online: the LOY code is settled and the order credited to whoever asked for it', async () => {
  db.redemptions.push({ id: 99, code: 'LOY-ABC123', channel: 'online', status: 'pending', customer_id: '501', tier: 'T2', rate: 5, discount_incl_tax: 3090, discount_node_id: 'gid://shopify/DiscountCodeNode/1' });
  shop.customers['888'] = { tags: [] };
  await earn.processOrder({ id: 7002, name: '#1101', total_price: '100000', customer: { id: 888 },
    discount_codes: [{ code: 'LOY-ABC123', amount: '3090.00' }], line_items: [] });
  const red = db.redemptions.find(r => r.id === 99);
  assert.strictEqual(red.status, 'used');
  assert.strictEqual(red.customer_mismatch, true, 'GoKwik attached the order to a different customer');
  assert.strictEqual(db.ledger['order:7002'].customer_id, '501', 'points go to the code owner');
  assert.strictEqual(shop.orderMf['7002'].loyalty_customer_id, '501');
  assert.deepStrictEqual(shop.discountsDeleted, ['gid://shopify/DiscountCodeNode/1']);
});

t('app proxy: a correctly signed request passes, a tampered customer id does not', async () => {
  const { verifyProxySignature } = require('./online');
  const crypto = require('crypto');
  const q = { shop: 'timanti.myshopify.com', logged_in_customer_id: '501', path_prefix: '/apps/loyalty', timestamp: '1700000000', extra: ['a', 'b'] };
  const msg = Object.keys(q).sort().map(k => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : q[k]}`).join('');
  const signature = crypto.createHmac('sha256', 'shpss_secret').update(msg).digest('hex');
  assert.ok(verifyProxySignature({ ...q, signature }, ['wrong', 'shpss_secret']));
  assert.ok(!verifyProxySignature({ ...q, logged_in_customer_id: '999', signature }, ['shpss_secret']));
  assert.ok(!verifyProxySignature({ ...q }, ['shpss_secret']), 'unsigned is refused');
  assert.ok(!verifyProxySignature({ ...q, signature }, []), 'no secret configured is refused');
});

t('server.js: the pricing hook runs AFTER the draft metafields are read (regression, 2026-10-09)', async () => {
  // A mis-applied patch once put the hook above `const mfMap = {}`, which threw on every reprice of
  // every draft ("Cannot access 'mfMap' before initialization").
  const src = require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function handleRecalculatePriceTag'));
  const decl = fn.indexOf('const mfMap = {}');
  const hook = fn.indexOf('applyLoyaltyToPricingInputs(mfMap');
  assert.ok(decl > 0 && hook > 0, 'hook or declaration missing');
  assert.ok(hook > decl, 'loyalty hook is above the mfMap declaration');
});

(async () => {
  for (const [name, fn] of tests) { await fn(); n++; console.log('  ok  ' + name); }
  console.log(`\n${n} assertions passed`);
})().catch(e => { console.error(e); process.exit(1); });
