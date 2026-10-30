# Email live-demo workshop — every customer email, every input combination

Written 2026-10-30. Every test below is a REAL send triggered the way staff trigger it — no rendered
previews. Use one demo customer whose email is yours, so nothing reaches a real customer. Staff Bcc
(store + HQ) still receive copies; warn them.

Side effects to clean up afterwards: demo orders flow into loyalty, the MTO PO queue, recon and the
accounts digest (the middleware has no test-order exclusion). Cancel each demo order with
**Notify customer UNTICKED** (or the cancellation email fires), archive, and list the order numbers
so loyalty entries can be reversed.

---

## 0. Before the workshop — what is actually live

Shopify's API cannot read notification templates, so "what is live" = what admin holds and what the
last real send looked like. As of today:

| Template (Settings → Notifications) | Live copy (from admin, 2026-10-30) | Repo copy | Status |
|---|---|---|---|
| Draft order invoice (advance receipt) | = repo | `templates/Strategy/email_draft_order_invoice.html` | Same. Payment method prints blank for card/UPI (see A3) |
| Order confirmation | **pre-10-Oct version** | `templates/Strategy/email_order_confirmation.html` | **Live copy has no tag routing — §1 shows the result** |
| Shipping confirmation | pre-10-Oct version | `templates/Strategy/email_shipping_confirmation.html` | Live ignores `ch:offline` tag; reads the metafield only (works, since metafields exist by shipping time) |
| Refund | new design | `templates/refund-confirmation.liquid` (older) | Last real send (30 Sept, #1023) was the OLD one: blank amount, phone 7738868305. Logo has the left-align bug; width 600 fixed |

Resend (after-sales) logo/phone-width fix: deployed in commit 71dbe86.

**Decision needed before installing the order confirmation — see §1.3.**

---

## 1. Order flow — the inputs and what they do

### 1.1 The inputs (Metafield Manager → Required Inputs, on the DRAFT)

| Panel field | Metafield | Tag the panel writes on save | Read by |
|---|---|---|---|
| Order Type | `custom.order_type` | `ot:in-stock` / `ot:mto` | Advance receipt (metafield). Order confirmation ignores it by design |
| Channel | `custom.channel` | `ch:online` / `ch:offline` | Advance receipt (metafield) — phone only; Order conf (tag, repo version only); Shipping conf (metafield) |
| Ship to Customer | `custom.shipment` | `ship:yes` / `ship:no` | Order conf (tag, repo version only) |
| Send Tax Invoice in Email | `custom.in_store_sale` | adds/removes `in-store-sale` | Order conf (tag, both versions) |

Why tags: Shopify sends the order confirmation ~2s after the draft converts; the middleware copies
`custom.*` onto the order 4–20s later. The confirmation can only see what the DRAFT carried — tags.
History: #1073 (in-store-sale typed on the order after conversion → wrong email; led to the
toggle, 1 Sept), #1075 (in-store sale got the online "on its way" email because the template read
blank metafields; led to ch:/ot:/ship: tags, 10 Oct — **never installed in admin**).

### 1.2 Order confirmation — every combination (metafields blank at send, as in production)

Columns: Subj+ = subject "…here's your tax invoice"; Btn = Download Tax Invoice; Body; 21d = "usually
shipped within 21 business days"; View = View order; Wts = gross/net/dia weights; Ship = shipping row +
shipping address + Shipping Policy link; Phone.

**LIVE template (what customers get today):**

| Channel | Ship | Tax-inv toggle | Subj+ | Btn | Body | 21d | View | Wts | Ship | Phone |
|---|---|---|---|---|---|---|---|---|---|---|
| any | any | **No** | – | – | "preparing your order… on its way" | ✓ | ✓ | – | ✓ | 938 |
| any | any | **Yes** | ✓ | ✓ | "preparing your order… on its way" | – | ✓ | – | – | 938 |

Channel and Ship to Customer have **no effect at all**. Every offline sale without the toggle gets
the full ONLINE email (no tax invoice, 21-day shipping promise, shipping charges row). With the
toggle it gets a hybrid: tax-invoice subject and button, but online body, View order, no weights,
online phone. **The offline-delivery email ("dispatched in 2 to 3 business days") is unreachable.**

