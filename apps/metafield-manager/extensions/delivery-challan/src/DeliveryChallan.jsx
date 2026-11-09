import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Delivery challan — make it, or cancel it, from one explicit button each.
//
// Replaces typing the make-memo-custom / cancel-memo-custom tags. Everything happens on the
// middleware (src/modules/challan/routes.js) and the answer comes straight back here: the DC number,
// or exactly what is missing. Nothing is written until staff confirm.
//
//   Make   → sets where the goods go, draws the next DC- number from the From store's book, and
//            prices the draft at gold + making 100%, diamond 50% (the challan valuation).
//   Cancel → voids the number (never reused). The draft's prices stay as they are.

const MIDDLEWARE_BASE_URL = "https://timanti-middleware.fly.dev";

const val = (e) => e?.currentTarget?.value ?? e?.target?.value ?? "";
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

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

function DeliveryChallan() {
  const draftGid = shopify.data?.selected?.[0]?.id || "";
  const draftId = String(draftGid).split("/").pop();
  const [s, setS] = useState(null);           // status from GET /api/challan/:id
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("form"); // form | confirm | cancel
  const [shipOutside, setShipOutside] = useState(false);
  const [from, setFrom] = useState("");
  const [dest, setDest] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState(null); // { kind: 'made'|'cancelled', number, warning? }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const body = await middleware(`/api/challan/${draftId}`);
      setS(body);
      setShipOutside(body.shipOutside);
      const known = { ...(body.stores || {}), ...(body.demoStores || {}) };
      const start = known[body.origin] ? body.origin : Object.keys(body.stores || {})[0] || "";
      setFrom(start);
      const others = Object.keys(body.stores || {}).filter((c) => c !== start);
      setDest(body.deliveryCode && body.deliveryCode !== start ? body.deliveryCode : (others[0] || ""));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function make() {
    setBusy(true);
    setError("");
    try {
      const body = await middleware(`/api/challan/${draftId}/make`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: from, shipOutside, deliveryCode: shipOutside ? "" : dest }),
      });
      setResult({ kind: "made", number: body.number });
    } catch (e) {
      setError(e.message);
      setStage("form");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const body = await middleware(`/api/challan/${draftId}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setResult({ kind: "cancelled", number: body.number, warning: body.warning });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const heading = `Delivery challan${s?.draft?.name ? ` — ${s.draft.name}` : ""}`;
  const close = <s-button slot="secondary-actions" onClick={() => shopify.close?.()}>Close</s-button>;

  // ── Finished ──
  if (result) {
    return (
      <s-admin-action heading={heading}>
        {result.kind === "made" ? (
          <s-banner tone="success" heading={`Challan ${result.number} made`}>
            The draft is priced for the challan and numbered. Refresh the draft page, then print it from
            More actions → Print with Order Printer → Delivery Challan.
          </s-banner>
        ) : (
          <s-banner tone={result.warning ? "warning" : "success"} heading={`Challan ${result.number} cancelled`}>
            {result.warning || "The number is void and will never be used again. The draft's prices are unchanged."}
          </s-banner>
        )}
        <s-button slot="primary-action" variant="primary" onClick={() => shopify.close?.()}>Done</s-button>
      </s-admin-action>
    );
  }

  if (loading || !s) {
    return (
      <s-admin-action heading={heading} loading={loading}>
        {error ? <s-banner tone="critical">{error}</s-banner> : <s-text>Loading…</s-text>}
        {close}
      </s-admin-action>
    );
  }

  const c = s.challan;
  const storeName = (code) => s.stores?.[code] || s.demoStores?.[code] || code || "—";
  // Demo-only From store (KA-TEST): its own DC-KATEST book, never a real store's numbers.
  // Active/cancelled screens describe the stored From; the form describes the one being picked.
  const isDemoCode = (code) => Boolean(s.demoStores?.[code]);
  const demoBanner = (c && c.status === "active" ? s.demo : isDemoCode(from)) ? (
    <s-banner tone="info" heading="Demo store (KA-TEST)">
      This challan comes from the demo book (DC-KATEST-…), not from a real store. It prints as a demo document.
    </s-banner>
  ) : null;

  // ── Already cancelled ──
  if (c && c.status === "cancelled") {
    return (
      <s-admin-action heading={heading}>
        <s-banner tone="critical" heading={`Challan ${c.number} was cancelled`}>
          {c.cancelReason ? `Reason: ${c.cancelReason}. ` : ""}A cancelled number is never reissued. To raise a new
          challan, duplicate this draft and make the challan on the copy.
        </s-banner>
        {close}
      </s-admin-action>
    );
  }

  // ── Active challan ──
  if (c && c.status === "active") {
    if (stage === "cancel") {
      return (
        <s-admin-action heading={heading}>
          <s-stack direction="block" gap="base">
            {error ? <s-banner tone="critical">{error}</s-banner> : null}
            <s-banner tone="warning" heading={`Cancel challan ${c.number}?`}>
              The number is voided for good and cannot be reused. The draft's prices stay as they are.
              Any printed copy of this challan should be destroyed.
            </s-banner>
            <s-text-area label="Reason for cancelling" rows={3} placeholder="e.g. wrong destination store; goods not sent"
              value={reason} onInput={(e) => setReason(val(e))} />
          </s-stack>
          <s-button slot="primary-action" variant="primary" tone="critical" onClick={cancel} loading={busy}
            disabled={Boolean(busy || !reason.trim())}>Cancel challan {c.number}</s-button>
          <s-button slot="secondary-actions" onClick={() => { setStage("form"); setError(""); }}>Back</s-button>
        </s-admin-action>
      );
    }
    return (
      <s-admin-action heading={heading}>
        <s-stack direction="block" gap="base">
          {demoBanner}
          {error ? <s-banner tone="critical">{error}</s-banner> : null}
          {c.priced ? (
            <s-banner tone="success" heading={`Challan ${c.number} is active`}>
              From {storeName(s.origin)} to {s.shipOutside ? "the customer's address" : storeName(s.deliveryCode)}.
              Print it from More actions → Print with Order Printer → Delivery Challan.
            </s-banner>
          ) : (
            <s-banner tone="warning" heading={`Challan ${c.number} is numbered, but the challan prices may not be applied`}>
              If this challan was made with the old tag, it is already priced and nothing needs doing.
              If the last attempt here stopped part-way, press Apply challan prices; the number stays the same.
            </s-banner>
          )}
          {!c.priced && s.preview ? <Preview preview={s.preview} current={s.draft.total} /> : null}
        </s-stack>
        {!c.priced ? <s-button slot="primary-action" variant="primary" onClick={make} loading={busy} disabled={busy}>Apply challan prices</s-button> : null}
        <s-button slot="secondary-actions" tone="critical" onClick={() => { setStage("cancel"); setError(""); }}>Cancel this challan</s-button>
        {close}
      </s-admin-action>
    );
  }

  // ── No challan yet ──
  const others = Object.keys(s.stores || {}).filter((code) => code !== from);
  const fromOptions = [...Object.keys(s.stores || {}), ...Object.keys(s.demoStores || {})];
  const pickFrom = (code) => {
    setFrom(code);
    if (dest === code) setDest(Object.keys(s.stores || {}).find((x) => x !== code) || "");
  };
  const missing = [];
  if (!s.enabled) missing.push("delivery challans are switched off on the server");
  if (!s.stores?.[from] && !s.demoStores?.[from]) missing.push("a From store");
  if (!shipOutside && dest && dest === from) missing.push("a To store different from the From store");
  if (shipOutside && !s.customerAddress) missing.push("a customer shipping or billing address with a state on this draft");
  if (!shipOutside && !dest) missing.push("a destination store");
  if (!s.preview?.lines?.length) missing.push("at least one product line on the draft");
  const destination = shipOutside ? `the customer — ${s.customerAddress?.name || ""}, ${s.customerAddress?.line || ""}` : storeName(dest);

  if (stage === "confirm") {
    return (
      <s-admin-action heading={heading}>
        <s-stack direction="block" gap="base">
          {demoBanner}
          <s-banner tone="warning" heading="Make the delivery challan?">
            This draws the next DC number from {storeName(from)}'s book and reprices this draft to the
            challan value (gold and making in full, diamonds at 50%). The number cannot be taken back,
            only cancelled.
          </s-banner>
          <s-text>From: {storeName(from)}</s-text>
          <s-text>To: {destination}</s-text>
          <Preview preview={s.preview} current={s.draft.total} />
        </s-stack>
        <s-button slot="primary-action" variant="primary" onClick={make} loading={busy} disabled={busy}>Yes, make challan</s-button>
        <s-button slot="secondary-actions" onClick={() => setStage("form")}>Back</s-button>
      </s-admin-action>
    );
  }

  return (
    <s-admin-action heading={heading}>
      <s-stack direction="block" gap="base">
        {demoBanner}
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {s.originLocked ? (
          <s-text>From: <s-text type="strong">{storeName(from)}</s-text> (set by this draft's state: tag)</s-text>
        ) : (
          <s-select label="From store" value={from} onChange={(e) => pickFrom(val(e))}>
            {fromOptions.map((code) => <s-option value={code}>{storeName(code)}</s-option>)}
          </s-select>
        )}
        <s-checkbox label="Ship outside — deliver to the customer's address, not to a store" checked={shipOutside}
          onChange={(e) => setShipOutside(Boolean(e?.currentTarget?.checked ?? e?.target?.checked))} />
        {shipOutside ? (
          s.customerAddress
            ? <s-text>To: {s.customerAddress.name}, {s.customerAddress.line}</s-text>
            : <s-text color="subdued">This draft has no customer address with a state. Add one to the draft first.</s-text>
        ) : (
          <s-select label="To store" value={dest} onChange={(e) => setDest(val(e))}>
            {others.map((code) => <s-option value={code}>{storeName(code)}</s-option>)}
          </s-select>
        )}
        {s.preview?.lines?.length ? <Preview preview={s.preview} current={s.draft.total} /> : null}
        {missing.length ? <s-text color="subdued">Still needed: {missing.join("; ")}</s-text> : null}
      </s-stack>
      <s-button slot="primary-action" variant="primary" onClick={() => setStage("confirm")} disabled={Boolean(missing.length)}>Make delivery challan</s-button>
      {close}
    </s-admin-action>
  );
}

function Preview({ preview, current }) {
  if (!preview?.lines?.length) return null;
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">Challan prices</s-text>
      {preview.lines.map((l) => (
        <s-text>{l.title}{l.quantity > 1 ? ` × ${l.quantity}` : ""}: {inr(l.current)} → {inr(l.challan)}</s-text>
      ))}
      <s-text>Draft total now {inr(current)} · challan value {inr(preview.total)}</s-text>
    </s-stack>
  );
}

export default async () => {
  render(<DeliveryChallan />, document.body);
};
