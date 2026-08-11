# Session Context — After-Sales Communications

**Date:** 2026-08-11
**Branch:** `feat/metafield-manager-extension`
**Status:** committed + pushed. **Not deployed.** Emails still gated to the test inbox.

---

## 1. What this workstream is

Mapping and rebuilding every customer-facing after-sales email — repairs, exchange
notes, vouchers, refunds — then extending the same messaging to WhatsApp templates.

Two reference points drove the design:

- **Bluestone's repair series** (4 PDFs the founder shared) — supplied the *copy,
  structure and running order*. Nothing else. Their visual style was explicitly
  rejected.
- **`timanti_email_preview_full_v2.html`** (in `Claude Projects/Pitchdeck snibbles
  project/Store Training Manual/`) — the authority for *all* visual styling. 600px
  shell, 120px logo, 22px/600 heading, 14px/#555 body, summary rows at 45%.

> If those two ever conflict, v2 wins on appearance, Bluestone wins on wording.

---

## 2. Shipped in this session

### `emailTemplates.js` (new)

Eight v2 templates. Table-based layout on purpose — the HTML previews use flexbox,
Outlook does not.

| Builder | Notes |
|---|---|
| `buildRepairReceivedHtml` | No customer name, no fault description, no timeline. Deliberately vague. |
| `buildRepairEstimateV2Html` | Carries the "approximate and may vary" caveat — **this is what licenses the final email to revise the number. Do not remove it.** |
| `buildRepairConfirmedHtml` | `paid` flag decides which branch the final email can take. |
| `buildRepairReadyFinalHtml` | Merged "ready for collection" + final charges. Three modes: `refund` / `balance` / `collect`. |
| `buildVoucherV2Html` | All 8 printed T&Cs verbatim, **equal-or-higher promoted to clause 1**. |
| `buildVoucherExpiryHtml` | 30-day reminder. Needs a sweep loop that does not exist yet. |
| `buildExchangeNoteV2Html` | 9-clause terms. Applied at generation, never held. |
| `buildRefundConfirmationHtml` | "Refund request confirmation". Generic 4-week bank line. |

`standardFooter()` is defined **once** and used by every email — need help → social →
promises → policy links, with the WhatsApp opt-in and unsubscribe grouped 34px below
the reviews. They cannot drift apart.

### `services/repairs/index.js`

- **`custom.repair_order_reference` is now MANDATORY.** Without it the intake is
  *held*: no customer email, no HQ estimate link, draft tagged
  `repair-missing-order-ref`, HQ alerted. Self-heals — `repair-hq-notified` is never
  set, so filling the metafield re-fires the webhook.
- **Ordering bug fixed.** `fetchAndCopyOriginalOrderSpecs` used to run *after* the
  intake emails, so the acknowledgement always rendered the raw `"repair"` line item.
  It now runs before, and returns the specs (the in-memory draft is stale after its
  own write).
- **Product image** resolved into `_image_url` at copy time — variant image first,
  then product primary. No Shopify call at send time.
- **Final Repair Cost** field on the Mark Complete form → `repair_final_cost`.
  Pre-filled with the estimate. Entered on the **same basis as the estimate** (see §5).
- **`/repairs/refund-wallet`** — signed route, same HMAC pattern as `store-approve`.

### Store inbox on everything

`STORE_EMAIL` (default `hsrstore@timanti.in`, override via the `STORE_EMAIL` secret)
is cc'd on **all** repair mail, customer and HQ, plus voucher and exchange-note mail.
Who acts on the signed links is governed by SOP, not by who can see them.

**Cannot be done for the refund confirmation** — that is Shopify's native
notification, so the store must be added in Shopify's own notification settings.

---

## 3. The reconciliation model (the important bit)

Everything hinges on **one question: was money collected up front?**

| Path | Collected | Final < estimate | Final > estimate |
|---|---|---|---|
| **A — Approve & Pay Now** | the estimate | refund owed → wallet or source | balance owed |
| **B — Approve & Pay at Store** | nothing | **no refund possible** — store charges the actual at the till | store charges the actual |

> A voucher can **only** arise on Path A. On Path B nothing was taken, so there is
> nothing to give back. The final email on that path is informational.

**Refund to wallet** posts to the Exchange Calculator's Apps Script, which owns the
Voucher Log. **Refund to source** is deliberately *not* a hyperlink — plain text
telling the customer to reply or call — until GoKwik confirm the refund API.

---

## 4. Live gates — nothing reaches a customer yet

| Gate | Where | Effect |
|---|---|---|
| `REPAIR_TEST_EMAIL = 'monodeep.dutta@timanti.in'` | `services/repairs/index.js` | All repair mail redirected, cc stripped |
| `SEND_CUSTOMER_EMAILS = false` | `services/exchange-cn/apps-script.js` | Voucher + exchange emails logged, never sent |

