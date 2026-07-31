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
/**
 * True when the pasted value is an API **secret key** (`shpss_...`), not an
 * access token. This is the most likely wrong paste by a wide margin: a Dev
 * Dashboard app's Settings page shows a Client ID and a Client secret and no
 * access token at all (those apps mint tokens via OAuth), so someone hunting
 * for a credential finds the secret first.
 *
 * Shopify's access tokens carry a documented static prefix: `shpat_` (public
 * apps), `shpca_` (custom apps), `shppa_` (legacy private apps). `shpss_` is
 * not among them under any flow, which is what makes rejecting it safe.
 *
 * NOTE the deliberate difference from the rule in shopify.md → "Credential
 * storage": provenance (managed vs static tuple) must NEVER be inferred from a
 * prefix, because expiring OAuth tokens are `shpat_`-prefixed too. That rule is
 * about telling two VALID token kinds apart. This is input validation against a
 * value that is never a token, so the prefix is sound evidence here.
 */
export function isShpssPrefixed(token: string): boolean {
  return token.trim().toLowerCase().startsWith("shpss_");
}

export function normalizeShopifyShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (s === "admin.shopify.com") return null;
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}
