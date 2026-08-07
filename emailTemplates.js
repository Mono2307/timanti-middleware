// ─────────────────────────────────────────────────────────────────────────────
// emailTemplates.js
// v2 customer-facing email templates — after-sales series.
//
// Visual spec is lifted from timanti_email_preview_full_v2.html: 600px shell,
// 120px logo, 22px/600 heading, 14px/#555 body, summary rows right-aligned at
// 45%, and the four-part standard footer (Need help → social → promises →
// policy links) that must be IDENTICAL across every email in the series.
//
// Layout is table-based on purpose. The HTML previews use flexbox; real email
// clients (Outlook in particular) do not, so anything that has to survive a
// customer's inbox is built with tables here.
// ─────────────────────────────────────────────────────────────────────────────

const LOGO_URL      = 'https://cdn.shopify.com/s/files/1/0775/8322/0993/files/WhatsApp_Image_2026-04-23_at_10.42.47_AM.jpg?v=1777029219';
const SUPPORT_PHONE = '+91 7710968305';
const SUPPORT_EMAIL = 'hello@timanti.in';
const STORE_ADDRESS = '17th Cross, 19th Main Rd, HSR Layout Sec 2, Bengaluru – 560102';
const SITE_URL      = 'https://www.timanti.in';

// Store Google listing — used by the voucher expiry email.
const STORE_MAP_URL = process.env.STORE_MAP_URL || SITE_URL;
// Catalogue landing for "Browse New Arrivals".
const CATALOGUE_URL = process.env.CATALOGUE_URL || SITE_URL;

// NOTE: not yet confirmed by the business. Single point of change.
const REPAIR_TURNAROUND = '10 to 15 days';

const PROMISES = [
  { img: 'https://cdn.shopify.com/s/files/1/0775/8322/0993/files/icon1_10925c66-b900-4920-a93c-49753bce74cf.png?v=1770206196', label: 'BIS Hallmarked<br>Gold' },
  { img: 'https://cdn.shopify.com/s/files/1/0775/8322/0993/files/icon6.png',                                                   label: 'IGI Certified<br>Diamonds' },
  { img: 'https://cdn.shopify.com/s/files/1/0775/8322/0993/files/icon2_1d5faa97-53c3-44c7-9b2a-04ca57696e11.png?v=1770206090', label: 'Lifetime<br>Exchange' }
];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n) => 'INR ' + Number(n || 0).toLocaleString('en-IN');

// ── shell ────────────────────────────────────────────────────────────────────

function head() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width">
  <style>
    body, p, td, span, li { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; }
    h2, h3 { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; }
    a { text-decoration: none; }
  </style>
</head>
<body style="background:#d8d8d8; margin:0; padding:20px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background:#ffffff; border:1px solid #cccccc;">
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:18px 40px 14px;">
          <img src="${LOGO_URL}" alt="Timanti" width="120" style="max-width:120px; height:auto; display:block;">
        </td></tr>
      </table>`;
}

function foot() {
  return `
    </td></tr>
  </table>
  </td></tr></table>
</body>
</html>`;
}

// Heading + optional body copy + optional buttons + optional grey timeline box.
function contentBlock({ ref, heading, body, buttonsHtml, storeLinkHtml, timelineHtml }) {
  return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:24px 40px 18px; text-align:center;">
          ${ref ? `<p style="font-size:13px; color:#999999; margin:0 0 5px;">${esc(ref)}</p>` : ''}
          <h2 style="font-size:22px; font-weight:600; color:#111111; margin:0 0 12px;">${heading}</h2>
          ${body ? `<p style="font-size:14px; color:#555555; line-height:1.65; margin:0 0 18px;">${body}</p>` : ''}
          ${buttonsHtml || ''}
          ${storeLinkHtml || ''}
          ${timelineHtml || ''}
        </td></tr>
      </table>`;
}

