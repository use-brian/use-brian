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
  SurfaceCacheEvictionError,
  invalidateSurfaceCache,
  isSurfaceCacheStale,
  loadSurfaceCache,
  markSurfaceCacheStale,
  mutateSurfaceCache,
  readSurfaceCache,
  resetSurfaceCache,
  seedSurfaceCache,
  useCachedResource,
  warmSurfaceCache,
} from "@/lib/surface-cache";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('[COMP:app-web/surface-cache] bounded first-paint seeds', () => {
  beforeEach(() => {vi.useFakeTimers();resetSurfaceCache();});
  afterEach(() => {resetSurfaceCache();vi.useRealTimers();});
  it('preserves an in-flight request and replaces the stale seed when it completes', async () => {
    let finish!: (value: string) => void;
    const disposal=vi.fn();
    const request=loadSurfaceCache('seed',()=>new Promise<string>(resolve=>{finish=resolve;}));
    expect(seedSurfaceCache('seed','hint',{expiresInMs:()=>400,dispose:disposal},true)).toBe(true);
    expect(readSurfaceCache('seed')).toMatchObject({data:'hint',revalidating:true});
    expect(isSurfaceCacheStale('seed')).toBe(true);
    expect(loadSurfaceCache('seed',async()=> 'wrong')).toBe(request);
    finish('fresh');await request;
    expect(disposal).toHaveBeenCalledExactlyOnceWith('hint');
    vi.advanceTimersByTime(401);expect(readSurfaceCache('seed').data).toBe('fresh');
  });
  it('expires an unmounted seed and discards the response of its detached request',async()=>{
    let finish!:(value:string)=>void;
    const request=loadSurfaceCache('seed',()=>new Promise<string>(resolve=>{finish=resolve;}));
    const disposal=vi.fn();
    seedSurfaceCache('seed','hint',{expiresInMs:()=>400,dispose:disposal});
    vi.advanceTimersByTime(401);finish('obsolete');await request;
    expect(readSurfaceCache('seed').data).toBeUndefined();expect(disposal).toHaveBeenCalledExactlyOnceWith('hint');
  });
  it('cannot replace a fetched value or denial, and rejects an expired seed',async()=>{
    await loadSurfaceCache('current',async()=>'current');
    await loadSurfaceCache('denied',async()=>{throw new SurfaceCacheEvictionError(new Error('denied'));});
    expect(seedSurfaceCache('current','hint')).toBe(false);
    expect(seedSurfaceCache('denied','hint')).toBe(false);
    expect(seedSurfaceCache('expired','hint',{expiresInMs:()=>0})).toBe(false);
    expect(readSurfaceCache('current').data).toBe('current');
    expect(readSurfaceCache('denied').data).toBeUndefined();
    expect(readSurfaceCache('denied').error).toMatchObject({message:'denied'});
  });
});

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

  it("does not retry a failed revalidation on every render (bounded by staleMs)", async () => {
    await loadSurfaceCache("tasks:w9", async () => ["a"]);
    markSurfaceCacheStale("tasks:w9");
    const fetcher = vi.fn(async () => {
      throw new Error("503");
    });
    let seen: string[] | undefined;
    function Probe() {
      const entry = useCachedResource<string[]>("tasks:w9", fetcher);
      seen = entry.data;
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await settle();
      await settle();
      await settle();
    });
    // One attempt, not a tight loop: the failure stamps `attemptedAt`, the
    // entry reads fresh for another window, and the rows stay painted.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["a"]);
    expect(isSurfaceCacheStale("tasks:w9")).toBe(false);
    // A spine mark reopens the window and one more attempt runs.
    await act(async () => {
      markSurfaceCacheStale("tasks:w9");
      await settle();
      await settle();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      root.unmount();
    });
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

  it.each(["success", "failure", "denial"])(
    "ignores a superseded %s without clearing the replacement request",
    async (outcome) => {
      let resolveOld!: (value: string) => void;
      let rejectOld!: (error: unknown) => void;
      const old = loadSurfaceCache("k", () => new Promise<string>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      }));
      invalidateSurfaceCache("k");
      let resolveNew!: (value: string) => void;
      const current = loadSurfaceCache("k", () => new Promise<string>((resolve) => {
        resolveNew = resolve;
      }));
      if (outcome === "success") resolveOld("obsolete");
      else rejectOld(outcome === "denial"
        ? new SurfaceCacheEvictionError(new Error("Forbidden"))
        : new Error("obsolete"));
      await old;
      expect(readSurfaceCache("k")).toMatchObject({
        data: undefined, error: undefined, revalidating: true,
      });
      const extra = vi.fn(async () => "duplicate");
      expect(loadSurfaceCache("k", extra)).toBe(current);
      expect(extra).not.toHaveBeenCalled();
      resolveNew("current");
      await current;
      expect(readSurfaceCache("k").data).toBe("current");
    },
  );

  it("does not resurrect data after a reset", async () => {
    let resolve!: (value: string) => void;
    const pending = loadSurfaceCache("k", () => new Promise<string>((done) => { resolve = done; }));
    resetSurfaceCache();
    resolve("signed-out");
    await pending;
    expect(readSurfaceCache("k").data).toBeUndefined();
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

  it("marks stale by exact key and by prefix WITHOUT dropping the data", async () => {
    // The spine's signal (instant-navigation contract N3): "something changed
    // somewhere" must keep the open list painting and revalidate behind it,
    // which is the opposite of `invalidateSurfaceCache`.
    await loadSurfaceCache("tasks:w1:u1", async () => ["a"]);
    await loadSurfaceCache("crm:w1:u1:config", async () => "cfg");
    await loadSurfaceCache("crm:w1:u1:lookups", async () => "lk");
    await loadSurfaceCache("crm:w2:u1:config", async () => "other");

    markSurfaceCacheStale("tasks:w1");
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(true);
    expect(readSurfaceCache<string[]>("tasks:w1:u1").data).toEqual(["a"]);

    markSurfaceCacheStale("crm:w1:");
    expect(isSurfaceCacheStale("crm:w1:u1:config")).toBe(true);
    expect(isSurfaceCacheStale("crm:w1:u1:lookups")).toBe(true);
    expect(readSurfaceCache("crm:w1:u1:config").data).toBe("cfg");
    // A sibling workspace is untouched.
    expect(isSurfaceCacheStale("crm:w2:u1:config")).toBe(false);
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

  it("revalidates behind the paint when the key is marked stale, keeping the old value up", async () => {
    // The spine path: a mounted surface must refetch after `markSurfaceCacheStale`
    // (the hook's load effect re-runs on the emitted snapshot and sees "data
    // present + stale") WITHOUT ever showing its cold branch.
    const fetcher = vi.fn(async () => "v1");
    await render(fetcher);
    expect(container!.textContent).toBe("v1");

    let release: (value: string) => void = () => {};
    fetcher.mockImplementation(() => new Promise<string>((resolve) => {
      release = resolve;
    }));
    await act(async () => {
      markSurfaceCacheStale("k");
      await settle();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Still painting the last good value while the revalidation is in flight.
    expect(container!.textContent).toBe("v1");
    await act(async () => {
      release("v2");
      await settle();
    });
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


describe('[COMP:app-web/surface-cache] disposable protected resources',()=>{
  beforeEach(()=>{resetSurfaceCache();vi.useFakeTimers();});
  afterEach(()=>{resetSurfaceCache();vi.useRealTimers();});
  it('expires and disposes unmounted entries without a subscriber',async()=>{
    const dispose=vi.fn();await loadSurfaceCache('media',async()=>'blob:first',{dispose,expiresInMs:()=>500});
    expect(readSurfaceCache('media').data).toBe('blob:first');
    await vi.advanceTimersByTimeAsync(501);
    expect(readSurfaceCache('media').data).toBeUndefined();expect(dispose).toHaveBeenCalledExactlyOnceWith('blob:first');
  });
  it('disposes replacement, denial and reset resources exactly once',async()=>{
    const dispose=vi.fn(),options={dispose,expiresInMs:()=>1000};
    await loadSurfaceCache('media',async()=>'first',options);
    await loadSurfaceCache('media',async()=>'second',options);
    expect(dispose.mock.calls).toEqual([['first']]);
    await loadSurfaceCache('media',async()=>{throw new SurfaceCacheEvictionError(new Error('403'));},options);
    expect(dispose.mock.calls).toEqual([['first'],['second']]);
    await loadSurfaceCache('media',async()=>'third',options);resetSurfaceCache();
    await vi.advanceTimersByTimeAsync(1001);
    expect(dispose.mock.calls).toEqual([['first'],['second'],['third']]);
  });
  it.each(['invalidate','reset'])('disposes late responses detached by %s without replacing a newer read',async action=>{
    const dispose=vi.fn();let resolve!:(value:string)=>void;
    const pending=loadSurfaceCache('media',()=>new Promise<string>(r=>{resolve=r;}),{dispose});
    if(action==='reset')resetSurfaceCache();else invalidateSurfaceCache('media');
    await loadSurfaceCache('media',async()=>'new',{dispose});
    resolve('old');await pending;
    expect(readSurfaceCache('media').data).toBe('new');expect(dispose.mock.calls).toEqual([['old']]);
  });
  it('rejects expired resources without retaining their URL',async()=>{
    const dispose=vi.fn();await loadSurfaceCache('media',async()=>'expired',{dispose,expiresInMs:()=>0});
    expect(readSurfaceCache('media').data).toBeUndefined();expect(dispose).toHaveBeenCalledExactlyOnceWith('expired');
  });
});
