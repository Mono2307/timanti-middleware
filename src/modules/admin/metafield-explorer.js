'use strict';

/**
 * GET /api/metafields/inspect — read the metafields on a product and its variants.
 *
 * WHY: pricing rules key off `custom.*` metafields, but there was no way to see what a product
 * actually carries without opening Shopify Admin and clicking through. That makes questions like
 * "what is the making-rate field called?" unanswerable from here, and makes it easy to write a
 * pricing rule against a key that does not exist — which fails silently, because a missing
 * metafield reads as absent rather than as an error.
 *
 * Read-only. Never writes, and never returns anything outside the `custom` namespace.
 *
 *   /api/metafields/inspect?productId=9121806876929
 *   /api/metafields/inspect?variantId=48578141913345     (resolves its product too)
 *   /api/metafields/inspect?draftOrderId=1451370283265   (every line item on the draft)
 *   /api/metafields/inspect?productId=…&all=true         (include non-custom namespaces)
 */

const { getShopifyToken, getJson } = require('../../core/shopify');
const { log } = require('../../core/logger');

/** Collapse Shopify's metafield array into { key: { value, type } }, custom namespace by default. */
function shape(metafields, includeAll) {
  const out = {};
  for (const m of (metafields || [])) {
    if (!includeAll && m.namespace !== 'custom') continue;
    out[includeAll ? `${m.namespace}.${m.key}` : m.key] = { value: m.value, type: m.type };
  }
  return out;
}

function register(app) {
  app.get('/api/metafields/inspect', async (req, res) => {
    const { productId, variantId, draftOrderId } = req.query;
    const includeAll = String(req.query.all || '') === 'true';

    if (!productId && !variantId && !draftOrderId) {
      return res.status(400).json({
        success: false,
        error: 'pass one of productId, variantId or draftOrderId',
      });
    }

    try {
      const token = await getShopifyToken();
      const result = { success: true, namespace: includeAll ? 'all' : 'custom' };

      // A draft resolves to its line items, which is usually what you actually want: it answers
      // "what does the thing on this order carry" without hunting for ids first.
      let targets = [];
      if (draftOrderId) {
        const d = await getJson(`draft_orders/${draftOrderId}.json`, { token });
        result.draftOrder = d.draft_order?.name;
        targets = (d.draft_order?.line_items || [])
          .filter(li => li.variant_id || li.product_id)
          .map(li => ({ title: li.title, variantId: li.variant_id, productId: li.product_id }));
      } else {
        targets = [{ variantId: variantId || null, productId: productId || null }];
      }

      result.items = [];
      for (const t of targets) {
        const entry = { title: t.title, variantId: t.variantId, productId: t.productId };

        if (t.variantId) {
          const v = await getJson(`variants/${t.variantId}/metafields.json`, { token });
          entry.variant = shape(v.metafields, includeAll);
          // A variant does not carry its product id in the metafields call, so look it up when the
          // caller gave only a variant — otherwise the product half comes back empty.
          if (!entry.productId) {
            const vv = await getJson(`variants/${t.variantId}.json`, { token });
            entry.productId = vv.variant?.product_id || null;
          }
        }

        if (entry.productId) {
          const p = await getJson(`products/${entry.productId}/metafields.json`, { token });
          entry.product = shape(p.metafields, includeAll);
        }

        result.items.push(entry);
      }

      return res.json(result);
    } catch (err) {
      log.error('admin', 'metafields/inspect:', err.response?.data || err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { register };
