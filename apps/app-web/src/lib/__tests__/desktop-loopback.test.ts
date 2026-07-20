import { describe, it, expect } from "vitest";

import { loopbackRedirectBase } from "../desktop-loopback";

describe("[COMP:app-web/desktop-loopback] loopbackRedirectBase", () => {
  it("accepts loopback http URLs with a port and /cb path", () => {
    expect(loopbackRedirectBase("http://127.0.0.1:54321/cb")).toBe("http://127.0.0.1:54321/cb");
    expect(loopbackRedirectBase("http://localhost:8080/cb")).toBe("http://localhost:8080/cb");
  });

  it("strips any query the caller passed (we append our own)", () => {
    expect(loopbackRedirectBase("http://127.0.0.1:5000/cb?x=1")).toBe("http://127.0.0.1:5000/cb");
  });

  it("rejects non-loopback hosts — the open-redirect guard", () => {
    expect(loopbackRedirectBase("https://evil.example/cb")).toBeNull();
    expect(loopbackRedirectBase("http://evil.example:80/cb")).toBeNull();
    expect(loopbackRedirectBase("http://169.254.169.254:80/cb")).toBeNull();
    expect(loopbackRedirectBase("http://app.usebrian.ai/cb")).toBeNull();
  });

  it("rejects https, a missing port, and a wrong path", () => {
    expect(loopbackRedirectBase("https://127.0.0.1:54321/cb")).toBeNull();
    expect(loopbackRedirectBase("http://127.0.0.1/cb")).toBeNull();
    expect(loopbackRedirectBase("http://127.0.0.1:54321/")).toBeNull();
    expect(loopbackRedirectBase("http://127.0.0.1:54321/evil")).toBeNull();
  });

  it("rejects a custom scheme, junk, and empty input", () => {
    expect(loopbackRedirectBase("usebrian://auth/cb")).toBeNull();
    expect(loopbackRedirectBase("file:///cb")).toBeNull();
    expect(loopbackRedirectBase("not a url")).toBeNull();
    expect(loopbackRedirectBase(null)).toBeNull();
    expect(loopbackRedirectBase(undefined)).toBeNull();
    expect(loopbackRedirectBase("")).toBeNull();
  });
});
