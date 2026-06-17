/**
 * Unit tests for the data-block offline policy (pure).
 * [COMP:app-web/offline-data-block-policy]
 */

import { describe, expect, it } from "vitest";
import {
  resolveDataBlockRender,
  shouldCachePayload,
  DEFAULT_MAX_STALE_MS,
} from "../data-block-policy";

const NOW = 1_700_000_000_000;

describe("[COMP:app-web/offline-data-block-policy] resolveDataBlockRender", () => {
  it("is always 'live' when online, even with a cache (honors 'live, not snapshot')", () => {
    expect(resolveDataBlockRender({ isOnline: true, cache: null, nowMs: NOW })).toEqual({
      mode: "live",
    });
    expect(
      resolveDataBlockRender({ isOnline: true, cache: { cachedAt: NOW }, nowMs: NOW }),
    ).toEqual({ mode: "live" });
  });

  it("is 'unavailable/no-cache' when offline with nothing cached", () => {
    expect(resolveDataBlockRender({ isOnline: false, cache: null, nowMs: NOW })).toEqual({
      mode: "unavailable",
      reason: "no-cache",
    });
  });

  it("serves a 'stale' snapshot offline within the staleness ceiling", () => {
    const cachedAt = NOW - 60 * 60 * 1000; // 1h old
    expect(
      resolveDataBlockRender({ isOnline: false, cache: { cachedAt }, nowMs: NOW }),
    ).toEqual({ mode: "stale", ageMs: 60 * 60 * 1000 });
  });

  it("is 'unavailable/expired' offline once the cache is older than the ceiling", () => {
    const cachedAt = NOW - DEFAULT_MAX_STALE_MS - 1;
    expect(
      resolveDataBlockRender({ isOnline: false, cache: { cachedAt }, nowMs: NOW }),
    ).toEqual({ mode: "unavailable", reason: "expired" });
  });

  it("treats exactly-at-the-ceiling as still stale (boundary)", () => {
    const cachedAt = NOW - DEFAULT_MAX_STALE_MS;
    expect(
      resolveDataBlockRender({ isOnline: false, cache: { cachedAt }, nowMs: NOW }),
    ).toEqual({ mode: "stale", ageMs: DEFAULT_MAX_STALE_MS });
  });

  it("honors a custom maxStaleMs", () => {
    const cachedAt = NOW - 5000;
    expect(
      resolveDataBlockRender({ isOnline: false, cache: { cachedAt }, nowMs: NOW, maxStaleMs: 1000 }),
    ).toEqual({ mode: "unavailable", reason: "expired" });
    expect(
      resolveDataBlockRender({ isOnline: false, cache: { cachedAt }, nowMs: NOW, maxStaleMs: 10000 }),
    ).toEqual({ mode: "stale", ageMs: 5000 });
  });

  it("clamps clock skew (cache timestamped in the future) to a fresh stale render", () => {
    expect(
      resolveDataBlockRender({ isOnline: false, cache: { cachedAt: NOW + 10_000 }, nowMs: NOW }),
    ).toEqual({ mode: "stale", ageMs: 0 });
  });
});

describe("[COMP:app-web/offline-data-block-policy] shouldCachePayload", () => {
  it("caches only a successful resolve", () => {
    expect(shouldCachePayload(true)).toBe(true);
    expect(shouldCachePayload(false)).toBe(false);
  });
});
