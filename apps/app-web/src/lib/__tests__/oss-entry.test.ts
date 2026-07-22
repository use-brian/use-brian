import { describe, it, expect, vi, beforeEach } from "vitest";
import { ossSignedOutRedirect, sanitizeNext } from "@/lib/oss-entry";
import { isOssEdition } from "@/lib/edition";

vi.mock("@/lib/edition", () => ({ isOssEdition: vi.fn() }));

const mockedIsOss = vi.mocked(isOssEdition);

beforeEach(() => mockedIsOss.mockReset());

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

describe("[COMP:app-web/oss-entry] ossSignedOutRedirect", () => {
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
