'use strict';

// Savings plan — the draft. Staff make it in Shopify like a CAD advance: a new draft, the customer,
// and one custom item titled "Savings Plan" priced at instalment × months (₹2,000 × 10 = ₹20,000).
// Starting the plan (routes.js) checks the draft, makes the line non-taxable, and writes the plan's
// tags and metafields. Reading reuses the buy plan's readDraft: the money is the draft's installment
// slots wherever they were recorded (a GoKwik link, or typed into the panel).

const { putJson } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { readDraft, todayIst, writeDraftLines, splitTags, adminDraftUrl } = require('../buy-plan/draft');
const R = require('./rules');

const savingsLines = (d) => (d?.draft?.line_items || []).filter(R.isSavingsLine);
const lineTotal = (li) => Math.round((parseFloat(li.price) || 0) * (Number(li.quantity) || 1));

// Why this draft cannot start a savings plan of `months` months ([] when it can), and the instalment
// it implies.
function startCheck(d, months) {
  const problems = [];
  const lines = d.draft.line_items || [];
  const sv = savingsLines(d);
  if (d.draft.status !== 'open') problems.push(`${d.draft.name} is already ${d.draft.status}`);
  if (!d.customer.id) problems.push('Add the customer to the draft');
  if (!d.customer.phone) problems.push('The customer needs a phone number (payment links go by SMS)');
  if (!d.customer.email) problems.push('The customer needs an email address (reminders go by email)');
  if (sv.length !== 1) problems.push(`Add one custom item titled "${R.SAVINGS_LINE_TITLE}", priced at instalment × months`);
  if (lines.length !== sv.length) problems.push(`The draft may hold only the "${R.SAVINGS_LINE_TITLE}" line: remove the other items`);
  const mf = d.mf || {};
  for (const [k, what] of [['voucher_value', 'a voucher'], ['exchange_note_value', 'an exchange note'], ['old_gold_value', 'old gold']]) {
    if (Math.abs(parseFloat(mf[k]) || 0) > 0) problems.push(`Remove ${what} from the draft: a savings plan is paid in money only`);
  }
  let instalment = null;
  if (sv.length === 1) {
    instalment = R.instalmentFromLine(lineTotal(sv[0]), months);
    if (instalment === null) problems.push(`The line price (Rs${lineTotal(sv[0]).toLocaleString('en-IN')}) does not divide into ${months} equal instalments`);
    else problems.push(...R.enrolmentProblems({ months, instalment }));
  }
  return { problems, instalment, total: sv.length === 1 ? lineTotal(sv[0]) : 0 };
}

// The plan's status on the draft: one status tag, the plan tag always. Other tags are kept.
function tagsFor(d, status, extra = []) {
  const keep = d.tags.filter(t => !R.isSavingsStatusTag(t) && !/^ssv(-value|-bonus)?:/i.test(t));
  return [...new Set([...keep, R.PLAN_TAG, R.statusTag(status), ...extra])];
}

async function writeTags(d, tags) {
  await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags: tags.join(', ') } });
  d.tags = tags;
}

// The Savings Plan line must not carry GST: money saved is not a sale (the voucher pays against the
// GST-inclusive price of the purchase later). Shopify ticks "Charge tax" on a new custom item by default.
async function makeLineNonTaxable(d) {
  const sv = savingsLines(d)[0];
  if (!sv || sv.taxable === false) return false;
  await writeDraftLines(d.id, (d.draft.line_items || []).map(li => (li === sv ? { ...li, taxable: false } : li)));
  return true;
}

// The plan's terms on the draft (text metafields, readable in the panel and by Order Printer).
function termsMetafields(plan) {
  return {
    savings_months: String(plan.months),
    savings_instalment: String(Math.round(plan.instalment)),
    savings_start: plan.start_date,
    savings_due_dates: (plan.due_dates || []).join(','),
    savings_maturity: R.maturityDate(plan.start_date, plan.months),
    savings_nominee: plan.nominee || '',
    savings_status: plan.status,
  };
}

// The outcome, written when the voucher is issued (design §5b): the bonus never goes in a payment slot.
function outcomeMetafields(plan) {
  return {
    savings_status: plan.status,
    savings_end: plan.end_kind || '',
    savings_paid: String(Math.round(plan.paid_at_end || 0)),
    savings_bonus: String(Math.round(plan.bonus || 0)),
    savings_bonus_pct: String(plan.bonus_pct ?? 0),
    savings_late_count: String(plan.late_count ?? 0),
    savings_voucher_code: plan.voucher_code || '',
    savings_voucher_value: plan.voucher_value != null ? String(Math.round(plan.voucher_value)) : '',
  };
}

const writeMetafields = (d, fields) => updateDraftOrderMetafields(d.id, fields);

module.exports = {
  readDraft, todayIst, splitTags, adminDraftUrl,
  savingsLines, lineTotal, startCheck, tagsFor, writeTags, makeLineNonTaxable, termsMetafields, outcomeMetafields, writeMetafields,
};