**REPO template (tag routing, not yet installed):**

| Channel | Ship | Tax-inv toggle | Result | Notes |
|---|---|---|---|---|
| online | any | No | ONLINE | correct |
| online | any | **Yes** | OFFLINE PICKUP (no body, weights, 968, no shipping) | toggle forces offline even on a web order |
| offline | yes | No | OFFLINE DELIVERY ("dispatched in 2 to 3 business days", Tax Invoice, shipping row + address + policy, 968) | correct |
| offline | yes | **Yes** | OFFLINE PICKUP | **delivery copy lost** — staff read "Send Tax Invoice = Yes" as harmless |
| offline | no | Yes / No | OFFLINE PICKUP | correct; toggle irrelevant — the invoice is sent either way |
| offline | blank | Yes / No | OFFLINE PICKUP | blank Ship is treated as pickup |
| blank | any | No | ONLINE | an offline sale with Channel unset gets the online email |
| blank | any | Yes | OFFLINE PICKUP | |

### 1.3 Decision needed — the toggle overlaps Channel

In the repo version the Tax-invoice toggle only matters in two places and is wrong in both
(online+Yes → pickup email; offline+delivery+Yes → delivery copy lost). Offline already sends the tax
invoice without it. Recommended rule set — one input decides one thing:

- **Channel** decides online vs offline. Offline always carries the tax invoice.
- **Ship to Customer** decides pickup vs delivery (offline only).
- **Send Tax Invoice in Email** is retired from routing (or, if kept, only shows/hides the button and
  never changes body or shipping copy).
- Channel and Ship to Customer must be filled before conversion. Today "required" is display-only
  (an asterisk); nothing stops a blank conversion.

This is a template logic change → needs hunks shown and approved before anything goes to admin.

### 1.4 Shipping confirmation — combinations (metafields present by then)

| Channel (metafield) | Toggle | Subject | Btn | Body | Phone |
|---|---|---|---|---|---|
| Online | any | "…here's your tax invoice" | ✓ | "packed with care… tax invoice and tracking below" | 938 |
| Offline | any | "…here are your tracking details" | – | "…tax invoice was sent earlier with your payment confirmation" | 968 |
| blank | any | online variant | ✓ | online | 938 |

Both versions behave the same. Note the chain: today an offline sale with the toggle off got NO
invoice in its confirmation (§1.2) and the shipping email then says "your tax invoice was sent
earlier" — **the customer never receives the invoice.**

### 1.5 Three questions answered

**Online checkout orders — who sets Channel = Online?** Nobody, and nothing needs to. A web order
never passes through a draft, so it carries no `ch:` tag, and no middleware code writes
`custom.channel` on it (only loyalty reads `source_name`). The template treats "not marked offline"
as online: the online branch is the default. There is no advance receipt for web orders (that email
is the Draft order invoice, sent only from drafts); the order confirmation is the payment
confirmation — "Your Timanti order #… confirmed", totals, GST, payment method. The shipping
confirmation then falls to its online variant (Tax Invoice button) for the same reason. Risk: the
default is online, so any OFFLINE draft that reaches conversion without `ch:offline` looks like a web
order.

**Why "Ship to Customer has no effect" — and #1075.** The field was added for exactly the right
reason. The problem is where the live template reads it from: `order.metafields.custom.shipment`.
That metafield reaches the order 4–20s AFTER the email, so it is always blank at send time. The live
template reads Channel the same way, so on #1075 Channel read blank → online branch → body "we are
preparing your order and will notify you when it is on its way" + "Items are usually shipped within
21 business days". Note the live template has no in-store-sale branch in the BODY: even with Send Tax
Invoice = Yes, that "on its way" sentence still prints. The repo template reads `ship:`/`ch:` TAGS,
which are on the draft before conversion — that is the version where Ship to Customer works. It was
written 10 Oct and never pasted into admin.

