import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Outside repair intake — a piece Timanti did not sell, taken in at the counter.
//
// Four short steps, then one Submit. Submit sends everything to the middleware
// (POST /api/repairs/outside-intake), which writes the inspection onto the draft's "repair" line and
// THEN tags it repair-outside + repair-intake (or free-repair). From that tag on, the ordinary repair
// flow runs: HQ intake mail, customer acknowledgement, Set Estimate, payment, Mark Complete.
//
// The terms text below must match OUTSIDE_TERMS in src/modules/after-sales/outside/specs.js, which
// is what the customer's email and the repair note print.

const MIDDLEWARE_BASE_URL = "https://timanti-middleware.fly.dev";

const METALS = ["24K Gold", "22K Gold", "18K Gold", "14K Gold", "9K Gold", "Silver 925", "Platinum 950", "Other"];
const COLOURS = ["Yellow", "White", "Rose", "Two-tone", "—"];
const TEST_METHODS = ["XRF", "Touchstone", "Declared by customer"];
const WORK_OPTIONS = [
  "Resize", "Solder / joint repair", "Polish / buff", "Rhodium / plating", "Stone reset (tighten)",
  "Stone replace", "Clasp / lock", "Chain repair", "Prong / claw rebuild", "Other",
];
const TERMS = [
  "Stone type, count and carat weight are as declared by you and observed by us; they are not certified by Timanti.",
  "Timanti is not responsible for damage arising from pre-existing wear, weakness, prior repairs or defects noted at intake.",
  "The metal and purity recorded are the result of our test at intake, which you have accepted.",
  "The piece must be collected within 30 days of our telling you it is ready. After that it is shipped to your address on file at your cost, or, with no address on file, a late fee of [LATE FEE: TBD] accrues.",
];
const STEPS = ["Piece", "Condition & stones", "Work requested", "Terms & submit"];

const EMPTY = {
  description: "", metal: "22K Gold", colour: "Yellow", metalOther: "",
  testMethod: "XRF", testReading: "", hallmark: "", grossWeight: "", photos: [],
  diaPcs: "", diaCts: "", gemCts: "", stonesNote: "", condition: "",
  work: [], workNote: "", repairClass: "paid", campaign: "", termsAccepted: false,
};

const val = (e) => e?.currentTarget?.value ?? e?.target?.value ?? "";

function metalLabel(f) {
  const base = f.metal === "Other" ? f.metalOther.trim() : f.metal.replace(" Gold", "");
  const colour = f.colour && f.colour !== "—" && f.metal.includes("Gold") ? f.colour : "";
  return [base, colour].filter(Boolean).join(" ");
}

// The middleware's shape (validateInspection / buildOutsideProps in outside/specs.js).
function toInspection(f) {
  return {
    description: f.description.trim(),
    metal: metalLabel(f),
    metalTest: { method: f.testMethod, reading: f.testReading.trim() },
    hallmark: f.hallmark.trim(),
    grossWeight: f.grossWeight,
    stones: { diaPcs: f.diaPcs, diaCts: f.diaCts, gemCts: f.gemCts, note: f.stonesNote.trim() },
    condition: f.condition.trim(),
    work: { items: f.work, note: f.workNote.trim() },
    photos: f.photos,
    termsAccepted: f.termsAccepted === true,
  };
}

// Mirrors validateInspection, per step, so staff are stopped on the step that is missing something.
function missingFor(step, f) {
  const m = [];
  if (step === 0) {
    if (!f.description.trim()) m.push("Description of the piece");
    if (f.metal === "Other" && !f.metalOther.trim()) m.push("Metal and karat");
    if (!(parseFloat(f.grossWeight) > 0)) m.push("Gross weight at intake");
    if (!f.photos.length) m.push("At least one photo");
  }
  if (step === 2 && !f.work.length && !f.workNote.trim()) m.push("What work is requested");
  if (step === 3 && !f.termsAccepted) m.push("Customer has accepted the terms");
  return m;
}

