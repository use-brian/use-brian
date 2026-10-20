import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  data: new Map<string, unknown>(), userId: "viewer-a", workspaceId: "00000000-0000-4000-8000-000000000001",
  origin: "https://api.example", storageFailure: false,
  afterStorageRead: undefined as (() => void) | undefined,
}));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: fixture.userId }) }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: fixture.origin }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(() => { throw new Error("Unexpected unpinned transport"); }), getValidAccessToken: vi.fn(async () =>
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
import { currentOfflineWriteAuthority, offlineWriteQueueKey, pinOfflineWriteSession, offlinePageDocumentKey } from "../application-write-authority";
import { flushWriteQueue, offlineWrite, readPendingWrites, setOnline } from "../offline-writes";

const pageId = "00000000-0000-4000-8000-000000000002";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function queuedKey() { return offlineWriteQueueKey(currentOfflineWriteAuthority()!); }
async function enqueue(name = "Fictional title") {
  await offlineWrite({ kind: "view.rename", coalesceKey: `rename:${pageId}`,
    payload: { id: pageId, name } });
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
  it("pins page transport headers and refuses foreign endpoints or later identities", async () => {
    const authority = currentOfflineWriteAuthority()!;
    const session = await pinOfflineWriteSession(authority);
    await expect(session.request("https://other.example/api/views")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await session.request(`/api/views/${pageId}`, { headers: { Authorization: "Bearer different" } });
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("Authorization")).toBe(`Bearer ${session.bearer()}`);
    fixture.userId = "viewer-b";
    expect(() => session.bearer()).toThrow();
    await expect(session.request(`/api/views/${pageId}`)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("partitions Yjs storage without adopting the old shared document database", () => {
    const first = offlinePageDocumentKey(pageId);
    expect(first).not.toBe(`doc-page-${pageId}`);
    fixture.userId = "viewer-b";
    expect(offlinePageDocumentKey(pageId)).not.toBe(first);
    fixture.userId = "viewer-a"; fixture.origin = "https://other.example";
    expect(offlinePageDocumentKey(pageId)).not.toBe(first);
    fixture.origin = "https://api.example"; fixture.workspaceId = "another-workspace";
    expect(offlinePageDocumentKey(pageId)).not.toBe(first);
  });

  it("does not dispatch an online edit after identity changes during the outbox read", async () => {
    setOnline(true);
    fixture.afterStorageRead = () => { fixture.userId = "viewer-b"; };
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Fictional title" } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["view.icon", { icon: "📄" }], ["view.fullWidth", { fullWidth: true }],
    ["view.clearance", { clearance: "internal" }],
  ])("replays %s through the canonical metadata writer", async (kind, fields) => {
    await offlineWrite({ kind, coalesceKey: null, payload: { id: pageId, ...fields } });
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


describe("[COMP:app-web/application-authority-cache] pinned online metadata effects", () => {
  it("uses the canonical SDK with a durable uncertainty marker before an online effect", async () => {
    setOnline(true);
    const onResult = vi.fn();
    const optimistic = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const entries = JSON.parse(fixture.data.get(queuedKey()) as string);
        expect(entries).toMatchObject([{ effect: "uncertain", payload: { id: pageId, name: "Online title" } }]);
      }
      return response({ id: pageId, workspaceId: fixture.workspaceId, name: "Online title" });
    }));
    await offlineWrite({ kind: "view.rename", coalesceKey: `rename:${pageId}`,
      payload: { id: pageId, name: "Online title" }, onResult, optimistic });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [read, write] = vi.mocked(fetch).mock.calls;
    expect(read[0]).toContain(`/api/views/${pageId}`);
    expect(write[0]).toContain(`/api/saved-views/${pageId}`);
    expect(write[1]).toMatchObject({ method: "PATCH", redirect: "error", cache: "no-store", credentials: "omit" });
    expect(new Headers(write[1]?.headers).get("Authorization")).toBe(new Headers(read[1]?.headers).get("Authorization"));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ id: pageId, name: "Online title" }));
    expect(optimistic).not.toHaveBeenCalled();
    expect(await readPendingWrites()).toEqual([]);
  });

  it("does not dispatch an online mutation when its durable claim cannot be saved", async () => {
    setOnline(true); fixture.storageFailure = true;
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Retain intent" } })).rejects.toThrow("quota");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).not.toBe("PATCH");
  });

  it("keeps an online lost response uncertain across reload without sending another mutation", async () => {
    setOnline(true);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new TypeError("response lost after possible commit");
      return response({ id: pageId, workspaceId: fixture.workspaceId });
    }));
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Possible commit" } })).rejects.toThrow();
    expect((await readPendingWrites())[0].effect).toBe("uncertain");
    vi.resetModules(); const reloaded = await import("../offline-writes");
    await reloaded.flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await reloaded.readPendingWrites())[0].effect).toBe("uncertain");
  });

  it("does not refresh or reissue an online unauthorized mutation", async () => {
    setOnline(true);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
      ? response({}, 401) : response({ id: pageId, workspaceId: fixture.workspaceId })));
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Original actor" } })).rejects.toThrow();
    await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getValidAccessToken).toHaveBeenCalledOnce();
    expect((await readPendingWrites())[0].effect).toBe("uncertain");
  });

  it("keeps the original account's uncertainty when identity changes after a possible online effect", async () => {
    setOnline(true); const key = queuedKey(); const onResult = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") fixture.userId = "viewer-b";
      return response({ id: pageId, workspaceId: fixture.workspaceId });
    }));
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Original account" }, onResult })).rejects.toThrow();
    expect(onResult).not.toHaveBeenCalled();
    expect(await readPendingWrites()).toEqual([]);
    expect(JSON.parse(fixture.data.get(key) as string)).toMatchObject([{ authority: { viewerId: "viewer-a" }, effect: "uncertain" }]);
    fixture.userId = "viewer-a"; await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("holds an online transport success whose acknowledgement names a different page", async () => {
    setOnline(true);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => response({
      id: init?.method === "PATCH" ? "00000000-0000-4000-8000-000000000009" : pageId,
      workspaceId: fixture.workspaceId,
    })));
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: pageId, name: "Wrong acknowledgement" } })).rejects.toThrow();
    await flushWriteQueue();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await readPendingWrites())[0].effect).toBe("uncertain");
  });

  it("preserves a second tab's newer edit while the first online mutation is in flight", async () => {
    setOnline(true);
    let release!: () => void; let signal!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signal = resolve; });
    let patches = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && ++patches === 1) { signal(); await blocked; }
      return response({ id: pageId, workspaceId: fixture.workspaceId });
    }));
    const first = offlineWrite({ kind: "view.rename", coalesceKey: `rename:${pageId}`,
      payload: { id: pageId, name: "First title" } });
    await started;
    vi.resetModules(); const secondTab = await import("../offline-writes"); secondTab.setOnline(true);
    const optimistic = vi.fn();
    await secondTab.offlineWrite({ kind: "view.rename", coalesceKey: `rename:${pageId}`,
      payload: { id: pageId, name: "Second title" }, optimistic });
    expect(patches).toBe(1); expect(optimistic).toHaveBeenCalledOnce();
    expect(await secondTab.readPendingWrites()).toMatchObject([
      { payload: { name: "First title" }, effect: "uncertain" },
      { payload: { name: "Second title" }, effect: "pending" },
    ]);
    release(); await first;
    expect(await secondTab.readPendingWrites()).toMatchObject([{ payload: { name: "Second title" }, effect: "pending" }]);
    await secondTab.flushWriteQueue();
    expect(patches).toBe(2); expect(await secondTab.readPendingWrites()).toEqual([]);
  });
});
