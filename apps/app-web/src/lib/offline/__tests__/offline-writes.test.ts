/**
 * Unit tests for the offline write manager — the queue-vs-direct decision now
 * that it runs un-gated on every client (web included). IndexedDB is absent in
 * the node test env, so `idb.ts` degrades to no-op persistence and the queue
 * lives in memory — exactly the private-mode fallback path.
 *
 * [COMP:app-web/offline-writes]
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-fixture" }) }));
vi.mock("../idb", () => ({
  idbGet: async (key: string) => data.get(key) ?? null,
  idbUpdate: async (key: string, fn: (v: unknown) => unknown) => {
    const next = fn(data.get(key) ?? null); data.set(key, next); return next;
  },
}));
vi.mock("../offline-pages", () => ({ readLocalPage: async () => null, readCachedPage: async () => null, patchLocalPage: async () => {} }));
// This suite isolates manager/coalescing behavior. The application authority
// suite exercises the actual live-admission and pinned-session transport.
vi.mock("../application-write-authority", async () => {
  const { renameView } = await import("@/lib/api/views");
  const authority = { viewerId: "viewer-fixture", workspaceId: "workspace-fixture", applicationId: "native", apiOrigin: "https://api.example" };
  return {
    currentOfflineWriteAuthority: () => authority,
    sameOfflineWriteAuthority: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    offlineWriteQueueKey: () => "offline:write-queue:fixture",
    offlineWriteUnavailable: () => new Error("Unavailable"),
    prepareQueuedMetadataWrite: async (op: { payload: { id: string; name: string } }) =>
      () => renameView(op.payload.id, op.payload.name),
  };
});

vi.mock("@/lib/api/views", () => ({
  renameView: vi.fn(async () => ({ renamed: true })),
  setViewIcon: vi.fn(async () => ({})),
  setViewFullWidth: vi.fn(async () => ({})),
  setViewClearance: vi.fn(async () => ({})),
}));

import { renameView } from "@/lib/api/views";
import {
  offlineWrite,
  flushWriteQueue,
  setOnline,
  subscribePendingCount,
} from "../offline-writes";

function pendingCount(): number {
  let count = -1;
  const unsub = subscribePendingCount((c) => {
    count = c;
  });
  unsub();
  return count;
}

describe("[COMP:app-web/offline-writes] offlineWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    data.clear();
    setOnline(true);
  });

  it("online: uses the canonical executor and applies its result", async () => {
    const onResult = vi.fn(); const optimistic = vi.fn();
    await offlineWrite({ kind: "view.rename", coalesceKey: "rename:v1",
      payload: { id: "v1", name: "A" }, onResult, optimistic });
    expect(renameView).toHaveBeenCalledWith("v1", "A");
    expect(onResult).toHaveBeenCalledWith({ renamed: true });
    expect(optimistic).not.toHaveBeenCalled(); expect(pendingCount()).toBe(0);
  });

  it("online: propagates the canonical executor's error and holds the uncertain effect", async () => {
    vi.mocked(renameView).mockRejectedValueOnce(new Error("boom"));
    await expect(offlineWrite({ kind: "view.rename", coalesceKey: null,
      payload: { id: "v1", name: "A" } })).rejects.toThrow("boom");
    await flushWriteQueue();
    expect(renameView).toHaveBeenCalledOnce(); expect(pendingCount()).toBe(1);
  });

  it("offline: queues the write and applies the optimistic update before transport", async () => {
    setOnline(false); const optimistic = vi.fn();
    await offlineWrite({ kind: "view.rename", coalesceKey: "rename:v2",
      payload: { id: "v2", name: "Offline title" }, optimistic });
    expect(renameView).not.toHaveBeenCalled();
    expect(optimistic).toHaveBeenCalledOnce(); expect(pendingCount()).toBe(1);
  });

  it("flushWriteQueue replays the queued op through the canonical SDK executor", async () => {
    setOnline(false);
    await offlineWrite({ kind: "view.rename", coalesceKey: "rename:v2",
      payload: { id: "v2", name: "Offline title" } });
    expect(pendingCount()).toBe(1); setOnline(true); await flushWriteQueue();
    expect(renameView).toHaveBeenCalledWith("v2", "Offline title"); expect(pendingCount()).toBe(0);
  });
});

describe("[COMP:app-web/offline-writes] replay races", () => {
  beforeEach(() => { data.clear(); vi.clearAllMocks(); setOnline(false); });
  it("keeps a newer coalesced edit made while replay is in flight", async () => {
    setOnline(false);
    const write = (name: string) => offlineWrite({ kind: "view.rename", coalesceKey: "rename:race", payload: { id: "race", name } });
    await write("old");
    vi.mocked(renameView).mockImplementationOnce(async () => { await write("new"); return {} as never; });
    await flushWriteQueue();
    expect(pendingCount()).toBe(1);
    await flushWriteQueue();
    expect(renameView).toHaveBeenLastCalledWith("race", "new");
    expect(pendingCount()).toBe(0);
  });
  it("does not drop edits after repeated server failures", async () => {
    setOnline(false);
    await offlineWrite({ kind: "view.rename", coalesceKey: null, payload: { id: "keep", name: "Retain" } });
    vi.mocked(renameView).mockRejectedValue(new Error("offline"));
    for (let n = 0; n < 7; n++) await flushWriteQueue();
    expect(pendingCount()).toBe(1);
  });
});
