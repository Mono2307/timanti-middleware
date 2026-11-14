'use strict';
// Offline test of the referral programme (referral.js + its engine maths). The repo's own modules
// are real; Shopify and Supabase are in-memory fakes, nothing dials out.
const assert = require('assert');
const Module = require('module');

// ── In-memory Supabase ─────────────────────────────────────────────────────────────────────────
const tables = {};
const UNIQUE = { referral_codes: ['customer_id', 'code'], referral_claims: ['referee_customer_id'], referral_rewards: ['source_order_id'] };
let nextId = 1;
const T = (name) => (tables[name] = tables[name] || []);
function query(table) {
  const st = { op: 'select', filters: [], returning: false, count: false, order: null, limit: null };
  const run = (single) => {
    const rows = T(table);
    const match = (r) => st.filters.every(f => f(r));
    if (st.op === 'insert') {
      for (const col of UNIQUE[table] || []) {
        if (st.row[col] != null && rows.some(r => String(r[col]) === String(st.row[col]))) {
          return Promise.resolve({ data: null, error: { code: '23505', message: `duplicate ${col}` } });
        }
      }
      const row = { id: nextId++, created_at: new Date().toISOString(), ...st.row };
      rows.push(row);
      return Promise.resolve({ data: st.returning ? [row] : null, error: null });
    }
    if (st.op === 'update') {
      const hit = rows.filter(match);
      hit.forEach(r => Object.assign(r, st.patch));
      return Promise.resolve({ data: st.returning ? hit.map(r => ({ id: r.id })) : null, error: null });
    }
    let out = rows.filter(match);
    if (st.order) out = [...out].sort((a, b) => (String(a[st.order.c]) < String(b[st.order.c]) ? -1 : 1) * (st.order.asc ? 1 : -1));
    if (st.limit) out = out.slice(0, st.limit);
    if (st.count) return Promise.resolve({ data: null, count: out.length, error: null });
    if (single) return Promise.resolve({ data: out[0] ? { ...out[0] } : null, error: null });
    return Promise.resolve({ data: out.map(r => ({ ...r })), error: null });
  };
  const api = {
    select(cols, opts) { if (st.op === 'select') { if (opts && opts.count) st.count = true; } else st.returning = true; return api; },
    insert(row) { st.op = 'insert'; st.row = row; return api; },
    update(p) { st.op = 'update'; st.patch = p; return api; },
    eq(c, v) { st.filters.push(r => String(r[c]) === String(v)); return api; },
    in(c, vs) { st.filters.push(r => vs.includes(r[c])); return api; },
    order(c, o) { st.order = { c, asc: !o || o.ascending !== false }; return api; },
    limit(n) { st.limit = n; return api; },
    maybeSingle() { return run(true); },
    then(res, rej) { return run(false).then(res, rej); },
  };
  return api;
}
const fakeSupabase = { from: (t) => query(t) };

// ── Fake Shopify ───────────────────────────────────────────────────────────────────────────────
// Customers: 100 Priya (referrer, has bought), 200 Rahul (new), 300 Pat (platinum), 400 Old (has bought).
const customers = {
  100: { firstName: 'Priya', email: 'priya@x.in', phone: '+919800000100', numberOfOrders: '3', first: '9001' },
  200: { firstName: 'Rahul', email: 'rahul@x.in', phone: '+919800000200', numberOfOrders: '1', first: '5001' },
  300: { firstName: 'Pat', email: 'pat@x.in', phone: '+919800000300', numberOfOrders: '9', first: '9100' },
  400: { firstName: 'Old', email: 'old@x.in', phone: '+919800000400', numberOfOrders: '2', first: '4000' },
  500: { firstName: 'Neha', email: 'neha@x.in', phone: '+919800000500', numberOfOrders: '0', first: null },
};
// Oldest first, at most 3, like the real connection: `first` is the customer's first order id.
const orderNodes = (c) => Array.from({ length: Math.min(3, Number(c.numberOfOrders) || 0) },
  (_, i) => ({ legacyResourceId: i === 0 ? c.first : `${c.first}-${i}` }));
