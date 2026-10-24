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
 *   loyalty.making_pct      number_decimal   the tier's making discount
 *   loyalty.making_cap      number_integer   most the making discount takes off one purchase (pre-tax Rs, 0 = none)
 *   loyalty.next_tier_name  single_line_text
 *   loyalty.next_tier_gap   number_integer   rupees still to spend for the next tier
 *
 * Tags: loyalty-T1 / loyalty-T2 / loyalty-T3 (exactly one, or none). These drive segments and Flow.
 */

const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { log } = require('../../core/logger');
const { sendEmail } = require('../../integrations/email');
const { buildLoyaltyTierUpHtml } = require('../../integrations/email/templates');
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
      discountPct: metafield(namespace: "loyalty", key: "discount_pct") { value }
      makingPct:   metafield(namespace: "loyalty", key: "making_pct")   { value }
      makingCap:   metafield(namespace: "loyalty", key: "making_cap")   { value }
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
    // The rates last published, so a change of grid republishes customers whose tier did not move.
    rates: [c.discountPct, c.makingPct, c.makingCap].map(m => (m ? Number(m.value) : null)),
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
    mf('making_pct', 'number_decimal', tier ? tier.making_pct || 0 : 0),
    mf('making_cap', 'number_integer', tier ? Math.round(tier.making_cap || 0) : 0),
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
  const want = info.tier ? [info.tier.pct, info.tier.making_pct || 0, Math.round(info.tier.making_cap || 0)] : [0, 0, 0];
  const ratesOk = (customer.rates || []).every((v, i) => v === want[i]);
  if (!tierChanged && customer.points === Math.floor(points) && tagOk && ratesOk) {
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

function tierEmailHtml(customer, info, cfg = {}) {
  return buildLoyaltyTierUpHtml({
    firstName: customer.firstName,
    tierName: info.tier.name,
    pct: info.tier.pct,
    makingPct: info.tier.making_pct,
    makingCap: info.tier.making_cap,
    nextName: info.next ? info.next.name : null,
    nextPct: info.next ? info.next.pct : null,
    nextMakingPct: info.next ? info.next.making_pct : null,
    nextMakingCap: info.next ? info.next.making_cap : null,
    nextGap: info.next ? Math.ceil(info.gapToNext) : 0,
    inStoreOnly: !((cfg.emails || {}).online_live),
  });
}

async function sendTierEmail(customer, info) {
  const cfg = await loadConfig();
  await sendEmail({
    to: customer.email,
    subject: `You're now a Timanti ${info.tier.name} member`,
    html: tierEmailHtml(customer, info, cfg),
  });
  log.info('loyalty', `tier email sent to customer ${customer.id} (${info.tier.key})`);
}

module.exports = { readCustomer, refreshCustomer, publishToCustomer, swapTierTags, tierEmailHtml, gid, numericId };
