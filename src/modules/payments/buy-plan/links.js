'use strict';

// Buy plan — payment links and the customer's "pay a different amount" link.
//
// ONE OPEN LINK PER PLAN. The GoKwik webhook records a payment against the NEWEST open link on the
// draft (it carries no amount of its own — see docs/gokwik-webhook.md), so two open links would let
// a customer pay the older one and be credited the newer one's amount. Creating a plan link therefore
// cancels every other open link on the draft first.
//
// The custom-amount link is a signed token (plan id + expiry, HMAC) so the public page needs no
// login and cannot be pointed at another plan. The key is derived from the Supabase service key —
// a server-only secret that already exists — so no new secret has to be provisioned.

const crypto = require('crypto');
const { config } = require('../../../core/config');
const { supabase } = require('../../../core/supabase');
const { log } = require('../../../core/logger');
const { createPaymentLink, cancelPaymentLink } = require('../../../integrations/gokwik');

const TOKEN_DAYS = 200;   // outlives the plan (6 months) with room for an overdue last installment

const tokenKey = () => crypto.createHmac('sha256', String(config.supabase.serviceKey || ''))
  .update('buy-plan-pay-link').digest();
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function payToken(planId, now = Date.now()) {
  const body = `${planId}.${Math.floor(now / 1000) + TOKEN_DAYS * 86400}`;
  const sig = b64u(crypto.createHmac('sha256', tokenKey()).update(body).digest()).slice(0, 32);
  return `${b64u(body)}.${sig}`;
}

// Returns the plan id, or null if the token is forged, malformed or expired.
function readPayToken(token, now = Date.now()) {
  const [bodyB64, sig] = String(token || '').split('.');
  if (!bodyB64 || !sig) return null;
  const body = Buffer.from(bodyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const expected = b64u(crypto.createHmac('sha256', tokenKey()).update(body).digest()).slice(0, 32);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [planId, exp] = body.split('.');
  if (!/^\d+$/.test(planId) || !(Number(exp) * 1000 > now)) return null;
  return Number(planId);
}

const customPayUrl = (planId) => `${String(config.serverUrl || '').replace(/\/+$/, '')}/pay/plan/${payToken(planId)}`;

// Cancel every open link on the draft, then raise one for `amount`. Returns { shortUrl, amount }.
async function createPlanLink(plan, amount) {
  const draftId = String(plan.draft_order_id);
  const { data: open } = await supabase.from('payment_links')
    .select('gokwik_link_id').eq('draft_order_id', draftId).eq('status', 'created');
  for (const l of open || []) {
    try { await cancelPaymentLink(l.gokwik_link_id); } catch (e) { log.warn('buy-plan', `cancel ${l.gokwik_link_id}: ${e.message}`); }
    await supabase.from('payment_links').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('gokwik_link_id', l.gokwik_link_id);
  }

  const phone = String(plan.customer_phone || '').replace(/\D/g, '').slice(-10);
  const { gokwikLinkId, shortUrl, expiresAt } = await createPaymentLink({
    draftOrderId: draftId, amount, customerPhone: phone,
    customerName: plan.customer_name || null, customerEmail: plan.customer_email || null,
  });
  const { error } = await supabase.from('payment_links').insert({
    draft_order_id: draftId, draft_order_name: plan.draft_name, gokwik_link_id: gokwikLinkId,
    short_url: shortUrl, amount, total_amount: Number(plan.total), installment_type: 'buy_plan',
    status: 'created', customer_phone: phone, expires_at: expiresAt,
  });
  if (error) log.warn('buy-plan', `payment_links insert for ${plan.draft_name}: ${error.message}`);
  log.info('buy-plan', `${plan.draft_name}: link ${gokwikLinkId} for Rs${amount}`);
  return { shortUrl, amount, expiresAt };
}

module.exports = { payToken, readPayToken, customPayUrl, createPlanLink };
