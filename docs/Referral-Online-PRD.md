# PRD: Referral programme online ("BZV online integration")

Status: **built on an unpublished theme copy, 26 Nov 2026.** Decisions taken: option A (a My Timanti page in
theme code), a 14-day referral session that restarts on every new link click, no "waiting for payment" count
on the page, an after-sales placeholder behind the same login. Theme files and edits: `theme/my-timanti/`.
Preview: `https://timanti.in/pages/my-timanti?preview_theme_id=166697074945`. In-store referral: see
`loyalty/REFERRAL.md`. Nothing here goes live until the UAT (`docs/Referral-Programme-UAT.docx`) passes.

## 1. Goal

A logged-in customer sees their benefits (tier, vouchers, referral link and rewards) on a profile page that
is built in theme code, not in an app. They share a link (to the site or to one product). A friend who buys
through that link earns the referrer a reward, and the cart prompts the referrer to use it on a later bill.

## 2. How the store is built today (read from the live theme, 25 Nov 2026)

| Fact | What it means for us |
|---|---|
| Live theme is **`auracarat/main`** (id 155385528577). 16 unpublished copies exist. | The name suggests a GitHub-connected theme. **To confirm with the developer**: if it is connected, changes go through that repo or the next sync overwrites them. |
| Customer accounts are **new customer accounts** (`NEW_CUSTOMER_ACCOUNTS`). `/account` goes to Shopify's hosted pages (`shopify.com/77583220993/account`). | The theme's `sections/main-account.liquid` is **never shown**. That is why the profile is "hidden". Hosted account pages can only be extended by an app (customer-account UI extension), which we are not doing. |
| **KwikPass** login embed is ON. OTP Login Notify is OFF. | Login is KwikPass (phone OTP). Once logged in, Liquid's `customer` object and the app proxy's `logged_in_customer_id` both work on storefront pages. The cart drawer relies on this already. |
| Our app's "My benefits" drawer embed is **OFF**. The drawer is **custom theme code**: a `<loyalty-benefits>` element in `snippets/cart-drawer.liquid` (markup about lines 877–932, script about 1550–1815). | Online loyalty already runs as theme code that calls our server through the app proxy `/apps/loyalty/*` (`/benefits`, `/apply`, `/promo`). This is the pattern to copy. |
| The drawer's `/benefits` reply already carries `referral: { available, pct, expires_at }`, but the drawer **does not show it**. | The server side is ready; the drawer needs a few lines. |
| **Nothing in the theme reads `?ref=`.** That logic was in the disabled app embed (`loyalty-benefits.js`). | Link capture has to be written into the theme. |
| Checkout is **GoKwik**: `snippets/gokwik-checkout.liquid` plus GoKwik's `merchant.integration.js`, which reads the Liquid `cart`. | Unknown whether cart attributes reach the Shopify order. A real test answers it (section 6). |

The app proxy is a server address, not an app block, so it stays. "No app on the drawer card" is met: every
visible piece is theme code.

## 3. Decision needed: where the profile lives

**Recommended: A. A "My Timanti" page in theme code (`/pages/my-timanti`)**
- New page template `templates/page.my-timanti.json` and section `sections/main-my-timanti.liquid`.
- It works with the current new customer accounts and KwikPass, with no change to logins.
- The header account icon points logged-in customers here, not to the hosted page. The page links out to
  Shopify's hosted **Orders** and **Profile** pages for order history and addresses.

**Alternative: B. Switch back to classic (legacy) customer accounts**
- `/account` would render the theme's `main-account.liquid`, which we would extend.
- Risks:
  - Shopify is phasing classic accounts out. Check the current deprecation date before choosing this.
  - KwikPass has to be checked against classic accounts.
  - Every existing customer's login experience changes.
- Choose this only if you need order history rendered inside our own page.

## 4. What to build (option A)

### 4.1 Link capture (every page)
New snippet `snippets/referral-capture.liquid`, rendered once in `layout/theme.liquid`:
1. If the URL has `?ref=CODE`, store the code in localStorage and in a first-party cookie for **N days**
   (decision: proposed 30). The most recent link wins.
2. Write cart attribute **`_referral=CODE`** with `/cart/update.js` whenever a cart exists and lacks it. Write it
   again after the cart is cleared or recreated.
3. If a customer is logged in (Liquid `customer`), POST `/apps/loyalty/referral/claim {code}` once. The server
   ignores the customer's own code and anyone who has bought before. It records "came from CODE" by customer
   id **and phone**. This is the backstop if GoKwik drops cart attributes, because KwikPass and GoKwik both
   key on the phone.
