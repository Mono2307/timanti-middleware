import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Buy plan — the fixed 6-installment plan on a draft order.
//
// Before a plan exists: shows what it would be (the net to collect, total/6 a month, the six dates)
// and anything that blocks it, and starts it on a deliberate click. Starting is the ONLY way a draft
// becomes a buy plan — the middleware locks the price (rate-locked tag) and stamps the dates.
//
// Once started: shows the schedule, what is paid, the balance, and sends the customer a GoKwik link
// for any amount from the amount due now (the minimum — no underpaying) up to the balance.
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

function Schedule({ rows }) {
  return (
    <s-stack direction="block" gap="small-200">
      {rows.map((r) => (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text type="strong">{r.k}.</s-text>
          <s-text>{fmtDate(r.due)}</s-text>
          <s-text>{r.status === "paid" ? (r.paidOn ? `paid ${fmtDate(r.paidOn)}` : "paid") : inr(r.amount)}</s-text>
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

  async function start() {
    setBusy(true);
    setError("");
    try {
      const body = await middleware("/api/buy-plan/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId }),
      });
      setData(body);
      setAmount(String(body.plan?.minPayment || ""));
      setNotice("Buy plan started. The price on this draft is now locked, and the customer has been emailed their schedule. Take installment 1 at the counter as usual, or send a link below.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendLink() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await middleware("/api/buy-plan/send-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, amount: Number(amount) }),
      });
      setNotice(`A payment link for ${inr(body.amount)} is on its way to ${body.phone} by SMS and email.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const heading = `Buy plan${data?.draft ? ` — ${data.draft}` : ""}`;
  const plan = data?.plan;
  const amt = Number(amount);
  const amountProblem = plan && plan.next
    ? (!(amt > 0) ? "Enter an amount"
      : amt < plan.minPayment ? `At least ${inr(plan.minPayment)} — the amount due now`
      : amt > plan.balance ? `At most ${inr(plan.balance)} — the balance` : "")
    : "";

  return (
    <s-admin-action heading={heading} loading={loading}>
      <s-stack direction="block" gap="base">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {notice ? <s-banner tone="success">{notice}</s-banner> : null}

        {data && !plan ? (
          <s-stack direction="block" gap="base">
            <s-text>
              {inr(data.preview.total)} to collect, in 6 monthly payments of about {inr(data.preview.monthly)}.
              The price is locked at today's gold rate and cannot change for the life of the plan.
            </s-text>
            <Schedule rows={data.rows} />
            <s-text color="subdued">
              The first payment is due today. Paying more than the amount due lowers the payments after it; paying less is not allowed.
            </s-text>
            {data.blockers?.length ? (
              <s-banner tone="warning" heading="Fix these before starting">
                {data.blockers.join(" · ")}
              </s-banner>
            ) : (
              <s-checkbox
                label="The customer has agreed to the plan: price locked today, 6 monthly payments, never less than the amount due"
                checked={agreed}
                onChange={(e) => setAgreed(Boolean(e?.currentTarget?.checked ?? e?.target?.checked))}
              />
            )}
          </s-stack>
        ) : null}

        {plan ? (
          <s-stack direction="block" gap="base">
            <s-text>
              {inr(plan.total)} · paid {inr(plan.paid)} · balance {inr(plan.balance)}
              {plan.lockedGoldRate ? ` · gold rate locked at ${plan.lockedGoldRate}` : ""}
            </s-text>
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
            ) : (
              <s-banner tone="success">Fully paid. The draft converts to an order.</s-banner>
            )}
          </s-stack>
        ) : null}
      </s-stack>

      {data && !plan ? (
        <s-button slot="primary-action" variant="primary" onClick={start} loading={busy}
          disabled={Boolean(busy || data.blockers?.length || !agreed)}>Start buy plan</s-button>
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
