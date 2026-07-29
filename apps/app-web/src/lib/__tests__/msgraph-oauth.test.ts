import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MSGRAPH_AUTHORIZE_URL,
  MSGRAPH_TOKEN_URL,
  buildMsGraphAuthorizeUrl,
  decodeMsGraphIdToken,
  msGraphScopes,
} from "@/lib/msgraph-oauth";

/**
 * The regression this file exists for: `OAUTH_SCOPES_WITH_EMAIL` in the Studio
 * connectors page prepends the GOOGLE userinfo.email scope to every entry of
 * OFFICIAL_OAUTH_SCOPES, and the Google branch is the fallthrough for anything
 * carrying scopes. A registered-but-unbranched OAuth connector therefore builds
 * a Google authorize URL with a Google client id. These assertions pin the
 * Microsoft endpoints and the parameter shape; the branch-ordering half is
 * pinned by `page.tsx` placing `id === "msgraph"` above that fallthrough.
 *
 * The tenant segment is asserted literally on purpose: `organizations` (not
 * `common`) is what keeps a personal Microsoft account out of the picker, and
 * it has to match `DEFAULT_TENANT` in `packages/api/src/msgraph/token.ts` or
 * the authorize and refresh halves of one round trip disagree.
 */
describe("[COMP:msgraph/oauth] Microsoft Graph connector OAuth", () => {
  const state = "msgraph:11111111-1111-1111-1111-111111111111:abcdefghijklmnop";

  function authorizeParams(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it("targets the Entra endpoints, never Google's", () => {
    expect(MSGRAPH_AUTHORIZE_URL).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(MSGRAPH_TOKEN_URL).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    );

    const url = buildMsGraphAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "https://app.usebrian.ai/api/auth/callback/msgraph",
      state,
      scopes: ["offline_access", "ChannelMessage.Read.All"],
    });
    expect(url.startsWith(`${MSGRAPH_AUTHORIZE_URL}?`)).toBe(true);
    expect(url).not.toContain("accounts.google.com");
    expect(url).not.toContain("googleapis.com");
  });

  it("builds the authorization-code request Entra expects", () => {
    const url = buildMsGraphAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "https://app.usebrian.ai/api/auth/callback/msgraph",
      state,
      scopes: ["offline_access", "openid", "ChannelMessage.Read.All"],
    });
    const params = authorizeParams(url);
    expect(params.get("client_id")).toBe("client-abc");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("response_mode")).toBe("query");
    expect(params.get("redirect_uri")).toBe(
      "https://app.usebrian.ai/api/auth/callback/msgraph",
    );
    expect(params.get("state")).toBe(state);
    // Space-delimited, per OAuth 2.0.
    expect(params.get("scope")).toBe("offline_access openid ChannelMessage.Read.All");
  });

  it("always requests offline_access and openid, and never duplicates a scope", () => {
    const scopes = msGraphScopes();
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("openid");
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("reads the tenant id and address out of an id_token", () => {
    const claims = {
      tid: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      preferred_username: "ada@contoso.onmicrosoft.com",
      name: "Ada Lovelace",
    };
    const idToken = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
    expect(decodeMsGraphIdToken(idToken)).toEqual({
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      email: "ada@contoso.onmicrosoft.com",
    });
  });

  it("prefers the email claim and tolerates a missing tenant", () => {
    const idToken = `x.${b64url('{"email":"ada@contoso.com","preferred_username":"ada"}')}.sig`;
    expect(decodeMsGraphIdToken(idToken)).toEqual({ email: "ada@contoso.com" });
  });

  it("returns no claims rather than throwing on a missing or malformed token", () => {
    expect(decodeMsGraphIdToken(undefined)).toEqual({});
    expect(decodeMsGraphIdToken("")).toEqual({});
    expect(decodeMsGraphIdToken("not-a-jwt")).toEqual({});
    expect(decodeMsGraphIdToken(`x.${b64url("not json")}.sig`)).toEqual({});
  });

  it("threads the public client id through Turbo without exposing the secret", () => {
    const repoRoot = resolve(process.cwd(), "../..");
    const turbo = JSON.parse(readFileSync(resolve(repoRoot, "turbo.json"), "utf8")) as {
      tasks: { build: { env: string[] } };
    };
    const nextConfig = readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8");
    const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");

    expect(turbo.tasks.build.env).toContain("MSGRAPH_CLIENT_ID");
    expect(turbo.tasks.build.env).not.toContain("MSGRAPH_CLIENT_SECRET");
    expect(nextConfig).toContain("process.env.MSGRAPH_CLIENT_ID");
    expect(nextConfig).not.toContain("process.env.MSGRAPH_CLIENT_SECRET");
    expect(envExample).toContain("MSGRAPH_CLIENT_ID=");
    expect(envExample).toContain("MSGRAPH_CLIENT_SECRET=");
  });
});

/** Encode a JSON string as an unpadded base64url JWT segment. */
function b64url(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}