function button(label, href, alt) {
  const bg = alt ? '#444444' : '#000000';
  return `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:5px auto;"><tr>
    <td style="background:${bg}; border-radius:4px;" align="center">
      <a href="${href}" target="_blank" style="display:inline-block; color:#ffffff; font-size:14px; font-weight:500; padding:13px 26px;">${esc(label)}</a>
    </td></tr></table>`;
}

function storeLink(label, href) {
  return `<p style="font-size:14px; margin:8px 0 0;"><a href="${href}" target="_blank" style="color:#fc7d27;">${esc(label)}</a></p>`;
}

function timeline(innerHtml) {
  return `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:14px auto 0; max-width:460px;"><tr>
    <td style="background:#f6f6f6; border-radius:4px; padding:12px 16px; font-size:12px; color:#888888; line-height:1.5; text-align:center;">${innerHtml}</td>
  </tr></table>`;
}

// A bordered section with an 8px grey rule above it — the v2 section divider.
function section(innerHtml) {
  return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-top:8px solid #f5f5f5; padding:20px 40px;">${innerHtml}</td></tr>
      </table>`;
}

function h3(text) {
  return `<h3 style="font-size:15px; font-weight:600; color:#111111; margin:0 0 12px;">${esc(text)}</h3>`;
}

// Item row. imageUrl comes from the ORIGINAL order via _image_url on the repair
// draft's line-item properties; falls back to the Timanti diamond mark.
function itemRow({ title, qty, variant, imageUrl }) {
  const thumb = imageUrl
    ? `<img src="${imageUrl}" width="60" height="60" alt="" style="width:60px; height:60px; border-radius:4px; display:block; object-fit:cover;">`
    : `<div style="width:60px; height:60px; background:#f8f2ea; border-radius:4px; line-height:60px; text-align:center; font-size:22px; color:#c9a96e;">&#9670;</div>`;
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid #f0f0f0;">
      <tr>
        <td width="60" valign="top" style="padding:12px 14px 12px 0;">${thumb}</td>
        <td valign="top" style="padding:12px 0; text-align:left;">
          <div style="font-weight:600; color:#111111; font-size:15px;">${esc(title)}</div>
          ${qty     ? `<div style="font-size:14px; color:#555555; margin-top:1px;">Qty: ${esc(qty)}</div>` : ''}
          ${variant ? `<div style="font-size:13px; color:#888888;">${esc(variant)}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

// Right-hand summary block, indented to 45% like the v2 order summary.
function summary(rows) {
  const body = rows.map(r => {
    const isTotal = !!r.total;
    const labelStyle = isTotal
      ? 'font-size:15px; color:#333333; font-weight:600;'
      : 'font-size:15px; color:#999999;';
    let valueColor = '#333333';
    if (isTotal) valueColor = '#111111';
    if (r.tone === 'refund') valueColor = '#16a34a';
    if (r.tone === 'due')    valueColor = '#dc2626';
    const valueStyle = `font-size:16px; color:${valueColor}; font-weight:${isTotal ? '600' : '500'};`;
    const border = isTotal ? 'border-top:2px solid #e5e5e5; padding-top:8px;' : '';
    return `<tr>
      <td style="${labelStyle} padding:3px 0; ${border}">${esc(r.label)}</td>
      <td align="right" style="${valueStyle} padding:3px 0; ${border}">${esc(r.value)}</td>
    </tr>`;
  }).join('');
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
      <td width="45%"></td>
      <td><table width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table></td>
    </tr></table>`;
}

function note(text) {
  return `<p style="font-size:12px; color:#666666; line-height:1.5; margin:14px 0 0; text-align:left;">${text}</p>`;
}

// Hyperlink bullets — used for the refund options and balance settlement.
function bullets(items) {
  const lis = items.map(i => `<li style="font-size:14px; color:#444444; line-height:1.75; margin-bottom:6px;">${i}</li>`).join('');
  return `<ul style="text-align:left; max-width:430px; margin:16px auto 0; padding-left:20px;">${lis}</ul>`;
}

// ── standard footer — one definition, used by every email ─────────────────────

function standardFooter() {
  const promises = PROMISES.map(p => `
    <td align="center" style="padding:0 13px;">
      <img src="${p.img}" width="44" height="44" alt="" style="width:44px; height:44px; display:block; margin:0 auto 6px;">
      <span style="font-size:12px; color:#333333; line-height:1.4;">${p.label}</span>
    </td>`).join('');

  return `
      <!-- Need help -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-top:8px solid #f5f5f5; padding:20px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e6d8cc; border-radius:8px;">
            <tr><td align="center" style="padding:20px;">
              <h3 style="font-size:16px; font-weight:500; color:#111111; margin:0 0 8px;">Need help?</h3>
              <p style="font-size:14px; color:#666666; margin:0 auto 16px; max-width:460px; line-height:1.6;">For any help with your order, please call or WhatsApp us on the number below, or reply to this email with your query and our customer team will get back to you.</p>
              <table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
                <td align="center" valign="top" style="padding:0 18px;">
                  <img src="https://cdn.simpleicons.org/whatsapp/25D366" width="26" height="26" alt="" style="display:block; margin:0 auto 6px;">
                  <strong style="color:#000000; font-size:13px;">Call / WhatsApp</strong><br>
                  <a href="tel:${SUPPORT_PHONE.replace(/\s/g, '')}" style="color:#fc7d27; font-weight:600; text-decoration:underline; font-size:13px;">${SUPPORT_PHONE}</a>
                </td>
                <td align="center" valign="top" style="padding:0 18px;">
                  <img src="https://api.iconify.design/mdi/email-outline.svg?color=%23333333" width="26" height="26" alt="" style="display:block; margin:0 auto 6px;">
                  <strong style="color:#000000; font-size:13px;">Email us</strong><br>
                  <a href="mailto:${SUPPORT_EMAIL}" style="color:#fc7d27; font-weight:600; text-decoration:underline; font-size:13px;">${SUPPORT_EMAIL}</a>
                </td>
              </tr></table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <!-- Social -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-top:8px solid #f5f5f5; padding:20px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f6; border-radius:8px;">
            <tr><td align="center" style="padding:20px;">
              <h3 style="font-size:16px; font-weight:600; color:#000000; margin:0 0 10px;">We hope you loved the experience so far!</h3>
              <p style="font-size:13px; color:#444444; margin:0 auto 16px; max-width:440px; line-height:1.6;">Please follow us on Instagram and leave us a review on Google. It would mean the world to us.</p>
              <table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
                <td style="padding:0 5px;">
                  <table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff; border:1.5px solid #000000; border-radius:6px;"><tr>
                    <td style="padding:9px 14px;"><a href="https://instagram.com/timanti.official" target="_blank" style="color:#000000; font-size:13px; font-weight:600;"><img src="https://cdn.simpleicons.org/instagram/E4405F" width="14" height="14" alt="" style="vertical-align:middle;">&nbsp;Follow @timanti.official</a></td>
                  </tr></table>
                </td>
                <td style="padding:0 5px;">
                  <table cellpadding="0" cellspacing="0" border="0" style="background:#ffffff; border:1.5px solid #000000; border-radius:6px;"><tr>
                    <td style="padding:9px 14px;"><a href="${STORE_MAP_URL}" target="_blank" style="color:#000000; font-size:13px; font-weight:600;"><img src="https://api.iconify.design/logos/google-icon.svg" width="14" height="14" alt="" style="vertical-align:middle;">&nbsp;Review us on Google</a></td>
                  </tr></table>
                </td>
              </tr></table>

              <!-- WhatsApp opt-in + unsubscribe, grouped and set below the reviews -->
              <table align="center" cellpadding="0" cellspacing="0" border="0" style="margin:34px auto 0; max-width:400px; border-top:1px solid #e4e4e4;"><tr>
                <td align="center" style="padding:18px 0 0;">
                  <p style="margin:0;"><a href="${SITE_URL}" target="_blank" style="color:#fc7d27; font-weight:600; text-decoration:underline; font-size:13px;">Get WhatsApp updates on new collections &amp; offers</a></p>
                  <p style="font-size:10px; color:#bbbbbb; line-height:1.5; margin:9px auto 0; max-width:340px;">By joining WhatsApp updates you consent to receive marketing messages. Unsubscribe anytime.</p>
                </td>
              </tr></table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <!-- Promises -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-top:8px solid #f5f5f5; padding:20px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F6F6; border-radius:8px;">
            <tr><td align="center" style="padding:18px;">
              <table align="center" cellpadding="0" cellspacing="0" border="0"><tr>${promises}</tr></table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <!-- Policy links -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="background:#F6F6F6; padding:16px 40px; text-align:center;">
          <a href="${SITE_URL}/pages/return-refund-policy" style="color:#fc7d27; font-size:14px;">Return &amp; Refund Policy</a>
          &nbsp;|&nbsp;
          <a href="${SITE_URL}/pages/lifetime-exchange-upgrade" style="color:#fc7d27; font-size:14px;">Lifetime Exchange &amp; Upgrade</a>
        </td></tr>
      </table>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// REPAIR SERIES
// ═════════════════════════════════════════════════════════════════════════════

// 1 — Jewellery received. Deliberately vague: no customer name, no fault
// description, no timeline. Nothing here can be contradicted by the estimate.
function buildRepairReceivedHtml({ draftRef, item }) {
  return head()
    + contentBlock({
        ref: `Repair ID: ${draftRef}`,
        heading: `We've received your jewellery for repair`,
        body: 'Our team will review your request and send the estimate soon.'
      })
    + section(h3('Repair summary') + itemRow(item))
    + standardFooter()
    + foot();
}

