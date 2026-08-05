import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MSGRAPH_DEFAULT_TENANT,
  buildMsGraphAuthorizeUrl,
  msGraphAuthorizeUrl,
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
 * The default tenant segment is asserted literally on purpose: `organizations`
 * (not `common`) is what keeps a personal Microsoft account out of the picker,
 * and it has to match `DEFAULT_TENANT` in `packages/api/src/msgraph/token.ts`
 * or the authorize and refresh halves of one round trip disagree.
 */
describe("[COMP:msgraph/oauth] Microsoft Graph connector OAuth", () => {
  const state = "msgraph:11111111-1111-1111-1111-111111111111:abcdefghijklmnop";

  function authorizeParams(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it("targets the Entra endpoints, never Google's", () => {
    expect(msGraphAuthorizeUrl()).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(MSGRAPH_DEFAULT_TENANT).toBe("organizations");

    const url = buildMsGraphAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "https://app.usebrian.ai/api/auth/callback/msgraph",
      state,
      scopes: ["offline_access", "ChannelMessage.Read.All"],
    });
    expect(url.startsWith(`${msGraphAuthorizeUrl()}?`)).toBe(true);
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

  /**
   * A workspace that registered a SINGLE-tenant app cannot use
   * `organizations` - Entra will not issue for it. The tenant travels with the
   * credentials from the API so the authorize call and the token call (which
   * reads the same stored row) cannot disagree about the authority.
   */
  it("pins the authority to a workspace's own tenant when it has one", () => {
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const url = buildMsGraphAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "https://app.usebrian.ai/api/auth/callback/msgraph",
      state,
      tenant,
    });
    expect(url.startsWith(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?`)).toBe(true);
    // Blank / absent falls back rather than producing an empty path segment.
    expect(msGraphAuthorizeUrl("")).toBe(msGraphAuthorizeUrl());
    expect(msGraphAuthorizeUrl("   ")).toBe(msGraphAuthorizeUrl());
    expect(msGraphAuthorizeUrl(null)).toBe(msGraphAuthorizeUrl());
  });

  it("always requests offline_access and openid, and never duplicates a scope", () => {
    const scopes = msGraphScopes();
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("openid");
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  /**
   * The load-bearing boundary of the workspace-owned-app design: the client
   * secret may belong to a CUSTOMER (their own Entra registration, stored
   * encrypted against their workspace), so app-web must never exchange a code.
   * It verifies the CSRF nonce and forwards to the API, which holds the secret.
   *
   * Asserted against the source text because the failure it guards is someone
   * "simplifying" the callback back into a direct token POST - which typechecks,
   * passes every unit test, and quietly ships a customer secret into a Next.js
   * runtime that has no way to read it on the hosted product anyway.
   */
  it("never exchanges the code in app-web", () => {
    const callback = readFileSync(
      resolve(process.cwd(), "src/app/api/auth/callback/msgraph/route.ts"),
      "utf8",
    );
    const helper = readFileSync(resolve(process.cwd(), "src/lib/msgraph-oauth.ts"), "utf8");

    // The exchange lives in the API; app-web posts the raw code to it.
    expect(callback).toContain("/api/connectors/msgraph/oauth-callback");
    // No token endpoint and no secret READ in either file. Matched on
    // `process.env.` rather than the bare name so the comments explaining why
    // the exchange moved are still allowed to name it.
    expect(callback).not.toContain("oauth2/v2.0/token");
    expect(callback).not.toContain("client_secret:");
    expect(callback).not.toContain("process.env.MSGRAPH_CLIENT_SECRET");
    expect(helper).not.toContain("client_secret:");
    expect(helper).not.toContain("process.env.MSGRAPH_CLIENT_SECRET");
  });

  /**
   * The client id is NOT inlined at build time any more: it is per-workspace
   * and only the API can resolve it. A `NEXT_PUBLIC_MSGRAPH_CLIENT_ID` here
   * would silently win for every workspace on the deployment.
   */
  it("keeps both halves of the app pair out of the browser bundle", () => {
    const repoRoot = resolve(process.cwd(), "../..");
    const turbo = JSON.parse(readFileSync(resolve(repoRoot, "turbo.json"), "utf8")) as {
      tasks: { build: { env: string[] } };
    };
    const nextConfig = readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8");
    const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");

    expect(turbo.tasks.build.env).not.toContain("MSGRAPH_CLIENT_ID");
    expect(turbo.tasks.build.env).not.toContain("MSGRAPH_CLIENT_SECRET");
    expect(nextConfig).not.toContain("NEXT_PUBLIC_MSGRAPH_CLIENT_ID:");
    expect(nextConfig).not.toContain("process.env.MSGRAPH_CLIENT_SECRET");
    // The deployment-wide fallback still exists, server-side, for self-hosts.
    expect(envExample).toContain("MSGRAPH_CLIENT_ID=");
    expect(envExample).toContain("MSGRAPH_CLIENT_SECRET=");
  });
});
