'use strict';

/**
 * Referral programme (founder, 2026-11-12). Schema: ./referral.sql.
 *
 * THE RULE
 *   An existing customer shares their link (timanti.in/?ref=PRIYA7K). A NEW customer who comes in on
 *   it, online or in store, pays full price. When that friend's FIRST order is created and fully paid,
 *   the referrer earns ONE reward: pct % (10) off the DIAMOND value of one later bill. No cap, no
 *   minimum. Rewards bank, one used per bill, each good for reward_months (12) after it is earned.
 *   A buy plan or savings scheme earns it when it COMPLETES (its order exists only once fully paid);
 *   starting one earns nothing. A friend's order fully refunded or cancelled before the reward is used
 *   voids the reward. Platinum (config referral.exclude_tiers) has no link and earns nothing.
 *
 * NEVER WITH LOYALTY
 *   The reward stacks with the campaign's auto diamond discount, manual cuts and ISB10, exactly as
 *   loyalty does, and never with loyalty itself. So it travels in loyalty's slot: bestFor() takes
 *   loyalty's computed benefit and returns whichever of the two takes more rupees off the bill
 *   (engine.pickBenefit), in the same shape. The online code, the promo stacking, the in-store
 *   per-line entry, settlement and the invoice need no new path. The reward is used up only on the
 *   bill where it wins.
 *
 * ATTRIBUTION (first match wins)
 *   1. tag  referred:<CODE>        in store: staff tag the draft ref:<code or referrer's phone>;
 *                                  handleReferralTagStep checks it and rewrites it to referred:<CODE>
 *   2. note attribute _referral    online: the cart embed copies ?ref= onto the cart (loyalty-benefits.js)
 *   3. landing_site ?ref=          online, when the visit that bought is the one that landed
 *   4. a claim                     the embed records "this logged-in customer came from <CODE>"
 *                                  (by customer id, then by phone, since GoKwik can attach the order to
 *                                  another customer record with the same phone)
 */

const crypto = require('crypto');
const { graphql, putJson } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { config } = require('../../core/config');
const { log } = require('../../core/logger');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');

const CODES = 'referral_codes';
const CLAIMS = 'referral_claims';
const REWARDS = 'referral_rewards';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const T_INPUT = /^ref:/i;
const T_DONE = 'referred:';
const T_INVALID = 'ref-invalid';