**MTO handed over at the second payment.** Order Type does NOT change the order confirmation in
either version (`is_mto` is assigned in the live file and never used). So leaving the draft as MTO
cannot produce "being made / gone to the workshop / wait" copy — and should be left as MTO, because
procurement sync uses order_type for the PO-queue tab. The "wait / shipped" wording a handover
customer sees today comes from the online default described above. With the repo template, a
handover = **Channel Offline + Ship to Customer No** → "Thank you for your purchase!", Tax Invoice
button, weights, no greeting sentence, no timeline, no shipping row/address/policy, phone 968 —
identical for MTO and in-stock. Two MTO traps remain:
- If the balance is collected with **Send invoice** (draft invoice) instead of converting, the
  advance-receipt template DOES read Order Type, and prints "Made to order pieces take up to 21
  business days" on a piece being handed over. Collect the final payment by converting, or switch
  Order Type before sending — confirm the effect on the PO queue first.
- Ship to Customer left blank is treated as pickup (safe for handover); Channel left blank is
  treated as online (wrong for handover). Channel must be enforced.

### 1.6 Phone numbers

Confirmed by the founder 2026-10-30: **7710938305 for online, 7710968305 for offline** — both are correct and intentional. Check each email shows the number for its channel. Resend after-sales emails use 968 (store-led flows).

---

## 2. Test cards — order flow

For each: set the inputs on the draft in Metafield Manager, **Save** (tags are written on save), then
act. Check the draft's Tags box shows the expected `ch:/ot:/ship:/in-store-sale` before converting.

**A1 Advance receipt — in-stock.** Inputs: Order Type in-stock, Channel Offline, Installment 1 amount
+ mode. Action: More actions → Send invoice. Expect: subject "Your Timanti Order Advance Receipt";
no order-number line; item name + qty only; single "Advance received" line = installment total;
balance note; "Download Advance Receipt"; **no** 21-day box; phone 968.

**A2 Advance receipt — MTO.** As A1 with Order Type mto. Expect the "Made to order pieces take up to 21
business days" box under the button. Everything else identical to A1.

**A3 Advance receipt — payment method.** Run A1 with mode UPI, then Card. Known bug: Payment method
prints **blank** (template matches bare `upi`/`card` tags; middleware now writes `pmodes:upi`). Cash
works by accident. Fix is in the order confirmation already (copy the `pmodes:` block).

**A4 Advance receipt — edge.** Channel unset → phone flips to 938. Installment not entered → no
"Advance received" line but the balance note still prints. Staff must save the panel before Send.

**O1 Online.** Option A: real storefront checkout with a single-use 100% code (₹0 totals) or a ₹1
product via UPI. Option B: draft with Channel Online, Mark as paid — valid only once the repo template
(tag routing) is installed. Expect: subject "Your Timanti order #… confirmed"; "Hi {name}, we are
preparing your order…"; View order; certificate note; no weights; 21-day timeline; Shipping row;
shipping + billing address; Shipping Policy link; phone 938.

**O2 Offline pickup.** Channel Offline, Ship No. Mark as paid. Expect: subject adds "here's your tax
invoice"; Tax Invoice button; no greeting body; weights; no timeline/View order/shipping row/shipping
address/Shipping Policy; phone 968.

**O3 Offline delivery.** Channel Offline, Ship Yes, toggle **No**. Expect: "your piece will be
dispatched to you in 2 to 3 business days"; Tax Invoice; weights; timeline; Shipping row + address;
Shipping Policy; 968.

**O4–O6 Combination checks** (run the cells marked bold in §1.2 to show the problem live):
O4 offline+delivery+toggle Yes; O5 online+toggle Yes; O6 offline with Channel blank.

**S1 Shipping — online.** Fulfil O1 with tracking number + carrier, Notify customer ticked. Expect:
no order line; "Your order is on the way!"; Tax Invoice button; one orange tracking line
"Tracking Number: X (Carrier)"; GST breakup; weights incl. dia ct; 938.

**S2 Shipping — offline.** Fulfil O3 the same way. Expect: subject "…here are your tracking details";
no Tax Invoice button; "tax invoice was sent earlier…"; 968.

**S3 Edge.** Carrier left blank → prints "Tracking Number: X ()". Don't use Edit tracking to re-test —
that sends the *Shipping update* template, not Shipping confirmation. Don't re-fire on real
customers' orders; fulfil a demo order.

