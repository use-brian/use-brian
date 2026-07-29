// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache] — the stale-while-revalidate store behind every
 * surface's landing fetch. These pin the four behaviours the surfaces rely on:
 * cached data is available synchronously (that is what makes a revisit paint on
 * the first frame), concurrent loads dedupe to one request, a failed
 * revalidation does NOT blank a value already on screen, and invalidation is
 * prefix-scoped so one mutation can drop a family of keys.
 *
 * If these break, surfaces silently regress to a skeleton on every visit, or
 * (worse) keep painting data a mutation already invalidated.
 *
 * jsdom because the store is deliberately browser-only: on the server a
 * module-level cache would be shared across requests and could leak one user's
 * data into another's render.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import {
  invalidateSurfaceCache,
  isSurfaceCacheStale,
  loadSurfaceCache,
  mutateSurfaceCache,
  readSurfaceCache,
  resetSurfaceCache,
  useCachedResource,
  warmSurfaceCache,
} from "@/lib/surface-cache";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** Drain the microtask + macrotask queue so an in-flight load has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("[COMP:app-web/surface-cache] Surface cache", () => {
  beforeEach(() => {
    resetSurfaceCache();
  });

  it("returns the empty entry for an unknown key", () => {
    const entry = readSurfaceCache<string[]>("tasks:none");
    expect(entry.data).toBeUndefined();
    expect(entry.error).toBeUndefined();
    expect(entry.revalidating).toBe(false);
  });

  it("makes a loaded value readable synchronously", async () => {
    await loadSurfaceCache("tasks:w1", async () => ["a", "b"]);
    // Synchronous read is the whole point: a remount paints from this without
    // waiting a tick, which is what removes the skeleton on a revisit.
    expect(readSurfaceCache<string[]>("tasks:w1").data).toEqual(["a", "b"]);
    expect(readSurfaceCache("tasks:w1").revalidating).toBe(false);
  });

  it("dedupes concurrent loads of the same key into one request", async () => {
    const fetcher = vi.fn(async () => "value");
    await Promise.all([
      loadSurfaceCache("k", fetcher),
      loadSurfaceCache("k", fetcher),
      loadSurfaceCache("k", fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good value when a revalidation fails", async () => {
    await loadSurfaceCache("k", async () => "good");
    await loadSurfaceCache("k", async () => {
      throw new Error("network down");
    });
    const entry = readSurfaceCache<string>("k");
    // The surface must keep rendering what the user was reading.
    expect(entry.data).toBe("good");
    expect(entry.error).toBeInstanceOf(Error);
    expect(entry.revalidating).toBe(false);
  });

  it("reports a first-load failure with no data", async () => {
    await loadSurfaceCache("k", async () => {
      throw new Error("nope");
    });
    const entry = readSurfaceCache("k");
    expect(entry.data).toBeUndefined();
    expect(entry.error).toBeInstanceOf(Error);
  });

  it("treats a missing value as stale and a fresh value as not", async () => {
    expect(isSurfaceCacheStale("k")).toBe(true);
    await loadSurfaceCache("k", async () => 1);
    expect(isSurfaceCacheStale("k")).toBe(false);
    // Past its window it is stale again — the hook still paints it, but
    // revalidates behind the paint.
    expect(isSurfaceCacheStale("k", -1)).toBe(true);
  });

  it("skips a warm while the value is fresh, and runs it once stale", async () => {
    const fetcher = vi.fn(async () => "v");
    warmSurfaceCache("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Let the load settle so the in-flight guard clears; a warm is skipped
    // while a request is already running, which is what makes repeated hovers
    // during the flight free.
    await settle();

    // Hovering the same link again inside the freshness window is also free.
    warmSurfaceCache("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // A zero-length freshness window makes everything stale — it runs again.
    warmSurfaceCache("k", fetcher, -1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("skips a warm that is already in flight", async () => {
    const fetcher = vi.fn(async () => "v");
    warmSurfaceCache("k", fetcher, -1);
    warmSurfaceCache("k", fetcher, -1);
    warmSurfaceCache("k", fetcher, -1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await settle();
  });

  it("applies an optimistic patch to a cached value", async () => {
    await loadSurfaceCache<string[]>("k", async () => ["a", "b"]);
    mutateSurfaceCache<string[]>("k", (previous) =>
      previous.filter((v) => v !== "a"),
    );
    expect(readSurfaceCache<string[]>("k").data).toEqual(["b"]);
  });

  it("ignores an optimistic patch when nothing is cached", () => {
    mutateSurfaceCache<string[]>("cold", () => ["invented"]);
    // Fabricating a list the server never sent would be worse than no-op.
    expect(readSurfaceCache("cold").data).toBeUndefined();
  });

  it("invalidates by exact key and by prefix", async () => {
    await loadSurfaceCache("tasks:w1", async () => 1);
    await loadSurfaceCache("tasks:w2", async () => 2);
    await loadSurfaceCache("crm:w1", async () => 3);

    invalidateSurfaceCache("tasks:w1");
    expect(readSurfaceCache("tasks:w1").data).toBeUndefined();
    expect(readSurfaceCache("tasks:w2").data).toBe(2);

    invalidateSurfaceCache("tasks:");
    expect(readSurfaceCache("tasks:w2").data).toBeUndefined();
    // A sibling family is untouched.
    expect(readSurfaceCache("crm:w1").data).toBe(3);
  });

  it("notifies subscribers on load, patch and invalidation", async () => {
    const seen: number[] = [];
    // The hook subscribes through this same path; if it stops firing, mounted
    // surfaces stop reflecting mutations made elsewhere in the app.
    const { subscribeForTest } = await import("@/lib/surface-cache");
    const unsubscribe = subscribeForTest("k", () => seen.push(seen.length));

    await loadSurfaceCache("k", async () => "v");
    mutateSurfaceCache<string>("k", () => "v2");
    invalidateSurfaceCache("k");
    unsubscribe();
    // start-of-load, resolve, patch, invalidate.
    expect(seen.length).toBeGreaterThanOrEqual(3);

    const before = seen.length;
    await loadSurfaceCache("k", async () => "v3");
    expect(seen.length).toBe(before);
  });
});

/**
 * The hook half. `useCachedResource` is what surfaces actually call, and its
 * load effect carries the subtle part: it must refetch when a value is missing
 * or stale, repair itself when another part of the app invalidates the key, and
 * NOT retry a cold-load failure forever (which would hammer a broken endpoint
 * from a mounted surface). These run it in a real React root.
 */
describe("[COMP:app-web/surface-cache] useCachedResource", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetSurfaceCache();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function Probe({ fetcher }: { fetcher: () => Promise<string> }) {
    const resource = useCachedResource("k", fetcher);
    return <span>{resource.data ?? (resource.loading ? "loading" : "empty")}</span>;
  }

  async function render(fetcher: () => Promise<string>) {
    await act(async () => {
      root!.render(<Probe fetcher={fetcher} />);
      await settle();
    });
  }

  it("fetches on mount and renders the value", async () => {
    await render(async () => "hello");
    expect(container!.textContent).toBe("hello");
  });

  it("paints a cached value with no fetch at all", async () => {
    await loadSurfaceCache("k", async () => "warmed");
    const fetcher = vi.fn(async () => "fresh");
    await render(fetcher);
    // This is the revisit case — the whole point of the cache.
    expect(container!.textContent).toBe("warmed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refetches when another part of the app invalidates the key", async () => {
    const fetcher = vi.fn(async () => "v1");
    await render(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValue("v2");
    await act(async () => {
      invalidateSurfaceCache("k");
      await settle();
    });
    // Without the repair path the surface would strand on an empty state.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toBe("v2");
  });

  it("does not retry a cold-load failure in a loop", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("endpoint down");
    });
    await act(async () => {
      root!.render(<Probe fetcher={fetcher as unknown as () => Promise<string>} />);
      await settle();
      await settle();
      await settle();
    });
    // One attempt, then it waits for an explicit refresh() — a mounted surface
    // must not hammer a broken endpoint.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toBe("empty");
  });
});
