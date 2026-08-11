const axios = require('axios');

const BASE_URL  = () => process.env.GOKWIK_BASE_URL || 'https://gkx.gokwik.co';
const gkHeaders = () => ({
  'gk-app-id':     process.env.GOKWIK_APP_ID,
  'gk-app-secret': process.env.GOKWIK_APP_SECRET,
  'Content-Type':  'application/json'
});

async function createPaymentLink({ draftOrderId, amount, customerPhone, customerName, customerEmail }) {
  const expireAt = Math.floor(Date.now() / 1000) + 604800;
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

module.exports = { createPaymentLink, cancelPaymentLink, getLinkStatus };
