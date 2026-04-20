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
  const find = (namespace, key) => {
    const mf = metafields.find(m => m.namespace === namespace && m.key === key);
    return mf ? parseFloat(mf.value) || 0 : 0;
  };
  return {
    gold:    find('custom', 'price_breakup_gold'),
    diamond: find('custom', 'price_breakup_diamond'),
    making:  find('custom', 'price_breakup_making'),
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

  const productItems = lineItems.filter(item => !isDiscountLineItem(item));

  // 2. Compute order-level totals
  const grossTotal = productItems.reduce(
    (sum, item) => sum + parseFloat(item.price) * parseInt(item.quantity, 10), 0
  );

  const discountObj = draftOrder.applied_discount;
  let discountAmount = 0;
  if (discountObj) {
    discountAmount = Number(discountObj.amount || discountObj.value || 0);
  }

  const taxableBeforeDiscount = roundToTwo(grossTotal / 1.03);

  // Treat applied_discount as a tax-inclusive reduction to derive the intended final price
  const intendedFinal = roundToTwo(grossTotal - discountAmount);
  if (intendedFinal < 0) {
    throw new Error(
      `Discount (Rs${roundToTwo(discountAmount)}) exceeds gross total (Rs${roundToTwo(grossTotal)})`
    );
  }

  // Back-calculate correct taxable value and GST from intendedFinal
  const taxableAfterDiscount = roundToTwo(intendedFinal / 1.03);
  const gst                  = roundToTwo(taxableAfterDiscount * 0.03);
  const finalTotal           = roundToTwo(taxableAfterDiscount + gst);
  const correctDiscount      = roundToTwo(taxableBeforeDiscount - taxableAfterDiscount);

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

    const itemCorrectDiscount = roundToTwo(correctDiscount * proportion);
    const itemDiscountDisplay = roundToTwo(discountAmount * proportion);
    const itemTaxable         = roundToTwo(taxableAfterDiscount * proportion);
    const itemGst             = roundToTwo(gst * proportion);
    const itemFinal           = roundToTwo(itemTaxable + itemGst);
    const adjustedDiamond     = roundToTwo(diamond * qty - itemCorrectDiscount);
    const grossValue          = roundToTwo(itemFinal + itemDiscountDisplay);

    const properties = [
      { name: 'Gold',             value: `Rs${roundToTwo(gold * qty)}` },
      { name: 'Diamond',          value: `Rs${adjustedDiamond}` },
      { name: 'Making',           value: `Rs${roundToTwo(making * qty)}` },
      { name: 'Discount Applied', value: `Rs${itemDiscountDisplay}` },
      { name: 'Taxable Value',    value: `Rs${itemTaxable}` },
      { name: 'GST',              value: `Rs${itemGst}` },
      { name: 'Gross Value',      value: `Rs${grossValue}` },
    ];

    const updatedItem = {
      id:         item.id,
      variant_id: item.variant_id,
      quantity:   qty,
      properties,
    };

    // Custom line items (no variant_id) need title preserved
    if (!item.variant_id) {
      updatedItem.title      = item.title;
      updatedItem.variant_id = undefined;
    }

    return updatedItem;
  });

  // 5. Update draft order — only write properties, leave price and applied_discount intact
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
    correctDiscount,
    updated:                true,
  };
}

module.exports = { recalculate };
