# Timanti Repair Middleware — Testing Plan

**Service:** `services/repairs/index.js`
**Middleware base URL:** `https://timanti-middleware.fly.dev`
**Test email intercept:** `REPAIR_TEST_EMAIL = monodeep.dutta@timanti.in` (all repair emails — customer AND HQ — are redirected here while this constant is set)
**Last updated:** 2026-06-02

---

## Prerequisites

Before running any test case:

1. Confirm the server is live: `curl https://timanti-middleware.fly.dev/health` (or equivalent health endpoint) — should return 200.
2. Confirm `REPAIR_TEST_EMAIL` is still hardcoded in `services/repairs/index.js` line 19. All emails will go to `monodeep.dutta@timanti.in` regardless of the draft order's customer email.
3. Have a Shopify draft order ready (auracarat.myshopify.com admin). Use the same draft order through the full lifecycle unless a test case says otherwise. Suggested setup:
   - Customer: a real name, email and phone (fields are pulled from `billing_address`)
   - Line item: e.g. "Ring Repair" at price ₹1 (placeholder — the estimate form updates it)
   - Notes: a brief description of the defect

---

## Test Cases

### TC-01 — Repair Intake (Trigger 0)

**Feature:** `handleRepairDraftUpdate` — Trigger 0

**Setup:**
- Draft order exists with at least one line item, a customer email, and a `billing_address.name`.
- Tags are empty (or contain only irrelevant tags).
- `repair-hq-notified` is NOT present.

**Steps:**
1. Open the draft order in Shopify admin (auracarat.myshopify.com).
2. Add tag `repair-intake` and save.
3. Wait ~5 seconds for the Shopify `draft_orders/update` webhook to reach the middleware.
4. Check Fly.io logs (`fly logs -a timanti-middleware`).
5. Check the inbox at `monodeep.dutta@timanti.in`.
6. Check the draft order tags and metafields in Shopify admin.

**Expected results:**

- [ ] Logs contain: `Repair intake trigger: D#XXXX`
- [ ] Logs contain: `✅ Repair intake: HQ notified + customer ack sent: D#XXXX`
- [ ] **HQ email** received at `monodeep.dutta@timanti.in`:
  - Subject: `New Repair Intake — D#XXXX — [Customer Name]`
  - Body shows: customer name, email, phone, item description, notes
  - Contains a black CTA button: "Set Estimate & Send to Customer"
  - Button URL format: `https://timanti-middleware.fly.dev/repairs/set-estimate?d={draftId}&t={32-char-hex}`
  - Footer reads: "Timanti internal — do not forward this email"
- [ ] **Customer acknowledgement email** received at `monodeep.dutta@timanti.in`:
  - Subject: `We've Received Your Item — D#XXXX`
  - Body says "We've received your [item name]. Our team will review it and send you an estimate within 1–2 business days."
- [ ] Draft order tag `repair-hq-notified` added
- [ ] Metafield `timanti.repair_intake_at` written (ISO timestamp)
- [ ] If `custom.repair_order_reference` was set on the draft: see TC-01b below

**Pass / Fail:** ___

---

### TC-01b — Original Order Specs Auto-Copied at Intake

**Feature:** `fetchAndCopyOriginalOrderSpecs` — called from Trigger 0 (intake) and Trigger 0b (free repair)

**Setup:**
- An existing fulfilled order on auracarat.myshopify.com (e.g. `#1234`) whose first line item has either:
  - Line item properties `_gross_wt`, `_net_wt`, `_diamond_cts`, `_diamond_pcs`, OR
  - Variant metafields `custom.total_metal_weight_g`, `custom.net_metal_weight_g`, OR
  - Product metafields `custom.totaldiamondweight`, `custom.totaldiamondcount`
- A repair draft order with metafield `custom.repair_order_reference = #1234` set in Shopify admin.
- `repair-hq-notified` NOT present on the draft.

**Steps:**
1. Add tag `repair-intake` to the draft and save.
2. Wait ~5 seconds for webhook + processing.
3. Check Fly.io logs.
4. In Shopify admin, open the draft order → click the first line item → check Properties.

**Expected results:**

- [ ] Logs contain: `✅ Copied N spec(s) from #1234 → D#XXXX: _gross_wt, _net_wt, ...`
- [ ] Line item properties on repair draft now show the copied specs (e.g. `_gross_wt: 2.45`, `_net_wt: 2.10`, `_diamond_cts: 0.50`)
- [ ] All pre-existing line item properties are preserved (nothing overwritten)
- [ ] Intake emails still fire normally — spec copy runs after, does not block emails