// 2 — Estimated charges. The "approximate and may vary" line is what licenses
// the final email to revise the number; do not remove it.
function buildRepairEstimateV2Html({ draftRef, item, amount, paymentUrl, approveStoreUrl, whatsappUrl }) {
  const btns = button(`Approve & Pay Now`, paymentUrl) + button('Approve & Pay at Store', approveStoreUrl, true);
  return head()
    + contentBlock({
        ref: `Repair ID: ${draftRef}`,
        heading: 'Your estimated repair charges',
        body: 'Please review the estimated charges below. These figures are approximate and may vary depending on the materials and labour required. Rest assured, our skilled artisans will handle your repair with care and expertise.',
        buttonsHtml: btns,
        storeLinkHtml: storeLink('Ask a question on WhatsApp', whatsappUrl),
        timelineHtml: timeline(`We aim to complete repairs within ${REPAIR_TURNAROUND}. This payment link is valid for 30 days.`)
      })
    + section(
        h3('Repair summary')
        + itemRow(item)
        + summary([{ label: 'Estimated charges', value: money(amount), total: true }])
      )
    + standardFooter()
    + foot();
}

// 3 — Charges confirmed. `paid` decides whether money is already in hand, which
// is what determines every branch of the final email.
function buildRepairConfirmedHtml({ draftRef, item, amount, paid }) {
  return head()
    + contentBlock({
        ref: `Repair ID: ${draftRef}`,
        heading: 'Your repair charges have been confirmed',
        body: 'Thank you for confirming your estimated repair charges. Our team has begun work on your jewellery.',
        timelineHtml: timeline(
          paid
            ? `We aim to complete repairs within ${REPAIR_TURNAROUND}.`
            : `We aim to complete repairs within ${REPAIR_TURNAROUND}. Payment will be collected when you pick up your piece.`
        )
      })
    + section(
        h3('Repair summary')
        + itemRow(item)
        + summary([{ label: paid ? 'Amount received' : 'Estimated charges', value: money(amount), total: true }])
        + note('Please note these charges could be higher or lower depending on the nature of the repair.')
      )
    + standardFooter()
    + foot();
}

