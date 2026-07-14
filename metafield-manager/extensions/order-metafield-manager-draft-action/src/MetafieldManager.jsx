/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * Shared workflow-metafield manager rendered by both the Draft Order and Order
 * block targets.
 *
 * RENDERING is driven by the static FIELD_CONFIG below, so the block always
 * shows its fields and can never go blank even if a network call fails. The
 * live metafield definitions are queried only to resolve each field's namespace
 * and type for SAVING (and to pick the right input widget). Every query is
 * best-effort: a failure shows a non-blocking note, never an empty block.
 *
 *   - section:  visual grouping
 *   - editable: whether store staff may edit it (else read-only)
 *   - applies:  "draft" | "order" | "both" — which page the field belongs to
 *
 * Mirrors middleware metafield_governance.csv. Namespace/type are never
 * hardcoded — they come from the live definitions at save time.
 */
// Founder flow: identity header (top, read-only) → Required Inputs → Payments →
// Pricing (incl. discounts) → Product Metadata → Adjustments (selector + values) →
// Repair → Credit Note → Manufacturing → System. "Order Details" is gone (its
// fields are Required), "Exchange" was always dead, "Procurement" PO fields removed.
const SECTION_ORDER = [
  "Payments",
  "Pricing",
  "Product Metadata",
  "Adjustments",
  "Repair",
  "Credit Note",
  "Manufacturing",
  "System",
];

// Compulsory staff inputs, in the priority order they must be filled. These are
// promoted into a single "Required Inputs" section at the top of the block,
// ahead of (and removed from) their topical sections below. Ordering here is
// the source of truth for the required tier — editability still comes from
// FIELD_CONFIG.
// Staff-fill only. payment_status / amount_pending were removed — they are now SYSTEM-computed
// (net-based) and shown read-only, so staff can't hand-type a wrong balance.
const REQUIRED_FIELDS = [
  "order_type",
  "channel",
  "state_code",
  "payment_mode_advance",
  "amount_paid",
];
const REQUIRED_SET = new Set(REQUIRED_FIELDS);
const REQUIRED_SECTION = "Required Inputs";

// Read-only identity block promoted ABOVE Required Inputs (document type + serials).
// These are auto-stamped by the middleware; staff only read them.
const IDENTITY_FIELDS = [
  "document_type",
  "serial_display",
  "serial_code",
  "serial_no",
  "serial_state",
  "order_name",
  "source_order_id",
  "action_token",
];
const IDENTITY_SET = new Set(IDENTITY_FIELDS);
const IDENTITY_SECTION = "Document / Identity";

