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
const SECTION_ORDER = [
  "Order Details",
  "Payments",
  "Pricing",
  "Exchange",
  "Credit Note",
  "Product Metadata",
  "Procurement",
  "Repair",
  "Manufacturing",
  "System",
];

// Compulsory staff inputs, in the priority order they must be filled. These are
// promoted into a single "Required Inputs" section at the top of the block,
// ahead of (and removed from) their topical sections below. Ordering here is
// the source of truth for the required tier — editability still comes from
// FIELD_CONFIG.
const REQUIRED_FIELDS = [
  "order_type",
  "channel",
  "payment_status",
  "payment_mode_advance",
  "amount_paid",
];
const REQUIRED_SET = new Set(REQUIRED_FIELDS);
const REQUIRED_SECTION = "Required Inputs";

const FIELD_CONFIG = {
  order_type: { section: "Order Details", label: "Order Type", editable: true, applies: "both" },
  channel: { section: "Order Details", label: "Channel", editable: true, applies: "both" },

  payment_status: { section: "Payments", label: "Payment Status", editable: true, applies: "both" },
  payment_mode_advance: { section: "Payments", label: "Advance Payment Mode", editable: true, applies: "both" },
  payment_mode_final: { section: "Payments", label: "Final Payment Mode", editable: true, applies: "both" },
  amount_paid: { section: "Payments", label: "Amount Paid", editable: true, applies: "both" },
  amount_pending: { section: "Payments", label: "Amount Pending", editable: true, applies: "both" },
  amount_to_be_collected: { section: "Payments", label: "Amount To Be Collected", editable: false, applies: "both" },

  gold_rate: { section: "Pricing", label: "Gold Rate", editable: true, applies: "both" },
  gold_rate_date: { section: "Pricing", label: "Gold Rate Date", editable: true, applies: "both" },

  old_gold_weight: { section: "Exchange", label: "Old Gold Weight", editable: true, applies: "both" },
  old_gold_value: { section: "Exchange", label: "Old Gold Value", editable: true, applies: "both" },
  old_gold_purity: { section: "Exchange", label: "Old Gold Purity (karat)", editable: true, applies: "draft" },
  exchange_note_value: { section: "Exchange", label: "Exchange Note Value", editable: false, applies: "both" },
  voucher_value: { section: "Exchange", label: "Voucher Value", editable: false, applies: "draft" },

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

  po_status: { section: "Procurement", label: "PO Status", editable: false, applies: "draft" },
  po_type: { section: "Procurement", label: "PO Type", editable: false, applies: "draft" },
  po_routing: { section: "Procurement", label: "PO Routing (JSON)", editable: false, applies: "both" },
  batch_id: { section: "Procurement", label: "PO Batch ID", editable: false, applies: "draft" },
  batch_date: { section: "Procurement", label: "PO Batch Date", editable: false, applies: "draft" },
  delivery_code: { section: "Procurement", label: "Delivery / Store Code", editable: true, applies: "draft" },
  replenishment_comments: { section: "Procurement", label: "Replenishment Notes", editable: true, applies: "both" },
  po_replenishment_variants: { section: "Procurement", label: "Replenishment Variants", editable: true, applies: "order" },
  po_mto_variants: { section: "Procurement", label: "MTO Variants", editable: true, applies: "order" },

  repair_order_reference: { section: "Repair", label: "Linked Repair Order", editable: true, applies: "draft" },
  repair_intake_at: { section: "Repair", label: "Repair Intake At", editable: false, applies: "draft" },
  repair_estimate_sent_at: { section: "Repair", label: "Estimate Sent At", editable: false, applies: "draft" },
  repair_completed_at: { section: "Repair", label: "Repair Completed At", editable: false, applies: "draft" },
  repair_store_pickup: { section: "Repair", label: "Store Pickup", editable: false, applies: "draft" },

  mto_comments: { section: "Manufacturing", label: "Manufacturing Notes", editable: true, applies: "order" },
  mto_comment: { section: "Manufacturing", label: "Manufacturing Note", editable: true, applies: "draft" },

  state_code: { section: "System", label: "Store / State Code", editable: true, applies: "both" },
  invoice_date: { section: "System", label: "Invoice Date", editable: true, applies: "both" },
  is_finalized: { section: "System", label: "Finalized", editable: true, applies: "both" },
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

  // Required staff inputs → single top section, in REQUIRED_FIELDS priority order.
  const requiredFields = REQUIRED_FIELDS.filter((key) => inScopeSet.has(key)).map((key) => ({
    key,
    label: FIELD_CONFIG[key].label,
    editable: FIELD_CONFIG[key].editable,
    required: true,
  }));

  // Everything else stays in its topical section (required keys are removed here
  // since they've been promoted above).
  const bySection = {};
  for (const key of inScope) {
    if (REQUIRED_SET.has(key)) continue;
    const cfg = FIELD_CONFIG[key];
    (bySection[cfg.section] ||= []).push({ key, label: cfg.label, editable: cfg.editable });
  }
  const topical = SECTION_ORDER.filter((title) => bySection[title]?.length).map((title) => ({
    title,
    fields: bySection[title],
  }));

  const sections = [];
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

function collectErrors(result, mutationField) {
  const errs = (result?.errors ?? []).map((e) => e.message);
  for (const e of result?.data?.[mutationField]?.userErrors ?? []) {
    const where = Array.isArray(e.field) ? e.field.join(".") : e.field;
    errs.push(where ? `${where}: ${e.message}` : e.message);
  }
  return errs;
}

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

      const editable = {};
      for (const key of fieldsForScope(ctx.scope)) {
        if (FIELD_CONFIG[key].editable) editable[key] = valuesByKey[key] ?? "";
      }

      if (!active) return;
      setDefs(defsByKey);
      setValues(valuesByKey);
      setEdits(editable);
      baselineRef.current = { ...editable };
      editsRef.current = { ...editable };
      setNotice(warnings.join(" • "));
    }

    load();
    return () => {
      active = false;
    };
  }, [ownerId]);

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

      for (const key of changedKeys()) {
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

      const nextValues = { ...values };
      for (const key of Object.keys(editsRef.current)) nextValues[key] = editsRef.current[key];
      baselineRef.current = { ...editsRef.current };
      setValues(nextValues);
      setSaved(true);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

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

  // Block on the order/draft page: inline card with the fields (reorder +
  // dropdowns). The roomy all-fields view stays exactly where v8 put it — the
  // "More actions" menu, served by the untouched action extensions.
  return (
    <s-admin-block heading="Jewellery Workspace">
      <s-stack direction="block" gap="large-100">
        {renderBanners()}
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
