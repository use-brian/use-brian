// @vitest-environment jsdom
/**
 * [COMP:app-web/session-list-requests] One session-list request per distinct
 * query on a page open, shared by every host, and aborted when nobody waits.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = vi.hoisted(() => ({ id: "u1" as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "Avery Example", email: "avery@example.com" } : null),
  subscribeUserInfo: () => () => {},
}));
vi.mock("@/lib/api/views", () => ({ listWorkspaceAssistants: async () => [], getView: vi.fn() }));
vi.mock("@/lib/api/crm", () => ({ fetchCrmConfig: vi.fn() }));
vi.mock("@/lib/api/tasks", () => ({ fetchWorkspaceTasks: vi.fn() }));
vi.mock("@/lib/api/workflow", () => ({ listWorkflows: vi.fn() }));
vi.mock("@/lib/api/connectors", () => ({ fetchConnectorsList: vi.fn() }));
const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/offline/idb", () => ({ idbReadEntries: async (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, cache.get(key) ?? null])), idbUpdateEntries: async (keys: readonly string[], update: (values: Record<string, unknown>) => Record<string, unknown>) => { const values = Object.fromEntries(keys.map(key => [key, cache.get(key) ?? null])); for (const [key, value] of Object.entries(update(values))) { if (value === undefined) cache.delete(key); else cache.set(key, value); values[key] = value ?? null; } return values; }, idbGet: async () => null, idbSet: async () => {}, idbDelete: async () => {}, idbUpdate: async () => null }));

import { fetchLatestSession } from "@/lib/api/sessions";
import { useChatSessionsData, useProjectChatSessionsData } from "@/lib/chat-surface-data";
import { readSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { chatSessionsCacheKey } from "@/lib/surface-prefetch";
import { chatHistoryScope, evictChatHistory, filterRetainedChatSessions } from "@/lib/offline/chat-history-cache";
import {
  requestSessionList,
  sessionListRequestStats,
  sessionListRequestsInFlight,
  setSessionListFetcherForTest,
} from "../session-list-requests";

type Pending = { url: string; signal: AbortSignal; resolve: (rows: unknown[]) => void; aborted: () => boolean };

/** A fake transport that holds every list request until the test answers it. */
function fakeLists() {
  const pending: Pending[] = [];
  const restore = setSessionListFetcherForTest((url, init) => new Promise<Response>((resolve, reject) => {
    const entry: Pending = {
      url, signal: init.signal,
      resolve: (rows) => resolve(new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } })),
      aborted: () => init.signal.aborted,
    };
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    pending.push(entry);
  }));
  return { pending, restore };
}
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const query = (url: string) => decodeURIComponent(url.slice(url.indexOf("/api/")));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restore: (() => void) | undefined;
beforeEach(() => { resetSurfaceCache(); cache.clear(); user.id = "u1"; window.history.replaceState({}, "", "/w/w1/chat"); window.dispatchEvent(new Event("brian:local-data-cleared")); });
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined; container = undefined;
  restore?.(); restore = undefined;
  vi.useRealTimers();
  document.cookie = "access_token=;path=/;max-age=0";
});

