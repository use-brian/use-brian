import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  parseAwakeBrianPreference,
  serializeAwakeBrianPreference,
} from "../awake-brian.js";

describe("[COMP:app-desktop/awake-brian] preference", () => {
  it("round-trips enabled and disabled values", () => {
    expect(parseAwakeBrianPreference(serializeAwakeBrianPreference(true))).toBe(true);
    expect(parseAwakeBrianPreference(serializeAwakeBrianPreference(false))).toBe(false);
  });

  it("enables only the current explicit true record", () => {
    expect(parseAwakeBrianPreference('{"v":1,"keepAwake":true}')).toBe(true);
    expect(parseAwakeBrianPreference('{"v":2,"keepAwake":true}')).toBe(false);
    expect(parseAwakeBrianPreference('{"v":1,"keepAwake":"true"}')).toBe(false);
  });

  it("falls back to disabled for missing or malformed data", () => {
    expect(parseAwakeBrianPreference(null)).toBe(false);
    expect(parseAwakeBrianPreference("")).toBe(false);
    expect(parseAwakeBrianPreference("{oops")).toBe(false);
    expect(parseAwakeBrianPreference("[]")).toBe(false);
  });

  it("renders the canonical logo asset instead of reconstructing the mark", () => {
    const html = readFileSync(new URL("../brian-pet.html", import.meta.url), "utf8");
    expect(html).toContain('src="./brian-logo.png"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("brian-blink");
  });
});
