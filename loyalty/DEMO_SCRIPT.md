# Timanti Loyalty: end-to-end demo script (in-store)

**Scope:** the in-store flow on draft orders, live in Shopify admin. Online (cart → GoKwik) is an
open discussion point at the end, shown with screenshots only.
**Length:** about 25 minutes, plus discussion.
**Presenter:** Monodeep. **Screen:** Shopify admin, with a second tab on the customer profile screenshots.

---

## 0. Prep checklist (the day before)

| # | Task | Who | Done |
|---|---|---|---|
| P1 | **Backfill committed:** real orders #1038 onwards loaded, so real customers show their true tiers (Vandana Gold, Karteek, Salone and Ashish Silver) | Claude | ✅ 13 Oct |
| P2 | **Demo customer ready:** *Monodeep Dutta* (test account) shows **Gold**. It currently holds a temporary ₹6,00,000 test adjustment, removed after the demo (see §7) | Claude | |
| P3 | **Second demo customer below tier:** *Mondeep .* (test account), ₹0 | — | |
| P4 | **Birthday:** set the demo customer's birthday to a date in the demo month, so the +2% shows. Change it back afterwards | Claude | ✅ set to 13 Oct (1993-10-13) |
| P5 | **Demo draft:** **#D273** for *Monodeep Dutta*: Stellar Statement Pendant 18K YG (PD00009, diamond ₹21,200) + Silver Coin (SCOIN). Tagged `loyalty-demo`. Don't convert it | Claude | ✅ 13 Oct |
| P6 | **Dry run of the script:** run through §2 once; note the exact rupee figures for the talk track | Monodeep | |
| P7 | **Screenshots open:** `loyalty/design/` (cart card, mobile, profile block) and `loyalty/planning/GOKWIK_EMAIL.md` | Monodeep | |

> **Rule for the call:** never convert the demo draft to an order. Earning is explained, not
> performed (§4).

---

## 1. Opening: the programme in one minute (2 min)

**Say:**
> "Timanti Loyalty rewards lifetime spend. Every rupee spent counts once. There are three tiers:
> Silver at ₹2 lakh, Gold at ₹5 lakh, Platinum at ₹10 lakh. They give 3, 5 and 7 percent off the
> **diamond value** of a piece, never the gold, the making or the GST. In the customer's birthday or
> anniversary month they get 2 percent more.
> It's used on every purchase, with no cap, and it sits alongside our automatic diamond discount,
> vouchers and exchange notes. It doesn't combine with any other promotion."

**Show:** this table, either on screen or as a slide.

| Tier | Lifetime spend | Off diamond value | In birthday or anniversary month |
|---|---|---|---|
| Silver | ₹2,00,000 | 3% | 5% |
| Gold | ₹5,00,000 | 5% | 7% |
| Platinum | ₹10,00,000 | 7% | 9% |

---

## 2. In-store: a Gold customer buys a pendant (10 min)

### 2a. The staff panel recognises the customer automatically
**Click:** Draft orders → the demo draft → **More actions → Jewellery Workspace** → scroll to **Loyalty & offers**.

**Point out:**
- **Who and what tier:** the customer's name, and a **Gold member** badge with "5% off diamond (+2% birthday month)". This is read from the customer on the draft; staff look nothing up.
- **The timeline:** ₹0 → Silver → Gold → Platinum, filled to their lifetime spend.
- **Progress:** "Lifetime spend ₹6,00,000 · ₹4,00,000 more to Platinum · 20% of the way". **Say:** "Staff can tell the customer exactly how close they are to the next tier."
- **The preview, piece by piece:**
  - Pendant: "₹X off diamond ₹Y".
  - Silver coin: "not eligible". Coins (SCOIN) are excluded.
  - "Estimated saving ₹Z before GST."

### 2b. Apply it
**Click:** **Apply loyalty**. Wait about 5 seconds, then reopen or refresh the panel.

**Show on the draft line:**
- **Discount on Diamond** now includes the loyalty share, on top of the auto diamond discount.
- **Taxable value** is lower; **GST** is worked out on the reduced value.
- **Gold value and making charges** are unchanged.

**Say:**
> "The discount is taken off before GST, and only on the diamond. If staff change the diamond value or
> swap a piece, the price updates by itself. There's nothing to reapply."

### 2c. Optional live edit (if time allows)
Change the pendant's Diamond value in the panel → save → after about 5 seconds, the loyalty amount follows.

### 2d. The guard-rails
1. **Another promotion is refused.** **Click:** Apply an Adjustment → Discount → any % → apply.
   **Show:** it is refused, and the tag reads `discount-invalid: loyalty applied`.
   **Say:** "Loyalty doesn't stack with promotions; the system blocks it, not the staff member."
2. **Vouchers and exchange notes still work, and staff can see them.** Under **Available offers for this customer** the panel lists every open voucher and exchange note, with its value and expiry.
   **Click:** **Use** on the ₹500 voucher (VCH27-KATEST-0003). It shows as **On this draft** and comes off after GST, alongside loyalty.
   **Say:** "Staff no longer need to ask the customer for codes; the system shows what they have."
