# Staff SOP — Raising a Purchase Order

**Who:** Bengaluru store staff
**When:** Any time a customer order contains an MTO or replenishment item

---

## Overview

You don't create POs manually. You just add one line item property to the right item in Shopify — the system does the rest automatically (creates the PO, emails HQ, logs it in the tracker).

---

## Step 1 — Find the order in Shopify Admin

Go to **Orders** → find the customer order (or draft order for partial payments).

---

## Step 2 — Add `_po_type` to the correct line item

1. Open the order → click **Edit order**
2. Find the line item that needs a PO
3. Click **Add property** under that line item
4. Set:
   - **Name:** `_po_type`
   - **Value:** `mto` or `replenishment` (lowercase, no spaces)
5. Click **Save**

> The underscore prefix (`_`) hides this field from the customer-facing order confirmation email. Always use `_po_type`, never `po_type`.

**Which value to use:**

| Situation | Value |
|---|---|
| Selling a piece from physical store stock | `replenishment` |
| Customer wants a custom / bespoke piece made to order | `mto` |
| A ring sizing, engraving, or stone change | `mto` |

---

## Step 3 — Optional flags (set same way)

| Property | Values | When to use |
|---|---|---|
| `_po_priority` | `urgent` | Customer has a hard deadline (wedding, gift, travel) |
| `_target_dispatch` | `YYYY-MM-DD` | Date you need HQ to dispatch by |
| `_customer_promise` | `YYYY-MM-DD` | MTO only — date you promised the customer |
| `Special Instructions` | Free text | MTO only — engraving text, finger size, stone preference, bespoke notes. **No underscore prefix** so it appears on the PO PDF. |

---

## Step 4 — Mixed carts (MTO + physical in one order)

If a single order has both types, add `_po_type` to **each line item** separately:

- Item A (`_po_type = mto`) → generates MTO PO
- Item B (`_po_type = replenishment`) → generates separate replenishment PO

Both POs are created automatically. HQ receives separate emails for each.

---

## Step 5 — Partial payment / offline orders (draft orders)

If a customer paid partially and the order is still a **draft order** in Shopify:

1. Open the **Draft Orders** section
2. Find the draft → Edit
3. Add `_po_type` to the relevant line item (same as above)
4. Save

The system monitors draft order updates as well as regular orders.

---

## Step 6 — Confirm it worked

Within ~30 seconds of saving:
- A new draft order (D-number) should appear in Shopify under **Draft Orders**
- An email lands in HQ's inbox with the PO PDF and action links
- A new row appears in the [PO Tracker sheet](https://docs.google.com/spreadsheets/) (yellow = pending HQ acknowledgement)

If nothing happens after 1 minute, check that you spelled the property name and value correctly (`_po_type` / `mto` or `replenishment`).

---

## What you do NOT need to do

- Create draft orders manually for POs
- Email HQ directly about the PO
- Fill in the Sheets tracker (middleware does that)
- Follow up on status — HQ uses the action links in the email to update stages

---

## POS limitation

Shopify POS does not currently support adding custom line item properties at point of sale. **Workaround:** after the POS sale, open the order on a desktop browser (Shopify Admin), use **Edit order** to add the `_po_type` property, then save. Do this before end of day.

---

## Who to contact

Any issues with the PO system → Monodeep.