const tagWrites = [];
const fakeGraphql = async (q, vars) => {
  if (q.includes('shop {')) return { shop: { metafield: null } };   // → default config
  if (q.includes('customer(id')) {
    const id = String(vars.id).split('/').pop();
    const c = customers[id];
    assert.ok(!q.includes('numberOfOrders'), 'numberOfOrders is not in the 2024-01 API');
    return { customer: c ? { id: vars.id, firstName: c.firstName, displayName: c.firstName, email: c.email, phone: c.phone,
      orders: { nodes: orderNodes(c) } } : null };
  }
  if (q.includes('customers(first')) {
    const p = String(vars.q).replace('phone:', '');
    const hit = Object.entries(customers).filter(([, c]) => c.phone === p);
    return { customers: { nodes: hit.map(([id, c]) => ({ id: `gid://shopify/Customer/${id}`, firstName: c.firstName, orders: { nodes: orderNodes(c).slice(0, 1) } })) } };
  }
  return {};
};
const stubs = {
  '../../core/shopify': { graphql: fakeGraphql, putJson: async (p, body) => { tagWrites.push(body.draft_order.tags); } },
  '../../core/supabase': { supabase: fakeSupabase },
  '../../core/config': { config: { loyalty: { enabled: true } } },
  '../../core/logger': { log: { info() {}, warn() {}, error() {} } },
};
const orig = Module._load;
Module._load = function (req) {
  if (stubs[req]) return stubs[req];
  return orig.apply(this, arguments);
};

const E = require('./engine');
const { DEFAULT_CONFIG, normalizeConfig } = require('./config');
const R = require('./referral');
const B = require('../pricing/discount_breakup');
const cfg = normalizeConfig(DEFAULT_CONFIG);

// Lifetime points: Priya Silver-level spend (₹2.5L), Pat Platinum (₹12L).
const points = (cid, p) => T('loyalty_ledger').push({ customer_id: String(cid), points: p });
points(100, 250000);
points(300, 1200000);

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────
test('codes and phones normalise', () => {
  assert.strictEqual(R.normalizeCode(' priya7k '), 'PRIYA7K');
  assert.strictEqual(R.normalizeCode('ab'), '');
  assert.strictEqual(R.normalizePhone('+91 98765 43210'), '9876543210');
  assert.strictEqual(R.normalizePhone('09876543210'), '9876543210');
  assert.strictEqual(R.normalizePhone('12345'), '');
  assert.strictEqual(R.makeCode('Priya-Anne', () => Buffer.from([0, 1, 2])), 'PRIYAAABC');
  assert.strictEqual(R.makeCode('', () => Buffer.from([0, 0, 0])), 'TMAAA');
  assert.strictEqual(R.linkFor('PRIYA7K', cfg), 'https://timanti.in/?ref=PRIYA7K');
});

test('attribution: store tag beats cart attribute beats landing page', () => {
  const base = { note_attributes: [{ name: '_referral', value: 'linkcode' }], landing_site: '/?utm=x&ref=LANDCODE' };
  assert.deepStrictEqual(R.attributionFrom({ ...base, tags: 'referred:STORE1, deposit:fully-paid' }), { code: 'STORE1', via: 'store' });
  assert.deepStrictEqual(R.attributionFrom(base), { code: 'LINKCODE', via: 'link' });
  assert.deepStrictEqual(R.attributionFrom({ landing_site: '/products/x?ref=landcode' }), { code: 'LANDCODE', via: 'landing' });
  assert.strictEqual(R.attributionFrom({ tags: 'loyalty-applied', landing_site: '/' }), null);
});