// 4 — Ready for collection + final charges, merged into one email.
//
// `mode` is derived by the caller from (was money collected?) x (final vs estimate):
//   'refund'  — prepaid, final lower  → refund option bullets
//   'balance' — prepaid, final higher → settlement bullets
//   'collect' — never prepaid         → payable on collection, no refund possible
//
// trackingId is optional. Both the store address and the shipment line always
// render; the shipment reference is only a hyperlink once an AWB exists,
// otherwise it degrades to plain non-clickable text.
function buildRepairReadyFinalHtml({
  draftRef, item, mode,
  estimateAmount, finalAmount, delta,
  refundWalletUrl, refundSourceUrl, payBalanceUrl,
  trackingId, trackingUrl
}) {
  let rows;
  let actionSection = '';

  if (mode === 'refund') {
    rows = [
      { label: 'Estimated charges', value: money(estimateAmount) },
      { label: 'Final charges',     value: money(finalAmount) },
      { label: 'Refund due to you', value: money(delta), total: true, tone: 'refund' }
    ];
    // Wallet is live and clickable — it mints a voucher through /repairs/refund-wallet.
    // Source is deliberately NOT a hyperlink until the GoKwik refund route is confirmed;
    // it stays visible so the customer knows the option exists, and reads as plain text.
    actionSection = section(
      h3(`How would you like your refund of ${money(delta)}?`)
      + bullets([
          `<a href="${refundWalletUrl}" style="color:#fc7d27; font-weight:600; text-decoration:underline;">Refund to my Timanti wallet</a> — issued as a voucher, usually within a day`,
          `<span style="color:#444444;">Refund to my original payment method</span> — back to the account you paid from. <span style="color:#999999; font-size:12.5px;">To choose this, reply to this email or call us on ${SUPPORT_PHONE} and our team will arrange it.</span>`
        ])
    );
  } else if (mode === 'balance') {
    rows = [
      { label: 'Estimated charges', value: money(estimateAmount) },
      { label: 'Final charges',     value: money(finalAmount) },
      { label: 'Balance payable',   value: money(delta), total: true, tone: 'due' }
    ];
    actionSection = section(
      h3(`Settling the balance of ${money(delta)}`)
      + bullets([
          `<a href="${payBalanceUrl}" style="color:#fc7d27; font-weight:600; text-decoration:underline;">Pay ${money(delta)} now</a> — secure payment link`,
          'Or pay when you collect your piece at the store'
        ])
    );
  } else {
    rows = [
      { label: 'Estimated charges',    value: money(estimateAmount) },
      { label: 'Payable on collection', value: money(finalAmount), total: true }
    ];
  }

  const shipmentFragment = (trackingId && trackingUrl)
    ? `<a href="${trackingUrl}" target="_blank" style="color:#fc7d27; font-weight:600; text-decoration:underline;">${esc(trackingId)}</a>`
    : `<span style="color:#888888;">tracking details will follow once dispatched</span>`;

  return head()
    + contentBlock({
        ref: `Repair ID: ${draftRef}`,
        heading: 'Your jewellery is repaired and ready for collection'
      })
    + section(h3('Repair summary') + itemRow(item) + summary(rows))
    + actionSection
    + section(
        h3('Collection or delivery')
        + `<p style="font-size:12px; color:#666666; line-height:1.5; margin:0; text-align:left;">You can collect your piece from our store at ${STORE_ADDRESS}, quoting <strong>${esc(draftRef)}</strong> — or track your shipment here: ${shipmentFragment}.</p>`
      )
    + standardFooter()
    + foot();
}

