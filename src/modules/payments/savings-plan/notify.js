'use strict';

// Savings plan — every message the plan sends. Customer mail goes to the customer (the email
// chokepoint Bccs the store as usual); staff mail is internal. Payment links also go by SMS.
// Every customer email carries a click-to-WhatsApp link to the store: on a 10-month plan it asks for
// early redemption (HQ, 11 Nov 2026), otherwise it is a plain "message us".

const { sendEmail } = require('../../../integrations/email');
const { sendSMS } = require('../../../integrations/sms');
const T = require('../../../integrations/email/templates');
const { config } = require('../../../core/config');
const R = require('./rules');
const { adminDraftUrl, todayIst } = require('./draft');

const STORE = () => config.email.store || 'hsrstore@timanti.in';
// The store's WhatsApp (config.savingsPlan.whatsapp; default the offline number, templates.js SUPPORT_PHONE).
const STORE_WHATSAPP = () => String(config.savingsPlan.whatsapp || '917710968305').replace(/\D/g, '');
const rupees = (n) => `Rs${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;
const phoneOf = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const fullBonus = (plan) => Math.round(Number(plan.instalment) * (R.PLANS[plan.months]?.fullPct || 0) / 100);

function whatsappToStore(plan, { early = Number(plan.months) === 10 } = {}) {
  const text = early
    ? `Hello Timanti, I would like to redeem my savings plan ${plan.draft_name} early. Please let me know what it comes to.`
    : `Hello Timanti, I have a question about my savings plan ${plan.draft_name}.`;
  return { url: `https://wa.me/${STORE_WHATSAPP()}?text=${encodeURIComponent(text)}`,
    label: early ? 'Ask about redeeming early on WhatsApp' : 'Message us on WhatsApp' };
}

// The plan's terms, as the bullets in every customer email (design v5).
function termsFor(plan) {
  const A = Number(plan.instalment);
  const bonusLine = Number(plan.months) === 10
    ? `Pay all 10 and you get a bonus of one full instalment (${rupees(fullBonus(plan))}), so your voucher is ${rupees(A * 11)}.`
    : `Pay all 6 and you get a bonus of half an instalment (${rupees(fullBonus(plan))}), so your voucher is ${rupees(A * 6 + fullBonus(plan))}.`;
  return [
    `Pay ${rupees(A)} every month, by the link we send or at the store.`,
    bonusLine,
    ...(Number(plan.months) === 10 ? ['You can also redeem early: from month 6 with 5 paid (a quarter of an instalment as bonus), or from month 8 with 7 paid (half an instalment).'] : []),
    `The bonus needs no more than ${R.LATE_LIMIT} late payments.`,
    `A missed instalment can be paid up to ${R.GRACE_DAYS} days after its due date. After that the plan closes and what you have paid comes back as a Savings Scheme Voucher, without the bonus.`,
    'Your Savings Scheme Voucher is valid for 1 year on any Timanti jewellery except coins, silver and loose solitaires. There are no cash refunds.',
  ];
}

async function toCustomer(plan, { subject, heading, body, st, link, sms, terms = false, early }) {
  const phone = phoneOf(plan.customer_phone);
  if (sms && phone) await sendSMS(phone, sms);
  const wa = whatsappToStore(plan, early === undefined ? {} : { early });
  await sendEmail({
    to: plan.customer_email,
    subject: `${subject} (${plan.draft_name})`,
    html: T.buildSavingsPlanHtml({
      draftName: plan.draft_name, heading, body,
      payUrl: link ? link.shortUrl : null, amount: link ? link.amount : 0,
      rows: st ? st.rows : null, paid: st ? st.paid : 0,
      terms: terms ? termsFor(plan) : null, whatsappUrl: wa.url, whatsappLabel: wa.label,
    }),
  });
}

