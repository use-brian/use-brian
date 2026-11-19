// @vitest-environment jsdom
/** [COMP:app-web/chat-sessions-cache] Retained authority expiry and invalidation races. */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  scope: { apiOrigin: "https://fixture.example", viewerId: "viewer", workspaceId: "workspace", applicationId: "native" },
  values: new Map<string, unknown>(), failCapture: false, pause: false, release: null as null | (() => void),
}));
vi.mock("../application-write-authority", () => ({
  currentOfflineWriteAuthority: () => state.scope,
  offlineWriteIdentityIsCurrent: (scope: typeof state.scope) =>
    scope.viewerId === state.scope.viewerId && scope.apiOrigin === state.scope.apiOrigin,
  sameOfflineWriteAuthority: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}));
vi.mock("../idb", () => ({
  idbReadEntries: async (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, state.values.get(key) ?? null])),
  idbUpdateEntries: async (keys: readonly string[], update: (values: Record<string, unknown>) => Record<string, unknown>) => {
    if (state.failCapture) { state.failCapture = false; throw new Error("Storage unavailable"); }
    const values = Object.fromEntries(keys.map(key => [key, state.values.get(key) ?? null]));
    for (const [key, value] of Object.entries(update(values))) { if (value === undefined) state.values.delete(key); else state.values.set(key, value); values[key] = value ?? null; }
    return values;
  },
  idbGet: async (key: string) => state.values.get(key) ?? null,
  idbDelete: async (key: string) => { state.values.delete(key); },
  idbUpdate: async (key: string, update: (old: unknown) => unknown) => {
    if (state.pause) { state.pause = false; await new Promise<void>(resolve => { state.release = resolve; }); }
    const next = update(state.values.get(key) ?? null); state.values.set(key, next); return next;
  },
}));
vi.mock("@/lib/chat-surface-data", () => ({ reconcileChatSessionLists: async () => {} }));
import { idbReadEntries, idbUpdateEntries } from "../idb";
import { createChatCachePersistence } from "../chat-cache-fence";
import { resetSurfaceCache } from "@/lib/surface-cache";
import { CHAT_OFFLINE_AUTHORITY_MS, chatHistoryDiskKey, chatHistoryMemoryKey, chatHistoryScope, prepareChatHistoryRead, isChatHistoryReadCurrent, chatFenceKey, chatSessionsDiskKey, refreshChatCacheFence, evictChatHistory, readChatHistory, writeChatHistory } from "../chat-history-cache";
const rows = [{ id: "message", role: "assistant" as const, content: "Delivered reply", timestamp: "2026-11-17T00:00:00Z", senderUserId: null, senderName: null, senderAvatarUrl: null, replyToText: null }];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
  state.scope = { apiOrigin: "https://fixture.example", viewerId: "viewer", workspaceId: "workspace", applicationId: "native" };
  state.values.clear(); state.failCapture = false; state.pause = false; state.release = null; resetSurfaceCache();
  window.dispatchEvent(new Event("brian:local-data-cleared"));
});
afterEach(() => vi.useRealTimers());
describe("retained chat history", () => {
  it("reads at 23h59 without extending authority and refuses exactly 24h", async () => {
    const synced = Date.now(), owner = chatHistoryScope("session");
    await writeChatHistory(owner, "session", rows, synced);
    vi.setSystemTime(synced + CHAT_OFFLINE_AUTHORITY_MS - 60_000);
    const before = await readChatHistory(chatHistoryScope("session"), "session");
    expect(before?.syncedAt).toBe(synced); expect(before?.rows).toEqual(rows);
    vi.setSystemTime(synced + CHAT_OFFLINE_AUTHORITY_MS);
    expect(await readChatHistory(chatHistoryScope("session"), "session")).toBeNull();
    expect((state.values.get(chatHistoryDiskKey(state.scope as never, "session")) as { syncedAt: number }).syncedAt).toBe(synced);
  });
  it("denial fences an older successful response and only a new authoritative read restores access", async () => {
    const older = chatHistoryScope("session"), denied = chatHistoryScope("session");
    await evictChatHistory(denied, "session");
    await writeChatHistory(older, "session", rows, Date.now());
    expect(await readChatHistory(chatHistoryScope("session"), "session")).toBeNull();
    const fresh = chatHistoryScope("session"); await writeChatHistory(fresh, "session", rows, Date.now());
    expect((await readChatHistory(fresh, "session"))?.rows).toEqual(rows);
  });
  it("an old queued IDB writer preserves the healthy response after denial and revalidation", async () => {
    const older = chatHistoryScope("session"); await prepareChatHistoryRead(older);
    await evictChatHistory(chatHistoryScope("session"), "session");
    const fresh = chatHistoryScope("session"), latest = [{ ...rows[0], content: "Newly authorized reply" }];
    await writeChatHistory(fresh, "session", latest, Date.now());
    await writeChatHistory(older, "session", rows, Date.now() - 1000);
    expect((await readChatHistory(fresh, "session"))?.rows).toEqual(latest);
  });

  it("records a current 403 durably after ticket capture fails over an existing valid list and history", async () => {
    const initial = chatHistoryScope("session")!;
    await writeChatHistory(initial, "session", rows, Date.now());
    const guard = chatFenceKey(initial.scope), listKey = chatSessionsDiskKey(initial.scope);
    const original = state.values.get(guard) as { generation: string };
    state.values.set(listKey, { version: 1, updatedAt: 123, cacheGeneration: original.generation, rowMarkers: { session: null, other: null },
      value: { personal: [{ id: "session", title: "Private retained title" }, { id: "other", title: "Other title" }], shared: [] } });
    const current = chatHistoryScope("session")!;
    state.failCapture = true; await prepareChatHistoryRead(current);
    await evictChatHistory(current, "session");
    const reloadedWindow = createChatCachePersistence({ read: idbReadEntries, update: idbUpdateEntries });
    expect(await reloadedWindow.readHistory(guard, chatHistoryDiskKey(initial.scope, "session"), "session")).toBeNull();
    const stored = await reloadedWindow.readList(guard, listKey);
    expect(stored?.updatedAt).toBe(123);
    expect(stored?.value.personal).toEqual([{ id: "other", title: "Other title" }]);
  });
  it("a ticketless old network read cannot bypass a subsequently observed denial from another window", async () => {
    const older = chatHistoryScope("session")!;
    state.failCapture = true; await prepareChatHistoryRead(older);
    const otherWindow = createChatCachePersistence({ read: idbReadEntries, update: idbUpdateEntries });
    const guard = chatFenceKey(older.scope), ticket = (await otherWindow.capture(guard))!;
    await otherWindow.deny(guard, chatHistoryDiskKey(older.scope, "session"), chatSessionsDiskKey(older.scope), "session", ticket);
    await refreshChatCacheFence(older.scope);
    expect(isChatHistoryReadCurrent(older, "session")).toBe(false);
    await writeChatHistory(older, "session", rows, Date.now());
    expect(state.values.has(chatHistoryDiskKey(older.scope, "session"))).toBe(false);
  });
  it("logout then the same account logging in cannot revive the earlier read", async () => {
    const owner = chatHistoryScope("session");
    window.dispatchEvent(new Event("brian:local-data-cleared")); state.values.clear();
    await writeChatHistory(owner, "session", rows, Date.now());
    expect(state.values.size).toBe(0);
  });
  it("separates deployment, viewer and workspace and fences a late identity response", async () => {
    const owner = chatHistoryScope("session"), before = chatHistoryMemoryKey("session");
    state.scope = { ...state.scope, viewerId: "other" };
    expect(chatHistoryMemoryKey("session")).not.toBe(before);
    await writeChatHistory(owner, "session", rows, Date.now()); expect(state.values.size).toBe(0);
    const second = chatHistoryDiskKey(state.scope as never, "session");
    expect(chatHistoryDiskKey({ ...state.scope, apiOrigin: "https://other.example" } as never, "session")).not.toBe(second);
    expect(chatHistoryDiskKey({ ...state.scope, workspaceId: "other" } as never, "session")).not.toBe(second);
  });
  it("preserves historical tool content without creating live pending interaction state", async () => {
    const owner = chatHistoryScope("session");
    await writeChatHistory(owner, "session", [{ ...rows[0], content: [{ type: "tool_use", input: { question: "Choose", actionId: "secret", signedUrl: "secret" } }] }], Date.now());
    expect(JSON.stringify(await readChatHistory(owner, "session"))).toContain("Choose");
    expect(JSON.stringify(await readChatHistory(owner, "session"))).toContain("secret");
    expect(await readChatHistory(owner, "session")).not.toHaveProperty("pendingConfirmation");
  });
});
