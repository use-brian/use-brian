/**
 * Shopify OAuth callback verification — SERVER-ONLY (node:crypto).
 *
 * Shopify signs the callback query string: `hmac` = hex HMAC-SHA256 of the
 * `key=value` pairs sorted by key with `hmac` (and the legacy `signature`)
 * removed, keyed by the app client secret. Verified BEFORE the code exchange
 * so a forged callback never reaches the token endpoint. Mirrors
 * `verifyShopifyOAuthQueryHmac` in `packages/api/src/shopify/client.ts`
 * (app-web cannot import the Express package) — keep the two in sync.
 *
 * See docs/architecture/integrations/shopify.md → "OAuth flow".
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyShopifyCallbackHmac(
  searchParams: URLSearchParams,
  clientSecret: string | undefined,
): boolean {
  const provided = searchParams.get("hmac");
  if (!provided || !clientSecret) return false;
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push([key, value]);
  }
  const message = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", clientSecret).update(message).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
