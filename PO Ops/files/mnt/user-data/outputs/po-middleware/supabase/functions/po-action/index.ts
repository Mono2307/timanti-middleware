/**
 * PO Action Link Handler
 * Receives clicks from HQ email action links
 * Validates token → updates Shopify draft order metafield → writes timestamp to Sheets
 *
 * Deploy: supabase functions deploy po-action
 * URL pattern: /po-action?action=acknowledge&token=abc123
 */

const SHOPIFY_SHOP  = Deno.env.get("SHOPIFY_SHOP")!;
const SHOPIFY_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN")!;
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_URL")!;

const VALID_ACTIONS = ["acknowledge", "ordered", "qc_passed", "shipped"] as const;
type Action = typeof VALID_ACTIONS[number];

const ACTION_TO_STATUS: Record<Action, string> = {
  acknowledge: "acknowledged",
  ordered:     "ordered",
  qc_passed:   "qc_passed",
  shipped:     "shipped"
};

const ACTION_TO_SHEET_COL: Record<Action, string> = {
  acknowledge: "acknowledged_at",
  ordered:     "ordered_at",
  qc_passed:   "qc_at",
  shipped:     "shipped_at"
};

// ─── Shopify helpers ──────────────────────────────────────────────────────────

async function shopifyGet(path: string) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${path}`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN }
  });
  return res.json();
}

async function shopifyPut(path: string, body: unknown) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${path}`, {
    method: "PUT",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function shopifyDelete(path: string) {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/${path}`, {
    method: "DELETE",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN }
  });
  return res.status;
}

// ─── Find draft order by action token ────────────────────────────────────────

async function findDraftOrderByToken(token: string): Promise<any | null> {
  // Fetch open draft orders, find one whose action_token metafield matches
  // For scale: replace with a Supabase table that maps token → draft_order_id
  const data = await shopifyGet("draft_orders.json?status=open&limit=250");
  const drafts = data.draft_orders ?? [];

  for (const draft of drafts) {
    const metaRes = await shopifyGet(`draft_orders/${draft.id}/metafields.json`);
    const metas = metaRes.metafields ?? [];
    const tokenMeta = metas.find((m: any) => m.key === "action_token" && m.namespace === "custom");
    if (tokenMeta?.value === token) {
      return { draft, metafields: metas };
    }
  }
  return null;
}

// ─── Update metafield ─────────────────────────────────────────────────────────

async function updatePoStatus(draftOrderId: string, metafields: any[], newStatus: string) {
  const statusMeta = metafields.find((m: any) => m.key === "po_status" && m.namespace === "custom");
  if (!statusMeta) return;

  await shopifyPut(`draft_orders/${draftOrderId}/metafields/${statusMeta.id}.json`, {
    metafield: { id: statusMeta.id, value: newStatus, type: "single_line_text_field" }
  });
}

// ─── Update Sheets ────────────────────────────────────────────────────────────

async function updateSheets(poNumber: string, column: string, timestamp: string) {
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", po_number: poNumber, column, value: timestamp })
    });
  } catch (e) {
    console.error("Sheets update error", e);
  }
}

// ─── HTML response helpers ────────────────────────────────────────────────────

function successPage(poName: string, action: string): string {
  const labels: Record<string, string> = {
    acknowledge: "acknowledged",
    ordered:     "marked as ordered",
    qc_passed:   "marked QC passed",
    shipped:     "marked as shipped to store"
  };
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>PO Updated</title>
<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}
.card{background:#fff;padding:40px;border-radius:8px;text-align:center;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1);}
h2{color:#27AE60;margin-bottom:8px;}p{color:#555;}</style>
</head>
<body><div class="card">
<h2>✓ Done</h2>
<p><strong>${poName}</strong> has been ${labels[action] ?? action}.</p>
<p style="color:#999;font-size:13px;margin-top:20px;">You can close this tab.</p>
</div></body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}
.card{background:#fff;padding:40px;border-radius:8px;text-align:center;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1);}
h2{color:#E74C3C;}</style>
</head>
<body><div class="card">
<h2>Something went wrong</h2>
<p>${message}</p>
</div></body></html>`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") as Action | null;
  const token  = url.searchParams.get("token");

  if (!action || !token) {
    return new Response(errorPage("Missing action or token in link."), { status: 400, headers: { "Content-Type": "text/html" } });
  }

  if (!VALID_ACTIONS.includes(action)) {
    return new Response(errorPage(`Unknown action: ${action}`), { status: 400, headers: { "Content-Type": "text/html" } });
  }

  // Find the draft order by token
  const found = await findDraftOrderByToken(token);
  if (!found) {
    return new Response(errorPage("PO not found or link has already been used."), { status: 404, headers: { "Content-Type": "text/html" } });
  }

  const { draft, metafields } = found;
  const newStatus = ACTION_TO_STATUS[action];
  const sheetCol  = ACTION_TO_SHEET_COL[action];
  const timestamp = new Date().toISOString();

  // Update Shopify draft order metafield
  await updatePoStatus(draft.id, metafields, newStatus);

  // Get PO number for Sheets lookup
  const poNameMeta = metafields.find((m: any) => m.key === "source_order_name");
  const poName = draft.name;

  // Update Sheets timestamp
  await updateSheets(poName, sheetCol, timestamp);

  // On shipped: delete the draft order (PO is complete)
  if (action === "shipped") {
    await shopifyDelete(`draft_orders/${draft.id}.json`);
    await updateSheets(poName, "status", "shipped");
  }

  return new Response(successPage(poName, action), {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
});
