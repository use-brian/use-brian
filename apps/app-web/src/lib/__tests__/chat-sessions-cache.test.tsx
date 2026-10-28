// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-sessions-cache] The Chat rail's cached data (instant
 * navigation, Phase 3 adoption of report E "Worst offenders" #2).
 *
 * Pins the four things the adoption exists for: (a) a warmed key paints the
 * rows on the FIRST frame with the fetch still pending (no skeleton, no
 * "Loading"); (b) a spine / same-tab stale mark repaints without a blank
 * frame; (c) a thread switch never shows the previous session's transcript;
 * (d) the IndexedDB tier is keyed by viewer, so two accounts on one device
 * never read each other's threads, and an authoritative denial evicts it.
 * Plus the N7 rule the personal fetcher holds: the roster comes from the
 * cache entry, never a second roster request beside the roster hook's own.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const user = vi.hoisted(() => ({ id: "u1" as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));

const api = vi.hoisted(() => ({
  listWorkspaceAssistants: vi.fn(),
  listSessionsForAssistants: vi.fn(),
  listWorkspaceSessions: vi.fn(),
}));
vi.mock("@/lib/api/views", () => ({
  listWorkspaceAssistants: (...args: unknown[]) => api.listWorkspaceAssistants(...args),
  getView: vi.fn(),
}));
vi.mock("@/lib/api/sessions", () => ({
  listSessionsForAssistants: (...args: unknown[]) => api.listSessionsForAssistants(...args),
  listWorkspaceSessions: (...args: unknown[]) => api.listWorkspaceSessions(...args),
  fetchSessionMessages: vi.fn(),
}));
// The other warm targets import their SDKs; never called here.
vi.mock("@/lib/api/crm", () => ({ fetchCrmConfig: vi.fn() }));
vi.mock("@/lib/api/tasks", () => ({ fetchWorkspaceTasks: vi.fn() }));
vi.mock("@/lib/api/workflow", () => ({ listWorkflows: vi.fn() }));
vi.mock("@/lib/api/connectors", () => ({ fetchConnectorsList: vi.fn() }));
vi.mock("@/lib/api/association", () => ({ fetchAssociationModules: vi.fn() }));

/** In-memory stand-in for the offline KV store. */
const idb = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => idb.store.get(key) ?? null,
  idbSet: async (key: string, value: unknown) => {
    idb.store.set(key, value);
  },
  idbDelete: async (key: string) => {
    idb.store.delete(key);
  },
}));