**Edge case A — no order reference set:**
- Draft has no `custom.repair_order_reference` metafield
- Expected: `fetchAndCopyOriginalOrderSpecs` bails silently, no log error, intake proceeds normally

**Edge case B — order reference set but order not found:**
- Set `custom.repair_order_reference = #DOESNOTEXIST`
- Expected: log `fetchAndCopyOriginalOrderSpecs: order #DOESNOTEXIST not found`, intake proceeds normally, no crash

**Edge case C — original order has no specs anywhere:**
- Original order line item has no properties and no variant/product metafields
- Expected: log `fetchAndCopyOriginalOrderSpecs: no specs found on #1234`, no properties written, intake proceeds normally

**Edge case D — spec copy also fires on free-repair (Trigger 0b):**
- Add `free-repair` tag directly to a draft that has `custom.repair_order_reference` set
- Expected: same spec-copy behaviour as TC-01b, plus free-repair emails fire

**Pass / Fail:** ___

---

### TC-02 — HQ Estimate Form Loads Correctly

**Feature:** `GET /repairs/set-estimate`

**Setup:** Use the "Set Estimate & Send to Customer" link received in TC-01.

**Steps:**
1. Copy the full URL from the HQ email button.
2. Open it in a browser.

**Expected results:**

- [ ] Page loads with status 200.
- [ ] Page title: "Set Estimate — D#XXXX"
- [ ] Shows customer name, email, phone (if set), and item description.
- [ ] Shows the draft note if one was entered.
- [ ] Shows an amount input field (₹ prefix) and a submit button labelled "Send Estimate to Customer".
- [ ] Shows the "This repair is our mistake — mark as free" checkbox (yellow background).
- [ ] Checking the free checkbox disables the amount input, clears its value, and changes button label to "Mark as Free & Notify Customer".

**Pass / Fail:** ___

---

### TC-03 — Set Estimate Form: Invalid / Tampered Token Returns 400

**Feature:** `GET /repairs/set-estimate` — token validation

**Setup:** None beyond a running server.

**Steps:**
1. Open: `https://timanti-middleware.fly.dev/repairs/set-estimate?d=999999999&t=badc0ffee`

**Expected results:**

- [ ] Response is HTTP 400.
- [ ] Page shows: "Invalid or expired link."

**Pass / Fail:** ___

---

### TC-04 — Estimate Email with 3 CTAs (Trigger 1 via form)

**Feature:** `POST /repairs/set-estimate` + `handleRepairDraftUpdate` Trigger 1

**Setup:** Draft order is in state after TC-01 (has `repair-intake`, `repair-hq-notified`).

**Steps:**
1. Open the set-estimate URL from TC-01 (or from HQ email in TC-01).
2. Enter an amount, e.g. `1500`.
3. Click "Send Estimate to Customer".
4. Observe the confirmation page.
5. Wait ~5 seconds for the Shopify webhook to fire.
6. Check Fly.io logs.
7. Check `monodeep.dutta@timanti.in`.
8. Check draft order in Shopify admin.

**Expected results:**

- [ ] Form submission returns a confirmation page: "Estimate sent to customer" with ₹1,500 displayed.
- [ ] Logs contain: `✅ Estimate set for D#XXXX: ₹1500 — repair-estimate-ready added`
- [ ] Logs contain: `Repair estimate trigger: D#XXXX`
- [ ] Logs contain: `✅ Repair estimate sent: D#XXXX`
- [ ] Draft order first line item price updated to `1500.00` in Shopify admin.
- [ ] Draft order tag `repair-estimate-sent` added.
- [ ] Draft order metafield `timanti.repair_estimate_sent_at` written (ISO timestamp).
- [ ] **Estimate email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Your Timanti Repair Estimate — D#XXXX`
  - Shows item description and "Estimated Cost: Rs.1500"
  - **CTA 1** — black button: "Approve & Pay Rs.1500 Now" — links to a GoKwik short URL (gokwik.co/... or similar)
  - **CTA 2** — dark-grey button: "Approve & Pay at Store" — links to `https://timanti-middleware.fly.dev/repairs/approve-store?d={draftId}&t={32-char-hex}`
  - **CTA 3** — green-outlined button: "Ask a Question on WhatsApp" — links to `https://wa.me/917710938305?text=Hi%2C%20I%20have%20a%20question%20about%20my%20repair%20(D%23XXXX)`
  - Footer shows: "Mon–Sat, 10AM–6PM | hello@timanti.in"

