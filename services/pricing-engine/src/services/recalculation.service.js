'use strict';

const { shopifyClient } = require('./shopify.service');
const { roundToTwo }    = require('../utils/math');

function isDiscountLineItem(item) {
  return item.title.toLowerCase().includes('discount') && parseFloat(item.price) < 0;
}

async function fetchVariantBreakdown(variantId) {
  const variantRes = await shopifyClient.get(`/variants/${variantId}/metafields.json`);
  const metafields = variantRes.data.metafields || [];

  const find = (namespace, key) => {
    const mf = metafields.find(m => m.namespace === namespace && m.key === key);
    return mf ? parseFloat(mf.value) || 0 : 0;
  };
  const findStr = (namespace, key) => {
    const mf = metafields.find(m => m.namespace === namespace && m.key === key);
    return mf ? (mf.value || '') : '';
  };
  return {
    gold:           find('custom', 'price_breakup_gold'),
    diamond:        find('custom', 'price_breakup_diamond'),
    making:         find('custom', 'price_breakup_making'),
    goldRate:       findStr('custom', 'gold_rate'),
    goldUpdatedAt:  findStr('custom', 'gold_last_updated_at'),
  };
}

class RecalculationService {
  async recalculate({ draftOrderId, discountType = 'diamond_flat' }) {
    // 1. Fetch draft order
    const fetchResponse = await shopifyClient.get(`/draft_orders/${draftOrderId}.json`);
    const draftOrder    = fetchResponse.data.draft_order;
    const lineItems     = draftOrder.line_items ?? [];

    const productItems = lineItems.filter(item => !isDiscountLineItem(item));

    // 2. Compute gross total (tax-inclusive) and pre-tax baseline
    const grossTotal            = productItems.reduce(
      (sum, item) => sum + parseFloat(item.price) * item.quantity, 0
    );
    const taxableBeforeDiscount = roundToTwo(grossTotal / 1.03);

    // 3. Fetch variant metafields for all product items.
    //    Must happen before discount resolution for diamond_percent, and is always
    //    needed for per-item breakdown properties.
    const itemBreakdowns = await Promise.all(
      productItems.map(async (item) => {
        let breakdown = { gold: 0, diamond: 0, making: 0 };
        if (item.variant_id) {
          try {
            breakdown = await fetchVariantBreakdown(item.variant_id);
          } catch (_) {
            // metafields unavailable — properties will show Rs0
          }
        }
        return { item, ...breakdown };
      })
    );

    // 4. Resolve taxableAfterDiscount based on discount type
    const discountObj = draftOrder.applied_discount;
    let taxableAfterDiscount, discountAmountDisplay;

    if (!discountObj) {
      taxableAfterDiscount  = taxableBeforeDiscount;
      discountAmountDisplay = 0;

    } else if (discountType === 'diamond_percent') {
      // applied_discount.value holds the percentage (e.g. "20.0") when value_type is "percentage"
      const percent = parseFloat(discountObj.value || 0);
      if (percent < 0 || percent > 100) {
        throw new Error(`Invalid diamond_percent value: ${percent}. Must be 0–100.`);
      }

      const totalDiamond    = itemBreakdowns.reduce(
        (sum, { diamond, item }) => sum + diamond * item.quantity, 0
      );
      const diamondDiscount = roundToTwo(totalDiamond * (percent / 100));

      if (diamondDiscount > taxableBeforeDiscount) {
        throw new Error(
          `Diamond discount (Rs${diamondDiscount}) exceeds taxable value (Rs${taxableBeforeDiscount})`
        );
      }

      // Discount is applied on the pre-tax diamond value → subtract from taxable directly
      taxableAfterDiscount  = roundToTwo(taxableBeforeDiscount - diamondDiscount);
      discountAmountDisplay = diamondDiscount;

    } else {
      // diamond_flat: applied_discount.amount is Shopify's tax-inclusive flat reduction
      const flatAmount    = Number(discountObj.amount || discountObj.value || 0);
      const intendedFinal = roundToTwo(grossTotal - flatAmount);
      if (intendedFinal < 0) {
        throw new Error(
          `Discount (Rs${roundToTwo(flatAmount)}) exceeds gross total (Rs${roundToTwo(grossTotal)})`
        );
      }

      // Back-calculate taxable from the intended tax-inclusive final
      taxableAfterDiscount  = roundToTwo(intendedFinal / 1.03);
      discountAmountDisplay = flatAmount;
    }

    const gst           = roundToTwo(taxableAfterDiscount * 0.03);
    const finalTotal    = roundToTwo(taxableAfterDiscount + gst);
    const correctDiscount = roundToTwo(taxableBeforeDiscount - taxableAfterDiscount);

    // 5. Build updated line items: proportional pricing + breakdown properties
    //    For diamond_percent, distribute the discount by each item's diamond contribution
    //    rather than its order-value share, so the per-item diamond display is accurate.
    const totalDiamondForProportion = discountType === 'diamond_percent'
      ? itemBreakdowns.reduce((sum, { diamond, item }) => sum + diamond * item.quantity, 0)
      : 0;

    const updatedLineItems = itemBreakdowns.map(({ item, gold, diamond, making, goldRate, goldUpdatedAt }) => {
      const qty           = item.quantity;
      const itemLineTotal = parseFloat(item.price) * qty;
      const valueProportion = grossTotal > 0 ? itemLineTotal / grossTotal : 1 / productItems.length;

      let itemCorrectDiscount, itemDiscountDisplay;
      if (discountType === 'diamond_percent' && totalDiamondForProportion > 0) {
        const diamondProportion = (diamond * qty) / totalDiamondForProportion;
        itemCorrectDiscount = roundToTwo(correctDiscount * diamondProportion);
        itemDiscountDisplay = roundToTwo(discountAmountDisplay * diamondProportion);
      } else {
        itemCorrectDiscount = roundToTwo(correctDiscount * valueProportion);
        itemDiscountDisplay = roundToTwo(discountAmountDisplay * valueProportion);
      }

      const itemTaxable     = roundToTwo(taxableAfterDiscount * valueProportion);
      const itemGst         = roundToTwo(gst * valueProportion);
      const itemFinal       = roundToTwo(itemTaxable + itemGst);
      const unitPrice       = roundToTwo(itemFinal / qty);
      const adjustedDiamond = roundToTwo(diamond * qty - itemCorrectDiscount);
      const grossValue      = roundToTwo(itemFinal + itemDiscountDisplay);

      const properties = [
        { name: 'Gold',             value: `Rs${roundToTwo(gold * qty)}` },
        { name: 'Diamond',          value: `Rs${adjustedDiamond}` },
        { name: 'Making',           value: `Rs${roundToTwo(making * qty)}` },
        { name: 'Discount Applied', value: `Rs${itemDiscountDisplay}` },
        { name: 'Taxable Value',    value: `Rs${itemTaxable}` },
        { name: 'GST',              value: `Rs${itemGst}` },
        { name: 'Gross Value',      value: `Rs${grossValue}` },
      ];
      if (goldRate)      properties.push({ name: '_gold_rate',       value: goldRate });
      if (goldUpdatedAt) properties.push({ name: '_gold_updated_at', value: goldUpdatedAt });

      const updatedItem = {
        id:         item.id,
        variant_id: item.variant_id,
        quantity:   qty,
        price:      unitPrice.toFixed(2),
        properties,
      };

      if (!item.variant_id) {
        updatedItem.title      = item.title;
        updatedItem.variant_id = undefined;
      }

      return updatedItem;
    });

    // 6. Update draft order — clear applied_discount (absorbed into overridden line item prices)
    await shopifyClient.put(`/draft_orders/${draftOrderId}.json`, {
      draft_order: { line_items: updatedLineItems, applied_discount: null },
    });

    return {
      draftOrderId:           draftOrder.id,
      draftOrderName:         draftOrder.name,
      grossTotal:             roundToTwo(grossTotal),
      discountAmount:         roundToTwo(discountAmountDisplay),
      discountType,
      taxableBeforeDiscount,
      taxableAfterDiscount,
      gst,
      finalTotal,
      correctDiscount,
      updated:                true,
    };
  }
}

module.exports = { RecalculationService };
