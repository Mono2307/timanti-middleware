import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * Loyalty tier on the customer's account Profile page (new customer accounts).
 *
 * Reads the loyalty.* customer metafields the middleware publishes after every order (see
 * src/modules/loyalty/customer.js). The definitions must grant customer-account READ access —
 * POST /api/loyalty/setup creates them that way. Nothing here computes anything: the ledger is
 * the truth and these fields are its copy.
 */
export default async () => {
  render(<LoyaltyTier />, document.body);
};

const KEYS = ["tier", "tier_name", "points", "discount_pct", "next_tier_name", "next_tier_gap"];

const inr = (v) => "₹" + Math.round(Number(v) || 0).toLocaleString("en-IN");

function LoyaltyTier() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const identifiers = KEYS.map((key) => `{namespace: "loyalty", key: "${key}"}`).join(", ");
        const res = await fetch("shopify://customer-account/api/2025-10/graphql.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `{ customer { firstName metafields(identifiers: [${identifiers}]) { key value } } }` }),
        });
        const body = await res.json();
        const out = { firstName: body?.data?.customer?.firstName || "" };
        for (const m of body?.data?.customer?.metafields || []) if (m) out[m.key] = m.value;
        setData(out);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  if (failed) return null;
  if (!data) return <s-section heading="Timanti Loyalty"><s-text>Loading…</s-text></s-section>;

  const hasTier = data.tier && data.tier !== "none";
  const gap = Number(data.next_tier_gap) || 0;
  return (
    <s-section heading="Timanti Loyalty">
      <s-stack direction="block" gap="base" alignItems="center">
        {hasTier ? (
          <s-stack direction="inline" gap="base" justifyContent="center" alignItems="center">
            <s-badge>{data.tier_name}</s-badge>
            <s-text>{`${Number(data.discount_pct) || 0}% off the diamond value of eligible pieces`}</s-text>
          </s-stack>
        ) : (
          <s-text>You are a Timanti member. Your first loyalty tier unlocks a discount on diamonds.</s-text>
        )}
        <s-text>{`Lifetime purchases: ${inr(data.points)}`}</s-text>
        {data.next_tier_name && data.next_tier_name !== "-" && gap > 0 ? (
          <s-text>{`Spend ${inr(gap)} more to reach ${data.next_tier_name}.`}</s-text>
        ) : null}
        {hasTier ? (
          <s-text tone="subdued">
            You get an extra 2% in your birthday and anniversary months. Online, use "My benefits" in your
            cart; in store, just let us know.
          </s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}
