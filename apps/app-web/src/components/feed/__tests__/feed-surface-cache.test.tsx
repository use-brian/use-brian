// @vitest-environment jsdom
/**
 * [COMP:app-web/feed-surface-cache] The Feed surfaces paint from the surface
 * cache (instant-navigation contract N1 / N2 / N3).
 *
 * Report E's worst offender: every Feed entry rendered "Loading your feed
 * workspace..." until five requests resolved, while `feedCachedJson` held
 * every response on disk and refused to return it while online. These pin
 * the three adopted surfaces (the shell gate, the sidebar post list, the
 * Plan month) against the preamble's two-test contract: (a) a warmed key
 * paints the rows on the FIRST frame with the fetch still pending - no
 * skeleton, no sentence; (b) a spine / local mark-stale repaints without a
 * blank frame and adopts the revalidated value. Plus the disk tier's two
 * rules: the IndexedDB seed is viewer-keyed, and a cold key answers from
 * disk before the network lands behind it.
 */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = vi.hoisted(() => ({ id: "u1" as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
  getCachedUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));

/** Controllable loaders: pending by default, resolvable per test. */
const loaders = vi.hoisted(() => ({
  workspace: vi.fn((..._args: unknown[]) => new Promise<unknown>(() => {})),
  sessions: vi.fn((..._args: unknown[]) => new Promise<unknown>(() => {})),
  plan: vi.fn((..._args: unknown[]) => new Promise<unknown>(() => {})),
}));
vi.mock("@/lib/feed-surface-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feed-surface-cache")>()),
  loadFeedWorkspaceRecord: (...args: unknown[]) => loaders.workspace(...args),
  loadFeedPlatformSessions: (...args: unknown[]) => loaders.sessions(...args),
  loadFeedPlanMonth: (...args: unknown[]) => loaders.plan(...args),
}));

/** An in-memory IndexedDB for the disk-tier tests. */
const idb = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => idb.store.get(key) ?? null,
  idbSet: async (key: string, value: unknown) => {
    idb.store.set(key, value);
  },
  idbDelete: async (key: string) => {
    idb.store.delete(key);
  },
  idbUpdate: async (key: string, update: (v: unknown) => unknown) => {
    const next = update(idb.store.get(key) ?? null);
    idb.store.set(key, next);
    return next;
  },
  clearLocalDocCaches: async () => {},
}));

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(), getAccessToken: () => null }));
const nav = vi.hoisted(() => ({ pathname: "/w/ws-1/feed" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ workspaceId: "ws-1", platform: "threads" }),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => ({
    feedProfiles: null,
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}));
// The shell's ready branch mounts the Feed dock; it is not under test here.
vi.mock("@/components/feed/feed-floating-chat", () => ({
  FeedFloatingChat: () => null,
}));
vi.mock("@/lib/chat-dock-suppress", () => ({
  chatDockSuppression: { suppress: () => () => {} },
}));
// The Plan board's chat rail, resize seam and session probes are not under
// test; the calendar itself renders for real so the slot chip is asserted.
vi.mock("@/components/feed/plan-chat-rail", () => ({
  PlanChatRail: () => null,
  PlanProposalCardboard: () => null,
  PlanQuickActions: () => null,
}));
vi.mock("@/components/operator/resizable-peek", () => ({
  usePeekResize: () => ({ width: null, resizing: false, handleProps: {} }),
  PeekResizeHandle: () => null,
}));
vi.mock("@/components/feed/use-lg-viewport", () => ({ useLgViewport: () => true }));
vi.mock("@/lib/api/feed", () => ({
  ensurePlanSession: async () => null,
  fetchFeedSessionIdByChannel: async () => null,
  createFeedIdea: vi.fn(),
  createPlanSlot: vi.fn(),
  deletePlanSlot: vi.fn(),
  draftFromFeedIdea: vi.fn(),
  draftFromPlanSlot: vi.fn(),
  savePlanBrief: vi.fn(),
  updateFeedIdea: vi.fn(),
  updatePlanSlot: vi.fn(),
}));
vi.mock("@/lib/api/sessions", () => ({ fetchSessionMessages: async () => [] }));
vi.mock("@/components/feed/connect-account-dialog", () => ({
  useConnectAccount: () => ({ openConnect: vi.fn(), dialog: null, isAdmin: true }),
}));
vi.mock("@/components/feed/feed-onboarding", () => ({
  FeedOnboarding: ({ onReady }: { onReady: () => void }) => {
    useEffect(() => onReady(), [onReady]);
    return null;
  },
}));
const feedWorkspace = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/contexts/feed-profiles-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/feed-profiles-context")>()),
  useFeedWorkspace: () => feedWorkspace.current,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  isSurfaceCacheStale,
  loadSurfaceCache,
  markSurfaceCacheStale,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import {
  feedPlanCacheKey,
  feedSessionsCacheKey,
  feedWorkspaceCacheKey,
} from "@/lib/surface-prefetch";
import {
  feedPaintFirst,
  readFeedCachedJson,
  writeFeedCachedJson,
} from "@/lib/offline/feed-cache";
import type {
  FeedPlanMonth,
  FeedPlatformSessions,
  FeedWorkspaceRecord,
} from "@/lib/feed-surface-cache";
import type { FeedDraftSessionSummary } from "@/lib/api/feed";
import type { PlanSlot } from "@/lib/feed-plan";
import { useFeedWorkspaceState } from "@/contexts/feed-profiles-context";
import { FeedSurfaceShell } from "../feed-surface-shell";
import { FeedPlan } from "../feed-plan";
import { FeedSidebarPanel } from "@/components/doc/sidebar-panels/feed-sidebar-panel";