**Pass / Fail:** ___

---

### TC-05 — Approve & Pay at Store: Confirmation Page Loads

**Feature:** `GET /repairs/approve-store`

**Setup:** Draft is in state after TC-04 (has `repair-estimate-sent`). Use the "Approve & Pay at Store" link from the estimate email.

**Steps:**
1. Copy the approve-store URL from the estimate email CTA 2.
2. Open it in a browser.

**Expected results:**

- [ ] Page loads with status 200.
- [ ] Page title: "Approve Repair — D#XXXX"
- [ ] Shows Timanti logo.
- [ ] Shows heading: "Approve Repair — Pay at Store"
- [ ] Shows the amount in a box: "Amount due at collection — ₹1,500"
- [ ] Shows the note: "Our team will begin the repair immediately. You'll receive a notification when your piece is ready."
- [ ] Shows black submit button: "Confirm — I'll Pay at the Store"

**Pass / Fail:** ___

---

### TC-06 — Approve & Pay at Store: Customer Confirms (Trigger 0c)

**Feature:** `POST /repairs/approve-store` + `handleRepairDraftUpdate` Trigger 0c

**Setup:** Draft is in state after TC-04. Use the approve-store URL from TC-05.

**Steps:**
1. On the page loaded in TC-05, click "Confirm — I'll Pay at the Store".
2. Observe the confirmation page.
3. Wait ~5 seconds for the Shopify webhook to fire.
4. Check Fly.io logs.
5. Check `monodeep.dutta@timanti.in`.
6. Check draft order tags in Shopify admin.

**Expected results:**

- [ ] POST returns confirmation page: "Repair confirmed — We've noted that you'll pay at the store. Our team will begin the repair on D#XXXX and you'll receive an email when it's ready to collect."
- [ ] Draft order tag `repair-store-approved` added.
- [ ] Shopify webhook fires → Trigger 0c runs.
- [ ] Logs contain: `Repair store-approve trigger: D#XXXX`
- [ ] Logs contain: `✅ Store payment approved: D#XXXX`
- [ ] **Customer email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Repair Confirmed — We'll Be in Touch (D#XXXX)`
  - Banner text: "REPAIR APPROVED — PAYMENT DUE AT STORE"
  - Heading: "Repair Confirmed — We'll Get Started"
  - Body mentions Rs.1500 due at collection
- [ ] **HQ email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Store Payment Approved — D#XXXX — [Customer Name] — Rs.1500`
  - Banner text: "PAYMENT RECEIVED — Rs.1500 · D#XXXX"
  - Contains black button: "Mark Repair Complete & Notify Customer"
  - Button URL format: `https://timanti-middleware.fly.dev/repairs/set-complete?d={draftId}&t={32-char-hex}`
- [ ] Draft order tag `repair-store-hq-notified` added.

**Pass / Fail:** ___

---

### TC-07 — Approve & Pay at Store: Already-Approved Shows Idempotent Page

**Feature:** `GET /repairs/approve-store` — already-approved guard

**Setup:** Draft already has `repair-store-approved` tag (after TC-06).

**Steps:**
1. Open the same approve-store URL from TC-05 again in a browser.

**Expected results:**

- [ ] Page loads with status 200 (not 4xx).
- [ ] Page shows heading: "Already confirmed"
- [ ] Body says: "Your repair D#XXXX has already been approved. Our team is on it."
- [ ] No new tag written to Shopify.
- [ ] No new emails sent.

**Pass / Fail:** ___

---

### TC-08 — Approve & Pay at Store: Invalid Token Returns 400

**Feature:** `GET /repairs/approve-store` — token validation

**Steps:**
1. Open: `https://timanti-middleware.fly.dev/repairs/approve-store?d=999999999&t=deadbeef`

**Expected results:**

- [ ] Response is HTTP 400.
- [ ] Page shows: "Invalid or expired link."

**Pass / Fail:** ___

---

### TC-09 — GoKwik Payment Webhook (Trigger 2)

**Feature:** `handleRepairPayment` — called from GoKwik webhook when draft has repair tags

