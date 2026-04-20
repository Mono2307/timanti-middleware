'use strict';

const axios = require('axios');

function roundToTwo(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isDiscountLineItem(item) {
  return (item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0;
}

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

async function fetchVariantBreakdown(variantId, shopifyToken, shopifyStoreUrl) {
  const response = await axios.get(
    `${shopifyStoreUrl}/admin/api/2024-01/variants/${variantId}/metafields.json`,
    { headers: shopifyHeaders(shopifyToken), timeout: 10000 }
  );
  const metafields = response.data.metafields || [];
  const find = (key) => {
    const mf = metafields.find(m => m.key === key);
    return mf ? parseFloat(mf.value) || 0 : 0;
  };
  return {
    gold:    find('gold_price'),
    diamond: find('diamond_price'),
    making:  find('making_price'),
  };
}

async function recalculate({ draftOrderId, shopifyToken, shopifyStoreUrl }) {
  // 1. Fetch draft order
  const fetchResponse = await axios.get(
    `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    { headers: shopifyHeaders(shopifyToken), timeout: 15000 }
  );

  const draftOrder = fetchResponse.data.draft_order;
  const lineItems  = draftOrder.line_items || [];

  const productItems  = lineItems.filter(item => !isDiscountLineItem(item));
  const discountItems = lineItems.filter(item => isDiscountLineItem(item));

  // 2. Compute order-level totals
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

  // 3. Fetch variant metafields for breakdown (gold/diamond/making) per line item
  const itemBreakdowns = await Promise.all(
    productItems.map(async (item) => {
      let breakdown = { gold: 0, diamond: 0, making: 0 };
      if (item.variant_id) {
        try {
          breakdown = await fetchVariantBreakdown(item.variant_id, shopifyToken, shopifyStoreUrl);
        } catch (_) {
          // metafields unavailable — properties will show Rs0
        }
      }
      return { item, ...breakdown };
    })
  );

  // 4. Build updated line items: proportional pricing + breakdown properties
  const updatedLineItems = itemBreakdowns.map(({ item, gold, diamond, making }) => {
    const qty            = parseInt(item.quantity, 10);
    const itemLineTotal  = parseFloat(item.price) * qty;
    const proportion     = grossTotal > 0 ? itemLineTotal / grossTotal : 1 / productItems.length;

    const itemDiscount  = roundToTwo(discountAmount * proportion);
    const itemTaxable   = roundToTwo(taxableAfterDiscount * proportion);
    const itemGst       = roundToTwo(gst * proportion);
    const itemFinal     = roundToTwo(itemTaxable + itemGst);
    const unitPrice     = roundToTwo(itemFinal / qty);

    const properties = [
      { name: 'Gold',             value: `Rs${roundToTwo(gold * qty)}` },
      { name: 'Diamond',          value: `Rs${roundToTwo(diamond * qty)}` },
      { name: 'Making',           value: `Rs${roundToTwo(making * qty)}` },
      { name: 'Discount Applied', value: `Rs${itemDiscount}` },
      { name: 'Taxable Value',    value: `Rs${itemTaxable}` },
      { name: 'GST',              value: `Rs${itemGst}` },
    ];

    const updatedItem = {
      id:         item.id,
      variant_id: item.variant_id,
      quantity:   qty,
      price:      unitPrice.toFixed(2),
      properties,
    };

    // Custom line items (no variant_id) need title preserved
    if (!item.variant_id) {
      updatedItem.title      = item.title;
      updatedItem.variant_id = undefined;
    }

    return updatedItem;
  });

  // 5. Update draft order in Shopify (discount line items excluded — absorbed into price)
  await axios.put(
    `${shopifyStoreUrl}/admin/api/2024-01/draft_orders/${draftOrderId}.json`,
    { draft_order: { line_items: updatedLineItems } },
    { headers: shopifyHeaders(shopifyToken), timeout: 15000 }
  );

  return {
    draftOrderId:           draftOrder.id,
    draftOrderName:         draftOrder.name,
    grossTotal:             roundToTwo(grossTotal),
    discountAmount:         roundToTwo(discountAmount),
    taxableBeforeDiscount,
    taxableAfterDiscount,
    gst,
    finalTotal,
    updated:                true,
  };
}

module.exports = { recalculate };
