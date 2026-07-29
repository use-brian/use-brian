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

/**
 * Body for the authorization-code exchange.
 *
 * `expiring: 1` is load-bearing and must never be dropped. Omitting it makes
 * Shopify mint a PERMANENT offline token with no refresh token, which in turn
 * makes `createShopifyTokenManager` unreachable dead code — a failure that is
 * invisible locally (the connector works fine) right up until Shopify starts
 * rejecting non-expiring tokens on 2027-01-01. Public apps created on or
 * after 2026-04-01 are required to use expiring tokens.
 */
export function buildShopifyTokenExchangeBody(params: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Record<string, string | number> {
  return {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    expiring: 1,
  };
}

export type ShopifyTokenResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
};

/**
 * Classify a token response into the stored tuple. The SHAPE is the
 * discriminator downstream (`isManagedShopifyTokens`), not any explicit flag:
 * a managed tuple carries `refreshToken` + `expiresAt`, a static one carries
 * neither. `now` is injected so the expiry math is testable.
 */
export function classifyShopifyTokens(
  tokens: ShopifyTokenResponse,
  now: number,
): { accessToken: string; refreshToken?: string; expiresAt?: string } | null {
  if (!tokens.access_token) return null;
  const managed = !!tokens.refresh_token && typeof tokens.expires_in === "number";
  if (!managed) return { accessToken: tokens.access_token };
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(now + Math.max(0, (tokens.expires_in as number) * 1000)).toISOString(),
  };
}
