// @vitest-environment jsdom
/**
 * [COMP:app-web/offline-pages] Viewer-scoped sidebar IndexedDB keys.
 *
 * The `sidebar:*` disk copies of the page tree used to be keyed by workspace
 * only, so on a shared device a second account in the same workspace could
 * paint the first account's page rows - rows its own clearance may not
 * permit. Every key now carries the signed-in viewer id (the same source
 * `offline-pages.ts` already scopes its outbox by), and with no viewer the
 * disk tier is skipped entirely. This pins the contract the sidebar's
 * paint-first seed (`doc-sidebar-data.tsx`) relies on: a cached tree is
 * NEVER returned for a viewer other than the one who wrote it.
 *
 * jsdom for `navigator.onLine`, which `listViews` reads to decide whether to
 * serve the disk copy without a network round trip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ id: null as string | null, apiOrigin: "http://api.example" }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: user.apiOrigin }) }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => store.get(key) ?? null,
  idbSet: async (key: string, value: unknown) => {
    store.set(key, value);
  },
  idbDelete: async (key: string) => {
    store.delete(key);
  },
  idbUpdate: async () => {
    throw new Error("not used here");
  },
  clearLocalDocCaches: async () => {
    store.clear();
  },
}));

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/desktop-auth-source", () => ({
  desktopBridge: () => null,
  isDesktopAuth: () => false,
}));

import { listViews, type ViewListRow } from "@/lib/api/views";
import { readCachedSidebarTree, sidebarCacheKey } from "@/lib/offline/offline-pages";

function row(id: string, name: string): ViewListRow {
  return {
    id,
    name,
    workspaceId: "w1",
    state: "saved",
    nestParentId: null,
    teamspaceId: null,
    position: 0,
  } as unknown as ViewListRow;
}

function okResponse(savedViews: ViewListRow[]) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ savedViews }),
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

describe("[COMP:app-web/offline-pages] sidebar cache keys carry the viewer", () => {
  beforeEach(() => {
    store.clear();
    user.id = null;
    user.apiOrigin = "http://api.example";
    window.history.replaceState({}, "", "/w/w1/p/page");
    authFetchMock.mockReset();
    setOnline(true);
  });

  it("partitions every sidebar family by deployment, viewer, workspace and native app", () => {
    user.id = "u1";
    const first = sidebarCacheKey("saved", "w1");
    expect(first).toContain(encodeURIComponent(user.apiOrigin));
    expect(first).toContain("u1:w1:native");
    expect(sidebarCacheKey("drafts", "w1")).not.toBe(first);
    expect(sidebarCacheKey("teamspaces", "w1")).not.toBe(first);
    user.id = "u2";
    expect(sidebarCacheKey("saved", "w1")).not.toBe(first);
    user.id = "u1"; user.apiOrigin = "http://other.example";
    expect(sidebarCacheKey("saved", "w1")).not.toBe(first);
    user.id = null;
    expect(sidebarCacheKey("saved", "w1")).toBeNull();
  });

  it("never returns one viewer's cached tree to another viewer", async () => {
    // u1 loads online: the rows land on disk under u1's key.
    user.id = "u1";
    authFetchMock.mockResolvedValue(okResponse([row("p1", "Only u1 may see this")]));
    const online = await listViews({ workspaceId: "w1", state: "saved" });
    expect(online.map((r) => r.name)).toEqual(["Only u1 may see this"]);
    expect(store.has(sidebarCacheKey("saved", "w1")!)).toBe(true);
    expect(store.has("sidebar:saved:w1")).toBe(false);

    // u2 opens the same workspace on the same device, offline: the disk tier
    // must not hand over u1's rows.
    user.id = "u2";
    setOnline(false);
    authFetchMock.mockReset();
    const offlineForU2 = await listViews({ workspaceId: "w1", state: "saved" });
    expect(offlineForU2).toEqual([]);
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(await readCachedSidebarTree("w1")).toBeNull();

    // u1, offline, still gets the copy they wrote.
    user.id = "u1";
    const offlineForU1 = await listViews({ workspaceId: "w1", state: "saved" });
    expect(offlineForU1.map((r) => r.name)).toEqual(["Only u1 may see this"]);
    const tree = await readCachedSidebarTree("w1");
    expect(tree?.saved.map((r) => r.name)).toEqual(["Only u1 may see this"]);
  });

  it("skips the disk tier entirely when no viewer is signed in", async () => {
    user.id = null;
    authFetchMock.mockResolvedValue(okResponse([row("p1", "Anon fetch")]));
    const rows = await listViews({ workspaceId: "w1", state: "saved" });
    expect(rows.map((r) => r.name)).toEqual(["Anon fetch"]);
    // Nothing written under any key: a viewer-less key would be shared by
    // every account on the device.
    expect(store.size).toBe(0);
    expect(await readCachedSidebarTree("w1")).toBeNull();
  });

  it("evicts the viewer's disk copy on an authoritative denial", async () => {
    user.id = "u1";
    const key = sidebarCacheKey("saved", "w1")!;
    store.set(key, [row("p1", "Stale")]);
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
      json: async () => ({}),
    });
    await expect(listViews({ workspaceId: "w1", state: "saved" })).rejects.toThrow(/HTTP 403/);
    expect(store.has(key)).toBe(false);
  });
  it("does not adopt a cached sidebar from a different deployment or historical shared key", async () => {
    user.id = "u1";
    authFetchMock.mockResolvedValue(okResponse([row("p1", "Fictional scoped row")]));
    await listViews({ workspaceId: "w1", state: "saved" });
    store.set("sidebar:saved:w1:u1", [row("old", "Historical row")]);
    user.apiOrigin = "http://other.example"; setOnline(false);
    expect(await listViews({ workspaceId: "w1", state: "saved" })).toEqual([]);
    expect(await readCachedSidebarTree("w1")).toBeNull();
  });
});