// ═════════════════════════════════════════════════════════════════════════════
// CREDIT INSTRUMENTS
// ═════════════════════════════════════════════════════════════════════════════

const VOUCHER_TERMS = (value, expiry) => [
  `This voucher may only be redeemed against a purchase of value <strong>equal to or higher than</strong> the voucher value of ${money(value)}.`,
  `This voucher is valid for <strong>365 days</strong> from the date of issue and expires on <strong>${esc(expiry)}</strong>. The validity period cannot be extended under any circumstances.`,
  `Valid for <strong>one-time use only</strong>. Any unused balance remaining after redemption is forfeited and will not be re-credited.`,
  `<strong>Non-transferable</strong> — this voucher may only be redeemed by the customer named on this document. It cannot be gifted, sold, or assigned to any third party.`,
  `<strong>Cannot be combined</strong> with any other discount code, coupon, or promotional offer active on the store at the time of redemption.`,
  `<strong>Applicable on all products</strong> listed on www.timanti.in, subject to product availability at the time of redemption. Timanti does not guarantee the availability of any specific item.`,
  `This voucher is issued under <strong>Section 34 of the CGST Act, 2017</strong>, against an exchange transaction on the order referenced above.`,
  `The voucher value is based on prevailing market rates for gold and diamonds applicable to the product at the time this exchange was processed. No adjustments will be made for subsequent rate changes.`,
  `Auracarat Private Limited reserves the right to cancel or void this voucher if the original order is found to be fraudulent, disputed, or returned outside policy.`
];

