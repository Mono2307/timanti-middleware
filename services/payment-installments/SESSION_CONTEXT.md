# Session Context — Payment Installments + Repair Wallet Refunds (2026-08-07 → 08)

Branch `feat/metafield-manager-extension`. Everything below is committed and pushed.
Supersedes `INSTALLMENT_TABLE_PLAN.md`, which proposed a **JSON array** metafield — that was
rejected in favour of flat scalars (staff must be able to type into them in the native editor).

---

## 1. What was built

| Area | Change |
|---|---|
| **Data model** | 13 flat metafields: `installment_1..4_value` (number_decimal), `_mode` (text + choices), `_date` (date), plus `installment_1_type` (`payment` \| `cad_advance`). **26 definitions** — per owner type, DraftOrder + Order. |
| **Semantics** | `amount_paid` = Σ of the legs. `amount_paid_final` pinned to `0`. `amount_pending` = `amount_to_be_collected` − Σ. No two-slot arithmetic survives. |
| **CAD advance** | Occupies slot 1 with `installment_1_type=cad_advance`. Prints as "Design Advance" but is **excluded from Σ** — `custom.advance` already reduces the net, so counting it again deducts twice. |
| **Server** | Both payment paths append a leg via one shared helper. Aggregate `pmodes:` tag replaces `pmode-advance:`/`pmode-final:` (dual-written during rollout). Order-side recompute wired to the orders webhook. |
| **Admin panel** | New Installments section, first in `SECTION_ORDER`. Manufacturing section retired; `delivery_code` moved to System. |
| **Templates** | Per-leg payment table on tax invoice + confirmation receipt, with a tag fallback. |
| **Repairs** | Wallet-refund flow connected end to end (was 3 pieces, 1 deployed as dead code). |

**Decisions locked with the founder:** flat metafields not JSON · CAD advance mirrored but excluded
from the sum · dates system-stamped but staff-editable · emails stay first-and-final (Resend
`sendDepositEmail` is hard-disabled; the live channel is Shopify's draft invoice carrying the OPP
receipt) · **no backfill of historical orders — forward-facing only**.

---

## 2. Bugs found and fixed

Ordered by how much money they could have moved.

| # | Bug | Why it mattered | Fix |
|---|---|---|---|
| 1 | Leg sum **erased pre-installment money**. #D194: ₹10,000 recorded the old way → added a leg → `amount_paid` reset to the leg sum. | Every draft with an existing balance, on its next payment. | `materializeLegacyLeg` — `11a82e9` |
| 2 | The fold then made **removal impossible** — blank a leg and the difference reappeared, pinning the order at "fully paid". | Payments could never be corrected downward. | Fold only when a doc has **zero** legs — `2ff72c1` |
| 3 | `is_finalized` was a **one-way latch**. REST returns a boolean metafield as a JSON boolean, so `=== 'true'` never matched; it could be set true, never false. | An order reopening a balance kept printing "fully paid" on its tax invoice. | `String()` normalisation — `6e7ae73` |
| 4 | All 4 templates + the sales report read `amount_paid` **without** `amount_paid_final`. | Every two-stage order under-reported collections, on the customer's invoice. | Fixed by the cumulative model — `41e6717` |
| 5 | `pm_final != ""` ⇒ **fully paid** latch in Liquid. | A part-paid order printed "Balance Due ₹0". | Removed — `41e6717` |
| 6 | `is_finalized` tested for **object truthiness** in Liquid (needs `allow_false: true` — `default` treats `false` as unset). | Same as #3, template side. | `12c508f` |
| 7 | Order-side edits **never recomputed** — the panel adds `sync-payment` and only the draft chain consumed it. | Editing installments after conversion left a stale balance. | Orders webhook + idempotence guard — `23cef2b` |
| 8 | Blank `—` dropdown option sent the **label**, not an empty value → written, rejected by `choices`, killing the whole save. | Removing an installment mode was impossible. | `BLANK_CHOICE_LABEL` normalisation — `b205d8c` |
| 9 | Repair refunds posted to **`APPS_SCRIPT_URL`** — the PO Tracker, which ignores `issue_voucher` silently. | Customer sees "voucher on its way", nothing issued. | Dedicated `EXCHANGE_APPS_SCRIPT_URL` — `773c7cb` |
| 10 | `issue_voucher` handler created **no discount code and no ledger row**. | Voucher number that buys nothing and reports "not found". | Rewritten to reuse the counter flow — `ae3f389` |
| 11 | Gross weight read `total_metal_weight_g` (often = net) instead of `gross_weight_g`. #1069 printed **5.45 for a real 6.656**. | Wrong weight on a GST invoice. | `b0519c5` |
| 12 | Gross/gemstone weight sat in `REPRICE_TRIGGER_KEYS`, so a cosmetic edit was routed to the pricing engine and **rejected** for want of a net weight. | No way to make a display-only correction. | `e11db2c` |

---

## 3. Platform gotchas learned (all verified, not assumed)