test('fully paid: store orders need the payment tag, online orders Shopify paid', () => {
  assert.strictEqual(R.isPaidInFull({ source_name: 'shopify_draft_order', financial_status: 'paid', tags: '' }), false);
  assert.strictEqual(R.isPaidInFull({ source_name: 'shopify_draft_order', tags: 'deposit:fully-paid' }), true);
  assert.strictEqual(R.isPaidInFull({ source_name: 'web', financial_status: 'paid' }), true);
  assert.strictEqual(R.isPaidInFull({ source_name: 'web', financial_status: 'pending' }), false);
  assert.strictEqual(R.isPaidInFull({ source_name: 'web', financial_status: 'paid', cancelled_at: '2026-11-01' }), false);
});

test('status moves: awaiting → earned → void; used and rejected are final', () => {
  assert.strictEqual(R.nextStatus('awaiting_payment', { paid: true, dead: false }), 'earned');
  assert.strictEqual(R.nextStatus('awaiting_payment', { paid: false, dead: false }), 'awaiting_payment');
  assert.strictEqual(R.nextStatus('awaiting_payment', { paid: false, dead: true }), 'void');
  assert.strictEqual(R.nextStatus('earned', { paid: true, dead: true }), 'void');
  assert.strictEqual(R.nextStatus('used', { paid: false, dead: true }), 'used');
  assert.strictEqual(R.nextStatus('rejected', { paid: true, dead: false }), 'rejected');
  assert.strictEqual(R.isOpen({ status: 'earned', expires_at: '2020-01-01T00:00:00Z' }), false);
  assert.strictEqual(R.isOpen({ status: 'earned', expires_at: '2999-01-01T00:00:00Z' }), true);
  assert.strictEqual(R.expiryFrom('2026-11-12T10:00:00.000Z', 12), '2027-11-12T10:00:00.000Z');
});

test('config: referral defaults fill in for a config saved before it existed', () => {
  const { referral, ...old } = DEFAULT_CONFIG;
  const c = normalizeConfig({ ...old, emails: {} });
  assert.deepStrictEqual(c.referral, { enabled: true, pct: 10, reward_months: 12, exclude_tiers: ['T3'], link_base: 'https://timanti.in/' });
  assert.strictEqual(c.emails.referral_reward, false);
  assert.strictEqual(normalizeConfig({ ...old, referral: { enabled: false } }).referral.enabled, false);
  assert.strictEqual(R.tierExcluded('T3', c), true);
  assert.strictEqual(R.tierExcluded('T2', c), false);
});

// ── The maths: 10% diamond only, and best-of against loyalty ───────────────────────────────────
const line = (diamond, making, extra = {}) => ({ sku: 'R1', productType: 'Ring', tags: [], collections: [], diamond, making, ...extra });
const loyaltyAt = (pts, lines) => E.computeLoyalty({ points: pts, lines, cfg });
const reward = { id: 42, expires_at: '2999-01-01T00:00:00Z' };

test('referral reward: 10% of the diamond value, no making, coins excluded', () => {
  const r = E.computeReferral({ lines: [line(40000, 30000), line(500, 0, { sku: 'SCOIN|S|999' })], cfg });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 4000);
  assert.strictEqual(r.perLine[0].makingDiscount, 0);
  assert.strictEqual(r.perLine[1].eligible, false);
  assert.strictEqual(r.tier.key, 'REF');
  assert.strictEqual(E.computeReferral({ lines: [line(0, 1000)], cfg }).ok, false);
});

test('best of: Silver tie keeps loyalty (reward stays banked)', () => {
  const lines = [line(40000, 30000)];
  const loy = loyaltyAt(250000, lines);                 // 5% of 40k + 15% of 30k capped at 2k = 4000
  assert.strictEqual(loy.total, 4000);
  const best = E.pickBenefit(loy, E.computeReferral({ lines, cfg }), reward);
  assert.strictEqual(best.kind, 'loyalty');
  assert.strictEqual(best.referralTotal, 4000);
});

test('best of: Gold on a making-heavy piece keeps loyalty', () => {
  const lines = [line(40000, 30000)];
  const loy = loyaltyAt(600000, lines);                 // 7% of 40k + 20% of 30k capped at 5k = 7800
  assert.strictEqual(loy.total, 7800);
  assert.strictEqual(E.pickBenefit(loy, E.computeReferral({ lines, cfg }), reward).kind, 'loyalty');
});

