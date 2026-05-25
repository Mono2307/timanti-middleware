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
// ─────────────────────────────────────────
// Repair email HTML builders
// ─────────────────────────────────────────

function buildRepairEstimateHtml({ customerName, draftRef, itemDescription, amount, paymentUrl }) {
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
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">${draftRef}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">Your Repair Estimate is Ready</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customerName}</strong>, your jewellery has been assessed by our team.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9;">
            <tr><td style="padding:20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Repair</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${itemDescription}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px solid #dddddd; padding-top:4px;"></td></tr>
                <tr>
                  <td style="font-size:14px; color:#000000; font-weight:bold; padding:5px 0;">Estimated Cost</td>
                  <td style="font-size:14px; color:#000000; font-weight:bold; text-align:right; padding:5px 0;">Rs.${amount}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 30px 10px 30px;">
        <tr><td style="text-align:center;">
          <p style="font-size:13px; color:#666666; margin-bottom:16px;">To proceed, complete payment using the secure link below. This link expires in <strong>7 days</strong>.</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background:#000000; border-radius:4px; text-align:center;">
              <a href="${paymentUrl}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:14px 32px; font-size:15px;">Pay Rs.${amount} — Secure Checkout</a>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px;">
          <p style="font-size:13px; color:#444444; margin:0;">Once payment is received we will begin the repair and keep you updated on progress.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h3 style="color:#000000; margin-bottom:12px; font-size:16px;">Need Help?</h3>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 20px; font-size:13px;"><strong>Phone/WhatsApp</strong><br><a href="tel:+917710938305" style="color:#000000;">+91-7710938305</a></td>
              <td style="padding:0 20px; font-size:13px;"><strong>Email</strong><br><a href="mailto:hello@timanti.in" style="color:#000000;">hello@timanti.in</a></td>
            </tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Mon–Sat, 10AM–6PM &nbsp;|&nbsp; <a href="mailto:hello@timanti.in" style="color:#fc7d27;">hello@timanti.in</a></p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildRepairPaymentConfirmedHtml({ customerName, draftRef, amount, transactionId, paymentMethod }) {
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
        <tr><td style="background:#d4edda; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #c3e6cb;">
          PAYMENT RECEIVED — Rs.${amount}
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">${draftRef}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">Payment Confirmed — Repair in Progress</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customerName}</strong>, we've received your payment of <strong>Rs.${amount}</strong>. Your jewellery is now with our repair team.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9;">
            <tr><td style="padding:20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Reference</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${draftRef}</td>
                </tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Transaction ID</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${transactionId}</td>
                </tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Payment Method</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${paymentMethod}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px solid #dddddd; padding-top:4px;"></td></tr>
                <tr>
                  <td style="font-size:14px; color:#006630; font-weight:bold; padding:5px 0;">Amount Received</td>
                  <td style="font-size:14px; color:#006630; font-weight:bold; text-align:right; padding:5px 0;">Rs.${amount}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px; font-size:14px;">What happens next</h4>
          <p style="font-size:13px; color:#444444; margin:4px 0;">Our repair team will work on your jewellery and contact you once it is ready for pickup or delivery.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Questions? <a href="mailto:hello@timanti.in" style="color:#fc7d27;">hello@timanti.in</a> | <a href="tel:+917710938305" style="color:#fc7d27;">+91-7710938305</a></p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildRepairCompleteHtml({ customerName, draftRef, sequelId, trackingUrl }) {
  const trackingSection = sequelId && trackingUrl ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px 20px 30px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9;">
            <tr><td style="padding:20px; text-align:center;">
              <h4 style="color:#000000; margin-bottom:8px; font-size:14px;">Track Your Shipment</h4>
              <p style="font-size:13px; color:#666666; margin:0 0 10px 0;">Your repaired jewellery is on its way. Use the ID below to follow it.</p>
              <p style="font-size:20px; font-weight:bold; letter-spacing:2px; color:#000000; margin:0 0 14px 0;">${sequelId}</p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr><td style="background:#000000; border-radius:4px; text-align:center;">
                  <a href="${trackingUrl}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:12px 28px; font-size:14px;">Track Shipment</a>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>` : `
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px; font-size:14px;">Next steps</h4>
          <p style="font-size:13px; color:#444444; margin:4px 0;">Our team will be in touch shortly to arrange return delivery or in-store pickup.</p>
          <p style="font-size:13px; color:#444444; margin:8px 0 0 0;">If you haven't heard from us in 24 hours, please call <strong>+91-7710938305</strong>.</p>
        </td></tr>
      </table>`;

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
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">${draftRef}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">Your Repair is Ready</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customerName}</strong>, your jewellery repair is complete and ready for collection.</p>
        </td></tr>
      </table>

      ${trackingSection}

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Questions? <a href="mailto:hello@timanti.in" style="color:#fc7d27;">hello@timanti.in</a> | <a href="tel:+917710938305" style="color:#fc7d27;">+91-7710938305</a></p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildCreditNoteHtml({ customerName, cnNumber, creditValue, validUntil, originalOrder }) {
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
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">Original Order ${originalOrder}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">Your Exchange Credit Note</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customerName}</strong>, your exchange has been processed. Here are your credit details.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9;">
            <tr><td style="padding:20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Credit Note</td>
                  <td style="font-size:14px; color:#000000; font-weight:bold; text-align:right; padding:5px 0; letter-spacing:1px;">${cnNumber}</td>
                </tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Discount Code</td>
                  <td style="font-size:14px; color:#000000; font-weight:bold; text-align:right; padding:5px 0; letter-spacing:1px;">${cnNumber}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px solid #dddddd; padding-top:4px;"></td></tr>
                <tr>
                  <td style="font-size:14px; color:#006630; font-weight:bold; padding:5px 0;">Credit Value</td>
                  <td style="font-size:14px; color:#006630; font-weight:bold; text-align:right; padding:5px 0;">Rs.${creditValue}</td>
                </tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Valid Until</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${validUntil}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 30px 10px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px;">
          <h4 style="color:#000000; margin-bottom:10px; font-size:14px;">How to use</h4>
          <p style="font-size:13px; color:#444444; margin:4px 0;"><strong>Online:</strong> enter <strong>${cnNumber}</strong> in the discount field at checkout on timanti.in</p>
          <p style="font-size:13px; color:#444444; margin:8px 0 0 0;"><strong>In-store:</strong> show this email and quote the code to our consultant</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px 20px 30px;">
        <tr><td style="background:#fff8f0; border:1px solid #f5d9b8; border-radius:6px; padding:14px 18px; font-size:12px; color:#666666; text-align:center;">
          Your new purchase must equal or exceed Rs.${creditValue}. &nbsp;·&nbsp; Single use &nbsp;·&nbsp; Non-transferable &nbsp;·&nbsp; Cannot be extended
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Questions? <a href="mailto:hello@timanti.in" style="color:#fc7d27;">hello@timanti.in</a> | <a href="tel:+917710938305" style="color:#fc7d27;">+91-7710938305</a></p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildRepairIntakeHtml({ customerName, customerEmail, customerPhone, draftRef, itemDesc, notes, approveUrl }) {
  const notesRow = notes
    ? `<tr><td style="font-size:13px; color:#666666; padding:5px 0; vertical-align:top;">Notes</td><td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${notes.replace(/\n/g, '<br>')}</td></tr>`
    : '';
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
        <tr><td style="background:#fff3cd; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #ffc107;">
          NEW REPAIR INTAKE — ${draftRef}
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <h2 style="font-size:20px; color:#000000; margin-bottom:16px;">Repair received — estimate required</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">The item has been logged. Review the details below and set the estimate to send the customer their payment link.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:10px 30px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9;">
            <tr><td style="padding:20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Reference</td>
                  <td style="font-size:13px; color:#000000; font-weight:bold; text-align:right; padding:5px 0;">${draftRef}</td>
                </tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Customer</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${customerName}</td>
                </tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Email</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${customerEmail}</td>
                </tr>
                ${customerPhone ? `<tr><td style="font-size:13px; color:#666666; padding:5px 0;">Phone</td><td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${customerPhone}</td></tr>` : ''}
                <tr><td colspan="2" style="border-top:1px solid #dddddd; padding-top:4px;"></td></tr>
                <tr>
                  <td style="font-size:13px; color:#666666; padding:5px 0;">Item</td>
                  <td style="font-size:13px; color:#444444; text-align:right; padding:5px 0;">${itemDesc}</td>
                </tr>
                ${notesRow}
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 30px 24px 30px;">
        <tr><td style="text-align:center;">
          <p style="font-size:13px; color:#666666; margin-bottom:16px;">Click below to set the estimate amount. The customer will receive their payment link automatically.</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background:#000000; border-radius:4px; text-align:center;">
              <a href="${approveUrl}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:14px 32px; font-size:15px;">Set Estimate &amp; Send to Customer</a>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#999999;">
          <p>Timanti internal — do not forward this email</p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildRepairAcknowledgementHtml({ customerName, draftRef, itemDesc }) {
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
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">${draftRef}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">We've Received Your Item</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customerName}</strong>, we've received your <strong>${itemDesc}</strong>. Our team will review it and send you an estimate within 1–2 business days.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
          <p style="font-size:13px; color:#444444; margin:0;">You'll receive a separate email once our team has assessed your jewellery and your estimate is ready.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h3 style="color:#000000; margin-bottom:12px; font-size:16px;">Need Help?</h3>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 20px; font-size:13px;"><strong>Phone/WhatsApp</strong><br><a href="tel:+917710938305" style="color:#000000;">+91-7710938305</a></td>
              <td style="padding:0 20px; font-size:13px;"><strong>Email</strong><br><a href="mailto:hello@timanti.in" style="color:#000000;">hello@timanti.in</a></td>
            </tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Mon–Sat, 10AM–6PM &nbsp;|&nbsp; <a href="mailto:hello@timanti.in" style="color:#fc7d27;">hello@timanti.in</a></p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildRepairFreeHtml({ customerName, draftRef, itemDesc }) {
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
        <tr><td style="background:#d4edda; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #c3e6cb;">
          COMPLIMENTARY REPAIR — NO CHARGE
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">${draftRef}</p>
          <h2 style="font-size:22px; color:#000000; margin-bottom:16px;">Great News — No Charge for This Repair</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">Hi <strong>${customerName}</strong>, we'll be repairing your <strong>${itemDesc}</strong> at no charge. No payment is needed from your side.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 30px 20px 30px;">
        <tr><td style="background:#F6F6F6; border-left:4px solid #fc7d27; padding:16px 20px; text-align:center;">
          <h4 style="color:#000000; margin-bottom:8px; font-size:14px;">What happens next</h4>
          <p style="font-size:13px; color:#444444; margin:4px 0;">Our repair team will begin work on your jewellery and you'll hear from us as soon as it's ready.</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 30px 20px 30px;">
        <tr><td style="border:1px solid #e6d8cc; border-radius:8px; padding:20px; text-align:center;">
          <h3 style="color:#000000; margin-bottom:12px; font-size:16px;">Questions?</h3>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 20px; font-size:13px;"><strong>Phone/WhatsApp</strong><br><a href="tel:+917710938305" style="color:#000000;">+91-7710938305</a></td>
              <td style="padding:0 20px; font-size:13px;"><strong>Email</strong><br><a href="mailto:hello@timanti.in" style="color:#000000;">hello@timanti.in</a></td>
            </tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#666666;">
          <p>Mon–Sat, 10AM–6PM &nbsp;|&nbsp; <a href="mailto:hello@timanti.in" style="color:#fc7d27;">hello@timanti.in</a></p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

function buildRepairHqCompleteReadyHtml({ customerName, draftRef, amount, completeUrl }) {
  const paymentBanner = amount
    ? `<table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#d4edda; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #c3e6cb;">
          PAYMENT RECEIVED — Rs.${amount} &nbsp;·&nbsp; ${draftRef}
        </td></tr>
      </table>`
    : `<table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#d4edda; padding:12px 20px; text-align:center; font-weight:bold; font-size:13px; border-bottom:1px solid #c3e6cb;">
          COMPLIMENTARY REPAIR CONFIRMED &nbsp;·&nbsp; ${draftRef}
        </td></tr>
      </table>`;

  const bodyText = amount
    ? `Payment of <strong>Rs.${amount}</strong> has been received for <strong>${customerName}</strong>. The repair can now proceed.`
    : `The repair for <strong>${customerName}</strong> has been confirmed as complimentary. Proceed with the repair when ready.`;

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

      ${paymentBanner}

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:28px 30px 10px 30px; text-align:center;">
          <p style="font-size:13px; color:#999999; margin-bottom:8px;">${draftRef}</p>
          <h2 style="font-size:20px; color:#000000; margin-bottom:16px;">Repair in Progress — Mark Complete When Done</h2>
          <p style="font-size:14px; color:#444444; line-height:1.6;">${bodyText}</p>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 30px 24px 30px;">
        <tr><td style="text-align:center;">
          <p style="font-size:13px; color:#666666; margin-bottom:16px;">When the repair is ready, click below to notify the customer. You can optionally add a Sequel tracking ID.</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="background:#000000; border-radius:4px; text-align:center;">
              <a href="${completeUrl}" target="_blank" style="color:#ffffff; text-decoration:none; font-weight:500; display:block; padding:14px 32px; font-size:15px;">Mark Repair Complete &amp; Notify Customer</a>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eeeeee; padding:20px 30px;">
        <tr><td style="text-align:center; font-size:12px; color:#999999;">
          <p>Timanti internal — do not forward this email</p>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { sendEmail, sendDepositEmail, buildDepositEmailHtml, buildRepairEstimateHtml, buildRepairPaymentConfirmedHtml, buildRepairCompleteHtml, buildCreditNoteHtml, buildRepairIntakeHtml, buildRepairAcknowledgementHtml, buildRepairFreeHtml, buildRepairHqCompleteReadyHtml };
