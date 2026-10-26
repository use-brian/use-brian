// @vitest-environment jsdom

/**
 * [COMP:app-web/surface-content-cache] Content lease for protected lists
 * (perceived-performance.md, "Content lease for protected lists").
 *
 * Pinned: a network value expires 30 seconds after its request started; a
 * visible surface renews it every 15 seconds; a failed renewal and an
 * optimistic edit never extend it; a disk copy outside the one-hour authority
 * window (or future-dated) is never painted; an authoritative denial evicts.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => storage.get(key) ?? null,
  idbSet: async (key: string, value: unknown) => { storage.set(key, value); },
  idbDelete: async (key: string) => { storage.delete(key); },
}));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-a", name: "n", email: "e" }) }));

import { SurfaceCacheEvictionError, loadSurfaceCache, mutateSurfaceCache, readSurfaceCache, resetSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import {
  OFFLINE_AUTHORITY_MS,
  isSurfaceContentExpiry,
  SURFACE_CONTENT_LEASE_MS,
  leaseSurfaceContent,
  readSurfaceContentCache,
  surfaceContentRemaining,
  useSurfaceContentCache,
  useSurfaceContentRenewal,
  useLeasedResource,
  writeSurfaceContentCache,
} from "@/lib/offline/surface-content-cache";

const KEY = "tasks:workspace-1:viewer-a";
const scope = { viewerId: "viewer-a", workspaceId: "workspace-1" };
const isRows = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let seen: string[][] | undefined[] = [];

function Harness({ fetch }: { fetch: () => Promise<string[]> }) {
  const fetcher = useSurfaceContentCache({ key: KEY, workspaceId: "workspace-1", resource: "tasks", isValue: isRows, fetch });
  const resource = useCachedResource(KEY, fetcher, { expiresInMs: surfaceContentRemaining });
  useSurfaceContentRenewal(resource.refresh);
  (seen as unknown[]).push(resource.data);
  return null;
}

async function mount(fetch: () => Promise<string[]>) {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => { root!.render(<Harness fetch={fetch} />); });
  await flush();
}

const latest = () => readSurfaceCache<string[]>(KEY).data;

describe("[COMP:app-web/surface-content-cache] Content lease for protected lists", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    storage.clear();
    resetSurfaceCache();
    seen = [];
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    vi.useRealTimers();
  });

  it("leases a fetched value for 30 seconds from its request start", async () => {
    const value = await leaseSurfaceContent(async () => ["Fictional row"]);
    expect(surfaceContentRemaining(value)).toBe(SURFACE_CONTENT_LEASE_MS);
    vi.advanceTimersByTime(SURFACE_CONTENT_LEASE_MS);
    expect(surfaceContentRemaining(value)).toBe(0);
    expect(surfaceContentRemaining(["unleased"])).toBe(0);
  });

  it("renews an open list every 15 seconds while visible", async () => {
    let calls = 0;
    await mount(async () => { calls += 1; return [`Fictional row ${calls}`]; });
    expect(latest()).toEqual(["Fictional row 1"]);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(latest()).toEqual(["Fictional row 2"]);
    await act(async () => { vi.advanceTimersByTime(29_000); });
    await flush();
    expect(latest()).toBeDefined();
  });

  it('renews from a slow initial response before the existing rows expire', async () => {
    let calls = 0;
    const fetch = vi.fn(() => new Promise<string[]>(resolve => setTimeout(() => resolve(['Fictional row']), ++calls === 1 ? 16_000 : 8_000)));
    function List() {
      const resource = useLeasedResource(KEY, fetch);
      return <div>{resource.data?.join() ?? 'cold skeleton'}</div>;
    }
    container = document.createElement('div');root = createRoot(container);
    await act(async () => root!.render(<List/>));
    await act(async () => vi.advanceTimersByTime(16_000));await flush();
    expect(container.textContent).toBe('Fictional row');
    for (let second = 0; second < 45; second++) {
      await act(async () => vi.advanceTimersByTime(1000));await flush();
      expect(container.textContent).toBe('Fictional row');
    }
  });

  it('hides expired rows without cancelling a renewal with its own valid deadline', async () => {
    let finish!: (rows:string[])=>void;
    const fetch=vi.fn().mockResolvedValueOnce(['Fictional row']).mockImplementation(()=>new Promise<string[]>(resolve=>{finish=resolve;}));
    function List(){const resource=useLeasedResource<string[]>(KEY,fetch);return <div>{resource.data?.join() ?? 'cold skeleton'}</div>;}
    container=document.createElement('div');root=createRoot(container);
    await act(async()=>root!.render(<List/>));await flush();
    await act(async()=>vi.advanceTimersByTime(15_000));await flush();
    await act(async()=>vi.advanceTimersByTime(15_001));await flush();
    expect(container.textContent).toBe('cold skeleton');
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async()=>finish(['Renewed row']));await flush();
    expect(container.textContent).toBe('Renewed row');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('starts the new key renewal schedule while the old key read is unresolved',async()=>{
    const oldRead=()=>new Promise<string[]>(()=>{});
    const nextRead=vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(['New scope row']);
    function List({cacheKey}:{cacheKey:string}){
      const resource=useLeasedResource<string[]>(cacheKey,cacheKey==='old'?oldRead:nextRead);
      return <div>{resource.data?.join() ?? 'cold skeleton'}</div>;
    }
    container=document.createElement('div');root=createRoot(container);
    await act(async()=>root!.render(<List cacheKey="old"/>));await flush();
    await act(async()=>vi.advanceTimersByTime(15_000));await flush();
    await act(async()=>root!.render(<List cacheKey="next"/>));await flush();
    await act(async()=>vi.advanceTimersByTime(15_000));await flush();
    expect(container.textContent).toBe('New scope row');expect(nextRead).toHaveBeenCalledTimes(2);
  });

  it('preserves the 15-second start cadence for manually leased editor readers',async()=>{
    const refresh=vi.fn(()=>new Promise<void>(resolve=>setTimeout(resolve,8000)));
    function Manual(){useSurfaceContentRenewal(refresh);return null;}
    container=document.createElement('div');root=createRoot(container);
    await act(async()=>root!.render(<Manual/>));
    await act(async()=>vi.advanceTimersByTime(15_000));await flush();expect(refresh).toHaveBeenCalledTimes(1);
    await act(async()=>vi.advanceTimersByTime(8000));await flush();
    await act(async()=>vi.advanceTimersByTime(7000));await flush();expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not postpone a renewal when optimistic edits replace the leased value',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(['Fictional row']).mockImplementation(()=>new Promise<string[]>(resolve=>setTimeout(()=>resolve(['Renewed row']),8000)));
    function List(){const resource=useLeasedResource<string[]>(KEY,fetch);return <div>{resource.data?.join() ?? 'cold skeleton'}</div>;}
    container=document.createElement('div');root=createRoot(container);
    await act(async()=>root!.render(<List/>));await flush();
    await act(async()=>vi.advanceTimersByTime(10_000));
    await act(async()=>mutateSurfaceCache<string[]>(KEY,rows=>[...rows,'Local edit']));await flush();
    await act(async()=>vi.advanceTimersByTime(5000));await flush();expect(fetch).toHaveBeenCalledTimes(2);
    for(let second=0;second<18;second++){
      await act(async()=>vi.advanceTimersByTime(1000));await flush();expect(container.textContent).not.toBe('cold skeleton');
    }
  });

  it("evicts an open list when renewal fails, and an optimistic edit does not extend it", async () => {
    let fail = false;
    await mount(async () => { if (fail) throw new Error("network down"); return ["Fictional protected row"]; });
    fail = true;
    act(() => mutateSurfaceCache<string[]>(KEY, (rows) => [...rows, "Fictional local edit"]));
    await act(async () => { vi.advanceTimersByTime(29_000); });
    await flush();
    expect(latest()).toEqual(["Fictional protected row", "Fictional local edit"]);
    await act(async () => { vi.advanceTimersByTime(1_500); });
    await flush();
    expect(latest()).toBeUndefined();
  });

  it("evicts both tiers on an authoritative denial", async () => {
    let denied = false;
    await mount(async () => {
      if (denied) throw Object.assign(new Error("HTTP 403"), { status: 403 });
      return ["Fictional protected row"];
    });
    denied = true;
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(latest()).toBeUndefined();
    expect(await readSurfaceContentCache(scope, "tasks", KEY, isRows)).toBeNull();
  });

  it("paints a disk copy only inside the authority window", async () => {
    await writeSurfaceContentCache(scope, "tasks", KEY, ["Fictional saved row"]);
    expect((await readSurfaceContentCache(scope, "tasks", KEY, isRows))?.value).toEqual(["Fictional saved row"]);
    vi.setSystemTime(Date.now() + OFFLINE_AUTHORITY_MS + 1);
    expect(await readSurfaceContentCache(scope, "tasks", KEY, isRows)).toBeNull();
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    storage.clear();
    vi.setSystemTime(Date.now() + 120_000);
    await writeSurfaceContentCache(scope, "tasks", KEY, ["Fictional future row"]);
    vi.setSystemTime(Date.now() - 120_000);
    expect(await readSurfaceContentCache(scope, "tasks", KEY, isRows)).toBeNull();
  });
  it("classifies a read slower than the lease as expiry, not as a failed read", async () => {
    const slow = loadSurfaceCache(KEY, () =>
      leaseSurfaceContent(() => new Promise<string[]>((resolve) => {
        setTimeout(() => resolve(["Fictional late row"]), SURFACE_CONTENT_LEASE_MS + 1);
      })),
      { expiresInMs: surfaceContentRemaining },
    );
    await act(async () => { vi.advanceTimersByTime(SURFACE_CONTENT_LEASE_MS + 1); });
    await slow;
    const entry = readSurfaceCache<string[]>(KEY);
    expect(entry.data).toBeUndefined();
    expect(isSurfaceContentExpiry(entry.error)).toBe(true);
    expect(isSurfaceContentExpiry(new SurfaceCacheEvictionError(new Error("surface_content_expired")))).toBe(true);
    expect(isSurfaceContentExpiry(new Error("Request failed: 500"))).toBe(false);
    expect(isSurfaceContentExpiry(new SurfaceCacheEvictionError(new Error("forbidden")))).toBe(false);
  });
});
