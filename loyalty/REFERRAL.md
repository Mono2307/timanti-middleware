# Referral programme — rollout and real-flow test

Code: `src/modules/loyalty/referral.js` (rules in its header). Schema: `src/modules/loyalty/referral.sql`.
Founder's rules (2026-11-12): the referrer gets 10% off the diamond value of one later bill, earned
when a NEW customer's first order on their link is created and fully paid (a buy plan / savings scheme
counts when it completes, not when it starts). The friend gets nothing. 12 months to use it, no cap, no
minimum. Stacks with the campaign, manual cuts and ISB10; never with loyalty (the bill gets whichever
saves more, worked out in rupees with the making cap). Platinum: no link, no rewards.

Switch off without a deploy: set `"referral": { "enabled": false }` in the `loyalty.program_config`
shop metafield.

## Go-live (in this order)

1. **Supabase**: run `src/modules/loyalty/referral.sql` in the SQL editor. (Deploying first is safe:
   every referral read falls back to plain loyalty until the tables exist.)
2. **Fly**: GitHub → Actions → `deploy.yml` → Run workflow on `main`.
3. **Shopify app**: `npx @shopify/cli app deploy -c timanti-metafield-manager-new` from
   `apps/metafield-manager`. Ships the cart embed (captures `?ref=`), the "Refer a friend" block and
   the staff panel's referral lines.
4. **Theme editor**: Online Store → Pages → add a page "Refer a friend" (handle `refer`) on a template
   that holds the app block **Refer a friend**. Link `/pages/refer` from the header account menu and
   the footer. The cart drawer embed ("My benefits (cart drawer)") must stay on: it is what reads
   `?ref=` on every page.

## Real-flow test

| # | As | Do | Expect |
|---|---|---|---|
| 1 | Referrer: a customer with a purchase, below Platinum | Log in, open `/pages/refer` | A link `https://timanti.in/?ref=NAMEXXX`, Copy and WhatsApp buttons, "Friends who shopped: 0" |
| 2 | Friend: a phone that has **never** bought | Incognito: open the link, log in with KwikPass, add the ₹1 test product, check out through GoKwik (prepaid) | Order placed at full price (no discount for the friend) |
| 3 | Operator | `GET /api/loyalty/referrals?secret=<ADMIN_API_SECRET>` | One row for the friend's order, `status: earned`, `via` = `link` (cart attribute survived GoKwik), `claim` (it did not; phone backup worked) or `landing` |
| 4 | Referrer | Reload `/pages/refer` | "1 reward ready to use: 10% off the diamond value · use by <date>" |
| 5 | Referrer | Add a diamond piece to the cart, open the drawer | "Referral reward · 10% off diamonds" (no tier) or "<Tier> member · … · or your referral reward …"; Apply gives a code worth the better of the two. No need to buy |
| 6 | Staff | Draft for the referrer with a diamond piece → Apply loyalty | Panel: "Referral reward applies …" when it beats the tier, else "Referral reward available …; the tier benefit saves more" |
| 7 | Staff | A draft for a new walk-in: add tag `ref:<code>` or `ref:<referrer's phone>` | Tag becomes `referred:<CODE>` (or `ref-invalid: <why>`); when that draft converts fully paid, step 3 shows a `via: store` row |

Rejected rows carry their reason (`own code`, `not the customer's first order`, `same phone or email as
the referrer`, `referrer is on the top tier`). After the test, delete the test rows:
`delete from referral_rewards where source_order_name in ('#....');` and cancel/refund the ₹1 order
as usual (a refund before the reward is used voids it anyway).

The referrer's "your friend shopped" email is built (`buildReferralRewardHtml`) but OFF until the
founder signs off the copy: `emails.referral_reward: true` in the config metafield.
