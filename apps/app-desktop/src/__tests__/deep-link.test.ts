import { describe, it, expect } from "vitest";

import {
  MAX_SIRI_PROMPT_LENGTH,
  parseUseBrianDeepLink,
  resolveDeepLink,
} from "../deep-link.js";

const cfg = { appUrl: "https://app.usebrian.ai", protocolScheme: "usebrian" };

describe("[COMP:app-desktop/deep-link] resolveDeepLink", () => {
  it("returns null for a non-URL string", () => {
    expect(resolveDeepLink("not a url", cfg)).toBeNull();
  });

  it("returns null for a different scheme", () => {
    expect(resolveDeepLink("https://app.usebrian.ai/w/x/p/y", cfg)).toBeNull();
    expect(resolveDeepLink("evil://open?path=/w/x", cfg)).toBeNull();
  });

  it("resolves usebrian://record to the record URL", () => {
    expect(resolveDeepLink("usebrian://record", cfg)).toBe(
      "https://app.usebrian.ai/?record=1",
    );
  });

  it("resolves usebrian://capture to the quick-capture URL", () => {
    expect(resolveDeepLink("usebrian://capture", cfg)).toBe(
      "https://app.usebrian.ai/?capture=1",
    );
  });

  it("resolves usebrian://open?path=... to an absolute canvas URL", () => {
    expect(resolveDeepLink("usebrian://open?path=/w/abc/p/def", cfg)).toBe(
      "https://app.usebrian.ai/w/abc/p/def",
    );
  });

  it("defaults open with no path to the canvas root", () => {
    expect(resolveDeepLink("usebrian://open", cfg)).toBe("https://app.usebrian.ai/");
  });

  it("refuses an off-origin path (absolute URL or protocol-relative)", () => {
    expect(resolveDeepLink("usebrian://open?path=https://evil.com", cfg)).toBeNull();
    expect(resolveDeepLink("usebrian://open?path=//evil.com/x", cfg)).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(resolveDeepLink("usebrian://wat?path=/x", cfg)).toBeNull();
  });
});

describe("[COMP:app-desktop/deep-link] parseUseBrianDeepLink", () => {
  it("extracts, decodes, and trims a Siri prompt", () => {
    expect(
      parseUseBrianDeepLink(
        "usebrian://use?prompt=%20Summarize%20my%20tasks%20",
        "usebrian",
      ),
    ).toBe("Summarize my tasks");
  });

  it("rejects missing, empty, oversized, and unrelated requests", () => {
    expect(parseUseBrianDeepLink("usebrian://use", "usebrian")).toBeNull();
    expect(
      parseUseBrianDeepLink("usebrian://use?prompt=%20", "usebrian"),
    ).toBeNull();
    expect(
      parseUseBrianDeepLink(
        `usebrian://use?prompt=${"x".repeat(MAX_SIRI_PROMPT_LENGTH + 1)}`,
        "usebrian",
      ),
    ).toBeNull();
    expect(
      parseUseBrianDeepLink("usebrian://open?prompt=hello", "usebrian"),
    ).toBeNull();
    expect(
      parseUseBrianDeepLink("evil://use?prompt=hello", "usebrian"),
    ).toBeNull();
    expect(parseUseBrianDeepLink("not a url", "usebrian")).toBeNull();
  });
});
