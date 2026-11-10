import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Buy plan — 4, 5 or 6 monthly installments on a draft order. Two ways to run it (founder):
//
//   Gold value first   the customer pays the gold value of the pieces (before GST) before the plan
//                      starts; that locks the gold rate, and the rest (GST included) is spread over
//                      the installments after it.
//   Equal installments equal payments at today's price; the gold rate is NOT locked. 3 days before
//                      the last installment the draft is repriced at that day's rate, and the last
//                      installment is whatever the new price leaves.
//
// Any payment from Rs1,000 counts; a missed installment is added to the next; after any payment the
// balance is re-spread over the installments left. 60 days with no payment (or unpaid 30 days after
// the last date) closes the plan and what was paid is owed back as a voucher.
//
// Vouchers are never automatic (founder, 2026-11-09): when a closed plan, a cheaper piece or an
// overpayment means money is owed back, this screen prompts staff, who press Issue voucher.
//
// Before a plan exists: staff pick the type and the number of installments, see the schedule, send
// the gold value link if needed, and start it on a deliberate click (the ONLY way a plan starts).
// Once started: the schedule, the payments, a GoKwik link for any amount, recording a payment taken
// in store, Change product after the pieces on the draft are changed, and Cancel plan: the customer
// opted out (what they paid becomes a voucher, once staff confirm the money really came in), or a
// demo / staff mistake (no voucher; the draft can be given a new plan).
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
const checked = (e) => Boolean(e?.currentTarget?.checked ?? e?.target?.checked);

const STATUS = {
  paid: { tone: "success", label: "Paid" },
  due: { tone: "info", label: "Due now" },
  overdue: { tone: "critical", label: "Overdue" },
  missed: { tone: "critical", label: "Missed, added to next" },
  upcoming: { tone: "neutral", label: "Upcoming" },
};
const MODE_LABEL = { gold: "Gold value first", equal: "Equal installments" };
const MODE_NAMES = { cash: "Cash", card: "Card", upi: "UPI", "bank transfer": "Bank transfer" };

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
          <s-text>
            {r.status === "missed" ? "—"
              : r.status === "paid" ? `${inr(r.amount)}${r.paidOn ? ` paid ${fmtDate(r.paidOn)}` : " paid"}`
              : `${inr(r.amount)}${r.estimate ? " (estimate)" : ""}`}
          </s-text>
          {STATUS[r.status] ? <s-badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</s-badge> : null}
        </s-stack>
      ))}
    </s-stack>
  );
}

function Payments({ list }) {
  if (!list?.length) return null;
  return (
    <s-stack direction="block" gap="small-100">
      <s-text type="strong">Payments</s-text>
      {list.map((p) => (
        <s-text color="subdued">{fmtDate(p.at)} · {inr(p.amount)} · {MODE_NAMES[p.mode] || p.mode || "—"}{p.source === "buy-plan" ? " (in store)" : ""}</s-text>
      ))}
    </s-stack>
  );
}

// Where a payment came from, so staff can check it before a voucher is made (credit.js paymentSlots).
function sourceLabel(s) {
  if (s.source === "gokwik") return `online payment link${s.ref ? ` (UTR ${s.ref})` : ""}`;
  if (s.source === "pine") return `card terminal${s.ref ? ` (ref ${s.ref})` : ""}`;
  if (s.source === "buy-plan") return "recorded in store on this screen";
  if (s.source) return `recorded as ${s.source}`;
  return "no payment record (typed into the Metafield Manager)";
}

// One tick per payment: the voucher is only the payments staff have checked really came in, plus
// old gold / exchange note handed in, less any voucher already issued on the plan.
function VerifyPayments({ plan, ticked, onToggle }) {
  const slots = plan.slots || [];
  const h = plan.handedIn || {};
  return (
    <s-stack direction="block" gap="small-200">
      {slots.length ? <s-text>Tick each payment you have checked actually reached Timanti (bank statement, GoKwik, or the cash drawer):</s-text> : null}
      {slots.map((s) => (
        <s-checkbox
          label={`Payment ${s.slot}: ${inr(s.amount)} on ${fmtDate(s.date)}${s.mode ? ` · ${MODE_NAMES[s.mode] || s.mode}` : ""} — ${sourceLabel(s)}`}
          checked={Boolean(ticked[s.slot])} onChange={(e) => onToggle(s.slot, checked(e))} />
      ))}
      {h.oldGold > 0 ? <s-text>Old gold handed in: {inr(h.oldGold)} (included)</s-text> : null}
      {h.exchangeNote > 0 ? <s-text>Exchange note handed in: {inr(h.exchangeNote)} (included)</s-text> : null}
      {plan.vouchered > 0 ? <s-text color="subdued">Already given back on voucher {plan.voucherCodes.join(", ")}: {inr(plan.vouchered)} (taken off)</s-text> : null}
    </s-stack>
  );
}
const verifiedPayout = (plan, ticked) => Math.max(0,
  (plan.slots || []).filter((s) => ticked[s.slot]).reduce((sum, s) => sum + s.amount, 0) + (plan.handedIn?.total || 0) - (plan.vouchered || 0));

