import { useEffect, useRef, useState } from "preact/hooks";

/**
 * Shared workflow-metafield manager rendered by both the Draft Order and Order
 * block targets.
 *
 * CONVENTION-DRIVEN (Model B): the block discovers fields from your live
 * metafield definitions, so new fields — or fields extended from draft to order
 * — appear automatically with NO code change or redeploy. The three grouping
 * rules are resolved like this:
 *
 *   - applies  → the definition's ownerType (we query DRAFTORDER vs ORDER).
 *   - editable → the definition's access.admin (MERCHANT_READ_WRITE = staff can
 *                edit; anything else renders read-only). Matches the intake vs
 *                custom namespace ownership split.
 *   - section  → parsed from the definition's `description` using the convention
 *                `section:<Name>` (e.g. "section:Payments"). Falls back to the
 *                committed governance map (GOVERNANCE) below, then "Other".
 *
 * GOVERNANCE mirrors metafield_governance.csv and is used only as a fallback
 * label/section/editable source for fields whose definitions don't yet carry
 * the convention metadata. It is the safety net, not the source of truth.
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

// Fallback metadata (mirrors metafield_governance.csv). section/label/editable.
const GOVERNANCE = {
  order_type: { section: "Order Details", label: "Order Type", editable: true },
  channel: { section: "Order Details", label: "Channel", editable: true },
  payment_status: { section: "Payments", label: "Payment Status", editable: true },
  payment_mode_advance: { section: "Payments", label: "Advance Payment Mode", editable: true },
  payment_mode_final: { section: "Payments", label: "Final Payment Mode", editable: true },
  amount_paid: { section: "Payments", label: "Amount Paid", editable: true },
  amount_pending: { section: "Payments", label: "Amount Pending", editable: true },
  amount_to_be_collected: { section: "Payments", label: "Amount To Be Collected", editable: false },
  gold_rate: { section: "Pricing", label: "Gold Rate", editable: true },
  gold_rate_date: { section: "Pricing", label: "Gold Rate Date", editable: true },
  old_gold_weight: { section: "Exchange", label: "Old Gold Weight", editable: true },
  old_gold_value: { section: "Exchange", label: "Old Gold Value", editable: true },
  old_gold_purity: { section: "Exchange", label: "Old Gold Purity (karat)", editable: true },
  exchange_note_value: { section: "Exchange", label: "Exchange Note Value", editable: false },
  voucher_value: { section: "Exchange", label: "Voucher Value", editable: false },
  cn_number: { section: "Credit Note", label: "Credit Note Number", editable: false },
  cn_value: { section: "Credit Note", label: "Credit Note Value", editable: false },
  cn_issued_date: { section: "Credit Note", label: "Credit Note Issued", editable: false },
  cn_expiry: { section: "Credit Note", label: "Credit Note Expiry", editable: false },
  jewelcode: { section: "Product Metadata", label: "Jewelcode (JSON)", editable: false },
  jewel_code: { section: "Product Metadata", label: "Jewel Code", editable: false },
  sku_id: { section: "Product Metadata", label: "SKU ID", editable: false },
  jewelcode_gross_weight: { section: "Product Metadata", label: "Gross Weight", editable: true },
  jewelcode_net_weight: { section: "Product Metadata", label: "Net Weight", editable: true },
  jewelcode_diamond_carats: { section: "Product Metadata", label: "Diamond Carats", editable: true },
  jewelcode_diamond_pieces: { section: "Product Metadata", label: "Diamond Pieces", editable: true },
  jewelcode_gemstone_weight: { section: "Product Metadata", label: "Gemstone Weight", editable: true },
  gross_wt: { section: "Product Metadata", label: "Gross Weight (legacy)", editable: false },
  net_wt: { section: "Product Metadata", label: "Net Weight (legacy)", editable: false },
  diamond_cts: { section: "Product Metadata", label: "Diamond Carats (legacy)", editable: false },
  po_status: { section: "Procurement", label: "PO Status", editable: false },
  po_type: { section: "Procurement", label: "PO Type", editable: false },
  po_routing: { section: "Procurement", label: "PO Routing (JSON)", editable: false },
  batch_id: { section: "Procurement", label: "PO Batch ID", editable: false },
  batch_date: { section: "Procurement", label: "PO Batch Date", editable: false },
  delivery_code: { section: "Procurement", label: "Delivery / Store Code", editable: true },
  replenishment_comments: { section: "Procurement", label: "Replenishment Notes", editable: true },
  po_replenishment_variants: { section: "Procurement", label: "Replenishment Variants", editable: true },
  po_mto_variants: { section: "Procurement", label: "MTO Variants", editable: true },
  repair_order_reference: { section: "Repair", label: "Linked Repair Order", editable: true },
  repair_intake_at: { section: "Repair", label: "Repair Intake At", editable: false },
  repair_estimate_sent_at: { section: "Repair", label: "Estimate Sent At", editable: false },
  repair_completed_at: { section: "Repair", label: "Repair Completed At", editable: false },
  repair_store_pickup: { section: "Repair", label: "Store Pickup", editable: true },
  mto_comments: { section: "Manufacturing", label: "Manufacturing Notes", editable: true },
  mto_comment: { section: "Manufacturing", label: "Manufacturing Note", editable: true },
  state_code: { section: "System", label: "Store / State Code", editable: true },
  invoice_date: { section: "System", label: "Invoice Date", editable: true },
  is_finalized: { section: "System", label: "Finalized", editable: true },
  order_name: { section: "System", label: "Linked Order Name", editable: false },
  source_order_id: { section: "System", label: "Source Order ID", editable: false },
  document_type: { section: "System", label: "Document Type", editable: false },
  serial_no: { section: "System", label: "Serial No", editable: false },
  serial_code: { section: "System", label: "Serial Code", editable: false },
  serial_display: { section: "System", label: "Display Serial", editable: false },
  serial_state: { section: "System", label: "Serial State", editable: false },
  action_token: { section: "System", label: "Action Token", editable: false },
};

/** Resolve the resource context from the selected GID. */
function resolveContext() {
  const id = shopify.data?.selected?.[0]?.id || "";
  const isOrder = id.includes("/Order/");
  return {
    id,
    ownerType: isOrder ? "ORDER" : "DRAFTORDER",
    resourceField: isOrder ? "order" : "draftOrder",
  };
}

