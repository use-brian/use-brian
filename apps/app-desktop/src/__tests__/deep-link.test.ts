import { describe, it, expect } from "vitest";

import { resolveDeepLink } from "../deep-link.js";

const cfg = { appUrl: "https://app.sidan.ai", protocolScheme: "sidanclaw" };

describe("[COMP:app-desktop/deep-link] resolveDeepLink", () => {
  it("returns null for a non-URL string", () => {
    expect(resolveDeepLink("not a url", cfg)).toBeNull();
  });

  it("returns null for a different scheme", () => {
    expect(resolveDeepLink("https://app.sidan.ai/w/x/p/y", cfg)).toBeNull();
    expect(resolveDeepLink("evil://open?path=/w/x", cfg)).toBeNull();
  });

  it("resolves sidanclaw://capture to the quick-capture URL", () => {
    expect(resolveDeepLink("sidanclaw://capture", cfg)).toBe(
      "https://app.sidan.ai/?capture=1",
    );
  });

  it("resolves sidanclaw://open?path=... to an absolute canvas URL", () => {
    expect(resolveDeepLink("sidanclaw://open?path=/w/abc/p/def", cfg)).toBe(
      "https://app.sidan.ai/w/abc/p/def",
    );
  });

  it("defaults open with no path to the canvas root", () => {
    expect(resolveDeepLink("sidanclaw://open", cfg)).toBe("https://app.sidan.ai/");
  });

  it("refuses an off-origin path (absolute URL or protocol-relative)", () => {
    expect(resolveDeepLink("sidanclaw://open?path=https://evil.com", cfg)).toBeNull();
    expect(resolveDeepLink("sidanclaw://open?path=//evil.com/x", cfg)).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(resolveDeepLink("sidanclaw://wat?path=/x", cfg)).toBeNull();
  });
});
