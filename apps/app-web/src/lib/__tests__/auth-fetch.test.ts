import { describe, it, expect, vi, afterEach } from "vitest";
import { selectFreshestAccessToken, getValidAccessToken } from "@/lib/auth-fetch";

// Force the production refresh path (a primary auth origin is configured), so
// the offline guard below is the only thing standing between a stale token and
// a full-page bounce to the primary.
vi.mock("@/lib/primary-auth", () => ({
  primaryAuthUrl: () => "https://sidan.ai",
  buildPrimaryAuthUrl: () => "https://sidan.ai",
}));

/**
 * Build a JWT-shaped token whose payload carries `exp` (epoch seconds). Only
 * the middle segment matters to the decoder; header + signature are filler.
 * Standard padded base64 keeps `atob` happy in the node test env.
 */
function tokenWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: "u", exp })).toString(
    "base64",
  );
  return `h.${payload}.s`;
}

describe("[COMP:app-web/auth-fetch] access_token selection", () => {
  const NOW = 1_780_000_000; // fixed epoch seconds → deterministic exps

  it("returns the single token when only one is present", () => {
    const tok = tokenWithExp(NOW + 3600);
    expect(selectFreshestAccessToken(`access_token=${tok}; user=x`)).toBe(tok);
  });

  it("returns null when no access_token cookie is present", () => {
    expect(selectFreshestAccessToken("user=x; locale=en")).toBeNull();
    expect(selectFreshestAccessToken("")).toBeNull();
  });

  it("prefers the live token over an expired host-only twin (twin LAST)", () => {
    const live = tokenWithExp(NOW + 3600);
    const stale = tokenWithExp(NOW - 3600);
    // Live first, stale last — the old positional "pick last" would wrongly
    // return the stale twin here.
    expect(
      selectFreshestAccessToken(`access_token=${live}; access_token=${stale}`),
    ).toBe(live);
  });

  it("prefers the live token regardless of cookie order (twin FIRST)", () => {
    const live = tokenWithExp(NOW + 3600);
    const stale = tokenWithExp(NOW - 3600);
    expect(
      selectFreshestAccessToken(`access_token=${stale}; access_token=${live}`),
    ).toBe(live);
  });

  it("picks the further-future token between two live tokens", () => {
    const soon = tokenWithExp(NOW + 600);
    const later = tokenWithExp(NOW + 3600);
    expect(
      selectFreshestAccessToken(`access_token=${soon}; access_token=${later}`),
    ).toBe(later);
    expect(
      selectFreshestAccessToken(`access_token=${later}; access_token=${soon}`),
    ).toBe(later);
  });

  it("falls back to the last occurrence when nothing decodes (tie)", () => {
    expect(
      selectFreshestAccessToken("access_token=garbage1; access_token=garbage2"),
    ).toBe("garbage2");
  });
});

describe("[COMP:app-web/auth-fetch] offline refresh guard", () => {
  const NOW_SEC = Math.floor(Date.now() / 1000);
  const expiredToken = tokenWithExp(NOW_SEC - 3600); // stale → forces a refresh

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offline: does NOT navigate to the primary — returns the current token (no logout)", async () => {
    const location = { href: "https://app.sidan.ai/w/1", origin: "https://app.sidan.ai" };
    vi.stubGlobal("window", { location });
    vi.stubGlobal("document", { cookie: `access_token=${expiredToken}` });
    vi.stubGlobal("navigator", { onLine: false });

    const token = await getValidAccessToken();

    // The stale cookie token comes back as-is, and crucially the prod bounce did
    // NOT fire (href unchanged) — so the desktop shell never intercepts a failed
    // refresh and never bounces the user to sign-in. This is the offline→logout fix.
    expect(token).toBe(expiredToken);
    expect(location.href).toBe("https://app.sidan.ai/w/1");
  });

  it("online: a stale token triggers the primary refresh-and-return bounce (unchanged prod behavior)", async () => {
    const location = { href: "https://app.sidan.ai/w/1", origin: "https://app.sidan.ai" };
    vi.stubGlobal("window", { location });
    vi.stubGlobal("document", { cookie: `access_token=${expiredToken}` });
    vi.stubGlobal("navigator", { onLine: true });

    await getValidAccessToken();

    expect(location.href).toContain("/api/auth/refresh-and-return");
  });
});