async function middleware(path, init) {
  const idToken = await shopify.auth.idToken();
  if (!idToken) throw new Error("this admin session could not be verified");
  const res = await fetch(`${MIDDLEWARE_BASE_URL}${path}`, {
    ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${idToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error((body.missing?.length ? `${body.error}: ${body.missing.join(", ")}` : body.error) || `HTTP ${res.status}`);
  }
  return body;
}

function OutsideRepairIntake() {
  const draftId = shopify.data?.selected?.[0]?.id || "";
  const [f, setF] = useState(EMPTY);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [draftInfo, setDraftInfo] = useState({ name: "", tags: [], hasLine: true, timantiRepair: false });
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));

  // Load the draft, and a previous inspection if this is a correction.
  useEffect(() => {
    (async () => {
      try {
        const res = await shopify.query(
          `query($id: ID!) { draftOrder(id: $id) {
             name tags lineItems(first: 1) { nodes { title } }
             inspection: metafield(namespace: "custom", key: "repair_inspection") { value }
             orderRef: metafield(namespace: "custom", key: "repair_order_reference") { value }
           } }`, { variables: { id: draftId } });
        const d = res?.data?.draftOrder;
        if (!d) throw new Error("Could not read this draft");
        const tags = d.tags || [];
        setDraftInfo({
          name: d.name, tags,
          hasLine: (d.lineItems?.nodes || []).length > 0,
          // A Timanti repair already under way: this form must not convert it.
          timantiRepair: !tags.includes("repair-outside") && (tags.includes("repair-hq-notified") || tags.includes("repair-free-notified") || Boolean(d.orderRef?.value)),
        });
        if (d.inspection?.value) {
          const p = JSON.parse(d.inspection.value);
          set({
            description: p.description || "", hallmark: p.hallmark || "", grossWeight: String(p.grossWeight || ""),
            testMethod: p.metalTest?.method || "XRF", testReading: p.metalTest?.reading || "",
            metal: "Other", metalOther: p.metal || "", colour: "—",
            photos: p.photos || [], diaPcs: p.stones?.diaPcs || "", diaCts: p.stones?.diaCts || "",
            gemCts: p.stones?.gemCts || "", stonesNote: p.stones?.note || "", condition: p.condition || "",
            work: p.work?.items || [], workNote: p.work?.note || "", repairClass: p.repairClass || "paid",
            campaign: p.campaign || "", termsAccepted: p.termsAccepted === true,
          });
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function addPhotos(e) {
    const files = Array.from(e?.currentTarget?.files || e?.target?.files || []);
    if (!files.length) return;
    setError("");
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const { url } = await middleware(`/api/repairs/photo?filename=${encodeURIComponent(file.name || "photo.jpg")}`, {
          method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file,
        });
        setF((prev) => ({ ...prev, photos: [...prev.photos, url] }));
      } catch (err) {
        setError(`Photo "${file.name}": ${err.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const body = await middleware("/api/repairs/outside-intake", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, inspection: toInspection(f), repairClass: f.repairClass, campaign: f.campaign.trim() }),
      });
      setDone(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const missing = missingFor(step, f);
  const blocked = !draftInfo.hasLine || draftInfo.timantiRepair;
  const next = () => { if (!missing.length) setStep((s) => Math.min(s + 1, STEPS.length - 1)); };

  const stepBody = [
    // ── 1. Piece ──
    <s-stack direction="block" gap="base">
      <s-text-field label="Description of the piece" placeholder="e.g. Plain 22K gold bangle, 2.4 inch" value={f.description} onInput={(e) => set({ description: val(e) })} />
      <s-stack direction="inline" gap="base">
        <s-select label="Metal" value={f.metal} onChange={(e) => set({ metal: val(e) })}>
          {METALS.map((m) => <s-option value={m}>{m}</s-option>)}
        </s-select>
        <s-select label="Colour" value={f.colour} onChange={(e) => set({ colour: val(e) })}>
          {COLOURS.map((c) => <s-option value={c}>{c}</s-option>)}
        </s-select>
      </s-stack>
      {f.metal === "Other" ? <s-text-field label="Metal and karat" placeholder="e.g. 20K YG" value={f.metalOther} onInput={(e) => set({ metalOther: val(e) })} /> : null}
      <s-stack direction="inline" gap="base">
        <s-select label="Tested by" value={f.testMethod} onChange={(e) => set({ testMethod: val(e) })}>
          {TEST_METHODS.map((m) => <s-option value={m}>{m}</s-option>)}
        </s-select>
        <s-text-field label="Reading" placeholder="e.g. 91.6%" value={f.testReading} onInput={(e) => set({ testReading: val(e) })} />
      </s-stack>
      <s-text-field label="Hallmark / HUID" placeholder="Leave blank if none" value={f.hallmark} onInput={(e) => set({ hallmark: val(e) })} />
      <s-number-field label="Gross weight at intake (g) — weighed with the customer present" step="0.01" min="0" value={f.grossWeight} onInput={(e) => set({ grossWeight: val(e) })} />
      <s-drop-zone label="Photos — front, back, any damage close-up, and one on the scale" accept="image/*" multiple onInput={addPhotos} />
      {uploading ? <s-text color="subdued">Uploading {uploading} photo{uploading > 1 ? "s" : ""}…</s-text> : null}
      {f.photos.length ? (
        <s-stack direction="inline" gap="small-200">
          {f.photos.map((url, i) => (
            <s-stack direction="block" gap="small-500">
              <s-image src={url} alt={`Intake photo ${i + 1}`} inlineSize="auto" aspectRatio="1" objectFit="cover" />
              <s-button variant="tertiary" onClick={() => set({ photos: f.photos.filter((_, j) => j !== i) })}>Remove</s-button>
            </s-stack>
          ))}
        </s-stack>
      ) : null}
    </s-stack>,

    // ── 2. Condition & stones ──
    <s-stack direction="block" gap="base">
      <s-text>Stones are recorded as the customer declares them. They are not certified.</s-text>
      <s-stack direction="inline" gap="base">
        <s-number-field label="Diamond pcs" min="0" value={f.diaPcs} onInput={(e) => set({ diaPcs: val(e) })} />
        <s-number-field label="Diamond ct" step="0.01" min="0" value={f.diaCts} onInput={(e) => set({ diaCts: val(e) })} />
        <s-number-field label="Gemstone ct" step="0.01" min="0" value={f.gemCts} onInput={(e) => set({ gemCts: val(e) })} />
      </s-stack>
      <s-text-field label="Stones — anything else" placeholder="e.g. 1 ruby centre, 2 small stones missing" value={f.stonesNote} onInput={(e) => set({ stonesNote: val(e) })} />
      <s-text-area label="Condition at intake" rows={4} placeholder="Pre-existing damage, wear, loose stones, prior repairs, solder marks" value={f.condition} onInput={(e) => set({ condition: val(e) })} />
    </s-stack>,

    // ── 3. Work requested ──
    <s-stack direction="block" gap="base">
      <s-choice-list label="Work requested" multiple values={f.work} onChange={(e) => set({ work: e?.currentTarget?.values ?? e?.target?.values ?? [] })}>
        {WORK_OPTIONS.map((w) => <s-choice value={w}>{w}</s-choice>)}
      </s-choice-list>
      <s-text-area label="Details" rows={3} placeholder="e.g. resize 14 → 16; reshape round" value={f.workNote} onInput={(e) => set({ workNote: val(e) })} />
      <s-select label="Charge" value={f.repairClass} onChange={(e) => set({ repairClass: val(e) })}>
        <s-option value="paid">Paid repair — HQ sets an estimate</s-option>
        <s-option value="free">Complimentary — no charge</s-option>
      </s-select>
      <s-text-field label="Campaign code (optional)" placeholder="e.g. diwali-2026" value={f.campaign} onInput={(e) => set({ campaign: val(e) })} />
    </s-stack>,

    // ── 4. Terms & submit ──
    <s-stack direction="block" gap="base">
      <s-text>Read these to the customer. They are printed on their acknowledgement email and on the repair note.</s-text>
      <s-ordered-list>{TERMS.map((t) => <s-list-item>{t}</s-list-item>)}</s-ordered-list>
      <s-checkbox label="The customer has heard and accepted these terms" checked={f.termsAccepted} onChange={(e) => set({ termsAccepted: Boolean(e?.currentTarget?.checked ?? e?.target?.checked) })} />
      <s-divider />
      <s-text type="strong">Summary</s-text>
      <s-text>{f.description || "—"} · {metalLabel(f) || "—"} ({f.testMethod}{f.testReading ? ` ${f.testReading}` : ""}) · {f.grossWeight || "—"} g · {f.photos.length} photo{f.photos.length === 1 ? "" : "s"}</s-text>
      <s-text>Work: {[...f.work, f.workNote].filter(Boolean).join("; ") || "—"} · {f.repairClass === "free" ? "Complimentary" : "Paid"}</s-text>
    </s-stack>,
  ];

  if (done) {
    return (
      <s-admin-action heading="Outside repair intake">
        <s-banner tone="success" heading={done.intakeAlreadySent ? "Inspection updated" : "Repair started"}>
          {done.intakeAlreadySent
            ? `${done.draft}: the inspection record was corrected. Emails already sent are not re-sent.`
            : `${done.draft}: the customer's acknowledgement and the store's Set Estimate email go out in a moment.`}
        </s-banner>
        <s-button slot="primary-action" variant="primary" onClick={() => shopify.close?.()}>Done</s-button>
      </s-admin-action>
    );
  }

  return (
    <s-admin-action heading={`Outside repair intake${draftInfo.name ? ` — ${draftInfo.name}` : ""}`} loading={loading}>
      <s-stack direction="block" gap="base">
        {!draftInfo.hasLine ? <s-banner tone="critical" heading="Add the repair line first">Add a custom item titled "repair" to this draft, save, then open this again.</s-banner> : null}
        {draftInfo.timantiRepair ? <s-banner tone="critical" heading="This is a Timanti repair">It already has an original order or is under way. Use the Jewellery Workspace instead.</s-banner> : null}
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        <s-text color="subdued">Step {step + 1} of {STEPS.length} · {STEPS[step]}</s-text>
        {stepBody[step]}
        {missing.length ? <s-text color="subdued">Still needed: {missing.join(", ")}</s-text> : null}
      </s-stack>
      {step < STEPS.length - 1 ? (
        <s-button slot="primary-action" variant="primary" onClick={next} disabled={Boolean(missing.length || uploading || blocked)}>Next</s-button>
      ) : (
        <s-button slot="primary-action" variant="primary" onClick={submit} loading={busy} disabled={Boolean(missing.length || busy || blocked)}>Submit & start repair</s-button>
      )}
      {step > 0 ? <s-button slot="secondary-actions" onClick={() => setStep((s) => s - 1)}>Back</s-button> : null}
      <s-button slot="secondary-actions" onClick={() => shopify.close?.()}>Cancel</s-button>
    </s-admin-action>
  );
}

export default async () => {
  render(<OutsideRepairIntake />, document.body);
};
