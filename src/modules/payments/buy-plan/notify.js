'use strict';

// Buy plan — every message the plan sends. Customer mail goes to the customer (store + HQ get the
// usual Bcc from the email chokepoint); staff mail is internal to the store. Payment links also go
// by SMS, like every other payment link. WhatsApp is manual: the staff digest carries a wa.me link
// with the message already written.

const { sendEmail } = require('../../../integrations/email');
const { sendSMS } = require('../../../integrations/sms');
const T = require('../../../integrations/email/templates');
const { config } = require('../../../core/config');
const S = require('./schedule');
const { customPayUrl } = require('./links');
const { todayIst, adminDraftUrl } = require('./draft');

const rupees = (n) => `Rs${Number(n || 0).toLocaleString('en-IN')}`;
const planView = (plan, d) => {
  const state = S.replay(plan.total, d.legs);
  return { state, rows: S.scheduleRows(plan, d.legs, todayIst()) };
};

async function sendStarted(plan, d) {
  const { state, rows } = planView(plan, d);
  await sendEmail({
    to: plan.customer_email,
    subject: `Your Timanti buy plan has started (${plan.draft_name})`,
    html: T.buildBuyPlanStartedHtml({
      customerName: plan.customer_name, draftName: plan.draft_name, total: Number(plan.total),
      rows, paid: state.paid, balance: state.balance, customPayUrl: customPayUrl(plan.id),
    }),
  });
}

// A payment link: by SMS (as every payment link is) and by email with the plan around it.
async function sendLink(plan, d, link, { overdue = false } = {}) {
  const { state, rows } = planView(plan, d);
  const k = state.next;
  const due = (plan.due_dates || [])[k - 1];
  const phone = String(plan.customer_phone || '').replace(/\D/g, '').slice(-10);
  if (phone) {
    await sendSMS(phone, `Timanti buy plan ${plan.draft_name}: installment ${k} of 6, ${rupees(link.amount)}${overdue ? ' (overdue)' : ''}. Pay: ${link.shortUrl}`);
  }
  await sendEmail({
    to: plan.customer_email,
    subject: overdue
      ? `Installment ${k} on your buy plan is overdue (${plan.draft_name})`
      : `Installment ${k} of 6 on your buy plan: ${rupees(link.amount)} (${plan.draft_name})`,
    html: T.buildBuyPlanDueHtml({
      customerName: plan.customer_name, draftName: plan.draft_name, k, dueDate: due,
      amount: link.amount, payUrl: link.shortUrl, customPayUrl: customPayUrl(plan.id),
      rows, paid: state.paid, balance: state.balance, overdue,
    }),
  });
}

async function sendReceived(plan, d) {
  const { state, rows } = planView(plan, d);
  await sendEmail({
    to: plan.customer_email,
    subject: `Payment received on your buy plan (${plan.draft_name})`,
    html: T.buildBuyPlanReceivedHtml({
      customerName: plan.customer_name, draftName: plan.draft_name,
      nextK: state.next, nextDue: state.next ? (plan.due_dates || [])[state.next - 1] : null, nextAmount: state.owed,
      customPayUrl: state.next ? customPayUrl(plan.id) : null, rows, paid: state.paid, balance: state.balance,
    }),
  });
}

async function sendCompleted(plan) {
  await sendEmail({
    to: plan.customer_email,
    subject: `Your buy plan is complete (${plan.draft_name})`,
    html: T.buildBuyPlanCompletedHtml({ customerName: plan.customer_name, draftName: plan.draft_name, total: Number(plan.total) }),
  });
}

// The message staff send by hand on WhatsApp.
function whatsappUrl(row) {
  const phone = String(row.phone || '').replace(/\D/g, '').slice(-10);
  if (!phone) return null;
  const due = new Date(`${String(row.due).slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const text = row.overdue
    ? `Hello ${row.customerName || ''}, a gentle reminder from Timanti: installment ${row.k} of your buy plan (${row.draftName}), ${rupees(row.amount)}, was due on ${due}. Your piece remains reserved at your locked price. The payment link is in your email.`
    : `Hello ${row.customerName || ''}, this is Timanti. Installment ${row.k} of your buy plan (${row.draftName}), ${rupees(row.amount)}, is due on ${due}. The payment link is in your email.`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text.replace(/\s+/g, ' ').trim())}`;
}

async function sendStaffDigest(rows) {
  const dateLabel = new Date(`${todayIst()}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  await sendEmail({
    to: config.email.store || 'hsrstore@timanti.in',
    internal: true,
    subject: `Buy plan follow-ups: ${rows.filter(r => r.overdue).length} overdue, ${rows.filter(r => !r.overdue).length} due soon`,
    html: T.buildBuyPlanStaffDigestHtml({ dateLabel, rows: rows.map(r => ({ ...r, waUrl: whatsappUrl(r) })) }),
  });
}

async function sendRestored({ plan, oldName, newName, newId, d }) {
  const state = S.replay(plan.total, d ? d.legs : []);
  await sendEmail({
    to: config.email.store || 'hsrstore@timanti.in',
    internal: true,
    subject: `Buy plan draft ${oldName} was deleted and restored as ${newName}`,
    html: T.buildBuyPlanRestoredHtml({
      oldName, newName, adminUrl: adminDraftUrl(newId), customerName: plan.customer_name,
      total: Number(plan.total), paid: state.paid, balance: state.balance,
    }),
  });
}

module.exports = { sendStarted, sendLink, sendReceived, sendCompleted, sendStaffDigest, sendRestored, whatsappUrl };