const FIELD_CONFIG = {
  order_type: { section: "Order Details", label: "Order Type", editable: true, applies: "both" },
  channel: { section: "Order Details", label: "Channel", editable: true, applies: "both" },

  // System-computed (net-based) — read-only so staff never hand-type a balance.
  payment_status: { section: "Payments", label: "Payment Status", editable: false, applies: "both" },
  payment_mode_advance: { section: "Payments", label: "Advance Payment Mode", editable: true, applies: "both" },
  payment_mode_final: { section: "Payments", label: "Final Payment Mode", editable: true, applies: "both" },
  amount_paid: { section: "Payments", label: "Amount Paid", editable: true, applies: "both" },
  amount_pending: { section: "Payments", label: "Amount Pending", editable: false, applies: "both" },
  amount_to_be_collected: { section: "Payments", label: "Amount To Be Collected", editable: false, applies: "both" },

  gold_rate: { section: "Pricing", label: "Gold Rate", editable: true, applies: "both" },
  gold_rate_date: { section: "Pricing", label: "Gold Rate Date", editable: true, applies: "both" },
  gross_value: { section: "Pricing", label: "Gross Value (pre-discount)", editable: false, applies: "both" },
  discount_applied: { section: "Pricing", label: "Discount Applied (pre-tax)", editable: false, applies: "both" },

  // Adjustments — old gold (staff enter weight+purity, system values it), exchange/voucher (system),
  // and CAD design advance. advance_ref is the one staff-fill here (redeem a past advance, Path B).
  old_gold_weight: { section: "Adjustments", label: "Old Gold Weight (g)", editable: true, applies: "both" },
  old_gold_purity: { section: "Adjustments", label: "Old Gold Purity (karat)", editable: true, applies: "draft" },
  old_gold_value: { section: "Adjustments", label: "Old Gold Value (auto; override optional)", editable: true, applies: "both" },
  exchange_note_value: { section: "Adjustments", label: "Exchange Note Value (auto from Apply; override optional)", editable: true, applies: "both" },
  voucher_value: { section: "Adjustments", label: "Voucher Value (auto from Apply; override optional)", editable: true, applies: "both" },
  advance: { section: "Adjustments", label: "Design Advance (auto from reference; override optional)", editable: true, applies: "both" },
  advance_ref: { section: "Adjustments", label: "Advance Ref — order # to redeem", editable: true, applies: "both" },
  advance_status: { section: "Adjustments", label: "Advance Status", editable: false, applies: "both" },
  redeemed_against: { section: "Adjustments", label: "Advance Redeemed Against", editable: false, applies: "both" },

  cn_number: { section: "Credit Note", label: "Credit Note Number", editable: false, applies: "order" },
  cn_value: { section: "Credit Note", label: "Credit Note Value", editable: false, applies: "order" },
  cn_issued_date: { section: "Credit Note", label: "Credit Note Issued", editable: false, applies: "order" },
  cn_expiry: { section: "Credit Note", label: "Credit Note Expiry", editable: false, applies: "order" },

  jewelcode: { section: "Product Metadata", label: "Jewelcode (JSON)", editable: false, applies: "both" },
  jewel_code: { section: "Product Metadata", label: "Jewel Code", editable: false, applies: "draft" },
  sku_id: { section: "Product Metadata", label: "SKU ID", editable: false, applies: "draft" },
  jewelcode_gross_weight: { section: "Product Metadata", label: "Gross Weight", editable: true, applies: "both" },
  jewelcode_net_weight: { section: "Product Metadata", label: "Net Weight", editable: true, applies: "both" },
  jewelcode_diamond_carats: { section: "Product Metadata", label: "Diamond Carats", editable: true, applies: "both" },
  jewelcode_diamond_pieces: { section: "Product Metadata", label: "Diamond Pieces", editable: true, applies: "draft" },
  jewelcode_gemstone_weight: { section: "Product Metadata", label: "Gemstone Weight", editable: true, applies: "both" },
  gross_wt: { section: "Product Metadata", label: "Gross Weight (legacy)", editable: false, applies: "draft" },
  net_wt: { section: "Product Metadata", label: "Net Weight (legacy)", editable: false, applies: "draft" },
  diamond_cts: { section: "Product Metadata", label: "Diamond Carats (legacy)", editable: false, applies: "draft" },

  // Read-only PO display fields (po_status/po_type/po_routing/batch_*) are intentionally
  // left in the now-unlisted "Procurement" section so they no longer render in this panel
  // (redundant here; still set/used server-side and in PO-ops). The EDITABLE staff inputs
  // below are relocated to "Manufacturing" so they survive.
  po_status: { section: "Procurement", label: "PO Status", editable: false, applies: "draft" },
  po_type: { section: "Procurement", label: "PO Type", editable: false, applies: "draft" },
  po_routing: { section: "Procurement", label: "PO Routing (JSON)", editable: false, applies: "both" },
  batch_id: { section: "Procurement", label: "PO Batch ID", editable: false, applies: "draft" },
  batch_date: { section: "Procurement", label: "PO Batch Date", editable: false, applies: "draft" },
  delivery_code: { section: "Manufacturing", label: "Delivery / Store Code", editable: true, applies: "draft" },
  replenishment_comments: { section: "Manufacturing", label: "Replenishment Notes", editable: true, applies: "both" },
  po_replenishment_variants: { section: "Manufacturing", label: "Replenishment Variants", editable: true, applies: "order" },
  po_mto_variants: { section: "Manufacturing", label: "MTO Variants", editable: true, applies: "order" },

  repair_order_reference: { section: "Repair", label: "Linked Repair Order", editable: true, applies: "draft" },
  repair_intake_at: { section: "Repair", label: "Repair Intake At", editable: false, applies: "draft" },
  repair_estimate_sent_at: { section: "Repair", label: "Estimate Sent At", editable: false, applies: "draft" },
  repair_completed_at: { section: "Repair", label: "Repair Completed At", editable: false, applies: "draft" },
  repair_store_pickup: { section: "Repair", label: "Store Pickup", editable: false, applies: "draft" },

  mto_comments: { section: "Manufacturing", label: "Manufacturing Notes", editable: true, applies: "order" },
  mto_comment: { section: "Manufacturing", label: "Manufacturing Note", editable: true, applies: "draft" },

  state_code: { section: "System", label: "Store / State Code", editable: true, applies: "both" },
  invoice_date: { section: "System", label: "Invoice Date", editable: true, applies: "both" },
  is_finalized: { section: "System", label: "Finalized", editable: false, applies: "both" },
  order_name: { section: "System", label: "Linked Order Name", editable: false, applies: "draft" },
  source_order_id: { section: "System", label: "Source Order ID", editable: false, applies: "draft" },
  document_type: { section: "System", label: "Document Type", editable: false, applies: "both" },
  serial_no: { section: "System", label: "Serial No", editable: false, applies: "both" },
  serial_code: { section: "System", label: "Serial Code", editable: false, applies: "both" },
  serial_display: { section: "System", label: "Display Serial", editable: false, applies: "both" },
  serial_state: { section: "System", label: "Serial State", editable: false, applies: "draft" },
  action_token: { section: "System", label: "Action Token", editable: false, applies: "draft" },
};