const EXCHANGE_TERMS = [
  `<strong>One-time use only.</strong> This exchange note is valid for a single application, against a purchase of value <strong>equal to or higher than</strong> the exchange note value. It has been applied to the order shown above and cannot be used again.`,
  `<strong>No residual balance.</strong> Any unused balance remaining after application is forfeited. It will not be carried forward, re-credited, or refunded in any form.`,
  `<strong>Non-transferable.</strong> This exchange note may only be held and used by the customer named above. It cannot be gifted, sold, or assigned to any third party.`,
  `<strong>Cannot be combined.</strong> It cannot be used together with any other discount code, coupon code, or promotional offer active at the time of application.`,
  `<strong>Subject to availability.</strong> Applicable only to products available at the time of application. Timanti does not guarantee the availability of any specific item.`,
  `<strong>Rate basis.</strong> The exchange value is based on the prevailing market rates for gold and diamonds applicable to the product at the time this exchange was processed. No adjustment will be made for any subsequent change in those rates.`,
  `<strong>Record on your invoice.</strong> The final tax invoice for the purchase against which this exchange note has been applied carries the full details of this transaction.`,
  `<strong>Acknowledgement.</strong> An acknowledgement is created at the time this exchange note is generated and forms part of your transaction record.`,
  `<strong>Right to void.</strong> Auracarat Private Limited reserves the right to cancel or void this exchange note if the original order is found to be fraudulent, disputed, or returned outside policy.`
];

function termsSection(title, lead, terms) {
  const lis = terms.map(t =>
    `<li style="font-size:12.5px; color:#555555; line-height:1.6; margin-bottom:8px;">${t}</li>`
  ).join('');
  return section(
    h3(title)
    + (lead ? `<p style="font-size:12.5px; color:#888888; margin:0 0 12px; line-height:1.55;">${lead}</p>` : '')
    + `<ol style="margin:0 0 0 18px; padding:0; text-align:left;">${lis}</ol>`
  );
}

function buildVoucherV2Html({ customerName, cnNumber, creditValue, validUntil, originalOrder }) {
  return head()
    + contentBlock({
        ref: originalOrder ? `Original Order ${originalOrder}` : null,
        heading: 'Your Timanti Voucher',
        body: 'Your store-credit voucher is ready. Use the code below on your next purchase, online or in store.',
        timelineHtml: timeline(`Enter <strong>${esc(cnNumber)}</strong> in the discount field at checkout on <a href="${SITE_URL}" style="color:#fc7d27; font-weight:600; text-decoration:underline;">www.timanti.in</a>, or show this email to our consultant in store.`)
      })
    + section(
        h3('Voucher details')
        + summary([
            { label: 'Voucher code',  value: cnNumber },
            { label: 'Valid until',   value: validUntil },
            { label: 'Voucher value', value: money(creditValue), total: true }
          ])
      )
    + termsSection('Terms & Conditions', 'Reproduced in full from the terms printed on your voucher document.', VOUCHER_TERMS(creditValue, validUntil))
    + standardFooter()
    + foot();
}

