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

const MIDDLEWARE = "https://timanti-middleware.fly.dev";

const inr = (v) =>"₹" + Math.round(Number(v) || 0).toLocaleString("en-IN");

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
  const points = Math.max(0, Math.floor(Number(data.points) || 0));
  // The tier in its own colour and the Silver → Gold → Platinum track with thresholds. Drawn by the
  // middleware, because customer-account extensions only allow Shopify's built-in colour tones.
  const graphic = `${MIDDLEWARE}/api/loyalty/tier.svg?p=${points}`;
  const toNext = data.next_tier_name && data.next_tier_name !== "-" && gap > 0
    ? `${inr(gap)} more to reach ${data.next_tier_name}` : "";
  return (
    <s-section heading="Timanti Loyalty">
      <s-stack direction="block" gap="base" alignItems="center">
        <s-image src={graphic} alt={hasTier ? `${data.tier_name} member` : "Timanti Loyalty"} inlineSize="fill" />
        <s-text type="strong">
          {hasTier ? `${Number(data.discount_pct) || 0}% off the diamond value of eligible pieces` : "Your first tier unlocks a discount on diamonds"}
        </s-text>
        <s-text>{`Lifetime purchases ${inr(points)}${toNext ? ` · ${toNext}` : ""}`}</s-text>
        {hasTier ? <s-text>Extra 2% in your birthday and anniversary months</s-text> : null}
      </s-stack>
    </s-section>
  );
}
