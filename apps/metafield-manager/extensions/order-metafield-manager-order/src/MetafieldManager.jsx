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
 *   - required: display only (adds an asterisk); does NOT promote the field out
 *               of its section, unlike membership of REQUIRED_FIELDS
 *
 * Mirrors middleware metafield_governance.csv. Namespace/type are never
 * hardcoded — they come from the live definitions at save time.
 */
// Founder flow: identity header (top, read-only) → Required Inputs → Installments → Payments →
// Pricing (incl. discounts) → Product Metadata → Adjustments (selector + values) →
// Repair → Credit Note → System. "Order Details" is gone (its fields are Required),
// "Exchange" was always dead, "Procurement" and "Manufacturing" PO/notes fields removed.
// A section named in FIELD_CONFIG but absent from this list renders nothing — that is how the
// unused fields are hidden while keeping their config as documentation.
//
// Installments sits FIRST so the payment table reads as one block. Leg 1 is marked required in
// FIELD_CONFIG rather than promoted into Required Inputs, which would split it from legs 2-4.
const SECTION_ORDER = [
  "Installments",
  "Payments",
  "Pricing",
  "Product Metadata",
  "Adjustments",
  "Repair",
  "Credit Note",
  "System",
];

// Compulsory staff inputs, in the priority order they must be filled. These are
// promoted into a single "Required Inputs" section at the top of the block,
// ahead of (and removed from) their topical sections below. Ordering here is
// the source of truth for the required tier — editability still comes from
// FIELD_CONFIG.
// Staff-fill only. payment_status / amount_pending were removed — they are now SYSTEM-computed
// (net-based) and shown read-only, so staff can't hand-type a wrong balance.
// The first payment used to live here as payment_mode_advance + amount_paid. It now lives in the
// Installments section as leg 1, flagged `required` in FIELD_CONFIG so it still gets the asterisk
// without being torn out of the table.
const REQUIRED_FIELDS = [
  "order_type",
  "channel",
  "state_code",
  "employee_name",
];
// Label on the blank entry of every choice dropdown. It is also the sentinel we normalise back to
// "" — see renderEditable and save(). Never let this string reach Shopify: it is not a valid
// choice, so a definition with a `choices` validation rejects the whole save.
const BLANK_CHOICE_LABEL = "—";

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
  employee_name: { section: "Order Details", label: "Sales Staff", editable: true, applies: "both" },

  // Payments are captured as up to 4 INSTALLMENTS, each with its own value, mode and date. Enter
  // each collection in its own leg — never re-type a running total, and never skip a slot. The
  // middleware sums the legs into amount_paid and derives the balance from there.
  //
  // The date is stamped by the middleware when a gateway or cash payment lands, and is editable so
  // a payment recorded days late can be corrected — it prints on the customer's tax invoice.
  installment_1_value: { section: "Installments", label: "1 · Amount", editable: true, applies: "both", required: true },
  installment_1_mode: { section: "Installments", label: "1 · Mode", editable: true, applies: "both", required: true },
  installment_1_date: { section: "Installments", label: "1 · Date", editable: true, applies: "both" },
  // Set to cad_advance by the middleware when leg 1 is a CAD design advance. That leg then shows on
  // the invoice as "Design Advance" and is EXCLUDED from amount_paid — custom.advance already
  // reduces the amount to be collected, so counting it again would deduct it twice.
  installment_1_type: { section: "Installments", label: "1 · Type (system)", editable: false, applies: "both" },
  installment_2_value: { section: "Installments", label: "2 · Amount", editable: true, applies: "both" },
  installment_2_mode: { section: "Installments", label: "2 · Mode", editable: true, applies: "both" },
  installment_2_date: { section: "Installments", label: "2 · Date", editable: true, applies: "both" },
  installment_3_value: { section: "Installments", label: "3 · Amount", editable: true, applies: "both" },
  installment_3_mode: { section: "Installments", label: "3 · Mode", editable: true, applies: "both" },
  installment_3_date: { section: "Installments", label: "3 · Date", editable: true, applies: "both" },
  installment_4_value: { section: "Installments", label: "4 · Amount", editable: true, applies: "both" },
  installment_4_mode: { section: "Installments", label: "4 · Mode", editable: true, applies: "both" },
  installment_4_date: { section: "Installments", label: "4 · Date", editable: true, applies: "both" },

  // All system-computed (net-based) — read-only so staff never hand-type a balance.
  // amount_paid is the SUM of the installment legs above, recomputed server-side on every save.
  payment_status: { section: "Payments", label: "Payment Status", editable: false, applies: "both" },
  amount_paid: { section: "Payments", label: "Total Received", editable: false, applies: "both" },
  amount_pending: { section: "Payments", label: "Amount Pending", editable: false, applies: "both" },
  amount_to_be_collected: { section: "Payments", label: "Amount To Be Collected", editable: false, applies: "both" },

  gold_rate: { section: "Pricing", label: "Gold Rate", editable: true, applies: "both" },
  gold_rate_date: { section: "Pricing", label: "Gold Rate Date", editable: true, applies: "both" },
  // Flat labour in Rs, positional per product ("1900,2500") — same CSV convention as gold_rate, hence
  // single_line_text. Blank = use the variant design spec. Labour never scales with weight.
  making: { section: "Pricing", label: "Making / Labour (flat Rs, per product)", editable: true, applies: "both" },
  gross_value: { section: "Pricing", label: "Gross Value (pre-discount)", editable: false, applies: "both" },
  discount_applied: { section: "Pricing", label: "Discount Applied (pre-tax)", editable: false, applies: "both" },

  // Adjustments — old gold (staff enter weight+purity, system values it), exchange/voucher (system),
  // and CAD design advance. advance_ref is the one staff-fill here (redeem a past advance, Path B).
  old_gold_weight: { section: "Adjustments", label: "Old Gold Weight (g)", editable: true, applies: "both" },
  old_gold_purity: { section: "Adjustments", label: "Old Gold Purity (karat)", editable: true, applies: "draft" },
  old_gold_value: { section: "Adjustments", label: "Old Gold Value (auto; override optional)", editable: true, applies: "both" },
  // The *_code fields identify WHICH instrument was applied — the value alone can't. Written by the
  // server on apply and cleared on void/strip, so they are read-only here: editing the code without
  // moving the ledger row would make the draft claim an instrument it does not hold.
  exchange_note_code: { section: "Adjustments", label: "Exchange Note Applied", editable: false, applies: "both" },
  exchange_note_value: { section: "Adjustments", label: "Exchange Note Value (auto from Apply; override optional)", editable: true, applies: "both" },
  voucher_code: { section: "Adjustments", label: "Voucher Applied", editable: false, applies: "both" },
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
  // "Manufacturing" is now unlisted too — replenishment notes, MTO notes and the PO variant lists
  // were never used from this panel. delivery_code was the one live field in it and has moved to
  // System, next to state_code: it exists only to print the delivery challan raised off a draft via
  // make-memo-custom, which is not enough to justify a section of its own.
  // left in the now-unlisted "Procurement" section so they no longer render in this panel
  // (redundant here; still set/used server-side and in PO-ops). The EDITABLE staff inputs
  // below are relocated to "Manufacturing" so they survive.
  po_status: { section: "Procurement", label: "PO Status", editable: false, applies: "draft" },
  po_type: { section: "Procurement", label: "PO Type", editable: false, applies: "draft" },
  po_routing: { section: "Procurement", label: "PO Routing (JSON)", editable: false, applies: "both" },
  batch_id: { section: "Procurement", label: "PO Batch ID", editable: false, applies: "draft" },
  batch_date: { section: "Procurement", label: "PO Batch Date", editable: false, applies: "draft" },
  replenishment_comments: { section: "Procurement", label: "Replenishment Notes", editable: true, applies: "both" },
  po_replenishment_variants: { section: "Procurement", label: "Replenishment Variants", editable: true, applies: "order" },
  po_mto_variants: { section: "Procurement", label: "MTO Variants", editable: true, applies: "order" },

  repair_order_reference: { section: "Repair", label: "Linked Repair Order", editable: true, applies: "draft" },
  // Weighed in front of the customer when the piece is taken in. Editable because it is a staff
  // observation, not a computed value, and it is the number any later weight dispute is settled
  // against — the post-repair weight on the Mark Complete form is a different measurement.
  // Both scopes: a weight dispute surfaces after the piece has gone back, by which point the draft
  // is a converted order. The ORDER-side metafield definition already exists (the ensure endpoint
  // creates every REPAIR_MF_DEF for DRAFTORDER and ORDER alike), so this still saves on an order.
  repair_intake_gross_weight: { section: "Repair", label: "Gross Weight at Intake (g)", editable: true, applies: "both" },
  // The other end of the same job: written by the Mark Complete form after the repair
  // (after-sales/index.js -> writeDraftOrderMetafields, custom.gross_weight_g). Read-only here
  // because it is captured by that form rather than typed into this panel - which also means it
  // needs no metafield definition, since display needs none and only saving would. Sits next to the
  // intake weight because the entire point of keeping both is putting them side by side.
  gross_weight_g: { section: "Repair", label: "Gross Weight at Delivery (g)", editable: false, applies: "both" },
  repair_intake_at: { section: "Repair", label: "Repair Intake At", editable: false, applies: "draft" },
  repair_estimate_sent_at: { section: "Repair", label: "Estimate Sent At", editable: false, applies: "draft" },
  repair_completed_at: { section: "Repair", label: "Repair Completed At", editable: false, applies: "draft" },
  repair_store_pickup: { section: "Repair", label: "Store Pickup", editable: false, applies: "draft" },

  mto_comments: { section: "Procurement", label: "Manufacturing Notes", editable: true, applies: "order" },
  mto_comment: { section: "Procurement", label: "Manufacturing Note", editable: true, applies: "draft" },

  state_code: { section: "System", label: "Store / State Code", editable: true, applies: "both" },
  // Draft-only, and only read when a delivery challan is raised off the draft via make-memo-custom.
  delivery_code: { section: "System", label: "Delivery / Store Code (delivery challan)", editable: true, applies: "draft" },
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
    // `required` here is display only (the asterisk) — it marks a compulsory field that must stay
    // with its neighbours rather than being promoted into the Required Inputs section.
    (bySection[cfg.section] ||= []).push({ key, label: cfg.label, editable: cfg.editable, required: cfg.required });
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
// Editing any installment leg must nudge the middleware to re-sum amount_paid and re-derive the
// balance — the values themselves are staff-entered, but the totals are always server-computed.
const PAYMENT_TRIGGER_KEYS = [
  "installment_1_value", "installment_1_mode", "installment_1_date",
  "installment_2_value", "installment_2_mode", "installment_2_date",
  "installment_3_value", "installment_3_mode", "installment_3_date",
  "installment_4_value", "installment_4_mode", "installment_4_date",
];

