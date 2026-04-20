'use strict';

const axios = require('axios');

function roundToTwo(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isDiscountLineItem(item) {
  return (item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0;
}

async function recalculate({ draftOrderId, shopifyToken, shopifyStoreUrl }) {
  const response = await axios.get(
    `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    { headers: { 'X-Shopify-Access-Token': shopifyToken }, timeout: 15000 }
  );

  const draftOrder = response.data.draft_order;
  const lineItems  = draftOrder.line_items || [];

  const productItems  = lineItems.filter(item => !isDiscountLineItem(item));
  const discountItems = lineItems.filter(item => isDiscountLineItem(item));

  const grossTotal = productItems.reduce(
    (sum, item) => sum + parseFloat(item.price) * parseInt(item.quantity, 10), 0
  );

  const discountAmount = discountItems.reduce(
    (sum, item) => sum + Math.abs(parseFloat(item.price)) * parseInt(item.quantity, 10), 0
  );

  const taxableBeforeDiscount = roundToTwo(grossTotal / 1.03);

  if (discountAmount > taxableBeforeDiscount) {
    throw new Error(
      `Discount (Rs${roundToTwo(discountAmount)}) exceeds taxable value (Rs${taxableBeforeDiscount})`
    );
  }

  const taxableAfterDiscount = roundToTwo(taxableBeforeDiscount - discountAmount);
  const gst                  = roundToTwo(taxableAfterDiscount * 0.03);
  const finalTotal           = roundToTwo(taxableAfterDiscount + gst);

  return {
    draftOrderId:           draftOrder.id,
    draftOrderName:         draftOrder.name,
    grossTotal:             roundToTwo(grossTotal),
    discountAmount:         roundToTwo(discountAmount),
    taxableBeforeDiscount,
    taxableAfterDiscount,
    gst,
    finalTotal
  };
}

module.exports = { recalculate };
