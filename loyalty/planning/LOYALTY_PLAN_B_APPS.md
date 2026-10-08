# Loyalty Program, Plan B: Shopify App Store apps (Nector + Function Studio)

*Status: planning only, nothing built. Last updated 2026-10-07.*

## Program
The program is the same as Plan A:
- **Tiers:** ₹2L, ₹5L and ₹10L of lifetime spend, giving **3%, 5% and 7% off the diamond value only**.
- **Occasion bonus:** +2% in the birthday or anniversary month.
- **Counting spend:** at order creation, with past orders included.
- **Stacking:** loyalty can be combined only with vouchers and exchange notes.
- **Where it works:** online through GoKwik and in-store through draft orders.
- **Tier visible** in the customer account.
- **Marketing triggers.**

## Why apps, and why these two
- **The Basic-plan rule:** on Shopify Basic, a discount Function can only run inside a **public App Store app**. A Function in our own custom app needs Shopify Plus ([shopify.dev/docs/api/functions](https://shopify.dev/docs/api/functions)). Publishing our own app to the App Store and using Shopify's native checkout are both ruled out.
- **No loyalty app can discount only the diamond value**, so the work is split:
  - **Nector** (Premium, about US$349/mo) holds the tiers and runs the customer-facing experience. It is an Indian app, works with GoKwik, and has birthday and anniversary rewards, account widgets, campaigns, and GoKwik KwikEngage messaging.
  - **Function Studio** (Advanced, about US$49/mo) is a public app that contains Functions. It can give a % of a **metafield** instead of the product price, which here is the diamond value ([docs](https://function-studio.app/docs/discount-metafield-settings/)).

## Two codes in the cart
- **Shopify allows it:** the cart takes several codes at once (`/cart/update.js` with `discount: 'CODE1,CODE2'`, [Ajax Cart API](https://shopify.dev/docs/api/ajax/reference/cart)). An order can carry up to 5 product/order codes, and they combine according to each discount's combination settings ([Combining discounts](https://help.shopify.com/manual/discounts/discount-combinations)).
- **A Function-backed code** behaves like any other code.
- **GoKwik:** its own code entry is turned off. It takes the codes already on the cart and does not allow cart edits.

## Design

### 1. Tiers: Nector
- **Tier basis:** lifetime-spend VIP tiers, counted at order creation (Nector's "Reward When" setting).
- **History:** past orders are loaded through Nector's tier and purchase-history CSV import.
- **Tier written back:** Nector writes the tier to a Shopify customer metafield ("Tier level", using its Shopify Metafield integration).
- **Customer-facing:** the account widget (tier badge, progress, points history), birthday and anniversary rewards, tier-change and occasion campaigns, and WhatsApp, SMS and email through its connectors.

### 2. The discount: one Function Studio code, `TIMANTI-LOYALTY`
- **One shared code for everyone.** The rules read the customer's Nector tier metafield and give **3/5/7% of the diamond value** on each eligible line. The diamond value comes from `custom.price_breakup_diamond` online and the **Diamond** line property in-store.
- **Occasion month:** an occasion-month version of each tier adds 2%.
  - A daily **Shopify Flow** schedule (no code; available on Basic) sets and clears the `loyalty-occasion-month` tag from `custom.birthday` and `custom.anniversary`.
- **Excluded lines:** excluded SKUs and products, and lines with no diamond value, get nothing.
- **Not applicable:** a logged-out or below-tier customer gets "code not applicable".
- **Combination settings:**
  - The loyalty code is **product class and combines with order discounts**.
  - VCH and exchange-note codes are order class and combine with product discounts. This needs a change to the voucher-issuing Apps Script plus a one-time update of open codes.
  - Promo codes don't combine, so Shopify refuses a promo alongside loyalty.

### 3. Cart: the "My benefits" block (theme app extension)
- **Logged out:** "Log in to see your benefits".
- **Logged in:** everything the customer can use, each with Apply and Remove:
  - Loyalty: "Gold member: 5% off diamond value (+2% birthday month)". It is hidden below tier.
  - Open vouchers and exchange notes: code, value and expiry.
- **Applying** writes the comma-separated cart codes: at most loyalty plus one voucher or exchange note. A free-text code box stays.
- **Data source: Liquid only, no live server call.** The block reads `customer.metafields`, namely the Nector tier and `loyalty.available_codes`. The middleware keeps that JSON list current whenever a voucher or exchange note is issued, redeemed or expires.
- **Display:** Shopify's cart shows each applied code and its saving, and GoKwik's checkout is read-only.

### 4. In-store (draft orders)
1. **How the draft knows the tier:** the draft has a customer attached. The staff panel's new **Loyalty** section reads that customer's Nector tier metafield and occasion tag. Either the app gets the `read_customers` scope, or a middleware preview endpoint supplies them. It shows, for example, "Gold, 5% + 2% birthday", the eligible lines and the estimated saving.
2. **Trigger:** staff tap **Apply loyalty**, which adds `TIMANTI-LOYALTY` to the draft (draft `discountCodes`). Staff can also type it into Shopify's own draft "Add discount → code" box.
3. **Calculation:** Shopify runs the Function on the draft, using the draft's customer (the Nector tier) and each line's **Diamond** property, which staff can edit live.
4. **Invoice:** on the next draft-update webhook, the middleware copies Shopify's per-line discount into `Discount on Diamond`, `Taxable Value` and `GST`. In this "external discount" mode it does **not** take the amount off the line price a second time, and its own `apply-discount` path is blocked.
5. **Repricing:** when staff edit the Diamond prop, the middleware reprices the line and Shopify recalculates the code.
6. **Vouchers and exchange notes** stay on today's in-store flow, deducted after tax.
- **Fallback:** if the trial shows the code does not survive the middleware's line repricing (`priceOverride`), or the Function cannot read line properties on drafts, the middleware works out the in-store discount itself (Plan A §5). It still uses the Nector tier.

### 5. Middleware work still needed
- Copying the in-store discount into the invoice props.
- Keeping `loyalty.available_codes` up to date.
- Updating voucher and exchange-note code combinations.
- Recording redemptions from `orders/create`.

## Trial before committing (dev store, free app trials)
- **Function Studio:**
  - limiting a discount by the customer's tier metafield or tag;
  - using the Diamond line property as the base;
  - per-unit × quantity maths;
  - a code-type discount;
  - running on drafts that use `priceOverride`.
- **Nector:**
  - CSV lifetime import (the help article currently returns a 404);
  - draft and POS orders counted at creation;
  - the exact metafield key for the tier;
  - anniversary rewards;
  - the account widget in new customer accounts.
- **GoKwik:** the loyalty code and a VCH code both reach the order intact, including after the phone-OTP login.

## Costs and trade-offs
- **Monthly cost:** about US$400 (Nector ~US$349 + Function Studio ~US$49).
- **What the customer gets:**
  - a polished tier widget and progress bar;
  - a points and reward history;
  - referrals and gamified rewards;
  - built-in campaigns with WhatsApp, SMS and email.
- **Costs beyond the fees:**
  - the tier is held outside our system;
  - two vendor dependencies;
  - settings in two app screens;
  - several features are unconfirmed until the trial.

## Rollout
1. Trials: Function Studio, Nector and GoKwik.
2. Nector setup and history import, then check the tiers against our order data.
3. Function Studio code rules and the occasion Flow.
4. Middleware: the invoice-prop copy, `available_codes`, voucher combinations and redemption records.
5. Panel Loyalty section and the cart block, then deploy the app.
6. Campaigns in Nector.
