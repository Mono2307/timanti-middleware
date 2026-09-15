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
  // Money OUT sits directly under money IN, because the two are read together — a balance only makes
  // sense alongside what has already gone back.
  "Refunds",
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
  // Last in the list on purpose: it is the question staff answer as they close the sale, and adding
  // it mid-list would reshuffle a section they fill from muscle memory.
  "in_store_sale",
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
  // Yes/No, and the answer must be given BEFORE the draft is converted. Shopify emails the order
  // confirmation the moment the order is created, and that email decides between "Download Tax
  // Invoice" and a plain summary purely on the in-store-sale tag. Draft tags carry across at
  // conversion; anything applied to the order afterwards arrives after the customer was emailed.
  // Draft-only for the same reason — on an order it would be a control that can no longer change
  // anything.
  in_store_sale: { section: "Order Details", label: "Send Tax Invoice in Email", editable: true, applies: "draft", required: true },

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

  // REFUNDS — money returned to the customer. Up to 2 legs, same shape as the installments above.
  //
  // Record the refund AFTER you have actually made the transfer at the gateway. Nothing here moves
  // money; this records what already happened, emails the customer (only when you press the button)
  // and puts the refund into the after-sales ledger and the reports.
  //
  // Total Received is deliberately NOT reduced by a refund. It stays what was actually collected —
  // the audit figure — and Amount Pending goes back up by the refunded amount instead. So a Rs50,000
  // deposit with Rs10,000 returned still reads 50,000 received, 10,000 refunded, and 10,000 more to
  // collect than before.
  //
  // Date is the date the money LEFT THE BANK, not the day you keyed it in — it prints on the invoice
  // and drives which month the refund lands in on the reports.
  refund_1_value: { section: "Refunds", label: "1 · Amount", editable: true, applies: "both" },
  refund_1_mode: { section: "Refunds", label: "1 · Mode", editable: true, applies: "both" },
  refund_1_date: { section: "Refunds", label: "1 · Date", editable: true, applies: "both" },
  // The gateway UTR. Text, so a leading zero survives. This is what accounts match against the
  // settlement report when a customer says the money never arrived.
  refund_1_ref: { section: "Refunds", label: "1 · Gateway Ref", editable: true, applies: "both" },
  refund_2_value: { section: "Refunds", label: "2 · Amount", editable: true, applies: "both" },
  refund_2_mode: { section: "Refunds", label: "2 · Mode", editable: true, applies: "both" },
  refund_2_date: { section: "Refunds", label: "2 · Date", editable: true, applies: "both" },
  refund_2_ref: { section: "Refunds", label: "2 · Gateway Ref", editable: true, applies: "both" },
  // Sum of the refund legs, recomputed server-side on every save. Shown here rather than under
  // Payments so the running total sits with the fields staff type into.
  amount_refunded: { section: "Refunds", label: "Total Refunded", editable: false, applies: "both" },

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

// Which class the document is carrying right now, read off its live tags. Free wins if both are
// somehow present, because the complimentary email is the one the customer will have believed.
function repairClassFromTags(tags) {
  const set = new Set((tags ?? []).map((t) => String(t).trim().toLowerCase()));
  if (REPAIR_FREE_TAGS.some((t) => set.has(t))) return "free";
  if (set.has(REPAIR_PAID_TAG)) return "paid";
  return "";
}

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
        tags
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
// Needed because in_store_sale can be turned back OFF. Every other tag this panel writes is a
// one-way trigger the middleware strips itself; in-store-sale is a standing flag, so switching it to
// No has to actually remove it or the confirmation would still carry the tax invoice.
const TAGS_REMOVE_MUTATION = `
  mutation RemoveWorkflowTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }
`;
// -- Repair class ----------------------------------------------------------------------------
// The repairs workflow is started by exactly ONE tag, and WHICH tag it is decides the class of the
// job:
//   repair-intake -> PAID repair. HQ gets the "Set Estimate" link; the customer is acknowledged and
//                    told an estimate follows within a day or two.
//   free-repair   -> COMPLIMENTARY repair. No estimate is ever quoted: the customer is told it is
//                    free and HQ gets the "Mark Complete" link straight away.
// Hand-typing these is where the mistakes happen -- a typo silently starts nothing, and a document
// carrying BOTH tags runs the paid intake first and then emails the same customer a complimentary
// confirmation -- so this panel writes them instead, one class at a time.
// `repair-free` is the SAME class, set by HQ's estimate form ("this repair is our mistake"). It is
// recognised here so an HQ decision shows up correctly, but it is never written from here.
const REPAIR_PAID_TAG = "repair-intake";
const REPAIR_FREE_TAG = "free-repair";
const REPAIR_FREE_TAGS = [REPAIR_FREE_TAG, "repair-free"];
// Written by the middleware once a class has actually been announced. Their presence means emails
// are already out, which no later tag change can unsend -- so the panel says so plainly rather than
// implying a switch is free.
const REPAIR_PAID_DONE_TAG = "repair-hq-notified";
const REPAIR_FREE_DONE_TAG = "repair-free-notified";

