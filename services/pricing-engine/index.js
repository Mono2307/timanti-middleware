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
  const findStr = (namespace, key) => {
    const mf = metafields.find(m => m.namespace === namespace && m.key === key);
    return mf ? (mf.value || '') : '';
  };
  return {
    gold:          find('custom', 'price_breakup_gold'),
    diamond:       find('custom', 'price_breakup_diamond'),
    making:        find('custom', 'price_breakup_making'),
    goldRate:      findStr('custom', 'gold_rate'),
    goldUpdatedAt: findStr('custom', 'gold_last_updated_at'),
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
    // Shopify may send amount="0.0" (truthy string) on the first webhook even when a real
    // discount is set — use value as ground truth when amount parses to zero.
    const rawAmount = parseFloat(discountObj.amount || 0);
    const rawValue  = parseFloat(discountObj.value  || 0);
    discountAmount  = rawAmount > 0 ? rawAmount : rawValue;
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
      let breakdown = { gold: 0, diamond: 0, making: 0, goldRate: '', goldUpdatedAt: '' };
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
  const updatedLineItems = itemBreakdowns.map(({ item, gold, diamond, making, goldRate, goldUpdatedAt }) => {
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
    // Preserve locked order-date rate — only write from variant on first-ever recalculation
    const existingGoldRate      = (item.properties || []).find(p => p.name === '_gold_rate');
    const existingGoldUpdatedAt = (item.properties || []).find(p => p.name === '_gold_updated_at');
    const lockedRate      = existingGoldRate      ? existingGoldRate.value      : goldRate;
    const lockedUpdatedAt = existingGoldUpdatedAt ? existingGoldUpdatedAt.value : goldUpdatedAt;
    if (lockedRate)      properties.push({ name: '_gold_rate',       value: lockedRate });
    if (lockedUpdatedAt) properties.push({ name: '_gold_updated_at', value: lockedUpdatedAt });

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