function resolveContext() {
  const id = shopify.data?.selected?.[0]?.id || "";
  const isOrder = id.includes("/Order/");
  return {
    id,
    ownerType: isOrder ? "ORDER" : "DRAFTORDER",
    resourceField: isOrder ? "order" : "draftOrder",
    scope: isOrder ? "order" : "draft",
  };
}

function fieldsForScope(scope) {
  return Object.keys(FIELD_CONFIG).filter((key) => {
    const a = FIELD_CONFIG[key].applies;
    return a === "both" || a === scope;
  });
}

function buildSections(scope) {
  const inScope = fieldsForScope(scope);
  const inScopeSet = new Set(inScope);

  // Read-only identity block → single section promoted ABOVE everything, in
  // IDENTITY_FIELDS order (document type + serials). Always rendered read-only.
  const identityFields = IDENTITY_FIELDS.filter((key) => inScopeSet.has(key)).map((key) => ({
    key,
    label: FIELD_CONFIG[key].label,
    editable: false,
  }));

  // Required staff inputs → single top section, in REQUIRED_FIELDS priority order.
  const requiredFields = REQUIRED_FIELDS.filter((key) => inScopeSet.has(key)).map((key) => ({
    key,
    label: FIELD_CONFIG[key].label,
    editable: FIELD_CONFIG[key].editable,
    required: true,
  }));

  // Everything else stays in its topical section (required + identity keys are
  // removed here since they've been promoted above).
  const bySection = {};
  for (const key of inScope) {
    if (REQUIRED_SET.has(key) || IDENTITY_SET.has(key)) continue;
    const cfg = FIELD_CONFIG[key];
    (bySection[cfg.section] ||= []).push({ key, label: cfg.label, editable: cfg.editable });
  }
  const topical = SECTION_ORDER.filter((title) => bySection[title]?.length).map((title) => ({
    title,
    fields: bySection[title],
  }));

  const sections = [];
  if (identityFields.length) sections.push({ title: IDENTITY_SECTION, fields: identityFields });
  if (requiredFields.length) sections.push({ title: REQUIRED_SECTION, fields: requiredFields });
  return sections.concat(topical);
}

function buildDefinitionsQuery(ownerType) {
  return `
    query WorkflowMetafieldDefinitions {
      metafieldDefinitions(first: 250, ownerType: ${ownerType}) {
        nodes { namespace key type { name } validations { name value } }
      }
    }
  `;
}

