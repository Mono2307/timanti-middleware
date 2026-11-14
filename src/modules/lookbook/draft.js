'use strict';

/**
 * "Create draft order" from a lookbook PDP.
 *
 * The point is to get the RIGHT variant into Shopify: staff pick the piece on the lookbook, where
 * the design code and the in-stock variant are visible, instead of searching for it again in Admin
 * where RG00048 and RG00048A look alike. The draft is a starting point, not a sale: staff open it,
 * swap in the real customer, set the routing tags and bill as usual.
 *
 * THE PLACEHOLDER CUSTOMER
 * Staff flows here expect a customer on every draft, so the draft is created against one fixed
 * placeholder, "Lookbook Walk-in". It has no email and no phone, so nothing (confirmation, payment
 * link, receipt) can be sent to it by mistake. It is found by tag, created once if missing, and can
 * be pinned with LOOKBOOK_DRAFT_CUSTOMER_ID.
 *
 * What happens after creation is the normal pipeline: the draft_orders/create webhook hydrates the
 * Gold/Diamond/Making properties from the variant, exactly as for a draft made by hand.
 */

const { gql } = require('./shopify-gql');
const { log } = require('../../core/logger');
const { config } = require('../../core/config');

const PLACEHOLDER_TAG = 'lookbook-placeholder';
const DRAFT_TAG = 'lookbook';
const DEDUPE_MS = 30 * 1000;           // a double tap on a slow connection must not make two drafts
const HOURLY_CAP = 60;                 // a runaway client, not a busy day, is what this stops

const VARIANT_QUERY = `
  query LookbookDraftVariant($id: ID!) {
    productVariant(id: $id) {
      id legacyResourceId sku title price inventoryQuantity
      product { id title status }
    }
  }`;

const FIND_CUSTOMER = `
  query LookbookPlaceholder($q: String!) {
    customers(first: 1, query: $q) { nodes { id } }
  }`;

const CREATE_CUSTOMER = `
  mutation LookbookPlaceholderCreate($input: CustomerInput!) {
    customerCreate(input: $input) { customer { id } userErrors { field message } }
  }`;

const CREATE_DRAFT = `
  mutation LookbookDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id legacyResourceId name }
      userErrors { field message }
    }
  }`;

const toCustomerGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Customer/${id}`);

let _customerId = null;
let _customerLookup = null;   // single-flight: two first-ever clicks must not create two placeholders

function placeholderCustomer() {
  if (config.lookbook.draftCustomerId) return Promise.resolve(toCustomerGid(config.lookbook.draftCustomerId));
  if (_customerId) return Promise.resolve(_customerId);
  if (_customerLookup) return _customerLookup;

  _customerLookup = (async () => {
    try {
      const found = await gql(FIND_CUSTOMER, { q: `tag:${PLACEHOLDER_TAG}` }, { label: 'draft-customer' });
      const hit = found.data && found.data.customers && found.data.customers.nodes[0];
      if (hit) { _customerId = hit.id; return _customerId; }

      const made = await gql(CREATE_CUSTOMER, {
        input: {
          firstName: 'Lookbook',
          lastName: 'Walk-in',
          tags: [PLACEHOLDER_TAG],
          note: 'Placeholder for drafts created from the staff lookbook. Replace it with the real ' +
                'customer before billing. Deliberately has no email or phone.',
        },
      }, { label: 'draft-customer' });
      const res = made.data && made.data.customerCreate;
      if (res && res.userErrors && res.userErrors.length) throw new Error('customerCreate: ' + JSON.stringify(res.userErrors));
      _customerId = res.customer.id;
      log.info('lookbook', `created the placeholder customer ${_customerId}`);
      return _customerId;
    } finally {
      _customerLookup = null;
    }
  })();
  return _customerLookup;
}

const _recent = new Map();   // variantId -> { at, result }
const _hour = [];            // creation timestamps, for the cap

function remember(variantId, result) {
  const now = Date.now();
  _recent.set(variantId, { at: now, result });
  _hour.push(now);
  for (const [k, v] of _recent) if (now - v.at > DEDUPE_MS) _recent.delete(k);
  while (_hour.length && now - _hour[0] > 3600 * 1000) _hour.shift();
}

class DraftError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * Create a one-line draft for `variantId` (bare numeric id). Returns
 * `{ id, name, adminUrl, sku, price, duplicate }`. Throws DraftError with an HTTP status for the
 * cases the page should explain rather than call a server fault.
 */
async function createDraft(variantId, { storeHandle = 'auracarat' } = {}) {
  const vid = String(variantId || '').trim();
  if (!/^\d+$/.test(vid)) throw new DraftError('variantId must be a numeric variant id', 400);

  const seen = _recent.get(vid);
  if (seen && Date.now() - seen.at < DEDUPE_MS) return Object.assign({}, seen.result, { duplicate: true });
  if (_hour.filter((t) => Date.now() - t < 3600 * 1000).length >= HOURLY_CAP) {
    throw new DraftError(`more than ${HOURLY_CAP} lookbook drafts in the last hour; try again later`, 429);
  }

  // Re-read the variant rather than trusting the page: the page could be hours old, and the draft
  // must carry the variant that exists in Shopify now.
  const { data } = await gql(VARIANT_QUERY, { id: `gid://shopify/ProductVariant/${vid}` }, { label: 'draft-variant' });
  const v = data && data.productVariant;
  if (!v) throw new DraftError('That variant no longer exists in Shopify. Reload the lookbook.', 404);
  if (v.product && v.product.status === 'ARCHIVED') throw new DraftError('That product is archived in Shopify.', 409);

  const customerId = await placeholderCustomer();

  const made = await gql(CREATE_DRAFT, {
    input: {
      lineItems: [{ variantId: v.id, quantity: 1 }],
      purchasingEntity: { customerId },
      tags: [DRAFT_TAG],
      note: `Created from the lookbook for ${v.sku || v.title}. Replace the "Lookbook Walk-in" ` +
            'customer with the real customer before billing.',
    },
  }, { label: 'draft-create' });

  const res = made.data && made.data.draftOrderCreate;
  if (res && res.userErrors && res.userErrors.length) {
    throw new DraftError('Shopify refused the draft: ' + res.userErrors.map((e) => e.message).join('; '), 422);
  }
  const d = res && res.draftOrder;
  if (!d) throw new Error('draftOrderCreate returned no draft');

  const result = {
    id: String(d.legacyResourceId),
    name: d.name,
    adminUrl: `https://admin.shopify.com/store/${storeHandle}/draft_orders/${d.legacyResourceId}`,
    sku: v.sku || null,
    product: v.product ? v.product.title : null,
    price: Number(v.price),
    duplicate: false,
  };
  remember(vid, result);
  log.info('lookbook', `draft ${d.name} created for ${v.sku || vid} (variant ${vid})`);
  return result;
}

/** Test hook: forget dedupe state and the cached placeholder. */
function _reset() { _recent.clear(); _hour.length = 0; _customerId = null; _customerLookup = null; }

module.exports = { createDraft, DraftError, PLACEHOLDER_TAG, DRAFT_TAG, DEDUPE_MS, _reset };
