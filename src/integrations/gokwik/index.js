const axios = require('axios');

const BASE_URL  = () => process.env.GOKWIK_BASE_URL || 'https://gkx.gokwik.co';
const gkHeaders = () => ({
  'gk-app-id':     process.env.GOKWIK_APP_ID,
  'gk-app-secret': process.env.GOKWIK_APP_SECRET,
  'Content-Type':  'application/json'
});

async function createPaymentLink({ draftOrderId, amount, customerPhone, customerName, customerEmail, expiryDays = 7 }) {
  const expireAt = Math.floor(Date.now() / 1000) + expiryDays * 86400;
  // Suffix with timestamp so GoKwik doesn't reject duplicate merchant_reference_id
  // when multiple links are created for the same draft (advance + final, or retries)
  const merchantRefId = `${draftOrderId}-${Date.now()}`;
  const response = await axios.post(`${BASE_URL()}/v1/payments/links`, {
    amount,
    currency:              'INR',
    merchant_reference_id: merchantRefId,
    mode:                  'standard',
    customer: {
      phone: customerPhone,
      ...(customerName  ? { name:  customerName  } : {}),
      ...(customerEmail ? { email: customerEmail } : {})
    },
    expire_at:   expireAt,
    webhook_url: `${process.env.MIDDLEWARE_BASE_URL}/api/gokwik-webhook`
  }, { headers: gkHeaders(), timeout: 15000 });

  const { id, short_url } = response.data.data;
  return { gokwikLinkId: id, shortUrl: short_url, expiresAt: new Date(expireAt * 1000).toISOString() };
}

async function cancelPaymentLink(gokwikLinkId) {
  const response = await axios.post(`${BASE_URL()}/v1/payments/links/cancel`,
    { id: gokwikLinkId },
    { headers: gkHeaders(), timeout: 15000 }
  );
  const { status, cancelled_at } = response.data.data;
  return { status, cancelledAt: cancelled_at };
}

async function getLinkStatus(gokwikLinkId) {
  const response = await axios.get(`${BASE_URL()}/v1/payments/links?id=${gokwikLinkId}`, {
    headers: { 'gk-app-id': process.env.GOKWIK_APP_ID, 'gk-app-secret': process.env.GOKWIK_APP_SECRET },
    timeout: 15000
  });
  return { status: response.data.data.status };
}

// ── Refunds (GoKwik refund API v2 + refund status v1; docs from GoKwik partnership, 2026) ──────────
// Initiate: POST /v2/order/refund/initiate { gokwik_oid | moid, amount }, headers appid / appsecret.
//   For a payment link, gokwik_oid is the link's merchant_reference_id ("<draftId>-<ms>"), the value the
//   payment webhook sends back as gokwik_oid. One call can make several refunds (extra_refunds) when
//   GoKwik split the original payment; their sum is the amount asked.
// Verify:   POST /v2/order/refund/verify { refund_id }.
// Status:   GET  /v1/payments/refunds?transactionPaymentId=… (gk-app-id / gk-app-secret) — every refund
//   already made against one payment, so we never refund the same money twice.
// GoKwik advise not to branch on their error messages: callers show them to staff and stop.
// The refund API lives on api.gokwik.co, not gkx (checked 24 Nov 2026: gkx answers 404 for /v2/order/refund/*).
const REFUND_BASE_URL = () => process.env.GOKWIK_REFUND_BASE_URL || 'https://api.gokwik.co';
const refundHeaders = () => ({ appid: process.env.GOKWIK_APP_ID, appsecret: process.env.GOKWIK_APP_SECRET, 'Content-Type': 'application/json' });
const gkError = (e) => {
  const d = e.response?.data;
  const msg = d?.statusMessage || d?.error?.reference?.message || d?.error?.message || d?.message || e.message;
  return Object.assign(new Error(`GoKwik: ${msg}`), { status: e.response?.status || 502, gokwik: d || null });
};

async function initiateRefund({ gokwikOid, amount }) {
  try {
    const r = await axios.post(`${REFUND_BASE_URL()}/v2/order/refund/initiate`,
      { gokwik_oid: String(gokwikOid), amount: Number(amount) }, { headers: refundHeaders(), timeout: 30000 });
    const d = r.data?.data || {};
    const parts = [d, ...(Array.isArray(d.extra_refunds) ? d.extra_refunds : [])]
      .filter(x => x && x.refund_id).map(x => ({ refundId: x.refund_id, amount: Number(x.amount) || 0, status: x.status || '' }));
    return { refundId: d.refund_id, status: d.status || '', parts };
  } catch (e) { throw gkError(e); }
}

async function verifyRefund(refundId) {
  try {
    const r = await axios.post(`${REFUND_BASE_URL()}/v2/order/refund/verify`, { refund_id: refundId }, { headers: refundHeaders(), timeout: 15000 });
    const d = r.data?.data || {};
    return { refundId: d.refund_id, amount: Number(d.amount) || 0, status: d.status || '',
      referenceId: d.reference_id && d.reference_id !== 'NA' ? d.reference_id : null,
      refundedAt: d.refunded_at && d.refunded_at !== 'NA' ? d.refunded_at : null };
  } catch (e) { throw gkError(e); }
}

// Every refund already made against one payment. [] when none (GoKwik may answer 400 REF79 for that).
async function listRefunds({ transactionPaymentId }) {
  try {
    const r = await axios.get(`${BASE_URL()}/v1/payments/refunds`, {
      params: { transactionPaymentId }, timeout: 15000,
      headers: { 'gk-app-id': process.env.GOKWIK_APP_ID, 'gk-app-secret': process.env.GOKWIK_APP_SECRET },
    });
    return (r.data?.data || []).map(x => ({
      refundId: x.gokwikRid || x.gokwik_rid, amount: Number(x.amount) || 0, status: String(x.status || ''),
      date: x.date || null, ref: x.custRefId || x.cust_ref_id || null,
    }));
  } catch (e) {
    if (e.response?.status === 400 && /REF79/.test(JSON.stringify(e.response.data || ''))) return [];
    throw gkError(e);
  }
}

module.exports = { createPaymentLink, cancelPaymentLink, getLinkStatus, initiateRefund, verifyRefund, listRefunds };