// -- Repair items ------------------------------------------------------------------------------
// WHICH pieces from the linked order are actually on the counter. A repair draft references exactly
// one original order, but that order may have carried several pieces and only one of them may be in
// for repair. The middleware used to copy line_items[0] unconditionally, so on a two-piece order the
// customer's acknowledgement, estimate and ready emails -- and the repair note -- all showed the
// wrong photo, title and gross weight, and the only fix was for HQ to retype the SKU by hand on the
// estimate form.
//
// Stored as a JSON array of the ORIGINAL order's line-item ids (numeric, to match what the
// middleware sees over REST) in custom.repair_items. Ids rather than SKUs: one order can carry the
// same SKU twice in different variants, and the id is the only thing that separates them.
const REPAIR_ITEMS_KEY = "repair_items";
// An empty selection is NOT "the first item" -- it means every piece on the order, which is what the
// middleware falls back to. Saying so here keeps the panel and the server telling the same story.
const REPAIR_ITEMS_ALL_NOTE = "all pieces on the order";
// Specs are copied once, when the repair starts. Changing the selection afterwards has to ask for a
// re-copy or the old piece stays on the note and in every later email. The middleware strips this
// tag once it has re-run.
const REPAIR_ITEMS_RESYNC_TAG = "repair-resync-items";

// Where the linked order's line items come from. NOT the Admin API from this extension: this app
// holds read_orders, which Shopify scopes to the last 60 days, and an order outside that window is
// not an error -- it is simply missing from the result. A repair is nearly always intake on an
// older piece, so the picker reported "No pieces found" for every genuine case and appeared to
// work only when the order being tested happened to be recent. The middleware's own token carries
// read_all_orders, so it reaches an order from any year.
// Server side: src/modules/after-sales/index.js, GET /api/repairs/order-items.
const MIDDLEWARE_BASE_URL = "https://timanti-middleware.fly.dev";

