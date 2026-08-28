import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeOidcTransaction } from "@/lib/oidc-transaction";

const ISSUER = "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client";
const BRIDGE = "b".repeat(32);

vi.mock("@/lib/oidc", () => ({
  discoverOidc: vi.fn().mockResolvedValue({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` }),
  exchangeOidcCode: vi.fn().mockResolvedValue("id-token"),
  verifyOidcIdentity: vi.fn().mockResolvedValue({
    issuer: ISSUER,
    subject: "subject",
    email: "admin@example.com",
    emailVerified: true,
  }),
}));

function configure() {
  vi.stubEnv("OUTPOST_AUTH_OIDC_ENABLED", "true");
  vi.stubEnv("OUTPOST_OIDC_ISSUER_URL", ISSUER);
  vi.stubEnv("OUTPOST_OIDC_CLIENT_ID", "client");
  vi.stubEnv("OUTPOST_OIDC_CLIENT_SECRET", "secret");
  vi.stubEnv("OUTPOST_OIDC_PROVIDER_NAME", "Cloudflare Access");
  vi.stubEnv("OUTPOST_AUTH_BRIDGE_SECRET", BRIDGE);
}

function callbackRequest() {
  const transaction = serializeOidcTransaction({
    state: "s".repeat(43),
    nonce: "n".repeat(43),
    verifier: "v".repeat(64),
    createdAt: Date.now(),
    next: "http://localhost:3003/w/one",
  }, BRIDGE);
  return new Request(`http://localhost:3005/api/auth/oidc/callback?code=code&state=${"s".repeat(43)}`, {
    headers: { Cookie: `brian_oidc_tx=${transaction}` },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("[COMP:app/outpost-auth] OIDC callback", () => {
  it("installs the Brian session and clears provider transaction state", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      user: { id: "u1", name: "Admin", email: "admin@example.com" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const { GET } = await import("./route");
    const response = await GET(callbackRequest());
    const cookies = response.headers.getSetCookie().join("\n");
    expect(response.headers.get("location")).toBe("http://localhost:3003/w/one");
    expect(cookies).toContain("access_token=access");
    expect(cookies).toContain("refresh_token=refresh");
    expect(cookies).toContain("brian_oidc_tx=;");
  });

  it("maps admission rejection to fixed portal copy without session cookies", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "email_enrollment_required" }), { status: 403 })));
    const { GET } = await import("./route");
    const response = await GET(callbackRequest());
    expect(response.headers.get("location")).toContain("error=enrollment_required");
    expect(response.headers.getSetCookie().join("\n")).not.toContain("access_token=");
  });
});