const splitTags = (s) => (Array.isArray(s) ? s : String(s || '').split(',')).map(t => String(t).trim()).filter(Boolean);
const numericId = (id) => String(id || '').replace(/^gid:\/\/shopify\/\w+\//, '');

// ── Pure helpers (tested in referral.test.js) ───────────────────────────────────────────────────

/** "priya7k " → "PRIYA7K"; anything that is not a code → ''. */
function normalizeCode(v) {
  const c = String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(c) ? c : '';
}

/** Indian mobile → its 10 digits ("+91 98765 43210" → "9876543210"); anything else → ''. */
function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

/** Up to 6 letters of the first name + 3 unambiguous characters: "Priya" → "PRIYA7K2"-style. */
function makeCode(firstName, randomBytes = crypto.randomBytes) {
  const name = String(firstName || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'TM';
  const bytes = randomBytes(3);
  let suffix = '';
  for (let i = 0; i < 3; i++) suffix += ALPHABET[bytes[i] % ALPHABET.length];
  return `${name}${suffix}`;
}

/** The referral link a code shares. */
function linkFor(code, cfg) {
  const base = String((cfg && cfg.referral && cfg.referral.link_base) || 'https://timanti.in/');
  return `${base}${base.includes('?') ? '&' : '?'}ref=${encodeURIComponent(code)}`;
}

/** reward_months after `from`, as an ISO string. */
function expiryFrom(from, months) {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + (Number(months) || 12));
  return d.toISOString();
}

/**
 * Who referred this order, from the order alone: { code, via } or null.
 * The in-store tag beats the cart attribute, which beats the landing page.
 */
function attributionFrom(order) {
  const tag = splitTags(order && order.tags).find(t => t.toLowerCase().startsWith(T_DONE));
  if (tag) {
    const code = normalizeCode(tag.slice(T_DONE.length));
    if (code) return { code, via: 'store' };
  }
  const attr = ((order && order.note_attributes) || []).find(a => a && String(a.name || '').toLowerCase() === '_referral');
  if (attr) {
    const code = normalizeCode(attr.value);
    if (code) return { code, via: 'link' };
  }
  const landing = String((order && order.landing_site) || '');
  const q = landing.indexOf('?');
  if (q >= 0) {
    try {
      const code = normalizeCode(new URLSearchParams(landing.slice(q + 1)).get('ref'));
      if (code) return { code, via: 'landing' };
    } catch { /* unparseable landing page: no attribution */ }
  }
  return null;
}

/**
 * Is this order fully paid? In store the payment engine's `deposit:fully-paid` tag is the one truth
 * (a draft can convert with a balance pending; buy plans cannot). Online, Shopify's status.
 */
function isPaidInFull(order) {
  if (!order || order.cancelled_at) return false;
  const tags = splitTags(order.tags).map(t => t.toLowerCase());
  if (tags.includes('deposit:fully-paid')) return true;
  if (order.source_name === 'shopify_draft_order') return false;
  return ['paid', 'partially_refunded'].includes(String(order.financial_status || '').toLowerCase());
}

/** Cancelled or fully refunded: a reward it earned is void unless already used. */
function isDead(order) {
  if (!order) return false;
  return !!order.cancelled_at || ['refunded', 'voided'].includes(String(order.financial_status || '').toLowerCase());
}

/**
 * Where a reward row moves on this pass. used / void / rejected are final.
 *   awaiting_payment → earned (paid) | void (dead)
 *   earned           → void (dead, before it was used)
 */
function nextStatus(status, { paid, dead }) {
  if (status === 'awaiting_payment') return dead ? 'void' : paid ? 'earned' : status;
  if (status === 'earned') return dead ? 'void' : status;
  return status;
}

/** Usable today: earned and not past its expiry. */
function isOpen(row, now = new Date()) {
  return !!row && row.status === 'earned' && (!row.expires_at || new Date(row.expires_at) > now);
}

/** Is this loyalty tier key shut out of the programme (Platinum)? */
function tierExcluded(tierKey, cfg) {
  return !!tierKey && ((cfg && cfg.referral && cfg.referral.exclude_tiers) || []).includes(String(tierKey));
}

// ── Supabase ────────────────────────────────────────────────────────────────────────────────────

async function codeRowFor(db, customerId) {
  const { data, error } = await db.from(CODES).select('*').eq('customer_id', String(customerId)).maybeSingle();
  if (error) throw new Error(`referral code read ${customerId}: ${error.message}`);
  return data || null;
}

async function ownerOfCode(db, code) {
  const c = normalizeCode(code);
  if (!c) return null;
  const { data, error } = await db.from(CODES).select('customer_id').eq('code', c).maybeSingle();
  if (error) throw new Error(`referral code lookup ${c}: ${error.message}`);
  return data ? String(data.customer_id) : null;
}

/** The customer's code, made on first ask. A clash on the random part just tries again. */
async function getOrCreateCode(db, customerId, firstName) {
  const existing = await codeRowFor(db, customerId);
  if (existing) return existing.code;
  for (let i = 0; i < 6; i++) {
    const code = makeCode(firstName);
    const { error } = await db.from(CODES).insert({ customer_id: String(customerId), code });
    if (!error) return code;
    if (error.code !== '23505') throw new Error(`referral code create ${customerId}: ${error.message}`);
    const again = await codeRowFor(db, customerId); // the clash was this customer's own row (a race)
    if (again) return again.code;
  }
  throw new Error(`referral code create ${customerId}: no free code after 6 tries`);
}

async function claimFor(db, { customerId, phone }) {
  if (customerId) {
    const { data, error } = await db.from(CLAIMS).select('*').eq('referee_customer_id', String(customerId)).maybeSingle();
    if (error) throw new Error(`referral claim read ${customerId}: ${error.message}`);
    if (data) return data;
  }
  const p = normalizePhone(phone);
  if (!p) return null;
  const { data, error } = await db.from(CLAIMS).select('*').eq('phone', p).order('created_at', { ascending: true }).limit(1);
  if (error) throw new Error(`referral claim read by phone: ${error.message}`);
  return (data && data[0]) || null;
}

async function rewardBySourceOrder(db, orderId) {
  const { data, error } = await db.from(REWARDS).select('*').eq('source_order_id', String(orderId)).maybeSingle();
  if (error) throw new Error(`referral reward read ${orderId}: ${error.message}`);
  return data || null;
}

/** The referrer's usable rewards, oldest first (the first to expire is used first). */
async function openRewards(db, customerId, now = new Date()) {
  const { data, error } = await db.from(REWARDS).select('*')
    .eq('referrer_customer_id', String(customerId)).eq('status', 'earned')
    .order('earned_at', { ascending: true });
  if (error) throw new Error(`referral rewards read ${customerId}: ${error.message}`);
  return (data || []).filter(r => isOpen(r, now));
}

async function updateReward(db, id, patch) {
  const { error } = await db.from(REWARDS).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`referral reward ${id} update: ${error.message}`);
}

