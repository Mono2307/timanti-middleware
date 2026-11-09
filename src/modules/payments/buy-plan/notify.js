'use strict';

// Buy plan — every message the plan sends. Customer mail goes to the customer (store + HQ get the
// usual Bcc from the email chokepoint); staff mail is internal to the store. Payment links also go
// by SMS, like every other payment link. WhatsApp is manual: the staff digest carries a wa.me link
// with the message already written.
//
// Every sender takes `today` (YYYY-MM-DD) so the sweep can run "as of" another day; the schedule in
// the email is the plan as it stands on that day.

const { sendEmail } = require('../../../integrations/email');
const { sendSMS } = require('../../../integrations/sms');
const T = require('../../../integrations/email/templates');
const { config } = require('../../../core/config');
const S = require('./schedule');
const { customPayUrl } = require('./links');
const { todayIst, adminDraftUrl } = require('./draft');

const STORE = () => config.email.store || 'hsrstore@timanti.in';
const rupees = (n) => `Rs${Number(n || 0).toLocaleString('en-IN')}`;
const phoneOf = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const stateOf = (plan, d, today) => S.planState(plan, d.legs, today || todayIst());
const finalDate = (plan) => S.datesOf(plan)[S.countOf(plan) - 1];
const base = (plan, st) => ({
  customerName: plan.customer_name, draftName: plan.draft_name, rows: st.rows, paid: st.paid, balance: st.balance,
});

async function sendStarted(plan, d, { today } = {}) {
  const st = stateOf(plan, d, today);
  await sendEmail({
    to: plan.customer_email,
    subject: `Your Timanti buy plan has started (${plan.draft_name})`,
    html: T.buildBuyPlanStartedHtml({
      ...base(plan, st), total: Number(plan.total), customPayUrl: customPayUrl(plan.id),
      mode: plan.mode, goldValue: Number(plan.gold_value) || 0, finalDate: finalDate(plan),
    }),
  });
}

// Before a gold plan starts: the link for the gold value (installment 1). Paying it is what lets
// staff start the plan and lock the rate.
async function sendGoldLink(d, link, goldValue) {
  const phone = phoneOf(d.customer.phone);
  if (phone) await sendSMS(phone, `Timanti buy plan ${d.draft.name}: pay the gold value, ${rupees(link.amount)}, to lock today's gold rate. Pay: ${link.shortUrl}`);
  await sendEmail({
    to: d.customer.email,
    subject: `Lock today's gold rate: ${rupees(link.amount)} (${d.draft.name})`,
    html: T.buildBuyPlanGoldLinkHtml({
      customerName: d.customer.name, draftName: d.draft.name, total: d.total, goldValue,
      amount: link.amount, payUrl: link.shortUrl,
    }),
  });
}

// Floating plan, 3 days before the last installment: the final price, and a link for what is left.
async function sendFinalPrice(plan, d, link, { today } = {}) {
  const st = stateOf(plan, d, today);
  const n = st.n;
  const phone = phoneOf(plan.customer_phone);
  if (link && phone) {
    await sendSMS(phone, `Timanti buy plan ${plan.draft_name}: final price ${rupees(plan.final_total)} at today's gold rate. Last installment (${n} of ${n}): ${rupees(link.amount)}, due ${T.planDate(finalDate(plan))}. Pay: ${link.shortUrl}`);
  }
  await sendEmail({
    to: plan.customer_email,
    subject: `Your buy plan's final price: ${rupees(plan.final_total)} (${plan.draft_name})`,
    html: T.buildBuyPlanFinalPriceHtml({
      ...base(plan, st), startTotal: Number(plan.total), finalTotal: Number(plan.final_total), k: n,
      dueDate: finalDate(plan), amount: link ? link.amount : 0, payUrl: link ? link.shortUrl : null,
      customPayUrl: st.balance > 0 ? customPayUrl(plan.id) : null, credit: st.credit,
    }),
  });
}