const dict = en as unknown as Dictionary;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  resetSurfaceCache();
  idb.store.clear();
  user.id = "u1";
  nav.pathname = "/w/ws-1/feed";
  for (const loader of [loaders.workspace, loaders.sessions, loaders.plan]) {
    loader.mockClear();
    loader.mockImplementation(() => new Promise(() => {}));
  }
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>);
  });
}

function record(overrides: Partial<FeedWorkspaceRecord> = {}): FeedWorkspaceRecord {
  return {
    workspaceId: "ws-1",
    name: "Acme",
    role: "admin",
    canDraft: true,
    me: { id: "u1" },
    profiles: [],
    assistants: [{ id: "a-1", name: "Brand voice" }],
    brand: null,
    cloudLink: { state: "native" },
    ...overrides,
  };
}

function session(id: string, title: string): FeedDraftSessionSummary {
  const time = "2026-09-01T00:00:00.000Z";
  return {
    id,
    platform: "threads",
    title: `[threads] ${title}`,
    startedBy: { id: "u1", name: "Me" },
    createdAt: time,
    lastActiveAt: time,
    preview: null,
    replyTarget: null,
    draftText: null,
    selectedDraft: null,
    seedKind: "freeform",
    draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0, deleted: 0 },
  } as FeedDraftSessionSummary;
}

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: "slot-1",
    assistantId: "a-1",
    platform: "threads",
    scheduledFor: "2026-09-04",
    scheduledMinute: null,
    title: "Launch recap",
    brief: null,
    media: [],
    status: "planned",
    draftId: null,
    sessionId: null,
    createdBy: "u1",
    createdAt: "2026-08-29T01:00:00Z",
    updatedAt: "2026-08-29T01:00:00Z",
    ...overrides,
  };
}

function Probe() {
  return <div data-feed-page>page body</div>;
}

describe("[COMP:app-web/feed-surface-cache] the shell gate", () => {
  it("paints the children on the first frame from a warmed key with the fetch still pending", async () => {
    await loadSurfaceCache(feedWorkspaceCacheKey("ws-1"), async () => record());
    markSurfaceCacheStale(feedWorkspaceCacheKey("ws-1"));

    mount(
      <FeedSurfaceShell workspaceId="ws-1">
        <Probe />
      </FeedSurfaceShell>,
    );

    expect(host!.querySelector("[data-feed-page]")).not.toBeNull();
    expect(host!.querySelector("[data-feed-gate-skeleton]")).toBeNull();
    expect(host!.textContent).not.toContain(en.feedPage.shell.loading);
    // The revalidation is in flight behind the paint, through the loader
    // the key names - the cache reads it with the same builder.
    expect(loaders.workspace).toHaveBeenCalledWith("ws-1", "feed-workspace:ws-1:u1");
  });

  it("repaints without a blank frame on the spine's mark-stale, then adopts the fresh record", async () => {
    await loadSurfaceCache(feedWorkspaceCacheKey("ws-1"), async () => record({ name: "Acme" }));
    let resolveFresh: (value: FeedWorkspaceRecord) => void = () => {};
    loaders.workspace.mockImplementation(
      () => new Promise<unknown>((resolve) => { resolveFresh = resolve as typeof resolveFresh; }),
    );

    function NameProbe() {
      // Reads the record the way every feed page does, through the provider;
      // the name is the field `workspace_config` (the identity refresh
      // event) moves.
      const state = useFeedWorkspaceState();
      return <div data-feed-page>{state.status === "ready" ? state.value.name : ""}</div>;
    }
    mount(
      <FeedSurfaceShell workspaceId="ws-1">
        <NameProbe />
      </FeedSurfaceShell>,
    );
    expect(host!.querySelector("[data-feed-page]")?.textContent).toBe("Acme");

    act(() => {
      markSurfaceCacheStale("feed-workspace:ws-1");
    });
    // Stale, not gone: the page keeps painting while it revalidates.
    expect(host!.querySelector("[data-feed-page]")?.textContent).toBe("Acme");
    expect(host!.querySelector("[data-feed-gate-skeleton]")).toBeNull();
    expect(readSurfaceCache(feedWorkspaceCacheKey("ws-1")).revalidating).toBe(true);

    await act(async () => {
      resolveFresh(record({ name: "Acme Renamed" }));
      await settle();
    });
    expect(host!.querySelector("[data-feed-page]")?.textContent).toBe("Acme Renamed");
    expect(host!.querySelector("[data-feed-gate-skeleton]")).toBeNull();
  });

  it("renders the skeleton, never the sentence, when nothing is cached", () => {
    mount(
      <FeedSurfaceShell workspaceId="ws-1">
        <Probe />
      </FeedSurfaceShell>,
    );
    expect(host!.querySelector("[data-feed-gate-skeleton]")).not.toBeNull();
    expect(host!.querySelector("[data-feed-page]")).toBeNull();
    expect(host!.textContent).not.toContain(en.feedPage.shell.loading);
  });
});

