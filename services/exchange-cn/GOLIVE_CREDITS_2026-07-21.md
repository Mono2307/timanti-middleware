# Go-live runbook — credit instruments (VCH / EXC)

Commit: `72f26a9` on `feat/metafield-manager-extension`.

## Deploy order

Order matters. The middleware must be live before the extensions, or staff get a UI
referencing metafields nothing writes yet.

### 1. Middleware (Fly)

Deploys are **manual dispatch only** — pushing does not deploy.

- `deploy.yml` builds the **default branch (main)**, ignoring the feature branch.
  As of today main is 51 commits behind, so this ships stale code unless the branch
  is merged first.
- `deploy_commit.yml` takes an explicit `commit_sha` — use `72f26a9` to ship exactly
  this work without touching main.

Verify after deploy: `GET /api/health` (or any known route) returns 200.

### 2. Metafield definitions

Writing a metafield does not need a definition, but without one the field is invisible
in Settings → Custom data, not filterable, and unavailable to Flow.

```
GET /api/metafield-definitions/ensure              # dry run — lists what it would create
GET /api/metafield-definitions/ensure?apply=true   # create
```

Creates `custom.exchange_note_code` and `custom.voucher_code` for DRAFTORDER and ORDER.
Re-runnable: existing definitions report `exists`, not an error.

### 3. Shopify extensions

```
cd metafield-manager
npm install && npm run build     # optional but catches JSX errors before the deploy
npx @shopify/cli app deploy -c timanti-metafield-manager-new
```

One deploy covers all four extensions — they share source and differ only in target
surface (draft/order × block/action).

### 4. Apps Script

Paste `services/exchange-cn/apps-script.js` into Extensions → Apps Script, save.

**The editor copy is not the repo copy.** Edits made in the editor do not come back
here, and pasting overwrites them. Check before pasting that nothing was changed in
the editor since the last paste.

Cell references this file assumes:

| Cell | Holds |
|------|-------|
| B45  | Document Type (Voucher / Exchange Note) |
| B46  | New Draft/Order # |
| B47  | Store Code |
| D19  | Effective gold rate — **written by the script, do not edit** |

`SEND_CUSTOMER_EMAILS = false` — customer emails are suppressed. Flip to `true` for
go-live.

---

## Acceptance criteria

### AC1 — Voucher issues into the ledger
Create a voucher from the sheet. The Voucher Log gets a row, and
`GET /api/recon-ledger?view=detail` shows a `credit_instruments` row with matching
serial, value, customer, and `status: open`.

*Fails as:* voucher created in Shopify but absent from the ledger — the old bug.

### AC2 — Voucher applies to a draft
Enter the code in the admin app on a draft. Within a few seconds:
`custom.voucher_value` = the value, `custom.voucher_code` = the serial,
`custom.amount_to_be_collected` = total − adjustments. Tags `vch-applied`,
`vch-num:<code>`. Ledger status → `applied`.

*Fails as:* `voucher-invalid: <code> not found` tag, nothing deducted.

### AC3 — Serial matches the ledger
The number on the document equals `serial_code` in the ledger — `VCH27-KAHSR-0001`
form, not `VCH-2026-0001`.

### AC4 — Swap replaces, never stacks
Apply A, then B, to the same draft. Draft ends holding **only** B (value and code).
A returns to `open` and is reusable. Never both, never A's value under B's code.

### AC5 — Credits are draft-only
On an order, Adjustments offers only Discount, with the explanatory line. The
`voucher_code` / `exchange_note_code` fields still *display* on the order.

### AC6 — Price rule survives an unconverted draft
Apply a voucher to a draft, then abandon it. The Shopify discount code still exists.
It is deleted only when a draft carrying it converts to an order.

### AC7 — Qty > 1 is exchanged per unit
An order line with quantity 2 shows two pickable rows (`SKU (1 of 2)`, `(2 of 2)`).
Selecting both counts both.

*Fails as:* one row, half the gold value.

### AC8 — Multi-SKU maths stays live
Select 2+ SKUs. B27 is a **formula** (`=B15*D19`), not a typed number. Edit B15 → the
gold value recalculates. D19 holds the weighted rate; C19 shows `X / Y` for humans.

### AC9 — Mixed karat is visible
Selecting 18K and 22K items shows `18K / 22K` in B12, not just `18K`.

### AC10 — No customer emails
Issuing either instrument sends nothing. The dialog says "Email SUPPRESSED (test
mode)". Confirm no mail arrived.

---

## Test script

Run against **KA-TEST** in B47, not KA-HSR.

| # | Steps | Expected |
|---|-------|----------|
| T1 | Sheet: order #, Document Type = Voucher, create | AC1, AC3, AC10 |
| T2 | Draft: apply T1's code | AC2 |
| T3 | Issue a second voucher, apply to the same draft | AC4 — draft holds only #2, #1 reopened |
| T4 | Delete/abandon the draft, check Discounts in Shopify | AC6 — code still exists |
| T5 | New draft, apply a voucher, convert to order | ledger `redeemed`, discount code now gone |
| T6 | Open that order in the admin app | AC5 — no Exchange/Voucher options, code visible |
| T7 | Order with a qty-2 line → Lookup Order Now | AC7 |
| T8 | Select 2 SKUs with different rates and karats, then edit B15 | AC8, AC9 |
| T9 | Apply a made-up code, e.g. `VCH27-KAHSR-9999` | `voucher-invalid: ... not found` tag |
| T10 | Sheet: Document Type = Exchange Note, apply to a draft | `exchange_note_code` + value set, GST unchanged |
| T11 | Apply a different EXC to that draft | AC4 for exchange notes |

### Known gaps — expected to fail, not yet built

- **T9 gives no UI feedback.** The `voucher-invalid` tag is written but the extension
  never reads it — staff see "Applying…" then silence. Not yet fixed.
- **No customer validation.** An instrument issued to customer A applies to customer
  B's draft without complaint.
- **Old Gold source, exchange type (full/deduction), cell gating** — not built.
- **`setupDocTypeFields` still writes to row 37.** Do not run it; it would rebuild the
  fields away from B45-B47.
- **Existing vouchers issued before this commit have no ledger row** and will fail
  AC2. Backfill from the Voucher Log tab (`recon-apps-script.js`) or re-issue.