// Choice-list metafields are stored as text/list types with a "choices"
// validation holding a JSON array of allowed values. Pull it out so the editor
// can render a dropdown instead of a free-text box.
function parseChoices(validations) {
  const v = (validations ?? []).find((x) => x.name === "choices");
  if (!v?.value) return undefined;
  try {
    const parsed = JSON.parse(v.value);
    return Array.isArray(parsed) && parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildValuesQuery(resourceField) {
  return `
    query WorkflowMetafields($id: ID!) {
      ${resourceField}(id: $id) {
        id
        metafields(first: 250) { nodes { namespace key value type } }
      }
    }
  `;
}

const SET_MUTATION = `
  mutation SetWorkflowMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { namespace key value }
      userErrors { field message code }
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteWorkflowMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { namespace key ownerId }
      userErrors { field message }
    }
  }
`;

// Adding a tag fires the resource's update webhook (a metafield save does NOT). We use this to nudge the
// middleware: `sync-payment` recomputes the balance off the net; `apply-voucher:<code>` redeems a
// voucher from the ledger. The middleware strips these trigger tags after processing.
const TAGS_ADD_MUTATION = `
  mutation AddWorkflowTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;
const PAYMENT_TRIGGER_KEYS = ["amount_paid", "payment_mode_advance", "payment_mode_final"];

// A metafield save alone never fires the resource webhook, so the middleware never recomputes on its
// own. We add trigger tags for what changed so it does (the middleware strips them after processing):
//  - `reprice`      → re-run the line-item price calc (gold rate × net weight, discount, GST).
//  - `sync-payment` → recompute net-to-collect (amount_to_be_collected) + balance (amount_pending);
//                     also runs syncAmountToCollect, which re-reads every adjustment metafield.
// Gold rate / jewel weights drive a full reprice; adjustment + payment fields drive a balance recompute.
const REPRICE_TRIGGER_KEYS = [
  "gold_rate", "gold_rate_date",
  "jewelcode_net_weight", "jewelcode_gross_weight",
  "jewelcode_diamond_carats", "jewelcode_gemstone_weight",
];
const RECOMPUTE_TRIGGER_KEYS = [
  ...PAYMENT_TRIGGER_KEYS,
  "old_gold_weight", "old_gold_purity", "old_gold_value",
  "exchange_note_value", "voucher_value", "advance", "advance_ref",
];

function collectErrors(result, mutationField) {
  const errs = (result?.errors ?? []).map((e) => e.message);
  for (const e of result?.data?.[mutationField]?.userErrors ?? []) {
    const where = Array.isArray(e.field) ? e.field.join(".") : e.field;
    errs.push(where ? `${where}: ${e.message}` : e.message);
  }
  return errs;
}

// The block's "Show all fields" button opens the matching action extension —
// the full-height panel that isn't capped by block height. This is Shopify's
// documented block -> action navigation.
const ACTION_HANDLE = {
  draft: "order-metafield-manager-draft-action",
  order: "order-metafield-manager-order-action",
};

export default function MetafieldManager({ surface = "block" } = {}) {
  const ctx = resolveContext();
  const ownerId = ctx.id;

  const [defs, setDefs] = useState({}); // key -> { namespace, type } (best-effort)
  const [values, setValues] = useState({}); // key -> stored value
  const [edits, setEdits] = useState({}); // editable key -> current value
  const [notice, setNotice] = useState(""); // non-blocking load warning
  const [error, setError] = useState(""); // save error
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [voucherCode, setVoucherCode] = useState("");
  const [voucherBusy, setVoucherBusy] = useState(false);
  const [voucherNote, setVoucherNote] = useState("");
  const [excCode, setExcCode] = useState("");
  const [excBusy, setExcBusy] = useState(false);
  const [excNote, setExcNote] = useState("");
  const [refreshTick, setRefreshTick] = useState(0); // bumped after a save to re-pull server-recomputed values
  const [recalcNote, setRecalcNote] = useState(""); // transient "recalculating…" hint after a trigger tag
  const baselineRef = useRef({});
  const editsRef = useRef({});

  useEffect(() => {
    let active = true;

    async function load() {
      const valuesByKey = {};
      const defsByKey = {};
      const warnings = [];

      // Values — best-effort.
      if (ownerId) {
        try {
          const res = await shopify.query(buildValuesQuery(ctx.resourceField), { variables: { id: ownerId } });
          if (res?.errors?.length) warnings.push(res.errors.map((e) => e.message).join("; "));
          for (const n of res?.data?.[ctx.resourceField]?.metafields?.nodes ?? []) {
            valuesByKey[n.key] = n.value ?? "";
          }
        } catch (e) {
          warnings.push(`Couldn't load values: ${e?.message || e}`);
        }
      } else {
        warnings.push("No resource is in context.");
      }

      // Definitions — best-effort (only needed for save namespace/type + widget).
      try {
        const res = await shopify.query(buildDefinitionsQuery(ctx.ownerType));
        if (res?.errors?.length) warnings.push(res.errors.map((e) => e.message).join("; "));
        for (const d of res?.data?.metafieldDefinitions?.nodes ?? []) {
          defsByKey[d.key] = {
            namespace: d.namespace,
            type: d.type?.name,
            choices: parseChoices(d.validations),
          };
        }
      } catch (e) {
        warnings.push(`Couldn't load definitions: ${e?.message || e}`);
      }
      // Fall back to each metafield's own namespace/type where no definition.
      // (values query already carried them; merge in.)

      const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const editable = {};
      for (const key of fieldsForScope(ctx.scope)) {
        if (!FIELD_CONFIG[key].editable) continue;
        let v = valuesByKey[key] ?? "";
        // invoice_date auto-fills to today when blank, but stays editable (staff can override).
        if (key === "invoice_date" && !v) v = todayISO;
        editable[key] = v;
      }

      if (!active) return;
      setDefs(defsByKey);
      setValues(valuesByKey);
      // On a post-save refresh the user may have started typing again — keep those in-progress edits and
      // don't clobber them; adopt fresh server values as the new baseline for everything else.
      const priorEdits = editsRef.current || {};
      const priorBaseline = baselineRef.current || {};
      const merged = {};
      for (const key of Object.keys(editable)) {
        const userDirty = (priorEdits[key] ?? "").trim() !== (priorBaseline[key] ?? "").trim();
        merged[key] = userDirty ? priorEdits[key] : editable[key];
      }
      setEdits(merged);
      baselineRef.current = { ...editable };
      editsRef.current = { ...merged };
      setNotice(warnings.join(" • "));
    }

    load();
    return () => {
      active = false;
    };
  }, [ownerId, refreshTick]);

  function setField(key, value) {
    editsRef.current = { ...editsRef.current, [key]: value };
    setSaved(false);
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  function changedKeys() {
    const baseline = baselineRef.current;
    return Object.keys(editsRef.current).filter(
      (key) => (editsRef.current[key] ?? "").trim() !== (baseline[key] ?? "").trim(),
    );
  }

  const dirty = changedKeys().length > 0;

  async function save() {
    if (!ownerId) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const toSet = [];
      const toDelete = [];
      const missing = [];
      const changed = changedKeys();

      for (const key of changed) {
        const def = defs[key];
        if (!def?.namespace || !def?.type) {
          missing.push(key);
          continue;
        }
        const value = (editsRef.current[key] ?? "").trim();
        if (value === "") {
          toDelete.push({ ownerId, namespace: def.namespace, key });
        } else {
          toSet.push({ ownerId, namespace: def.namespace, key, type: def.type, value });
        }
      }

      if (missing.length) {
        throw new Error(`No metafield definition found for: ${missing.join(", ")}. Create the definition first.`);
      }
      if (toSet.length) {
        const res = await shopify.query(SET_MUTATION, { variables: { metafields: toSet } });
        const errs = collectErrors(res, "metafieldsSet");
        if (errs.length) throw new Error(errs.join("; "));
      }
      if (toDelete.length) {
        const res = await shopify.query(DELETE_MUTATION, { variables: { metafields: toDelete } });
        const errs = collectErrors(res, "metafieldsDelete");
        if (errs.length) throw new Error(errs.join("; "));
      }

      // A metafield save never fires the resource webhook, so the middleware won't recompute on its own.
      // Add trigger tags for what actually changed: `reprice` re-runs the price calc (gold rate × weight,
      // discount, GST); `sync-payment` recomputes net-to-collect + balance. Best-effort (non-blocking).
      const triggerTags = [];
      if (changed.some((k) => REPRICE_TRIGGER_KEYS.includes(k))) triggerTags.push("reprice");
      if (changed.some((k) => RECOMPUTE_TRIGGER_KEYS.includes(k))) triggerTags.push("sync-payment");
      if (triggerTags.length) {
        try {
          await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: triggerTags } });
        } catch { /* non-blocking */ }
      }

      const nextValues = { ...values };
      for (const key of Object.keys(editsRef.current)) nextValues[key] = editsRef.current[key];
      baselineRef.current = { ...editsRef.current };
      setValues(nextValues);
      setSaved(true);

      // The recompute happens server-side after the trigger tag fires. Re-pull values shortly after so the
      // computed read-only fields (Amount To Be Collected, Amount Pending, Payment Status, prices) refresh
      // instead of looking frozen. Non-editable values only — in-progress edits are preserved by the loader.
      if (triggerTags.length) {
        setRecalcNote("Recalculating balance & pricing… values refresh in a moment.");
        setTimeout(() => { setRefreshTick((t) => t + 1); setRecalcNote(""); }, 2500);
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  // Apply a voucher: staff type the code, we drop an `apply-voucher:<code>` tag. The middleware looks up
  // the value + validity in the ledger, applies it post-tax, cancels the online code, and (on failure)
  // leaves a `voucher-invalid:<reason>` tag. Staff never type an amount.
  async function applyVoucher() {
    const code = voucherCode.trim();
    if (!ownerId || !code) return;
    setVoucherBusy(true);
    setVoucherNote("");
    try {
      const res = await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: [`apply-voucher:${code}`] } });
      const errs = collectErrors(res, "tagsAdd");
      if (errs.length) throw new Error(errs.join("; "));
      setVoucherCode("");
      setVoucherNote(`Applying ${code}… the balance updates in a few seconds. If it's invalid, a "voucher-invalid" tag will appear with the reason.`);
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setVoucherNote(`Couldn't apply: ${e?.message || e}`);
    } finally {
      setVoucherBusy(false);
    }
  }

  // Apply/reference an exchange note by its number: staff type the code, we drop an `apply-exc:<number>`
  // tag. The middleware looks up the value + validity in the ledger, applies it post-tax, and (on failure)
  // leaves an `exc-invalid:<reason>` tag. Staff never type an amount (the Exchange Note Value field is a
  // manual override for notes not in the ledger). Mirrors applyVoucher.
  async function applyExc() {
    const code = excCode.trim();
    if (!ownerId || !code) return;
    setExcBusy(true);
    setExcNote("");
    try {
      const res = await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: [`apply-exc:${code}`] } });
      const errs = collectErrors(res, "tagsAdd");
      if (errs.length) throw new Error(errs.join("; "));
      setExcCode("");
      setExcNote(`Applying ${code}… the balance updates in a few seconds. If it's invalid, an "exc-invalid" tag will appear with the reason.`);
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setExcNote(`Couldn't apply: ${e?.message || e}`);
    } finally {
      setExcBusy(false);
    }
  }

  const renderExcApply = () => (
    <s-section heading="Apply an Exchange Note">
      <s-stack direction="block" gap="base">
        <s-text tone="subdued">
          Type the exchange-note number (e.g. EXC27-KAHSR-0001). The system verifies it's valid and unused
          in the ledger and applies it after tax. You never enter the amount here. For a note that isn't in
          the ledger, use the Exchange Note Value field below to override manually.
        </s-text>
        <s-text-field
          label="Exchange Note Number"
          value={excCode}
          disabled={excBusy ? "" : undefined}
          onChange={(e) => setExcCode(e.target.value ?? "")}
        />
        <s-button
          onClick={applyExc}
          loading={excBusy ? "" : undefined}
          disabled={!excCode.trim() || excBusy ? "" : undefined}
        >
          Apply Exchange Note
        </s-button>
        {excNote ? <s-text>{excNote}</s-text> : null}
      </s-stack>
    </s-section>
  );

  const renderVoucherApply = () => (
    <s-section heading="Apply a Voucher">
      <s-stack direction="block" gap="base">
        <s-text tone="subdued">
          Type the voucher code (e.g. VCH27-KAHSR-0001). The system verifies it's valid and unused, applies
          it after tax, and cancels its online code. You never enter the amount.
        </s-text>
        <s-text-field
          label="Voucher Code"
          value={voucherCode}
          disabled={voucherBusy ? "" : undefined}
          onChange={(e) => setVoucherCode(e.target.value ?? "")}
        />
        <s-button
          onClick={applyVoucher}
          loading={voucherBusy ? "" : undefined}
          disabled={!voucherCode.trim() || voucherBusy ? "" : undefined}
        >
          Apply Voucher
        </s-button>
        {voucherNote ? <s-text>{voucherNote}</s-text> : null}
      </s-stack>
    </s-section>
  );

  const sections = buildSections(ctx.scope);

  // Rendered fresh in each location (inline card + modal) so vnodes aren't shared.
  const renderBanners = () => (
    <>
      {error ? (
        <s-banner tone="critical" heading="Couldn't save">
          {error}
        </s-banner>
      ) : null}
      {saved ? (
        <s-banner tone="success" heading="Saved" dismissible>
          Metafields updated.
        </s-banner>
      ) : null}
      {notice ? (
        <s-banner tone="warning" heading="Some data may be incomplete" dismissible>
          {notice}
        </s-banner>
      ) : null}
      {recalcNote ? (
        <s-banner tone="info" heading="Recalculating">
          {recalcNote}
        </s-banner>
      ) : null}
    </>
  );

  const renderSections = () =>
    sections.map((section) => (
      <s-section key={section.title} heading={section.title}>
        <s-stack direction="block" gap="base">
          {section.fields.map((field) =>
            field.editable
              ? renderEditable(field, defs[field.key]?.type || "", defs[field.key]?.choices, edits[field.key] ?? "", setField, saving)
              : renderReadOnly(field, values[field.key] ?? ""),
          )}
        </s-stack>
      </s-section>
    ));

  const renderSaveButton = () => (
    <s-button
      variant="primary"
      onClick={save}
      loading={saving ? "" : undefined}
      disabled={!dirty || saving ? "" : undefined}
    >
      Save
    </s-button>
  );

  // Action surface: the roomy all-fields overlay opened from the block (or from
  // "More actions"). No height cap here — every field is shown with room.
  if (surface === "action") {
    return (
      <s-admin-action heading="Jewellery Workspace — all fields">
        <s-stack direction="block" gap="large-100">
          {renderBanners()}
          {renderVoucherApply()}
          {renderExcApply()}
          {renderSections()}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={save}
          loading={saving ? "" : undefined}
          disabled={!dirty || saving ? "" : undefined}
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" onClick={() => shopify.close?.()}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  // Block on the order/draft page. "Show all fields" opens the matching action
  // extension — the full-height panel that shows every field, bypassing the
  // block's height cap (which limits the inline list to ~7-8 fields).
  const showAllFields = () => {
    const handle = ACTION_HANDLE[ctx.scope];
    if (handle) shopify.navigation?.navigate(`extension://${handle}`);
  };

  return (
    <s-admin-block heading="Jewellery Workspace">
      <s-stack direction="block" gap="large-100">
        {renderBanners()}
        <s-button onClick={showAllFields}>Show all fields</s-button>
        {renderSections()}
        <s-stack direction="inline" gap="base" alignItems="center">
          {renderSaveButton()}
          {dirty ? <s-text>Unsaved changes</s-text> : null}
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}

function renderReadOnly(field, value) {
  return (
    <s-stack key={field.key} direction="block" gap="small-500">
      <s-text>{field.label}</s-text>
      <s-text tone="subdued">{value === "" ? "—" : value}</s-text>
    </s-stack>
  );
}

function renderEditable(field, type, choices, value, setField, saving) {
  const disabled = saving ? "" : undefined;
  const onChange = (e) => setField(field.key, e.target.value ?? "");
  // Required staff inputs get an asterisk so the compulsory fields read clearly.
  const label = field.required ? `${field.label} *` : field.label;

  // Definition-driven choice list (e.g. order_type, channel, payment_status)
  // takes precedence over the type-based widget so staff get a dropdown.
  if (Array.isArray(choices) && choices.length) {
    return (
      <s-select key={field.key} label={label} value={value} disabled={disabled} onChange={onChange}>
        <s-option value="">—</s-option>
        {choices.map((c) => (
          <s-option key={c} value={c}>
            {c}
          </s-option>
        ))}
      </s-select>
    );
  }

  if (type === "boolean") {
    return (
      <s-select key={field.key} label={label} value={value} disabled={disabled} onChange={onChange}>
        <s-option value="">—</s-option>
        <s-option value="true">Yes</s-option>
        <s-option value="false">No</s-option>
      </s-select>
    );
  }
  if (type === "date" || type === "date_time") {
    return <s-date-field key={field.key} label={label} value={value} disabled={disabled} onChange={onChange} />;
  }
  if (type.startsWith("number_") || type === "money" || type === "dimension" || type === "weight" || type === "volume") {
    return <s-number-field key={field.key} label={label} value={value} disabled={disabled} onChange={onChange} />;
  }
  if (type === "multi_line_text_field" || type === "json" || type.startsWith("list.")) {
    return <s-text-area key={field.key} label={label} value={value} disabled={disabled} onChange={onChange} />;
  }
  return <s-text-field key={field.key} label={label} value={value} disabled={disabled} onChange={onChange} />;
}