3. **Remove loyalty.** **Click:** **Remove loyalty** → the prices go back, and Apply is offered again.

---

## 3. A customer below tier (2 min)
**Click:** open (or create) a draft for *Mondeep .* → Jewellery Workspace → Loyalty.

**Show:** **No tier yet**, "₹2,00,000 more to Silver", "Loyalty discount starts at Silver". Apply is disabled.

**Say:**
> "Staff see the gap at the counter, which is a natural upsell line: 'one more piece and you're Silver'."

---

## 4. How points are earned (3 min, explained, not performed)

**Say:**
> - "Points are added the moment an order is created, at the value the customer paid. Installments on a
>   draft don't count until it becomes an order.
> - Refunds and exchange notes are taken back off.
> - The tier updates straight away, so the next purchase gets the new rate.
> - We loaded everyone's history from order #1038 onwards; earlier orders were tests."

**Show:** the backfill result.

| Customer | Lifetime spend | Tier |
|---|---|---|
| Vandana Reddy | ₹5,29,924 | Gold |
| P Karteek | ₹3,78,974 | Silver |
| Salone Sehgal | ₹3,22,068 | Silver |
| Ashish Singla | ₹2,38,185 | Silver |
| Jade Ranjan | ₹1,85,706 | ₹14,294 to Silver |
| Nikhila Harish Reddy | ₹1,67,109 | ₹32,891 to Silver |
| Nagesh Reddy | ₹1,65,294 | ₹34,706 to Silver |

**Say:**
> "That's 75 orders and 34 customers: 1 Gold and 3 Silver today, and three more within ₹35,000 of
> Silver. That's our first win-back list."

**Optional:** Customers → Vandana Reddy → **Metafields**: tier, points and gap; **Tags**: `loyalty-T2`.
**Say:** "These tags are what Shopify Flow and our marketing use."

---

## 5. What the customer sees (2 min, screenshots)
**Show:** `loyalty/design/profile-block-current.jpg`, the "Timanti Loyalty" block on the account page: tier, % off, the timeline, and the spend to the next tier.

**Say (be candid):**
> "Today our login app (Simply OTP) shows its own account screen, so customers don't yet reach this
> page. We plan to move to GoKwik KwikPass, and that's in the email to GoKwik."

---

## 6. Changing the rules without a developer (2 min)
**Click:** Settings → Custom data → Shop → `loyalty.program_config`.

**Say:**
> "Thresholds, percentages, the birthday bonus, the excluded products: all in this one setting. Changes
> take effect within five minutes, with no deploy."

**Don't edit it live.**

---

## 7. Open discussion: online (cart → GoKwik), not yet live

**Show:** `loyalty/design/benefits-card-preview-v1.png`, `benefits-card-preview-mobile.png`, then the GoKwik email.

**Talk track:**
- **The cart:** shows a "Your Benefits" card under the price breakdown. The customer taps **Apply** for their loyalty saving, can add a voucher code, and can open "Other available offers".
- **Behind the button:** it creates a one-time loyalty code for that cart (single use, 2-hour expiry), so the same diamond-only maths reaches the GoKwik checkout.
- **What we need from GoKwik**, i.e. the email:
  1. KwikPass login (replacing Simply OTP).
  2. Removing their coupon bar at checkout.
  3. Carrying our cart codes through to checkout, read-only (loyalty and voucher together).
  4. A test window.

**Questions to settle on the call:**
1. **Online launch:** do we launch online now, or after the GoKwik test?
2. **Birthday bonus:** every purchase in the month (today's rule), or once a year?
3. **Per-order cap:** do we want a rupee maximum on the loyalty discount per order? Today there is none.
4. **Customer messaging:** tier-upgrade email or WhatsApp, and "you're close to Silver" nudges. Who owns the copy?
5. **Staff training:** who trains the store team, and when?

---

## 8. After the call (cleanup)
- Delete the demo draft(s). Never convert them.
- Claude removes the ₹6,00,000 test adjustment from *Monodeep Dutta* and resets the test birthday.

---

## Crib sheet: likely questions

| Question | Answer |
|---|---|
| Is there a cap per transaction? | No. It applies to every eligible piece on every purchase. The only limit is that it can never exceed the diamond value. A cap can be added in the setting |
| Does the birthday bonus apply once? | Today it applies to every purchase in the birthday month (India time). Birthday and anniversary in the same month give +2%, not +4%. Both are changeable |
| Where do birthdays come from? | The customer's Shopify record, filled in by the Typeform integration. No date means no bonus |
| Can a tier go down? | Only if refunds or exchanges take lifetime spend back below the threshold. There's no annual reset |
| Which products are excluded? | Silver coins (SCOIN) and anything tagged `no-loyalty`. Pieces with no diamond value get nothing |
| What about the auto diamond discount? | Loyalty stacks on top of it, and both are diamond-only |
| What if the customer pays in installments? | The points come when the draft becomes an order, at the order value |
| What does it cost to run? | No new subscriptions; it runs on our own system |