| Constraint | Evidence |
|---|---|
| **Shopify tag max = 40 chars** | A 57-char packed `inst:` tag → `422 Tag exceeds the maximum length`. Hence one tag per leg. |
| **REST returns boolean metafields as JSON booleans**, not `"true"` | `typeof m.value === 'boolean'` on #D194. Broke `=== 'true'` everywhere. |
| **Line-item properties are immutable on an order via API** | `PUT` on #1069 removing `_gross_wt` → **200, no change**. The admin UI can delete (not edit/add); apps get no such path. |
| **Order Printer validates Liquid comments as HTML** | `<value>@<mode>@<date>` in a comment → `Tag value invalid`. Keep angle brackets out. |
| **Metafield definitions are per owner type** | `jewelcode_*` existed on DraftOrder only; editing on an order aborted the whole save. |
| **`choices` is enforced on write** | Live enum lacked `pos`/`gokwik_link` that the server emits — union them or the write fails. |
| **`draft_orders.json?status=any` returns nothing** | Valid values are `open` / `invoice_sent` / `completed`. |
| **Apps Script POST returns a 302** that must be followed as a **GET** | `curl --post302` re-POSTs and gets a Drive 404 — this cost several wrong diagnoses. |

---

## 4. Deploy state

| Target | Status |
|---|---|
| **Metafield definitions** | ✅ 26 installment + 4 `jewelcode_*` on ORDER. Verified both owner types, choices intact. |
| **Apps Script** | ✅ Working — `{"ok":false,"error":"unknown action"}`. Deployment `AKfycbxaakST…`. |
| **Fly** | ⏳ **Pending: `6e7ae73`, `cd503b2`, `b0519c5`** |
| **Shopify app** | ⏳ **Pending: `e11db2c`** |
| **Order Printer Pro** | ⏳ **Re-paste all 4 templates** (through `9b3ed01`) |

`cd503b2` is the urgent one — without it the `i1:`–`i4:` tags are not written automatically, so the
invoice payment table goes **silently stale** after any panel edit.

---

## 5. Verified live on #D194

Two legs appended (5000 upi / 3000 card) → totals correct → leg removed → total dropped → settled in
full → `Full` + pending ₹0 → leg removed again → back to `Partial`. Only `is_finalized` failed to
revert, which is bug #3.

---

## 6. Open items

| Item | Note |
|---|---|
| **Is `orders/update` webhook registered?** | `SYSTEM_OVERVIEW.md:98` says it must be created **manually** → `/api/serial/order-serial`. Unverified — `webhooks.json` only lists the querying app's own. If absent, order-side recompute needs `POST /api/recompute-payment {orderId}`. |
| ~~Do metafields resolve in Order Printer?~~ **RESOLVED** | They do, but Order Printer Pro **caps how many it exposes** — it prints the cost fields and a limited set of metafields, which is why this codebase has tag fallbacks everywhere. The installment table needs 13 keys, well past that cap, so the `i1:`–`i4:` tags are the correct primary source, not a workaround. Confirmed by the founder 2026-08-09. |
| **`total_metal_weight_g` = net across the catalogue?** | True on #1069's variant. If widespread, other readers still get a net weight labelled "total". |
| **Tags are a denormalised cache** | Only refreshed by the panel's `sync-payment`. Editing installments in **Metafields Guru** or the native editor leaves them stale, silently. Argues for keeping these 12 fields out of Guru. |
| **`_gross_wt` on drafts** | The override is display-only. Anything else reading the property (reports, `jewelcode` JSON) still sees the old value. |
| **Email redesign** | Deferred: extend Shopify's draft invoice onto Resend, recycle for later payments. |
| **Backfill** | Deliberately **not run**. Dry run showed 10 drafts with drift and one where audit rows said ₹1 against ₹20,914 recorded — applying would have destroyed real money. |

---

## 7. Reference

**Commits (this session):** `41e6717` `12c508f` `b85529e` `773c7cb` `99b5d7c` `ae3f389` `d860b9e`
`11a82e9` `c704f62` `23cef2b` `2ff72c1` `b205d8c` `6e7ae73` `cd503b2` `7485d07` `b0519c5` `e11db2c` `9b3ed01`

**Key files:** `services/payment-installments/installments.js` (pure helpers, 26 tests via `npm test`)
· `backfill-installments.js` · `server.js` payment paths + tag appliers · `MetafieldManager.jsx` (**×4
byte-identical copies**) · `templates/tax-invoice.liquid` + `order-confirmation-receipt.liquid` (+ TEST copies)
· `services/exchange-cn/EXCHANGE-CALCULATOR-FULL.gs.txt` (drop-in Apps Script)

**Mode enum (live):** `cash, upi, card, online_link, bank transfer, pos` — `gokwik_link` was renamed
`online_link` on 2026-08-07; recon matches both spellings.

**Deploys:** Fly → GitHub Actions → "Deploy to Fly.io", **select the branch** (defaults to `main`,
which lacks all of this) · Extension → `cd metafield-manager && npx @shopify/cli app deploy -c
timanti-metafield-manager-new` · Templates → paste into Order Printer Pro by hand.