4. When the visitor logs in later (KwikPass reloads the page), step 3 runs then.

Server: no change. `claim` and order attribution already exist (order tag > `_referral` cart attribute >
landing `?ref=` > claim).

### 4.2 "My Timanti" page
Logged out: a KwikPass login button. Logged in, from `/apps/loyalty/benefits` and `/apps/loyalty/referral`:
- Greeting, tier badge, lifetime spend and progress to the next tier.
- Open vouchers with expiry dates.
- **Refer a friend**:
  - Their link, with Copy and WhatsApp share buttons.
  - "Friends who shopped: N".
  - **Rewards ready**: N × 10% off diamond value, the earliest expiry first.
  - Rewards waiting for a friend's full payment.
  - Any customer with a record gets a link, bought or not (rule changed 25 Nov).
- Links to Orders and Profile (Shopify hosted).
- The reward is always shown here, whether or not any email is sent.

### 4.3 Cart drawer prompt
In `renderBenefits()` in `snippets/cart-drawer.liquid`:
- Reward and no tier: show "Referral reward · 10% off diamonds" with Apply.
- Reward and a tier: one line naming both and saying the larger one applies, with one Apply. The server's
  `/apply` already picks the better of the two and mints one code.
- Logged out, with a stored `?ref=`: no line. The friend gets nothing.

### 4.4 Shoppable link (phase 2)
- On the product page, a "Share this piece" option appends `?ref=CODE` to the product URL. The existing
  `share-button` snippet can carry it.
- Capture (4.1) works on any page, so this needs no server change.

### 4.5 Header and menus
- The account icon goes to `/pages/my-timanti` when logged in, and to the KwikPass login when logged out.
  Both are in `sections/header.liquid` around line 259 and `snippets/header-drawer.liquid` around line 192.
- Add "My Timanti / Refer a friend" to the footer and the mobile menu.

## 5. Rules online (same engine as the store)
- 10% off the diamond value of one later bill per friend who buys. No cap, no minimum, 12 months.
- Two friends means two rewards, used on two separate later bills, never both on one bill.
- The friend pays full price. "New" means they have never bought from us. A registered account with no order counts.
- The reward stacks with the campaign, manual cuts and ISB10 (ISB10 ends 30 Nov 2026). It never stacks with loyalty:
  the larger one in rupees applies. An order-level code blocks both.
- Platinum: earns and banks rewards, but the tier benefit always wins, so they go unused.
- It unlocks when the friend's first order is fully paid. A buy plan or savings scheme counts when it completes.
- Refund before the reward is used: the reward is void. After it's used: not recovered. **Founder to approve.**

## 6. GoKwik survival test (do this first, before building 4.2/4.3)
Build only 4.1 on an **unpublished copy** of the theme, then:

| # | Do | Pass if |
|---|---|---|
| T1 | Incognito, open `?ref=CODE` on the preview theme, add the ₹1 product, check out through GoKwik **without** logging in first | The order's `note_attributes` has `_referral` → `via: link` |
| T2 | Same, but log in with KwikPass before checkout | `via: link`, or a claim row exists → `via: claim` |
| T3 | Open the link, close the tab, come back 2 days later via Google, buy | Cookie/localStorage still set; `via: link` or `claim` |
| T4 | Referrer opens their own link and buys | Row `rejected: own code` |
| T5 | Someone who bought before opens a link and buys | `rejected: not the customer's first order` |

Read the result: `GET /api/loyalty/referrals` (run on the Fly machine; `inspecting-prod-state` memory note).
If T1 fails but T2 passes, require login before checkout for referred visitors, or rely on the claim.

## 7. Open decisions
1. ~~Profile: option A or B~~ **A, built.**
2. ~~Cookie window~~ **14 days from the click; clicking a referral link again starts a new 14 days.** The theme
   stores the start (`_referral_at`), and the server ignores a cart code or login claim older than 14 days at
   order time (`referral.session_days` in the loyalty config).
3. Is `auracarat/main` GitHub-connected, and who edits the theme: the developer in that repo, or us through
   the theme API on a copy?
4. Can a non-purchasing customer refer? Built as yes; still listed as an open point.
5. The "your friend shopped" email: built and off. Not needed for the flow, because the profile and cart
   prompt the customer. Keep it off unless the founder wants it.
6. Refund rules (section 5): founder approval.