Clearing `REPAIR_TEST_EMAIL` switches on **both** the customer and the store copy.

---

## 5. Open questions — answer before go-live

1. **Is the estimate GST-inclusive?** Repairs carry 18% GST. The final-cost field
   sidesteps this by asking for the *same basis as the estimate*, so the delta is
   like-for-like — but the invoice still needs the answer.
2. **Turnaround.** "10 to 15 days" throughout is **Bluestone's number**, not
   Timanti's. Single constant `REPAIR_TURNAROUND` in `emailTemplates.js`. It becomes
   a promise the moment it sends.
3. **Variance threshold** for the upward-revision approval gate. 15% is a placeholder.
4. **GoKwik refunds** — partial supported? window after settlement? refund webhook?
   credentials scoped? The settlement-window answer is most likely to kill it, since
   repairs run 10–15 days.
5. **Does a balance owed block collection**, or is the piece released?

---

## 6. Not built yet

- **Reconciliation branch** — reads `repair_final_cost` vs `payment_amount`, picks
  the mode, sends `buildRepairReadyFinalHtml`. **This is the next thing to build.**
  Until it exists nothing generates the wallet link `/repairs/refund-wallet` waits for.
- **Daily sweep loop** — voucher expiry, unanswered quotes, uncollected pieces, HQ
  stalled-jobs digest. Cheap: `server.js` already runs `setInterval` (30s GoKwik
  poller) and `min_machines_running = 1`.
- **The other 7 builders wired in.** Only `buildRepairReceivedHtml` is called; the
  rest exist but nothing invokes them.
- **Apps Script `issue_voucher` handler** — `services/exchange-cn/apps-script-issue-voucher.gs.txt`
  needs pasting into the **Exchange Calculator** project (not the PO one) and
  deploying as a web app.

---

## 7. Traps found the hard way

- **`APPS_SCRIPT_URL` is the PO Tracker**, which only handles `append`/`update`. An
  `issue_voucher` post there is **silently ignored**. Use `EXCHANGE_APPS_SCRIPT_URL`.
- **A voucher IS a Shopify discount code.** Without the price rule + discount code
  the customer gets a number that buys nothing. Bind it to the customer with
  `prerequisite_customer_ids` or it is a bearer instrument.
- **Column M of the Voucher Log is `price_rule_id`** — `voidVoucher` reads that
  index. Extra columns go after it, never in place of it.
- **Do not route repair refunds through a Shopify refund.** GoKwik/Cash/Pine
  payments are punched in manually, so Shopify never held the gateway transaction.
  A Shopify refund produces a clean accounting entry with **no money behind it**.
- **`SpreadsheetApp.getUi().alert()` blocks forever** when run from the Apps Script
  editor with the sheet unfocused — hangs with no log. Use `toast()`.
- **`clear()` does not undo merges**, so a rebuild collides. `breakApart()` first.
- **`requireTextLengthGreaterThan` does not exist.** No text-length rule exists in
  the DataValidation API — use `requireFormulaSatisfied`.

---

## 8. Deliverables outside the repo

All in `OneDrive/Desktop/Timanti/`:

| File | What |
|---|---|
| `timanti_aftersales_all_emails.html` | **The current preview.** All 8 emails, one view, v2 chrome. Supersedes the earlier split previews. |
| `timanti_aftersales_touchpoint_map.html` | Current-state map |
| `timanti_aftersales_target_touchpoint_map.html` | Target state + phased plan, costed |
| `timanti_aftersales_build_spec.html` | Incremental spec — 19 new emails, colour-coded |
| `whatsapp_templates_builder.gs.txt` | Apps Script that builds the WhatsApp tabs |

---

## 9. WhatsApp templates

Sheet: `1l0tRGEBVc3_SVODSMfnTntmsC9iDj-DtweiXjRNlzkU` — "Whatsapp Templates".
Existing order-flow tabs: `1 - Payment Link`, `2 - Advance Payment (DOI)`,
`3 - Order Confirmation (OC)`, `4 - Shipping Confirmation (SC)`.

Mechanism: `C5` phone → `B10` composed message → `C12` =
`"https://wa.me/91"&C5&"?text="&ENCODEURL(B10)` → green HYPERLINK button.

**Tab 1's send button currently shows `#REF!`** — that template is dead until fixed.
`repairTab1Button()` in the builder script re-points it.

Seven tabs to build (10 and 11 dropped by the founder): `1B - Second Payment Link`,
`5 - Repair Received`, `6 - Repair Estimate`, `7 - Charges Confirmed`,
`8 - Repair Ready`, `9 - Voucher Issued`, `12 - Refund Processed`.

**Unverified:** `B10`'s exact formula was never read — Chrome could click and type
but every screenshot timed out. The builder script infers the composition pattern
from the rendered text. Check it matches on first run.
