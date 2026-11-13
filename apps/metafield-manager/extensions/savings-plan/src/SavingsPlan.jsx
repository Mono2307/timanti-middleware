import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Savings plan — 6 or 10 fixed monthly instalments, paid out as a Savings Scheme Voucher (HQ, Nov 2026).
//
// Before a plan exists: the draft must hold only the custom item "Savings Plan", priced at instalment ×
// months (₹2,000 × 10 = ₹20,000), and the customer. Staff pick 6 or 10 months, see the schedule and the
// voucher at the end, add a nominee, and start the plan on a deliberate click.
//
// Once started: where the plan stands (paid, late payments, what is due, the date it closes if unpaid),
// a payment link for what is due, and — when the plan can end — the voucher buttons:
//   Issue the voucher            every instalment paid (the full bonus)
//   Redeem early                 10-month plan, month 6 with 5 paid (25%) or month 8 with 7 paid (50%),
//                                when the customer asks (the WhatsApp link in their emails)
//   Customer stops the plan      the money paid, no bonus
//   Issue the voucher (no bonus) a plan the system closed 30 days after an unpaid due date
// Payments taken in store are typed into the Jewellery Workspace panel's Installments section.
//
// All maths lives in the middleware (src/modules/payments/savings-plan/rules.js); this only displays.

const MIDDLEWARE_BASE_URL = "https://timanti-middleware.fly.dev";

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const val = (e) => e?.currentTarget?.value ?? e?.target?.value ?? "";
const checked = (e) => Boolean(e?.currentTarget?.checked ?? e?.target?.checked);

const STATUS = {
  paid: { tone: "success", label: "Paid" },
  due: { tone: "info", label: "Due today" },
  overdue: { tone: "critical", label: "Overdue" },
  upcoming: { tone: "neutral", label: "Upcoming" },
};
const PLAN_STATUS = {
  active: "In progress", completed: "Completed: voucher issued", terminated: "Closed",
  redeemed: "Voucher used up", cancelled: "Cancelled",
};
const END_NOTE = {
  full: "The full bonus. The voucher is the money paid plus the bonus.",
  early: "The early-redemption bonus for the step the plan has reached. Only when the customer has asked to redeem now.",
  stopped: "The customer is giving up the plan. The voucher is the money paid, with no bonus. This cannot be undone.",
  terminated: "The plan closed for non-payment. The voucher is the money paid, with no bonus.",
};

