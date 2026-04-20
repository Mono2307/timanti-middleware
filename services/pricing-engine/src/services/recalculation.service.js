'use strict';

const { shopifyClient } = require('./shopify.service');
const { roundToTwo }    = require('../utils/math');

function isDiscountLineItem(item) {
  return item.title.toLowerCase().includes('discount') && parseFloat(item.price) < 0;
}

class RecalculationService {
  async recalculate({ draftOrderId }) {
    const response   = await shopifyClient.get(`/draft_orders/${draftOrderId}.json`);
    const draftOrder = response.data.draft_order;
    const lineItems  = draftOrder.line_items ?? [];

    const productItems  = lineItems.filter(item => !isDiscountLineItem(item));
    const discountItems = lineItems.filter(item => isDiscountLineItem(item));

    const grossTotal = productItems.reduce(
      (sum, item) => sum + parseFloat(item.price) * item.quantity, 0
    );

    const discountAmount = discountItems.reduce(
      (sum, item) => sum + Math.abs(parseFloat(item.price)) * item.quantity, 0
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
}

module.exports = { RecalculationService };
