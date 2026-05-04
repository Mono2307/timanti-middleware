/**
 * PO Webhook Handler
 * Listens to orders/updated and draft_orders/updated
 * Reads _po_type line item properties → creates PO draft orders → sends email via Resend
 *
 * Deploy: supabase functions deploy po-webhook
 * Register webhook in Shopify: orders/updated + draft_orders/updated → this URL
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHOPIFY_SHOP = Deno.env.get("SHOPIFY_SHOP")!;           // e.g. auracarat.myshopify.com
const SHOPIFY_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN")!;   // Admin API token
const SHOPIFY_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const HQ_EMAIL = Deno.env.get("HQ_EMAIL")!;                   // e.g. hq@timanti.in
const FROM_EMAIL = Deno.env.get("FROM_EMAIL")!;               // e.g. store@timanti.in
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_URL")!;     // Google Apps Script web app URL
const MIDDLEWARE_BASE_URL = Deno.env.get("MIDDLEWARE_BASE_URL")!; // e.g. https://xyz.supabase.co/functions/v1
const OPP_API_KEY = Deno.env.get("OPP_API_KEY")!;             // Order Printer Pro API key

// ─── HMAC verification ──────────────────────────────────────────────────────

async function verifyShopifyHmac(req: Request, body: string): Promise<boolean> {
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  if (!hmacHeader) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SHOPIFY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === hmacHeader;
}

// ─── Shopify Admin API helpers ───────────────────────────────────────────────

async function shopifyGet(path: string) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${path}`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  return res.json();
}

async function shopifyPost(path: string, body: unknown) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${path}`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ─── Idempotency check ───────────────────────────────────────────────────────
// Returns true if a PO draft order already exists for this source order + type

async function poAlreadyExists(sourceOrderId: string, poType: string): Promise<boolean> {
  // Query draft orders with matching metafield source_order_id
  // Shopify doesn't support metafield filtering on draft_orders list endpoint directly,
  // so we fetch recent open draft orders and filter in memory.
  // For scale, replace with a Supabase table that tracks created POs.
  const data = await shopifyGet("draft_orders.json?status=open&limit=250");
  const drafts = data.draft_orders ?? [];

  for (const draft of drafts) {
    const metaRes = await shopifyGet(`draft_orders/${draft.id}/metafields.json`);
    const metas = metaRes.metafields ?? [];
    const srcId = metas.find((m: any) => m.key === "source_order_id")?.value;
    const type = metas.find((m: any) => m.key === "po_type")?.value;
    if (srcId === sourceOrderId && type === poType) return true;
  }
  return false;
}

// ─── Token generator ─────────────────────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Create PO draft order ───────────────────────────────────────────────────

async function createPoDraftOrder(
  sourceOrder: any,
  lineItems: any[],
  poType: "mto" | "replenishment",
  sourceOrderName: string,
  sourceOrderId: string,
  isDraftOrder: boolean // true if source is a draft order (partial payment)
): Promise<any> {
  const token = generateToken();

  const draftOrderBody: any = {
    draft_order: {
      line_items: lineItems.map((item: any) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
        price: "0.00",
        title: item.title,
        properties: [
          { name: "Special Instructions", value: getSpecialInstructions(item) },
          { name: "_source_line_item_id", value: String(item.id) }
        ].filter(p => p.value)
      })),
      note: `Auto-generated ${poType} PO for ${sourceOrderName}`,
      note_attributes: [
        { name: "action_acknowledge", value: buildActionLink(token, "acknowledge") },
        { name: "action_ordered",     value: buildActionLink(token, "ordered") },
        { name: "action_qc_passed",   value: buildActionLink(token, "qc_passed") },
        { name: "action_shipped",     value: buildActionLink(token, "shipped") },
      ],
      metafields: [
        { namespace: "custom", key: "po_type",          value: poType,          type: "single_line_text_field" },
        { namespace: "custom", key: "po_status",        value: "pending",       type: "single_line_text_field" },
        { namespace: "custom", key: "source_order_id",  value: sourceOrderId,   type: "single_line_text_field" },
        { namespace: "custom", key: "source_order_name",value: sourceOrderName, type: "single_line_text_field" },
        { namespace: "custom", key: "action_token",     value: token,           type: "single_line_text_field" },
      ]
    }
  };

  // MTO: attach customer details
  if (poType === "mto") {
    if (sourceOrder.shipping_address) draftOrderBody.draft_order.shipping_address = sourceOrder.shipping_address;
    if (sourceOrder.billing_address)  draftOrderBody.draft_order.billing_address  = sourceOrder.billing_address;
    if (sourceOrder.email)            draftOrderBody.draft_order.email             = sourceOrder.email;
  }

  const res = await shopifyPost("draft_orders.json", draftOrderBody);
  return { draftOrder: res.draft_order, token };
}

function getSpecialInstructions(item: any): string {
  if (!item.properties) return "";
  return item.properties
    .filter((p: any) => !p.name.startsWith("_") && p.name !== "_po_type" && p.name !== "_po_priority")
    .map((p: any) => `${p.name}: ${p.value}`)
    .join(" | ");
}

function buildActionLink(token: string, action: string): string {
  // Note: we don't have draft order ID yet at this point; it gets added after creation
  // We embed the token; the endpoint looks up the draft order by token
  return `${MIDDLEWARE_BASE_URL}/po-action?action=${action}&token=${token}`;
}

// ─── Fetch OPP PDF ───────────────────────────────────────────────────────────

async function fetchPoPdf(draftOrderId: string): Promise<ArrayBuffer | null> {
  // Order Printer Pro API - generates PDF for a given order/draft order
  // Docs: https://orderprinterpro.com/docs/api
  try {
    const res = await fetch(
      `https://app.orderprinterpro.com/api/v2/documents/draft_order/${draftOrderId}?template=Purchase+Order`,
      { headers: { "Authorization": `Bearer ${OPP_API_KEY}` } }
    );
    if (!res.ok) { console.error("OPP PDF fetch failed", res.status, await res.text()); return null; }
    return res.arrayBuffer();
  } catch (e) {
    console.error("OPP PDF error", e);
    return null;
  }
}

// ─── Send email via Resend ───────────────────────────────────────────────────

async function sendPoEmail(
  draftOrder: any,
  poType: string,
  sourceOrderName: string,
  noteAttributes: { name: string; value: string }[],
  pdfBuffer: ArrayBuffer | null
) {
  const actionLinks = Object.fromEntries(
    noteAttributes.map(na => [na.name, na.value])
  );

  const priority = draftOrder.line_items?.[0]?.properties?.find((p: any) => p.name === "_po_priority")?.value ?? "standard";
  const subjectPrefix = priority === "urgent" ? "🔴 URGENT — " : "";

  const emailBody = `
<p style="font-family: Arial, sans-serif; font-size: 14px;">
  <strong>New ${poType.toUpperCase()} Purchase Order</strong><br>
  PO Number: <strong>${draftOrder.name}</strong><br>
  Source Order: <strong>${sourceOrderName}</strong><br>
  Type: <strong>${poType}</strong><br>
  Priority: <strong>${priority}</strong>
</p>
<p style="font-family: Arial, sans-serif; font-size: 14px;">
  Please find the PO PDF attached. Use the links below to update status:
</p>
<table style="border-collapse: collapse; font-family: Arial, sans-serif; font-size: 14px;">
  <tr>
    <td style="padding: 8px 16px;">
      <a href="${actionLinks.action_acknowledge}" style="background:#2F5496; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; display:inline-block;">
        ✓ Acknowledge PO
      </a>
    </td>
    <td style="padding: 8px 16px;">
      <a href="${actionLinks.action_ordered}" style="background:#E67E22; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; display:inline-block;">
        📋 Mark as Ordered
      </a>
    </td>
    <td style="padding: 8px 16px;">
      <a href="${actionLinks.action_qc_passed}" style="background:#8E44AD; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; display:inline-block;">
        ✓ QC Passed
      </a>
    </td>
    <td style="padding: 8px 16px;">
      <a href="${actionLinks.action_shipped}" style="background:#27AE60; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; display:inline-block;">
        🚚 Mark as Shipped
      </a>
    </td>
  </tr>
</table>
<p style="font-family: Arial, sans-serif; font-size: 12px; color: #888; margin-top: 24px;">
  Each link can only be used once per stage in sequence. Received at store is confirmed by the Bengaluru store team.
</p>
  `.trim();

  const payload: any = {
    from: FROM_EMAIL,
    to: [HQ_EMAIL],
    subject: `${subjectPrefix}New PO — ${draftOrder.name} — ${poType} — ${sourceOrderName}`,
    html: emailBody
  };

  if (pdfBuffer) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(pdfBuffer)));
    payload.attachments = [{
      filename: `PO-${draftOrder.name}-${poType}.pdf`,
      content: base64
    }];
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) console.error("Resend error", res.status, await res.text());
}

// ─── Write to Google Sheets via Apps Script ──────────────────────────────────

async function writeToSheets(row: Record<string, string>) {
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "append", row })
    });
  } catch (e) {
    console.error("Sheets write error", e);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.text();
  const isValid = await verifyShopifyHmac(req, body);
  if (!isValid) return new Response("Unauthorized", { status: 401 });

  const topic = req.headers.get("x-shopify-topic") ?? "";
  const order = JSON.parse(body);
  const isDraftOrder = topic.startsWith("draft_orders");

  const sourceOrderId   = String(order.id);
  const sourceOrderName = order.name ?? `#${order.id}`;
  const lineItems       = order.line_items ?? [];

  // Group line items by _po_type property
  const groups: Record<string, any[]> = {};
  for (const item of lineItems) {
    const poTypeProp = (item.properties ?? []).find((p: any) => p.name === "_po_type");
    if (!poTypeProp?.value) continue;
    const type = poTypeProp.value.toLowerCase().trim();
    if (!["mto", "replenishment"].includes(type)) continue;
    if (!groups[type]) groups[type] = [];
    groups[type].push(item);
  }

  if (Object.keys(groups).length === 0) {
    return new Response("No _po_type properties found — nothing to do", { status: 200 });
  }

  // Process each group
  for (const [poType, items] of Object.entries(groups)) {
    // Idempotency — skip if PO already created for this order + type
    const exists = await poAlreadyExists(sourceOrderId, poType);
    if (exists) {
      console.log(`PO already exists for ${sourceOrderName} / ${poType} — skipping`);
      continue;
    }

    // Create PO draft order
    const { draftOrder, token } = await createPoDraftOrder(
      order, items, poType as "mto" | "replenishment",
      sourceOrderName, sourceOrderId, isDraftOrder
    );

    if (!draftOrder) { console.error("Draft order creation failed"); continue; }

    // Fetch PDF from OPP
    const pdf = await fetchPoPdf(draftOrder.id);

    // Send email via Resend
    await sendPoEmail(draftOrder, poType, sourceOrderName, draftOrder.note_attributes ?? [], pdf);

    // Write to Sheets
    const firstItem = items[0];
    await writeToSheets({
      po_number:       draftOrder.name,
      po_type:         poType,
      source_order:    sourceOrderName,
      customer_name:   poType === "mto" ? `${order.shipping_address?.first_name ?? ""} ${order.shipping_address?.last_name ?? ""}`.trim() : "",
      item_description: items.map((i: any) => i.title).join(", "),
      gati_id:         "", // populated from product metafields if available
      sku:             items.map((i: any) => i.sku ?? "").join(", "),
      priority:        (firstItem.properties ?? []).find((p: any) => p.name === "_po_priority")?.value ?? "standard",
      target_dispatch: (firstItem.properties ?? []).find((p: any) => p.name === "_target_dispatch")?.value ?? "",
      customer_promise:(firstItem.properties ?? []).find((p: any) => p.name === "_customer_promise")?.value ?? "",
      po_sent_at:      new Date().toISOString(),
    });

    console.log(`Created PO ${draftOrder.name} for ${sourceOrderName} / ${poType}`);
  }

  return new Response("OK", { status: 200 });
});
