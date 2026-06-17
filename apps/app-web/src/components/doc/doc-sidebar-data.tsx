"use client";

/**
 * Workspace-wide sidebar data + page-mutation handlers — the seam that makes
 * the Doc sidebar PERSISTENT across every `/w/[workspaceId]/*` surface
 * (Brain / Studio / Workflow / Approvals / Knowledge-base / the doc page
 * tree), not just `/p`.
 *
 * THE HOIST (docs/plans/doc-web-app-consolidation.md §4 chrome). Before this
 * provider, the sidebar lists (`saved` / `drafts` / `recents` / `draftPruneByid`
 * / inbox state) and the page-mutation handlers (save / unsave / delete /
 * rename / duplicate / reparent / add-child / new-draft / set-icon) all lived
 * inside `DocShell`, which only mounts on `/p`. That made the sidebar a
 * doc-only chrome. Lifting the data + handlers up here — mounted by the
 * `/w/[workspaceId]` layout (a parent of every surface) — lets `WorkspaceChrome`
 * render the same sidebar above every surface while `DocShell` keeps owning
 * only the centre page + chat.
 *
 * Why a PROVIDER, not sibling props: the handlers and `DocShell` share a lot
 * of state (the lists, `draftPruneByid`, `reloadSidebar`). A context keeps them
 * the same closures/objects (no prop-drilling explosion) and — crucially —
 * preserves the doc `/p` soft-nav: this provider lives ABOVE `p/layout.tsx`,
 * so it never remounts on a `/p/<pageId>` change and its fetch keys on the
 * stable route `workspaceId`. The lists therefore never flash empty on a page
 * switch (the load-bearing behaviour `p/layout.tsx` documents).
 *
 * THE ACTIVE-PAGE BRIDGE. Several handlers optimistically patch the CENTRE
 * pane's open page (`setActiveView`) or its tab browse-history
 * (`dropFromTabs` / `navigate`) — state that still lives in `DocShell`, only
 * mounted on `/p`. `DocShell` registers an `ActivePageBridge` on mount; the
 * handlers call through it and **no-op the optimistic part off `/p`** (where
 * there is no open page), falling back to `reloadSidebar` which always runs.
 * This mirrors the codebase's existing "latest callback ref" pattern
 * (`buildPageRef` in `doc-shell.tsx`). `tsc` cannot verify the runtime wiring
 * of this bridge — it is the primary browser-QA item for this change.
 *
 * THE COLD-START SIGNAL. The provider also fires the connectors probe ONCE per
 * workspace (`hasAnyConnectedConnector`, non-blocking) and exposes the result as
 * `studioSetupIncomplete: boolean | null`. Both the sidebar's Studio "Set up"
 * nudge (`WorkspaceChrome`) and the home setup-checklist (`EmptyPageLanding`,
 * via `DocShell`) read this one signal, so the workspace has a single source
 * of truth for "is setup incomplete" rather than two competing fetches.
 *
 * [COMP:app-web/sidebar-data]
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { useT, format } from "@/lib/i18n/client";
import {
  createDraft,
  deleteView,
  getView,
  listViews,
  renameView,
  reparentView,
  saveView,
  setViewIcon,
  unsaveView,
  type ViewListRow,
  type ViewMetadata,
} from "@/lib/api/views";
import { hasAnyConnectedConnector } from "@/lib/api/studio";
import { isDesktopAuth } from "@/lib/desktop-auth-source";
import { idbGet, idbSet } from "@/lib/offline/idb";
import { offlineWrite, getOnline } from "@/lib/offline/offline-writes";
import type { SidebarMove } from "./doc-sidebar";

/** localStorage key for the per-workspace recently-opened page list. */
function recentsKey(workspaceId: string): string {
  return `doc:recents:${workspaceId}`;
}

/** How many recent ids we retain in storage; the sidebar shows fewer. */
const RECENTS_STORAGE_CAP = 8;
/** How many recent rows the sidebar renders (excludes the active page). */
const RECENTS_VISIBLE_CAP = 5;

/**
 * The slice of CENTRE-pane state the handlers need to keep optimistically in
 * sync. `DocShell` registers this on mount; it is `null` on every non-`/p`
 * surface, where the optimistic part is skipped (a `reloadSidebar` covers it).
 */