test('best of: Gold on a diamond-heavy piece takes the referral reward', () => {
  const lines = [line(200000, 15000)];
  const loy = loyaltyAt(600000, lines);                 // 14000 + 3000 = 17000
  assert.strictEqual(loy.total, 17000);
  const best = E.pickBenefit(loy, E.computeReferral({ lines, cfg }), reward);
  assert.strictEqual(best.kind, 'referral');
  assert.strictEqual(best.total, 20000);
  assert.strictEqual(best.loyaltyTotal, 17000);
  assert.deepStrictEqual(best.reward, { id: 42, expires_at: reward.expires_at });
});

test('best of: below the first tier the reward is the benefit; no reward means plain loyalty', () => {
  const lines = [line(40000, 30000)];
  const loy = loyaltyAt(10000, lines);
  assert.strictEqual(loy.ok, false);
  assert.strictEqual(E.pickBenefit(loy, E.computeReferral({ lines, cfg }), reward).kind, 'referral');
  const none = E.pickBenefit(loy, E.computeReferral({ lines, cfg }), null);
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.referralTotal, 0);
});

test('in store: the reward becomes a referral per-line entry with no making cut', () => {
  const applied = { kind: 'referral', rate: 10, mk: 0, eligible_variants: ['11'] };
  const out = E.withLoyaltyEntries([[{ t: 'dia', m: 'pct', v: 5, src: 'auto-dia' }]], [{ variant_id: 11 }], applied);
  assert.deepStrictEqual(out[0], [{ t: 'dia', m: 'pct', v: 5, src: 'auto-dia' }, { t: 'dia', m: 'pct', v: 10, src: 'referral' }]);
  // Switching back to loyalty replaces the referral entry rather than adding beside it.
  const back = E.withLoyaltyEntries(out, [{ variant_id: 11 }], { rate: 7, mk: 0, eligible_variants: ['11'] });
  assert.deepStrictEqual(back[0].map(e => e.src), ['auto-dia', 'loyalty']);
});

test('discount breakup: referral is its own row, absent when unused', () => {
  assert.strictEqual(B.sourceOf({ src: 'referral' }), 'referral');
  const plain = B.buildBreakup([{ bySrc: { campaign: 100, manual: 0, loyalty: 50, other: 0, code: 0 }, campaigns: [] }]);
  assert.strictEqual('referral' in plain, false);
  const withRef = B.buildBreakup([{ bySrc: { campaign: 100, referral: 400 }, campaigns: [] }]);
  assert.strictEqual(withRef.referral, 400);
  assert.strictEqual(withRef.total, 500);
});

// ── Flows against the fakes ────────────────────────────────────────────────────────────────────
let priyaCode;
test('view: a buying customer gets a code and link; new and Platinum customers do not', async () => {
  const v = await R.viewFor('100');
  assert.strictEqual(v.eligible, true);
  assert.ok(/^PRIYA[A-Z2-9]{3}$/.test(v.code), v.code);
  assert.strictEqual(v.link, `https://timanti.in/?ref=${v.code}`);
  assert.strictEqual(v.available, 0);
  priyaCode = v.code;
  assert.strictEqual((await R.viewFor('100')).code, priyaCode, 'same code on every visit');
  assert.strictEqual((await R.viewFor('500')).reason, 'first-purchase');
  const pat = await R.viewFor('300');
  assert.strictEqual(pat.eligible, false);
  assert.strictEqual(pat.reason, 'top-tier');
  assert.strictEqual(pat.tierName, 'Platinum');
});

const online = (over = {}) => ({
  id: 5001, name: '#2001', source_name: 'web', financial_status: 'paid', tags: '',
  customer: { id: 200 }, email: 'rahul@x.in', phone: '+919800000200',
  note_attributes: [{ name: '_referral', value: priyaCode }], ...over,
});