/**
 * The reward went on this bill. Only an `earned` row moves; anything else is logged, never thrown:
 * the sale has happened and must not fail on our bookkeeping.
 */
async function markUsed(db, rewardId, { orderId, orderName, channel }) {
  if (!rewardId) return false;
  const { data, error } = await db.from(REWARDS).update({
    status: 'used', used_at: new Date().toISOString(), used_order_id: String(orderId), used_order_name: orderName || null,
    used_channel: channel, updated_at: new Date().toISOString(),
  }).eq('id', rewardId).eq('status', 'earned').select('id');
  if (error) throw new Error(`referral reward ${rewardId} use: ${error.message}`);
  if (!data || !data.length) {
    log.warn('referral', `reward ${rewardId} was not open when ${orderName || orderId} used it (already used, void or expired) — check`);
    return false;
  }
  log.info('referral', `reward ${rewardId} used on ${orderName || orderId} (${channel})`);
  return true;
}

// ── Shopify ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What qualifying needs about a customer. Null when there is no such customer. `orders` is read off
 * the orders connection (oldest first, at most 3: only "none / some" and the first one matter), not
 * numberOfOrders, which the 2024-01 API the core helper speaks does not have.
 */
async function customerFacts(customerId) {
  const data = await graphql(`query($id: ID!) { customer(id: $id) {
      id firstName displayName email phone
      orders(first: 3, sortKey: CREATED_AT) { nodes { legacyResourceId createdAt } } } }`,
  { id: `gid://shopify/Customer/${numericId(customerId)}` });
  const c = data && data.customer;
  if (!c) return null;
  const nodes = (c.orders && c.orders.nodes) || [];
  return {
    id: numericId(c.id), firstName: c.firstName || '', name: c.displayName || '', email: String(c.email || '').toLowerCase(),
    phone: normalizePhone(c.phone), orders: nodes.length,
    firstOrderId: nodes[0] ? String(nodes[0].legacyResourceId) : null,
  };
}

/** The customer with this phone who has bought from us (or, failing that, any with it), or null. */
async function customerByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const data = await graphql(`query($q: String!) { customers(first: 5, query: $q) {
      nodes { id firstName orders(first: 1) { nodes { id } } } } }`, { q: `phone:+91${p}` });
  const nodes = ((data && data.customers && data.customers.nodes) || [])
    .map(n => ({ id: numericId(n.id), firstName: n.firstName || '', orders: ((n.orders && n.orders.nodes) || []).length }))
    .sort((a, b) => b.orders - a.orders);
  return nodes[0] || null;
}

async function tierKeyOf(customerId, cfg) {
  const points = await ledger.customerPoints(supabase, customerId);
  const t = E.tierFor(points, cfg);
  return t.tier ? t.tier.key : null;
}

// ── Earning: called from earn.js on every order pass ───────────────────────────────────────────

