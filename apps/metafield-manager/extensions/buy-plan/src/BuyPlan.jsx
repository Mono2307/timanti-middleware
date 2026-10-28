import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Buy plan — the fixed 6-installment plan on a draft order. Two ways to run it (founder, 2026-10-24):
//
//   Gold value first   the customer pays the gold value of the pieces (incl. GST) before the plan
//                      starts; that locks the gold rate, and the rest is spread over installments 2..6.
//   Equal installments six equal payments at today's price; the gold rate is NOT locked. On the date
//                      of installment 6 the draft is repriced at that day's rate and the last
//                      installment is whatever the new price leaves.
//
// Before a plan exists: staff pick one, see the schedule, send the gold value link if needed, and
// start it on a deliberate click. Starting is the ONLY way a draft becomes a buy plan.
// Once started: the schedule, what is paid, the balance, and a GoKwik link for any amount from the
// amount due now (the minimum — no underpaying) up to the balance.
//
// All maths lives in the middleware (src/modules/payments/buy-plan/schedule.js); this only displays.

const MIDDLEWARE_BASE_URL = "https://timanti-middleware.fly.dev";

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const val = (e) => e?.currentTarget?.value ?? e?.target?.value ?? "";

const STATUS = {
  paid: { tone: "success", label: "Paid" },
  open: { tone: "info", label: "Due now" },
  overdue: { tone: "critical", label: "Overdue" },
  upcoming: { tone: "neutral", label: "Upcoming" },
};
const MODE_LABEL = { gold: "Gold value first", equal: "Equal installments" };

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
  return (
    <s-stack direction="block" gap="small-200">
      {rows.map((r) => (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text type="strong">{r.k}.</s-text>
          <s-text>{fmtDate(r.due)}</s-text>
          <s-text>{r.status === "paid" ? (r.paidOn ? `paid ${fmtDate(r.paidOn)}` : "paid") : `${inr(r.amount)}${r.estimate ? " (estimate)" : ""}`}</s-text>
          {STATUS[r.status] ? <s-badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</s-badge> : null}
        </s-stack>
      ))}
    </s-stack>
  );
}

