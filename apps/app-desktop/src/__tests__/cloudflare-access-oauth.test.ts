import { describe, expect, it, vi } from "vitest";

import {
  accessAuthorizationForUrl,
  accessGrantMatchesApp,
  buildAccessAuthorizationUrl,
  buildAccessLoopbackRedirectUri,
  classifyDesktopConfigAccessResponse,
  discoverAccessOAuth,
  exchangeAccessCode,
  isAccessGrantExpiring,
  isTrustedAccessEndpoint,
  isTrustedResourceMetadataUrl,
  parseAccessGrant,
  parseAccessLoopbackCallback,
  parseResourceMetadataChallenge,
  refreshAccessGrant,
  registerAccessClient,
  serializeAccessGrant,
  type AccessOAuthMetadata,
  type CloudflareAccessGrant,
} from "../cloudflare-access-oauth.js";

const APP = "https://hinson.usebrian.ai";
const RESOURCE_METADATA = `${APP}/.well-known/oauth-protected-resource`;
const TEAM = "https://use-brian.cloudflareaccess.com";
const NOW = 1_800_000_000_000;

function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
} {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const metadata: AccessOAuthMetadata = {
  resource: APP,
  authorizationEndpoint: `${TEAM}/cdn-cgi/access/oauth/authorize`,
  tokenEndpoint: `${TEAM}/cdn-cgi/access/oauth/token`,
  registrationEndpoint: `${TEAM}/cdn-cgi/access/oauth/register`,
};

const grant: CloudflareAccessGrant = {
  v: 1,
  resource: APP,
  clientId: "client-1",
  accessToken: "oauth:access",
  refreshToken: "oauth:refresh",
  accessTokenExpiresAt: NOW + 900_000,
  tokenEndpoint: metadata.tokenEndpoint,
};

describe("[COMP:app-desktop/cloudflare-access-oauth] challenge classification", () => {
  it("extracts resource metadata from a Bearer challenge with other params", () => {
    expect(
      parseResourceMetadataChallenge(
        `Bearer realm="Access", resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`,
      ),
    ).toBe(RESOURCE_METADATA);
    expect(parseResourceMetadataChallenge("Basic realm=x")).toBeNull();
  });

  it("recognizes Managed OAuth's 401 challenge", () => {
    expect(
      classifyDesktopConfigAccessResponse({
        status: 401,
        wwwAuthenticate: `Bearer resource_metadata="${RESOURCE_METADATA}"`,
        location: null,
        appUrl: APP,
      }),
    ).toEqual({ kind: "managed-oauth", resourceMetadataUrl: RESOURCE_METADATA });
  });

  it("recognizes traditional Cloudflare Access redirects", () => {
    expect(
      classifyDesktopConfigAccessResponse({
        status: 302,
        wwwAuthenticate: null,
        location: `${TEAM}/cdn-cgi/access/login/hinson`,
        appUrl: APP,
      }),
    ).toEqual({ kind: "legacy-access" });
    expect(
      classifyDesktopConfigAccessResponse({
        status: 302,
        wwwAuthenticate: null,
        location: "/cdn-cgi/access/login/hinson",
        appUrl: APP,
      }),
    ).toEqual({ kind: "legacy-access" });
  });

  it("does not misclassify ordinary failures and redirects", () => {
    expect(
      classifyDesktopConfigAccessResponse({
        status: 404,
        wwwAuthenticate: null,
        location: null,
        appUrl: APP,
      }),
    ).toEqual({ kind: "none" });
    expect(
      classifyDesktopConfigAccessResponse({
        status: 302,
        wwwAuthenticate: null,
        location: "https://example.com/login",
        appUrl: APP,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("[COMP:app-desktop/cloudflare-access-oauth] discovery trust", () => {
  it("pins resource metadata to the exact HTTPS app origin", () => {
    expect(isTrustedResourceMetadataUrl(RESOURCE_METADATA, APP)).toBe(true);
    expect(isTrustedResourceMetadataUrl("http://hinson.usebrian.ai/meta", APP)).toBe(false);
    expect(isTrustedResourceMetadataUrl("https://evil.example/meta", APP)).toBe(false);
  });

  it("allows endpoints only on the app or a Cloudflare Access team domain", () => {
    expect(isTrustedAccessEndpoint(`${APP}/oauth/authorize`, APP)).toBe(true);
    expect(isTrustedAccessEndpoint(`${TEAM}/oauth/authorize`, APP)).toBe(true);
    expect(isTrustedAccessEndpoint("https://evil.example/oauth", APP)).toBe(false);
    expect(isTrustedAccessEndpoint("http://use-brian.cloudflareaccess.com/oauth", APP)).toBe(false);
  });

  it("accepts Cloudflare's direct app-domain authorization metadata", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      response(200, {
        issuer: TEAM,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        registration_endpoint: metadata.registrationEndpoint,
      }),
    );
    await expect(discoverAccessOAuth(APP, RESOURCE_METADATA, fetchImpl)).resolves.toEqual(metadata);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses a direct combined metadata response's canonical same-origin resource", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      response(200, {
        resource: `${APP}/api/desktop-config`,
        issuer: TEAM,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        registration_endpoint: metadata.registrationEndpoint,
      }),
    );
    await expect(discoverAccessOAuth(APP, RESOURCE_METADATA, fetchImpl)).resolves.toMatchObject({
      resource: `${APP}/api/desktop-config`,
    });
  });

  it("supports the two-step protected-resource and authorization-server metadata shape", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => {
      call += 1;
      return call === 1
        ? response(200, {
          resource: `${APP}/`,
          authorization_servers: [TEAM],
        })
        : response(200, {
          issuer: TEAM,
          authorization_endpoint: metadata.authorizationEndpoint,
          token_endpoint: metadata.tokenEndpoint,
          registration_endpoint: metadata.registrationEndpoint,
        });
    });
    await expect(discoverAccessOAuth(APP, RESOURCE_METADATA, fetchImpl)).resolves.toEqual({
      ...metadata,
      resource: `${APP}/`,
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `${TEAM}/.well-known/oauth-authorization-server`,
    );
  });

  it("fails closed when the challenge or discovered endpoints leave the trust boundary", async () => {
    await expect(
      discoverAccessOAuth(APP, "https://evil.example/meta", vi.fn()),
    ).rejects.toMatchObject({ code: "untrusted-metadata" });

    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      response(200, {
        authorization_endpoint: "https://evil.example/authorize",
        token_endpoint: metadata.tokenEndpoint,
        registration_endpoint: metadata.registrationEndpoint,
      }),
    );
    await expect(discoverAccessOAuth(APP, RESOURCE_METADATA, fetchImpl)).rejects.toMatchObject({
      code: "untrusted-metadata",
    });
  });
});

describe("[COMP:app-desktop/cloudflare-access-oauth] client + authorization request", () => {
  it("registers a public native client with the exact loopback redirect", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      capturedInit = init;
      return response(201, { client_id: "dynamic-client", client_secret: "optional-secret" });
    });
    const redirectUri = buildAccessLoopbackRedirectUri(45678);
    await expect(registerAccessClient(metadata, redirectUri, fetchImpl)).resolves.toEqual({
      clientId: "dynamic-client",
      clientSecret: "optional-secret",
    });
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("builds an RFC 8707 resource-bound PKCE authorization URL", () => {
    const redirectUri = buildAccessLoopbackRedirectUri(45678);
    const url = new URL(
      buildAccessAuthorizationUrl({
        metadata,
        client: { clientId: "dynamic-client" },
        redirectUri,
        challenge: "challenge",
        state: "state",
      }),
    );
    expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "dynamic-client",
      redirect_uri: redirectUri,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state",
      resource: APP,
    });
  });

  it("parses only the expected loopback path and state", () => {
    expect(
      parseAccessLoopbackCallback(
        "/cloudflare-access/callback?code=abc&state=state",
        "state",
      ),
    ).toEqual({ kind: "code", code: "abc" });
    expect(
      parseAccessLoopbackCallback(
        "/cloudflare-access/callback?error=access_denied&state=state",
        "state",
      ),
    ).toEqual({ kind: "error", error: "access_denied" });
    expect(
      parseAccessLoopbackCallback("/cloudflare-access/callback?code=abc&state=wrong", "state"),
    ).toBeNull();
    expect(parseAccessLoopbackCallback("/cb?code=abc&state=state", "state")).toBeNull();
  });
});

