# Metafield Manager — Session Context (2026-06-23)

> Working notes / handover. **Not committed to git.**

## Goal
Two requested block changes for the "Jewellery Workspace" admin block:
1. Reorder fields so compulsory staff inputs (order_type, channel, payment_status,
   payment_mode_advance, amount_paid) sit in a "Required Inputs" section on top.
2. Render choice-list metafields (order_type, channel, payment_status, …) as
   dropdowns instead of free text.

Plus: keep the "all fields" view available (full-height panel, since the inline
block is height-capped to ~7–8 fields).

## Status (as of latest deploy, version timanti-metafield-manager-new-13)
- ✅ Reorder (Required Inputs on top) — DONE, live.
- ✅ Choice-list dropdowns — DONE, live (reads the `choices` validation off each
  metafield definition; if a field still shows free text, its Shopify definition
  has no "choices" validation — add it under Settings → Custom data).
- ✅ Action extensions (full all-fields panel) deploy and open from "More actions".
- ❓ "Show all fields" button on the block (opens the action via
  `shopify.navigation.navigate('extension://<handle>')`) — committed in `b7f5d64`
  and confirmed in the deploy build log, but user reported not seeing it.
  **Most likely the Shopify admin caching the old extension bundle** — verify in an
  Incognito window (definitive cache test). If it shows there, clear admin cache.

## Key facts learned (don't relearn these)
- **Deploy target:** `shopify app deploy --config=timanti-metafield-manager-new`.
  The LIVE app is **Timanti-Metafield-Manager-New** (client 3c0a0f5a). The default
  `shopify.app.toml` is a DIFFERENT app (timanti-custom-extension-app, 69d13abe) —
  deploying there changes nothing visible.
- **Dependencies:** pnpm workspace. Run `pnpm install` after adding/restoring an
  extension folder, or the CLI throws a misleading "wrong @shopify/ui-extensions
  version / type reference not found" error.
- **Architecture (from @shopify/ui-extensions docs):** an admin BLOCK is
  height-capped and CANNOT host a modal. The "all fields" view MUST be an admin
  ACTION extension (`admin.{draft-order,order}-details.action.render`, rendered in
  `<s-admin-action>`). A block opens it via
  `shopify.navigation.navigate('extension://<action-handle>')`. An in-block
  `s-modal` does NOT work.
- **The 4 metafield extensions (must all be in the folder or a deploy deletes the
  missing ones):**
  - `order-metafield-manager` — draft block (`admin.draft-order-details.block.render`)
  - `order-metafield-manager-order` — order block (`admin.order-details.block.render`)
  - `order-metafield-manager-draft-action` — draft action (all-fields panel)
  - `order-metafield-manager-order-action` — order action (all-fields panel)
  - All four share an identical surface-aware `MetafieldManager.jsx`
    (`surface="block"` vs `"action"`).
- **The action extensions were never originally in git** — a past deploy from a
  folder missing them DELETED them from the live app (caused hours of churn). They
  are now reconstructed and committed. Keep them in the folder.
- **Rollback:** v8 is the last known-good with the original panel:
  `shopify app release --config=timanti-metafield-manager-new --version=timanti-metafield-manager-new-8`

## If the button still doesn't show after Incognito
The released bundle genuinely lacks it (would contradict the build log) — inspect
the bundle from the version dashboard, or it's a `navigation.navigate` runtime
issue; the action is still reachable from the "More actions" menu regardless.