// Sweep-driven, 30 days before expiry. One send per voucher — the caller must
// guard on the vch-expiry-reminded tag.
function buildVoucherExpiryHtml({ cnNumber, creditValue, expiryDate, originalOrder }) {
  return head()
    + contentBlock({
        ref: originalOrder ? `Original Order ${originalOrder}` : null,
        heading: 'Your voucher expires in 30 days',
        body: `A reminder that your Timanti voucher of <strong>${money(creditValue)}</strong> expires on <strong>${esc(expiryDate)}</strong>.`,
        buttonsHtml: button('Browse New Arrivals', CATALOGUE_URL),
        storeLinkHtml: storeLink('or visit our HSR Layout store', STORE_MAP_URL),
        timelineHtml: timeline(`Enter <strong>${esc(cnNumber)}</strong> in the discount field at checkout on <a href="${SITE_URL}" style="color:#fc7d27; font-weight:600; text-decoration:underline;">www.timanti.in</a>, or show this email to our consultant in store.`)
      })
    + section(
        h3('Voucher details')
        + summary([
            { label: 'Voucher code',  value: cnNumber },
            { label: 'Expires on',    value: expiryDate },
            { label: 'Voucher value', value: money(creditValue), total: true }
          ])
      )
    + standardFooter()
    + foot();
}

function buildExchangeNoteV2Html({ excNumber, excValue, oldOrder, newOrder }) {
  const rows = [{ label: 'Exchange note', value: excNumber }];
  if (newOrder) rows.push({ label: 'Applied to', value: newOrder });
  rows.push({ label: 'Value deducted', value: money(excValue), total: true, tone: 'refund' });

  return head()
    + contentBlock({
        ref: oldOrder ? `Exchanged Item — Order ${oldOrder}` : null,
        heading: 'Your Exchange Note',
        body: 'Your exchange has been applied directly to your new purchase. No action is needed.',
        timelineHtml: timeline('This exchange value has already been deducted from your new invoice. It is not a credit for future use.')
      })
    + section(h3('Exchange details') + summary(rows))
    + termsSection(
        'Exchange Note Conditions & Terms',
        'This exchange note has been applied in full to the order shown above at the time of issue. It cannot be retained, transferred, or used at a later date. The conditions below govern that application — please keep this email with your invoice.',
        EXCHANGE_TERMS
      )
    + standardFooter()
    + foot();
}

// Refund request confirmation.
function buildRefundConfirmationHtml({ orderName, item, refundMethod, refundAmount }) {
  return head()
    + contentBlock({
        ref: `Order ${orderName}`,
        heading: 'Refund request confirmation',
        body: 'Your refund has been processed to your original payment method.',
        storeLinkHtml: storeLink('Visit our online store', SITE_URL)
      })
    + section(
        h3('Items returned')
        + itemRow(item)
        + summary([
            { label: 'Refund method', value: refundMethod || '—' },
            { label: 'Total refund',  value: money(refundAmount), total: true, tone: 'refund' }
          ])
        + note('It can take up to 4 weeks for the refund to reflect in your bank account.')
      )
    + standardFooter()
    + foot();
}

module.exports = {
  buildRepairReceivedHtml,
  buildRepairEstimateV2Html,
  buildRepairConfirmedHtml,
  buildRepairReadyFinalHtml,
  buildVoucherV2Html,
  buildVoucherExpiryHtml,
  buildExchangeNoteV2Html,
  buildRefundConfirmationHtml,
  // exposed for reuse / testing
  standardFooter, itemRow, summary, section, REPAIR_TURNAROUND
};
