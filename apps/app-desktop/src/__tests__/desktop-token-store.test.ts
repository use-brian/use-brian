import { describe, it, expect } from "vitest";

import type { DesktopSession } from "../desktop-auth.js";
import {
  serializeTokens,
  parseStoredTokens,
  encryptTokens,
  encryptBlob,
  decryptTokens,
  decodeAccessTokenExpiryMs,
  serializeRendererTokens,
  isAccessTokenExpiring,
  type TokenCipher,
} from "../desktop-token-store.js";

/** Build an unsigned (for tests) JWT with the given payload. */
function makeJwt(payload: object): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "HS256", typ: "JWT" })}.${seg(payload)}.sig`;
}

const NOW = 1_700_000_000_000;

function session(overrides: Partial<DesktopSession> = {}): DesktopSession {
  return {
    accessToken: "access-abc",
    refreshToken: "refresh-xyz",
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 60 * 60 * 24 * 30,
    user: { id: "u1", name: "Ada", email: "ada@example.com", plan: "pro" },
    ...overrides,
  };
}

/**
 * A reversible fake cipher — keeps persistence logic pure in tests. The "cipher"
 * is just a Buffer↔utf8 round-trip; the point under test is the store's
 * serialize/validate + availability/throw handling, not the crypto itself.
 */
function fakeCipher(available = true): TokenCipher {
  return {
    isAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain, "utf8"),
    decryptString: (buf) => buf.toString("utf8"),
  };
}

/** A cipher whose authenticated decrypt rejects a tampered/foreign blob. */
function tamperingCipher(): TokenCipher {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, "utf8"),
    decryptString: () => {
      throw new Error("authentication failed");
    },
  };
}

describe("[COMP:app-desktop/token-store] serialize + parse", () => {
  it("round-trips a session, computing the access-token expiry from the clock", () => {
    const raw = serializeTokens(session(), NOW);
    const parsed = parseStoredTokens(raw);
    expect(parsed).toEqual({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      accessTokenExpiresAt: NOW + 3600 * 1000,
      user: { id: "u1", name: "Ada", email: "ada@example.com", plan: "pro" },
    });
  });

  it("keeps a session with no user (user is optional)", () => {
    const raw = serializeTokens(session({ user: undefined }), NOW);
    const parsed = parseStoredTokens(raw);
    expect(parsed?.user).toBeUndefined();
    expect(parsed?.accessToken).toBe("access-abc");
  });

  it("rejects malformed JSON", () => {
    expect(parseStoredTokens("{not json")).toBeNull();
  });

  it("rejects a record missing or blanking the tokens", () => {
    expect(parseStoredTokens(JSON.stringify({ refreshToken: "r", accessTokenExpiresAt: NOW }))).toBeNull();
    expect(
      parseStoredTokens(JSON.stringify({ accessToken: "", refreshToken: "r", accessTokenExpiresAt: NOW })),
    ).toBeNull();
    expect(
      parseStoredTokens(JSON.stringify({ accessToken: "a", refreshToken: "", accessTokenExpiresAt: NOW })),
    ).toBeNull();
  });

  it("rejects a non-numeric expiry", () => {
    expect(
      parseStoredTokens(JSON.stringify({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: "soon" })),
    ).toBeNull();
  });

  it("drops a malformed user but keeps the tokens", () => {
    const parsed = parseStoredTokens(
      JSON.stringify({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: NOW, user: { id: 7 } }),
    );
    expect(parsed?.user).toBeUndefined();
    expect(parsed?.accessToken).toBe("a");
  });
});

describe("[COMP:app-desktop/token-store] encrypt + decrypt", () => {
  it("round-trips through an available cipher", () => {
    const cipher = fakeCipher();
    const blob = encryptTokens(cipher, session(), NOW);
    expect(blob).not.toBeNull();
    const parsed = decryptTokens(cipher, blob as Buffer);
    expect(parsed?.accessToken).toBe("access-abc");
    expect(parsed?.refreshToken).toBe("refresh-xyz");
  });

  it("refuses to encrypt when OS encryption is unavailable (no plaintext on disk)", () => {
    expect(encryptTokens(fakeCipher(false), session(), NOW)).toBeNull();
  });

  it("returns null when decrypting with an unavailable cipher", () => {
    const blob = encryptTokens(fakeCipher(), session(), NOW) as Buffer;
    expect(decryptTokens(fakeCipher(false), blob)).toBeNull();
  });

  it("returns null when authenticated decrypt rejects a tampered/foreign blob", () => {
    expect(decryptTokens(tamperingCipher(), Buffer.from("garbage"))).toBeNull();
  });
});

describe("[COMP:app-desktop/token-store] decodeAccessTokenExpiryMs", () => {
  it("reads the JWT exp claim as milliseconds", () => {
    expect(decodeAccessTokenExpiryMs(makeJwt({ exp: 1_700_003_600 }))).toBe(1_700_003_600_000);
  });

  it("returns null for a non-JWT string", () => {
    expect(decodeAccessTokenExpiryMs("not-a-jwt")).toBeNull();
    expect(decodeAccessTokenExpiryMs("a.b")).toBeNull();
  });

  it("returns null when exp is missing or non-numeric", () => {
    expect(decodeAccessTokenExpiryMs(makeJwt({ sub: "u1" }))).toBeNull();
    expect(decodeAccessTokenExpiryMs(makeJwt({ exp: "soon" }))).toBeNull();
  });

  it("returns null when the payload segment is not valid JSON", () => {
    expect(decodeAccessTokenExpiryMs("h.@@@.s")).toBeNull();
  });
});

describe("[COMP:app-desktop/token-store] serializeRendererTokens", () => {
  it("serializes a renderer payload, reading expiry from the access-token JWT", () => {
    const jwt = makeJwt({ exp: 1_700_003_600 });
    const raw = serializeRendererTokens(
      { accessToken: jwt, refreshToken: "r", user: { id: "u1", name: "Ada", email: "a@e.com", plan: "pro" } },
      NOW,
    );
    expect(raw).not.toBeNull();
    expect(parseStoredTokens(raw as string)).toEqual({
      accessToken: jwt,
      refreshToken: "r",
      accessTokenExpiresAt: 1_700_003_600_000,
      user: { id: "u1", name: "Ada", email: "a@e.com", plan: "pro" },
    });
  });

  it("falls back to now (expiring) when the access token is not a decodable JWT", () => {
    const raw = serializeRendererTokens({ accessToken: "opaque", refreshToken: "r" }, NOW);
    expect(parseStoredTokens(raw as string)?.accessTokenExpiresAt).toBe(NOW);
  });

  it("rejects malformed IPC payloads (defense in depth)", () => {
    expect(serializeRendererTokens(null, NOW)).toBeNull();
    expect(serializeRendererTokens("nope", NOW)).toBeNull();
    expect(serializeRendererTokens({ refreshToken: "r" }, NOW)).toBeNull();
    expect(serializeRendererTokens({ accessToken: "a" }, NOW)).toBeNull();
    expect(serializeRendererTokens({ accessToken: "", refreshToken: "r" }, NOW)).toBeNull();
  });

  it("drops a malformed user", () => {
    const raw = serializeRendererTokens(
      { accessToken: "a", refreshToken: "r", user: { id: 7 } },
      NOW,
    );
    expect(parseStoredTokens(raw as string)?.user).toBeUndefined();
  });
});

describe("[COMP:app-desktop/token-store] encryptBlob", () => {
  it("round-trips an arbitrary blob through an available cipher", () => {
    const cipher = fakeCipher();
    const blob = encryptBlob(cipher, "hello");
    expect(blob).not.toBeNull();
    expect(cipher.decryptString(blob as Buffer)).toBe("hello");
  });

  it("returns null when OS encryption is unavailable", () => {
    expect(encryptBlob(fakeCipher(false), "hello")).toBeNull();
  });
});

describe("[COMP:app-desktop/token-store] isAccessTokenExpiring", () => {
  const tokens = { accessToken: "a", refreshToken: "r", accessTokenExpiresAt: NOW + 3600_000 };

  it("is false for a comfortably-fresh token", () => {
    expect(isAccessTokenExpiring(tokens, NOW)).toBe(false);
  });

  it("is true within the skew window", () => {
    expect(isAccessTokenExpiring(tokens, NOW + 3600_000 - 30_000)).toBe(true);
  });

  it("is true once expired", () => {
    expect(isAccessTokenExpiring(tokens, NOW + 3600_000 + 1)).toBe(true);
  });
});
