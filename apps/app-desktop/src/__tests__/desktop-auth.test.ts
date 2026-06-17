import { describe, it, expect, vi } from "vitest";

import {
  deriveChallenge,
  generatePkcePair,
  buildDesktopAuthStartUrl,
  buildLoopbackRedirectUri,
  buildSignedInPageUrl,
  generateStateNonce,
  parseAuthCallback,
  parseLoopbackCallback,
  exchangeCode,
  refreshSession,
  jwtExpSeconds,
  shouldRefreshSession,
  SESSION_REFRESH_MARGIN_SECONDS,
  buildSessionCookies,
  serializePendingVerifier,
  parsePendingVerifier,
  PENDING_VERIFIER_TTL_MS,
  type DesktopSession,
} from "../desktop-auth.js";

/** A structurally-valid unsigned JWT carrying the given `exp`. */
function jwtWithExp(exp: number): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", exp })}.sig`;
}

describe("[COMP:app-desktop/desktop-auth] PKCE", () => {
  it("derives the S256 challenge matching the RFC 7636 appendix B vector", () => {
    // RFC 7636 §appendix B.
    expect(deriveChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates a verifier whose challenge round-trips", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(deriveChallenge(verifier));
  });
});

describe("[COMP:app-desktop/desktop-auth] pending-verifier persistence", () => {
  it("round-trips a fresh verifier", () => {
    const raw = serializePendingVerifier("verifier-abc_123", 1_000);
    expect(parsePendingVerifier(raw, 1_000)).toEqual({
      verifier: "verifier-abc_123",
      addAccount: false,
    });
    expect(parsePendingVerifier(raw, 1_000 + 60_000)).toEqual({
      verifier: "verifier-abc_123",
      addAccount: false,
    });
  });

  it("round-trips the add-account intent across the persisted blob", () => {
    const raw = serializePendingVerifier("verifier-abc_123", 1_000, true);
    expect(parsePendingVerifier(raw, 1_000)).toEqual({
      verifier: "verifier-abc_123",
      addAccount: true,
    });
  });

  it("rejects a stale verifier past the TTL", () => {
    const raw = serializePendingVerifier("v".repeat(43), 0);
    expect(parsePendingVerifier(raw, PENDING_VERIFIER_TTL_MS + 1)).toBeNull();
  });

  it("rejects a backwards clock, bad JSON, and a malformed shape", () => {
    expect(parsePendingVerifier(serializePendingVerifier("v".repeat(43), 10_000), 0)).toBeNull();
    expect(parsePendingVerifier("not json", 0)).toBeNull();
    expect(parsePendingVerifier(JSON.stringify({ verifier: "has space", createdAt: 0 }), 0)).toBeNull();
    expect(parsePendingVerifier(JSON.stringify({ createdAt: 0 }), 0)).toBeNull();
  });
});

describe("[COMP:app-desktop/desktop-auth] buildDesktopAuthStartUrl", () => {
  it("points at the canvas bridge with the encoded challenge", () => {
    expect(buildDesktopAuthStartUrl("https://app.sidan.ai", "abc-123")).toBe(
      "https://app.sidan.ai/desktop/auth?challenge=abc-123",
    );
  });

  it("threads the loopback redirect + state when given", () => {
    const out = new URL(
      buildDesktopAuthStartUrl("https://app.sidan.ai", "abc-123", {
        redirectUri: "http://127.0.0.1:54321/cb",
        state: "nonce-xyz",
      }),
    );
    expect(out.pathname).toBe("/desktop/auth");
    expect(out.searchParams.get("challenge")).toBe("abc-123");
    expect(out.searchParams.get("redirect")).toBe("http://127.0.0.1:54321/cb");
    expect(out.searchParams.get("state")).toBe("nonce-xyz");
  });

  it("sets addAccount=1 for an add-account sign-in, and omits it otherwise", () => {
    const add = new URL(
      buildDesktopAuthStartUrl("https://app.sidan.ai", "abc-123", { addAccount: true }),
    );
    expect(add.searchParams.get("addAccount")).toBe("1");
    const plain = new URL(buildDesktopAuthStartUrl("https://app.sidan.ai", "abc-123"));
    expect(plain.searchParams.has("addAccount")).toBe(false);
  });
});

describe("[COMP:app-desktop/desktop-auth] loopback redirect", () => {
  it("builds the 127.0.0.1 redirect URI for a port", () => {
    expect(buildLoopbackRedirectUri(54321)).toBe("http://127.0.0.1:54321/cb");
  });

  it("generates a base64url state nonce", () => {
    expect(generateStateNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateStateNonce()).not.toBe(generateStateNonce());
  });

  it("extracts a code from a /cb request when the state matches", () => {
    expect(parseLoopbackCallback("/cb?code=xyz&state=abc", "abc")).toEqual({
      kind: "code",
      code: "xyz",
    });
  });

  it("extracts an error from a /cb request", () => {
    expect(parseLoopbackCallback("/cb?error=mint_failed&state=abc", "abc")).toEqual({
      kind: "error",
      error: "mint_failed",
    });
  });

  it("reports no_code for /cb with neither code nor error", () => {
    expect(parseLoopbackCallback("/cb?state=abc", "abc")).toEqual({
      kind: "error",
      error: "no_code",
    });
  });

  it("rejects a mismatched or missing state (CSRF guard) by returning null", () => {
    expect(parseLoopbackCallback("/cb?code=xyz&state=wrong", "abc")).toBeNull();
    expect(parseLoopbackCallback("/cb?code=xyz", "abc")).toBeNull();
  });

  it("ignores non-/cb paths (e.g. favicon) so the server stays open", () => {
    expect(parseLoopbackCallback("/favicon.ico", "abc")).toBeNull();
    expect(parseLoopbackCallback("/", "abc")).toBeNull();
  });

  it("skips the state check when none was issued (scheme-fallback shape)", () => {
    expect(parseLoopbackCallback("/cb?code=xyz", null)).toEqual({ kind: "code", code: "xyz" });
  });
});

describe("[COMP:app-desktop/desktop-auth] buildSignedInPageUrl", () => {
  it("points at the canvas /desktop/signed-in page on success", () => {
    expect(buildSignedInPageUrl("https://app.sidan.ai")).toBe(
      "https://app.sidan.ai/desktop/signed-in",
    );
  });

  it("adds the error status when sign-in did not complete", () => {
    expect(buildSignedInPageUrl("http://localhost:3003", { error: true })).toBe(
      "http://localhost:3003/desktop/signed-in?status=error",
    );
  });
});

describe("[COMP:app-desktop/desktop-auth] parseAuthCallback", () => {
  it("extracts a code", () => {
    expect(parseAuthCallback("sidanclaw://auth?code=xyz", "sidanclaw")).toEqual({
      kind: "code",
      code: "xyz",
    });
  });

  it("extracts an error", () => {
    expect(parseAuthCallback("sidanclaw://auth?error=mint_failed", "sidanclaw")).toEqual({
      kind: "error",
      error: "mint_failed",
    });
  });

  it("reports no_code when neither is present", () => {
    expect(parseAuthCallback("sidanclaw://auth", "sidanclaw")).toEqual({
      kind: "error",
      error: "no_code",
    });
  });

  it("returns null for non-auth links and other schemes (so deep-link routing wins)", () => {
    expect(parseAuthCallback("sidanclaw://open?path=/w/x", "sidanclaw")).toBeNull();
    expect(parseAuthCallback("sidanclaw://capture", "sidanclaw")).toBeNull();
    expect(parseAuthCallback("https://app.sidan.ai/x", "sidanclaw")).toBeNull();
    expect(parseAuthCallback("not a url", "sidanclaw")).toBeNull();
  });
});

describe("[COMP:app-desktop/desktop-auth] exchangeCode", () => {
  const session: DesktopSession = {
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 2592000,
    user: { id: "u1", name: "A", email: "a@b.com", plan: "pro" },
  };

  it("POSTs code + verifier to the exchange endpoint and returns the session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => session,
    });
    const result = await exchangeCode("https://api.sidan.ai", "code1", "verifier1", fetchImpl);
    expect(result).toEqual(session);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.sidan.ai/auth/desktop/exchange");
    expect(JSON.parse(init.body)).toEqual({ code: "code1", verifier: "verifier1" });
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    await expect(exchangeCode("https://api.sidan.ai", "c", "v", fetchImpl)).rejects.toThrow(/400/);
  });
});

