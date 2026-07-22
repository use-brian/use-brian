/**
 * Shopify store-domain normalization — client-safe (no node imports).
 *
 * Accepts "mystore", "mystore.myshopify.com", or a pasted admin URL and
 * returns the canonical `{shop}.myshopify.com` host, or null when the input
 * cannot be one. The connect flow interpolates this value into the per-shop
 * authorize URL, so the strict `*.myshopify.com` bind is also the
 * scheme/path-injection guard. Mirrors `normalizeShopDomain` in
 * `packages/api/src/shopify/client.ts` — keep the two in sync.
 *
 * See docs/architecture/integrations/shopify.md.
 */
export function normalizeShopifyShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (s === "admin.shopify.com") return null;
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}