function buildDefinitionsQuery(ownerType) {
  return `
    query WorkflowMetafieldDefinitions {
      metafieldDefinitions(first: 250, ownerType: ${ownerType}) {
        nodes {
          namespace
          key
          name
          description
          type { name }
          access { admin }
        }
      }
    }
  `;
}

function buildValuesQuery(resourceField) {
  return `
    query WorkflowMetafields($id: ID!) {
      ${resourceField}(id: $id) {
        id
        metafields(first: 250) {
          nodes { namespace key value type }
        }
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

/** Parse `section:<Name>` out of a definition description. */
function parseSection(description) {
  if (!description) return null;
  const m = description.match(/section\s*[:=]\s*([^;|\n]+)/i);
  return m ? m[1].trim() : null;
}

/** MERCHANT_READ_WRITE = staff-editable; anything else is read-only. */
function accessIsEditable(admin) {
  if (admin === "MERCHANT_READ_WRITE") return true;
  if (admin === "MERCHANT_READ" || admin === "PRIVATE") return false;
  return null; // unknown — let the caller fall back to governance
}

/** Human label from a metafield key, e.g. "old_gold_purity" -> "Old Gold Purity". */
function prettify(key) {
  return key
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build the field descriptors to render. Definition-driven, with the committed
 * governance map as a fallback, plus any known legacy metafields that have a
 * value but no definition.
 */
function buildFields(defNodes, valuesByKey) {
  const fields = {};

  for (const d of defNodes) {
    const gov = GOVERNANCE[d.key];
    const accessEditable = accessIsEditable(d.access?.admin);
    fields[d.key] = {
      key: d.key,
      namespace: d.namespace,
      type: d.type?.name || "",
      label: d.name || gov?.label || prettify(d.key),
      section: parseSection(d.description) || gov?.section || "Other",
      editable: accessEditable === null ? Boolean(gov?.editable) : accessEditable,
    };
  }

  // Surface known legacy fields that have a value but no definition (read-only).
  for (const key of Object.keys(valuesByKey)) {
    if (fields[key]) continue;
    const gov = GOVERNANCE[key];
    if (!gov) continue;
    fields[key] = {
      key,
      namespace: undefined,
      type: undefined,
      label: gov.label,
      section: gov.section,
      editable: false,
    };
  }

  return fields;
}

function buildSections(fields) {
  const bySection = {};
  for (const key of Object.keys(fields)) {
    const f = fields[key];
    (bySection[f.section] ||= []).push(f);
  }

  const known = SECTION_ORDER.filter((title) => bySection[title]?.length);
  const extras = Object.keys(bySection)
    .filter((title) => !SECTION_ORDER.includes(title) && title !== "Other")
    .sort();
  const ordered = [...known, ...extras];
  if (bySection["Other"]?.length) ordered.push("Other");

  return ordered.map((title) => ({ title, fields: bySection[title] }));
}

export default function MetafieldManager() {
  const ctx = resolveContext();
  const ownerId = ctx.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [fields, setFields] = useState({}); // key -> descriptor
  const [values, setValues] = useState({}); // key -> stored value
  const [edits, setEdits] = useState({}); // editable key -> current value
  const baselineRef = useRef({});
  const editsRef = useRef({});

  useEffect(() => {
    let active = true;

    async function load() {
      if (!ownerId) {
        setError("No resource is in context.");
        setLoading(false);
        return;
      }
      try {
        const [defRes, valRes] = await Promise.all([
          shopify.query(buildDefinitionsQuery(ctx.ownerType)),
          shopify.query(buildValuesQuery(ctx.resourceField), { variables: { id: ownerId } }),
        ]);

        const queryErrors = [
          ...(defRes?.errors ?? []).map((e) => e.message),
          ...(valRes?.errors ?? []).map((e) => e.message),
        ];
        if (queryErrors.length) throw new Error(queryErrors.join("; "));

        const defNodes = defRes?.data?.metafieldDefinitions?.nodes ?? [];
        const valuesByKey = {};
        for (const n of valRes?.data?.[ctx.resourceField]?.metafields?.nodes ?? []) {
          valuesByKey[n.key] = n.value ?? "";
        }

        const fieldMap = buildFields(defNodes, valuesByKey);

        const editable = {};
        for (const key of Object.keys(fieldMap)) {
          if (fieldMap[key].editable) editable[key] = valuesByKey[key] ?? "";
        }

        if (!active) return;
        setFields(fieldMap);
        setValues(valuesByKey);
        setEdits(editable);
        baselineRef.current = { ...editable };
        editsRef.current = { ...editable };
      } catch (e) {
        if (active) setError(e?.message || String(e));
      } finally {
        if (active) setLoading(false);
      }
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

      for (const key of changedKeys()) {
        const field = fields[key];
        if (!field?.namespace || !field?.type) {
          throw new Error(`Missing metafield definition for "${key}"; cannot save.`);
        }
        const value = (editsRef.current[key] ?? "").trim();
        if (value === "") {
          toDelete.push({ ownerId, namespace: field.namespace, key });
        } else {
          toSet.push({ ownerId, namespace: field.namespace, key, type: field.type, value });
        }
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

  if (loading) {
    return (
      <s-admin-block heading="Jewellery Workspace">
        <s-stack direction="inline" gap="base">
          <s-spinner accessibilityLabel="Loading metafields" />
          <s-text>Loading metafields…</s-text>
        </s-stack>
      </s-admin-block>
    );
  }

  const sections = buildSections(fields);

  return (
    <s-admin-block heading="Jewellery Workspace">
      <s-stack direction="block" gap="large-100">
        {error ? (
          <s-banner tone="critical" heading="Couldn't complete the request">
            {error}
          </s-banner>
        ) : null}
        {saved ? (
          <s-banner tone="success" heading="Saved" dismissible>
            Metafields updated.
          </s-banner>
        ) : null}
        {sections.length === 0 ? (
          <s-text tone="subdued">No workflow metafields found for this resource.</s-text>
        ) : null}

        {sections.map((section) => (
          <s-section key={section.title} heading={section.title}>
            <s-stack direction="block" gap="base">
              {section.fields.map((field) =>
                field.editable
                  ? renderEditable(field, edits[field.key] ?? "", setField, saving)
                  : renderReadOnly(field, values[field.key] ?? ""),
              )}
            </s-stack>
          </s-section>
        ))}

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="primary"
            onClick={save}
            loading={saving ? "" : undefined}
            disabled={!dirty || saving ? "" : undefined}
          >
            Save
          </s-button>
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

function renderEditable(field, value, setField, saving) {
  const type = field.type || "";
  const disabled = saving ? "" : undefined;
  const onChange = (e) => setField(field.key, e.target.value ?? "");

  if (type === "boolean") {
    return (
      <s-select key={field.key} label={field.label} value={value} disabled={disabled} onChange={onChange}>
        <s-option value="">—</s-option>
        <s-option value="true">Yes</s-option>
        <s-option value="false">No</s-option>
      </s-select>
    );
  }

  if (type === "date" || type === "date_time") {
    return <s-date-field key={field.key} label={field.label} value={value} disabled={disabled} onChange={onChange} />;
  }

  if (
    type.startsWith("number_") ||
    type === "money" ||
    type === "dimension" ||
    type === "weight" ||
    type === "volume"
  ) {
    return <s-number-field key={field.key} label={field.label} value={value} disabled={disabled} onChange={onChange} />;
  }

  if (type === "multi_line_text_field" || type === "json" || type.startsWith("list.")) {
    return <s-text-area key={field.key} label={field.label} value={value} disabled={disabled} onChange={onChange} />;
  }

  return <s-text-field key={field.key} label={field.label} value={value} disabled={disabled} onChange={onChange} />;
}