async function middleware(path, init = {}) {
  const idToken = await shopify.auth.idToken();
  if (!idToken) throw new Error("this admin session could not be verified");
  const res = await fetch(`${MIDDLEWARE_BASE_URL}${path}`, {
    ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${idToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error((body.missing?.length ? `${body.error}: ${body.missing.join("; ")}` : body.error) || `HTTP ${res.status}`);
  }
  return body;
}
const post = (path, payload) => middleware(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

function Schedule({ rows }) {
  const n = rows.length;
  return (
    <s-stack direction="block" gap="small-200">
      {rows.map((r) => (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text type="strong">{r.k} of {n}</s-text>
          <s-text>{fmtDate(r.due)}</s-text>
          <s-text>{inr(r.amount)}{r.status === "paid" && r.paidOn ? ` paid ${fmtDate(r.paidOn)}` : ""}</s-text>
          {STATUS[r.status] ? <s-badge tone={r.status === "paid" && r.late ? "warning" : STATUS[r.status].tone}>
            {r.status === "paid" && r.late ? "Paid late" : STATUS[r.status].label}</s-badge> : null}
        </s-stack>
      ))}
    </s-stack>
  );
}

function SavingsPlan() {
  const draftId = String(shopify.data?.selected?.[0]?.id || "").replace(/\D/g, "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [months, setMonths] = useState(10);
  const [nominee, setNominee] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [how, setHow] = useState(null);
  const [checkedPayments, setCheckedPayments] = useState(false);
  const [cancelAgreed, setCancelAgreed] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try { setData(await middleware(`/api/savings-plan/draft/${draftId}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function run(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const start = () => run(async () => {
    const body = await post("/api/savings-plan/start", { draftId, months, nominee });
    setData(body);
    setAgreed(false);
    setNotice(body.firstLink
      ? "Savings plan started. The customer has been emailed the terms and a link for the first instalment (by SMS too). If they pay at the counter instead, type it into Installments 1 in the Jewellery Workspace panel."
      : "Savings plan started. The customer has been emailed the terms.");
  });

  const sendLink = () => run(async () => {
    const body = await post("/api/savings-plan/send-link", { draftId });
    setNotice(`A payment link for ${inr(body.amount)} is on its way to ${body.phone} by SMS and email.`);
  });

  const issue = () => run(async () => {
    const body = await post("/api/savings-plan/issue-voucher", { draftId, how, confirm: true });
    setHow(null);
    setCheckedPayments(false);
    setNotice(`Savings Scheme Voucher ${body.voucher.code} for ${inr(body.voucher.value)}${body.voucher.bonus > 0 ? ` (${inr(body.voucher.paid)} saved + ${inr(body.voucher.bonus)} bonus)` : ""} issued and emailed to the customer, valid until ${fmtDate(body.voucher.validUntil)}. Keep this draft: do not delete it or complete it.`);
    await load();
  });

  const cancel = () => run(async () => {
    await post("/api/savings-plan/cancel", { draftId, confirm: true });
    setCancelAgreed(false);
    setNotice("Plan cancelled. Nothing was paid, no voucher was made, and the customer was not emailed. Delete this draft.");
    await load();
  });

  const plan = data?.plan;
  const option = !plan ? data?.options?.[months] : null;
  const heading = `Savings plan${data?.draft ? ` — ${data.draft}` : ""}`;
  const actions = data?.actions || [];
  const chosen = actions.find((a) => a.how === how);
  const preview = option ? option.dates.map((due, i) => ({ k: i + 1, due, amount: option.instalment || 0, status: "upcoming" })) : [];

  return (
    <s-admin-action heading={heading} loading={loading}>
      <s-stack direction="block" gap="base">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {notice ? <s-banner tone="success">{notice}</s-banner> : null}

        {data && !plan && option ? (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text>Months:</s-text>
              {[6, 10].map((m) => (
                <s-button variant={months === m ? "primary" : "secondary"} onClick={() => { setMonths(m); setAgreed(false); }}>{String(m)}</s-button>
              ))}
            </s-stack>
            {option.problems?.length ? (
              <s-banner tone="warning" heading="Fix these before starting">{option.problems.join(" · ")}</s-banner>
            ) : (
              <s-stack direction="block" gap="base">
                <s-text>
                  {inr(option.instalment)} a month for {months} months, first instalment today. Paid in full (and no more than 2 payments late),
                  the customer gets a Savings Scheme Voucher for <s-text type="strong">{inr(option.voucherAtEnd)}</s-text>: {inr(option.instalment * months)} saved
                  plus a bonus of {inr(option.bonus)}.
                </s-text>
                <Schedule rows={preview} />
                <s-text color="subdued">
                  {months === 10 ? "Early redemption: from month 6 with 5 paid (a quarter of an instalment as bonus), or month 8 with 7 paid (half). " : ""}
                  A missed instalment can be paid up to 30 days after its due date; after that the plan closes and the money paid comes back
                  as a voucher, without the bonus. No cash refunds. The voucher is valid for 1 year, on any jewellery except coins, silver
                  and loose solitaires.
                </s-text>
                <s-text-field label="Nominee (optional)" value={nominee} onInput={(e) => setNominee(val(e))} />
                <s-checkbox label={`The customer has agreed: ${inr(option.instalment)} a month for ${months} months, and the terms above`}
                  checked={agreed} onChange={(e) => setAgreed(checked(e))} />
              </s-stack>
            )}
          </s-stack>
        ) : null}

        {plan ? (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={plan.status === "active" ? "info" : plan.status === "terminated" ? "critical" : "success"}>{PLAN_STATUS[plan.status] || plan.status}</s-badge>
              <s-text>{inr(plan.instalment)} × {plan.months} months · started {fmtDate(plan.startDate)} · matures {fmtDate(plan.maturity)}</s-text>
            </s-stack>
            <s-text>
              Saved {inr(plan.paid)} ({plan.paidCount} of {plan.months} instalments) · late payments {plan.lateCount} of {plan.lateLimit} allowed
              {plan.bonusOk ? "" : " — the bonus is lost"}{plan.nominee ? ` · nominee ${plan.nominee}` : ""}
            </s-text>

            {plan.voucherCode ? (
              <s-banner tone="success" heading={`Savings Scheme Voucher ${plan.voucherCode}: ${inr(plan.voucherValue)}`}>
                Issued{plan.endKind ? ` (${plan.endKind})` : ""}. The customer can use it in parts, online or in store: apply it to their
                purchase draft like any voucher. Keep this draft until the voucher is used up.
              </s-banner>
            ) : null}
            {plan.status === "active" && plan.overdueDays > 0 ? (
              <s-banner tone="critical" heading={`Instalment ${plan.next.k} is ${plan.overdueDays} days late`}>
                The plan closes on {fmtDate(plan.closeOn)} if it stays unpaid. Send a link, or take it in store and type it into the panel.
              </s-banner>
            ) : null}
            {plan.oddPayments?.length ? (
              <s-banner tone="warning" heading="Check these payments">
                {plan.oddPayments.map((p) => `Payment ${p.slot}: ${inr(p.value)} is not a whole number of ${inr(plan.instalment)} instalments`).join(" · ")}
              </s-banner>
            ) : null}
            {plan.status === "active" && plan.next && !plan.overdueDays ? (
              <s-text color="subdued">Next: instalment {plan.next.k}, {inr(plan.linkAmount)}, due {fmtDate(plan.next.due)}.</s-text>
            ) : null}
            {plan.redeemNow?.kind === "early" && plan.status === "active" ? (
              <s-text>Redeeming early today pays {inr(plan.redeemNow.value)}{plan.redeemNow.bonus > 0 ? ` (bonus ${inr(plan.redeemNow.bonus)})` : " (no bonus: too many late payments)"}.</s-text>
            ) : null}
            <Schedule rows={data.rows || []} />

            {actions.length ? (
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">End the plan and issue the voucher</s-text>
                <s-stack direction="inline" gap="small-200">
                  {actions.map((a) => (
                    <s-button variant={how === a.how ? "primary" : "secondary"} tone={a.how === "stopped" ? "critical" : undefined}
                      onClick={() => { setHow(a.how); setCheckedPayments(false); }}>{`${a.label}: ${inr(a.value)}`}</s-button>
                  ))}
                </s-stack>
                {chosen ? (
                  <s-stack direction="block" gap="small-200">
                    <s-text>{END_NOTE[chosen.how]} {inr(chosen.paid)} paid{chosen.bonus > 0 ? ` + ${inr(chosen.bonus)} bonus (${chosen.pct}% of one instalment)` : ""} = {inr(chosen.value)}.</s-text>
                    <s-checkbox label="I have checked every payment on this draft really reached Timanti (GoKwik, the bank statement or the cash drawer)"
                      checked={checkedPayments} onChange={(e) => setCheckedPayments(checked(e))} />
                    <s-button variant="primary" tone={chosen.how === "stopped" ? "critical" : undefined} onClick={issue} loading={busy}
                      disabled={Boolean(busy || !checkedPayments)}>{`Issue voucher for ${inr(chosen.value)}`}</s-button>
                  </s-stack>
                ) : null}
              </s-stack>
            ) : null}

            {plan.status === "active" && plan.paid === 0 ? (
              <s-stack direction="block" gap="small-200">
                <s-checkbox label="Started by mistake or as a demo: cancel it (only while nothing is paid)" checked={cancelAgreed}
                  onChange={(e) => setCancelAgreed(checked(e))} />
                {cancelAgreed ? <s-button tone="critical" onClick={cancel} loading={busy} disabled={busy}>Cancel plan</s-button> : null}
              </s-stack>
            ) : null}
          </s-stack>
        ) : null}
      </s-stack>

      {data && !plan ? (
        <s-button slot="primary-action" variant="primary" onClick={start} loading={busy}
          disabled={Boolean(busy || option?.problems?.length || !agreed)}>Start savings plan</s-button>
      ) : null}
      {plan?.status === "active" && !plan.fullyPaid ? (
        <s-button slot="primary-action" variant="primary" onClick={sendLink} loading={busy} disabled={busy}>{`Send payment link (${inr(plan.linkAmount)})`}</s-button>
      ) : null}
      <s-button slot="secondary-actions" onClick={() => shopify.close?.()}>Close</s-button>
    </s-admin-action>
  );
}

export default async () => {
  render(<SavingsPlan />, document.body);
};
