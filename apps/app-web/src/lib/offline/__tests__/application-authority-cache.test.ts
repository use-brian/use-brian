import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  data: new Map<string, unknown>(), userId: "viewer-a", workspaceId: "00000000-0000-4000-8000-000000000001",
  origin: "https://api.example", storageFailure: false,
  afterStorageRead: undefined as (() => void) | undefined,
}));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: fixture.userId }) }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: fixture.origin }) }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: vi.fn(async () =>
  `header.${btoa(JSON.stringify({ sub: fixture.userId }))}.signature`) }));
vi.mock("../offline-pages", () => ({ readLocalPage: async () => null, readCachedPage: async () => null,
  patchLocalPage: async () => {} }));
vi.mock("../idb", () => ({
  idbGet: async (key: string) => {
    const value = structuredClone(fixture.data.get(key) ?? null);
    const afterRead = fixture.afterStorageRead; fixture.afterStorageRead = undefined;
    afterRead?.(); return value;
  },
  idbUpdate: async (key: string, update: (value: unknown) => unknown) => {
    if (fixture.storageFailure) throw new Error("quota");
    const next = update(structuredClone(fixture.data.get(key) ?? null));
    fixture.data.set(key, structuredClone(next)); return next;
  },
}));

import { getValidAccessToken } from "@/lib/auth-fetch";
import { currentOfflineWriteAuthority, offlineWriteQueueKey } from "../application-write-authority";
import { flushWriteQueue, offlineWrite, readPendingWrites, setOnline } from "../offline-writes";

const pageId = "00000000-0000-4000-8000-000000000002";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function queuedKey() { return offlineWriteQueueKey(currentOfflineWriteAuthority()!); }
async function enqueue(name = "Fictional title") {
  await offlineWrite({ kind: "view.rename", coalesceKey: `rename:${pageId}`,
    payload: { id: pageId, name }, exec: async () => {} });
}
function liveServer() {
  return vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
    ? response({ id: pageId, workspaceId: fixture.workspaceId }) : response({ id: pageId, workspaceId: fixture.workspaceId }));
}
beforeEach(() => {
  fixture.data.clear(); fixture.userId = "viewer-a"; fixture.workspaceId = "00000000-0000-4000-8000-000000000001";
  fixture.origin = "https://api.example"; fixture.storageFailure = false;
  fixture.afterStorageRead = undefined;
  vi.stubGlobal("window", { location: { get pathname() { return `/w/${fixture.workspaceId}/p/${pageId}`; } } });
  vi.mocked(getValidAccessToken).mockReset().mockImplementation(async () =>
    `header.${btoa(JSON.stringify({ sub: fixture.userId }))}.signature`);
  vi.stubGlobal("fetch", liveServer()); setOnline(false);
});