describe("[COMP:app-desktop/desktop-auth] session keep-alive decision", () => {
  it("decodes a JWT exp and returns 0 for garbage", () => {
    expect(jwtExpSeconds(jwtWithExp(12345))).toBe(12345);
    expect(jwtExpSeconds("not.a.jwt")).toBe(0);
    expect(jwtExpSeconds("")).toBe(0);
  });

  it("refreshes when the token is missing or unparseable", () => {
    expect(shouldRefreshSession(null, 1000)).toBe(true);
    expect(shouldRefreshSession("garbage", 1000)).toBe(true);
  });

  it("refreshes inside the margin, not outside it", () => {
    const now = 10_000;
    expect(shouldRefreshSession(jwtWithExp(now + SESSION_REFRESH_MARGIN_SECONDS + 1), now)).toBe(false);
    expect(shouldRefreshSession(jwtWithExp(now + SESSION_REFRESH_MARGIN_SECONDS), now)).toBe(true);
    expect(shouldRefreshSession(jwtWithExp(now - 1), now)).toBe(true); // already expired
  });
});

describe("[COMP:app-desktop/desktop-auth] refreshSession", () => {
  const session: DesktopSession = {
    accessToken: "at2",
    refreshToken: "rt2",
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 2592000,
  };

  it("POSTs the refresh token and returns the rotated session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => session });
    const result = await refreshSession("https://api.sidan.ai", "rt1", fetchImpl);
    expect(result).toEqual(session);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.sidan.ai/auth/refresh");
    expect(JSON.parse(init.body)).toEqual({ refreshToken: "rt1" });
  });

  it("returns null on a definitive rejection (dead refresh token)", async () => {
    for (const status of [400, 401]) {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) });
      expect(await refreshSession("https://api.sidan.ai", "rt1", fetchImpl)).toBeNull();
    }
  });

  it("throws on a transient failure (5xx / network) so callers retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(refreshSession("https://api.sidan.ai", "rt1", fetchImpl)).rejects.toThrow(/503/);
    const fetchDown = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(refreshSession("https://api.sidan.ai", "rt1", fetchDown)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("[COMP:app-desktop/desktop-auth] buildSessionCookies", () => {
  const session: DesktopSession = {
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 2592000,
    user: { id: "u1", name: "A", email: "a@b.com", plan: "pro" },
  };

  it("mirrors the web's three cookies with the right flags + expiries", () => {
    const cookies = buildSessionCookies("https://app.sidan.ai", session, 1000);
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));

    expect(byName.access_token).toMatchObject({
      value: "at",
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      expirationDate: 1000 + 3600,
    });
    expect(byName.refresh_token).toMatchObject({
      value: "rt",
      httpOnly: true,
      expirationDate: 1000 + 2592000,
    });
    expect(JSON.parse(byName.user.value)).toMatchObject({
      id: "u1",
      email: "a@b.com",
      plan: "pro",
      effectivePlan: "pro",
    });
    expect(byName.user.httpOnly).toBe(false);
  });

  it("marks cookies insecure for an http (dev) canvas URL", () => {
    const cookies = buildSessionCookies("http://localhost:3003", session, 0);
    expect(cookies.every((c) => c.secure === false)).toBe(true);
  });
});
