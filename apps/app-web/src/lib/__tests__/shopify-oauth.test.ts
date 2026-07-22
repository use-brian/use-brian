/**
 * Shopify OAuth callback verification helpers (app-web side).
 * Component tag: [COMP:api/shopify-oauth].
 *
 * The callback route gates on TWO signatures before any token exchange: our
 * own state nonce (covered by connector-oauth-state tests) and Shopify's
 * `hmac` query param, verified here. Domain normalization doubles as the
 * authorize-URL injection guard.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyCallbackHmac } from "../shopify-oauth";
import { normalizeShopifyShopDomain } from "../shopify-domain";

const SECRET = "app-client-secret";

function signedParams(overrides: Record<string, string> = {}): URLSearchParams {
  const base: Record<string, string> = {
    code: "c0de",
    shop: "teststore.myshopify.com",
    state: "shopify:ws-1:nonce",
    timestamp: "1700000000",
    ...overrides,
  };
  const message = Object.keys(base)
    .sort()
    .map((k) => `${k}=${base[k]}`)
    .join("&");
  const hmac = createHmac("sha256", SECRET).update(message).digest("hex");
  return new URLSearchParams({ ...base, hmac });
}

describe("[COMP:api/shopify-oauth] Shopify OAuth callback verification", () => {
  it("accepts a correctly signed callback query", () => {
    expect(verifyShopifyCallbackHmac(signedParams(), SECRET)).toBe(true);
  });

  it("rejects a tampered parameter", () => {
    const params = signedParams();
    params.set("shop", "evil.myshopify.com");
    expect(verifyShopifyCallbackHmac(params, SECRET)).toBe(false);
  });

  it("rejects a wrong secret, a missing hmac, and an unset secret", () => {
    expect(verifyShopifyCallbackHmac(signedParams(), "wrong")).toBe(false);
    const noHmac = signedParams();
    noHmac.delete("hmac");
    expect(verifyShopifyCallbackHmac(noHmac, SECRET)).toBe(false);
    expect(verifyShopifyCallbackHmac(signedParams(), undefined)).toBe(false);
  });

  it("excludes hmac and legacy signature params from the signed message", () => {
    const params = signedParams();
    params.set("signature", "legacy-noise");
    expect(verifyShopifyCallbackHmac(params, SECRET)).toBe(true);
  });

  it("normalizeShopifyShopDomain canonicalizes and rejects like the server helper", () => {
    expect(normalizeShopifyShopDomain("mystore")).toBe("mystore.myshopify.com");
    expect(normalizeShopifyShopDomain("https://MyStore.myshopify.com/admin")).toBe("mystore.myshopify.com");
    expect(normalizeShopifyShopDomain("mystore.com")).toBeNull();
    expect(normalizeShopifyShopDomain("evil.com/#.myshopify.com")).toBeNull();
    expect(normalizeShopifyShopDomain("")).toBeNull();
  });
});