import {
  chatRosterCacheKey,
  chatSessionsCacheKey,
  chatSharedSessionsCacheKey,
  chatTranscriptCacheKey,
} from "@/lib/surface-prefetch";
import {
  isSurfaceCacheStale,
  loadSurfaceCache,
  markSurfaceCacheStale,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { LIVE_REFRESH_EVENT } from "@/lib/workspace-events";
import { applySpineEventToSurfaceCache } from "@/lib/surface-cache-invalidation";
import { dispatchChatSessionsRefresh } from "@/lib/chat-session-events";
import {
  chatSessionsSnapshotKey,
  fetchPersonalChatSessions,
  isAuthoritativeRosterDenial,
  loadTranscriptCache,
  readCachedTranscript,
  useChatSessionsData,
  writeChatSessionsSnapshot,
  writeTranscriptCache,
  type ChatSessionsData,
} from "@/lib/chat-surface-data";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const never = () => new Promise<never>(() => {});

const ROSTER = [
  { id: "a1", name: "Brian", iconSeed: 0, kind: "primary" as const, appType: null },
];
const PERSONAL = [
  { id: "s1", title: "Quarterly plan", channelId: "c", lastActive: "2026-09-01T00:00:00.000Z", appOrigin: "chat", assistantId: "a1" },
];
const SHARED = [
  {
    id: "r1",
    title: "Launch room",
    channelId: "c",
    lastActive: "2026-09-01T00:00:00.000Z",
    appOrigin: "chat",
    assistantId: "a1",
    status: "idle",
    startedByUserId: "u9",
    startedByName: "Sam",
    startedByAvatarUrl: null,
  },
];

/** Render probe: paints the hook's state as text so a test can read it. */
function Probe({ onData }: { onData?: (data: ChatSessionsData) => void }) {
  const data = useChatSessionsData("w1");
  onData?.(data);
  return (
    <div>
      <span data-testid="personal">
        {data.personal === null ? "SKELETON" : data.personal.map((r) => r.title).join(",") || "EMPTY"}
      </span>
      <span data-testid="shared">
        {data.shared === null ? "SKELETON" : data.shared.map((r) => r.title).join(",") || "EMPTY"}
      </span>
      <span data-testid="assistants">{data.assistants.map((a) => a.name).join(",")}</span>
      <span data-testid="revalidating">{String(data.revalidating)}</span>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
}

const text = (id: string) =>
  container?.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

beforeEach(() => {
  resetSurfaceCache();
  idb.store.clear();
  user.id = "u1";
  api.listWorkspaceAssistants.mockReset();
  api.listSessionsForAssistants.mockReset();
  api.listWorkspaceSessions.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/chat-sessions-cache] keys", () => {
  it("builds workspace-first, viewer-suffixed list keys and a per-session transcript key", () => {
    expect(chatRosterCacheKey("w1")).toBe("chat-roster:w1:u1");
    expect(chatSessionsCacheKey("w1")).toBe("chat-sessions:w1:u1");
    expect(chatSharedSessionsCacheKey("w1")).toBe("chat-shared:w1:u1");
    expect(chatTranscriptCacheKey("s1")).toBe("chat-transcript:s1");
    user.id = "u2";
    expect(chatSessionsCacheKey("w1")).not.toBe("chat-sessions:w1:u1");
  });

  it("the sidebar panel and the surface both read the hook, and the hook builds its keys from the prefetch module", () => {
    const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
    const hook = src("lib/chat-surface-data.ts");
    expect(hook).toContain('from "@/lib/surface-prefetch"');
    // Code only: the module's prose names the keys in backticks.
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/["'`]chat-(roster|sessions|shared|transcript):/);
    for (const rel of [
      "components/doc/sidebar-panels/chat-sidebar-panel.tsx",
      "components/chat-app/chat-surface.tsx",
    ]) {
      const source = src(rel);
      expect(source).toContain("useChatSessionsData(workspaceId)");
      // No private list fetch, no refetch listener of its own (N3).
      expect(source).not.toContain("listSessionsForAssistants(");
      expect(source).not.toContain("listWorkspaceSessions(");
      expect(source).not.toContain("addEventListener(CHAT_SESSIONS_REFRESH_EVENT");
    }
    // The panel's cold state is the skeleton, never the "Loading" sentence.
    const panel = src("components/doc/sidebar-panels/chat-sidebar-panel.tsx");
    expect(panel).not.toContain("t.loading");
    expect(panel).toContain("<RailRowsSkeleton");
  });
});

describe("[COMP:app-web/chat-sessions-cache] first paint and stale marks", () => {
  it("(a) paints personal, shared and roster rows from warmed keys while the fetch is still pending", async () => {
    await loadSurfaceCache(chatRosterCacheKey("w1"), async () => ROSTER);
    await loadSurfaceCache(chatSessionsCacheKey("w1"), async () => PERSONAL);
    await loadSurfaceCache(chatSharedSessionsCacheKey("w1"), async () => SHARED);
    api.listWorkspaceAssistants.mockImplementation(never);
    api.listSessionsForAssistants.mockImplementation(never);
    api.listWorkspaceSessions.mockImplementation(never);

    mount(<Probe />);

    expect(text("personal")).toBe("Quarterly plan");
    expect(text("shared")).toBe("Launch room");
    expect(text("assistants")).toBe("Brian");
    // Fresh keys: nothing refetches on mount.
    expect(api.listWorkspaceAssistants).not.toHaveBeenCalled();
    expect(api.listSessionsForAssistants).not.toHaveBeenCalled();
    expect(api.listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("(b) a spine `session` mark and the same-tab refresh signal repaint without a blank frame", async () => {
    await loadSurfaceCache(chatRosterCacheKey("w1"), async () => ROSTER);
    await loadSurfaceCache(chatSessionsCacheKey("w1"), async () => PERSONAL);
    await loadSurfaceCache(chatSharedSessionsCacheKey("w1"), async () => SHARED);
    let resolveShared: (rows: typeof SHARED) => void = () => {};
    api.listWorkspaceSessions.mockImplementation(
      () => new Promise<typeof SHARED>((r) => { resolveShared = r; }),
    );
    api.listSessionsForAssistants.mockResolvedValue(PERSONAL);
    mount(<Probe />);
    expect(text("shared")).toBe("Launch room");

    // The spine's session primitive marks both lists stale...
    act(() => {
      applySpineEventToSurfaceCache(LIVE_REFRESH_EVENT, { workspaceId: "w1" }, "w1");
    });
    await act(async () => {
      await settle();
    });
    // ...the rows stay painted while the refetch runs behind them...
    expect(text("shared")).toBe("Launch room");
    expect(text("revalidating")).toBe("true");
    expect(api.listWorkspaceSessions).toHaveBeenCalledTimes(1);
    // ...and the new rows land in place.
    await act(async () => {
      resolveShared([{ ...SHARED[0], title: "Launch room (renamed)" }]);
      await settle();
    });
    expect(text("shared")).toBe("Launch room (renamed)");

    // The same-tab signal (a rename, a settle) does the same through the hook.
    api.listWorkspaceSessions.mockImplementation(
      () => new Promise<typeof SHARED>((r) => { resolveShared = r; }),
    );
    act(() => {
      dispatchChatSessionsRefresh("w1");
    });
    expect(isSurfaceCacheStale(chatSessionsCacheKey("w1"))).toBe(true);
    expect(isSurfaceCacheStale(chatSharedSessionsCacheKey("w1"))).toBe(true);
    await act(async () => {
      await settle();
    });
    expect(text("shared")).toBe("Launch room (renamed)");
    expect(text("personal")).toBe("Quarterly plan");
    // A signal for ANOTHER workspace is ignored.
    await act(async () => {
      resolveShared(SHARED);
      await settle();
    });
    dispatchChatSessionsRefresh("w9");
    expect(isSurfaceCacheStale(chatSharedSessionsCacheKey("w1"))).toBe(false);
  });

  it("the personal fetcher reads a fresh roster from the cache and never fires a second roster request (N7)", async () => {
    await loadSurfaceCache(chatRosterCacheKey("w1"), async () => ROSTER);
    api.listSessionsForAssistants.mockResolvedValue(PERSONAL);
    await fetchPersonalChatSessions("w1");
    expect(api.listWorkspaceAssistants).not.toHaveBeenCalled();
    expect(api.listSessionsForAssistants).toHaveBeenCalledWith({
      workspaceId: "w1",
      assistantIds: ["a1"],
      strict: true,
    });
  });

  it("a cold mount fetches the roster and the shared list in parallel, then joins the roster load for the personal list", async () => {
    let resolveRoster: (rows: typeof ROSTER) => void = () => {};
    api.listWorkspaceAssistants.mockImplementation(
      () => new Promise<typeof ROSTER>((r) => { resolveRoster = r; }),
    );
    api.listWorkspaceSessions.mockResolvedValue(SHARED);
    api.listSessionsForAssistants.mockResolvedValue(PERSONAL);
    mount(<Probe />);
    expect(text("personal")).toBe("SKELETON");
    await act(async () => {
      await settle();
    });
    // Roster and shared list both started before the roster answered;
    // exactly one roster request between the roster hook and the personal
    // fetcher.
    expect(api.listWorkspaceAssistants).toHaveBeenCalledTimes(1);
    expect(api.listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(text("shared")).toBe("Launch room");
    await act(async () => {
      resolveRoster(ROSTER);
      await settle();
      await settle();
    });
    expect(api.listWorkspaceAssistants).toHaveBeenCalledTimes(1);
    expect(api.listSessionsForAssistants).toHaveBeenCalledWith({
      workspaceId: "w1",
      assistantIds: ["a1"],
      strict: true,
    });
    expect(text("personal")).toBe("Quarterly plan");
  });
});

describe("[COMP:app-web/chat-sessions-cache] list failures", () => {
  async function healthyLists() {
    api.listWorkspaceAssistants.mockResolvedValue(ROSTER);
    api.listSessionsForAssistants.mockResolvedValue(PERSONAL);
    api.listWorkspaceSessions.mockResolvedValue(SHARED);
    let latest: ChatSessionsData;
    mount(<Probe onData={(data) => { latest = data; }} />);
    await act(async () => { await settle(); await settle(); });
    return () => latest!;
  }

  it("does not turn a failed cold roster read into successful empty history", async () => {
    api.listWorkspaceAssistants.mockRejectedValue(new Error("Failed to list workspace assistants: 503"));
    await expect(fetchPersonalChatSessions("w1")).rejects.toThrow();
    expect(api.listSessionsForAssistants).not.toHaveBeenCalled();
  });

  it("retains healthy rows and disk history after a failed list refresh", async () => {
    api.listWorkspaceAssistants.mockResolvedValue(ROSTER);
    api.listSessionsForAssistants.mockResolvedValue(PERSONAL);
    api.listWorkspaceSessions.mockResolvedValue(SHARED);
    let latest: ChatSessionsData | undefined;
    mount(<Probe onData={(data) => { latest = data; }} />);
    await act(async () => { await settle(); await settle(); });
    const snapshot = idb.store.get(chatSessionsSnapshotKey("u1", "w1"));
    const failure = new Error("chat_list_failed: 500");
    api.listSessionsForAssistants.mockRejectedValue(failure);
    await act(async () => { await latest!.refreshPersonal(); await settle(); });
    expect(text("personal")).toBe("Quarterly plan");
    expect(latest?.personalError).toBe(failure);
    expect(idb.store.get(chatSessionsSnapshotKey("u1", "w1"))).toBe(snapshot);
  });

  it("evicts a denied personal value so a later server failure cannot restore it", async () => {
    const latest = await healthyLists();
    api.listSessionsForAssistants.mockRejectedValue(new Error("chat_list_failed: 403"));
    await act(async () => { await latest().refreshPersonal(); await settle(); });
    expect(latest().personal).toBeNull();
    expect(readSurfaceCache(chatSessionsCacheKey("w1")).data).toBeUndefined();
    api.listSessionsForAssistants.mockRejectedValue(new Error("chat_list_failed: 500"));
    await act(async () => { await latest().refresh(); await settle(); });
    expect(latest().personal).toBeNull();
    expect(text("personal")).not.toBe("Quarterly plan");
  });

  it("keeps independently current personal history available when only the shared list is denied", async () => {
    const latest = await healthyLists();
    api.listWorkspaceSessions.mockRejectedValue(new Error("chat_list_failed: 403"));
    await act(async () => { await latest().refreshShared(); await settle(); });
    expect(latest().personal).toEqual(PERSONAL);
    expect(latest().personalError).toBeUndefined();
    expect(latest().shared).toBeNull();
    expect(readSurfaceCache(chatSharedSessionsCacheKey("w1")).data).toBeUndefined();
  });

  it("cannot restore denied history when only the roster recovers", async () => {
    const latest = await healthyLists();
    api.listWorkspaceAssistants.mockRejectedValue(new Error("Failed to list workspace assistants: 403"));
    api.listSessionsForAssistants.mockRejectedValue(new Error("chat_list_failed: 500"));
    api.listWorkspaceSessions.mockRejectedValue(new Error("chat_list_failed: 500"));
    await act(async () => { await latest().refresh(); await settle(); await settle(); });
    expect(latest().personal).toBeNull();
    expect(latest().shared).toBeNull();
    api.listWorkspaceAssistants.mockResolvedValue(ROSTER);
    await act(async () => { await latest().refresh(); await settle(); });
    expect(latest().personal).toBeNull();
    expect(latest().shared).toBeNull();
  });

  it("does not hydrate history outside the existing offline authority window", async () => {
    await writeChatSessionsSnapshot("u1", "w1", { personal: PERSONAL, shared: SHARED });
    const stored = idb.store.get(chatSessionsSnapshotKey("u1", "w1")) as { updatedAt: number };
    stored.updatedAt = Date.now() - 60 * 60_000 - 1;
    api.listWorkspaceAssistants.mockImplementation(never);
    api.listSessionsForAssistants.mockImplementation(never);
    api.listWorkspaceSessions.mockImplementation(never);
    mount(<Probe />);
    await act(async () => { await settle(); });
    expect(text("personal")).toBe("SKELETON");
    expect(text("shared")).toBe("SKELETON");
  });
});

describe("[COMP:app-web/chat-sessions-cache] transcripts", () => {
  it("(c) a thread switch reads the target session's own key, so the previous thread's rows never paint", async () => {
    const rowsA = [{ id: "m1", role: "user", text: "hello from s1", timestamp: new Date() }];
    // A cold seed lands on the next tick (it goes through the loader).
    writeTranscriptCache("s1", rowsA);
    await settle();
    expect(readCachedTranscript("s1")).toEqual(rowsA);
    // Switching to s2 finds nothing under s2 - not s1's rows.
    expect(readCachedTranscript("s2")).toBeUndefined();
    const rowsB = [{ id: "m2", role: "assistant", text: "s2 reply", timestamp: new Date() }];
    await loadTranscriptCache("s2", async () => rowsB);
    expect(readCachedTranscript("s2")).toEqual(rowsB);
    expect(readCachedTranscript("s1")).toEqual(rowsA);
    // The surface's hydrate effect clears the pane on a cold session and paints
    // the cached rows on a warm one, in that order, before it fetches.
    const surface = readFileSync(
      resolve(process.cwd(), "src/components/chat-app/chat-surface.tsx"),
      "utf8",
    );
    expect(surface).toMatch(
      /readCachedTranscript<SurfaceMessage>\(activeSessionId\);\s*chat\.loadMessages\(cached \?\? \[\]\);\s*setTranscriptCold\(!cached\);/,
    );
  });

  it("write-through patches a cached transcript and seeds a cold one; a forced load bypasses the dedupe", async () => {
    const first = [{ id: "m1", text: "a" }];
    writeTranscriptCache("s3", first);
    await settle();
    expect(readCachedTranscript("s3")).toEqual(first);
    // A warm slot patches synchronously.
    const second = [{ id: "m1", text: "a" }, { id: "m2", text: "b" }];
    writeTranscriptCache("s3", second);
    expect(readCachedTranscript("s3")).toEqual(second);
    const fetcher = vi.fn(async () => [{ id: "m3", text: "settled" }]);
    const rows = await loadTranscriptCache("s3", fetcher, { force: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ id: "m3", text: "settled" }]);
    expect(readSurfaceCache(chatTranscriptCacheKey("s3")).data).toEqual(rows);
  });
});

describe("[COMP:app-web/chat-sessions-cache] IndexedDB tier", () => {
  it("(d) hydrates the rail from the viewer's own snapshot while the network is pending, and never another viewer's", async () => {
    expect(chatSessionsSnapshotKey("u1", "w1")).not.toBe(chatSessionsSnapshotKey("u2", "w1"));
    await writeChatSessionsSnapshot("u1", "w1", { personal: PERSONAL, shared: SHARED });
    api.listWorkspaceAssistants.mockImplementation(never);
    api.listSessionsForAssistants.mockImplementation(never);
    api.listWorkspaceSessions.mockImplementation(never);

    // Another account on the same device: nothing to paint.
    user.id = "u2";
    mount(<Probe />);
    await act(async () => {
      await settle();
    });
    expect(text("personal")).toBe("SKELETON");
    expect(text("shared")).toBe("SKELETON");
    act(() => {
      root?.unmount();
    });
    container?.remove();

    // The viewer who wrote it: the last-known rail paints before the network.
    user.id = "u1";
    mount(<Probe />);
    await act(async () => {
      await settle();
    });
    expect(text("personal")).toBe("Quarterly plan");
    expect(text("shared")).toBe("Launch room");
  });

  it("writes the snapshot once both lists have landed, and an authoritative roster denial evicts it", async () => {
    api.listWorkspaceAssistants.mockResolvedValue(ROSTER);
    api.listSessionsForAssistants.mockResolvedValue(PERSONAL);
    api.listWorkspaceSessions.mockResolvedValue(SHARED);
    mount(<Probe />);
    await act(async () => {
      await settle();
      await settle();
    });
    expect(idb.store.has(chatSessionsSnapshotKey("u1", "w1"))).toBe(true);
    act(() => {
      root?.unmount();
    });
    container?.remove();

    resetSurfaceCache();
    api.listWorkspaceAssistants.mockRejectedValue(
      new Error("Failed to list workspace assistants: 403"),
    );
    api.listSessionsForAssistants.mockResolvedValue([]);
    api.listWorkspaceSessions.mockResolvedValue([]);
    mount(<Probe />);
    await act(async () => {
      await settle();
      await settle();
    });
    expect(idb.store.has(chatSessionsSnapshotKey("u1", "w1"))).toBe(false);
  });

  it("treats only 401 / 403 / 404 on the roster as authoritative", () => {
    expect(isAuthoritativeRosterDenial(new Error("Failed to list workspace assistants: 403"))).toBe(true);
    expect(isAuthoritativeRosterDenial(new Error("Failed to list workspace assistants: 404"))).toBe(true);
    expect(isAuthoritativeRosterDenial(new Error("Failed to list workspace assistants: 500"))).toBe(false);
    expect(isAuthoritativeRosterDenial(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAuthoritativeRosterDenial(undefined)).toBe(false);
  });

  it("a stale mark keeps the rows (the spine never blanks the rail)", async () => {
    await loadSurfaceCache(chatSessionsCacheKey("w1"), async () => PERSONAL);
    markSurfaceCacheStale(`chat-sessions:w1`);
    expect(isSurfaceCacheStale(chatSessionsCacheKey("w1"))).toBe(true);
    expect(readSurfaceCache(chatSessionsCacheKey("w1")).data).toEqual(PERSONAL);
  });
});
