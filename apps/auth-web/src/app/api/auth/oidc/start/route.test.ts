import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ISSUER = "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client";

function configure() {
  vi.stubEnv("OUTPOST_AUTH_OIDC_ENABLED", "true");
  vi.stubEnv("OUTPOST_OIDC_ISSUER_URL", ISSUER);
  vi.stubEnv("OUTPOST_OIDC_CLIENT_ID", "client");
  vi.stubEnv("OUTPOST_OIDC_CLIENT_SECRET", "secret");
  vi.stubEnv("OUTPOST_OIDC_PROVIDER_NAME", "Cloudflare Access");
  vi.stubEnv("OUTPOST_AUTH_BRIDGE_SECRET", "b".repeat(32));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("[COMP:app/outpost-auth] OIDC start", () => {
  it("redirects with PKCE and stores host-only signed transaction state", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorization`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const response = await GET(new Request("http://localhost:3005/api/auth/oidc/start?next=http%3A%2F%2Flocalhost%3A3003%2Fw%2Fone"));
    const target = new URL(response.headers.get("location")!);
    const cookie = response.headers.get("set-cookie")!;
    expect(target.origin + target.pathname).toBe(`${ISSUER}/authorization`);
    expect(target.searchParams.get("redirect_uri")).toBe("http://localhost:3005/api/auth/oidc/callback");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(cookie).toContain("brian_oidc_tx=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).not.toContain("Domain=");
  });

  it("is unavailable when OIDC is disabled", async () => {
    const response = await GET(new Request("http://localhost:3005/api/auth/oidc/start"));
    expect(response.status).toBe(404);
  });
});