test('friend\'s first online order, paid: the referrer earns a 12-month reward', async () => {
  const row = await R.onOrder(online(), { points: 50000, cfg });
  assert.strictEqual(row.status, 'earned');
  assert.strictEqual(row.referrer_customer_id, '100');
  assert.strictEqual(row.via, 'link');
  const months = (new Date(row.expires_at) - new Date(row.earned_at)) / (30.4 * 864e5);
  assert.ok(months > 11.5 && months < 12.5, String(months));
  // The several deliveries Shopify sends change nothing.
  await R.onOrder(online(), { points: 50000, cfg });
  assert.strictEqual(T('referral_rewards').filter(r => r.source_order_id === '5001').length, 1);
  assert.strictEqual((await R.openRewards(fakeSupabase, '100')).length, 1);
});

test('the reward is used once; a second use is refused', async () => {
  const [open] = await R.openRewards(fakeSupabase, '100');
  assert.strictEqual(await R.markUsed(fakeSupabase, open.id, { orderId: 9500, orderName: '#2050', channel: 'online' }), true);
  assert.strictEqual(await R.markUsed(fakeSupabase, open.id, { orderId: 9501, orderName: '#2051', channel: 'store' }), false);
  assert.strictEqual((await R.openRewards(fakeSupabase, '100')).length, 0);
  // Refunding the friend's order AFTER the reward was used leaves it used.
  await R.onOrder(online({ financial_status: 'refunded' }), { points: 0, cfg });
  assert.strictEqual(T('referral_rewards').find(r => r.source_order_id === '5001').status, 'used');
});

test('store order (buy plan style): waits for full payment, then earns; a refund before use voids', async () => {
  customers[600] = { firstName: 'Meera', email: 'meera@x.in', phone: '+919800000600', numberOfOrders: '1', first: '6001' };
  const store = (tags, over = {}) => ({ id: 6001, name: '#2002', source_name: 'shopify_draft_order', financial_status: 'pending',
    tags, customer: { id: 600 }, phone: '+919800000600', ...over });
  assert.strictEqual((await R.onOrder(store(`referred:${priyaCode}`), { points: 80000, cfg })).status, 'awaiting_payment');
  assert.strictEqual((await R.openRewards(fakeSupabase, '100')).length, 0, 'an unpaid plan earns nothing');
  assert.strictEqual((await R.onOrder(store(`referred:${priyaCode}, deposit:fully-paid`), { points: 80000, cfg })).status, 'earned');
  assert.strictEqual((await R.openRewards(fakeSupabase, '100')).length, 1);
  // Fully refunded in store: points drop to 0 → the unused reward is void.
  assert.strictEqual((await R.onOrder(store(`referred:${priyaCode}`), { points: 0, cfg })).status, 'void');
  assert.strictEqual((await R.openRewards(fakeSupabase, '100')).length, 0);
});

test('rejections: own code, not a first order, Platinum referrer, same phone', async () => {
  const own = await R.onOrder(online({ id: 9001, name: '#2003', customer: { id: 100 }, phone: '+919800000100', email: 'priya@x.in' }), { points: 1000, cfg });
  assert.strictEqual(own.status, 'rejected');
  assert.strictEqual(own.reason, 'own code');
  const repeat = await R.onOrder(online({ id: 4100, name: '#2004', customer: { id: 400 }, phone: '+919800000400', email: 'old@x.in' }), { points: 1000, cfg });
  assert.strictEqual(repeat.reason, 'not the customer\'s first order');
  const patCode = await R.getOrCreateCode(fakeSupabase, '300', 'Pat');
  customers[700] = { firstName: 'New', email: 'n@x.in', phone: '+919800000700', numberOfOrders: '1', first: '7001' };
  const plat = await R.onOrder(online({ id: 7001, name: '#2005', customer: { id: 700 }, phone: '+919800000700', email: 'n@x.in',
    note_attributes: [{ name: '_referral', value: patCode }] }), { points: 1000, cfg });
  assert.strictEqual(plat.reason, 'referrer is on the top tier');
  customers[800] = { firstName: 'Twin', email: 't@x.in', phone: '+919800000100', numberOfOrders: '1', first: '8001' };
  const twin = await R.onOrder(online({ id: 8001, name: '#2006', customer: { id: 800 }, phone: '+919800000100', email: 't@x.in' }), { points: 1000, cfg });
  assert.strictEqual(twin.reason, 'same phone or email as the referrer');
});