/**
 * Decide whether this order earns its referrer a reward. Returns { ok, reason, referrerId }.
 * Rejections are stored with their reason so staff can see why, and so they are not re-checked.
 */
async function qualify(order, attr, cfg) {
  const refereeId = order.customer && order.customer.id ? String(order.customer.id) : '';
  if (!refereeId) return { ok: false, reason: 'no customer on the order' };
  const referrerId = await ownerOfCode(supabase, attr.code);
  if (!referrerId) return { ok: false, reason: `unknown code ${attr.code}` };
  if (referrerId === refereeId) return { ok: false, reason: 'own code', referrerId };
  const [referrer, referee] = await Promise.all([customerFacts(referrerId), customerFacts(refereeId)]);
  if (!referrer) return { ok: false, reason: 'referrer not found', referrerId };
  const orderPhone = normalizePhone(order.phone || (order.billing_address || {}).phone || (order.customer || {}).phone);
  const orderEmail = String(order.email || (order.customer || {}).email || '').toLowerCase();
  if ((referrer.phone && [orderPhone, referee && referee.phone].includes(referrer.phone)) ||
      (referrer.email && [orderEmail, referee && referee.email].includes(referrer.email))) {
    return { ok: false, reason: 'same phone or email as the referrer', referrerId };
  }
  if (referee && referee.firstOrderId && referee.firstOrderId !== String(order.id)) {
    return { ok: false, reason: 'not the customer\'s first order', referrerId };
  }
  if (tierExcluded(await tierKeyOf(referrerId, cfg), cfg)) return { ok: false, reason: 'referrer is on the top tier', referrerId };
  return { ok: true, reason: '', referrerId };
}

/**
 * One order pass. points is what earn.js just worked out for the order (0 = not a sale, e.g. a CAD
 * advance receipt, or fully refunded). Idempotent: the reward row is keyed by the friend's order.
 */
async function onOrder(order, { points = 0, cfg } = {}) {
  cfg = cfg || await loadConfig();
  if (!cfg.referral || !cfg.referral.enabled || !order || !order.id) return null;
  const existing = await rewardBySourceOrder(supabase, order.id);
  const paid = points > 0 && isPaidInFull(order);
  if (existing) {
    const dead = isDead(order) || (existing.status === 'earned' && !(points > 0));
    const next = nextStatus(existing.status, { paid, dead });
    if (next === existing.status) return existing;
    const now = new Date().toISOString();
    await updateReward(supabase, existing.id, {
      status: next,
      ...(next === 'earned' ? { earned_at: now, expires_at: expiryFrom(now, cfg.referral.reward_months) } : {}),
      ...(next === 'void' ? { reason: isDead(order) ? 'friend\'s order cancelled or refunded' : 'friend\'s order no longer counts' } : {}),
    });
    log.info('referral', `order ${order.name}: reward ${existing.id} ${existing.status} → ${next}`);
    if (next === 'earned') notifyEarned(existing.referrer_customer_id, cfg).catch(e => log.warn('referral', `reward email: ${e.message}`));
    return { ...existing, status: next };
  }

  let attr = attributionFrom(order);
  if (!attr) {
    const claim = await claimFor(supabase, {
      customerId: order.customer && order.customer.id,
      phone: order.phone || (order.billing_address || {}).phone || (order.customer || {}).phone,
    });
    if (claim) attr = { code: claim.code, via: 'claim' };
  }
  if (!attr) return null;
  if (!(points > 0)) return null; // not a sale: nothing to reward, and the real sale gets its own pass

  const q = await qualify(order, attr, cfg);
  const now = new Date().toISOString();
  const earned = q.ok && paid;
  const row = {
    source_order_id: String(order.id), source_order_name: order.name || null,
    referrer_customer_id: q.referrerId || null,
    referee_customer_id: order.customer && order.customer.id ? String(order.customer.id) : null,
    code: attr.code, via: attr.via,
    status: !q.ok ? 'rejected' : earned ? 'earned' : 'awaiting_payment',
    reason: q.reason || null,
    earned_at: earned ? now : null,
    expires_at: earned ? expiryFrom(now, cfg.referral.reward_months) : null,
  };
  const { data, error } = await supabase.from(REWARDS).insert(row).select('*');
  if (error) {
    if (error.code === '23505') return rewardBySourceOrder(supabase, order.id); // a parallel pass got there first
    throw new Error(`referral reward insert ${order.name}: ${error.message}`);
  }
  log.info('referral', `order ${order.name}: ${attr.via} referral ${attr.code} → ${row.status}${row.reason ? ` (${row.reason})` : ''}`);
  if (earned) notifyEarned(row.referrer_customer_id, cfg).catch(e => log.warn('referral', `reward email: ${e.message}`));
  return (data && data[0]) || row;
}

