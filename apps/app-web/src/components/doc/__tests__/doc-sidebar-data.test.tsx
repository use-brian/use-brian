// @vitest-environment jsdom
/**
 * [COMP:app-web/sidebar-data] The sidebar-data provider paints from the
 * cache (instant-navigation contract N1 / N2 / N3).
 *
 * Two slots, both built in `lib/surface-prefetch.ts`: `homeDockCacheKey`
 * (shared with the workspace root, which decides the Suggested landing off
 * it) and `sidebarTreeCacheKey` (saved + drafts + teamspaces in ONE parallel
 * fetch). The contract under test:
 *
 *  - a warmed key paints on the FIRST render with the fetch still pending -
 *    no empty tree, no `dockLoading`;
 *  - a spine mark-stale (the APPROVALS event's `home-dock:<wid>` prefix) and
 *    a user `reloadSidebar()` both revalidate BEHIND the paint: the old rows
 *    stay up until the new ones land, never a blank frame;
 *  - after a full reload (memory cold) the tree seeds from the viewer-scoped
 *    IndexedDB copy while the network revalidates;
 *  - a key miss paints an empty tree, never another workspace's rows.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: vi.fn() }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({ docPage: {} }),
  format: (s: string) => s,
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));

const listViews = vi.fn();
const listTeamspaces = vi.fn();
vi.mock("@/lib/api/views", () => ({
  listViews: (...args: unknown[]) => listViews(...args),
  createDraft: vi.fn(),
  deleteView: vi.fn(),
  getView: vi.fn(),
  renameView: vi.fn(),
  reparentView: vi.fn(),
  saveView: vi.fn(),
  setViewIcon: vi.fn(),
  unsaveView: vi.fn(),
}));
vi.mock("@/lib/api/teamspaces", () => ({
  listTeamspaces: (...args: unknown[]) => listTeamspaces(...args),
  deleteTeamspace: vi.fn(),
  removeTeamspaceMember: vi.fn(),
}));
const fetchHomeDock = vi.fn();
vi.mock("@/lib/api/home-dock", () => ({
  fetchHomeDock: (...args: unknown[]) => fetchHomeDock(...args),
}));
// Probes that must never decide the paint: park them forever. Hoisted because
// the mock factories below reference it at module-evaluation time.
const never = vi.hoisted(() => () => new Promise<never>(() => {}));
vi.mock("@/lib/api/studio", () => ({ hasAnyConnectedConnector: never }));
const getWorkspaceHomeApps = vi.fn();
vi.mock("@/lib/api/workspaces", () => ({
  getWorkspaceHomeApps: (...args: unknown[]) => getWorkspaceHomeApps(...args),
}));
vi.mock("@/lib/api/home-apps", () => ({ listCustomHomeApps: never }));
vi.mock("@/lib/api/feed", () => ({ fetchFeedTeamProfiles: never }));
vi.mock("@/lib/edition", () => ({ isHostedEdition: () => false }));
vi.mock("@/lib/doc-tabs-session", () => ({ dropPageFromDocTabsSession: vi.fn() }));
vi.mock("@/lib/offline/offline-writes", () => ({
  offlineWrite: vi.fn(),
  getOnline: () => true,
}));
const idb = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => idb.get(key) ?? null,
  idbSet: async (key: string, value: unknown) => {
    idb.set(key, value);
  },
  idbDelete: async (key: string) => {
    idb.delete(key);
  },
}));
const readCachedSidebarTree = vi.fn();
vi.mock("@/lib/offline/offline-pages", () => ({
  LOCAL_PAGES_CHANGED: "doc:local-pages-changed",
  readCachedSidebarTree: (...args: unknown[]) => readCachedSidebarTree(...args),
  sidebarCacheKey: (kind: string, wid: string) => `sidebar:${kind}:${wid}:u1`,
}));

import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";
import { applySpineEventToSurfaceCache } from "@/lib/surface-cache-invalidation";
import { loadSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { homeDockCacheKey, sidebarTreeCacheKey } from "@/lib/surface-prefetch";
import { DocSidebarDataProvider, useSidebarData } from "../doc-sidebar-data";

/** Drain the microtask + macrotask queue so an in-flight load has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Marked = { marker: string; needsYou: never[] };
const dock = (marker: string) => ({ marker, needsYou: [] }) as unknown as Marked;
const tree = (label: string) => ({
  saved: [{ id: `${label}-1`, name: `${label} page` }],
  drafts: [],
  teamspaces: [{ id: `${label}-ts`, name: `${label} space` }],
});

function Probe() {
  const {
    dock,
    dockLoading,
    saved,
    teamspaces,
    homeApps,
    homeAppsLoading,
  } = useSidebarData();
  return (
    <div>
      <span data-testid="dock">
        {dockLoading ? "loading" : dock ? `dock:${(dock as unknown as Marked).marker}` : "none"}
      </span>
      <span data-testid="saved">{saved.map((r) => r.name).join(",")}</span>
      <span data-testid="ts">{teamspaces.map((t) => t.name).join(",")}</span>
      <span data-testid="home-apps">
        {homeAppsLoading ? "loading" : homeApps.join(",")}
      </span>
    </div>
  );
}

describe("[COMP:app-web/sidebar-data] paints the dock and the tree from the cache", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetSurfaceCache();
    idb.clear();
    listViews.mockReset().mockImplementation(never);
    listTeamspaces.mockReset().mockImplementation(never);
    fetchHomeDock.mockReset().mockImplementation(never);
    getWorkspaceHomeApps.mockReset().mockImplementation(never);
    readCachedSidebarTree.mockReset().mockResolvedValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const text = (id: string) =>
    container!.querySelector(`[data-testid="${id}"]`)!.textContent;

  async function mount(workspaceId = "w1", initialHomeApps?: unknown) {
    await act(async () => {
      root!.render(
        <DocSidebarDataProvider
          workspaceId={workspaceId}
          initialHomeApps={initialHomeApps}
        >
          <Probe />
        </DocSidebarDataProvider>,
      );
      await settle();
    });
  }

  it("seeds the exact ordered Home config before background revalidation", async () => {
    await mount("w1", ["chat", "page"]);
    expect(text("home-apps")).toBe("chat,page");
    expect(getWorkspaceHomeApps).toHaveBeenCalledWith("w1");
  });

  it("settles an unseeded config read failure onto the normalized default", async () => {
    getWorkspaceHomeApps.mockRejectedValueOnce(new Error("offline"));
    await mount("w1");
    expect(text("home-apps")).toBe("chat,page,browsers");
  });

  it("first paint comes from the warmed keys with both fetches still pending", async () => {
    await loadSurfaceCache(homeDockCacheKey("w1"), async () => dock("warm"));
    await loadSurfaceCache(sidebarTreeCacheKey("w1"), async () => tree("Warm"));

    await mount();

    expect(text("dock")).toBe("dock:warm");
    expect(text("saved")).toBe("Warm page");
    expect(text("ts")).toBe("Warm space");
    // Fresh keys: nothing refetched, nothing read from disk.
    expect(fetchHomeDock).not.toHaveBeenCalled();
    expect(listViews).not.toHaveBeenCalled();
    expect(readCachedSidebarTree).not.toHaveBeenCalled();
  });

  it("the APPROVALS spine event marks the dock stale and repaints without a blank frame", async () => {
    await loadSurfaceCache(homeDockCacheKey("w1"), async () => dock("warm"));
    await loadSurfaceCache(sidebarTreeCacheKey("w1"), async () => tree("Warm"));
    await mount();
    expect(text("dock")).toBe("dock:warm");

    let release: (value: unknown) => void = () => {};
    fetchHomeDock.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    await act(async () => {
      applySpineEventToSurfaceCache(APPROVALS_REFRESH_EVENT, { workspaceId: "w1" }, "w1");
      await settle();
    });
    // Revalidating behind the paint: the old dock is still up, no "loading".
    expect(fetchHomeDock).toHaveBeenCalledTimes(1);
    expect(text("dock")).toBe("dock:warm");

    await act(async () => {
      release(dock("fresh"));
      await settle();
    });
    expect(text("dock")).toBe("dock:fresh");
  });

  it("a user reload keeps the last good tree up until the new lists land", async () => {
    await loadSurfaceCache(sidebarTreeCacheKey("w1"), async () => tree("Warm"));
    await loadSurfaceCache(homeDockCacheKey("w1"), async () => dock("warm"));

    let reload: () => void = () => {};
    function Reloader() {
      reload = useSidebarData().reloadSidebar;
      return null;
    }
    await act(async () => {
      root!.render(
        <DocSidebarDataProvider workspaceId="w1">
          <Probe />
          <Reloader />
        </DocSidebarDataProvider>,
      );
      await settle();
    });
    expect(text("saved")).toBe("Warm page");

    let releaseSaved: (rows: unknown) => void = () => {};
    listViews.mockImplementation((params: { state: string }) =>
      params.state === "saved"
        ? new Promise((resolve) => {
            releaseSaved = resolve;
          })
        : Promise.resolve([]),
    );
    listTeamspaces.mockResolvedValue([{ id: "ts", name: "Fresh space" }]);
    await act(async () => {
      reload();
      await settle();
    });
    expect(listViews).toHaveBeenCalledTimes(2);
    // Old rows stay painted while the refresh is in flight.
    expect(text("saved")).toBe("Warm page");

    await act(async () => {
      releaseSaved([{ id: "f1", name: "Fresh page" }]);
      await settle();
    });
    expect(text("saved")).toBe("Fresh page");
    expect(text("ts")).toBe("Fresh space");
    // The teamspace list was written to the viewer-scoped disk key.
    expect(idb.get("sidebar:teamspaces:w1:u1")).toEqual([{ id: "ts", name: "Fresh space" }]);
  });

  it("seeds the tree from the viewer's IndexedDB copy on a cold memory slot, then adopts the network", async () => {
    readCachedSidebarTree.mockResolvedValue(tree("Disk"));
    let releaseSaved: (rows: unknown) => void = () => {};
    listViews.mockImplementation((params: { state: string }) =>
      params.state === "saved"
        ? new Promise((resolve) => {
            releaseSaved = resolve;
          })
        : Promise.resolve([]),
    );
    listTeamspaces.mockResolvedValue([{ id: "ts", name: "Net space" }]);

    await mount();
    // The network is still pending; the disk copy is what paints.
    expect(readCachedSidebarTree).toHaveBeenCalledWith("w1");
    expect(text("saved")).toBe("Disk page");
    expect(text("ts")).toBe("Disk space");

    await act(async () => {
      releaseSaved([{ id: "n1", name: "Net page" }]);
      await settle();
    });
    expect(text("saved")).toBe("Net page");
    expect(text("ts")).toBe("Net space");
  });

  it("a cold key paints an empty tree, never another workspace's rows", async () => {
    await loadSurfaceCache(sidebarTreeCacheKey("w1"), async () => tree("W1"));
    await mount("w1");
    expect(text("saved")).toBe("W1 page");

    await mount("w2");
    expect(text("saved")).toBe("");
    expect(text("ts")).toBe("");
    expect(text("dock")).toBe("loading");
  });
});