function BuyPlan() {
  const draftId = String(shopify.data?.selected?.[0]?.id || "").replace(/\D/g, "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState("gold");
  const [agreed, setAgreed] = useState(false);
  const [amount, setAmount] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const body = await middleware(`/api/buy-plan/draft/${draftId}`);
      setData(body);
      if (body.plan) setAmount(String(body.plan.minPayment || ""));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function run(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const start = () => run(async () => {
    const body = await post("/api/buy-plan/start", { draftId, mode });
    setData(body);
    setAmount(String(body.plan?.minPayment || ""));
    setNotice(mode === "gold"
      ? "Buy plan started. The gold rate is locked and the customer has been emailed their schedule."
      : "Buy plan started. The price is held at today's rate until the last installment, which is repriced on its date. The customer has been emailed their schedule.");
  });

  const sendGoldLink = () => run(async () => {
    const body = await post("/api/buy-plan/gold-link", { draftId });
    setNotice(`A link for the gold value, ${inr(body.amount)}, is on its way to ${body.phone} by SMS and email. Once it is paid, reopen Buy plan and start the plan.`);
  });

  const sendLink = () => run(async () => {
    const body = await post("/api/buy-plan/send-link", { draftId, amount: Number(amount) });
    setNotice(`A payment link for ${inr(body.amount)} is on its way to ${body.phone} by SMS and email.`);
  });

  const heading = `Buy plan${data?.draft ? ` — ${data.draft}` : ""}`;
  const plan = data?.plan;
  const pv = data?.preview;
  const option = data?.options?.[mode];
  const goldUnpaid = Boolean(mode === "gold" && pv && pv.goldValue > 0 && pv.goldOutstanding > 0);
  const amt = Number(amount);
  const amountProblem = plan && plan.next
    ? (!(amt > 0) ? "Enter an amount"
      : amt < plan.minPayment ? `At least ${inr(plan.minPayment)} — the amount due now`
      : amt > plan.balance ? `At most ${inr(plan.balance)} — the balance` : "")
    : "";
  const pick = (m) => { setMode(m); setAgreed(false); setNotice(""); setError(""); };

  return (
    <s-admin-action heading={heading} loading={loading}>
      <s-stack direction="block" gap="base">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {notice ? <s-banner tone="success">{notice}</s-banner> : null}

        {data && !plan && option ? (
          <s-stack direction="block" gap="base">
            <s-text>{inr(pv.total)} to collect over 6 months. How will the customer pay?</s-text>
            <s-stack direction="inline" gap="small-200">
              <s-button variant={mode === "gold" ? "primary" : "secondary"} onClick={() => pick("gold")}>{MODE_LABEL.gold}</s-button>
              <s-button variant={mode === "equal" ? "primary" : "secondary"} onClick={() => pick("equal")}>{MODE_LABEL.equal}</s-button>
            </s-stack>

            {mode === "gold" ? (
              <s-text>
                First payment: the gold value, {inr(pv.goldValue)} (incl. GST){pv.paid ? `, ${inr(pv.paid)} paid so far` : ""}.
                Paying it locks today's gold rate. The rest, about {inr(pv.monthlyAfterGold)} a month, is spread over the next 5 months.
              </s-text>
            ) : (
              <s-text>
                6 payments of about {inr(pv.monthlyEqual)} at today's price. The gold rate is not locked: on {fmtDate(pv.finalDate)} the
                draft is repriced at that day's rate, and the last payment covers the difference (more if gold rises, less if it falls).
              </s-text>
            )}
            <Schedule rows={option.rows} />
            <s-text color="subdued">Paying more than the amount due lowers the payments after it; paying less is not allowed.</s-text>

            {goldUnpaid && !data.options.equal.blockers?.length ? (
              <s-banner tone="info" heading={`Collect the gold value first: ${inr(pv.goldOutstanding)}`}>
                Take it at the counter as usual, or send the customer a link with the button below. Then reopen Buy plan to start the plan.
              </s-banner>
            ) : option.blockers?.length ? (
              <s-banner tone="warning" heading="Fix these before starting">{option.blockers.join(" · ")}</s-banner>
            ) : (
              <s-checkbox
                label={mode === "gold"
                  ? "The customer has agreed: gold rate locked today, the rest over 5 monthly payments, never less than the amount due"
                  : "The customer has agreed: 6 monthly payments, last payment repriced at the gold rate on its date, never less than the amount due"}
                checked={agreed}
                onChange={(e) => setAgreed(Boolean(e?.currentTarget?.checked ?? e?.target?.checked))}
              />
            )}
          </s-stack>
        ) : null}

        {plan ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">{MODE_LABEL[plan.mode] || "Buy plan"}</s-text>
            <s-text>
              {inr(plan.finalTotal ?? plan.total)} · paid {inr(plan.paid)} · balance {inr(plan.balance)}
              {plan.mode === "gold" && plan.lockedGoldRate ? ` · gold rate locked at ${plan.lockedGoldRate}` : ""}
            </s-text>
            {plan.awaitingFinalPrice ? (
              <s-text color="subdued">
                Price held at today's rate until {fmtDate(plan.finalDate)}, when the draft is repriced at that day's gold rate and the
                last payment is worked out. Do not complete the draft before then.
              </s-text>
            ) : null}
            {plan.mode === "equal" && plan.finalTotal != null ? (
              <s-text color="subdued">Final price set on {fmtDate(plan.finalDate)}: {inr(plan.finalTotal)} (was {inr(plan.total)}).</s-text>
            ) : null}
            {plan.credit > 0 ? (
              <s-banner tone="warning">The customer has paid {inr(plan.credit)} more than the final price. Settle it with them before completing the draft.</s-banner>
            ) : null}
            <Schedule rows={data.rows} />
            {plan.next ? (
              <s-stack direction="block" gap="small-200">
                <s-divider />
                <s-number-field
                  label={`Send a payment link (installment ${plan.next}: at least ${inr(plan.minPayment)})`}
                  min={String(plan.minPayment)} max={String(plan.balance)} step="1"
                  value={amount} onInput={(e) => setAmount(val(e))}
                />
                {amountProblem ? <s-text color="subdued">{amountProblem}</s-text> : null}
                <s-text color="subdued">
                  The link goes to the customer by SMS and email, and replaces any earlier link that is still unpaid.
                  Reminders with a link also go automatically 3 days before each due date.
                </s-text>
                {plan.customPayUrl ? (
                  <s-text-field label="Customer's own link to pay a different amount (share on WhatsApp)" value={plan.customPayUrl} readOnly />
                ) : null}
              </s-stack>
            ) : (!plan.awaitingFinalPrice && !(plan.credit > 0)) ? (
              <s-banner tone="success">Fully paid. The draft can be completed.</s-banner>
            ) : null}
          </s-stack>
        ) : null}
      </s-stack>

      {data && !plan && goldUnpaid ? (
        <s-button slot="primary-action" variant="primary" onClick={sendGoldLink} loading={busy}
          disabled={Boolean(busy || data.options?.equal?.blockers?.length)}>Send gold value link</s-button>
      ) : null}
      {data && !plan && !goldUnpaid ? (
        <s-button slot="primary-action" variant="primary" onClick={start} loading={busy}
          disabled={Boolean(busy || option?.blockers?.length || !agreed)}>Start buy plan</s-button>
      ) : null}
      {plan?.next ? (
        <s-button slot="primary-action" variant="primary" onClick={sendLink} loading={busy}
          disabled={Boolean(busy || amountProblem)}>Send payment link</s-button>
      ) : null}
      <s-button slot="secondary-actions" onClick={() => shopify.close?.()}>Close</s-button>
    </s-admin-action>
  );
}

export default async () => {
  render(<BuyPlan />, document.body);
};
