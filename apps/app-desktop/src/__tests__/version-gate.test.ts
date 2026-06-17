import { describe, it, expect } from "vitest";

import { parseVersion, compareVersions, evaluateVersionGate } from "../version-gate.js";

describe("[COMP:app-desktop/version-gate] parseVersion", () => {
  it("parses full, partial, prefixed, and pre-release versions", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2")).toEqual([1, 2, 0]);
    expect(parseVersion("1")).toEqual([1, 0, 0]);
    expect(parseVersion("v2.4.6")).toEqual([2, 4, 6]);
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+build.5")).toEqual([1, 2, 3]);
    expect(parseVersion("  1.0.0  ")).toEqual([1, 0, 0]);
  });

  it("returns null for unparseable input", () => {
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("beta")).toBeNull();
  });
});

describe("[COMP:app-desktop/version-gate] compareVersions", () => {
  it("orders by major, minor, then patch", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1); // numeric, not lexical
  });

  it("returns null when either side is unparseable", () => {
    expect(compareVersions("garbage", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "")).toBeNull();
  });
});

describe("[COMP:app-desktop/version-gate] evaluateVersionGate", () => {
  it("allows when the client meets or exceeds the minimum", () => {
    expect(evaluateVersionGate("1.0.0", "1.0.0")).toEqual({ allowed: true });
    expect(evaluateVersionGate("1.2.0", "1.1.0")).toEqual({ allowed: true });
  });

  it("blocks (force update) when the client is strictly below the minimum", () => {
    expect(evaluateVersionGate("1.0.0", "1.1.0")).toEqual({
      allowed: false,
      reason: "below-minimum",
      clientVersion: "1.0.0",
      minVersion: "1.1.0",
    });
  });

  it("fails open when no minimum is advertised", () => {
    expect(evaluateVersionGate("1.0.0", null)).toEqual({ allowed: true });
    expect(evaluateVersionGate("1.0.0", undefined)).toEqual({ allowed: true });
    expect(evaluateVersionGate("1.0.0", "")).toEqual({ allowed: true });
  });

  it("fails open when either version is unparseable (never brick the app)", () => {
    expect(evaluateVersionGate("1.0.0", "garbage")).toEqual({ allowed: true });
    expect(evaluateVersionGate("garbage", "1.0.0")).toEqual({ allowed: true });
  });
});