describe("[COMP:app-web/feed-surface-cache] the sidebar post list", () => {
  const sessions: FeedPlatformSessions = [
    { assistantId: "a-1", sessions: [session("s-1", "Spring drop"), session("s-2", "Founder note")] },
  ];

  beforeEach(() => {
    // A platform-scoped route: the URL is authoritative for the platform,
    // so the panel reads the threads key synchronously.
    nav.pathname = "/w/ws-1/feed/threads/posts";
  });

  it("paints the rows from the warmed keys with both fetches pending, and never waterfalls", async () => {
    await loadSurfaceCache(feedWorkspaceCacheKey("ws-1"), async () => record());
    await loadSurfaceCache(feedSessionsCacheKey("ws-1", "threads"), async () => sessions);
    markSurfaceCacheStale("feed-workspace:ws-1");
    markSurfaceCacheStale("feed-sessions:ws-1");

    mount(<FeedSidebarPanel workspaceId="ws-1" />);

    expect(host!.textContent).toContain("Spring drop");
    expect(host!.textContent).toContain("Founder note");
    // Both revalidations started on mount - the sessions loader resolves its
    // assistant set from the record itself, not from a second effect.
    expect(loaders.workspace).toHaveBeenCalledTimes(1);
    expect(loaders.sessions).toHaveBeenCalledTimes(1);
    expect(loaders.sessions.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      platform: "threads",
      sessionsKey: "feed-sessions:ws-1:u1:threads",
      workspaceKey: "feed-workspace:ws-1:u1",
    });
  });

  it("keeps the rows on the local posts-changed mark-stale and adopts the revalidated list", async () => {
    await loadSurfaceCache(feedWorkspaceCacheKey("ws-1"), async () => record());
    await loadSurfaceCache(feedSessionsCacheKey("ws-1", "threads"), async () => sessions);
    let resolveFresh: (value: FeedPlatformSessions) => void = () => {};
    loaders.sessions.mockImplementation(
      () => new Promise<unknown>((resolve) => { resolveFresh = resolve as typeof resolveFresh; }),
    );

    mount(<FeedSidebarPanel workspaceId="ws-1" />);
    expect(host!.textContent).toContain("Spring drop");

    // What `notifyFeedPostsChanged` does: the family goes stale, nothing drops.
    act(() => {
      markSurfaceCacheStale("feed-sessions:");
    });
    expect(host!.textContent).toContain("Spring drop");
    expect(isSurfaceCacheStale(feedSessionsCacheKey("ws-1", "threads"))).toBe(true);

    await act(async () => {
      resolveFresh([{ assistantId: "a-1", sessions: [session("s-3", "Q4 teaser")] }]);
      await settle();
    });
    expect(host!.textContent).toContain("Q4 teaser");
    expect(host!.textContent).not.toContain("Spring drop");
  });
});