export type ActivePageBridge = {
  /** The page currently open in the centre pane, or null. */
  getActiveView: () => ViewMetadata | null;
  /** Optimistically replace / patch the centre pane's open page metadata. */
  setActiveView: (
    updater: ViewMetadata | null | ((v: ViewMetadata | null) => ViewMetadata | null),
  ) => void;
  /** Drop a deleted page from every tab's browse history. */
  dropFromTabs: (id: string) => void;
  /** Open a page in the active tab (push onto its history), or blank it. */
  navigate: (id: string | null) => void;
  /**
   * Latch a just-created draft so the centre pane paints its "what do you want
   * to see?" landing instantly through the create → navigate → sync window
   * (no editor-skeleton flash). No-op off `/p` — a fresh navigation mounts the
   * shell anew and the placeholder gate covers it.
   */
  latchNewDraft: (id: string) => void;
};

type SidebarData = {
  workspaceId: string;
  saved: ViewListRow[];
  drafts: ViewListRow[];
  draftPruneByid: Record<string, string | null>;
  /** The most-recently-opened saved cards (recents, falling back to freshest). */
  landingCards: ViewListRow[];
  busyNewDraft: boolean;
  topError: string | null;
  setTopError: (msg: string | null) => void;
  inboxOpen: boolean;
  setInboxOpen: (open: boolean) => void;
  /**
   * Desktop sidebar collapse (Notion's panel toggle). Owned here because the
   * sidebar lives in `WorkspaceChrome` (the layout) while the toggle button
   * lives in `DocShell`'s top bar (the centre pane) — both read/drive it.
   */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (next: boolean | ((v: boolean) => boolean)) => void;
  /** Mobile drawer open state (the `< md` slide-in). */
  sidebarOpen: boolean;
  setSidebarOpen: (next: boolean) => void;
  /**
   * Cold-start signal: whether the workspace has ZERO connected connectors
   * (≈ setup incomplete). `null` while the (non-blocking) probe is in flight or
   * failed, so no consumer ever *shows* a setup affordance to an already-set-up
   * user. The single fetch path lives here so both the sidebar's Studio nudge
   * (`WorkspaceChrome`) and the home checklist (`EmptyPageLanding`) read the
   * same signal — no second connectors fetch.
   */
  studioSetupIncomplete: boolean | null;
  /** Refetch both sidebar lists. Centre-pane mutations route through here too. */
  reloadSidebar: () => void;
  /** Record the open of a page id into the recents list (+ localStorage). */
  pushRecent: (id: string) => void;
  /** Record a draft's `autoPruneAt` for sidebar caption rendering (the list
   *  endpoint omits it; `DocShell`'s `getView` is the other producer). */
  recordPrune: (id: string, autoPruneAt: string | null) => void;
  /** `DocShell` registers the centre-pane bridge on mount; null off `/p`. */
  registerActivePageBridge: (bridge: ActivePageBridge) => () => void;
  // Mutation handlers (raised by the sidebar + page header). Each commits to
  // the API, refreshes the lists, and — when a page is open — keeps the centre
  // pane in sync through the active-page bridge.
  handleNewDraft: () => Promise<void>;
  handleAddChild: (parentId: string) => Promise<void>;
  handleSave: (id: string) => Promise<void>;
  handleUnsave: (id: string) => Promise<void>;
  handleRename: (id: string) => Promise<void>;
  handleRenameValue: (id: string, name: string) => Promise<void>;
  handleDuplicate: (id: string) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleMove: (move: SidebarMove) => Promise<void>;
  handleSetIcon: (id: string, icon: string | null) => Promise<void>;
};

const SidebarDataContext = createContext<SidebarData | null>(null);

export function useSidebarData(): SidebarData {
  const ctx = useContext(SidebarDataContext);
  if (!ctx) {
    throw new Error(
      "useSidebarData must be used within a <DocSidebarDataProvider>",
    );
  }
  return ctx;
}

