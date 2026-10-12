**Subject:** Timanti (timanti.in): KwikPass migration, Shopify account view, cart-code pass-through and removing the checkout coupon bar

Hi team,

We are launching a loyalty programme on timanti.in and need your help with a few changes to our GoKwik setup.

**1. Move from Simply OTP Login to KwikPass**
We want to replace our current storefront login (Simply OTP Login) with KwikPass, so customers log in once on the website and are not asked for an OTP again at checkout. Please confirm:
- KwikPass signs the customer into our Shopify store session, so Shopify's `customer` object and logged-in state are available on the storefront and in the cart, as Simply OTP does today.
- A customer logged in through KwikPass is recognised at GoKwik checkout **without a second OTP**, and their saved addresses load straight away.
- The OTP-verified phone number is saved on the Shopify customer, so the website login and the checkout identity are the same customer record.
- The migration steps, and whether existing customers keep their accounts and order history.

**2. Log in with KwikPass, but land on Shopify's own account page**
We want customers to log in through KwikPass (phone OTP / WhatsApp / Truecaller) but then see **Shopify's native customer account profile**, not a KwikPass-hosted profile view. We show loyalty status there. Our understanding of the setup is below; please confirm it, or tell us the correct approach:
- **Classic customer accounts:** we would switch Settings → Customer accounts from *new* to *classic* customer accounts, because new customer accounts enforce Shopify's own login screen. Is classic accounts required for KwikPass + native account view, or does KwikPass support Shopify's **new** customer accounts?
- **Header account icon:** it would open the KwikPass modal (`KP_LOGIN_SDK_INSTANCE.handleKpLogin()`) instead of `/account/login`.
- **Session after OTP:** on success the SDK fires `kp-data-sent` with a `kpToken`, which KwikPass uses to log the customer into Shopify's session. **How is that session created?** Shopify **Multipass is only available on Shopify Plus, and we are on the Basic plan**, so please confirm the mechanism KwikPass uses on a non-Plus store, and that it is a supported, stable flow.
- **Redirect:** after login we would send the customer to `/account`, which is Shopify's native account page. Can KwikPass do this redirect itself, as a setting, or should our theme do it?
- **Logout:** the logout link on the account page would call `KP_LOGIN_SDK_INSTANCE.handleLogout('/account/login')` so that both the Shopify session and the KwikPass token are cleared, with no login loop. Is that the recommended method?
- Please share KwikPass's documentation for the SDK (`handleKpLogin`, `handleLogout`, `kp-data-sent`), and say whether your team does this theme integration or we do.

**3. Remove the coupon / discount code section from checkout**
Please turn off the coupon entry field and the offers list on our GoKwik checkout. From now on, discount codes will be applied only in the cart on our website.

**4. Carry cart discount codes through to checkout, read-only**
Customers will apply codes in our cart drawer. Please confirm that GoKwik checkout:
- carries **every** code already on the Shopify cart into checkout and into the Shopify order's `discount_codes`. Typically this is two codes together: a single-use loyalty code (`LOY-…`, product-level, fixed amount) and a voucher code (`VCH…`, order-level);
- respects the combination rules set on those codes in Shopify (the loyalty code combines with order-level codes only);
- shows these codes read-only at checkout, with no option to edit or remove them;
- keeps the discounts if the customer's checkout phone differs from the logged-in website account.

**5. Test window**
Could you share a staging or test checkout, or a time slot, when we can run a test order with a loyalty code plus a voucher code before go-live?

Thanks,
Monodeep Dutta
Timanti