describe("[COMP:app-web/feed-surface-cache] the Plan month", () => {
  const month: FeedPlanMonth = { slots: [slot()], brief: null, ideas: [] };

  beforeEach(() => {
    feedWorkspace.current = record();
  });

  it("paints the calendar from the warmed month key with the fetch still pending", async () => {
    const key = feedPlanCacheKey("ws-1", "a-1", "2026-09");
    await loadSurfaceCache(key, async () => month);
    markSurfaceCacheStale(key);
    vi.useFakeTimers({ now: new Date(2026, 8, 9), toFake: ["Date"] });
    try {
      mount(<FeedPlan />);
    } finally {
      vi.useRealTimers();
    }

    expect(host!.querySelector("[data-plan-month-skeleton]")).toBeNull();
    expect(host!.textContent).toContain("Launch recap");
    expect(loaders.plan).toHaveBeenCalledWith({ assistantId: "a-1", month: "2026-09", key });
  });

  it("repaints without a blank frame on mark-stale and adopts the revalidated month", async () => {
    const key = feedPlanCacheKey("ws-1", "a-1", "2026-09");
    await loadSurfaceCache(key, async () => month);
    let resolveFresh: (value: FeedPlanMonth) => void = () => {};
    loaders.plan.mockImplementation(
      () => new Promise<unknown>((resolve) => { resolveFresh = resolve as typeof resolveFresh; }),
    );
    vi.useFakeTimers({ now: new Date(2026, 8, 9), toFake: ["Date"] });
    try {
      mount(<FeedPlan />);
    } finally {
      vi.useRealTimers();
    }
    expect(host!.textContent).toContain("Launch recap");

    act(() => {
      markSurfaceCacheStale("feed-plan:ws-1");
    });
    expect(host!.textContent).toContain("Launch recap");
    expect(host!.querySelector("[data-plan-month-skeleton]")).toBeNull();

    await act(async () => {
      resolveFresh({ slots: [slot({ id: "slot-2", title: "Retitled recap" })], brief: null, ideas: [] });
      await settle();
    });
    expect(host!.textContent).toContain("Retitled recap");
    expect(host!.textContent).not.toContain("Launch recap");
  });
});

describe("[COMP:app-web/feed-surface-cache] the disk tier", () => {
  it("keys the IndexedDB seed by viewer: another account never reads it", async () => {
    user.id = "u1";
    await writeFeedCachedJson("record:feed-workspace:ws-1", record());
    expect(idb.store.has("feed:cache:u1:record:feed-workspace:ws-1")).toBe(true);
    expect(await readFeedCachedJson<FeedWorkspaceRecord>("record:feed-workspace:ws-1")).not.toBeNull();

    user.id = "u2";
    expect(await readFeedCachedJson("record:feed-workspace:ws-1")).toBeNull();
    user.id = null;
    expect(await readFeedCachedJson("record:feed-workspace:ws-1")).toBeNull();
  });

  it("does not restore a slow disk seed after the network denies the read", async () => {
    const key="feed-collaboration:revoked";
    let diskDone!: (value:string) => void;
    const denied=new Error("access_denied");
    const request=loadSurfaceCache(key,()=>feedPaintFirst(key,
      ()=>new Promise<string>(resolve=>{diskDone=resolve;}),
      async()=>{throw denied;},
    ));
    await Promise.resolve(); await Promise.resolve();
    diskDone("protected stale draft");
    await request;
    expect(readSurfaceCache(key).data).toBeUndefined();
    expect(readSurfaceCache(key).error).toBe(denied);
  });

  it("prefers an already completed network read to a late disk seed", async () => {
    const key="feed-collaboration:fresh";
    let diskDone!: (value:string) => void;
    const request=loadSurfaceCache(key,()=>feedPaintFirst(key,
      ()=>new Promise<string>(resolve=>{diskDone=resolve;}),async()=>"current draft"));
    await Promise.resolve(); await Promise.resolve();
    diskDone("old draft");
    await request;
    expect(readSurfaceCache(key).data).toBe("current draft");
  });

  it("does not let an obsolete background response replace a newer cache entry", async () => {
    const key="feed-collaboration:newer";
    let reply!: (value:string)=>void;
    await loadSurfaceCache(key,()=>feedPaintFirst(key,async()=>"old disk",()=>new Promise<string>(resolve=>{reply=resolve;})));
    await loadSurfaceCache(key,async()=>"newer read");
    reply("obsolete response");
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(readSurfaceCache(key).data).toBe("newer read");
  });

  it("answers a cold key from disk first and lands the network value behind it", async () => {
    const key = "feed-workspace:ws-1:u1";
    let resolveNetwork: (value: string) => void = () => {};
    const network = vi.fn(
      () => new Promise<string>((resolve) => { resolveNetwork = resolve; }),
    );
    const first = await loadSurfaceCache(key, () =>
      feedPaintFirst(key, async () => "from-disk", network),
    );
    expect(first).toBe("from-disk");
    expect(readSurfaceCache<string>(key).data).toBe("from-disk");
    // The network request started with the disk read, not after it.
    expect(network).toHaveBeenCalledTimes(1);

    resolveNetwork("from-network");
    await settle();
    await vi.waitFor(() => expect(readSurfaceCache<string>(key).data).toBe("from-network"));

    // A WARM key is network-only: disk is never consulted again.
    const disk = vi.fn(async () => "stale-disk");
    network.mockImplementation(() => Promise.resolve("fresh"));
    await loadSurfaceCache(key, () => feedPaintFirst(key, disk, network));
    expect(disk).not.toHaveBeenCalled();
    expect(readSurfaceCache<string>(key).data).toBe("fresh");
  });
});