describe("[COMP:app-desktop/cloudflare-access-oauth] token lifecycle", () => {
  it("exchanges a code and computes expiry from the opaque token response", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      capturedInit = init;
      return response(200, {
        access_token: "oauth:new-access",
        refresh_token: "oauth:new-refresh",
        token_type: "Bearer",
        expires_in: 900,
      });
    });
    const result = await exchangeAccessCode(
      {
        metadata,
        client: { clientId: "client-1" },
        redirectUri: buildAccessLoopbackRedirectUri(45678),
        code: "code",
        verifier: "verifier",
        nowMs: NOW,
      },
      fetchImpl,
    );
    expect(result).toEqual({
      ...grant,
      accessToken: "oauth:new-access",
      refreshToken: "oauth:new-refresh",
    });
    const body = new URLSearchParams(String(capturedInit?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("resource")).toBe(APP);
  });

  it("rotates access and refresh tokens, retaining refresh when not rotated", async () => {
    const rotated = await refreshAccessGrant(
      grant,
      NOW,
      vi.fn(async () =>
        response(200, {
          access_token: "oauth:rotated",
          refresh_token: "oauth:rotated-refresh",
          expires_in: 600,
        }),
      ),
    );
    expect(rotated).toMatchObject({
      accessToken: "oauth:rotated",
      refreshToken: "oauth:rotated-refresh",
      accessTokenExpiresAt: NOW + 600_000,
    });
    const retained = await refreshAccessGrant(
      grant,
      NOW,
      vi.fn(async () => response(200, { access_token: "oauth:rotated", expires_in: 600 })),
    );
    expect(retained?.refreshToken).toBe(grant.refreshToken);
  });

  it("returns null for a definitively rejected refresh and throws on transient failure", async () => {
    await expect(
      refreshAccessGrant(grant, NOW, vi.fn(async () => response(401))),
    ).resolves.toBeNull();
    await expect(
      refreshAccessGrant(grant, NOW, vi.fn(async () => response(503))),
    ).rejects.toMatchObject({ code: "token-failed" });
  });

  it("round-trips a valid encrypted-store payload and rejects malformed records", () => {
    expect(parseAccessGrant(serializeAccessGrant(grant))).toEqual(grant);
    expect(parseAccessGrant("{bad")).toBeNull();
    expect(parseAccessGrant(JSON.stringify({ ...grant, accessToken: "" }))).toBeNull();
    expect(parseAccessGrant(JSON.stringify({ ...grant, tokenEndpoint: "http://insecure/token" }))).toBeNull();
  });

  it("uses expires_in timing rather than trying to decode the opaque token", () => {
    expect(isAccessGrantExpiring(grant, NOW)).toBe(false);
    expect(isAccessGrantExpiring(grant, grant.accessTokenExpiresAt - 30_000)).toBe(true);
  });
});

describe("[COMP:app-desktop/cloudflare-access-oauth] exact-origin bearer boundary", () => {
  it("authorizes every path on the exact protected app origin", () => {
    expect(accessGrantMatchesApp(grant, APP)).toBe(true);
    expect(accessAuthorizationForUrl(grant, `${APP}/api/desktop-config`)).toBe(
      "Bearer oauth:access",
    );
    expect(accessAuthorizationForUrl(grant, `${APP}/w/one/p`)).toBe("Bearer oauth:access");
  });

  it("never leaks the Access bearer to the Brian API, a sibling, or a lookalike host", () => {
    expect(accessAuthorizationForUrl(grant, "https://api.hinson.usebrian.ai/health")).toBeNull();
    expect(accessAuthorizationForUrl(grant, "https://other.usebrian.ai/")).toBeNull();
    expect(accessAuthorizationForUrl(grant, "https://hinson.usebrian.ai.evil.example/")).toBeNull();
    expect(accessAuthorizationForUrl(grant, "not a url")).toBeNull();
  });
});