describe("[COMP:app-web/application-authority-cache] actual native outbox replay", () => {
  it("does not dispatch an online edit after identity changes during the outbox read", async () => {
    setOnline(true);
    fixture.afterStorageRead = () => { fixture.userId = "viewer-b"; };
    const exec = vi.fn(async () => {});
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Fictional title" }, exec })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ["view.icon", { icon: "📄" }], ["view.fullWidth", { fullWidth: true }],
    ["view.clearance", { clearance: "internal" }],
  ])("replays %s through the canonical metadata writer", async (kind, fields) => {
    await offlineWrite({ kind, coalesceKey: null, payload: { id: pageId, ...fields }, exec: async () => {} });
    await flushWriteQueue();
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(JSON.stringify(fields));
    expect(await readPendingWrites()).toEqual([]);
  });

  it("reauthorizes each pending write through live server reads and uses one pinned bearer", async () => {
    await enqueue();
    await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [read, write] = vi.mocked(fetch).mock.calls;
    expect(read[0]).toContain(`/api/views/${pageId}`);
    expect(read[1]).toMatchObject({ cache: "no-store", credentials: "omit" });
    expect(write[0]).toContain(`/api/saved-views/${pageId}`);
    expect(write[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ name: "Fictional title" }), credentials: "omit" });
    expect(new Headers(write[1]?.headers).get("Authorization")).toBe(new Headers(read[1]?.headers).get("Authorization"));
    expect(await readPendingWrites()).toEqual([]);
  });

  it.each(["account", "workspace", "deployment"] as const)("does not replay across a changed %s", async (axis) => {
    await enqueue(); const key = queuedKey();
    if (axis === "account") fixture.userId = "viewer-b";
    if (axis === "workspace") fixture.workspaceId = "00000000-0000-4000-8000-000000000003";
    if (axis === "deployment") fixture.origin = "https://other.example";
    await flushWriteQueue();
    expect(fetch).not.toHaveBeenCalled(); expect(await readPendingWrites()).toEqual([]);
    expect(JSON.parse(fixture.data.get(key) as string)).toHaveLength(1);
  });

  it("does not turn an app marker or historical shared queue into authority", async () => {
    await enqueue(); const key = queuedKey();
    const entries = JSON.parse(fixture.data.get(key) as string);
    entries[0].authority.applicationId = "other-app";
    fixture.data.set(key, JSON.stringify(entries));
    fixture.data.set("offline:write-queue", JSON.stringify(entries));
    await flushWriteQueue(); expect(fetch).not.toHaveBeenCalled();
    fixture.data.delete(key);
    await flushWriteQueue(); expect(fetch).not.toHaveBeenCalled();
    expect(fixture.data.has("offline:write-queue")).toBe(true);
  });

  it("retains a pending intent when current page access is withdrawn and retries only its read", async () => {
    await enqueue();
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 403)));
    await flushWriteQueue();
    expect((await readPendingWrites())[0].effect).toBe("pending");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
    vi.stubGlobal("fetch", liveServer()); await flushWriteQueue();
    expect(await readPendingWrites()).toEqual([]);
  });

  it("rejects a refreshed bearer belonging to another account before any request", async () => {
    await enqueue();
    vi.mocked(getValidAccessToken).mockResolvedValue(`header.${btoa(JSON.stringify({ sub: "viewer-b" }))}.signature`);
    await flushWriteQueue(); expect(fetch).not.toHaveBeenCalled();
    expect((await readPendingWrites())[0].effect).toBe("pending");
  });

  it("does not accept a page from another workspace even under the same account", async () => {
    await enqueue();
    vi.stubGlobal("fetch", vi.fn(async () => response({ id: pageId, workspaceId: "other-workspace" })));
    await flushWriteQueue(); expect(fetch).toHaveBeenCalledTimes(1);
    expect((await readPendingWrites())[0].effect).toBe("pending");
  });

  it("does not refresh and replay a rejected mutation into a new session", async () => {
    await enqueue();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
      ? response({}, 401) : response({ id: pageId, workspaceId: fixture.workspaceId })));
    await flushWriteQueue(); await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getValidAccessToken).toHaveBeenCalledOnce();
    expect((await readPendingWrites())[0].effect).toBe("uncertain");
  });

  it("does not clear uncertainty for a transport success without a canonical result", async () => {
    await enqueue();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
      ? new Response("incomplete reply", { status: 200 }) : response({ id: pageId, workspaceId: fixture.workspaceId })));
    await flushWriteQueue(); await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await readPendingWrites())[0].effect).toBe("uncertain");
  });

  it("checks identity again after asynchronous admission", async () => {
    await enqueue(); const key = queuedKey();
    vi.stubGlobal("fetch", vi.fn(async () => {
      fixture.userId = "viewer-b";
      return response({ id: pageId, workspaceId: fixture.workspaceId });
    }));
    await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fixture.data.get(key) as string)[0].effect).toBe("pending");
  });

  it("never uploads before its uncertainty marker commits to storage", async () => {
    await enqueue(); fixture.storageFailure = true;
    await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(1);
    fixture.storageFailure = false;
    expect((await readPendingWrites())[0].effect).toBe("pending");
  });

  it("keeps a lost-response effect uncertain across reload and never blindly retries it", async () => {
    await enqueue();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new TypeError("response lost after possible commit");
      return response({ id: pageId, workspaceId: fixture.workspaceId });
    }));
    await flushWriteQueue(); expect((await readPendingWrites())[0].effect).toBe("uncertain");
    vi.resetModules();
    const reloaded = await import("../offline-writes");
    await reloaded.flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await reloaded.readPendingWrites())[0].effect).toBe("uncertain");
  });

  it("keeps a concurrent new edit distinct from a dispatched prior effect", async () => {
    await enqueue("First title");
    const server = liveServer();
    server.mockImplementationOnce(async () => response({ id: pageId, workspaceId: fixture.workspaceId }))
      .mockImplementationOnce(async () => { await enqueue("New title"); return response({ id: pageId, workspaceId: fixture.workspaceId }); });
    vi.stubGlobal("fetch", server); await flushWriteQueue();
    expect(await readPendingWrites()).toMatchObject([{ payload: { name: "New title" }, effect: "pending" }]);
    await flushWriteQueue(); expect(await readPendingWrites()).toEqual([]);
  });

  it("allows only one tab to claim an exact queued version", async () => {
    await enqueue();
    let release!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signal = resolve; });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PATCH" && ++reads === 1) { signal(); await blocked; }
      return response({ id: pageId, workspaceId: fixture.workspaceId });
    }));
    const first = flushWriteQueue(); await started;
    vi.resetModules(); const secondTab = await import("../offline-writes");
    await secondTab.flushWriteQueue(); release(); await first;
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(await readPendingWrites()).toEqual([]);
  });
});
