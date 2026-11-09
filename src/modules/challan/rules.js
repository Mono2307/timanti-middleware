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

// DEMO ONLY. A From store whose challans draw from their own book (DC-KATEST-0001…), so a demo or
// UAT never spends a real store's numbers. It can send goods but never receive them, and the
// template prints its challan as a demo document. Added 2026-11-09 for the UAT demo; to retire it,
// empty this object (and drop the KATEST branch from the template).
const DEMO_STORES = {
  'KA-TEST': 'KA-TEST (demo only, not a real store)',
};

const isOrigin = (code) => Boolean(STORES[code] || DEMO_STORES[code]);
const isDemo   = (code) => Boolean(DEMO_STORES[code]);

/** What is missing before a challan can be made. */
function missingForMake({ origin, deliveryCode, shipOutside, address, productLines }) {
  const m = [];
  if (!isOrigin(origin)) m.push(origin ? `the From store "${origin}" is not KA-HSR or MH-HQ (set Store / State Code in Metafield Manager)` : 'the From store (set Store / State Code in Metafield Manager)');
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

module.exports = { STORES, DEMO_STORES, isOrigin, isDemo, missingForMake };
