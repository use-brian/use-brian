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
  });

  it("rejects lookalikes, protocol-relative values, and arbitrary portal paths", () => {
    expect(safeReturnUrl("https://app.brian.example.com.evil.test/x", config)).toBeNull();
    expect(safeReturnUrl("//evil.test/x", config)).toBeNull();
    expect(safeReturnUrl("/login", config)).toBeNull();
  });
});