test('no attribution or not a sale: nothing recorded', async () => {
  const before = T('referral_rewards').length;
  assert.strictEqual(await R.onOrder(online({ id: 9900, note_attributes: [] }), { points: 1000, cfg }), null);
  assert.strictEqual(await R.onOrder(online({ id: 9901 }), { points: 0, cfg }), null);
  assert.strictEqual(T('referral_rewards').length, before);
});

test('claim: a logged-in new visitor\'s code attributes an order that carries none', async () => {
  assert.deepStrictEqual(await R.claim('400', priyaCode), { ok: false, reason: 'existing customer' });
  assert.deepStrictEqual(await R.claim('100', priyaCode), { ok: false, reason: 'own code' });
  customers[900] = { firstName: 'Ira', email: 'ira@x.in', phone: '+919800000900', numberOfOrders: '0', first: null };
  assert.deepStrictEqual(await R.claim('900', priyaCode.toLowerCase()), { ok: true });
  // GoKwik put the order on a different customer record with the same phone.
  customers[901] = { firstName: 'Ira', email: '', phone: '+919800000900', numberOfOrders: '1', first: '9902' };
  const row = await R.onOrder(online({ id: 9902, name: '#2007', customer: { id: 901 }, phone: '+919800000900', email: '', note_attributes: [] }), { points: 30000, cfg });
  assert.strictEqual(row.via, 'claim');
  assert.strictEqual(row.status, 'earned');
});

test('bestFor: an open reward wins over a weaker benefit; Platinum never sees it', async () => {
  const lines = [line(200000, 15000)];
  const r = await R.bestFor('100', loyaltyAt(250000, lines), lines, cfg);   // Silver: 10000 + 2000 = 12000 < 20000
  assert.strictEqual(r.kind, 'referral');
  assert.ok(r.reward && r.reward.id);
  T('referral_rewards').push({ id: 999, source_order_id: 'x999', referrer_customer_id: '300', status: 'earned', earned_at: '2026-11-01', expires_at: '2999-01-01' });
  const p = await R.bestFor('300', loyaltyAt(1200000, lines), lines, cfg);
  assert.notStrictEqual(p.kind, 'referral');
});

test('in store: ref:<code or phone> becomes referred:<CODE>; bad input is flagged', async () => {
  await R.handleReferralTagStep({ id: 1, name: '#D1', tags: `ref:${priyaCode.toLowerCase()}, reprice`, customer: { id: 200 } });
  assert.strictEqual(tagWrites.pop(), `reprice, referred:${priyaCode}`);
  await R.handleReferralTagStep({ id: 2, name: '#D2', tags: 'ref:+91 98000 00100', customer: { id: 200 } });
  assert.strictEqual(tagWrites.pop(), `referred:${priyaCode}`);
  await R.handleReferralTagStep({ id: 3, name: '#D3', tags: 'ref:NOSUCH1', customer: { id: 200 } });
  assert.strictEqual(tagWrites.pop(), 'ref-invalid: unknown code');
  await R.handleReferralTagStep({ id: 4, name: '#D4', tags: `ref:${priyaCode}`, customer: { id: 100 } });
  assert.strictEqual(tagWrites.pop(), 'ref-invalid: own code');
  const n = tagWrites.length;
  await R.handleReferralTagStep({ id: 5, name: '#D5', tags: `referred:${priyaCode}, loyalty-applied` });
  assert.strictEqual(tagWrites.length, n, 'no ref: tag → no write');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error(`FAIL ${name}\n  ${e.stack}`); process.exitCode = 1; }
  }
  console.log(`referral.test.js: ${passed}/${tests.length} passed`);
})();
