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
    setOnline(true);
  });

  it("online: runs exec directly and applies the result, queueing nothing", async () => {
    const exec = vi.fn(async () => "server-result");
    const onResult = vi.fn();
    const optimistic = vi.fn();
    await offlineWrite({
      kind: "view.rename",
      coalesceKey: "rename:v1",
      payload: { id: "v1", name: "A" },
      exec,
      onResult,
      optimistic,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("server-result");
    expect(optimistic).not.toHaveBeenCalled();
    expect(pendingCount()).toBe(0);
  });

  it("online: propagates exec errors to the caller (no silent queueing)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      offlineWrite({
        kind: "view.rename",
        coalesceKey: null,
        payload: {},
        exec,
      }),
    ).rejects.toThrow("boom");
    expect(pendingCount()).toBe(0);
  });

  it("offline: queues the write, applies the optimistic update, and never calls exec", async () => {
    setOnline(false);
    const exec = vi.fn(async () => "unused");
    const optimistic = vi.fn();
    await offlineWrite({
      kind: "view.rename",
      coalesceKey: "rename:v2",
      payload: { id: "v2", name: "Offline title" },
      exec,
      optimistic,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(optimistic).toHaveBeenCalledTimes(1);
    expect(pendingCount()).toBe(1);
  });

  it("flushWriteQueue replays the queued op through the real SDK executor", async () => {
    // The op queued by the previous test is still pending (module-level queue).
    expect(pendingCount()).toBe(1);
    setOnline(true);
    await flushWriteQueue();
    expect(renameView).toHaveBeenCalledWith("v2", "Offline title");
    expect(pendingCount()).toBe(0);
  });
});

describe("[COMP:app-web/offline-writes] replay races", () => {
  it("keeps a newer coalesced edit made while replay is in flight", async () => {
    setOnline(false);
    const write = (name: string) => offlineWrite({ kind: "view.rename", coalesceKey: "rename:race", payload: { id: "race", name }, exec: async () => {} });
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
    await offlineWrite({ kind: "view.rename", coalesceKey: null, payload: { id: "keep", name: "Retain" }, exec: async () => {} });
    vi.mocked(renameView).mockRejectedValue(new Error("offline"));
    for (let n = 0; n < 7; n++) await flushWriteQueue();
    expect(pendingCount()).toBe(1);
  });
});
