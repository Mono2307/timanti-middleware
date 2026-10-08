'use strict';

/**
 * Live acceptance self-test for loyalty — runs INSIDE the deployed service against real Shopify and
 * Supabase, and never creates an order.
 *
 * What it touches, and how it cleans up:
 *   - one UAT test customer (given by id): its points are moved with temporary ledger adjustments
 *     keyed 'uat-<run>', deleted at the end, and the customer republished;
 *   - scratch DRAFT orders tagged 'uat-loyalty', created and deleted again (never completed, so no
 *     order, invoice or serial number exists);
 *   - one-time LOY- codes it creates itself, deleted at the end;
 *   - a synthetic order object (never sent to Shopify) to exercise earning and code settlement.
 *
 * Refuses to create drafts while AUTO_PUSH_TO_TERMINAL is on, because a new draft would be pushed
 * to the card terminal.
 *
 * Results are a list of { id, name, status: PASS|FAIL|SKIP, detail }, matching the IDs in
 * loyalty/UAT_LOYALTY.md. Run it with tools/loyalty-uat.js.
 */

const crypto = require('crypto');
const axios = require('axios');
const { config } = require('../../core/config');
const { supabase } = require('../../core/supabase');
const { getJson, putJson, graphql, getShopifyToken, shopifyHeaders } = require('../../core/shopify');
const { updateDraftOrderMetafields } = require('../../core/metafields');
const { log } = require('../../core/logger');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig, fetchRawConfig, normalizeConfig } = require('./config');
const { readCustomer, refreshCustomer } = require('./customer');
const draftMod = require('./draft');
const earn = require('./earn');
const { verifyProxySignature } = require('./online');

let job = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;
const rs = (v) => Math.abs(parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || 0);
const prop = (li, name) => { const p = (li.properties || []).find(x => x && x.name === name); return p ? p.value : null; };