// A metafield save alone never fires the resource webhook, so the middleware never recomputes on its
// own. We add trigger tags for what changed so it does (the middleware strips them after processing):
//  - `reprice`      → re-run the line-item price calc (gold rate × net weight, discount, GST).
//  - `sync-payment` → recompute net-to-collect (amount_to_be_collected) + balance (amount_pending);
//                     also runs syncAmountToCollect, which re-reads every adjustment metafield.
// Gold rate / jewel weights drive a full reprice; adjustment + payment fields drive a balance recompute.
// PRICE-BEARING fields only. Gross weight and gemstone weight are DISPLAY fields — nothing in the
// pricing engine multiplies by them (gold is rated off net weight, diamond off carats), so editing
// one used to add a `reprice` tag that the handler then refused to act on, because it aborts unless
// jewelcode_net_weight is present. A cosmetic correction should not be routed through the pricing
// engine at all, let alone rejected by it.
// Everything the reprice engine reads BY LINE POSITION, plus the order-level discount intent that
// outlives a line edit. The positional values are indexed by product-line position (the middleware
// reads them as CSV, or as a JSON array for line_discounts), so removing, adding or reordering a
// line shifts every one of them onto a different product. The prices that come out are internally
// consistent and wrong, which is why nobody notices.
//
// discount_applied is in the list because readDiscountIntent falls back to it as a legacy flat
// discount whenever discount_rate is unset: clearing the others without it does not remove the
// discount, it just re-routes the same one through the legacy path.
const POSITIONAL_PRICING_KEYS = [
  "gold_rate",
  "making",
  "jewelcode_net_weight",
  "jewelcode_gross_weight",
  "jewelcode_diamond_carats",
  "jewelcode_gemstone_weight",
  "jewelcode_diamond_pieces",
  "line_discounts",
  "discount_rate",
  "discount_kind",
  "discount_mode",
  "discount_applied",
];

