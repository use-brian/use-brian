/**
 * Pure-logic tests for the human auto-title trigger's gate
 * (`shouldRequestAutoTitle`). The hook's effect/observer wiring is thin glue
 * over this predicate; app-web vitest has no DOM, so we test the contract.
 *
 * [COMP:app-web/use-auto-title]
 */

import { describe, expect, it } from "vitest";
import { AUTO_TITLE_MIN_CHARS, shouldRequestAutoTitle } from "../use-auto-title";

const armed = {
  nameOrigin: "placeholder",
  synced: true,
  plaintextLength: AUTO_TITLE_MIN_CHARS,
  inFlight: false,
};

describe("[COMP:app-web/use-auto-title] shouldRequestAutoTitle", () => {
  it("fires when synced, placeholder, idle, and over the threshold", () => {
    expect(shouldRequestAutoTitle(armed)).toBe(true);
  });

  it("does not fire below the size threshold", () => {
    expect(
      shouldRequestAutoTitle({ ...armed, plaintextLength: AUTO_TITLE_MIN_CHARS - 1 }),
    ).toBe(false);
  });

  it("does not fire once the title is auto- or user-set (only placeholder is armed)", () => {
    expect(shouldRequestAutoTitle({ ...armed, nameOrigin: "auto" })).toBe(false);
    expect(shouldRequestAutoTitle({ ...armed, nameOrigin: "user" })).toBe(false);
  });

  it("does not fire before the initial sync lands", () => {
    expect(shouldRequestAutoTitle({ ...armed, synced: false })).toBe(false);
  });

  it("does not fire while a request is already in flight", () => {
    expect(shouldRequestAutoTitle({ ...armed, inFlight: true })).toBe(false);
  });

  it("uses a sensible default threshold", () => {
    expect(AUTO_TITLE_MIN_CHARS).toBe(500);
  });
});
