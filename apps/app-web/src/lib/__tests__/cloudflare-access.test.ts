import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authorizeCloudflareOwner,
  readCloudflareAccessOwnerConfig,
} from "@/lib/cloudflare-access";

const TEAM_DOMAIN = "https://use-brian.cloudflareaccess.com";
const AUDIENCE =
  "354ba8b4a3e116c80ad66dee6b8ea2fca3b68522ef57313b2a7864bdbc4e0c02";
const OWNER_EMAILS = "wongkahinhinson@gmail.com,hinson@usebrian.ai";
const ENABLED_ENV = {
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUDIENCE,
  USEBRIAN_OWNER_EMAILS: OWNER_EMAILS,
};

let privateKey: CryptoKey;
let localKeySet: JWTVerifyGetKey;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  localKeySet = createLocalJWKSet({ keys: [publicJwk] });
});

async function assertion(
  email: string,
  overrides: {
    issuer?: string;
    audience?: string;
    expiresAt?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? TEAM_DOMAIN)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(privateKey);
}

function request(token?: string): Request {
  return new Request("https://hinson.usebrian.ai/api/auth/local-session", {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : undefined,
  });
}

const resolveKey = () => localKeySet;

describe("[COMP:app-web/cloudflare-access-owner] owner configuration", () => {
  it("leaves localhost OSS behavior unchanged when the gate is absent", () => {
    expect(readCloudflareAccessOwnerConfig({})).toEqual({ mode: "disabled" });
  });

  it("fails closed when only part of the three-part gate is configured", () => {
    expect(
      readCloudflareAccessOwnerConfig({
        CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      }),
    ).toEqual({ mode: "invalid" });
  });

  it("rejects an unpinned team domain and malformed owner address", () => {
    expect(
      readCloudflareAccessOwnerConfig({
        ...ENABLED_ENV,
        CF_ACCESS_TEAM_DOMAIN: "https://example.com",
      }),
    ).toEqual({ mode: "invalid" });
    expect(
      readCloudflareAccessOwnerConfig({
        ...ENABLED_ENV,
        USEBRIAN_OWNER_EMAILS: "not-an-email",
      }),
    ).toEqual({ mode: "invalid" });
  });
});

describe("[COMP:app-web/cloudflare-access-owner] signed owner assertion", () => {
  it("permits the local launcher when the remote gate is disabled", async () => {
    await expect(
      authorizeCloudflareOwner(request(), { env: {} }),
    ).resolves.toEqual({ ok: true, email: null });
  });

  it("requires an assertion when the remote gate is enabled", async () => {
    await expect(
      authorizeCloudflareOwner(request(), { env: ENABLED_ENV, resolveKey }),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: "cloudflare_access_required",
    });
  });

  it("accepts a signed allowlisted email case-insensitively", async () => {
    const token = await assertion("Hinson@UseBrian.ai");
    await expect(
      authorizeCloudflareOwner(request(token), {
        env: ENABLED_ENV,
        resolveKey,
      }),
    ).resolves.toEqual({ ok: true, email: "hinson@usebrian.ai" });
  });

  it("rejects an email that Cloudflare allowed but the machine did not", async () => {
    const token = await assertion("contact@usebrian.ai");
    await expect(
      authorizeCloudflareOwner(request(token), {
        env: ENABLED_ENV,
        resolveKey,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "cloudflare_access_denied",
    });
  });

  it("rejects the wrong issuer, audience, or an expired assertion", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = await Promise.all([
      assertion("hinson@usebrian.ai", {
        issuer: "https://other.cloudflareaccess.com",
      }),
      assertion("hinson@usebrian.ai", { audience: "different-audience-value" }),
      assertion("hinson@usebrian.ai", { expiresAt: now - 60 }),
    ]);

    for (const token of tokens) {
      await expect(
        authorizeCloudflareOwner(request(token), {
          env: ENABLED_ENV,
          resolveKey,
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 403,
        error: "cloudflare_access_denied",
      });
    }
  });

  it("pins the remote key URL to the configured team domain", async () => {
    const token = await assertion("hinson@usebrian.ai");
    let seenUrl: URL | undefined;

    await authorizeCloudflareOwner(request(token), {
      env: ENABLED_ENV,
      resolveKey: (certsUrl) => {
        seenUrl = certsUrl;
        return localKeySet;
      },
    });

    expect(seenUrl?.toString()).toBe(
      "https://use-brian.cloudflareaccess.com/cdn-cgi/access/certs",
    );
  });
});
