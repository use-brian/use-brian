import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ossPublicAppOrigin,
  ossSignedOutRedirect,
  sanitizeNext,
} from "@/lib/oss-entry";
import { isOssEdition } from "@/lib/edition";

vi.mock("@/lib/edition", () => ({ isOssEdition: vi.fn() }));

const mockedIsOss = vi.mocked(isOssEdition);

beforeEach(() => mockedIsOss.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("[COMP:app-web/oss-entry] ossPublicAppOrigin", () => {
  it("uses configured APP_URL instead of Cloudflare's loopback request origin", () => {
    vi.stubEnv("APP_URL", "https://hinson.usebrian.ai");

    expect(
      ossPublicAppOrigin("http://localhost:3003/api/auth/local-session"),
    ).toBe("https://hinson.usebrian.ai");
  });

  it("falls back to the incoming origin for zero-config local development", () => {
    vi.stubEnv("APP_URL", "");

    expect(ossPublicAppOrigin("http://localhost:3003/login?next=%2Fw")).toBe(
      "http://localhost:3003",
    );
  });
});

describe("[COMP:app-web/oss-entry] sanitizeNext", () => {
  it("keeps a same-origin absolute path", () => {
    expect(sanitizeNext("/w/abc/p/123")).toBe("/w/abc/p/123");
    expect(sanitizeNext("/teams?x=1")).toBe("/teams?x=1");
  });

  it("collapses a protocol-relative path, which would resolve off-origin", () => {
    expect(sanitizeNext("//evil.com/steal")).toBe("/");
  });

  it("collapses an absolute URL and anything not starting with /", () => {
    expect(sanitizeNext("https://evil.com")).toBe("/");
    expect(sanitizeNext("w/abc")).toBe("/");
  });

  it("collapses empty and missing input", () => {
    expect(sanitizeNext("")).toBe("/");
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
  });
});

describe("[COMP:app-web/local-session-route] ossSignedOutRedirect", () => {
  /**
   * The reported bug: a self-hosted (oss) visitor with no cookie was sent to
   * /login, which in this edition is a Google button with no client ID behind
   * it. There is no login in single-player — the root IS the owner session.
   */
  it("sends a signed-out oss visitor to the local-owner session", () => {
    mockedIsOss.mockReturnValue(true);
    expect(ossSignedOutRedirect()).toBe("/api/auth/local-session");
  });

  it("carries a deep link through as an encoded ?next=", () => {
    mockedIsOss.mockReturnValue(true);
    expect(ossSignedOutRedirect("/w/abc/p/123")).toBe(
      "/api/auth/local-session?next=%2Fw%2Fabc%2Fp%2F123",
    );
  });

  it("omits ?next= when the target is already the app root", () => {
    mockedIsOss.mockReturnValue(true);
    expect(ossSignedOutRedirect("/")).toBe("/api/auth/local-session");
  });

  it("never propagates an off-origin next into the redirect", () => {
    mockedIsOss.mockReturnValue(true);
    expect(ossSignedOutRedirect("//evil.com")).toBe("/api/auth/local-session");
    expect(ossSignedOutRedirect("https://evil.com")).toBe(
      "/api/auth/local-session",
    );
  });

  // The hosted edition must be untouched: callers fall back to their own
  // /login behaviour on null.
  it("returns null in the hosted edition so /login still owns sign-in", () => {
    mockedIsOss.mockReturnValue(false);
    expect(ossSignedOutRedirect()).toBeNull();
    expect(ossSignedOutRedirect("/w/abc")).toBeNull();
  });
});