// Fingerprint of the line composition those values were entered against, stored as a short hash of
// "<lineId>:<qty>|...". Line ids catch removal, addition, reordering and variant swaps (Shopify
// issues a new line id on a swap); quantity catches the rest, because custom.making is the whole
// line's labour, already multiplied by quantity.
//
// Stored unstructured - metafieldsSet accepts a key with no definition, exactly as
// custom.line_discounts already does. Hashed rather than kept verbatim so the value stays short
// whatever the line count.
const PRICING_BASIS_KEY = "pricing_basis";

// The fingerprint has to be computable from BOTH sides: here, off GraphQL nodes, and in the
// middleware, off a REST webhook payload. So it is built from values that mean the same thing in
// both - the variant id and the quantity - and never from line ids, which arrive as a gid here and
// as a bare number there and would never agree.
//
// PRODUCT lines only, matching how the middleware indexes its positional arrays: it builds
// productItems by dropping everything without a variant (exchange-note lines and custom negative
// discount lines are both custom lines), and positions are counted within THAT list.
function basisHash(lineNodes) {
  const raw = (lineNodes || [])
    .filter((n) => n?.variant?.id)
    .map((n) => String(n.variant.id).split("/").pop() + ":" + (n.quantity ?? 1))
    .join("|");
  if (!raw) return "";
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const REPRICE_TRIGGER_KEYS = [
  "gold_rate", "gold_rate_date", "making",
  "jewelcode_net_weight",
  "jewelcode_diamond_carats",
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
  // Unified adjustments selector + discount inputs.
  const [adjType, setAdjType] = useState(""); // "" | "exchange" | "voucher" | "discount"
  const [discountSubmode, setDiscountSubmode] = useState("code"); // "code" | "custom"
  const [discountCode, setDiscountCode] = useState("");
  const [discountValue, setDiscountValue] = useState("");
  const [discountMode, setDiscountMode] = useState("pct"); // "pct" | "flat"
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountNote, setDiscountNote] = useState("");
  const [refreshTick, setRefreshTick] = useState(0); // bumped after a save to re-pull server-recomputed values
  const [recalcNote, setRecalcNote] = useState(""); // transient "recalculating…" hint after a trigger tag
  // Per-line discount editor (draft scope): one row per line item carrying a stack of discounts,
  // serialized to custom.line_discounts (JSON). Labour is NOT written from here: custom.making in the
  // Pricing section is its only channel, and a reduction to labour is a discount targeting Making.
  const [lineRows, setLineRows] = useState([]); // [{ id, title, discounts:[{ t, m, v }] }]
  const [lineBusy, setLineBusy] = useState(false);
  const [lineNote, setLineNote] = useState("");
  // Stale-pricing guard. basis = the current line composition's hash; staleKeys = the positional
  // values that were entered against a different one.
  const [staleP, setStaleP] = useState({ basis: "", setKeys: [], staleKeys: [] });
  const [staleNs, setStaleNs] = useState({});
  const [staleBusy, setStaleBusy] = useState(false);
  const [staleNote, setStaleNote] = useState("");
  const baselineRef = useRef({});
  const editsRef = useRef({});

  useEffect(() => {
    let active = true;

    async function load() {
      const valuesByKey = {};
      const nsByKey = {};
      const defsByKey = {};
      const warnings = [];
      let currentBasis = "";

      // Values — best-effort.
      if (ownerId) {
        try {
          const res = await shopify.query(buildValuesQuery(ctx.resourceField), { variables: { id: ownerId } });
          if (res?.errors?.length) warnings.push(res.errors.map((e) => e.message).join("; "));
          for (const n of res?.data?.[ctx.resourceField]?.metafields?.nodes ?? []) {
            valuesByKey[n.key] = n.value ?? "";
            // Kept for the stale-pricing wipe: metafieldsDelete identifies by namespace + key, and
            // these keys are not all in FIELD_CONFIG, so defs[] cannot supply the namespace.
            nsByKey[n.key] = n.namespace;
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

      // Per-line discount editor prefill (draft scope): one row per line item, seeded from the
      // custom.line_discounts JSON (indexed by line position).
      let lineRowsInit = [];
      if (ctx.scope === "draft" && ownerId) {
        try {
          const liRes = await shopify.query(
            `query LineItemsForPricing($id: ID!) { ${ctx.resourceField}(id: $id) { lineItems(first: 50) { nodes { id title name quantity variant { id } } } } }`,
            { variables: { id: ownerId } },
          );
          const nodes = liRes?.data?.[ctx.resourceField]?.lineItems?.nodes ?? [];
          currentBasis = basisHash(nodes);
          let lineDisc = [];
          try { lineDisc = JSON.parse(valuesByKey["line_discounts"] || "[]"); } catch { lineDisc = []; }
          lineRowsInit = nodes.map((n, i) => ({
            id: n.id,
            title: n.title || n.name || `Line ${i + 1}`,
            discounts: Array.isArray(lineDisc[i])
              ? lineDisc[i].map((e) => ({ t: e.t || "dia", m: e.m || "pct", v: String(e.v ?? "") }))
              : [],
          }));
        } catch { /* non-blocking — the editor just shows no rows */ }
      }

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
      setLineRows(lineRowsInit);
      // A positional value only means anything against the line composition it was entered for. If
      // that has moved on, every one of them now points at a different product. A draft with no
      // recorded basis is left alone: absence is not evidence the lines changed, and every draft
      // priced before this shipped has none.
      const storedBasis = (valuesByKey[PRICING_BASIS_KEY] ?? "").trim();
      const isSet = (k) => {
        const v = (valuesByKey[k] ?? "").trim();
        return v !== "" && v !== "[]" && v !== "0";
      };
      // setKeys is every override currently carried, drift or no drift: it drives the manual control,
      // which has to work on drafts that predate pricing_basis entirely - which, on the day this
      // shipped, is all of them.
      const setKeys = POSITIONAL_PRICING_KEYS.filter(isSet);
      const drifted = storedBasis && currentBasis && storedBasis !== currentBasis;
      setStaleNs(nsByKey);
      setStaleP({ basis: currentBasis, setKeys, staleKeys: drifted ? setKeys : [] });
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
        // Belt-and-braces: the blank dropdown entry must clear the field, never be written. If it
        // ever reaches here it fails the whole save with 'Value does not exist in provided
        // choices', taking every other edited field down with it.
        const raw = (editsRef.current[key] ?? "").trim();
        const value = raw === BLANK_CHOICE_LABEL ? "" : raw;
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
      // Record which line composition these values were entered against, so a later line edit can be
      // detected. Written whenever a positional value is touched; best-effort, and never allowed to
      // fail the save that produced it.
      if (changed.some((k) => POSITIONAL_PRICING_KEYS.includes(k)) && staleP.basis) {
        try {
          await shopify.query(SET_MUTATION, { variables: { metafields: [{
            ownerId, namespace: "custom", key: PRICING_BASIS_KEY,
            type: "single_line_text_field", value: staleP.basis,
          }] } });
        } catch { /* non-blocking */ }
      }

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

  // Apply a pre-tax, diamond-only discount: staff pick a real Shopify code or a custom %/₹. We drop an
  // `apply-discount:<code>` or `apply-discount:custom:<v>:<pct|flat>` tag; the middleware resolves the
  // amount against the diamond value, writes custom.discount_applied, and reprices dia-only pre-tax.
  async function applyDiscount() {
    if (!ownerId) return;
    let tag;
    if (discountSubmode === "code") {
      const code = discountCode.trim();
      if (!code) return;
      tag = `apply-discount:${code}`;
    } else {
      const v = parseFloat(discountValue);
      if (!(v > 0)) return;
      tag = `apply-discount:custom:${v}:${discountMode}`;
    }
    setDiscountBusy(true);
    setDiscountNote("");
    try {
      const res = await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: [tag] } });
      const errs = collectErrors(res, "tagsAdd");
      if (errs.length) throw new Error(errs.join("; "));
      setDiscountCode("");
      setDiscountValue("");
      setDiscountNote(`Applying discount… the diamond value, line prices and balance update in a few seconds. If it can't be resolved, a "discount-invalid" tag appears with the reason.`);
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setDiscountNote(`Couldn't apply: ${e?.message || e}`);
    } finally {
      setDiscountBusy(false);
    }
  }

  // Clear every positional pricing value that was entered against a superseded line composition,
  // then reprice. Deliberately a button rather than an automatic wipe on open: this moves
  // customer-facing prices, and doing that as a side effect of opening a panel leaves nothing to
  // trace afterwards.
  //
  // The basis is deleted along with the values, so the draft returns to "nothing recorded" rather
  // than to a basis with no values under it.
  async function clearPricingOverrides(keys) {
    if (!ownerId || !keys || !keys.length) return;
    setStaleBusy(true);
    setStaleNote("");
    try {
      const toDelete = [...keys, PRICING_BASIS_KEY].map((key) => ({
        ownerId,
        namespace: staleNs[key] || defs[key]?.namespace || "custom",
        key,
      }));
      const res = await shopify.query(DELETE_MUTATION, { variables: { metafields: toDelete } });
      const errs = collectErrors(res, "metafieldsDelete");
      if (errs.length) throw new Error(errs.join("; "));
      try {
        await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: ["reprice"] } });
      } catch { /* non-blocking - the values are already gone, which is the part that matters */ }
      setStaleP({ basis: staleP.basis, setKeys: [], staleKeys: [] });
      setStaleNote("Cleared. Repricing off the catalogue now - re-enter any rate, labour, weight or discount this order needs.");
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setStaleNote("Couldn't clear: " + (e?.message || e));
    } finally {
      setStaleBusy(false);
    }
  }

  // Per-line discount editor mutations.
  const addRowDiscount = (i) =>
    setLineRows((rows) => rows.map((r, j) => (j === i ? { ...r, discounts: [...r.discounts, { t: "dia", m: "pct", v: "" }] } : r)));
  const setRowDiscount = (i, di, patch) =>
    setLineRows((rows) => rows.map((r, j) => (j === i ? { ...r, discounts: r.discounts.map((d, k) => (k === di ? { ...d, ...patch } : d)) } : r)));
  const removeRowDiscount = (i, di) =>
    setLineRows((rows) => rows.map((r, j) => (j === i ? { ...r, discounts: r.discounts.filter((_, k) => k !== di) } : r)));

  // Apply per-line discounts: serialize the discount stacks → JSON (custom.line_discounts), write it,
  // then drop a `reprice` tag so the middleware recomputes prices/GST/discount and folds every discount
  // into the single pre-tax Discount Applied.
  //
  // custom.making is deliberately NOT written here. It used to be, and an untouched labour box
  // serialized as "0" — which the reprice engine reads as a real "labour waived" override, not as
  // "unset", and so zeroed the line's Making on every reprice (draft #D202). Labour is set in the
  // Pricing section; cutting labour is a discount targeting Making.
  async function applyLinePricing() {
    if (!ownerId || !lineRows.length) return;
    setLineBusy(true);
    setLineNote("");
    try {
      const lineDiscJson = JSON.stringify(
        lineRows.map((r) =>
          (r.discounts || [])
            .filter((d) => parseFloat(d.v) > 0)
            .map((d) => ({ t: d.t, m: d.m, v: parseFloat(d.v) })),
        ),
      );
      // Definitions drive namespace/type; fall back to the known custom/* shape if a definition is absent
      // (custom.line_discounts may not be defined yet — an unstructured JSON metafield still reads server-side).
      const ldDef = defs["line_discounts"] || { namespace: "custom", type: "json" };
      const toSet = [
        { ownerId, namespace: ldDef.namespace, key: "line_discounts", type: ldDef.type, value: lineDiscJson },
      ];
      // Same basis stamp as save(). line_discounts is positional too, and is the value most likely to
      // be left behind on a line that no longer exists.
      if (staleP.basis) {
        toSet.push({
          ownerId, namespace: "custom", key: PRICING_BASIS_KEY,
          type: "single_line_text_field", value: staleP.basis,
        });
      }
      const res = await shopify.query(SET_MUTATION, { variables: { metafields: toSet } });
      const errs = collectErrors(res, "metafieldsSet");
      if (errs.length) throw new Error(errs.join("; "));
      try {
        await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: ["reprice"] } });
      } catch { /* non-blocking */ }
      setLineNote("Applying per-line discounts… saved and reprice triggered. Line prices, GST and the balance refresh in a few seconds.");
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setLineNote(`Couldn't apply: ${e?.message || e}`);
    } finally {
      setLineBusy(false);
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

  const renderDiscountApply = () => (
    <s-section heading="Apply a Discount">
      <s-stack direction="block" gap="base">
        <s-text tone="subdued">
          Discounts reduce the DIAMOND value pre-tax (order-level). Use a real Shopify discount code, or a
          custom % / ₹ amount. Taxable value, GST, line price and amount-to-collect all update automatically.
        </s-text>
        <s-select
          label="Discount source"
          value={discountSubmode}
          onChange={(e) => setDiscountSubmode(e.target.value ?? "code")}
        >
          <s-option value="code">Discount code</s-option>
          <s-option value="custom">Custom</s-option>
        </s-select>
        {discountSubmode === "code" ? (
          <s-text-field
            label="Discount code (e.g. FNF5)"
            value={discountCode}
            disabled={discountBusy ? "" : undefined}
            onChange={(e) => setDiscountCode(e.target.value ?? "")}
          />
        ) : (
          <s-stack direction="inline" gap="base">
            <s-text-field
              label="Value"
              value={discountValue}
              disabled={discountBusy ? "" : undefined}
              onChange={(e) => setDiscountValue(e.target.value ?? "")}
            />
            <s-select
              label="Type"
              value={discountMode}
              onChange={(e) => setDiscountMode(e.target.value ?? "pct")}
            >
              <s-option value="pct">% of diamond</s-option>
              <s-option value="flat">₹ flat</s-option>
            </s-select>
          </s-stack>
        )}
        <s-button
          onClick={applyDiscount}
          loading={discountBusy ? "" : undefined}
          disabled={
            (discountSubmode === "code" ? !discountCode.trim() : !(parseFloat(discountValue) > 0)) || discountBusy
              ? ""
              : undefined
          }
        >
          Apply Discount
        </s-button>
        {discountNote ? <s-text>{discountNote}</s-text> : null}
      </s-stack>
    </s-section>
  );

  // Pricing overrides carried by this document, with a way to drop them.
  //
  // Separate from the drift banner above on purpose. The banner only fires when custom.pricing_basis
  // proves the lines moved, which cannot work on a document priced before that field existed, and
  // cannot work at all when someone edits the item table and never opens this panel. This is the
  // manual escape hatch: it shows what is actually set, whenever anything is set, and clears it on
  // request without needing to prove anything first.
  const renderPricingOverrides = () => {
    if (!staleP.setKeys.length) return null;
    return (
      <s-section heading="Pricing overrides">
        <s-stack direction="block" gap="base">
          <s-text tone="subdued">
            These values override catalogue pricing on this document, and every one of them is held
            per line position - so if the line items have changed since they were entered, they are
            now applied to different products. Clearing them reprices off the catalogue; re-enter
            whatever this order genuinely needs.
          </s-text>
          <s-text>
            {staleP.setKeys.map((k) => FIELD_CONFIG[k]?.label || k).join(", ")}
          </s-text>
          <s-button
            onClick={() => clearPricingOverrides(staleP.setKeys)}
            loading={staleBusy ? "" : undefined}
            disabled={staleBusy ? "" : undefined}
          >
            Clear all pricing overrides and reprice
          </s-button>
          {staleNote ? <s-text>{staleNote}</s-text> : null}
        </s-stack>
      </s-section>
    );
  };

  // Per-line discount editor — draft scope only (reprice runs on the draft webhook). One card per
  // line item: a stack of discounts, each targeting Diamond, Making, or the whole product (%/₹).
  // Everything folds into the single pre-tax Discount on Taxable on the invoice. Labour itself is set
  // in the Pricing section, not here.
  const renderLinePricing = () => {
    if (ctx.scope !== "draft" || !lineRows.length) return null;
    return (
      <s-section heading="Per-Line Discounts">
        <s-stack direction="block" gap="base">
          <s-text tone="subdued">
            Stack discounts on Diamond, Making, or the whole product — % is of that component, ₹ is a
            flat amount. Each discount is capped at what it targets; all fold into one pre-tax "Discount
            on Taxable". Applying reprices every line. Labour is set above, under Pricing.
          </s-text>
          {lineRows.map((row, i) => (
            <s-stack key={row.id || i} direction="block" gap="small-500">
              <s-text>{`— ${row.title} —`}</s-text>
              {row.discounts.map((d, di) => (
                <s-stack key={di} direction="inline" gap="small-500" alignItems="center">
                  <s-select
                    label="On"
                    value={d.t}
                    disabled={lineBusy ? "" : undefined}
                    onChange={(e) => setRowDiscount(i, di, { t: e.target.value ?? "dia" })}
                  >
                    <s-option value="dia">Diamond</s-option>
                    <s-option value="mk">Making</s-option>
                    <s-option value="total">Whole product</s-option>
                  </s-select>
                  <s-select
                    label="Type"
                    value={d.m}
                    disabled={lineBusy ? "" : undefined}
                    onChange={(e) => setRowDiscount(i, di, { m: e.target.value ?? "pct" })}
                  >
                    <s-option value="pct">%</s-option>
                    <s-option value="flat">₹</s-option>
                  </s-select>
                  <s-number-field
                    label="Value"
                    value={d.v}
                    disabled={lineBusy ? "" : undefined}
                    onChange={(e) => setRowDiscount(i, di, { v: e.target.value ?? "" })}
                  />
                  <s-button onClick={() => removeRowDiscount(i, di)} disabled={lineBusy ? "" : undefined}>
                    Remove
                  </s-button>
                </s-stack>
              ))}
              <s-button onClick={() => addRowDiscount(i)} disabled={lineBusy ? "" : undefined}>
                + Add discount
              </s-button>
            </s-stack>
          ))}
          <s-button
            variant="primary"
            onClick={applyLinePricing}
            loading={lineBusy ? "" : undefined}
            disabled={lineBusy ? "" : undefined}
          >
            Apply per-line discounts
          </s-button>
          {lineNote ? <s-text>{lineNote}</s-text> : null}
        </s-stack>
      </s-section>
    );
  };

  // Credit instruments go on DRAFTS ONLY. A converted order has a final invoice and a settled GST
  // position; deducting a voucher afterwards would put the printed invoice and the system out of
  // step. The server enforces this too — the apply-* tag handlers run only on the draft webhook, so
  // on an order the tag would sit unprocessed forever with no feedback. Hiding the controls here
  // makes that boundary visible instead of silent. Discounts are unaffected.
  const creditsAllowed = ctx.scope !== "order";

  // Unified adjustments selector: pick one to reveal its panel (Exchange / Voucher / Discount).
  const renderAdjustmentSelector = () => (
    <>
      <s-section heading="Adjustments">
        <s-stack direction="block" gap="base">
          <s-select
            label="Add adjustment"
            value={adjType}
            onChange={(e) => setAdjType(e.target.value ?? "")}
          >
            <s-option value="">Select an adjustment to apply…</s-option>
            {creditsAllowed ? <s-option value="exchange">Exchange Note</s-option> : null}
            {creditsAllowed ? <s-option value="voucher">Voucher</s-option> : null}
            <s-option value="discount">Discount</s-option>
          </s-select>
          {creditsAllowed ? null : (
            <s-text tone="subdued">
              Exchange notes and vouchers can only be applied to a draft order, before it is converted.
              Apply them on the draft, then convert.
            </s-text>
          )}
        </s-stack>
      </s-section>
      {creditsAllowed && adjType === "exchange" ? renderExcApply() : null}
      {creditsAllowed && adjType === "voucher" ? renderVoucherApply() : null}
      {adjType === "discount" ? renderDiscountApply() : null}
    </>
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
      {staleP.staleKeys.length ? (
        <s-banner tone="critical" heading="Line items changed - the pricing overrides on this draft are misaligned">
          <s-stack direction="block" gap="small-500">
            <s-text>
              These values are held per line position, and the lines have changed since they were
              entered, so each is now being applied to a different product:
              {" "}{staleP.staleKeys.map((k) => FIELD_CONFIG[k]?.label || k).join(", ")}.
              Clear them and price this order fresh before going any further.
            </s-text>
            <s-button
              variant="primary"
              onClick={() => clearPricingOverrides(staleP.staleKeys)}
              loading={staleBusy ? "" : undefined}
              disabled={staleBusy ? "" : undefined}
            >
              Clear overrides and reprice
            </s-button>
            {staleNote ? <s-text>{staleNote}</s-text> : null}
          </s-stack>
        </s-banner>
      ) : null}
    </>
  );

  const renderSections = () =>
    sections.flatMap((section) => {
      const block = (
        <s-section key={section.title} heading={section.title}>
          <s-stack direction="block" gap="base">
            {section.fields.map((field) =>
              field.editable
                ? renderEditable(field, defs[field.key]?.type || "", defs[field.key]?.choices, edits[field.key] ?? "", setField, saving)
                : renderReadOnly(field, values[field.key] ?? ""),
            )}
          </s-stack>
        </s-section>
      );
      // The per-line discount editor belongs WITH the Pricing section (gold rate / making),
      // so it renders right after it rather than at the top of the panel.
      if (section.title === "Pricing") {
        const out = [block];
        const po = renderPricingOverrides();
        if (po) out.push(<s-stack key="pricing-overrides" direction="block">{po}</s-stack>);
        const lp = renderLinePricing();
        if (lp) out.push(<s-stack key="line-pricing" direction="block">{lp}</s-stack>);
        return out;
      }
      return [block];
    });

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
          {renderAdjustmentSelector()}
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
  // The blank dropdown entry is <s-option value="">—</s-option>, but the host hands back the
  // OPTION LABEL rather than its empty value — so clearing a choice field yielded the literal
  // "—". That is not empty, so save() WROTE it instead of deleting the metafield, and Shopify
  // rejected it: 'Value does not exist in provided choices'. Normalise it back to empty here so
  // picking "—" clears the field, which is the only way to remove an installment's mode.
  const onChange = (e) => {
    const raw = e.target.value ?? "";
    setField(field.key, raw === BLANK_CHOICE_LABEL ? "" : raw);
  };
  // Required staff inputs get an asterisk so the compulsory fields read clearly.
  const label = field.required ? `${field.label} *` : field.label;

  // Definition-driven choice list (e.g. order_type, channel, payment_status)
  // takes precedence over the type-based widget so staff get a dropdown.
  if (Array.isArray(choices) && choices.length) {
    return (
      <s-select key={field.key} label={label} value={value} disabled={disabled} onChange={onChange}>
        <s-option value="">{BLANK_CHOICE_LABEL}</s-option>
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
        <s-option value="">{BLANK_CHOICE_LABEL}</s-option>
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
