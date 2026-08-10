// @vitest-environment jsdom
/**
 * [COMP:app-web/shopify-app] — the local run history.
 *
 * This is a convenience list in `localStorage`, so the assertions that matter
 * are the ones about not breaking anything else: a corrupt or foreign value
 * must degrade to "no history" rather than throw inside the sidebar, and a
 * failed write must not surface over the answer the owner is reading.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RUNS,
  clearRuns,
  readRuns,
  recordRun,
  runHref,
  type ShopifyRun,
} from "../shopify-history";

const WS = "ws-1";
const run = (over: Partial<ShopifyRun> = {}): ShopifyRun => ({
  key: "dropout",
  title: "Where am I losing shoppers?",
  since: "2026-08-01",
  until: "2026-08-10",
  at: 1_000,
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("[COMP:app-web/shopify-app] run history", () => {
  it("records newest first", () => {
    recordRun(WS, run({ key: "a", at: 1 }));
    recordRun(WS, run({ key: "b", at: 2 }));
    expect(readRuns(WS).map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("replaces a repeat of the same question over the same window", () => {
    // Without this the list fills with one repeated row and pushes real
    // history off the end.
    recordRun(WS, run({ at: 1 }));
    recordRun(WS, run({ at: 2 }));
    const rows = readRuns(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe(2);
  });

  it("keeps the same question over a DIFFERENT window as its own entry", () => {
    recordRun(WS, run({ since: "2026-07-01" }));
    recordRun(WS, run({ since: "2026-08-01" }));
    expect(readRuns(WS)).toHaveLength(2);
  });

  it("caps the list so the panel never becomes the page", () => {
    for (let i = 0; i < MAX_RUNS + 5; i += 1) recordRun(WS, run({ key: `k${i}`, at: i }));
    expect(readRuns(WS)).toHaveLength(MAX_RUNS);
  });

  it("keeps workspaces apart", () => {
    recordRun(WS, run({ key: "mine" }));
    expect(readRuns("ws-2")).toEqual([]);
  });

  it("returns nothing for a blank workspace id rather than reading a stray key", () => {
    expect(readRuns("")).toEqual([]);
  });

  it("degrades to empty on a corrupt value instead of throwing", () => {
    window.localStorage.setItem(`shopify:runs:${WS}`, "{not json");
    expect(readRuns(WS)).toEqual([]);
  });

  it("drops entries that do not fit the shape, keeping the ones that do", () => {
    // Written by an older build, or hand-edited. Half a list is still useful.
    window.localStorage.setItem(
      `shopify:runs:${WS}`,
      JSON.stringify([{ nope: true }, run({ key: "good" }), null, "x"]),
    );
    expect(readRuns(WS).map((r) => r.key)).toEqual(["good"]);
  });

  it("survives storage being unavailable", () => {
    // Private mode. A missing history is not an error, and a failed write must
    // not throw over the answer already on screen.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readRuns(WS)).toEqual([]);
    expect(() => recordRun(WS, run())).not.toThrow();
  });

  it("clears", () => {
    recordRun(WS, run());
    clearRuns(WS);
    expect(readRuns(WS)).toEqual([]);
  });

  it("builds an href that reopens the same question and window", () => {
    const href = runHref(WS, run());
    expect(href).toContain("section=analyse");
    expect(href).toContain("an=dropout");
    expect(href).toContain("since=2026-08-01");
    expect(href).toContain("until=2026-08-10");
  });
});
