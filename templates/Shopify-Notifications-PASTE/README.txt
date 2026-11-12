Paste each file into Shopify admin > Settings > Notifications > (name below) > Edit code.
Select all the existing code, replace it with the file's full contents, Save. Then send a real test.

1 - Draft order invoice (advance receipt)  -> "Draft order invoice"
    CAD Advance drafts get "Your Timanti Design Advance Receipt" copy (no 21-day box, no balance note).
    Payment method now shows Card / UPI (was blank).
    Check: search the file for "design advance".
    Savings plan drafts (the "Savings Plan" line / savings-plan tag, 12 Nov 2026) get "Your Timanti Savings Plan Receipt"
    copy, "Paid into your plan so far", no 21-day box, no balance note. Check: search the file for "is_savings".

2 - Order confirmation                     -> "Order confirmation"
    Reads the draft's Channel / Ship to Customer / Order Type tags, so they finally take effect.
    Online: online email. Offline + Ship No: "Thank you for your purchase!" + tax invoice, nothing
    about shipping or making (MTO and in-stock alike). Offline + Ship Yes in-stock: "2 to 3
    business days", no 21-day line. Offline + Ship Yes MTO: "being crafted", with 21-day line.
    Check: search the file for "show_timeline".

3 - Shipping confirmation                  -> "Shipping confirmation"
    Online carries the tax invoice; offline carries tracking only. No empty "()" when carrier blank.
    Check: search the file for "tracking_company != blank".

4 - Refund                                 -> "Refund"
    No button. Shows the refund amount entered on the panel when Shopify's own amount is 0
    (offline-paid orders). Logo centred, fits phones.
    Check: search the file for "panel_refund".

These are copies of templates/Strategy/email_*.html and templates/refund-confirmation.liquid,
identical as of 2026-11-06. If one is edited later, edit the source and re-copy.