// Internal: the customer has paid more than the price — gold fell before the final price, or a
// cheaper piece after Change product (why: 'change'). Nothing is issued: the store offers a piece of
// higher value, or issues a voucher for the difference on the Buy plan screen.
async function sendFinalCredit(plan, d, credit, { why = 'final', oldTotal, newTotal } = {}) {
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Buy plan ${plan.draft_name}: customer has paid ${rupees(credit)} more than the ${why === 'change' ? 'new piece' : 'final price'}`,
    html: T.buildBuyPlanFinalCreditHtml({
      draftName: plan.draft_name, adminUrl: adminDraftUrl(d.id), customerName: plan.customer_name,
      phone: plan.customer_phone, credit, why,
      startTotal: why === 'change' ? oldTotal : Number(plan.total), finalTotal: why === 'change' ? newTotal : Number(plan.final_total),
    }),
  });
}

// A payment link for installment k: by SMS (as every payment link is) and by email with the plan.
// relink: the link sent earlier is about to lapse (GoKwik links last 30 days); this is its replacement.
async function sendLink(plan, d, link, { k, dueDate, overdue = false, today, relink = false } = {}) {
  const st = stateOf(plan, d, today);
  const n = st.n;
  const phone = phoneOf(plan.customer_phone);
  if (phone) {
    await sendSMS(phone, `Timanti buy plan ${plan.draft_name}: installment ${k} of ${n}, ${rupees(link.amount)}${overdue ? ' (overdue)' : ''}. ${relink ? 'New payment link (the earlier one is expiring)' : 'Pay'}: ${link.shortUrl}`);
  }
  await sendEmail({
    to: plan.customer_email,
    subject: relink
      ? `A new payment link for installment ${k} on your buy plan (${plan.draft_name})`
      : overdue
      ? `Installment ${k} on your buy plan is overdue (${plan.draft_name})`
      : `Installment ${k} of ${n} on your buy plan: ${rupees(link.amount)} (${plan.draft_name})`,
    html: T.buildBuyPlanDueHtml({
      ...base(plan, st), k, dueDate, amount: link.amount, payUrl: link.shortUrl,
      customPayUrl: customPayUrl(plan.id), overdue, mode: plan.mode,
    }),
  });
}

async function sendReceived(plan, d, amount, { today } = {}) {
  const st = stateOf(plan, d, today);
  const next = st.dueNow > 0 ? { k: st.k, due: st.dates[st.k - 1], amount: st.dueNow } : st.upcoming;
  await sendEmail({
    to: plan.customer_email,
    subject: `Payment received on your buy plan (${plan.draft_name})`,
    html: T.buildBuyPlanReceivedHtml({
      ...base(plan, st), amount,
      nextK: next ? next.k : null, nextDue: next ? next.due : null, nextAmount: next ? next.amount : 0,
      customPayUrl: st.balance > 0 ? customPayUrl(plan.id) : null,
      mode: plan.mode, finalDate: finalDate(plan), awaitingFinal: S.awaitingFinalPrice(plan),
    }),
  });
}

async function sendCompleted(plan) {
  await sendEmail({
    to: plan.customer_email,
    subject: `Your buy plan is complete (${plan.draft_name})`,
    html: T.buildBuyPlanCompletedHtml({ customerName: plan.customer_name, draftName: plan.draft_name, total: S.currentTotal(plan) }),
  });
}

// The plan closes on closeOn unless something is paid.
async function sendClosingSoon(plan, d, link, { closeOn, lastInstallment, today } = {}) {
  const st = stateOf(plan, d, today);
  const phone = phoneOf(plan.customer_phone);
  if (phone && link) {
    await sendSMS(phone, `Timanti buy plan ${plan.draft_name}: no payment received. Your plan closes on ${T.planDate(closeOn)} unless you pay; any amount from Rs1,000 keeps it going. Pay: ${link.shortUrl}`);
  }
  await sendEmail({
    to: plan.customer_email,
    subject: `Your buy plan closes on ${T.planDate(closeOn)} (${plan.draft_name})`,
    html: T.buildBuyPlanClosingSoonHtml({
      ...base(plan, st), closeOn, amount: link ? link.amount : 0, payUrl: link ? link.shortUrl : null,
      customPayUrl: customPayUrl(plan.id), mode: plan.mode, lastInstallment,
    }),
  });
}

// Internal: the plan closed for non-payment. owed is what the voucher will be; staff issue it.
async function sendForfeited(plan, d, { owed, reason }) {
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Buy plan ${plan.draft_name} closed (${reason})${owed > 0 ? `: issue the voucher for ${rupees(owed)}` : ''}`,
    html: T.buildBuyPlanForfeitedStaffHtml({
      draftName: plan.draft_name, adminUrl: d ? adminDraftUrl(d.id) : '', customerName: plan.customer_name,
      phone: plan.customer_phone, owed, total: S.currentTotal(plan), reason,
    }),
  });
}

// Customer: staff issued a voucher (credit.js). kind 'closed': the plan closed for non-payment and this
// is everything paid; 'credit': what was paid beyond the price.
async function sendVoucherIssued(plan, d, { kind, voucher }) {
  await sendEmail({
    to: plan.customer_email,
    subject: kind === 'closed'
      ? `Your buy plan has closed: voucher ${voucher.code} for ${rupees(voucher.value)} (${plan.draft_name})`
      : `Your voucher ${voucher.code} for ${rupees(voucher.value)} (${plan.draft_name})`,
    html: kind === 'closed'
      ? T.buildBuyPlanForfeitedHtml({
          customerName: plan.customer_name, draftName: plan.draft_name, paid: voucher.value, voucherCode: voucher.code, validUntil: voucher.validUntil,
        })
      : T.buildBuyPlanCreditVoucherHtml({
          customerName: plan.customer_name, draftName: plan.draft_name, amount: voucher.value, voucherCode: voucher.code, validUntil: voucher.validUntil,
        }),
  });
}

