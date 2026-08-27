import { describe, expect, it } from "vitest";
import { resolvePortalConfig } from "./config";

describe("[COMP:app/outpost-auth] runtime configuration", () => {
  it("accepts exact customer origins under one isolated cookie namespace", () => {
    expect(resolvePortalConfig({
      NODE_ENV: "production",
      INTERNAL_API_URL: "http://127.0.0.1:4000",
      AUTH_PORTAL_URL: "https://auth.brian.example.com",
      AUTHED_APP_URL: "https://app.brian.example.com",
      COOKIE_DOMAIN: ".brian.example.com",
    })).toMatchObject({ cookieDomain: ".brian.example.com" });
  });

  it("fails production without an isolated cookie domain", () => {
    expect(() => resolvePortalConfig({
      NODE_ENV: "production",
      AUTH_PORTAL_URL: "https://auth.example.com",
      AUTHED_APP_URL: "https://app.example.com",
    })).toThrow(/COOKIE_DOMAIN/);
  });

  it("rejects origins outside the cookie namespace", () => {
    expect(() => resolvePortalConfig({
      NODE_ENV: "production",
      AUTH_PORTAL_URL: "https://auth.brian.customer.example",
      AUTHED_APP_URL: "https://app.other.example",
      COOKIE_DOMAIN: ".brian.customer.example",
    })).toThrow(/inside COOKIE_DOMAIN/);
  });

  it("rejects public and overly broad cookie suffixes", () => {
    expect(() => resolvePortalConfig({
      NODE_ENV: "production",
      AUTH_PORTAL_URL: "https://auth.com",
      AUTHED_APP_URL: "https://app.com",
      COOKIE_DOMAIN: ".com",
    })).toThrow(/COOKIE_DOMAIN/);
    expect(() => resolvePortalConfig({
      NODE_ENV: "production",
      AUTH_PORTAL_URL: "https://auth.example.com",
      AUTHED_APP_URL: "https://app.example.com",
      COOKIE_DOMAIN: ".example.com",
    })).toThrow(/COOKIE_DOMAIN/);
  });

  it("defaults to email-only and rejects disabling every provider", () => {
    expect(resolvePortalConfig({})).toMatchObject({ emailEnabled: true, oidcEnabled: false });
    expect(() => resolvePortalConfig({
      OUTPOST_AUTH_EMAIL_ENABLED: "false",
      OUTPOST_AUTH_OIDC_ENABLED: "false",
    })).toThrow(/at least one/);
  });

  it("accepts complete OIDC-only configuration", () => {
    expect(resolvePortalConfig({
      OUTPOST_AUTH_EMAIL_ENABLED: "false",
      OUTPOST_AUTH_OIDC_ENABLED: "true",
      OUTPOST_OIDC_ISSUER_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client",
      OUTPOST_OIDC_CLIENT_ID: "client",
      OUTPOST_OIDC_CLIENT_SECRET: "client-secret",
      OUTPOST_OIDC_PROVIDER_NAME: "Cloudflare Access",
      OUTPOST_AUTH_BRIDGE_SECRET: "b".repeat(32),
    })).toMatchObject({
      emailEnabled: false,
      oidcEnabled: true,
      oidc: { providerName: "Cloudflare Access", subjectIdentityEnabled: false },
    });
  });

  it("requires an explicit flag for issuer-subject identities without email", () => {
    const env = {
      OUTPOST_AUTH_OIDC_ENABLED: "true",
      OUTPOST_OIDC_ISSUER_URL: "https://id.example.com/tenant",
      OUTPOST_OIDC_CLIENT_ID: "client",
      OUTPOST_OIDC_CLIENT_SECRET: "secret",
      OUTPOST_OIDC_PROVIDER_NAME: "Company SSO",
      OUTPOST_AUTH_BRIDGE_SECRET: "b".repeat(32),
    };
    expect(resolvePortalConfig(env).oidc?.subjectIdentityEnabled).toBe(false);
    expect(resolvePortalConfig({ ...env, OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED: "true" }).oidc?.subjectIdentityEnabled).toBe(true);
    expect(() => resolvePortalConfig({ ...env, OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED: "yes" })).toThrow(/true, false/);
  });

  it("parses mapped OIDC enrollment metadata needed by the authorization request", () => {
    const env = {
      OUTPOST_AUTH_OIDC_ENABLED: "true",
      OUTPOST_OIDC_ISSUER_URL: "https://id.example.com/tenant",
      OUTPOST_OIDC_CLIENT_ID: "client",
      OUTPOST_OIDC_CLIENT_SECRET: "secret",
      OUTPOST_OIDC_PROVIDER_NAME: "Company SSO",
      OUTPOST_AUTH_BRIDGE_SECRET: "b".repeat(32),
      OUTPOST_OIDC_ENROLLMENT_MODE: "mapped",
      OUTPOST_OIDC_WORKSPACE_MAPPINGS: JSON.stringify({
        version: 1,
        groupClaim: "groups",
        additionalScopes: ["groups"],
        rules: [{ group: "engineering", workspaceId: "11111111-1111-4111-8111-111111111111" }],
      }),
    };
    expect(resolvePortalConfig(env).oidc?.enrollment).toEqual({
      mode: "mapped",
      groupClaim: "groups",
      additionalScopes: ["groups"],
    });
    expect(() => resolvePortalConfig({ ...env, OUTPOST_OIDC_WORKSPACE_MAPPINGS: "{" })).toThrow(/valid JSON/);
  });

  it("requires explicit issuer trust when the provider omits email_verified", () => {
    const env = {
      OUTPOST_AUTH_OIDC_ENABLED: "true",
      OUTPOST_OIDC_ISSUER_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client",
      OUTPOST_OIDC_CLIENT_ID: "client",
      OUTPOST_OIDC_CLIENT_SECRET: "secret",
      OUTPOST_OIDC_PROVIDER_NAME: "Cloudflare Access",
      OUTPOST_AUTH_BRIDGE_SECRET: "b".repeat(32),
    };
    expect(resolvePortalConfig(env).oidc?.emailVerification).toBe("claim");
    expect(resolvePortalConfig({ ...env, OUTPOST_OIDC_EMAIL_VERIFICATION: "issuer" }).oidc?.emailVerification).toBe("issuer");
    expect(() => resolvePortalConfig({ ...env, OUTPOST_OIDC_EMAIL_VERIFICATION: "none" })).toThrow(/claim or issuer/);
  });

  it("rejects malformed flags and incomplete OIDC configuration", () => {
    expect(() => resolvePortalConfig({ OUTPOST_AUTH_OIDC_ENABLED: "yes" })).toThrow(/true, false/);
    expect(() => resolvePortalConfig({ OUTPOST_AUTH_OIDC_ENABLED: "true" })).toThrow(/OUTPOST_OIDC_ISSUER_URL/);
  });
});