const who = (plan, rest) => (plan.customer_name ? `${plan.customer_name}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));

async function sendStarted(plan, d, st, link) {
  await toCustomer(plan, {
    subject: 'Your Timanti Savings Plan has started', heading: 'Your savings plan has started', st, link, terms: true,
    body: who(plan, `you are saving <strong>${rupees(plan.instalment)}</strong> a month for <strong>${plan.months} months</strong>. `
      + `At the end, everything you have saved plus your bonus comes to you as a Savings Scheme Voucher for any Timanti jewellery.`
      + (link ? ' Your first instalment is below.' : '')),
    sms: link ? `Timanti savings plan ${plan.draft_name} has started: ${rupees(plan.instalment)} a month for ${plan.months} months. First instalment: ${link.shortUrl}` : null,
  });
}

async function sendDue(plan, d, st, link, { k, dueDate, overdue = false }) {
  await toCustomer(plan, {
    subject: overdue ? `Instalment ${k} on your savings plan is overdue` : `Instalment ${k} of ${plan.months} on your savings plan: ${rupees(link.amount)}`,
    heading: overdue ? `Instalment ${k} is overdue` : `Instalment ${k} is due on ${T.planDate(dueDate)}`,
    body: overdue
      ? who(plan, `instalment ${k} of your savings plan was due on <strong>${T.planDate(dueDate)}</strong>. Please pay <strong>${rupees(link.amount)}</strong> to keep your plan and your bonus on track.`)
      : who(plan, `instalment ${k} of ${plan.months} on your savings plan is <strong>${rupees(link.amount)}</strong>, due on <strong>${T.planDate(dueDate)}</strong>.`),
    st, link, terms: true,
    sms: `Timanti savings plan ${plan.draft_name}: instalment ${k} of ${plan.months}, ${rupees(link.amount)}${overdue ? ' (overdue)' : `, due ${T.planDate(dueDate)}`}. Pay: ${link.shortUrl}`,
  });
}

// Day 15 / day 25 of the 30-day grace. earlyNow: what an early redemption would pay today (or null).
async function sendGraceWarning(plan, d, st, link, { days, closeOn, earlyNow }) {
  const earlyLine = earlyNow
    ? ` You can also redeem your plan now for <strong>${rupees(earlyNow.value)}</strong> (including a bonus of ${rupees(earlyNow.bonus)}): message us on WhatsApp before ${T.planDate(closeOn)}.`
    : '';
  await toCustomer(plan, {
    subject: `Your savings plan closes on ${T.planDate(closeOn)} unless instalment ${st.next.k} is paid`,
    heading: `Your savings plan closes on ${T.planDate(closeOn)}`,
    body: who(plan, `instalment ${st.next.k} was due on <strong>${T.planDate(st.next.due)}</strong>, ${days} days ago. If it is not paid by <strong>${T.planDate(R.addDays(closeOn, -1))}</strong>, the plan closes and the <strong>${rupees(st.paid)}</strong> you have saved comes back as a Savings Scheme Voucher, without the bonus.${earlyLine}`),
    st, link, early: Boolean(earlyNow) || undefined,
    sms: `Timanti savings plan ${plan.draft_name}: instalment ${st.next.k} is ${days} days late. Pay by ${T.planDate(R.addDays(closeOn, -1))} or the plan closes. Pay: ${link ? link.shortUrl : 'see your email'}`,
  });
}

async function sendReceived(plan, d, st, amount) {
  const next = st.next ? ` Your next instalment, <strong>${rupees(plan.instalment)}</strong>, is due on <strong>${T.planDate(st.next.due)}</strong>. We will send you a link a few days before.` : '';
  await toCustomer(plan, {
    subject: 'Payment received, thank you', heading: 'Payment received, thank you', st,
    body: who(plan, `we have received <strong>${rupees(amount)}</strong> into your savings plan. You have saved <strong>${rupees(st.paid)}</strong> so far.${next}`),
  });
}

// A 10-month plan has reached an early-redemption step (month 6 or month 8).
async function sendEarlyOpen(plan, d, st) {
  const r = st.redeem;
  await toCustomer(plan, {
    subject: `You can now redeem your savings plan early: ${rupees(r.value)}`, heading: 'You can redeem your plan early',
    body: who(plan, `you have paid ${st.paidCount} instalments, so you can redeem your plan now for <strong>${rupees(r.value)}</strong>`
      + (r.bonus > 0 ? ` (${rupees(st.paid)} saved plus a bonus of ${rupees(r.bonus)})` : ' (more than two payments were late, so there is no bonus)')
      + `. Or keep saving: pay all ${st.n} and your voucher is <strong>${rupees(st.n * st.A + (st.bonusOk ? fullBonus(plan) : 0))}</strong>. To redeem, message us on WhatsApp.`),
    st, early: true,
  });
}

async function sendFullyPaid(plan, d, st) {
  const r = st.redeem;
  await toCustomer(plan, {
    subject: 'Your savings plan is complete', heading: 'Your savings plan is complete',
    body: who(plan, `you have paid all ${st.n} instalments, <strong>${rupees(st.paid)}</strong>.`
      + (r.bonus > 0 ? ` With your bonus of ${rupees(r.bonus)}, your Savings Scheme Voucher will be <strong>${rupees(r.value)}</strong>.` : ` More than two payments were late, so there is no bonus: your Savings Scheme Voucher will be <strong>${rupees(r.value)}</strong>.`)
      + ' Our store team will send it to you shortly.'),
    st, early: false,
  });
}

async function sendTerminated(plan, d, st, { stopped = false } = {}) {
  await toCustomer(plan, {
    subject: 'Your savings plan has closed', heading: 'Your savings plan has closed',
    body: who(plan, stopped
      ? `your savings plan has been closed as you asked. The <strong>${rupees(st.paid)}</strong> you saved comes back to you as a Savings Scheme Voucher, without the bonus.`
      : `instalment ${st.next ? st.next.k : ''} was not paid within ${R.GRACE_DAYS} days of its due date, so your savings plan has closed. The <strong>${rupees(st.paid)}</strong> you saved comes back to you as a Savings Scheme Voucher, without the bonus.`)
      + ' Our store team will send it to you shortly.',
    st, early: false,
  });
}

async function sendVoucherIssued(plan, d, voucher) {
  await toCustomer(plan, {
    subject: `Your Savings Scheme Voucher: ${rupees(voucher.value)}`, heading: 'Your Savings Scheme Voucher',
    body: who(plan, `your Savings Scheme Voucher <strong>${voucher.code}</strong> is worth <strong>${rupees(voucher.value)}</strong>`
      + (voucher.bonus > 0 ? ` (${rupees(voucher.paid)} saved plus a bonus of ${rupees(voucher.bonus)})` : '')
      + `. Use it on any Timanti jewellery, online or at the store, until <strong>${T.planDate(voucher.validUntil)}</strong>. Coins, silver and loose solitaires are not included.`),
    early: false,
  });
}

// After a part use: what is left on the voucher.
async function sendVoucherBalance(plan, { code, used, left, orderName, expiresAt }) {
  await toCustomer(plan, {
    subject: `${rupees(left)} left on your Savings Scheme Voucher`, heading: `${rupees(left)} left on your voucher`,
    body: who(plan, `you used <strong>${rupees(used)}</strong> of your Savings Scheme Voucher <strong>${code}</strong>${orderName ? ` on order ${orderName}` : ''}. `
      + `<strong>${rupees(left)}</strong> is left on it. Use it on any Timanti jewellery, online or at the store`
      + `${expiresAt ? `, until <strong>${T.planDate(String(expiresAt).slice(0, 10))}</strong>` : ''}.`),
    early: false,
  });
}

// Internal: one item that needs the store. facts: [{ label, value }].
async function toStore(plan, d, { subject, heading, body, facts = [] }) {
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Savings plan ${plan.draft_name}: ${subject}`,
    html: T.buildSavingsPlanStaffHtml({
      heading: `${plan.draft_name}: ${heading}`, body, adminUrl: adminDraftUrl(plan.draft_order_id),
      facts: [{ label: 'Customer', value: `${plan.customer_name || '—'} ${plan.customer_phone || ''}` }, ...facts],
    }),
  });
}

// The message staff send by hand on WhatsApp to the customer (the digest's link).
function whatsappToCustomer(plan, text) {
  const phone = phoneOf(plan.customer_phone);
  return phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(text.replace(/\s+/g, ' ').trim())}` : null;
}

async function sendDigest(rows, { today } = {}) {
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Savings plan follow-ups: ${rows.length}`,
    html: T.buildSavingsPlanDigestHtml({ dateLabel: T.planDate(today || todayIst()), rows }),
  });
}

module.exports = {
  termsFor, whatsappToStore, whatsappToCustomer,
  sendStarted, sendDue, sendGraceWarning, sendReceived, sendEarlyOpen, sendFullyPaid, sendTerminated, sendVoucherIssued, sendVoucherBalance,
  toStore, sendDigest,
};
