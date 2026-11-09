'use strict';

/**
 * Delivery challan rules — pure, no I/O, so they can be tested on their own.
 */

// The stores the challan template knows how to print (templates/delivery-challan.liquid,
// from_key / to_key branches). A code outside this list would print the template's error block.
const STORES = {
  'KA-HSR': 'Bengaluru HSR (KA-HSR)',
  'MH-HQ':  'Mumbai HQ (MH-HQ)',
};

/** What is missing before a challan can be made. */
function missingForMake({ origin, deliveryCode, shipOutside, address, productLines }) {
  const m = [];
  if (!STORES[origin]) m.push(origin ? `the From store "${origin}" is not KA-HSR or MH-HQ (set Store / State Code in Metafield Manager)` : 'the From store (set Store / State Code in Metafield Manager)');
  if (shipOutside) {
    if (!address) m.push('a customer shipping or billing address with a state, because Ship outside is on');
  } else if (!STORES[deliveryCode]) {
    m.push('the destination store');
  } else if (deliveryCode === origin) {
    m.push('a destination store different from the From store');
  }
  if (!productLines) m.push('at least one product line on the draft');
  return m;
}

module.exports = { STORES, missingForMake };
