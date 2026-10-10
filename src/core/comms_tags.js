// Routing tags for the Shopify order-confirmation email.
//
// Shopify sends the order confirmation the instant a draft converts — about two seconds after the
// order exists, and BEFORE copyDraftMetafieldsToOrder has carried a single custom.* field across
// (#1075: email at 14:46:18, channel/order_type written 14:46:21). So the email can never read the
// routing metafields; all it can see is what the draft already carried, which is its tags. These
// mirror the three fields the template branches on onto the draft as tags:
//
//   custom.channel    Online | Offline   ->  ch:online   | ch:offline
//   custom.order_type in-stock | mto     ->  ot:in-stock | ot:mto
//   custom.shipment   Yes | No           ->  ship:yes    | ship:no
//
// The admin panel writes them on save (the primary path, so they exist before staff can convert);
// the draft webhook pass re-derives them from the metafields as a backstop for edits made anywhere
// else. A blank field removes its tag, so a tag never outlives the value it stands for.

const COMMS_TAG_FIELDS = { channel: 'ch', order_type: 'ot', shipment: 'ship' };
const COMMS_TAG_RE = /^(ch|ot|ship):/i;

function isCommsTag(t) {
  return COMMS_TAG_RE.test(String(t || '').trim());
}

function commsTagValue(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

// mfMap: { key: value } over the custom namespace. Returns the tags the metafields call for.
function commsTagsFromMetafields(mfMap) {
  const out = [];
  for (const [key, prefix] of Object.entries(COMMS_TAG_FIELDS)) {
    const v = commsTagValue(mfMap?.[key]);
    if (v) out.push(`${prefix}:${v}`);
  }
  return out;
}

module.exports = { COMMS_TAG_FIELDS, isCommsTag, commsTagsFromMetafields };
