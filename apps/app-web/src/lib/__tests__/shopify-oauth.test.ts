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
import {
  buildShopifyTokenExchangeBody,
  classifyShopifyTokens,
  verifyShopifyCallbackHmac,
} from "../shopify-oauth";
import { normalizeShopifyShopDomain, isShpssPrefixed } from "../shopify-domain";

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

  it("asks for an EXPIRING offline token in the code exchange", () => {
    // Regression guard. Dropping `expiring` makes Shopify mint a permanent
    // token with no refresh token, which silently strands the whole rotation
    // path — and nothing else in the suite would notice.
    const body = buildShopifyTokenExchangeBody({
      clientId: "cid",
      clientSecret: "csec",
      code: "c0de",
    });
    expect(body.expiring).toBe(1);
    expect(body).toEqual({
      client_id: "cid",
      client_secret: "csec",
      code: "c0de",
      expiring: 1,
    });
  });

  it("classifies an expiring token response into a managed tuple", () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0);
    const tuple = classifyShopifyTokens(
      {
        access_token: "shpat_new",
        refresh_token: "shprt_new",
        expires_in: 3600,
        scope: "read_products",
      },
      now,
    );
    expect(tuple).toEqual({
      accessToken: "shpat_new",
      refreshToken: "shprt_new",
      expiresAt: new Date(now + 3_600_000).toISOString(),
    });
  });

  it("classifies a legacy non-expiring response as a static tuple", () => {
    // No refreshToken/expiresAt: the SHAPE is what isManagedShopifyTokens
    // reads downstream, so a static tuple must carry neither key.
    const tuple = classifyShopifyTokens({ access_token: "shpat_legacy" }, 0);
    expect(tuple).toEqual({ accessToken: "shpat_legacy" });
    expect(tuple).not.toHaveProperty("refreshToken");
    expect(tuple).not.toHaveProperty("expiresAt");
  });

  it("treats a half-expiring response as static and a token-less one as null", () => {
    // refresh_token without expires_in (or vice versa) is not a usable
    // rotation tuple — fall back to static rather than storing a broken one.
    expect(classifyShopifyTokens({ access_token: "t", refresh_token: "r" }, 0)).toEqual({
      accessToken: "t",
    });
    expect(classifyShopifyTokens({ access_token: "t", expires_in: 3600 }, 0)).toEqual({
      accessToken: "t",
    });
    expect(classifyShopifyTokens({ refresh_token: "r", expires_in: 3600 }, 0)).toBeNull();
    expect(classifyShopifyTokens({}, 0)).toBeNull();
  });

  describe("isShpssPrefixed", () => {
    // The connect form's only credential is a pasted token, and a Dev Dashboard
    // app shows a client secret and NO access token, so `shpss_` is the most
    // likely wrong paste. Catching it locally turns a 401 round trip into a
    // message that names the mistake.
    it("flags an API secret key regardless of case or padding", () => {
      expect(isShpssPrefixed("shpss_abc123")).toBe(true);
      expect(isShpssPrefixed("  SHPSS_ABC123  ")).toBe(true);
    });

    it("passes every real access-token prefix through", () => {
      // Documented access-token prefixes: shpat_ (public), shpca_ (custom),
      // shppa_ (legacy private). None may be rejected by this guard.
      for (const t of ["shpat_abc", "shpca_abc", "shppa_abc"]) {
        expect(isShpssPrefixed(t)).toBe(false);
      }
      // And it must not fire on a merely similar prefix or an empty field.
      expect(isShpssPrefixed("shp_abc")).toBe(false);
      expect(isShpssPrefixed("")).toBe(false);
    });
  });
});
