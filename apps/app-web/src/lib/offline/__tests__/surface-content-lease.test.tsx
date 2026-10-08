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

import { mutateSurfaceCache, readSurfaceCache, resetSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import {
  OFFLINE_AUTHORITY_MS,
  SURFACE_CONTENT_LEASE_MS,
  leaseSurfaceContent,
  readSurfaceContentCache,
  surfaceContentRemaining,
  useSurfaceContentCache,
  useSurfaceContentRenewal,
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
});