function BuyPlan() {
  const draftId = String(shopify.data?.selected?.[0]?.id || "").replace(/\D/g, "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState(null);
  const [count, setCount] = useState(6);
  const [agreed, setAgreed] = useState(false);
  const [amount, setAmount] = useState("");
  const [storeAmount, setStoreAmount] = useState("");
  const [storeMode, setStoreMode] = useState("card");
  const [changeAgreed, setChangeAgreed] = useState(false);
  const [cancelKind, setCancelKind] = useState(null);
  const [cancelAgreed, setCancelAgreed] = useState(false);
  const [cancelNote, setCancelNote] = useState("");
  const [voucherAgreed, setVoucherAgreed] = useState(false);
  const [ticked, setTicked] = useState({});
  const toggle = (slot, on) => setTicked((t) => ({ ...t, [slot]: on }));
  const verifiedSlots = () => Object.keys(ticked).filter((k) => ticked[k]).map(Number);

  function take(body) {
    setData(body);
    if (body.plan) setAmount(String(body.plan.suggested || ""));
    if (!body.plan && body.preview && !mode) setMode(body.preview.suggestedMode || "equal");
  }

  async function load() {
    setLoading(true);
    setError("");
    try { take(await middleware(`/api/buy-plan/draft/${draftId}`)); }
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
    const body = await post("/api/buy-plan/start", { draftId, mode, installments: count });
    take(body);
    setNotice(mode === "gold"
      ? "Buy plan started. The gold rate is locked and the customer has been emailed their schedule."
      : "Buy plan started. The price is held at today's rate until 3 days before the last installment, when it is repriced. The customer has been emailed their schedule.");
  });

  const sendGoldLink = () => run(async () => {
    const body = await post("/api/buy-plan/gold-link", { draftId });
    setNotice(`A link for the gold value, ${inr(body.amount)}, is on its way to ${body.phone} by SMS and email. Once it is paid, reopen Buy plan and start the plan.`);
  });

  const sendLink = () => run(async () => {
    const body = await post("/api/buy-plan/send-link", { draftId, amount });
    setNotice(`A payment link for ${inr(body.amount)} is on its way to ${body.phone} by SMS and email.`);
  });

  const recordPayment = () => run(async () => {
    const body = await post("/api/buy-plan/record-payment", { draftId, amount: storeAmount, mode: storeMode });
    take(body);
    setStoreAmount("");
    setNotice(`${inr(Number(String(storeAmount).replace(/[^\d.]/g, "")))} by ${MODE_NAMES[storeMode]} recorded. The customer's thank-you email follows within a few hours.`);
  });

  const changeProduct = () => run(async () => {
    const body = await post("/api/buy-plan/change-product", { draftId, confirm: true });
    setChangeAgreed(false);
    setNotice(body.message);
    await load();
  });

  const issueVoucher = () => run(async () => {
    const body = await post("/api/buy-plan/issue-voucher", { draftId, confirm: true, verifiedSlots: verifiedSlots() });
    setVoucherAgreed(false);
    setTicked({});
    setNotice(body.kind === "closed"
      ? `Voucher ${body.voucher.code} for ${inr(body.voucher.value)} issued and emailed to the customer. Now delete this draft; do not complete it.`
      : `Voucher ${body.voucher.code} for ${inr(body.voucher.value)} issued and emailed to the customer. The plan is settled: complete the draft.`);
    await load();
  });

  const pickCancel = (k) => { setCancelKind(k); setCancelAgreed(false); setTicked({}); };

  const cancelPlan = () => run(async () => {
    const body = await post("/api/buy-plan/cancel", {
      draftId, kind: cancelKind, verifiedSlots: verifiedSlots(), note: cancelNote, confirm: true,
    });
    setCancelKind(null);
    setNotice(cancelKind === "mistake"
      ? "Plan cancelled. No voucher was made and the customer was not emailed. This is a normal draft again: delete it, or start a new plan."
      : body.voucher
      ? `Plan cancelled. Voucher ${body.voucher.code} for ${inr(body.voucher.value)} has been emailed to the customer. Delete this draft; do not complete it.`
      : body.voucherError
      ? `Plan cancelled, but the voucher could not be made: ${body.voucherError}. Create it by hand, then delete this draft.`
      : "Plan cancelled. Nothing was paid, so there is no voucher. Delete this draft.");
    await load();
  });

  const heading = `Buy plan${data?.draft ? ` — ${data.draft}` : ""}`;
  const plan = data?.plan;
  const pv = data?.preview;
  const option = mode ? data?.options?.[mode] : null;
  const rows = option?.rows?.[count] || [];
  const goldUnpaid = Boolean(mode === "gold" && pv && pv.goldValue > 0 && pv.goldOutstanding > 0);
  const active = plan?.status === "active";
  const amountProblem = (v) => {
    const a = Number(v);
    if (!plan || !(plan.balance > 0)) return "";
    if (!(a > 0)) return "Enter an amount";
    if (a < plan.minPayment) return `At least ${inr(plan.minPayment)}`;
    if (a > plan.balance) return `At most ${inr(plan.balance)}, the balance`;
    return "";
  };
  const linkProblem = amountProblem(amount);
  const storeProblem = amountProblem(storeAmount);
  const pick = (m) => { setMode(m); setAgreed(false); setNotice(""); setError(""); };
  const pickCount = (c) => { setCount(c); setAgreed(false); };

  return (
    <s-admin-action heading={heading} loading={loading}>
      <s-stack direction="block" gap="base">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {notice ? <s-banner tone="success">{notice}</s-banner> : null}

        {data && !plan && option ? (
          <s-stack direction="block" gap="base">
            <s-text>{inr(pv.total)} to collect. How will the customer pay?</s-text>
            <s-stack direction="inline" gap="small-200">
              <s-button variant={mode === "gold" ? "primary" : "secondary"} onClick={() => pick("gold")}>{MODE_LABEL.gold}</s-button>
              <s-button variant={mode === "equal" ? "primary" : "secondary"} onClick={() => pick("equal")}>{MODE_LABEL.equal}</s-button>
            </s-stack>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text>Installments:</s-text>
              {(data.installmentChoices || [4, 5, 6]).map((c) => (
                <s-button variant={count === c ? "primary" : "secondary"} onClick={() => pickCount(c)}>{String(c)}</s-button>
              ))}
            </s-stack>

            {mode === "gold" ? (
              <s-text>
                First payment: the gold value, {inr(pv.goldValue)} (before GST){pv.paid ? `, ${inr(pv.paid)} paid so far` : ""}.
                Paying it locks today's gold rate. The rest, GST included, is spread over the next {count - 1} months.
              </s-text>
            ) : (
              <s-text>
                {count} payments at today's price. The gold rate is not locked: 3 days before {fmtDate(pv.finalDates?.[count])} the
                draft is repriced at that day's rate, and the last payment covers the difference (more if gold rises, less if it falls).
              </s-text>
            )}
            <Schedule rows={rows} />
            <s-text color="subdued">
              Any payment from ₹1,000 counts. Paying more lowers the payments after it, paying less raises them, and a missed
              installment is added to the next. No payment for 60 days, or the plan unpaid 30 days after the last date, closes
              the plan and what was paid becomes a voucher valid for a year.
            </s-text>

            {goldUnpaid && !data.options.equal.blockers?.length ? (
              <s-stack direction="block" gap="small-200">
                <s-banner tone="info" heading={`Collect the gold value first: ${inr(pv.goldOutstanding)}`}>
                  Taken at the counter? Record it here. Or send the customer a link with the button below.
                </s-banner>
                <s-stack direction="inline" gap="small-200" alignItems="end">
                  <s-number-field label="Amount taken in store" min="1" step="1"
                    value={storeAmount} onInput={(e) => setStoreAmount(val(e))} />
                  <s-select label="Paid by" value={storeMode} onChange={(e) => setStoreMode(val(e))}>
                    {(data.storeModes || Object.keys(MODE_NAMES)).map((m) => <s-option value={m}>{MODE_NAMES[m] || m}</s-option>)}
                  </s-select>
                </s-stack>
                <s-button onClick={recordPayment} loading={busy} disabled={Boolean(busy || !storeAmount)}>Record payment</s-button>
              </s-stack>
            ) : option.blockers?.length ? (
              <s-banner tone="warning" heading="Fix these before starting">{option.blockers.join(" · ")}</s-banner>
            ) : (
              <s-checkbox
                label={mode === "gold"
                  ? `The customer has agreed: gold rate locked today, the rest over ${count - 1} monthly payments, and the closing rules above`
                  : `The customer has agreed: ${count} monthly payments, the last repriced at the gold rate 3 days before it is due, and the closing rules above`}
                checked={agreed}
                onChange={(e) => setAgreed(checked(e))}
              />
            )}
          </s-stack>
        ) : null}

        {plan ? (
          <s-stack direction="block" gap="base">
            {plan.status === "forfeited" ? (
              <s-banner tone="critical" heading="This plan has closed">
                <s-stack direction="block" gap="small-200">
                  <s-text>
                    {plan.closedReason ? `Closed: ${plan.closedReason}. ` : ""}
                    {plan.voucherDue > 0
                      ? "What was paid (and any old gold or exchange note handed in) is owed back to the customer as a voucher (one year, one purchase of at least its value). Nothing has been sent to them yet. Do not delete this draft until the voucher is issued."
                      : plan.voucherCodes?.length
                      ? `Voucher ${plan.voucherCodes.join(", ")} has been issued. Delete this draft; do not complete it.`
                      : "Nothing was paid. Delete this draft."}
                  </s-text>
                  {plan.voucherDue > 0 ? (
                    <s-stack direction="block" gap="small-200">
                      <VerifyPayments plan={plan} ticked={ticked} onToggle={toggle} />
                      <s-button onClick={issueVoucher} loading={busy} disabled={Boolean(busy || !(verifiedPayout(plan, ticked) > 0))}>
                        Issue voucher for {inr(verifiedPayout(plan, ticked))}
                      </s-button>
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-banner>
            ) : null}
            {plan.status === "completed" ? <s-banner tone="success">This plan is complete.</s-banner> : null}
            {plan.status === "cancelled" ? (
              <s-banner tone="critical" heading="This plan was cancelled">
                {plan.closedReason ? `Cancelled: ${plan.closedReason}. ` : ""}
                {plan.voucherCode
                  ? `What the customer paid, ${inr(plan.voucherValue || plan.paid)}, is voucher ${plan.voucherCode}. Delete this draft; do not complete it.`
                  : plan.paid > 0
                  ? "The voucher could not be created automatically. Create it by hand, then delete this draft."
                  : "Nothing was paid. Delete this draft."}
              </s-banner>
            ) : null}

            <s-text type="strong">{MODE_LABEL[plan.mode] || "Buy plan"} · {plan.n} installments</s-text>
            <s-text>
              {inr(plan.total)} · paid {inr(plan.paid)} · balance {inr(plan.balance)}
              {plan.lockedGoldRate ? ` · gold rate locked at ${plan.lockedGoldRate}` : ""}
            </s-text>
            {plan.awaitingFinalPrice ? (
              <s-text color="subdued">
                Price held at the starting rate until 3 days before {fmtDate(plan.finalDate)}, when the draft is repriced at that
                day's gold rate and the last payment is worked out. Do not complete the draft before then.
              </s-text>
            ) : null}
            {plan.finalTotal != null && plan.mode === "equal" ? (
              <s-text color="subdued">Final price: {inr(plan.finalTotal)} (started at {inr(plan.startTotal)}).</s-text>
            ) : null}
            {plan.changePending ? (
              <s-banner tone="info">Repricing the new pieces at today's gold rate. Reopen in a few minutes to see the new schedule.</s-banner>
            ) : null}
            {active && plan.warn ? (
              <s-banner tone="critical" heading={`Closes on ${fmtDate(plan.closeOn)} unless paid`}>
                No payment has come in for a while. Any payment from ₹1,000 keeps the plan going. The customer has been warned.
              </s-banner>
            ) : null}
            {active && plan.voucherDue > 0 ? (
              <s-banner tone="warning" heading={`The customer has paid ${inr(plan.voucherDue)} more than the price`}>
                <s-stack direction="block" gap="small-200">
                  <s-text>
                    Nothing has been issued or sent to the customer. First suggest a piece worth at least what they have paid, or a
                    second piece: add it to the draft, then press Change product. If they would rather have the difference back,
                    issue a voucher for it (one year, one purchase of at least its value). The plan is then settled at its price.
                  </s-text>
                  <s-checkbox label={`The customer wants ${inr(plan.voucherDue)} back as a voucher`}
                    checked={voucherAgreed} onChange={(e) => setVoucherAgreed(checked(e))} />
                  <s-button onClick={issueVoucher} loading={busy} disabled={Boolean(busy || !voucherAgreed)}>Issue voucher for {inr(plan.voucherDue)}</s-button>
                </s-stack>
              </s-banner>
            ) : null}
            {active && plan.vouchered > 0 ? (
              <s-text color="subdued">Voucher {plan.voucherCodes.join(", ")} ({inr(plan.vouchered)}) issued on this plan.</s-text>
            ) : null}

            {active && plan.piecesChanged && !plan.changePending ? (
              <s-banner tone="warning" heading="The pieces on the draft are not the plan's">
                <s-stack direction="block" gap="small-200">
                  <s-text>
                    If the customer is changing product: everything paid carries over and the dates stay. The draft is repriced at
                    today's gold rate and the balance spread over the installments left.
                    {plan.mode === "gold" ? " The locked gold rate is given up for good; the last installment is then repriced 3 days before it is due." : ""}
                    {" "}If the change was a mistake, put the original pieces back instead.
                  </s-text>
                  {plan.newPiecesEstimate != null ? (
                    <s-text>
                      New pieces: about {inr(plan.newPiecesEstimate)} at catalog prices (the exact price is set at today's gold rate).
                      Paid so far: {inr(plan.paid)}.
                    </s-text>
                  ) : null}
                  {plan.newPiecesEstimate != null && plan.newPiecesEstimate < plan.paid ? (
                    <s-banner tone="critical" heading={`About ${inr(plan.paid - plan.newPiecesEstimate)} more than the new pieces has been paid`}>
                      Suggest a piece worth {inr(plan.paid)} or more, or add a second piece. If the customer still wants this one,
                      go ahead: nothing is given back automatically, and you can issue a voucher for the difference afterwards.
                    </s-banner>
                  ) : null}
                  <s-checkbox label="The customer has agreed to the change of product" checked={changeAgreed} onChange={(e) => setChangeAgreed(checked(e))} />
                  <s-button onClick={changeProduct} loading={busy} disabled={Boolean(busy || !changeAgreed)}>Change product</s-button>
                </s-stack>
              </s-banner>
            ) : null}

            <Schedule rows={data.rows} />
            <Payments list={data.payments} />

            {active && plan.balance > 0 ? (
              <s-stack direction="block" gap="small-200">
                <s-divider />
                {plan.lastPayment ? (
                  <s-banner tone="warning" heading={`Five payments made: the next one must be the whole balance, ${inr(plan.balance)}`}>
                    A plan takes at most six payments. Links and the customer's pay page ask for the whole balance from now on.
                  </s-banner>
                ) : null}
                <s-text type="strong">Record a payment taken in store</s-text>
                <s-stack direction="inline" gap="small-200" alignItems="end">
                  <s-number-field label="Amount" min={String(plan.minPayment)} max={String(plan.balance)} step="1"
                    value={storeAmount} onInput={(e) => setStoreAmount(val(e))} />
                  <s-select label="Paid by" value={storeMode} onChange={(e) => setStoreMode(val(e))}>
                    {(data.storeModes || Object.keys(MODE_NAMES)).map((m) => <s-option value={m}>{MODE_NAMES[m] || m}</s-option>)}
                  </s-select>
                </s-stack>
                {storeAmount && storeProblem ? <s-text color="subdued">{storeProblem}</s-text> : null}
                <s-button onClick={recordPayment} loading={busy} disabled={Boolean(busy || !storeAmount || storeProblem)}>Record payment</s-button>

                <s-divider />
                <s-number-field
                  label={`Send a payment link (${plan.dueNow > 0 ? `due now ${inr(plan.dueNow)}` : plan.upcoming ? `next: ${inr(plan.upcoming.amount)} on ${fmtDate(plan.upcoming.due)}` : "the balance"}; at least ${inr(plan.minPayment)})`}
                  min={String(plan.minPayment)} max={String(plan.balance)} step="1"
                  value={amount} onInput={(e) => setAmount(val(e))}
                />
                {linkProblem ? <s-text color="subdued">{linkProblem}</s-text> : null}
                <s-text color="subdued">
                  The link goes to the customer by SMS and email, and replaces any earlier link that is still unpaid.
                  Reminders with a link also go automatically 3 days before each due date.
                </s-text>
                {plan.customPayUrl ? (
                  <s-text-field label="Customer's own link to pay a different amount (share on WhatsApp)" value={plan.customPayUrl} readOnly />
                ) : null}
              </s-stack>
            ) : active && !plan.awaitingFinalPrice && !(plan.voucherDue > 0) ? (
              <s-banner tone="success">Fully paid. The draft can be completed.</s-banner>
            ) : null}

            {active && !plan.changePending ? (
              <s-stack direction="block" gap="small-200">
                <s-divider />
                <s-text type="strong">Cancel this plan</s-text>
                <s-stack direction="inline" gap="small-200">
                  <s-button variant={cancelKind === "opted_out" ? "primary" : "secondary"} onClick={() => pickCancel("opted_out")}>Customer opted out</s-button>
                  <s-button variant={cancelKind === "mistake" ? "primary" : "secondary"} onClick={() => pickCancel("mistake")}>Demo or staff mistake</s-button>
                </s-stack>
                {cancelKind === "opted_out" ? (
                  <s-banner tone="warning" heading={verifiedPayout(plan, ticked) > 0 ? `Voucher for ${inr(verifiedPayout(plan, ticked))}` : "No voucher yet"}>
                    <s-stack direction="block" gap="small-200">
                      <s-text>
                        {plan.cancelVoucher > 0
                          ? "The payments you tick below, plus any old gold or exchange note handed in, become one voucher for the customer: valid one year, for one purchase worth at least its value. No cash refund. The customer is emailed."
                          : "Nothing is owed back, so there is no voucher. The customer is emailed that the plan is cancelled."}
                      </s-text>
                      {plan.cancelVoucher > 0 ? <VerifyPayments plan={plan} ticked={ticked} onToggle={toggle} /> : null}
                      {plan.slots?.length && !verifiedSlots().length ? (
                        <s-text color="subdued">No payment ticked: the voucher will not include any money paid.</s-text>
                      ) : null}
                      {plan.cancelVoucher > 0 ? (
                        <s-text color="subdued">If the payments were only recorded for a demo or by mistake, choose Demo or staff mistake instead.</s-text>
                      ) : null}
                    </s-stack>
                  </s-banner>
                ) : null}
                {cancelKind === "mistake" ? (
                  <s-banner tone="info" heading="No voucher, no customer email">
                    The plan stops and its price lock comes off. This becomes a normal draft again
                    {plan.paid > 0 ? `, still showing the ${inr(plan.paid)} recorded on it` : ""}. You can then delete it (it will not come
                    back), or start a new plan on it.
                  </s-banner>
                ) : null}
                {cancelKind ? (
                  <s-stack direction="block" gap="small-200">
                    <s-text-field label="Note (optional)" value={cancelNote} onInput={(e) => setCancelNote(val(e))} />
                    <s-checkbox label="Cancel this buy plan. This cannot be undone." checked={cancelAgreed} onChange={(e) => setCancelAgreed(checked(e))} />
                    <s-button tone="critical" onClick={cancelPlan} loading={busy}
                      disabled={Boolean(busy || !cancelAgreed)}>
                      {cancelKind === "opted_out" && verifiedPayout(plan, ticked) > 0 ? `Cancel plan and issue voucher for ${inr(verifiedPayout(plan, ticked))}` : "Cancel plan"}
                    </s-button>
                  </s-stack>
                ) : null}
              </s-stack>
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
      {active && plan.balance > 0 ? (
        <s-button slot="primary-action" variant="primary" onClick={sendLink} loading={busy}
          disabled={Boolean(busy || linkProblem)}>Send payment link</s-button>
      ) : null}
      <s-button slot="secondary-actions" onClick={() => shopify.close?.()}>Close</s-button>
    </s-admin-action>
  );
}

export default async () => {
  render(<BuyPlan />, document.body);
};