async function waitFor(fn, { timeout = 90000, every = 4000, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function graphqlAt(version, query, variables) {
  const token = await getShopifyToken();
  const { data } = await axios.post(`${config.shopify.storeUrl}/admin/api/${version}/graphql.json`,
    { query, variables }, { headers: shopifyHeaders(token), timeout: 20000 });
  if (data.errors && data.errors.length) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

const getDraft = async (id) => (await getJson(`draft_orders/${id}.json`)).draft_order;
const tagsOf = (d) => String(d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
async function addTags(id, extra) {
  const d = await getDraft(id);
  await putJson(`draft_orders/${id}.json`, { draft_order: { id, tags: [...new Set([...tagsOf(d), ...extra])].join(', ') } });
}
async function dropTags(id, re) {
  const d = await getDraft(id);
  await putJson(`draft_orders/${id}.json`, { draft_order: { id, tags: tagsOf(d).filter(t => !re.test(t)).join(', ') } });
}
/** Settled = no trigger tags left for the pipeline to consume. */
const settled = (d) => !tagsOf(d).some(t => /^(reprice|apply-loyalty|remove-loyalty|recalculate-price|apply-discount:)/i.test(t));

async function createDraft(customerId, variantIds, runId) {
  const r = await graphql(`mutation($i: DraftOrderInput!) { draftOrderCreate(input: $i) {
      draftOrder { id name } userErrors { field message } } }`, {
    i: {
      customerId: `gid://shopify/Customer/${customerId}`,
      lineItems: variantIds.map(v => ({ variantId: `gid://shopify/ProductVariant/${v}`, quantity: 1 })),
      tags: ['uat-loyalty'],
      note: `Loyalty UAT ${runId} — scratch draft, deleted automatically. Do not convert.`,
    },
  });
  const errs = r.draftOrderCreate.userErrors || [];
  if (errs.length) throw new Error(JSON.stringify(errs));
  return r.draftOrderCreate.draftOrder.id.split('/').pop();
}

async function deleteDraft(id) {
  await graphql(`mutation($i: DraftOrderDeleteInput!) { draftOrderDelete(input: $i) { userErrors { message } } }`,
    { i: { id: `gid://shopify/DraftOrder/${id}` } }).catch(e => log.warn('loyalty', `uat draft ${id} delete failed: ${e.message}`));
}

/** Move the test customer to exactly `target` points with a temporary adjustment. */
async function setPoints(runId, customerId, target) {
  await ledger.deleteEntriesByPrefix(supabase, `adjust:uat-${runId}`);
  const base = await ledger.customerPoints(supabase, customerId);
  if (target !== base) await ledger.addAdjustment(supabase, { customerId, entryKey: `uat-${runId}`, points: target - base, note: 'loyalty UAT (temporary)' });
  return refreshCustomer(customerId, { notify: false });
}

/** Call our own app-proxy route the way Shopify would, signed with the proxy secret. */
async function proxyCall(method, path, customerId, body, { tamper = false } = {}) {
  const secret = config.loyalty.proxySecrets[0];
  const q = { shop: String(config.shopify.storeUrl || '').replace(/^https?:\/\//, ''), logged_in_customer_id: String(customerId || ''),
    path_prefix: '/apps/loyalty', timestamp: String(Math.floor(Date.now() / 1000)) };
  const msg = Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('');
  q.signature = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  if (tamper) q.logged_in_customer_id = '1';
  const url = `http://127.0.0.1:${config.port}/api/loyalty/proxy/${path}?${new URLSearchParams(q)}`;
  const res = await axios({ method, url, data: body, validateStatus: () => true, timeout: 30000 });
  return { status: res.status, data: res.data };
}

async function readCode(code) {
  const d = await graphql(`query($c: String!) { codeDiscountNodeByCode(code: $c) { id codeDiscount { __typename
      ... on DiscountCodeBasic { usageLimit endsAt
        combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        customerGets { value { __typename ... on DiscountAmount { amount { amount } appliesOnEachItem } }
          items { __typename ... on DiscountProducts { productVariants(first: 50) { nodes { id } } } } } } } } }`, { c: code });
  return d.codeDiscountNodeByCode;
}

async function run(p) {
  const results = job.results;
  const record = (id, name, status, detail = '') => { results.push({ id, name, status, detail: String(detail).slice(0, 400) }); };
  const check = async (id, name, fn) => {
    try { const d = await fn(); record(id, name, 'PASS', d || ''); }
    catch (e) { record(id, name, e && e.skip ? 'SKIP' : 'FAIL', e && e.message); }
  };
  const skip = (why) => { const e = new Error(why); e.skip = true; throw e; };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const runId = job.runId;
  const cust = String(p.customerId || '');
  const eligibleVariant = String(p.eligibleVariantId || '');
  const excludedVariant = p.excludedVariantId ? String(p.excludedVariantId) : '';
  const secondVariant = p.secondVariantId ? String(p.secondVariantId) : '';
  let cfg;

  // ── P: preconditions ────────────────────────────────────────────────────────────────────────
  await check('P1', 'LOYALTY_ENABLED is on', async () => { assert(config.loyalty.enabled, 'LOYALTY_ENABLED is off'); });
  await check('P2', 'Programme config reads and validates', async () => {
    const raw = await fetchRawConfig();
    assert(raw, 'shop metafield loyalty.program_config is missing — run POST /api/loyalty/setup');
    cfg = normalizeConfig(JSON.parse(raw));
    return cfg.tiers.map(t => `${t.name} ${t.min}→${t.pct}%`).join(', ');
  });
  if (!cfg) cfg = await loadConfig();
  await check('P3', 'Supabase loyalty tables reachable', async () => {
    const a = await supabase.from('loyalty_ledger').select('id', { head: true, count: 'exact' });
    const b = await supabase.from('loyalty_redemptions').select('id', { head: true, count: 'exact' });
    assert(!a.error && !b.error, (a.error || b.error || {}).message || 'unreachable');
    return `${a.count} ledger rows, ${b.count} redemptions`;
  });
  await check('P4', 'Customer metafield definitions exist with storefront + customer-account read', async () => {
    const d = await graphqlAt('2025-01', `{ metafieldDefinitions(first: 50, ownerType: CUSTOMER, namespace: "loyalty") {
        nodes { key access { storefront customerAccount } } } }`);
    const nodes = d.metafieldDefinitions.nodes;
    const missing = ['points', 'tier', 'tier_name', 'discount_pct', 'next_tier_name', 'next_tier_gap'].filter(k => !nodes.find(n => n.key === k));
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    const closed = nodes.filter(n => n.access.storefront !== 'PUBLIC_READ' || n.access.customerAccount !== 'READ').map(n => n.key);
    assert(!closed.length, `not readable on storefront/account: ${closed.join(', ')}`);
  });
  await check('P5', 'Test customer exists', async () => {
    assert(cust, 'customerId not given');
    const c = await readCustomer(cust);
    assert(c, `customer ${cust} not found`);
    return c.name;
  });
  await check('P6', 'Proxy secret configured', async () => { assert(config.loyalty.proxySecrets.length, 'MFM_CLIENT_SECRET / SHOPIFY_CLIENT_SECRET not set'); });

  // ── T: tiers published to the customer ──────────────────────────────────────────────────────
  const tierAt = async (points) => {
    await setPoints(runId, cust, points);
    const c = await readCustomer(cust);
    const want = E.tierFor(points, cfg).tier;
    const key = want ? want.key : 'none';
    assert(c.tierKey === key, `tier metafield ${c.tierKey}, expected ${key}`);
    assert(c.points === points, `points metafield ${c.points}, expected ${points}`);
    const tierTags = c.tags.filter(t => /^loyalty-T\d+$/i.test(t));
    assert(want ? (tierTags.length === 1 && tierTags[0] === `loyalty-${key}`) : !tierTags.length, `tags ${tierTags.join(',') || 'none'}`);
    return `${points} pts → ${key}, tags ${tierTags.join(',') || 'none'}`;
  };
  const [t1, t2, t3] = cfg.tiers;
  if (cust) {
    await check('T1', 'Below first tier: no tier, no tag', () => tierAt(Math.max(0, t1.min - 1)));
    await check('T2', 'Exactly on first threshold: first tier', () => tierAt(t1.min));
    if (t2) await check('T3', 'Second tier', () => tierAt(t2.min + 1000));
    if (t3) await check('T4', 'Top tier', () => tierAt(t3.min + 1000));
    if (t2) await check('T5', 'Points fall back (refund): tier steps down, old tag removed', () => tierAt(t2.min + 1000));
  }

  // ── D: in-store draft flow ──────────────────────────────────────────────────────────────────
  let draftId = null;
  const draftBlocked = config.auto.pushToTerminal ? 'AUTO_PUSH_TO_TERMINAL is on — a scratch draft would go to the card terminal' : '';
  const needDraft = () => { if (draftBlocked) skip(draftBlocked); if (!eligibleVariant) skip('eligibleVariantId not given'); if (!draftId) skip('no scratch draft'); };
  if (!draftBlocked && eligibleVariant && cust) {
    try {
      draftId = await createDraft(cust, [eligibleVariant, excludedVariant].filter(Boolean), runId);
      job.draftId = draftId;
      await waitFor(async () => { const d = await getDraft(draftId); return d.line_items.every(li => !li.variant_id || prop(li, '_jewel_code') !== null) && d; },
        { what: 'draft hydration' });
    } catch (e) { record('D0', 'Create scratch draft', 'FAIL', e.message); draftId = null; }
  }

  const applyAndSettle = async () => {
    await addTags(draftId, ['apply-loyalty']);
    return waitFor(async () => { const d = await getDraft(draftId); return settled(d) && d; }, { what: 'loyalty apply + reprice' });
  };
  const checkLines = (d, rate) => {
    const lines = d.line_items.filter(li => li.variant_id);
    const out = [];
    for (const li of lines) {
      const dia = rs(prop(li, 'Diamond'));
      const disc = rs(prop(li, 'Discount on Diamond'));
      const applied = rs(prop(li, 'Discount Applied'));
      const gross = rs(prop(li, 'Gross Value'));
      const taxable = rs(prop(li, 'Taxable Value'));
      const gst = rs(prop(li, 'GST'));
      const isEligible = String(li.variant_id) === eligibleVariant || String(li.variant_id) === secondVariant;
      if (isEligible) {
        assert(dia > 0, `line ${li.title}: no Diamond value`);
        assert(near(disc, dia * rate / 100), `line ${li.title}: Discount on Diamond ${disc}, expected ${(dia * rate / 100).toFixed(2)}`);
        assert(near(applied, disc), `line ${li.title}: Discount Applied ${applied} ≠ Discount on Diamond ${disc} (another component was discounted)`);
      } else {
        assert(disc === 0, `excluded line ${li.title} carries Discount on Diamond ${disc}`);
      }
      if (gross > 0) {
        assert(near(taxable, gross / 1.03 - applied), `line ${li.title}: Taxable ${taxable} ≠ Gross/1.03 − discount ${(gross / 1.03 - applied).toFixed(2)}`);
        assert(near(gst, taxable * 0.03), `line ${li.title}: GST ${gst} ≠ 3% of taxable`);
        assert(near(Number(li.price) * li.quantity, taxable + gst, 2), `line ${li.title}: price ${li.price} ≠ taxable + GST`);
      }
      out.push(`${li.title}: dia ${dia} − ${disc}`);
    }
    return out.join('; ');
  };

  let appliedRate = 0;
  await check('D1', 'Apply loyalty on a tier customer: diamond-only discount, GST on reduced value', async () => {
    needDraft();
    await setPoints(runId, cust, (t2 || t1).min + 1000);
    const ev = await draftMod.evaluateDraft(await getDraft(draftId), (await draftMod.readDraftMetafields(draftId)).map);
    assert(ev.ok, `preview refused: ${ev.reason}`);
    appliedRate = ev.rate;
    const d = await applyAndSettle();
    assert(tagsOf(d).includes('loyalty-applied'), `tags: ${d.tags}`);
    return `rate ${appliedRate}% — ` + checkLines(d, appliedRate);
  });
  await check('D2', 'Excluded piece on the same draft is not discounted', async () => {
    needDraft(); if (!excludedVariant) skip('excludedVariantId not given');
    const d = await getDraft(draftId);
    const li = d.line_items.find(x => String(x.variant_id) === excludedVariant);
    assert(li && rs(prop(li, 'Discount on Diamond')) === 0, 'excluded line was discounted');
  });
  await check('D3', 'Panel preview matches what was applied', async () => {
    needDraft();
    const { map } = await draftMod.readDraftMetafields(draftId);
    const applied = E.readApplied(map.loyalty_applied);
    assert(applied && applied.rate === appliedRate, `stored rate ${applied && applied.rate}, preview ${appliedRate}`);
    const d = await getDraft(draftId);
    const totalDisc = d.line_items.reduce((s, li) => s + rs(prop(li, 'Discount on Diamond')), 0);
    assert(near(Number(map.discount_applied || 0), totalDisc, 2), `discount_applied ${map.discount_applied} vs lines ${totalDisc.toFixed(2)}`);
  });
  await check('D4', 'Adding a piece re-evaluates and discounts the new line', async () => {
    needDraft(); if (!secondVariant) skip('secondVariantId not given');
    const d = await getDraft(draftId);
    const lines = d.line_items.map(li => li.variant_id
      ? { variantId: `gid://shopify/ProductVariant/${li.variant_id}`, quantity: li.quantity, priceOverride: { amount: Number(li.price).toFixed(2), currencyCode: 'INR' },
          customAttributes: (li.properties || []).map(x => ({ key: x.name, value: String(x.value) })) }
      : { title: li.title, quantity: li.quantity, originalUnitPriceWithCurrency: { amount: Number(li.price).toFixed(2), currencyCode: 'INR' },
          customAttributes: (li.properties || []).map(x => ({ key: x.name, value: String(x.value) })) });
    lines.push({ variantId: `gid://shopify/ProductVariant/${secondVariant}`, quantity: 1 });
    const r = await graphqlAt('2025-01', `mutation($id: ID!, $i: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $i) { userErrors { message } } }`,
      { id: `gid://shopify/DraftOrder/${draftId}`, i: { lineItems: lines } });
    assert(!(r.draftOrderUpdate.userErrors || []).length, JSON.stringify(r.draftOrderUpdate.userErrors));
    const settledDraft = await waitFor(async () => {
      const x = await getDraft(draftId);
      const li = x.line_items.find(l => String(l.variant_id) === secondVariant);
      return settled(x) && li && rs(prop(li, 'Discount on Diamond')) > 0 && x;
    }, { what: 'new line discounted', timeout: 120000 });
    return checkLines(settledDraft, appliedRate);
  });
  await check('D5', 'A discount code on a loyalty draft is refused', async () => {
    needDraft();
    await addTags(draftId, ['apply-discount:custom:5:pct']);
    const d = await waitFor(async () => { const x = await getDraft(draftId); return !tagsOf(x).some(t => /^apply-discount:/i.test(t)) && x; }, { what: 'apply-discount handled' });
    assert(tagsOf(d).includes('discount-invalid: loyalty applied'), `tags: ${d.tags}`);
    const { map } = await draftMod.readDraftMetafields(draftId);
    assert(!(Number(map.discount_rate) > 0), 'discount_rate was written');
    await dropTags(draftId, /^discount-invalid/i);
  });
  await check('D6', 'Another discount sneaking on takes loyalty off with a reason', async () => {
    needDraft();
    await updateDraftOrderMetafields(draftId, { discount_rate: '5' });
    await addTags(draftId, ['uat-ping']);
    const d = await waitFor(async () => { const x = await getDraft(draftId); return !tagsOf(x).includes('loyalty-applied') && settled(x) && x; }, { what: 'loyalty taken off' });
    assert(tagsOf(d).some(t => /^loyalty-invalid: removed/.test(t)), `tags: ${d.tags}`);
    const { map, all } = await draftMod.readDraftMetafields(draftId);
    assert(/taken off/.test(map.loyalty_note || ''), 'no explanation in custom.loyalty_note');
    // Clean the sneaked-in discount AND what the reprice resolved from it, then reprice back to clean.
    const { deleteJson } = require('../../core/shopify');
    for (const key of ['discount_rate', 'discount_kind', 'discount_mode', 'discount_code', 'discount_codes', 'discount_applied']) {
      const mf = all.find(m => m.namespace === 'custom' && m.key === key);
      if (mf) await deleteJson(`draft_orders/${draftId}/metafields/${mf.id}.json`);
    }
    await dropTags(draftId, /^(loyalty-invalid|uat-ping)/i);
    await addTags(draftId, ['reprice']);
    await waitFor(async () => { const x = await getDraft(draftId); return settled(x) && x; }, { what: 'clean reprice' });
  });
  await check('D7', 'Remove loyalty: discount props and discount_applied gone after reprice', async () => {
    needDraft();
    await applyAndSettle();
    await addTags(draftId, ['remove-loyalty']);
    const d = await waitFor(async () => { const x = await getDraft(draftId); return !tagsOf(x).includes('loyalty-applied') && settled(x) && x; }, { what: 'loyalty removed' });
    const left = d.line_items.filter(li => rs(prop(li, 'Discount on Diamond')) > 0);
    assert(!left.length, `still discounted: ${left.map(l => l.title).join(', ')}`);
    const { map } = await draftMod.readDraftMetafields(draftId);
    assert(!map.loyalty_applied && !(Number(map.discount_applied) > 0), 'loyalty record or discount_applied left behind');
  });
  await check('D8', 'Below-tier customer is refused with the reason', async () => {
    needDraft();
    await setPoints(runId, cust, Math.max(0, t1.min - 1));
    await addTags(draftId, ['apply-loyalty']);
    const d = await waitFor(async () => { const x = await getDraft(draftId); return !tagsOf(x).includes('apply-loyalty') && x; }, { what: 'refusal' });
    assert(tagsOf(d).includes('loyalty-invalid: below tier'), `tags: ${d.tags}`);
    const { map } = await draftMod.readDraftMetafields(draftId);
    assert(/below the first tier/.test(map.loyalty_note || ''), 'no reason in the note');
  });
  await check('D9', 'Every tag the flow wrote is ≤ 40 characters', async () => {
    needDraft();
    const long = tagsOf(await getDraft(draftId)).filter(t => t.length > 40);
    assert(!long.length, long.join(', '));
  });
  if (draftId) await deleteDraft(draftId);

  // ── O: online (app proxy + one-time code) ───────────────────────────────────────────────────
  let code = null;
  await check('O1', 'Unsigned or tampered proxy request is rejected', async () => {
    if (!config.loyalty.proxySecrets.length) skip('no proxy secret');
    const r = await proxyCall('get', 'benefits', cust, null, { tamper: true });
    assert(r.status === 401, `status ${r.status}`);
    assert(!verifyProxySignature({ logged_in_customer_id: cust }, config.loyalty.proxySecrets), 'unsigned accepted');
  });
  await check('O2', 'Benefits for a tier customer: tier, rate, vouchers', async () => {
    if (!config.loyalty.proxySecrets.length) skip('no proxy secret');
    await setPoints(runId, cust, (t2 || t1).min + 1000);
    const r = await proxyCall('get', 'benefits', cust);
    assert(r.status === 200 && r.data.found, `status ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    assert(r.data.tier && r.data.tier.key === (t2 || t1).key, `tier ${JSON.stringify(r.data.tier)}`);
    return `${r.data.tier.name} ${r.data.rate}%, ${r.data.vouchers.length} voucher(s)`;
  });
  await check('O3', 'Logged-out benefits says log in', async () => {
    if (!config.loyalty.proxySecrets.length) skip('no proxy secret');
    const r = await proxyCall('get', 'benefits', '');
    assert(r.status === 200 && r.data.loggedIn === false, JSON.stringify(r.data));
  });
  await check('O4', 'Apply on a cart: one-time code worth exactly the diamond-only amount', async () => {
    if (!config.loyalty.proxySecrets.length) skip('no proxy secret'); if (!eligibleVariant) skip('eligibleVariantId not given');
    const lines = [{ variant_id: eligibleVariant, quantity: 1 }, ...(excludedVariant ? [{ variant_id: excludedVariant, quantity: 1 }] : [])];
    const r = await proxyCall('post', 'apply', cust, { lines });
    assert(r.status === 200 && r.data.ok, JSON.stringify(r.data));
    code = r.data.code;
    job.codes.push(code);
    const node = await readCode(code);
    assert(node, 'code not found in Shopify');
    const c = node.codeDiscount;
    assert(near(c.customerGets.value.amount.amount, r.data.amount, 0.01), `Shopify amount ${c.customerGets.value.amount.amount} vs ${r.data.amount}`);
    assert(c.usageLimit === 1, `usageLimit ${c.usageLimit}`);
    assert(c.combinesWith.orderDiscounts === true && c.combinesWith.productDiscounts === false, `combinesWith ${JSON.stringify(c.combinesWith)}`);
    const vars = c.customerGets.items.productVariants.nodes.map(n => n.id.split('/').pop());
    assert(vars.includes(eligibleVariant), 'eligible variant not entitled');
    if (excludedVariant) assert(!vars.includes(excludedVariant), 'excluded variant is entitled');
    const hrs = (new Date(c.endsAt) - Date.now()) / 3600000;
    assert(hrs > 0 && hrs <= cfg.online.code_ttl_minutes / 60 + 0.1, `expires in ${hrs.toFixed(2)}h`);
    return `${code} = ₹${r.data.amount} (${r.data.rate}%)`;
  });
  await check('O5', 'Same cart again returns the same code (no code spam)', async () => {
    if (!code) skip('no code from O4');
    const lines = [{ variant_id: eligibleVariant, quantity: 1 }, ...(excludedVariant ? [{ variant_id: excludedVariant, quantity: 1 }] : [])];
    const r = await proxyCall('post', 'apply', cust, { lines });
    assert(r.data.ok && r.data.code === code, `got ${r.data.code}`);
  });
  await check('O6', 'Below-tier customer is refused at the cart', async () => {
    if (!config.loyalty.proxySecrets.length) skip('no proxy secret'); if (!eligibleVariant) skip('eligibleVariantId not given');
    await setPoints(runId, cust, Math.max(0, t1.min - 1));
    const r = await proxyCall('post', 'apply', cust, { lines: [{ variant_id: eligibleVariant, quantity: 1 }] });
    assert(r.data.ok === false && /more to unlock/.test(r.data.reason || ''), JSON.stringify(r.data));
    await setPoints(runId, cust, (t2 || t1).min + 1000);
  });
  await check('O7', 'Open vouchers allow a loyalty code beside them (combine with product discounts)', async () => {
    const creditInstruments = require('../adjustments/credit_instruments');
    const open = await creditInstruments.listOpenForCustomer(supabase, { instrumentType: 'voucher' });
    if (!open.length) skip('no open vouchers to check');
    const bad = [];
    for (const v of open.slice(0, 15)) {
      const n = await readCode(v.serial_code).catch(() => null);
      if (n && n.codeDiscount && n.codeDiscount.combinesWith && !n.codeDiscount.combinesWith.productDiscounts) bad.push(v.serial_code);
    }
    assert(!bad.length, `not combinable yet (run POST /api/loyalty/voucher-combos): ${bad.join(', ')}`);
    return `${Math.min(open.length, 15)} checked`;
  });

  // ── E: earning (synthetic orders — nothing sent to Shopify) ─────────────────────────────────
  await check('E1', 'Code settles on the order: marked used, mismatch flagged, code deleted, points to requester', async () => {
    if (!code) skip('no code from O4');
    const orderId = `uat-${runId}`;
    await earn.processOrder({
      id: orderId, name: '#UAT', total_price: '100000', source_name: 'web',
      customer: { id: 1 }, discount_codes: [{ code, amount: String((await ledger.getRedemptionByCode(supabase, code)).discount_incl_tax) }],
      line_items: [{ title: 'UAT', price: '100000', quantity: 1 }],
    });
    const red = await ledger.getRedemptionByCode(supabase, code);
    assert(red.status === 'used', `status ${red.status}`);
    assert(red.customer_mismatch === true, 'mismatch not flagged');
    const { data } = await supabase.from('loyalty_ledger').select('*').eq('entry_key', `order:${orderId}`).maybeSingle();
    assert(data && String(data.customer_id) === cust && Number(data.points) === 100000, `ledger ${JSON.stringify(data)}`);
    assert(!(await readCode(code)), 'code still exists in Shopify');
  });
  await check('E2', 'Refund on the order brings its points down; duplicate delivery is a no-op', async () => {
    const orderId = `uat-${runId}`;
    const o = { id: orderId, name: '#UAT', total_price: '100000', customer: { id: cust }, line_items: [],
      refunds: [{ transactions: [{ kind: 'refund', status: 'success', amount: '40000' }] }] };
    await earn.processOrder(o);
    await earn.processOrder(o);
    const { data } = await supabase.from('loyalty_ledger').select('points').eq('entry_key', `order:${orderId}`).maybeSingle();
    assert(data && Number(data.points) === 60000, `points ${data && data.points}`);
  });
  await check('E3', 'Recent real orders: earning rule reads them cleanly (read only)', async () => {
    const { orders } = await getJson('orders.json?status=any&limit=20&fields=id,name,total_price,cancelled_at,customer,line_items,discount_applications,discount_codes,refunds');
    const rows = orders.map(o => `${o.name}:${E.orderEarnValue(o)}`);
    return rows.slice(0, 10).join(' ');
  });

  // ── M: marketing sweep ──────────────────────────────────────────────────────────────────────
  await check('M1', 'Occasion-month sweep (dry run) runs and counts', async () => {
    const r = await require('./sweep').runLoyaltySweep({ dryRun: true });
    assert(r.tags, 'sweep failed');
    return `${r.tags.seen} customers seen, would add ${r.tags.added}, remove ${r.tags.removed}`;
  });
}

async function cleanup() {
  const runId = job.runId;
  for (const c of job.codes) {
    const node = await readCode(c).catch(() => null);
    if (node) await graphql(`mutation($id: ID!) { discountCodeDelete(id: $id) { userErrors { message } } }`, { id: node.id }).catch(() => {});
    await ledger.deleteRedemptionByCode(supabase, c).catch(() => {});
  }
  await ledger.deleteEntriesByPrefix(supabase, `adjust:uat-${runId}`).catch(e => job.cleanupErrors.push(e.message));
  await ledger.deleteEntriesByPrefix(supabase, `order:uat-${runId}`).catch(e => job.cleanupErrors.push(e.message));
  if (job.draftId) await deleteDraft(job.draftId);
  if (job.params.customerId) await refreshCustomer(String(job.params.customerId), { notify: false }).catch(e => job.cleanupErrors.push(e.message));
}

function start(params = {}) {
  if (job && job.running) return { started: false, job: status() };
  job = { runId: Date.now().toString(36), params, running: true, startedAt: new Date().toISOString(), finishedAt: null,
    results: [], codes: [], draftId: null, cleanupErrors: [] };
  run(params)
    .catch(e => job.results.push({ id: 'X', name: 'self-test crashed', status: 'FAIL', detail: e.message }))
    .finally(async () => {
      await cleanup().catch(e => job.cleanupErrors.push(e.message));
      job.running = false; job.finishedAt = new Date().toISOString();
      const c = (s) => job.results.filter(r => r.status === s).length;
      log.info('loyalty', `self-test ${job.runId}: ${c('PASS')} pass, ${c('FAIL')} fail, ${c('SKIP')} skip`);
    });
  return { started: true, job: status() };
}

function status() {
  if (!job) return null;
  const c = (s) => job.results.filter(r => r.status === s).length;
  return { runId: job.runId, running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt,
    pass: c('PASS'), fail: c('FAIL'), skip: c('SKIP'), results: job.results, cleanupErrors: job.cleanupErrors };
}

module.exports = { start, status };