export function DocSidebarDataProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const t = useT().docPage;

  const [saved, setSaved] = useState<ViewListRow[]>([]);
  const [drafts, setDrafts] = useState<ViewListRow[]>([]);
  const [draftPruneByid, setDraftPruneByid] = useState<
    Record<string, string | null>
  >({});
  const [busyNewDraft, setBusyNewDraft] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  // Session-scoped chrome state (resets on a hard reload, like the tabs).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Cold-start signal (single connectors probe, non-blocking) ─────────
  // `null` while undecided (no fetch back / failed) → no setup affordance.
  // Both the Studio sidebar nudge and the home checklist read this; the
  // probe is fired ONCE here per workspace instead of in each consumer.
  // Connecting a connector navigates away + back, remounting this provider's
  // effect, so the signal clears without a manual event bus.
  const [studioSetupIncomplete, setStudioSetupIncomplete] = useState<
    boolean | null
  >(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setStudioSetupIncomplete(null);
    hasAnyConnectedConnector()
      .then((connected) => {
        if (!cancelled) setStudioSetupIncomplete(!connected);
      })
      .catch(() => {
        // Defensive: a failed probe never *shows* a setup affordance.
        if (!cancelled) setStudioSetupIncomplete(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // ── The centre-pane bridge (registered by DocShell on /p) ──────────
  const bridgeRef = useRef<ActivePageBridge | null>(null);
  const registerActivePageBridge = useCallback((bridge: ActivePageBridge) => {
    bridgeRef.current = bridge;
    return () => {
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
  }, []);
  // Optimistically patch the open page IF one is mounted (on /p). A no-op
  // elsewhere — the `reloadSidebar` each handler also fires covers the lists.
  const patchActiveView = useCallback(
    (
      id: string,
      updater: (v: ViewMetadata) => ViewMetadata,
    ) => {
      const b = bridgeRef.current;
      if (!b) return;
      b.setActiveView((v) => (v && v.id === id ? updater(v) : v));
    },
    [],
  );
  const recordPrune = useCallback((id: string, autoPruneAt: string | null) => {
    setDraftPruneByid((prev) => ({ ...prev, [id]: autoPruneAt }));
  }, []);

  // ── Recents (localStorage, per workspace) ─────────────────────────────
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !workspaceId) return;
    try {
      const raw = window.localStorage.getItem(recentsKey(workspaceId));
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      setRecentIds(
        Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === "string")
          : [],
      );
    } catch {
      setRecentIds([]);
    }
  }, [workspaceId]);

  const pushRecent = useCallback(
    (id: string) => {
      if (typeof window === "undefined" || !workspaceId || !id) return;
      setRecentIds((prev) => {
        const next = [id, ...prev.filter((x) => x !== id)].slice(
          0,
          RECENTS_STORAGE_CAP,
        );
        try {
          window.localStorage.setItem(
            recentsKey(workspaceId),
            JSON.stringify(next),
          );
        } catch {
          // Non-fatal — recents are a convenience, not load-bearing.
        }
        return next;
      });
    },
    [workspaceId],
  );

  // ── Sidebar list fetch — re-runs on workspace change + manual bump ────
  const [reloadTick, setReloadTick] = useState(0);
  const reloadSidebar = useCallback(() => setReloadTick((n) => n + 1), []);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    // Bundled desktop only (gated): stale-while-revalidate the page tree through
    // IndexedDB so the sidebar renders offline. Seed from cache immediately, then
    // fetch; on success refresh the cache; on failure (offline) keep the stale
    // tree instead of surfacing a hard error. Web + thin shell skip all of this.
    const bundled = isDesktopAuth();
    const savedKey = `sidebar:saved:${workspaceId}`;
    const draftKey = `sidebar:drafts:${workspaceId}`;
    if (bundled) {
      void Promise.all([
        idbGet<ViewListRow[]>(savedKey),
        idbGet<ViewListRow[]>(draftKey),
      ]).then(([cs, cd]) => {
        if (cancelled) return;
        if (cs) setSaved(cs);
        if (cd) setDrafts(cd);
      });
    }

    Promise.all([
      listViews({ workspaceId, state: "saved" }),
      listViews({ workspaceId, state: "draft" }),
    ])
      .then(([s, d]) => {
        if (cancelled) return;
        setSaved(s);
        setDrafts(d);
        if (bundled) {
          void idbSet(savedKey, s);
          void idbSet(draftKey, d);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Offline in the bundled app: keep the cache-seeded tree, stay quiet.
        if (bundled) return;
        const message = err instanceof Error ? err.message : String(err);
        setTopError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadTick]);

  // Floating-chat bridge: a chat turn that persists a draft fires
  // `doc:draft-created`; refresh the lists so the new draft surfaces
  // immediately (mirrors the old shell-owned listener).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => reloadSidebar();
    window.addEventListener("doc:draft-created", handler);
    return () => window.removeEventListener("doc:draft-created", handler);
  }, [reloadSidebar]);

  // ── Navigation helper through the bridge (no-op off /p) ───────────────
  const navigate = useCallback((id: string | null) => {
    if (id) pushRecent(id);
    bridgeRef.current?.navigate(id);
  }, [pushRecent]);

  // ── Mutation handlers ─────────────────────────────────────────────────
  const handleNewDraft = useCallback(async () => {
    if (!getOnline()) return; // not supported offline — the create button is disabled too
    setBusyNewDraft(true);
    setTopError(null);
    try {
      const created = await createDraft({ workspaceId });
      reloadSidebar();
      recordPrune(created.id, created.autoPruneAt);
      bridgeRef.current?.latchNewDraft(created.id);
      navigate(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.createDraftFailed, { message }));
    } finally {
      setBusyNewDraft(false);
    }
  }, [workspaceId, reloadSidebar, recordPrune, navigate, t]);

  const handleAddChild = useCallback(
    async (parentId: string) => {
      if (!getOnline()) return; // not supported offline
      setTopError(null);
      try {
        const created = await createDraft({ workspaceId, nestParentId: parentId });
        reloadSidebar();
        recordPrune(created.id, created.autoPruneAt);
        bridgeRef.current?.latchNewDraft(created.id);
        navigate(created.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.createDraftFailed, { message }));
      }
    },
    [workspaceId, reloadSidebar, recordPrune, navigate, t],
  );

  const handleSave = useCallback(
    async (id: string) => {
      if (!getOnline()) return; // not supported offline
      try {
        const updated = await saveView(id);
        patchActiveView(id, () => updated);
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.saveFailed, { message }));
      }
    },
    [patchActiveView, reloadSidebar, t],
  );

  const handleUnsave = useCallback(
    async (id: string) => {
      if (!getOnline()) return; // not supported offline
      try {
        const updated = await unsaveView(id);
        patchActiveView(id, () => updated);
        if (updated.state === "draft") recordPrune(updated.id, updated.autoPruneAt);
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.unsaveFailed, { message }));
      }
    },
    [patchActiveView, recordPrune, reloadSidebar, t],
  );

  const handleRename = useCallback(
    async (id: string) => {
      const active = bridgeRef.current?.getActiveView() ?? null;
      const current =
        active?.id === id
          ? active.name
          : (saved.find((r) => r.id === id) ?? drafts.find((r) => r.id === id))
              ?.name ?? "";
      const next = await promptDialog({
        title: t.sidebarRowRename,
        defaultValue: current,
        confirmLabel: t.sidebarRowRename,
        cancelLabel: t.cancel,
      });
      if (next === null || next === current) return;
      try {
        await offlineWrite({
          kind: "view.rename",
          coalesceKey: `view.rename:${id}`,
          payload: { id, name: next },
          exec: () => renameView(id, next),
          onResult: (updated) => patchActiveView(id, () => updated),
          optimistic: () => patchActiveView(id, (v) => ({ ...v, name: next })),
        });
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.saveFailed, { message }));
      }
    },
    [saved, drafts, patchActiveView, reloadSidebar, t],
  );

  const handleRenameValue = useCallback(
    async (id: string, name: string) => {
      setTopError(null);
      try {
        await offlineWrite({
          kind: "view.rename",
          coalesceKey: `view.rename:${id}`,
          payload: { id, name },
          exec: () => renameView(id, name),
          onResult: (updated) => patchActiveView(id, () => updated),
          optimistic: () => patchActiveView(id, (v) => ({ ...v, name })),
        });
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.saveFailed, { message }));
      }
    },
    [patchActiveView, reloadSidebar, t],
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      if (!getOnline()) return; // not supported offline
      setTopError(null);
      try {
        const active = bridgeRef.current?.getActiveView() ?? null;
        const source = active?.id === id ? active : await getView(id);
        const created = await createDraft({
          workspaceId,
          name: source.name,
          nestParentId: source.nestParentId,
        });
        reloadSidebar();
        recordPrune(created.id, created.autoPruneAt);
        navigate(created.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.createDraftFailed, { message }));
      }
    },
    [workspaceId, reloadSidebar, recordPrune, navigate, t],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!getOnline()) return; // not supported offline — don't even prompt
      const ok = await confirmDialog({
        title: t.deleteConfirmTitle,
        description: t.deleteConfirm,
        confirmLabel: t.deleteConfirmAction,
        cancelLabel: t.cancel,
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await deleteView(id);
        // Scrub the deleted page from every tab's history + clear it from the
        // centre pane if it was open (both no-op off /p).
        const b = bridgeRef.current;
        if (b) {
          b.dropFromTabs(id);
          b.setActiveView((v) => (v && v.id === id ? null : v));
        }
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.saveFailed, { message }));
      }
    },
    [reloadSidebar, t],
  );

  const handleMove = useCallback(
    async (move: SidebarMove) => {
      if (!getOnline()) return; // reparent not supported offline
      setTopError(null);
      try {
        const updated = await reparentView(move.viewId, {
          nestParentId: move.nestParentId,
          position: move.position,
        });
        patchActiveView(move.viewId, () => updated);
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.saveFailed, { message }));
      }
    },
    [patchActiveView, reloadSidebar, t],
  );

  const handleSetIcon = useCallback(
    async (id: string, icon: string | null) => {
      setTopError(null);
      try {
        await offlineWrite({
          kind: "view.icon",
          coalesceKey: `view.icon:${id}`,
          payload: { id, icon },
          exec: () => setViewIcon(id, icon),
          onResult: (updated) => patchActiveView(id, () => updated),
          optimistic: () => patchActiveView(id, (v) => ({ ...v, icon })),
        });
        reloadSidebar();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTopError(format(t.saveFailed, { message }));
      }
    },
    [patchActiveView, reloadSidebar, t],
  );

  // ── Derived: recents → home landing cards ─────────────────────────────
  // Walk the stored id order (most recent first), keep only saved rows that
  // still exist, drop the active page, and cap. Drafts are excluded — this
  // mirrors Favorites' saved-page scope, not the scratch space. The sidebar
  // no longer renders a Recents section; this now feeds `landingCards` (the
  // home "recently opened" cards) only.
  const recents = useMemo(() => {
    const activeId = bridgeRef.current?.getActiveView()?.id ?? null;
    const byId = new Map(saved.map((r) => [r.id, r] as const));
    const out: ViewListRow[] = [];
    for (const id of recentIds) {
      if (id === activeId) continue;
      const row = byId.get(id);
      if (row) out.push(row);
      if (out.length >= RECENTS_VISIBLE_CAP) break;
    }
    return out;
    // `recentIds` + `saved` are the real inputs; the active-page exclusion is a
    // best-effort read off the bridge (recomputed whenever the lists change).
  }, [recentIds, saved]);

  const landingCards = useMemo(
    () => (recents.length > 0 ? recents : saved.slice(0, RECENTS_VISIBLE_CAP)),
    [recents, saved],
  );

  const value = useMemo<SidebarData>(
    () => ({
      workspaceId,
      saved,
      drafts,
      draftPruneByid,
      landingCards,
      busyNewDraft,
      topError,
      setTopError,
      inboxOpen,
      setInboxOpen,
      sidebarCollapsed,
      setSidebarCollapsed,
      sidebarOpen,
      setSidebarOpen,
      studioSetupIncomplete,
      reloadSidebar,
      pushRecent,
      recordPrune,
      registerActivePageBridge,
      handleNewDraft,
      handleAddChild,
      handleSave,
      handleUnsave,
      handleRename,
      handleRenameValue,
      handleDuplicate,
      handleDelete,
      handleMove,
      handleSetIcon,
    }),
    [
      workspaceId,
      saved,
      drafts,
      draftPruneByid,
      landingCards,
      busyNewDraft,
      topError,
      inboxOpen,
      sidebarCollapsed,
      sidebarOpen,
      studioSetupIncomplete,
      reloadSidebar,
      pushRecent,
      recordPrune,
      registerActivePageBridge,
      handleNewDraft,
      handleAddChild,
      handleSave,
      handleUnsave,
      handleRename,
      handleRenameValue,
      handleDuplicate,
      handleDelete,
      handleMove,
      handleSetIcon,
    ],
  );

  return (
    <SidebarDataContext.Provider value={value}>
      {children}
    </SidebarDataContext.Provider>
  );
}