**R1 Refund (Shopify).** Refund a demo order with Notify customer ticked. Expect the new design:
"Refund request confirmation — #…", amount, method, item table, 4-week line, 968. Check the logo is
centred on a phone.

---

## 3. Test cards — after-sales (Resend)

All from `hello@timanti.in`. Repair drafts are driven by tags + HQ forms.

| # | Email | Trigger | Look for |
|---|---|---|---|
| R1 | Received | tag `repair-intake` (needs an order reference; outside pieces need inspection) | "Repair ID: #D…"; no name/fault/timeline; item table with "Gross weight at receipt" if intake weight was entered. Internal intake email to store/HQ |
| R1b | Complimentary | `free-repair` (panel) or HQ estimate form with free=true | Old-style email (green banner) — only v1 email still sent. Known: item reads "repair" (draft line title); no item table |
| R2 | Estimate | HQ estimate form submit | Breakdown rows; total; Approve & Pay Now / Approve & Pay at Store / WhatsApp; "10 to 15 days… link valid 30 days" |
| R3a | Confirmed — paid online | pay the GoKwik link | "Amount received" = estimate; "could be higher or lower" note. Internal Payment Received with Mark Complete link |
| R3b | Confirmed — pay at store | tag `repair-store-approved` | "Payment will be collected when you pick up"; "Estimated charges" |
| R4a | Ready — refund (paid, final lower) | HQ Mark Complete with lower Final Repair Cost | Estimated / Final / Refund due (green); wallet vs original-method choice |
| R4b | Ready — balance (paid, final higher) | higher final cost | Balance payable (red); pay-now link + pay at store |
| R4c | Ready — pay at store | path R3b, then complete | **Known bug:** "Estimated charges" shows the FINAL figure, not the original estimate |
| R4d | Ready — complimentary | complete a free repair | **Known risk:** final cost 0 is read as blank → falls back to the draft price → customer asked to pay |
| R4e | Tracking vs pickup | enter a Sequel ID or leave blank | Tracking link only with a Sequel ID; pickup customers still see "tracking details will follow" |
| V1 | Voucher | Exchange Calculator → Create Voucher & Tag Order | Subject "Your Timanti Voucher — Rs.X \| Code: VCH-…" (value unformatted, e.g. Rs.28400); code/valid-until/value; 9 terms |
| V2 | Voucher expiry | daily sweep, 30 days before `cn-exp:` | Fires once per day window; guard is in-memory → a deploy that day re-sends |
| V3 | Exchange note | applied to a new draft (`/api/exc-email`) | "Value deducted"; "not a credit for future use"; 9 conditions |
| V4 | Draft refund | MFM refund button (`send-refund-email`) | Full vs partial copy; paid / refunded / pending rows |

Check every Resend email on a phone: logo centred, no horizontal clipping (fixed in 71dbe86).

---

## 4. Known problems, ranked

1. **Live order confirmation ignores Channel and Ship to Customer** — every offline sale gets online
   wording; offline-delivery copy unreachable; invoice never sent when toggle is off. Fix: install the
   repo template after the §1.3 decision.
2. **Tax-invoice toggle conflicts with Ship to Customer** (repo version): Yes on a delivery order
   drops delivery copy; Yes on an online order sends the store email. §1.3.
3. **Required inputs are not enforced** — blank Channel → online email; blank Ship → pickup.
4. **Advance receipt payment method blank** for card/UPI (`pmodes:` tags).
5. **Repair pay-at-store ready email** shows final as "estimated" (`after-sales/index.js:1090`).
6. **Complimentary repair can be billed at completion** (₹0 final read as blank, `index.js:1031`).
7. **Balance payment link on a repair** has no handler after the estimate tags are stripped — no
   confirmation email (server.js:4331).
8. **Voucher-expiry guard is in memory** — restart re-sends, downtime skips.
9. **Repair wallet-refund vouchers print exchange-only terms 7–8.**
10. **Refund template** (Shopify) — logo left-align + fixed 600 width; replace before demo.