describe("[COMP:app-web/session-list-requests] request coalescing", () => {
  it("a caller joining after denial retains the earlier transport's admission start", async () => {
    window.history.replaceState({}, "", "/w/11111111-1111-4111-8111-111111111111/chat");
    const net = fakeLists(); restore = net.restore;
    const url = "https://api.example/api/sessions?workspaceId=11111111-1111-4111-8111-111111111111";
    const first = requestSessionList(url);
    await tick();
    await evictChatHistory(chatHistoryScope("s-1"), "s-1");
    const joined = requestSessionList(url);
    await tick();
    expect(net.pending).toHaveLength(1);
    net.pending[0]!.resolve([{ id: "s-1", title: "Old title" }]);
    const [a, b] = await Promise.all([first, joined]);
    expect(a.authorityRead).toBe(b.authorityRead);
    expect(filterRetainedChatSessions(a.authorityRead!.scope, a.data as Array<{ id: string }>, a.authorityRead)).toEqual([]);
    const fresh = requestSessionList(url); await tick(); net.pending[1]!.resolve([{ id: "s-1", title: "Current title" }]);
    const current = await fresh;
    expect(filterRetainedChatSessions(current.authorityRead!.scope, current.data as Array<{ id: string }>, current.authorityRead)).toHaveLength(1);
    expect(filterRetainedChatSessions(a.authorityRead!.scope, a.data as Array<{ id: string }>, a.authorityRead)).toEqual([]);
  });

  it("does not coalesce the same URL across authenticated account changes", async () => {
    window.history.replaceState({}, "", "/w/11111111-1111-4111-8111-111111111111/chat");
    const net = fakeLists(); restore = net.restore;
    document.cookie = "access_token=first-account;path=/";
    const first = requestSessionList("https://api.example/api/sessions?workspaceId=11111111-1111-4111-8111-111111111111");
    await tick();
    user.id = "u2"; document.cookie = "access_token=second-account;path=/";
    const second = requestSessionList("https://api.example/api/sessions?workspaceId=11111111-1111-4111-8111-111111111111");
    await tick();
    expect(net.pending).toHaveLength(2);
    net.pending[0]!.resolve([{ id: "private-first-account" }]); net.pending[1]!.resolve([{ id: "own-second-account" }]);
    const [a, b] = await Promise.all([first, second]);
    expect(filterRetainedChatSessions(a.authorityRead!.scope, a.data as Array<{ id: string }>, a.authorityRead)).toEqual([]);
    expect(filterRetainedChatSessions(b.authorityRead!.scope, b.data as Array<{ id: string }>, b.authorityRead)).toEqual([{ id: "own-second-account" }]);
  });

  it("callers of one query share one request and one parsed body; distinct queries stay distinct", async () => {
    const net = fakeLists(); restore = net.restore;
    const a = requestSessionList("https://api.example/api/sessions?scope=workspace");
    const b = requestSessionList("https://api.example/api/sessions?scope=workspace");
    const c = requestSessionList("https://api.example/api/sessions?scope=workspace&appOrigin=doc");
    expect(net.pending.map((item) => query(item.url))).toEqual([
      "/api/sessions?scope=workspace", "/api/sessions?scope=workspace&appOrigin=doc",
    ]);
    net.pending[0]!.resolve([{ id: "s-1" }]);
    net.pending[1]!.resolve([]);
    const [first, second, third] = await Promise.all([a, b, c]);
    expect(first).toEqual({ ok: true, status: 200, data: [{ id: "s-1" }] });
    expect(second.data).toBe(first.data);
    expect(third.data).toEqual([]);
    // Settled requests leave the map; the next caller asks the server again.
    void requestSessionList("https://api.example/api/sessions?scope=workspace");
    expect(net.pending).toHaveLength(3);
  });

  it("a caller's abort detaches only that caller; the last one aborts the request", async () => {
    const net = fakeLists(); restore = net.restore;
    const first = new AbortController();
    const second = new AbortController();
    const one = requestSessionList("https://api.example/api/sessions?q=1", first.signal);
    const two = requestSessionList("https://api.example/api/sessions?q=1", second.signal);
    first.abort();
    await expect(one).rejects.toMatchObject({ name: "AbortError" });
    expect(net.pending[0]!.aborted()).toBe(false);
    second.abort();
    await expect(two).rejects.toMatchObject({ name: "AbortError" });
    expect(net.pending[0]!.aborted()).toBe(true);
    expect(sessionListRequestsInFlight()).toBe(0);
  });
});