/** "Your friend shopped" — off until the founder signs off the copy (emails.referral_reward). */
async function notifyEarned(referrerId, cfg) {
  if (!cfg.emails || !cfg.emails.referral_reward || !referrerId) return;
  const c = await customerFacts(referrerId);
  if (!c || !c.email) return;
  const { sendEmail } = require('../../integrations/email');
  const { buildReferralRewardHtml } = require('../../integrations/email/templates');
  await sendEmail({
    to: c.email,
    subject: `Your friend shopped at Timanti: ${cfg.referral.pct}% off diamonds is yours`,
    html: buildReferralRewardHtml({ firstName: c.firstName, pct: cfg.referral.pct, months: cfg.referral.reward_months }),
  });
  log.info('referral', `reward email sent to customer ${referrerId}`);
}

// ── Redeeming: loyalty or the reward, whichever saves more ─────────────────────────────────────

/**
 * loyaltyResult is engine.computeLoyalty's answer for these lines (may be a refusal). Returns the
 * better of the two in the same shape; a referral winner carries `reward`. Any failure reading the
 * rewards falls back to loyalty: the counter is never blocked by the referral programme.
 */
async function bestFor(customerId, loyaltyResult, lines, cfg) {
  if (!cfg || !cfg.referral || !cfg.referral.enabled || !customerId) return loyaltyResult;
  if (tierExcluded(loyaltyResult && loyaltyResult.tier ? loyaltyResult.tier.key : null, cfg)) return loyaltyResult;
  let rewards = [];
  try { rewards = await openRewards(supabase, customerId); }
  catch (e) { log.warn('referral', `rewards read for ${customerId} failed, loyalty only: ${e.message}`); return loyaltyResult; }
  if (!rewards.length) return loyaltyResult;
  return E.pickBenefit(loyaltyResult, E.computeReferral({ lines, cfg }), rewards[0]);
}

// ── Storefront (app proxy) ─────────────────────────────────────────────────────────────────────

/** Everything the "Refer a friend" card shows for the logged-in customer. */
async function viewFor(customerId) {
  const cfg = await loadConfig();
  const r = cfg.referral || {};
  const base = { loggedIn: true, enabled: !!r.enabled, pct: r.pct, months: r.reward_months };
  if (!r.enabled) return base;
  const c = await customerFacts(customerId);
  if (!c) return { ...base, found: false };
  if (c.orders < 1) return { ...base, found: true, eligible: false, reason: 'first-purchase', firstName: c.firstName };
  const tierKey = await tierKeyOf(customerId, cfg);
  if (tierExcluded(tierKey, cfg)) {
    const tier = (cfg.tiers || []).find(t => t.key === tierKey);
    return { ...base, found: true, eligible: false, reason: 'top-tier', tierName: tier ? tier.name : '', firstName: c.firstName };
  }
  const code = await getOrCreateCode(supabase, customerId, c.firstName);
  const open = await openRewards(supabase, customerId);
  const { count } = await supabase.from(REWARDS).select('id', { count: 'exact', head: true })
    .eq('referrer_customer_id', String(customerId)).in('status', ['earned', 'used']);
  return {
    ...base, found: true, eligible: true, firstName: c.firstName,
    code, link: linkFor(code, cfg),
    available: open.length, rewards: open.map(x => ({ expires_at: x.expires_at })), friends: count || 0,
  };
}