// Parse custom.repair_items. Anything unreadable is treated as "nothing selected" rather than
// throwing: a malformed value must not take the whole panel down, and the middleware reads it the
// same forgiving way.
function parseRepairItems(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

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
// Editing a refund leg needs its own nudge: `sync-refund` writes the refund into the after-sales
// ledger and re-sums amount_refunded. It is deliberately NOT part of RECOMPUTE_TRIGGER_KEYS — the
// balance recompute must run AFTER the refund is recorded, and the middleware orders the two.
//
// Recording does NOT email the customer. That is the button below, because a refund raised only
// because the order value contracted — where the customer immediately pays a new balance — should
// not be announced as "your refund is on its way".
const REFUND_TRIGGER_KEYS = [
  "refund_1_value", "refund_1_mode", "refund_1_date", "refund_1_ref",
  "refund_2_value", "refund_2_mode", "refund_2_date", "refund_2_ref",
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
  const [refundEmailBusy, setRefundEmailBusy] = useState(false);
  const [refundEmailNote, setRefundEmailNote] = useState("");
  // Repair class selector: the document's live tags (so the panel reports what the workflow actually
  // sees, not what someone meant to type) plus the staff member's pending choice.
  const [docTags, setDocTags] = useState([]);
  const [repairClass, setRepairClass] = useState(""); // "" | "paid" | "free"
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairNote, setRepairNote] = useState("");
  // Which pieces of the linked order are in for repair: what that order actually contains (fetched
  // when the reference resolves) and which of them staff have ticked.
  const [repairOrderItems, setRepairOrderItems] = useState([]);
  const [repairItemsLoading, setRepairItemsLoading] = useState(false);
  const [repairItemsError, setRepairItemsError] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [repairItemsBusy, setRepairItemsBusy] = useState(false);
  const [repairItemsNote, setRepairItemsNote] = useState("");
  // True once staff have ticked something they haven't saved. Saving any OTHER field bumps
  // refreshTick, and without this flag that refresh would quietly throw the pending selection away.
  const repairItemsDirty = useRef(false);
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
  const baselineRef = useRef({});
  const editsRef = useRef({});

  useEffect(() => {
    let active = true;

    async function load() {
      const valuesByKey = {};
      const defsByKey = {};
      const warnings = [];
      let tagsOnDoc = [];

      // Values — best-effort.
      if (ownerId) {
        try {
          const res = await shopify.query(buildValuesQuery(ctx.resourceField), { variables: { id: ownerId } });
          if (res?.errors?.length) warnings.push(res.errors.map((e) => e.message).join("; "));
          for (const n of res?.data?.[ctx.resourceField]?.metafields?.nodes ?? []) {
            valuesByKey[n.key] = n.value ?? "";
          }
          tagsOnDoc = (res?.data?.[ctx.resourceField]?.tags ?? []).map((t) => String(t).trim());
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
            `query LineItemsForPricing($id: ID!) { ${ctx.resourceField}(id: $id) { lineItems(first: 50) { nodes { id title name } } } }`,
            { variables: { id: ownerId } },
          );
          const nodes = liRes?.data?.[ctx.resourceField]?.lineItems?.nodes ?? [];
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
      setDocTags(tagsOnDoc);
      // Reflect the class the document is actually carrying. A live class only ever OVERWRITES a
      // pending choice when the document has one -- a background refresh (the recompute after a
      // save) must not wipe a selection staff have made but not applied yet.
      const liveClass = repairClassFromTags(tagsOnDoc);
      setRepairClass((prev) => liveClass || prev);
      // Adopt the saved selection unless staff have an unsaved one in front of them.
      if (!repairItemsDirty.current) setSelectedItemIds(parseRepairItems(valuesByKey[REPAIR_ITEMS_KEY]));
      setLineRows(lineRowsInit);
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

  // Pull the linked order's line items so the picker has something to show. Keyed on the reference
  // as staff have it RIGHT NOW (a pending edit included) -- typing an order number and seeing its
  // pieces appear is the whole point; waiting for a save would make the control feel broken.
  const repairRef = (edits.repair_order_reference ?? values.repair_order_reference ?? "").trim();
  useEffect(() => {
    if (ctx.scope !== "draft" || !repairRef) { setRepairOrderItems([]); setRepairItemsError(""); return; }
    let active = true;
    setRepairItemsLoading(true);
    setRepairItemsError("");
    (async () => {
      try {
        // Authenticated with a Shopify session token so this stays a staff-only lookup -- the
        // endpoint can read any order on the store by number.
        const idToken = await shopify.auth.idToken();
        if (!idToken) throw new Error("this admin session could not be verified");
        const res = await fetch(
          `${MIDDLEWARE_BASE_URL}/api/repairs/order-items?ref=${encodeURIComponent(repairRef)}`,
          { headers: { Authorization: `Bearer ${idToken}` } },
        );
        if (!active) return;
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `the lookup failed (HTTP ${res.status})`);
        setRepairOrderItems((body?.items ?? []).map((li) => ({
          // Already the bare numeric id the middleware and custom.repair_items both use.
          id: String(li.id),
          title: li.title || "",
          sku: li.sku || "",
          quantity: li.quantity || 1,
          variantTitle: li.variantTitle || "",
        })));
      } catch (e) {
        if (active) setRepairItemsError(`Couldn't read ${repairRef}: ${e?.message || e}`);
      } finally {
        if (active) setRepairItemsLoading(false);
      }
    })();
    return () => { active = false; };
  }, [ctx.scope, repairRef, refreshTick]);

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
      // in_store_sale is stored as a metafield so the panel can render and remember it, but what the
      // order-confirmation email actually reads is the TAG. Keep the two in step on every save:
      // Yes adds it, anything else removes it. Best-effort — a tag write failing must not fail the
      // save, and the metafield still records what staff chose.
      if (changed.includes("in_store_sale")) {
        const wantTag = (editsRef.current["in_store_sale"] || "").trim().toLowerCase() === "yes";
        try {
          await shopify.query(wantTag ? TAGS_ADD_MUTATION : TAGS_REMOVE_MUTATION,
            { variables: { id: ownerId, tags: ["in-store-sale"] } });
        } catch { /* non-blocking */ }
      }

      const triggerTags = [];
      if (changed.some((k) => REPRICE_TRIGGER_KEYS.includes(k))) triggerTags.push("reprice");
      if (changed.some((k) => RECOMPUTE_TRIGGER_KEYS.includes(k))) triggerTags.push("sync-payment");
      // A refund also has to move the balance, so it asks for BOTH. The middleware runs refund-sync
      // before payment-sync, so amount_refunded is on the document before the balance derives off it.
      if (changed.some((k) => REFUND_TRIGGER_KEYS.includes(k))) {
        triggerTags.push("sync-refund");
        if (!triggerTags.includes("sync-payment")) triggerTags.push("sync-payment");
      }
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

  // Tell the customer about a refund. Deliberately a BUTTON and not something the save does on its
  // own: a refund raised because the order value contracted, where the customer immediately settles
  // a new balance, should not be announced as "your refund is on its way". Staff decide.
  //
  // Safe to press twice — the middleware only emails refund legs it has never emailed before, so a
  // second press sends nothing, and pressing it for a NEW refund never re-announces an older one.
  async function sendRefundEmail() {
    if (!ownerId) return;
    setRefundEmailBusy(true);
    setRefundEmailNote("");
    try {
      const res = await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: ["send-refund-email"] } });
      const errs = collectErrors(res, "tagsAdd");
      if (errs.length) throw new Error(errs.join("; "));
      setRefundEmailNote("Sending… the customer gets a refund confirmation in a few seconds. Refunds already emailed are skipped.");
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setRefundEmailNote(`Couldn't send: ${e?.message || e}`);
    } finally {
      setRefundEmailBusy(false);
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

  // Start (or correct) a repair by writing its class tag. The middleware watches the draft for
  // exactly these tags; everything downstream -- which emails go out, whether an estimate is ever
  // quoted, and whether the finished job takes a TS or an FS serial -- follows from this one choice.
  //
  // The losing tag is removed BEFORE the new one is added, and that order is the whole point: a
  // document that briefly carries both fires the paid intake flow on the very next webhook, which is
  // exactly the mistake this control exists to prevent. Removing first leaves the draft with no
  // class tag for a moment, which triggers nothing.
  async function applyRepairClass() {
    if (!ownerId || !repairClass) return;
    setRepairBusy(true);
    setRepairNote("");
    try {
      const present = new Set(docTags.map((t) => t.toLowerCase()));
      const add = repairClass === "free" ? [REPAIR_FREE_TAG] : [REPAIR_PAID_TAG];
      const drop = (repairClass === "free" ? [REPAIR_PAID_TAG] : REPAIR_FREE_TAGS).filter((t) => present.has(t));
      if (drop.length) {
        const res = await shopify.query(TAGS_REMOVE_MUTATION, { variables: { id: ownerId, tags: drop } });
        const errs = collectErrors(res, "tagsRemove");
        if (errs.length) throw new Error(errs.join("; "));
      }
      const res = await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: add } });
      const errs = collectErrors(res, "tagsAdd");
      if (errs.length) throw new Error(errs.join("; "));
      setRepairNote(repairClass === "free"
        ? `Tagged ${REPAIR_FREE_TAG}. The customer is being emailed a complimentary-repair confirmation and HQ gets the "Mark Complete" link -- this takes a few seconds.`
        : `Tagged ${REPAIR_PAID_TAG}. HQ is being emailed the "Set Estimate" link and the customer an acknowledgement -- this takes a few seconds.`);
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setRepairNote(`Couldn't set the repair type: ${e?.message || e}`);
    } finally {
      setRepairBusy(false);
    }
  }

  // Save the picked pieces. The selection is a metafield, and a metafield save fires no webhook, so
  // the resync tag goes on in the same breath -- otherwise a correction made after intake would sit
  // in the metafield while the note and the emails kept showing the piece copied on day one.
  async function applyRepairItems() {
    if (!ownerId) return;
    setRepairItemsBusy(true);
    setRepairItemsNote("");
    try {
      const def = defs[REPAIR_ITEMS_KEY] || { namespace: "custom", type: "json" };
      const picked = repairOrderItems.filter((li) => selectedItemIds.includes(li.id));
      if (picked.length && picked.length < repairOrderItems.length) {
        const res = await shopify.query(SET_MUTATION, {
          variables: { metafields: [{ ownerId, namespace: def.namespace, key: REPAIR_ITEMS_KEY,
                                      type: def.type, value: JSON.stringify(picked.map((li) => li.id)) }] },
        });
        const errs = collectErrors(res, "metafieldsSet");
        if (errs.length) throw new Error(errs.join("; "));
      } else {
        // Everything ticked (or nothing) means the same thing -- no narrowing -- so clear the
        // metafield rather than storing a list that has to be re-checked against the order every
        // time it is read.
        const res = await shopify.query(DELETE_MUTATION, {
          variables: { metafields: [{ ownerId, namespace: def.namespace, key: REPAIR_ITEMS_KEY }] },
        });
        // Deleting something that was never set is not an error worth surfacing.
        const errs = collectErrors(res, "metafieldsDelete").filter((m) => !/not found|does not exist/i.test(m));
        if (errs.length) throw new Error(errs.join("; "));
      }
      try {
        await shopify.query(TAGS_ADD_MUTATION, { variables: { id: ownerId, tags: [REPAIR_ITEMS_RESYNC_TAG] } });
      } catch { /* non-blocking: the selection is saved either way */ }
      repairItemsDirty.current = false;
      setRepairItemsNote(picked.length && picked.length < repairOrderItems.length
        ? `Saved ${picked.length} of ${repairOrderItems.length} pieces. The repair note and the customer emails are being rebuilt around them -- this takes a few seconds.`
        : `Saved: ${REPAIR_ITEMS_ALL_NOTE}. Every piece on the linked order will appear on the note and in the customer emails.`);
      setTimeout(() => setRefreshTick((t) => t + 1), 3000);
    } catch (e) {
      setRepairItemsNote(`Couldn't save the pieces: ${e?.message || e}`);
    } finally {
      setRepairItemsBusy(false);
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

  // Only offered once a refund actually exists on the document — there is nothing to tell the
  // customer about otherwise. Reads the saved value, not the in-progress edit, because the
  // middleware has to have recorded the refund before it can email it.
  const renderRefundEmail = () => {
    // Show as soon as a refund exists ANYWHERE on the document — a saved leg counts, not just the
    // server-computed total. amount_refunded is written by the middleware on the next webhook pass,
    // so gating on it alone meant staff entered a refund, saved, and the button they needed was
    // simply absent until they reloaded. Legs are the thing staff actually type, so they are the
    // honest signal that a refund is on this document.
    //
    // Reading `values` (saved) rather than `edits` (in progress) is deliberate: the middleware can
    // only email a refund it has already recorded, so offering the button over an unsaved figure
    // would produce a press that silently does nothing.
    const refunded = parseFloat(values.amount_refunded || "0") || 0;
    const legTotal = (parseFloat(values.refund_1_value || "0") || 0)
                   + (parseFloat(values.refund_2_value || "0") || 0);
    const shown = refunded > 0 ? refunded : legTotal;
    if (!(shown > 0)) return null;
    return (
      <s-section heading="Refund Confirmation Email">
        <s-stack direction="block" gap="base">
          <s-text tone="subdued">
            {refunded > 0
              ? `Rs.${refunded.toLocaleString("en-IN")} has been recorded as refunded.`
              : `Rs.${legTotal.toLocaleString("en-IN")} entered — still being recorded, this takes a few seconds.`}
            {" "}Nothing has been sent to the customer — send the confirmation only if they should hear about
            this money coming back. If the refund was just a correction because the order value changed and
            they are paying a new balance, you can skip it. Refunds already emailed are never sent twice.
          </s-text>
          <s-button
            onClick={sendRefundEmail}
            loading={refundEmailBusy ? "" : undefined}
            disabled={refundEmailBusy ? "" : undefined}
          >
            Send refund email
          </s-button>
          {refundEmailNote ? <s-text>{refundEmailNote}</s-text> : null}
        </s-stack>
      </s-section>
    );
  };

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

  // Repair type -- the single control that starts a repair, sitting under the Repair fields because
  // it is the first thing staff do to a repair draft and the last thing they should be typing by
  // hand. It writes the class tag; the middleware does everything else.
  const renderRepairClass = () => {
    // Repairs run off the DRAFT webhook only, so on a converted order the tag would sit there
    // unprocessed forever with no feedback. Say so rather than offering a button that does nothing.
    if (ctx.scope !== "draft") {
      return (
        <s-section heading="Repair Type">
          <s-text tone="subdued">
            A repair is started on the draft order -- that is the only document the repairs workflow
            watches. Set the type there, before the draft is converted.
          </s-text>
        </s-section>
      );
    }

    const tagSet = new Set(docTags.map((t) => t.toLowerCase()));
    const current = repairClassFromTags(docTags);
    // Emails already sent for this class. A tag change from here cannot unsend them, so the panel
    // has to say what the customer has ALREADY been told before staff switch anything.
    const announced = (current === "free" && tagSet.has(REPAIR_FREE_DONE_TAG))
                   || (current === "paid" && tagSet.has(REPAIR_PAID_DONE_TAG));
    // The paid flow is gated server-side on custom.repair_order_reference: without it the intake is
    // HELD, no customer email goes out, and HQ gets an "action needed" mail instead. Staff can see
    // that here, in the same panel that has the field, instead of finding out by email.
    const missingRef = !(values.repair_order_reference || "").trim() && !(edits.repair_order_reference || "").trim();

    const currentLabel = current === "free"
      ? "Free / complimentary repair"
      : current === "paid"
        ? "Paid repair (estimate flow)"
        : "Not started -- no repair tag on this draft yet";
    const changed = repairClass && repairClass !== current;

    return (
      <s-section heading="Repair Type">
        <s-stack direction="block" gap="base">
          <s-text tone="subdued">
            Pick the type and press the button -- it adds the tag that starts the workflow, so nobody
            has to type one. A paid repair emails HQ the "Set Estimate" link and acknowledges the
            customer; a free repair tells the customer there is no charge and sends HQ the "Mark
            Complete" link with no estimate. Only one type can be set at a time.
          </s-text>
          <s-text>{`Current: ${currentLabel}`}</s-text>
          <s-select
            label="Repair type"
            value={repairClass}
            disabled={repairBusy ? "" : undefined}
            onChange={(e) => {
              // The host hands back the option LABEL for the blank entry, so anything that isn't one
              // of the two real values is treated as "nothing picked".
              const v = e.target.value ?? "";
              setRepairClass(v === "paid" || v === "free" ? v : "");
            }}
          >
            <s-option value="">Select a repair type...</s-option>
            <s-option value="paid">Paid repair -- send an estimate</s-option>
            <s-option value="free">Free repair -- no charge</s-option>
          </s-select>
          {repairClass === "paid" && missingRef ? (
            <s-text tone="caution">
              No Linked Repair Order yet. The intake will be held until you fill it in below and save
              -- nothing is sent to the customer before then, because every repair email shows the
              original piece copied from that order.
            </s-text>
          ) : null}
          {announced && changed ? (
            <s-text tone="caution">
              {current === "free"
                ? "This customer has already been told the repair is complimentary. Switching to paid does not unsend that -- call them."
                : "This customer has already been acknowledged for a paid repair and HQ holds the estimate link. Switching to free does not unsend that."}
            </s-text>
          ) : null}
          <s-button
            variant="primary"
            onClick={applyRepairClass}
            loading={repairBusy ? "" : undefined}
            disabled={!changed || repairBusy ? "" : undefined}
          >
            {current ? "Change repair type" : "Start repair"}
          </s-button>
          {repairNote ? <s-text>{repairNote}</s-text> : null}
        </s-stack>
      </s-section>
    );
  };

  // Which pieces are in for repair. Sits directly under the repair-type control because the two are
  // one decision in the staff member's head: what kind of repair, and on which piece.
  const renderRepairItems = () => {
    // Same reason as the repair-type control: the reference, the specs copy and the repairs webhook
    // all live on the draft. renderRepairClass already says so on an order, so say nothing here
    // rather than stack a second grey box under it.
    if (ctx.scope !== "draft") return null;

    if (!repairRef) {
      return (
        <s-section heading="Pieces in for Repair">
          <s-text tone="subdued">
            Fill in Linked Repair Order above and save -- the pieces on that order will be listed here
            to pick from.
          </s-text>
        </s-section>
      );
    }

    const allSelected = !selectedItemIds.length || selectedItemIds.length === repairOrderItems.length;
    // A selection that no longer matches the order -- the reference was edited to point somewhere
    // else -- is worth saying out loud, because until it is re-saved the middleware falls back to
    // every piece.
    const stale = selectedItemIds.filter((id) => !repairOrderItems.some((li) => li.id === id));

    return (
      <s-section heading="Pieces in for Repair">
        <s-stack direction="block" gap="base">
          <s-text tone="subdued">
            Tick only the pieces actually on the counter. Everything downstream follows this -- the
            photo, name and gross weight on the customer's emails, the line on the repair note, and
            the Item ID on the invoice. Leave them all ticked if the whole order came in.
          </s-text>
          {repairItemsError ? (
            <s-text tone="critical">{repairItemsError}</s-text>
          ) : repairItemsLoading ? (
            <s-text tone="subdued">{`Loading the pieces on ${repairRef}...`}</s-text>
          ) : !repairOrderItems.length ? (
            <s-text tone="caution">
              {`No pieces found on ${repairRef}. Check the order number -- the repair intake is held until it resolves.`}
            </s-text>
          ) : (
            <s-stack direction="block" gap="small-300">
              {repairOrderItems.map((li) => {
                // Everything the counter needs to tell two pieces of one order apart, on one line.
                const bits = [li.sku, li.variantTitle].filter(Boolean).join(" / ");
                const label = `${li.title}${bits ? ` -- ${bits}` : ""}${li.quantity > 1 ? ` (qty ${li.quantity})` : ""}`;
                const on = allSelected || selectedItemIds.includes(li.id);
                return (
                  <s-checkbox
                    key={li.id}
                    label={label}
                    checked={on ? "" : undefined}
                    disabled={repairItemsBusy ? "" : undefined}
                    onChange={(e) => {
                      const want = !!e.target.checked;
                      // The stored list is always explicit. "Nothing selected" renders as everything
                      // ticked, so the first untick has to start from the full list rather than from
                      // an empty one -- otherwise unticking one piece would silently select it.
                      const base = selectedItemIds.length ? selectedItemIds : repairOrderItems.map((x) => x.id);
                      repairItemsDirty.current = true;
                      setSelectedItemIds(want ? [...new Set([...base, li.id])] : base.filter((x) => x !== li.id));
                    }}
                  />
                );
              })}
            </s-stack>
          )}
          {stale.length ? (
            <s-text tone="caution">
              {`${stale.length} previously picked piece(s) are not on ${repairRef} any more. Re-pick and save, or every piece on the order will be used.`}
            </s-text>
          ) : null}
          {repairOrderItems.length > 1 && allSelected ? (
            <s-text tone="caution">
              {`All ${repairOrderItems.length} pieces are selected. The customer will be emailed about every one of them.`}
            </s-text>
          ) : null}
          <s-button
            variant="secondary"
            onClick={applyRepairItems}
            loading={repairItemsBusy ? "" : undefined}
            disabled={repairItemsBusy || repairItemsLoading || !repairOrderItems.length ? "" : undefined}
          >
            Save pieces
          </s-button>
          {repairItemsNote ? <s-text>{repairItemsNote}</s-text> : null}
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
      {renderRefundEmail()}
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
        const lp = renderLinePricing();
        if (lp) return [block, <s-stack key="line-pricing" direction="block">{lp}</s-stack>];
      }
      // Same idea for the repair class selector: it belongs with the repair fields (the Linked
      // Repair Order it depends on is one of them), not floating at the top of the panel.
      if (section.title === "Repair") {
        const rc = renderRepairClass();
        const ri = renderRepairItems();
        const extras = [
          rc ? <s-stack key="repair-class" direction="block">{rc}</s-stack> : null,
          ri ? <s-stack key="repair-items" direction="block">{ri}</s-stack> : null,
        ].filter(Boolean);
        if (extras.length) return [block, ...extras];
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