describe("[COMP:app-web/session-list-requests] page open across the hosts that mount today", () => {
  it("issues one list request per distinct query (before: one per caller)", async () => {
    const net = fakeLists(); restore = net.restore;
    // The viewer id is not known on the first render, so the cached lists
    // start under one key and move to the viewer-scoped key mid-flight.
    user.id = null;
    function ChatPage() { useChatSessionsData("w1"); return null; }
    function SidebarPanel() { useChatSessionsData("w1"); useProjectChatSessionsData("w1", null); return null; }
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<><ChatPage /><SidebarPanel /></>));
    user.id = "u1";
    await act(async () => root!.render(<><ChatPage key="viewer-page" /><SidebarPanel key="viewer-sidebar" /></>));
    // The desktop dock and the phone drawer both resume the doc thread.
    const dock = fetchLatestSession({ workspaceId: "w1", scope: "workspace", appOrigin: "doc" });
    const drawer = fetchLatestSession({ workspaceId: "w1", scope: "workspace", appOrigin: "doc" });
    await tick();
    const stats = [...sessionListRequestStats()].map(([url, row]) => ({ query: query(url), ...row }));
    const before = stats.reduce((sum, row) => sum + row.callers, 0);
    const after = stats.reduce((sum, row) => sum + row.requests, 0);
    // One request per distinct query on the wire.
    expect(stats.every((row) => row.requests === 1)).toBe(true);
    expect(stats.map((row) => row.query).sort()).toEqual([
      "/api/sessions/workspace?workspaceId=w1",
      "/api/sessions/workspace?workspaceId=w1&contextProjectId=general",
      "/api/sessions?workspaceId=w1&scope=workspace&appOrigin=doc",
      "/api/sessions?scope=workspace&channels=all&workspaceId=w1",
    ].sort());
    // Measured: 8 list calls (2 per query) used to mean 8 requests.
    expect(after).toBe(4);
    expect(before).toBe(8);
    console.info(`[session-list-requests] page open: ${before} list calls before coalescing, ${after} requests after`, stats);
    for (const item of net.pending) item.resolve(item.url.includes("appOrigin=doc") ? [] : [{ id: "s-1", title: "New Chat", lastActive: "2026-11-17T00:00:00.000Z", channelId: "c-1" }]);
    expect(await dock).toBeNull();
    expect(await drawer).toBeNull();
    await tick();
    // Titles withheld under load arrive as the server's placeholder: the row
    // still renders under it.
    expect(readSurfaceCache<Array<{ title: string }>>(chatSessionsCacheKey("w1")).data?.map((row) => row.title)).toEqual(["New Chat"]);
  });

  it("aborts an in-flight list when its last host unmounts, recording no failure", async () => {
    const net = fakeLists(); restore = net.restore;
    function ChatPage() { useChatSessionsData("w1"); return null; }
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<><ChatPage /><ChatPage /></>));
    await tick();
    const personal = net.pending.find((item) => item.url.includes("channels=all"))!;
    expect(personal.aborted()).toBe(false);
    await act(async () => root!.render(<ChatPage />)); // one host remains
    await tick();
    expect(personal.aborted()).toBe(false);
    await act(async () => root!.render(<></>)); // the last host leaves
    await tick();
    expect(personal.aborted()).toBe(true);
    const entry = readSurfaceCache(chatSessionsCacheKey("w1"));
    expect(entry.error).toBeUndefined();
    expect(entry.data).toBeUndefined();
    // Mounting again starts a fresh read rather than waiting on a dead one.
    await act(async () => root!.render(<ChatPage />));
    await tick();
    expect(net.pending.filter((item) => item.url.includes("channels=all"))).toHaveLength(2);
  });

  it("aborts the old query's read when a host moves to another query", async () => {
    const net = fakeLists(); restore = net.restore;
    function ProjectGroup({ project }: { project: string }) { useProjectChatSessionsData("w1", project); return null; }
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<ProjectGroup project="p-a" />));
    await tick();
    await act(async () => root!.render(<ProjectGroup project="p-b" />));
    await tick();
    const a = net.pending.find((item) => item.url.includes("contextProjectId=p-a"))!;
    const b = net.pending.find((item) => item.url.includes("contextProjectId=p-b"))!;
    expect(a.aborted()).toBe(true);
    expect(b.aborted()).toBe(false);
  });

  it("a StrictMode replay keeps its read", async () => {
    const net = fakeLists(); restore = net.restore;
    function ChatPage() { useChatSessionsData("w1"); return null; }
    const { StrictMode } = await import("react");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<StrictMode><ChatPage /></StrictMode>));
    await tick();
    expect(net.pending.filter((item) => item.url.includes("channels=all"))).toHaveLength(1);
    expect(net.pending.every((item) => !item.aborted())).toBe(true);
  });
});
