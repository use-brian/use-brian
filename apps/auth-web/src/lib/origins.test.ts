import { describe, expect, it } from "vitest";
import { safeReturnUrl } from "./origins";

const config = {
  internalApiUrl: "http://127.0.0.1:4000",
  portalOrigin: "https://auth.brian.example.com",
  appOrigin: "https://app.brian.example.com",
  cookieDomain: ".brian.example.com",
  trustProxyHeaders: false,
  emailEnabled: true,
  oidcEnabled: false,
};

describe("[COMP:app/outpost-auth] return origin policy", () => {
  it("allows the exact app origin and invite resume", () => {
    expect(safeReturnUrl("https://app.brian.example.com/w/one", config)?.pathname).toBe("/w/one");
    expect(safeReturnUrl("/invite?token=abc", config)?.searchParams.get("token")).toBe("abc");
    expect(safeReturnUrl("/invite?token=abc#accept", config)?.toString()).toBe("https://auth.brian.example.com/invite?token=abc#accept");
    expect(safeReturnUrl("https://auth.brian.example.com/login?error=retry", config)?.toString()).toBe("https://auth.brian.example.com/login?error=retry");
  });

  it("rejects lookalikes, protocol-relative values, and arbitrary portal paths", () => {
    expect(safeReturnUrl("https://app.brian.example.com.evil.test/x", config)).toBeNull();
    expect(safeReturnUrl("//evil.test/x", config)).toBeNull();
    expect(safeReturnUrl("/login", config)).toBeNull();
  });

  it.each([
    "/\\outside.example/invite",
    "/\\outside.example\\invite",
    "/\t/outside.example/invite",
    "/\n/outside.example/invite",
    "/\r/outside.example/invite",
  ])("rejects a relative invite that normalizes to another origin: %j", (raw) => {
    expect(safeReturnUrl(raw, config)).toBeNull();
  });

  it.each(["/\\[::1/invite", "/\\%/invite", "http://[::1"])("returns no destination for malformed URL input: %j", (raw) => {
    expect(safeReturnUrl(raw, config)).toBeNull();
  });
});
