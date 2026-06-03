# Repairs — External Communications Touchpoint Map

All customer and HQ emails are sent via **Resend** from `hello@timanti.in`.  
While `REPAIR_TEST_EMAIL` is set in `index.js`, every email (customer + HQ) is redirected to `monodeep.dutta@timanti.in`.

---

## Stage 0 — Intake

**Trigger:** Staff adds tag `repair-intake` to draft order in Shopify admin

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | HQ | Email | `New Repair Intake — D#XXXX — [Customer Name]` | Customer name, email, phone, item description, staff notes | **Set Estimate & Send to Customer** → signed URL `/repairs/set-estimate?d=...&t=...` |
| 2 | Customer | Email | `We've Received Your Item — D#XXXX` | Confirms piece received; estimate within 1–2 business days | None |

**Side effect (internal):** Middleware reads `custom.repair_order_reference`, fetches original Shopify order, copies `_gross_wt`, `_net_wt`, `_diamond_cts`, `_diamond_pcs`, `_item_title`, `_sku`, `_variant_title` onto the repair draft's line item properties.

---

## Stage 1 — Estimate Sent

**Trigger:** HQ opens the "Set Estimate" link from the Stage 0 email, enters an amount, submits. Middleware sets price on draft line item and adds tag `repair-estimate-ready` → Shopify webhook → GoKwik payment link created → estimate email sent.

| # | Recipient | Channel | Subject | Content | CTAs |
|---|-----------|---------|---------|---------|------|
| 1 | Customer | Email | `Your Timanti Repair Estimate — D#XXXX` | Item description, estimated cost | **Approve & Pay Rs.X Now** (GoKwik link) · **Approve & Pay at Store** (signed `/repairs/approve-store` URL) · **Ask a Question on WhatsApp** (`wa.me/917710938305` pre-filled with draft ref) |

> The WhatsApp CTA is customer-initiated — it opens a chat; no message is sent by the system.

---

## Stage 1B — Free / Complimentary Repair

**Trigger (path A):** HQ checks "This repair is our mistake" on the estimate form → middleware adds tag `repair-free`.  
**Trigger (path B):** Staff adds tag `free-repair` directly in Shopify admin.  
Both paths share a single dedup guard (`repair-free-notified`).

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | Customer | Email | `Great News — Complimentary Repair Confirmed (D#XXXX)` | No charge; repair will proceed; team will notify when ready | None |
| 2 | HQ | Email | `Complimentary Repair — D#XXXX — [Customer Name]` | Confirms complimentary repair; proceed when ready | **Mark Repair Complete & Notify Customer** → signed `/repairs/set-complete` URL |

---

## Stage 2A — Payment Received (Online via GoKwik)

**Trigger:** Customer pays via GoKwik link → GoKwik webhook hits `/api/gokwik-webhook` → middleware detects repair tags on draft.

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | Customer | Email | `Payment Confirmed — Repair in Progress (D#XXXX)` | Confirms Rs.X received; transaction ID; payment method; "what happens next" | None |
| 2 | HQ | Email | `Payment Received — D#XXXX — [Customer Name]` | Payment confirmed; proceed with repair | **Mark Repair Complete & Notify Customer** → signed `/repairs/set-complete` URL |

**Tags written:** `repair-paid` added; `repair-estimate-ready` + `repair-estimate-sent` removed.  
**Metafields written:** `timanti.payment_status`, `timanti.gokwik_transaction_id`, `timanti.payment_amount`, `timanti.payment_method`, `timanti.payment_date`.

---

## Stage 2B — Approved, Pay at Store

**Trigger:** Customer clicks "Approve & Pay at Store" CTA in the estimate email → lands on confirmation page at `/repairs/approve-store` → clicks confirm → middleware adds tag `repair-store-approved` → Shopify webhook.

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | Customer | Email | `Repair Confirmed — We'll Be in Touch (D#XXXX)` | Repair approved; Rs.X due when collecting at store; team will notify when ready | None |
| 2 | HQ | Email | `Store Payment Approved — D#XXXX — [Customer Name] — Rs.X` | Customer approved store payment; proceed with repair | **Mark Repair Complete & Notify Customer** → signed `/repairs/set-complete` URL |

---

## Stage 3A — Repair Complete, Dispatched via Sequel

**Trigger:** HQ opens set-complete link, enters Sequel shipment ID, submits → middleware writes `timanti.repair_tracking_id` metafield → adds tag `repair-complete` → webhook.

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | Customer | Email | `Your Repair is Ready — D#XXXX` | Repair complete; shipment ID in bold | **Track Shipment** → `sequellogistics.in/track-shipment?awb=...` |

---

## Stage 3B — Repair Complete, In-Store Pickup

**Trigger:** HQ opens set-complete link, checks "Customer will collect in-store", submits → middleware writes `timanti.repair_store_pickup = true` → adds `repair-complete` tag → webhook.

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | Customer | Email | `Your Repair is Ready — Please Collect at Our Store (D#XXXX)` | Repair complete; store address (17th Cross, HSR Sec 2, Bengaluru); quote draft ref; Mon–Sat 10AM–6PM | None |

---

## Stage 3C — Repair Complete, No Tracking

**Trigger:** HQ opens set-complete link, submits without Sequel ID and without store pickup → `repair-complete` tag → webhook.

| # | Recipient | Channel | Subject | Content | CTA |
|---|-----------|---------|---------|---------|-----|
| 1 | Customer | Email | `Your Repair is Ready — D#XXXX` | Team will be in touch to arrange return delivery or pickup; if not heard in 24 hours call +91-7710938305 | None |

---

## Full Flow Summary

```
Staff adds repair-intake
        │
        ├─► HQ: intake email + Set Estimate link
        └─► Customer: "We've received your item"

HQ submits estimate
        │
        ├─ (paid) ─► Customer: estimate email with 3 CTAs
        │                   │
        │                   ├─ CTA 1: GoKwik payment
        │                   │       └─► Customer: payment confirmed
        │                   │           HQ: mark complete link
        │                   │
        │                   ├─ CTA 2: Approve at store
        │                   │       └─► Customer: approved, pay at store
        │                   │           HQ: mark complete link
        │                   │
        │                   └─ CTA 3: WhatsApp (customer-initiated, no system message)
        │
        └─ (free) ──► Customer: complimentary repair confirmed
                      HQ: mark complete link

HQ marks complete
        │
        ├─ Sequel ID ──► Customer: repair ready + track shipment button
        ├─ Store pickup ─► Customer: please collect at store
        └─ Neither ──────► Customer: team will be in touch
```

---

## Email Sender Details

| Field | Value |
|-------|-------|
| From | `Timanti <hello@timanti.in>` |
| Service | Resend |
| Phone/WhatsApp in footers | +91-7710938305 |
| Contact email in footers | hello@timanti.in |
| Store address | 17th Cross, 19th Main Rd, HSR Layout Sec 2, Bengaluru – 560102 |

---

## What Is NOT Automated

| Touchpoint | Status | Notes |
|------------|--------|-------|
| WhatsApp messages to customer | ❌ Not automated | Estimate email has a customer-initiated WA link only |
| SMS | ❌ Not in scope | |
| Mid-repair status updates | ❌ Not in scope | No "repair in progress" update between payment and completion |
| Reminder if customer doesn't pay | ❌ Not in scope | Estimate link has no expiry logic beyond GoKwik's 7-day link |
| Collection reminder (30-day window) | ❌ Not in scope | T&C mentions 30 days; no automated chase |
