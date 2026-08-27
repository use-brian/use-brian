import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { PortalConfig } from "./config";
import { authorizationUrl, discoverOidc, exchangeOidcCode, oidcCallbackUrl, pkceChallenge, verifyOidcIdentity } from "./oidc";

const config: PortalConfig = {
  internalApiUrl: "http://127.0.0.1:4000",
  portalOrigin: "https://auth.example.test",
  appOrigin: "https://app.example.test",
  trustProxyHeaders: false,
  emailEnabled: true,
  oidcEnabled: true,
  oidc: {
    issuerUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client",
    clientId: "client",
    clientSecret: "secret",
    providerName: "Cloudflare Access",
    bridgeSecret: "b".repeat(32),
    allowedEndpointOrigins: ["https://team.cloudflareaccess.com"],
    emailVerification: "claim",
  },
};

describe("[COMP:app/outpost-auth] OIDC protocol", () => {
  it("derives the callback and authorization-code PKCE request from trusted config", () => {
    const url = authorizationUrl({
      issuer: config.oidc!.issuerUrl,
      authorization_endpoint: "https://team.cloudflareaccess.com/authorization",
      token_endpoint: "https://team.cloudflareaccess.com/token",
      jwks_uri: "https://team.cloudflareaccess.com/jwks",
    }, config, { state: "state", nonce: "nonce", challenge: "challenge" });
    expect(oidcCallbackUrl(config)).toBe("https://auth.example.test/api/auth/oidc/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("creates the RFC 7636 S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("rejects discovery endpoints outside the configured issuer origin", async () => {
    const fetchFn = async () => new Response(JSON.stringify({
      issuer: config.oidc!.issuerUrl,
      authorization_endpoint: "https://evil.example/authorize",
      token_endpoint: "https://team.cloudflareaccess.com/token",
      jwks_uri: "https://team.cloudflareaccess.com/jwks",
    }), { status: 200 });
    await expect(discoverOidc(config, fetchFn as typeof fetch)).rejects.toThrow(/authorization_endpoint invalid/);
  });

  it("allows a discovered endpoint on an explicitly configured provider origin", async () => {
    const split = { ...config, oidc: { ...config.oidc!, allowedEndpointOrigins: [
      "https://team.cloudflareaccess.com",
      "https://tokens.example.test",
    ] } };
    const fetchFn = async () => new Response(JSON.stringify({
      issuer: split.oidc.issuerUrl,
      authorization_endpoint: `${split.oidc.issuerUrl}/authorization`,
      token_endpoint: "https://tokens.example.test/token",
      jwks_uri: "https://tokens.example.test/jwks",
    }), { status: 200 });
    await expect(discoverOidc(split, fetchFn as typeof fetch)).resolves.toMatchObject({
      token_endpoint: "https://tokens.example.test/token",
    });
  });

  it("form-encodes confidential client credentials for Basic authentication", async () => {
    const special = { ...config, oidc: { ...config.oidc!, clientId: "client id", clientSecret: "secret:value" } };
    let authorization = "";
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ id_token: "token" }), { status: 200 });
    };
    await expect(exchangeOidcCode({
      issuer: special.oidc.issuerUrl,
      authorization_endpoint: `${special.oidc.issuerUrl}/authorization`,
      token_endpoint: `${special.oidc.issuerUrl}/token`,
      jwks_uri: `${special.oidc.issuerUrl}/jwks`,
    }, special, "code", "v".repeat(64), fetchFn as typeof fetch)).resolves.toBe("token");
    expect(Buffer.from(authorization.slice("Basic ".length), "base64").toString()).toBe("client+id:secret%3Avalue");
  });

  it("requires email_verified by default and permits explicit exact-issuer trust", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "key-1", alg: "RS256", use: "sig" };
    const token = await new SignJWT({ email: "admin@example.com", nonce: "nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(config.oidc!.issuerUrl)
      .setAudience(config.oidc!.clientId)
      .setSubject("subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const metadata = {
      issuer: config.oidc!.issuerUrl,
      authorization_endpoint: `${config.oidc!.issuerUrl}/authorization`,
      token_endpoint: `${config.oidc!.issuerUrl}/token`,
      jwks_uri: `${config.oidc!.issuerUrl}/jwks`,
    };
    const fetchFn = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    await expect(verifyOidcIdentity(token, metadata, config, "nonce", fetchFn as typeof fetch)).rejects.toThrow(/verified email/);
    const issuerTrusted = { ...config, oidc: { ...config.oidc!, emailVerification: "issuer" as const } };
    await expect(verifyOidcIdentity(token, metadata, issuerTrusted, "nonce", fetchFn as typeof fetch)).resolves.toMatchObject({
      email: "admin@example.com",
      emailVerified: true,
    });
  });
});
