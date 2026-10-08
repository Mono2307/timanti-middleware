'use strict';

/**
 * The customer side of loyalty: reading a customer's dates and current tier from Shopify, and
 * publishing the ledger's verdict back onto the customer as metafields and tags.
 *
 * The ledger (Supabase) is the truth. The customer metafields are a COPY, written so that the
 * things that cannot reach Supabase can still see the tier: the customer-account page, the cart
 * block's Liquid, Shopify Flow, customer segments, and staff looking at the admin customer page.
 *
 *   loyalty.points          number_integer   lifetime points
 *   loyalty.tier            single_line_text tier key (T1/T2/T3) or 'none'
 *   loyalty.tier_name       single_line_text display name
 *   loyalty.tier_since      date             when the current tier was reached
 *   loyalty.discount_pct    number_decimal   the tier's diamond discount, excluding occasions
 *   loyalty.next_tier_name  single_line_text
 *   loyalty.next_tier_gap   number_integer   rupees still to spend for the next tier
 *
 * Tags: loyalty-T1 / loyalty-T2 / loyalty-T3 (exactly one, or none). These drive segments and Flow.
 */

const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { log } = require('../../core/logger');
const { sendEmail } = require('../../integrations/email');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');

const TIER_TAG_RE = /^loyalty-T\d+$/i;
const gid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Customer/${id}`);
const numericId = (id) => String(id).replace(/^gid:\/\/shopify\/Customer\//, '');

/** Everything loyalty needs to know about a customer, in one GraphQL read. Null if not found. */
async function readCustomer(customerId) {
  const data = await graphql(`query($id: ID!) { customer(id: $id) {
      id email firstName lastName displayName tags
      birthday:    metafield(namespace: "custom",  key: "birthday")     { value }
      anniversary: metafield(namespace: "custom",  key: "anniversary")  { value }
      tier:        metafield(namespace: "loyalty", key: "tier")         { value }
      tierSince:   metafield(namespace: "loyalty", key: "tier_since")   { value }
      points:      metafield(namespace: "loyalty", key: "points")       { value }
    } }`, { id: gid(customerId) });
  const c = data && data.customer;
  if (!c) return null;
  return {
    id: numericId(c.id),
    email: c.email || '',
    firstName: c.firstName || '',
    name: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' '),
    tags: c.tags || [],
    birthday: c.birthday ? c.birthday.value : null,
    anniversary: c.anniversary ? c.anniversary.value : null,
    tierKey: c.tier ? c.tier.value : 'none',
    tierSince: c.tierSince ? c.tierSince.value : null,
    points: c.points ? Number(c.points.value) : null,
  };
}

/** Write the loyalty metafields and swap the tier tag. One mutation each. */
async function publishToCustomer(customerId, { points, info, tierSince }) {
  const ownerId = gid(customerId);
  const tier = info.tier;
  const mf = (key, type, value) => ({ ownerId, namespace: 'loyalty', key, type, value: String(value) });
  const metafields = [
    mf('points', 'number_integer', Math.floor(points)),
    mf('tier', 'single_line_text_field', tier ? tier.key : 'none'),
    mf('tier_name', 'single_line_text_field', tier ? tier.name : 'Member'),
    mf('discount_pct', 'number_decimal', tier ? tier.pct : 0),
    mf('next_tier_name', 'single_line_text_field', info.next ? info.next.name : '-'),
    mf('next_tier_gap', 'number_integer', Math.max(0, Math.ceil(info.gapToNext || 0))),
  ];
  if (tierSince) metafields.push(mf('tier_since', 'date', tierSince));
  const set = await graphql(`mutation($m: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $m) { userErrors { field message } } }`, { m: metafields });
  const errs = (set && set.metafieldsSet && set.metafieldsSet.userErrors) || [];
  if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
}

async function swapTierTags(customerId, currentTags, tierKey) {
  const want = tierKey && tierKey !== 'none' ? `loyalty-${tierKey}` : null;
  const stale = (currentTags || []).filter(t => TIER_TAG_RE.test(t) && t !== want);
  if (stale.length) {
    await graphql(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: gid(customerId), tags: stale });
  }
  if (want && !(currentTags || []).includes(want)) {
    await graphql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: gid(customerId), tags: [want] });
  }
}

/**
 * Recompute a customer's points and tier from the ledger and publish them to Shopify.
 *
 * Skips the writes when nothing moved (the common case on duplicate webhook deliveries).
 * notify: send the tier-change email when the tier went UP and emails are switched on in config.
 * Backfills pass notify:false so loading history never emails anyone.
 */
async function refreshCustomer(customerId, { notify = false } = {}) {
  if (!customerId) return null;
  const cfg = await loadConfig();
  const points = await ledger.customerPoints(supabase, customerId);
  const info = E.tierFor(points, cfg);
  const customer = await readCustomer(customerId);
  if (!customer) { log.warn('loyalty', `customer ${customerId} not found in Shopify — ledger kept, nothing published`); return null; }

  const newKey = info.tier ? info.tier.key : 'none';
  const tierChanged = newKey !== (customer.tierKey || 'none');
  const tagOk = newKey === 'none'
    ? !customer.tags.some(t => TIER_TAG_RE.test(t))
    : customer.tags.includes(`loyalty-${newKey}`) && customer.tags.filter(t => TIER_TAG_RE.test(t)).length === 1;
  if (!tierChanged && customer.points === Math.floor(points) && tagOk) {
    return { customerId, points, tier: info.tier, changed: false };
  }

  const tierSince = tierChanged ? (info.tier ? E.istDate() : null) : customer.tierSince;
  await publishToCustomer(customerId, { points, info, tierSince });
  await swapTierTags(customerId, customer.tags, newKey);

  const rank = (key) => cfg.tiers.findIndex(t => t.key === key);
  const wentUp = tierChanged && info.tier && rank(newKey) > rank(customer.tierKey);
  if (notify && wentUp && cfg.emails.tier_change && customer.email) {
    sendTierEmail(customer, info).catch(e => log.error('loyalty', `tier email to ${customerId} failed: ${e.message}`));
  }
  log.info('loyalty', `customer ${customerId}: ${Math.floor(points)} pts, tier ${customer.tierKey || 'none'} → ${newKey}`);
  return { customerId, points, tier: info.tier, changed: true, tierChanged, wentUp };
}

const inr = (v) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');

function tierEmailHtml(customer, info) {
  const t = info.tier;
  const next = info.next
    ? `<p style="margin:0 0 12px">Spend ${inr(info.gapToNext)} more to reach <b>${info.next.name}</b> and ${info.next.pct}% off.</p>`
    : '';
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#222;line-height:1.5">
    <h2 style="font-weight:normal;margin:0 0 16px">Welcome to ${t.name}, ${customer.firstName || 'there'}</h2>
    <p style="margin:0 0 12px">Thank you for choosing Timanti. Your purchases with us have reached ${inr(info.points)},
      which makes you a <b>${t.name}</b> member.</p>
    <p style="margin:0 0 12px">From today you get <b>${t.pct}% off the diamond value</b> of eligible pieces,
      online and in our stores, with an extra 2% in your birthday and anniversary months.</p>
    ${next}
    <p style="margin:0 0 12px">Online, log in to your account and use the "My benefits" box in your cart. In store, just let us know.</p>
    <p style="margin:24px 0 0;color:#777;font-size:13px">Team Timanti</p></div>`;
}

async function sendTierEmail(customer, info) {
  await sendEmail({
    to: customer.email,
    subject: `You're now a Timanti ${info.tier.name} member`,
    html: tierEmailHtml(customer, info),
  });
  log.info('loyalty', `tier email sent to customer ${customer.id} (${info.tier.key})`);
}

module.exports = { readCustomer, refreshCustomer, publishToCustomer, swapTierTags, tierEmailHtml, gid, numericId };