/**
 * The cart embed saw ?ref= in this browser and the visitor is now logged in: remember which code
 * brought them. First claim wins. Ignored for the code's owner and for anyone who has bought before.
 */
async function claim(customerId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'no code' };
  const owner = await ownerOfCode(supabase, code);
  if (!owner) return { ok: false, reason: 'unknown code' };
  if (owner === String(customerId)) return { ok: false, reason: 'own code' };
  const c = await customerFacts(customerId);
  if (!c) return { ok: false, reason: 'not found' };
  if (c.orders > 0) return { ok: false, reason: 'existing customer' };
  const { error } = await supabase.from(CLAIMS).insert({ referee_customer_id: String(customerId), code, phone: c.phone || null });
  if (error && error.code !== '23505') throw new Error(`referral claim ${customerId}: ${error.message}`);
  if (!error) log.info('referral', `customer ${customerId} claimed referral code ${code}`);
  return { ok: true };
}

// ── In store: the draft tag ────────────────────────────────────────────────────────────────────

/**
 * Staff tag a draft `ref:<code>` or `ref:<referrer's phone>`. This step checks it and leaves exactly
 * one of `referred:<CODE>` (good; it travels to the order) or `ref-invalid: <why>`. Costs nothing on
 * drafts without a ref: tag. Tags stay within Shopify's 40 characters.
 */
async function handleReferralTagStep(draft) {
  if (!config.loyalty.enabled || !draft || !draft.id) return;
  const tags = splitTags(draft.tags);
  const input = tags.find(t => T_INPUT.test(t));
  if (!input) return;
  const cfg = await loadConfig();
  const raw = input.slice(input.indexOf(':') + 1).trim();
  let owner = null;
  let code = '';
  let invalid = '';
  if (!cfg.referral || !cfg.referral.enabled) invalid = 'programme off';
  else if (normalizePhone(raw)) {
    const c = await customerByPhone(raw);
    if (!c) invalid = 'no customer with that phone';
    else if (c.orders < 1) invalid = 'referrer has not bought yet';
    else { owner = c.id; code = await getOrCreateCode(supabase, c.id, c.firstName); }
  } else {
    code = normalizeCode(raw);
    owner = code ? await ownerOfCode(supabase, code) : null;
    if (!owner) invalid = 'unknown code';
  }
  if (!invalid && draft.customer && String(draft.customer.id) === owner) invalid = 'own code';
  if (!invalid && tierExcluded(await tierKeyOf(owner, cfg), cfg)) invalid = 'referrer is top tier';
  const next = tags.filter(t => !T_INPUT.test(t) && !/^ref-invalid/i.test(t) && !t.toLowerCase().startsWith(T_DONE));
  next.push(invalid ? `${T_INVALID}: ${invalid}`.slice(0, 40) : `${T_DONE}${code}`);
  await putJson(`draft_orders/${draft.id}.json`, { draft_order: { id: draft.id, tags: [...new Set(next)].join(', ') } });
  log.info('referral', `draft ${draft.name || draft.id}: ${input} → ${invalid ? `invalid (${invalid})` : `referred by ${owner} (${code})`}`);
}

// ── Operator ───────────────────────────────────────────────────────────────────────────────────

async function listRewards({ status, referrer } = {}) {
  let q = supabase.from(REWARDS).select('*').order('created_at', { ascending: false }).limit(500);
  if (status) q = q.eq('status', status);
  if (referrer) q = q.eq('referrer_customer_id', String(referrer));
  const { data, error } = await q;
  if (error) throw new Error(`referral rewards list: ${error.message}`);
  return data || [];
}

module.exports = {
  // pure
  normalizeCode, normalizePhone, makeCode, linkFor, expiryFrom, attributionFrom, isPaidInFull, isDead,
  nextStatus, isOpen, tierExcluded,
  // flows
  onOrder, qualify, bestFor, markUsed, viewFor, claim, handleReferralTagStep, listRewards,
  getOrCreateCode, ownerOfCode, openRewards,
  T_DONE,
};