**Setup:** Draft has `repair-estimate-sent` tag. (Use a fresh draft or continue from TC-04 before TC-05.)

**Steps:**
1. Open the GoKwik payment URL (CTA 1 from the estimate email).
2. Complete a test payment using the GoKwik sandbox card.
3. Wait ~10 seconds for the GoKwik webhook to reach the middleware.
4. Check Fly.io logs.
5. Check `monodeep.dutta@timanti.in`.
6. Check draft order in Shopify admin.

**Expected results:**

- [ ] Logs contain: `✅ Repair payment recorded: D#XXXX txn=...`
- [ ] Draft order tags: `repair-estimate-ready` and `repair-estimate-sent` removed; `repair-paid` added.
- [ ] Metafields written on the draft order:
  - `timanti.payment_status` = `paid`
  - `timanti.gokwik_transaction_id` = transaction ID string
  - `timanti.payment_amount` = amount string (e.g. `1500.00`)
  - `timanti.payment_method` = `gokwik_link`
  - `timanti.payment_date` = ISO timestamp
- [ ] **Customer payment confirmed email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Payment Confirmed — Repair in Progress (D#XXXX)`
  - Banner: "PAYMENT RECEIVED — Rs.1500"
  - Shows transaction ID, payment method "GoKwik Link", amount Rs.1500
- [ ] **HQ complete-link email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Payment Received — D#XXXX — [Customer Name]`
  - Banner: "PAYMENT RECEIVED — Rs.1500 · D#XXXX"
  - Contains "Mark Repair Complete & Notify Customer" button → `https://timanti-middleware.fly.dev/repairs/set-complete?d={draftId}&t={32-char-hex}`

**Pass / Fail:** ___

---

### TC-10 — Set Complete Form Loads Correctly

**Feature:** `GET /repairs/set-complete`

**Setup:** Use the "Mark Repair Complete & Notify Customer" link from the HQ email in TC-09 (or TC-06).

**Steps:**
1. Copy the set-complete URL from the HQ email.
2. Open it in a browser.

**Expected results:**

- [ ] Page loads with status 200.
- [ ] Page title: "Mark Complete — D#XXXX"
- [ ] Shows customer name and item description.
- [ ] Shows "Customer will collect in-store (no shipping required)" checkbox (blue background).
- [ ] Shows "Sequel Shipment ID (optional)" text input, not disabled.
- [ ] Shows two weight fields side-by-side: "Net Weight (g)" and "Gross Weight (g)" (both optional).
- [ ] Shows hint text: "Appears on the repair note — can also be set directly on the draft order in Shopify admin."
- [ ] Black button: "Notify Customer & Mark Complete".
- [ ] Checking the store-pickup checkbox: Sequel ID field becomes visually dimmed (opacity 0.35) and is disabled.

**Pass / Fail:** ___

---

### TC-11 — Set Complete: Normal (Shipping with Sequel ID, Trigger 3)

**Feature:** `POST /repairs/set-complete` + `handleRepairDraftUpdate` Trigger 3

**Setup:** Draft is in `repair-paid` state (after TC-09). Use the set-complete link from TC-10. Store-pickup checkbox is NOT checked.

**Steps:**
1. Leave the store-pickup checkbox unchecked.
2. Enter a Sequel ID, e.g. `SQ123456789IN`.
3. Enter Net Weight: `2.10`, Gross Weight: `2.45`.
4. Click "Notify Customer & Mark Complete".
5. Observe the confirmation page.
6. Wait ~5 seconds for webhook.
7. Check logs, email, and Shopify admin.

**Expected results:**

- [ ] Confirmation page: "Repair marked as complete — Sequel shipment ID SQ123456789IN has been saved — the customer will receive a tracking link."
- [ ] Logs contain: `✅ Repair complete marked: D#XXXX Sequel: SQ123456789IN`
- [ ] Metafield `timanti.repair_tracking_id` = `SQ123456789IN` written BEFORE `repair-complete` tag is added.
- [ ] Draft order tag `repair-complete` added.
- [ ] Webhook fires → Trigger 3 runs.
- [ ] Logs contain: `Repair complete trigger: D#XXXX`
- [ ] Logs contain: `✅ Repair completion notified: D#XXXX (Sequel: SQ123456789IN)`
- [ ] Draft order tag `repair-completion-notified` added.
- [ ] Metafield `timanti.repair_completed_at` written.
- [ ] First line item properties on draft order contain `_net_wt = 2.10` and `_gross_wt = 2.45`. Verify in Shopify admin: draft order → line item → properties.
- [ ] **Customer completion email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Your Repair is Ready — D#XXXX`
  - Shows shipment ID `SQ123456789IN` in large bold text
  - Contains black "Track Shipment" button → `https://www.sequellogistics.in/track-shipment?awb=SQ123456789IN`

**Pass / Fail:** ___

---

### TC-12 — Set Complete: Store Pickup Path

**Feature:** `POST /repairs/set-complete` — `storePickup = true`

**Setup:** Fresh draft order in `repair-paid` state (or the store-approval path after TC-06 — just ensure `repair-complete` and `repair-completion-notified` are not already present). Open set-complete URL.

**Steps:**
1. Check the "Customer will collect in-store" checkbox.
2. Confirm the Sequel ID field is disabled (try typing — should not be accepted).
3. Optionally enter weights.
4. Click "Notify Customer & Mark Complete".
5. Observe the confirmation page.
6. Wait ~5 seconds for webhook.
7. Check logs, email, and Shopify admin.

**Expected results:**

- [ ] Confirmation page: "The customer will receive a 'please collect at store' email for D#XXXX."
- [ ] Logs contain: `✅ Repair complete marked: D#XXXX [store pickup]`
- [ ] Metafield `timanti.repair_store_pickup` = `'true'` written BEFORE `repair-complete` tag is added (order matters — the webhook reads this metafield).
- [ ] `repair_tracking_id` metafield is NOT written (Sequel ID field was disabled).
- [ ] Draft order tag `repair-complete` added.
- [ ] Webhook fires → Trigger 3 runs.
- [ ] Metafields check in Trigger 3: `repair_store_pickup` = `'true'` is read, `storePickup` flag = `true`.
- [ ] **Customer completion email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Your Repair is Ready — Please Collect at Our Store (D#XXXX)`
  - Body says: "Please Collect at Our Store" section with store address: "17th Cross, 19th Main Rd, HSR Layout Sec 2, Bengaluru – 560102"
  - Says: "Please quote D#XXXX when you arrive. Mon–Sat, 10AM–6PM."
  - NO tracking ID and NO tracking button present.
- [ ] Draft order tag `repair-completion-notified` added.

**Pass / Fail:** ___

---

### TC-13 — Set Complete: Weights Written to Line Item Properties

**Feature:** `POST /repairs/set-complete` — `_net_wt` and `_gross_wt` properties

**Setup:** Any draft that has not yet had `repair-complete` added. Open set-complete URL.

**Steps:**
1. Enter Net Weight: `3.55`, Gross Weight: `4.10`.
2. Optionally enter Sequel ID or check store pickup (either path is fine).
3. Click "Notify Customer & Mark Complete".
4. In Shopify admin, open the draft order → click into the first line item → scroll to Properties.

**Expected results:**

- [ ] Line item shows `_net_wt: 3.55` in properties.
- [ ] Line item shows `_gross_wt: 4.10` in properties.
- [ ] Any pre-existing line item properties (e.g. `_diamond_cts`, `_diamond_pcs`) are still present and unchanged.
- [ ] Submitting with both weight fields blank: no `_net_wt` or `_gross_wt` properties are added; existing properties are unaffected.

**Pass / Fail:** ___

---

### TC-14 — Set Complete: Invalid Token Returns 400

**Feature:** `GET /repairs/set-complete` — token validation

**Steps:**
1. Open: `https://timanti-middleware.fly.dev/repairs/set-complete?d=999999999&t=badc0ffee`

**Expected results:**

- [ ] Response is HTTP 400.
- [ ] Page shows: "Invalid or expired link."

**Pass / Fail:** ___

---

### TC-15 — Free Repair via HQ Form (Trigger 0b — repair-free tag)

**Feature:** `POST /repairs/set-estimate` — free path, then `handleRepairDraftUpdate` Trigger 0b

**Setup:** Fresh draft order with `repair-intake` and `repair-hq-notified` tags set (run TC-01 first, or manually add both tags). Open the set-estimate URL from the HQ intake email.

**Steps:**
1. Check the "This repair is our mistake — mark as free" checkbox.
2. Confirm the amount input is disabled/cleared and the button label changes to "Mark as Free & Notify Customer".
3. Click "Mark as Free & Notify Customer".
4. Observe the confirmation page.
5. Wait ~5 seconds for the webhook.
6. Check logs, email, and Shopify admin.

**Expected results:**

- [ ] Confirmation page: "Marked as complimentary repair — The customer will receive a 'no charge' email for D#XXXX and your team will receive the 'Mark Complete' link when the repair is ready."
- [ ] Logs contain: `✅ Free repair marked: D#XXXX — repair-free added`
- [ ] Draft order tag `repair-free` added.
- [ ] Webhook fires → Trigger 0b runs (checks `tags.includes('repair-free') || tags.includes('free-repair')`).
- [ ] Logs contain: `Repair free trigger: D#XXXX`
- [ ] Logs contain: `✅ Free repair confirmed: D#XXXX`
- [ ] **Customer free-repair email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Great News — Complimentary Repair Confirmed (D#XXXX)`
  - Banner: "COMPLIMENTARY REPAIR — NO CHARGE"
  - Heading: "Great News — No Charge for This Repair"
  - Body: "we'll be repairing your [item] at no charge. No payment is needed from your side."
- [ ] **HQ complete-link email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Complimentary Repair — D#XXXX — [Customer Name]`
  - Banner: "COMPLIMENTARY REPAIR CONFIRMED · D#XXXX"
  - Contains "Mark Repair Complete & Notify Customer" button
- [ ] Draft order tag `repair-free-notified` added.

**Pass / Fail:** ___

---

### TC-16 — Free Repair via Staff Direct Tag (free-repair tag)

**Feature:** `handleRepairDraftUpdate` Trigger 0b — `free-repair` tag variant

**Setup:** Fresh draft order in Shopify admin. No free-repair related tags present. `repair-free-notified` must NOT be present.

**Steps:**
1. In Shopify admin, add the tag `free-repair` directly to the draft order and save.
   - Note: this is `free-repair` (hyphenated, staff-direct), NOT `repair-free` (which is set by the estimate form).
2. Wait ~5 seconds.
3. Check logs, email, and Shopify admin.

**Expected results:**

- [ ] Logs contain: `Repair free trigger: D#XXXX`
- [ ] Logs contain: `✅ Free repair confirmed: D#XXXX`
- [ ] **Customer free-repair email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Great News — Complimentary Repair Confirmed (D#XXXX)`
  - Same content as TC-15.
- [ ] **HQ complete-link email** received at `monodeep.dutta@timanti.in`:
  - Subject: `Complimentary Repair — D#XXXX — [Customer Name]`
- [ ] Draft order tag `repair-free-notified` added.
- [ ] The trigger does NOT fire a second time if `repair-free-notified` is already present (idempotency guard).

**Pass / Fail:** ___

---

### TC-17 — Dedup Guards: No Double-Firing on Re-Save

**Feature:** All trigger guards (`repair-hq-notified`, `repair-estimate-sent`, `repair-store-hq-notified`, `repair-free-notified`, `repair-completion-notified`)

**Setup:** Use a draft order that has already completed a full trigger (e.g. after TC-01: it has both `repair-intake` AND `repair-hq-notified`).

**Steps:**
1. In Shopify admin, save the draft order again (make a trivial change, e.g. change the note) without removing any tags.
2. Wait ~5 seconds.
3. Check logs.

**Expected results:**

- [ ] Logs do NOT contain a second `Repair intake trigger:` entry.
- [ ] No new emails received at `monodeep.dutta@timanti.in`.
- [ ] Tags remain unchanged.

Repeat this check for any other trigger state (estimate-sent, store-hq-notified, free-notified, completion-notified).

**Pass / Fail:** ___

---

### TC-18 — Trigger 3: Repair Complete (No Sequel ID, No Store Pickup)

**Feature:** `handleRepairDraftUpdate` Trigger 3 — fallback path

**Setup:** Draft in `repair-paid` or `repair-store-hq-notified` state. Open set-complete URL.

**Steps:**
1. Leave store-pickup unchecked.
2. Leave Sequel ID blank.
3. Leave weight fields blank.
4. Click "Notify Customer & Mark Complete".
5. Check email.

**Expected results:**

- [ ] Confirmation page: "The customer will receive a 'repair is ready' email for D#XXXX."
- [ ] **Customer completion email** received:
  - Subject: `Your Repair is Ready — D#XXXX`
  - No tracking section shown — falls back to: "Our team will be in touch shortly to arrange return delivery or in-store pickup. If you haven't heard from us in 24 hours, please call +91-7710938305."
  - No tracking button present.
- [ ] Tags: `repair-completion-notified` added.
- [ ] Metafield `timanti.repair_completed_at` written.

**Pass / Fail:** ___

---

## Full Lifecycle Smoke Test

Run after all individual test cases pass. Use a single fresh draft order through every step.

| Step | Action | Key Check |
|------|--------|-----------|
| 1 | Set `custom.repair_order_reference = #XXXX` on draft, add `repair-intake` tag | `repair-hq-notified` added, 2 emails, specs copied to line item properties |
| 2 | HQ clicks estimate link, enters ₹1500 + SKU ID | `repair-estimate-ready` → `repair-estimate-sent`, estimate email with 3 CTAs, `timanti.sku_id` metafield written |
| 3 | Customer clicks GoKwik CTA, pays | `repair-paid`, payment confirmed emails |
| 4 | HQ clicks set-complete, enters Sequel ID + post-repair weights | `repair-complete` → `repair-completion-notified`, tracking email, `_gross_wt`/`_net_wt` in line item properties |
| Pass/Fail | | |

Alternative lifecycle (store approval):

| Step | Action | Key Check |
|------|--------|-----------|
| 1 | Add `repair-intake` tag | `repair-hq-notified` added, 2 emails received |
| 2 | HQ clicks estimate link, enters ₹1500 | Estimate email with 3 CTAs |
| 3 | Customer clicks "Approve & Pay at Store" | `repair-store-approved` → `repair-store-hq-notified`, store-approve emails |
| 4 | HQ clicks set-complete, checks store-pickup | `repair-complete` → `repair-completion-notified`, store-pickup email |
| Pass/Fail | | |

---

## Tag Lifecycle Reference

| Tag | Set by | Triggers | Guards against |
|-----|--------|----------|----------------|
| `repair-intake` | Staff (Shopify admin) | Trigger 0: HQ intake email + customer acknowledgement | — |
| `repair-hq-notified` | Middleware (Trigger 0) | — | Prevents Trigger 0 re-firing |
| `repair-free` | Middleware (`/repairs/set-estimate` free path) | Trigger 0b: complimentary emails | — |
| `free-repair` | Staff (Shopify admin, direct tag) | Trigger 0b: complimentary emails (same as `repair-free`) | — |
| `repair-free-notified` | Middleware (Trigger 0b) | — | Prevents Trigger 0b re-firing for either free tag |
| `repair-store-approved` | Middleware (`POST /repairs/approve-store`) | Trigger 0c: store-approval emails | — |
| `repair-store-hq-notified` | Middleware (Trigger 0c) | — | Prevents Trigger 0c re-firing |
| `repair-estimate-ready` | Middleware (`/repairs/set-estimate` paid path) | Trigger 1: estimate email + GoKwik link | — |
| `repair-estimate-sent` | Middleware (Trigger 1) | — | Prevents Trigger 1 re-firing |
| `repair-paid` | Middleware (`handleRepairPayment` / GoKwik webhook) | — | Replaces `repair-estimate-ready` + `repair-estimate-sent` |
| `repair-complete` | Middleware (`POST /repairs/set-complete`) | Trigger 3: completion email | — |
| `repair-completion-notified` | Middleware (Trigger 3) | — | Prevents Trigger 3 re-firing |
| `repair-returned` | Staff (Shopify admin) | None (end-of-lifecycle marker only) | — |

**Token generation summary:**
- Estimate form / set-estimate link: `HMAC-SHA256(SHOPIFY_WEBHOOK_SECRET, draftId)` → first 32 hex chars
- Set-complete link: `HMAC-SHA256(SHOPIFY_WEBHOOK_SECRET, "complete:{draftId}")` → first 32 hex chars
- Approve-store link: `HMAC-SHA256(SHOPIFY_WEBHOOK_SECRET, "store-approve:{draftId}")` → first 32 hex chars

All tokens are deterministic — regenerating for the same draft always produces the same URL, so HQ can safely be sent the same link again if they lose their email.

---

## Known Gotchas

### 1. REPAIR_TEST_EMAIL intercepts everything
`REPAIR_TEST_EMAIL` is hardcoded (not an env var) on line 19 of `services/repairs/index.js`. While it is set, **all** repair emails — both customer-facing and HQ-internal — go to `monodeep.dutta@timanti.in`. HQ_CC_EMAIL is also stripped. Remember to remove or null this constant before going live.

### 2. Metafields must be written before the tag
For store pickup and tracking ID, `writeDraftOrderMetafields` is called before the PUT that adds `repair-complete`. If the middleware crashes between these two calls, the tag will be missing but the metafield will exist — safe to retry. Do not manually add `repair-complete` before running set-complete, as the metafield would never be written.

### 3. Trigger 0c fires on repair-store-approved — not on the POST response
`POST /repairs/approve-store` only adds the `repair-store-approved` tag and returns the confirmation page. The customer and HQ emails are sent by `handleRepairDraftUpdate` when the Shopify webhook fires. If the webhook is delayed, emails will be delayed. Watch logs for `Repair store-approve trigger:`.

### 4. GoKwik must create a payment link for Trigger 1
Trigger 1 (`repair-estimate-ready`) calls `createPaymentLink` via `services/gokwik`. If GoKwik returns an error, the entire trigger is aborted — `repair-estimate-sent` is NOT added and no email is sent. The form can be resubmitted safely because the tag guard checks for `repair-estimate-sent`, not `repair-estimate-ready`. Watch logs for `GoKwik link failed for`.

### 5. WhatsApp URL uses the repairs number (+917710938305)
The WhatsApp CTA in the estimate email and the "Need Help?" footers in estimate-related emails use `+91-7710938305`. The deposit/standard emails use `+91-7738868305`. Do not mix these up.

### 6. Webhook must be registered for draft_orders/update in Shopify
`handleRepairDraftUpdate` is called from the `/api/shopify-draft-updated` handler in `server.js`. Verify the `draft_orders/update` webhook is active and pointing at `https://timanti-middleware.fly.dev/api/shopify-draft-updated`. If the webhook is missing or misconfigured, no triggers will fire even though tags are being updated correctly.

### 7. Trigger 0b handles both repair-free and free-repair with one guard
The check `hasFreeTag && !tags.includes('repair-free-notified')` uses a single dedup tag regardless of which free tag triggered it. If a draft has `repair-free` set, fires and gets `repair-free-notified`, and then staff later adds `free-repair` directly — it will NOT fire again. This is the intended behaviour.

### 8. Re-triggering after a failed run
If an email failed partway through (e.g. Resend error during Trigger 0 after the HQ email but before the ack), the tag `repair-hq-notified` will NOT have been added (the tag update happens after both emails succeed or fail). Remove the blocking tag guard if present, and re-save the draft to retrigger. For Trigger 1 specifically: if `repair-estimate-ready` was added but `repair-estimate-sent` was not (GoKwik/Resend failure), removing `repair-estimate-ready` and then having HQ resubmit the estimate form is the safest path.

### 9. Shopify API version pinned to 2024-01
All Shopify REST calls use `/admin/api/2024-01/`. If this version is deprecated, update `SHOPIFY_STORE_URL` references in `services/repairs/index.js` and `writeDraftOrderMetafields`.

### 10. Store address is hardcoded in buildRepairCompleteHtml
The store address "17th Cross, 19th Main Rd, HSR Layout Sec 2, Bengaluru – 560102" is in the email template in `emailService.js`. If the store moves, update that template directly.

### 11. fetchAndCopyOriginalOrderSpecs runs after emails, never blocks them
The spec-copy call is the last thing in Trigger 0 and 0b. If it throws (network error, Shopify API down), it is wrapped in try/catch and only logs a warning — intake emails are already sent and tags already written before this runs. A failed spec copy does not retrigger; staff can manually add line item properties if needed.

### 12. repair_order_reference format — include the # prefix
The Shopify orders API `name` parameter matches on the full order name including the `#`. Set the metafield value as `#1234` not `1234`. Both work in practice (Shopify matches on the number part too) but `#1234` is canonical and avoids ambiguity.

### 13. Spec copy only runs once — no re-copy on re-save
`fetchAndCopyOriginalOrderSpecs` runs every time Trigger 0 fires, but Trigger 0 is guarded by `repair-hq-notified`. Once that tag is present, the trigger (and therefore the spec copy) will not run again. If specs need to be refreshed (e.g. wrong order reference was set), remove `repair-hq-notified` and re-save the draft — this re-runs the full Trigger 0 including spec copy.
