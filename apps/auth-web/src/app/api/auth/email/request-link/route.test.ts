import { describe, expect, it } from "vitest";
import { trustedClientIp } from "./route";

describe("[COMP:app/outpost-auth] client IP forwarding", () => {
  it("prefers proxy-authenticated headers and otherwise takes the nearest forwarded hop", () => {
    const request = new Request("https://auth.example", { headers: { "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.2, 10.0.0.3" } });
    expect(trustedClientIp(request, false)).toBeNull();
    expect(trustedClientIp(request, true)).toBe("203.0.113.5");
    expect(trustedClientIp(new Request("https://auth.example", { headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.3" } }), true)).toBe("10.0.0.3");
  });
});
