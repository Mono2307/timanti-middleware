// ─────────────────────────────────────────
// emailService.js
// Isolated email functionality for Timanti middleware
// All Resend sends go through this module
// ─────────────────────────────────────────

const SEND_DEPOSIT_EMAIL = false; // set true to re-enable deposit confirmation emails via Resend

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────
// Core Resend sender
// ─────────────────────────────────────────

async function sendEmail({ to, subject, html, cc }) {
  const payload = { from: 'Timanti <hello@timanti.in>', to, subject, html };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log(`📧 Email sent to ${to} — id: ${data.id}`);
  return data;
}

// ─────────────────────────────────────────
// Deposit email HTML builder
// ─────────────────────────────────────────

function buildDepositEmailHtml({ draft_order_name, customer_name, total_price, amount_paid, amount_pending, deposit_status, pdf_url }) {
  const isPartial  = deposit_status === 'partial';
  const bannerBg   = isPartial ? '#fff3cd' : '#d4edda';
  const bannerText = isPartial
    ? `PARTIAL PAYMENT RECEIVED — Rs.${amount_paid} paid | Rs.${amount_pending} pending before dispatch`
    : `FULLY PAID — Rs.${amount_paid} received in full`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width">
  <style>
    body, p, td, span { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 300; margin: 0; padding: 0; }
    h2, h3, h4 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 500; margin: 0 0 10px 0; }
    a { color: #fc7d27; text-decoration: none; }
  </style>
</head>
<body style="background:#f4f4f4; padding:20px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    <tr><td>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #eeeeee;">
        <tr><td style="text-align:center; padding:24px 20px;">
          <img src="https://cdn.shopify.com/s/files/1/0775/8322/0993/files/Timanti_Logo_Black.jpg?v=1766506323" alt="Timanti" width="150">
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:${bannerBg}; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #dddddd;">
          ${bannerText}
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">Order ${draft_order_name}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">${isPartial ? 'Deposit received — thank you!' : 'Full payment received — thank you!'}</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">
            Hi <strong>${customer_name}</strong>,
            ${isPartial
              ? `your deposit of <strong>Rs.${amount_paid}</strong> has been received. Your jewellery is being held for you. The remaining balance of <strong>Rs.${amount_pending}</strong> is due before dispatch.`
              : `your full payment of <strong>Rs.${amount_paid}</strong> has been received. Your jewellery is being prepared and you will be notified when it is dispatched.`
            }
          </p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9;">
            <tr><td style="padding:20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Order Total</td>
                  <td style="font-size:13px; color:#666666; text-align:right; padding:5px 0;">Rs.${total_price}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#006630; font-weight:bold; padding:5px 0;">Amount Received</td>
                  <td style="font-size:14px; color:#006630; font-weight:bold; text-align:right; padding:5px 0;">Rs.${amount_paid}</td>
                </tr>
                ${isPartial ? `
                <tr><td colspan="2" style="border-top:1px solid #dddddd; padding-top:4px;"></td></tr>
                <tr>
                  <td style="font-size:14px; color:#cc4400; font-weight:bold; padding:5px 0;">Balance Pending</td>
                  <td style="font-size:14px; color:#cc4400; font-weight:bold; text-align:right; padding:5px 0;">Rs.${amount_pending}</td>
                </tr>` : ''}
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px 10px 30px;">
  <tr><td style="text-align:center;">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
      <tr><td style="background:#000000; border-radius:4px; text-align:center;">
        <a href="${pdf_url}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:14px 28px; font-size:14px;">Download Deposit Receipt</a>
      </td></tr>
    </table>
  </td></tr>
</table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px; font-size:14px;">${isPartial ? 'Next steps' : 'What happens next'}</h4>
          ${isPartial
            ? `<p style="font-size:13px; color:#444444; margin:4px 0;">Your piece is being held. Please complete the balance of <strong>Rs.${amount_pending}</strong> to proceed to dispatch.</p>
               <p style="font-size:13px; color:#444444; margin:4px 0;">Call or WhatsApp us at <strong>+91-7738868305</strong> or visit the store.</p>`
            : `<p style="font-size:13px; color:#444444; margin:4px 0;">Your jewellery is being prepared and quality checked.</p>
               <p style="font-size:13px; color:#444444; margin:4px 0;">You will receive a shipping confirmation with your tax invoice once dispatched.</p>`
          }
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h3 style="color:#000000; margin-bottom:12px; font-size:16px;">Need Help?</h3>
          <p style="color:#666666; font-size:13px; margin-bottom:12px;">Our team is here to assist you</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 20px; font-size:13px;"><strong>Phone/WhatsApp</strong><br><a href="tel:+917738868305" style="color:#000000;">+91-7738868305</a></td>
              <td style="padding:0 20px; font-size:13px;"><strong>Email</strong><br><a href="mailto:info@timanti.in" style="color:#000000;">info@timanti.in</a></td>
            </tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px; font-size:14px;">Stay Connected with Timanti</h4>
          <p style="font-size:13px; color:#444444; margin-bottom:12px;">Get exclusive updates on new collections, special offers, and jewelry care tips.</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background:#000000; border-radius:4px;">
              <a href="https://wa.me/917738868305?text=Yes%2C%20I%20want%20to%20receive%20WhatsApp%20updates%20from%20Timanti" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:10px 20px; font-size:13px;">Join WhatsApp Updates</a>
            </td></tr>
          </table>
          <p style="font-size:11px; color:#999999; margin-top:12px;">By clicking above, you consent to receive marketing messages from Timanti. You can unsubscribe anytime.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Questions? <a href="mailto:info@timanti.in" style="color:#fc7d27;">info@timanti.in</a> | <a href="tel:+917738868305" style="color:#fc7d27;">+91-7738868305</a></p>
          <p style="margin-top:8px;">
            <a href="https://timanti.in/pages/return-refund-policy" style="color:#fc7d27;">Returns &amp; Refunds</a> &nbsp;|&nbsp;
            <a href="https://timanti.in/pages/exchange-and-buyback" style="color:#fc7d27;">Exchange &amp; Buyback</a> &nbsp;|&nbsp;
            <a href="https://timanti.in/pages/shipping" style="color:#fc7d27;">Shipping Policy</a>
          </p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────
// Send deposit confirmation email
// Called from handlePaymentCompletion in server.js
// ─────────────────────────────────────────

async function sendDepositEmail(shopifyDraftId, draftOrderName, newAmountPaid, newAmountPending, newStatus, deposit, getShopifyToken) {
  if (!SEND_DEPOSIT_EMAIL) {
    console.log(`sendDepositEmail: disabled — skipping for ${draftOrderName}`);
    return;
  }
  let draftOrder = null;
  try {
    const token = await getShopifyToken();
    const draftRes = await fetch(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders/${shopifyDraftId}.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const draftData = await draftRes.json();
    draftOrder = draftData.draft_order;

    if (!draftOrder) {
      console.error(`sendDepositEmail: no draft_order in Shopify response:`, JSON.stringify(draftData));
      return;
    }
    if (!draftOrder.email) {
      console.log(`sendDepositEmail: draft order ${shopifyDraftId} has no email, skipping`);
      return;
    }

    // dedup check
    if (deposit) {
      if (newStatus === 'partial' && deposit.email_sent_partial) { console.log(`already sent partial email for ${draftOrderName}`); return; }
      if (newStatus === 'paid' && deposit.email_sent_paid) { console.log(`already sent paid email for ${draftOrderName}`); return; }
    }

    const pdfUrl = `https://timanti.in/apps/download-pdf/drafts/545867e5309dda498f8f/${draftOrder.id * 8461}/${draftOrderName.replace('#', '').toLowerCase()}.pdf`;

    const subject = newStatus === 'paid'
      ? `Your Timanti order ${draftOrderName} — payment received in full`
      : `Your Timanti order ${draftOrderName} — deposit of Rs.${Math.round(newAmountPaid)} confirmed`;

    const html = buildDepositEmailHtml({
      draft_order_name: draftOrderName,
      customer_name:    draftOrder.billing_address?.first_name || 'there',
      total_price:      draftOrder.total_price,
      amount_paid:      Math.round(newAmountPaid).toString(),
      amount_pending:   Math.round(Math.max(0, newAmountPending)).toString(),
      deposit_status:   newStatus,
      pdf_url:          pdfUrl
    });

    await sendEmail({ to: draftOrder.email, subject, html });

    if (deposit?.id) {
      const flag = newStatus === 'paid' ? { email_sent_paid: true } : { email_sent_partial: true };
      await supabase.from('store_deposits').update(flag).eq('id', deposit.id);
    }

  } catch (err) {
    console.error('❌ sendDepositEmail failed:', err.message);
    console.error('draftOrder at time of error:', JSON.stringify(draftOrder));
  }
}
module.exports = { sendEmail, sendDepositEmail, buildDepositEmailHtml };
