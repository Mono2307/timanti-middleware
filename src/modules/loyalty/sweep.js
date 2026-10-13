'use strict';

/**
 * Daily loyalty housekeeping (started from the bootstrap's listen callback, like the voucher-expiry
 * sweep):
 *
 *   1. Expired one-time online codes: delete the Shopify discount and mark the redemption expired,
 *      so unused codes do not pile up in Shopify's discount list.
 *   2. The occasion tag `loyalty-occasion-month`: on for customers whose birthday or anniversary is
 *      this calendar month (IST), off for everyone else who carries it. Shopify Flow, segments and
 *      Shopify Email key off this tag ("your extra 2% is live this month"). The discount itself never
 *      reads the tag — it checks the dates live — so a missed sweep cannot cost a customer the bonus.
 *
 * Customers considered for the tag: anyone with a tier tag, anyone captured through Typeform (that
 * is where the dates come from), and anyone already carrying the tag (so it is removed next month).
 */

const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { config } = require('../../core/config');
const { log } = require('../../core/logger');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');
const { deleteDiscountNode } = require('./online');
const { sendEmail } = require('../../integrations/email');
const { buildLoyaltyOccasionHtml } = require('../../integrations/email/templates');

const OCCASION_TAG = 'loyalty-occasion-month';
const DAY_MS = 24 * 60 * 60 * 1000;

async function expireCodes() {
  const rows = await ledger.expiredPendingCodes(supabase);
  let n = 0;
  for (const r of rows) {
    if (r.discount_node_id) await deleteDiscountNode(r.discount_node_id);
    await ledger.updateRedemption(supabase, r.id, { status: 'expired' });
    n++;
  }
  return n;
}

async function occasionTags({ dryRun = false } = {}) {
  const cfg = await loadConfig();
  const query = `tag:'${OCCASION_TAG}' OR tag:TYPEFORM OR ${cfg.tiers.map(t => `tag:'loyalty-${t.key}'`).join(' OR ')}`;
  let after = null;
  let added = 0, removed = 0, seen = 0, emailed = 0;
  for (let page = 0; page < 200; page++) {
    const data = await graphql(`query($q: String!, $after: String) {
        customers(first: 100, after: $after, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes { id tags email firstName
            birthday:    metafield(namespace: "custom", key: "birthday")    { value }
            anniversary: metafield(namespace: "custom", key: "anniversary") { value } } } }`,
      { q: query, after });
    const conn = data.customers;
    for (const c of conn.nodes) {
      seen++;
      const occ = E.occasionBonus({ birthday: c.birthday && c.birthday.value, anniversary: c.anniversary && c.anniversary.value }, new Date(), cfg);
      // For marketing, any birthday/anniversary this month counts, whatever the bonus percentage.
      const inMonth = occ.occasions.length > 0 ||
        [c.birthday, c.anniversary].some(m => m && E.monthOf(m.value) === E.istMonth());
      const has = (c.tags || []).includes(OCCASION_TAG);
      if (inMonth && !has) {
        if (!dryRun) {
          await graphql(`mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { message } } }`, { id: c.id, t: [OCCASION_TAG] });
          // The tag goes on once a month, so this is also the once-a-month send.
          if (await sendOccasionEmail(c, occ, cfg)) emailed++;
        }
        added++;
      } else if (!inMonth && has) {
        if (!dryRun) await graphql(`mutation($id: ID!, $t: [String!]!) { tagsRemove(id: $id, tags: $t) { userErrors { message } } }`, { id: c.id, t: [OCCASION_TAG] });
        removed++;
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { seen, added, removed, emailed };
}

/** Last day of the current IST month, e.g. "31 October". */
function monthEndLabel(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const last = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0));
  return last.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * "Happy birthday month" email for a tier member whose bonus is live this month. Off unless
 * emails.occasion is on. Customers below the first tier get no bonus, so no email.
 */
async function sendOccasionEmail(c, occ, cfg) {
  if (!cfg.emails.occasion || !c.email || !occ.occasions.length) return false;
  const tier = cfg.tiers.find(t => (c.tags || []).includes(`loyalty-${t.key}`));
  if (!tier) return false;
  const occasion = occ.occasions.includes('birthday') ? 'birthday' : 'anniversary';
  try {
    await sendEmail({
      to: c.email,
      subject: occasion === 'birthday' ? 'Happy birthday month from Timanti' : 'Happy anniversary month from Timanti',
      html: buildLoyaltyOccasionHtml({
        firstName: c.firstName,
        occasion,
        totalPct: Number(tier.pct) + occ.pct,
        bonusPct: occ.pct,
        monthEnd: monthEndLabel(),
        inStoreOnly: !cfg.emails.online_live,
      }),
    });
    log.info('loyalty', `occasion email (${occasion}) sent to customer ${c.id}`);
    return true;
  } catch (e) {
    log.error('loyalty', `occasion email to ${c.id} failed: ${e.message}`);
    return false;
  }
}

/**
 * Nightly safety net: re-earn every order touched in the last 90 days (an in-store refund recorded
 * without a webhook) and every order with redeemed after-sales credit against it. Each goes through
 * the normal earning path, which only writes when the figure actually changed.
 */
const RECHECK_DAYS = 90;
async function recheckOrders() {
  const { getJson } = require('../../core/shopify');
  const afterSales = require('./after_sales');
  const { reearnOrderByName } = require('./earn');
  const since = new Date(Date.now() - RECHECK_DAYS * DAY_MS).toISOString();
  const names = new Set(await afterSales.sourceOrdersWithRedemptions(supabase).catch(() => []));
  let url = `orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(since)}&fields=name`;
  for (let page = 0; page < 20 && url; page++) {
    const body = await getJson(url);
    for (const o of body.orders || []) names.add(o.name);
    url = null; // one page of 250 covers the store's volume; widen here if that ever changes
  }
  let n = 0;
  for (const name of names) {
    try { if (await reearnOrderByName(name, { now: true })) n++; } catch (e) { log.warn('loyalty', `re-check ${name}: ${e.message}`); }
  }
  return n;
}

async function runLoyaltySweep({ dryRun = false } = {}) {
  const expired = dryRun ? 0 : await expireCodes().catch(e => { log.error('loyalty', `code expiry failed: ${e.message}`); return 0; });
  const tags = await occasionTags({ dryRun }).catch(e => { log.error('loyalty', `occasion tags failed: ${e.message}`); return null; });
  const rechecked = dryRun ? 0 : await recheckOrders().catch(e => { log.error('loyalty', `order re-check failed: ${e.message}`); return 0; });
  log.info('loyalty', `sweep${dryRun ? ' (dry run)' : ''}: ${expired} code(s) expired; occasion tag ${tags ? `+${tags.added} −${tags.removed} of ${tags.seen}, ${tags.emailed} emailed` : 'failed'}; ${rechecked} order(s) re-checked`);
  return { expired, tags, rechecked };
}

/** Once shortly after boot, then daily. No-op unless LOYALTY_ENABLED. */
function startLoyaltySweep() {
  if (!config.loyalty.enabled) return;
  const kick = () => runLoyaltySweep().catch(e => log.error('loyalty', `sweep failed: ${e.message}`));
  setTimeout(kick, 3 * 60 * 1000);
  setInterval(kick, DAY_MS);
}

module.exports = { OCCASION_TAG, runLoyaltySweep, startLoyaltySweep, expireCodes, occasionTags, monthEndLabel, sendOccasionEmail };