// Staff cancelled the plan (cancel.js). The customer hears only when they opted out — not for a demo
// or a mistake, and not while their voucher still has to be made by hand.
async function sendCancelled(plan, d, { kind, paid, voucher, voucherError, reason, by }) {
  if (kind === 'opted_out' && !voucherError) {
    await sendEmail({
      to: plan.customer_email,
      subject: voucher
        ? `Your buy plan has been cancelled: voucher ${voucher.code} for ${rupees(paid)} (${plan.draft_name})`
        : `Your buy plan has been cancelled (${plan.draft_name})`,
      html: T.buildBuyPlanCancelledHtml({
        customerName: plan.customer_name, draftName: plan.draft_name, paid, voucherCode: voucher?.code, validUntil: voucher?.validUntil,
      }),
    });
  }
  const handVoucher = kind === 'opted_out' && paid > 0 && !voucher;
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Buy plan ${plan.draft_name} cancelled (${reason})${voucher ? `: voucher ${voucher.code}` : handVoucher ? ': CREATE THE VOUCHER BY HAND' : ''}`,
    html: T.buildBuyPlanCancelledStaffHtml({
      draftName: plan.draft_name, adminUrl: d ? adminDraftUrl(d.id) : '', customerName: plan.customer_name,
      phone: plan.customer_phone, paid, total: S.currentTotal(plan), kind, reason, by,
      voucherCode: voucher?.code, validUntil: voucher?.validUntil, voucherError,
    }),
  });
}

// The piece on the plan was changed.
async function sendChanged(plan, d, { oldTotal, newTotal, lostLock, credit, today }) {
  const st = stateOf(plan, d, today);
  await sendEmail({
    to: plan.customer_email,
    subject: `Your buy plan has been updated (${plan.draft_name})`,
    html: T.buildBuyPlanChangedHtml({
      ...base(plan, st), oldTotal, newTotal, lostLock, credit,
      customPayUrl: customPayUrl(plan.id),
    }),
  });
}

// Internal: the draft's pieces were edited without "Change product".
async function sendLinesChanged(plan, d) {
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Buy plan ${plan.draft_name}: pieces changed without "Change product"`,
    html: T.buildBuyPlanLinesChangedHtml({ draftName: plan.draft_name, adminUrl: adminDraftUrl(d.id), customerName: plan.customer_name }),
  });
}

// fixes: draft.js linesToRestore — the lines put back at the plan's price (error: the write failed).
async function sendPricePutBack(plan, d, fixes, error = null) {
  await sendEmail({
    to: STORE(), internal: true,
    subject: error
      ? `Buy plan ${plan.draft_name}: a piece is at the wrong price, fix it by hand`
      : `Buy plan ${plan.draft_name}: a re-added piece was put back at the plan price`,
    html: T.buildBuyPlanPricePutBackHtml({
      draftName: plan.draft_name, adminUrl: adminDraftUrl(d.id), customerName: plan.customer_name,
      lines: fixes.map(f => ({ title: f.title, from: f.from, to: f.to })), error,
    }),
  });
}

// The message staff send by hand on WhatsApp.
function whatsappUrl(row) {
  const phone = phoneOf(row.phone);
  if (!phone) return null;
  const due = T.planDate(row.due);
  const reserved = row.mode === 'equal' ? 'Your piece remains reserved for you.' : 'Your piece remains reserved at your locked price.';
  const text = row.closeOn
    ? `Hello ${row.customerName || ''}, this is Timanti. We have not received a payment on your buy plan (${row.draftName}) for a while. It closes on ${T.planDate(row.closeOn)} unless a payment is made; any amount from Rs1,000 keeps it going. The payment link is in your email.`
    : row.overdue
    ? `Hello ${row.customerName || ''}, a gentle reminder from Timanti: installment ${row.k} of your buy plan (${row.draftName}), ${rupees(row.amount)}, was due on ${due}. ${reserved} The payment link is in your email.`
    : `Hello ${row.customerName || ''}, this is Timanti. Installment ${row.k} of your buy plan (${row.draftName}), ${rupees(row.amount)}, is due on ${due}. The payment link is in your email.`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text.replace(/\s+/g, ' ').trim())}`;
}

async function sendStaffDigest(rows, { today } = {}) {
  const dateLabel = T.planDate(today || todayIst());
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Buy plan follow-ups: ${rows.filter(r => r.overdue).length} overdue, ${rows.filter(r => !r.overdue).length} due soon`,
    html: T.buildBuyPlanStaffDigestHtml({ dateLabel, rows: rows.map(r => ({ ...r, waUrl: r.stuck ? null : whatsappUrl(r) })) }),
  });
}

async function sendRestored({ plan, oldName, newName, newId, d }) {
  const st = S.planState(plan, d ? d.legs : [], todayIst());
  await sendEmail({
    to: STORE(), internal: true,
    subject: `Buy plan draft ${oldName} was deleted and restored as ${newName}`,
    html: T.buildBuyPlanRestoredHtml({
      oldName, newName, adminUrl: adminDraftUrl(newId), customerName: plan.customer_name,
      total: st.total, paid: st.paid, balance: st.balance,
    }),
  });
}

module.exports = {
  sendStarted, sendGoldLink, sendLink, sendReceived, sendCompleted, sendFinalPrice, sendFinalCredit,
  sendClosingSoon, sendForfeited, sendVoucherIssued, sendCancelled, sendChanged, sendLinesChanged, sendPricePutBack, sendStaffDigest, sendRestored, whatsappUrl,
};
