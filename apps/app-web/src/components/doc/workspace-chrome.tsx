"use client";

/**
 * Persistent workspace chrome — the left sidebar + inbox flyout that wrap
 * EVERY `/w/[workspaceId]/*` surface (Brain / Studio / Workflow / Approvals /
 * Knowledge-base / the doc page tree).
 *
 * THE HOIST (docs/architecture/features/doc.md §4). The sidebar used
 * to live inside `DocShell`, which only mounts on `/p` — so it was
 * doc-only chrome. This component is mounted by `/w/[workspaceId]/layout.tsx`
 * (a parent of every surface) and renders the same `DocSidebar` +
 * `InboxPanel` beside `{children}` in a flex row. `DocShell` now renders ONLY
 * the centre page + chat (no sidebar).
 *
 * Because the workspace layout persists across all `/w/[id]/*` navigation
 * (parent layouts do not remount on a child route change), the sidebar persists
 * even more robustly than before — including across surface switches, not just
 * `/p/<pageId>` switches. The data + handlers it needs live in the sibling
 * `DocSidebarDataProvider` (also mounted in the layout), so the doc `/p`
 * soft-nav behaviour (no list flash on page switch) is preserved: the lists are
 * fetched above `p/layout.tsx` and keyed on the stable route `workspaceId`.
 *
 * Navigation off the chrome (a page row, an inbox row, "New draft") soft-routes
 * to the canonical `/w/<id>/p/<pageId>` URL via `next/router`. When `DocShell`
 * is mounted (on `/p`) its URL→tabs effect adopts the change into the active
 * tab's browse history — exactly the path a floating-chat draft auto-nav already
 * takes. From a non-`/p` surface the same push lands the user on the doc page
 * surface with that page open.
 *
 * [COMP:app-web/views-shell]
 */

import { WorkspaceSearchProvider, WorkspaceSearchFallback } from "@/components/workspace-search/workspace-search-provider";
import { DesktopBrowserCoordinator } from "@/components/computer/desktop-browser-coordinator";
import { WorkspaceTopbarProvider, WorkspaceTopbarHost } from "@/components/chrome/workspace-topbar";
import { useWorkspaceSidebarResize, WorkspaceSidebarResizeHandle } from "./workspace-sidebar-resize";
import { WorkspaceThemePicker } from "./workspace-theme-picker";
import { Tooltip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DesktopUpdateChip } from "@/components/chrome/desktop-update-chip";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { RefreshCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  docPagePath,
  pageIdFromPathname,
  surfaceFromPathname,
} from "@/lib/doc-page-url";
import { useT, format } from "@/lib/i18n/client";
import { SurfaceTransition } from "@/components/chrome/surface-transition";
import { usePrimaryAssistant } from "@/contexts/primary-assistant";
import { routeProgress } from "@/lib/route-progress";
import { surfaceShortcutModifierPressed } from "@/lib/surface-shortcuts";
import {
  useChatDockSuppressed,
  workspaceChatDockSuppressed,
} from "@/lib/chat-dock-suppress";
import {
  DEFAULT_OPERATOR_APP,
  homeAppFromPathname,
  readOperatorApp,
  writeHomeAppLocation,
  writeOperatorApp,
  type HomeAppEntry,
} from "@/lib/operator-apps";
import { useDocChatOthersRun } from "@/lib/doc-chat-relay";
import { useOfflineSync } from "@/lib/offline/use-offline-sync";
import { useWorkspaceEvents } from "@/lib/workspace-events";
import { useSurfaceCacheInvalidation } from "@/lib/surface-cache-invalidation";
import { SIDEBAR_CLOSE_EVENT } from "@/lib/sidebar-close";
import { cn } from "@/lib/utils";
import { CHAT_SEED_EVENT, type ChatSeed } from "@/lib/chat-seed";
import {
  acknowledgeDesktopMessageBrian,
  desktopBridge,
  onDesktopUseBrian,
  onDesktopMessageBrian,
} from "@/lib/desktop-auth-source";
import { normalizeUseBrianPrompt } from "@/lib/siri-use-brian";
import {
  desktopTitlebarInsetCssPx,
  resolveDesktopZoomFactor,
} from "@/lib/desktop-titlebar";
import { DocSidebar, WORKSPACE_STATUS_ROW_HEIGHT_CLASS } from "./doc-sidebar";
import { InboxPanel } from "./inbox-panel";
import { WorkspaceFileDropBoundary } from "./workspace-file-drop";
import { BrainIntakeTray } from "@/components/chrome/brain-intake-tray";
import { useSidebarData } from "./doc-sidebar-data";
import {
  TeamspaceCreateDialog,
  TeamspaceSettingsModal,
  type TeamspaceSettingsTab,
} from "./teamspace-settings-modal";
import { FloatingChat } from "@/components/chrome/floating-chat";
import { FloatingRecorderHost } from "@/components/chrome/dock-recorder";
import { MobileChatDrawer } from "./mobile-chat-drawer";

/**
 * A doc chat seed (`doc:chat-seed`) routed by the chrome to one chat surface.
 * Carries a fresh `nonce` per fire so a repeated prompt re-triggers, and a
 * `target` so exactly one of the two mounted chat instances (the desktop dock
 * or the mobile drawer) acts on it. Relocated here from `DocShell` when the
 * dock was hoisted to chrome so the routing lives beside the mounts.
 */
type RoutedSeed = {
  prefill: string;
  autoSend?: boolean;
  docViewId?: string;
  model?: ChatSeed["model"];
  researchMode?: boolean;
  fileIds?: string[];
  attachedRecordingIds?: string[];
  anchorBlockId?: string;
  /** Draft-assistant pick (the landing's picker) — the dock switches its
   *  interlocutor for the seeded turn. */
  assistantId?: string;
  nonce: number;
  target: "desktop" | "mobile";
};

/**
 * The one current Home app resolved by the persistent workspace chrome.
 * Descendant surfaces consume this instead of independently re-reading the
 * sticky localStorage cache and risking a one-frame disagreement with the
 * sidebar app bar.
 */
const ActiveOperatorAppContext = createContext<HomeAppEntry | null>(null);

export function useActiveOperatorApp(): HomeAppEntry | null {
  return useContext(ActiveOperatorAppContext);
}

/** Per-workspace localStorage key for the dismissed Studio cold-start nudge. */
function studioNudgeDismissedKey(workspaceId: string): string {
  return `doc:studio-nudge-dismissed:${workspaceId}`;
}

export function WorkspaceChrome({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const t = useT().docPage;
  const sidebarResize = useWorkspaceSidebarResize();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The single connectivity driver — mounted here (chrome is on every surface)
  // so the global offline flag + write-queue flush run app-wide, not just on
  // the doc page. The collab socket signal reaches it via the module store
  // (`publishCollabConnected`, published by doc-shell).
  const offlineState = useOfflineSync();
  // The ONE workspace realtime EventSource per tab (realtime-sync). Routes
  // server change signals to per-domain CustomEvents; surfaces refetch via
  // their existing listeners. Mounted on the chrome so every surface —
  // workflow, approvals, brain, skills — stays live without its own stream.
  useWorkspaceEvents(workspaceId);
  // The ONE spine-to-cache map (instant-navigation contract N3): each domain
  // event marks the surface-cache prefixes it feeds stale, so a cached
  // surface (Tasks, CRM, Workflow, the Brain graph) repaints behind its paint
  // without carrying a listener of its own - and a task or deal an assistant
  // writes from chat reaches the OPEN list, not just the sidebar counts.
  useSurfaceCacheInvalidation(workspaceId);

  // Keep macOS native traffic lights and the zoomable web chrome in the same
  // coordinate system. The three OS buttons stay fixed when Electron's View
  // menu changes page zoom, so a static 4.75rem inset grows into a large gap at
  // high zoom and shrinks into an overlap at low zoom. The exact factor comes
  // from new preloads; outer/inner geometry covers older frameless shells.
  // WorkspaceChrome persists across every workspace surface, so one listener
  // keeps the sidebar, collapsed topbars, and mobile-menu clearance aligned.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const desktop = desktopBridge();
    if (!desktop) return;

    const root = document.documentElement;
    root.classList.add("is-canvas-desktop");
    if (desktop.platform && desktop.platform !== "darwin") {
      root.classList.add("is-canvas-desktop-standard-frame");
      // Windows draws min/max/close over the top row's right edge.
      root.classList.toggle("is-canvas-desktop-win", desktop.platform === "win32");
      root.style.removeProperty("--doc-titlebar-lights");
      return;
    }
    root.classList.remove("is-canvas-desktop-standard-frame");
    const getZoomFactor = desktop.getZoomFactor;

    function syncTitlebarInset() {
      let reported: number | undefined;
      try {
        reported = getZoomFactor?.();
      } catch {
        // A stale/partially upgraded bridge falls through to window geometry.
      }
      const zoomFactor = resolveDesktopZoomFactor(reported, {
        outerWidth: window.outerWidth,
        innerWidth: window.innerWidth,
      });
      root.style.setProperty(
        "--doc-titlebar-lights",
        `${desktopTitlebarInsetCssPx(zoomFactor)}px`,
      );
    }

    syncTitlebarInset();
    window.addEventListener("resize", syncTitlebarInset);
    window.visualViewport?.addEventListener("resize", syncTitlebarInset);
    return () => {
      window.removeEventListener("resize", syncTitlebarInset);
      window.visualViewport?.removeEventListener("resize", syncTitlebarInset);
    };
  }, []);

  const activeSurface = surfaceFromPathname(pathname);
  // Views that embed their OWN chat take a suppression hold. The full Chat app
  // is route-known and hides the dock directly: a second launcher there can
  // cover the full-page composer's Send action at narrower widths. The hoisted
  // dock HIDES (not unmounts) in both cases, so an in-flight turn survives.
  const embeddedChatSuppressed = useChatDockSuppressed();
  const [brianNearby, setBrianNearby] = useState(
    () => desktopBridge()?.isBrianNearby?.() ?? false,
  );
  const dockSuppressed = workspaceChatDockSuppressed(
    embeddedChatSuppressed,
    activeSurface,
    brianNearby,
  );

  useEffect(() => {
    const bridge = desktopBridge();
    setBrianNearby(bridge?.isBrianNearby?.() ?? false);
    return bridge?.onBrianNearbyChange?.(setBrianNearby);
  }, []);
  // Page-collab "another member is running on this page" guard, published by
  // `DocShell` (the only place with the page's Yjs provider); null off `/p`.
  const docOthersRun = useDocChatOthersRun();
  const {
    saved,
    drafts,
    teamspaces,
    draftPruneByid,
    busyNewDraft,
    inboxOpen,
    setInboxOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarOpen,
    setSidebarOpen,
    studioSetupIncomplete,
    homeApps,
    customApps,
    dock,
    reloadSidebar,
    handleNewDraft,
    handleAddChild,
    handleSave,
    handleUnsave,
    handleRename,
    handleDuplicate,
    handleDelete,
    handleMove,
    handleLeaveTeamspace,
    handleDeleteTeamspace,
  } = useSidebarData();

  // ── Teamspace dialogs (settings modal + create) ───────────────────────
  // Owned here, beside the sidebar mount: the sidebar raises intent
  // callbacks (its section `⋯` menu / the "New teamspace" affordance) and
  // stays a pure renderer. The modal resolves its teamspace FROM THE LIVE
  // LIST by id so a reload (rename, member change) refreshes it in place.
  const [teamspaceModal, setTeamspaceModal] = useState<{
    id: string;
    tab: TeamspaceSettingsTab;
  } | null>(null);
  const [createTeamspaceOpen, setCreateTeamspaceOpen] = useState(false);
  const modalTeamspace = teamspaceModal
    ? teamspaces.find((ts) => ts.id === teamspaceModal.id) ?? null
    : null;

  // The active page id is the canonical `/p/<pageId>` path segment — used only
  // to highlight the matching sidebar row. Pathname-derived (NOT the centre
  // pane's fetched metadata), so it's correct on every surface; `null` off `/p`.
  const activeId = activeSurface === "p" ? pageIdFromPathname(pathname) : null;

  // ── Drawer hygiene (responsive contract M7) ──────────────────────────────
  // Below `md` the sidebar is a drawer over the page, and every action
  // launched from inside it that opens a modal / sheet or navigates must
  // close it - otherwise the user lands on an open drawer over a dimmed page
  // and pays a backdrop tap to get back to work. Two signals cover every
  // launcher without each row having to know about the chrome:
  //  - a NAVIGATION (a page row, an operator-panel row, an app-bar icon, the
  //    top-nav icons): the URL moves, so close on any pathname / search
  //    change while the drawer is open;
  //  - a MODAL / SHEET (Settings, Invite members, the teamspace dialogs):
  //    the URL does not move, so the launcher dispatches `doc:sidebar-close`
  //    (`lib/sidebar-close.ts`) and this is the one listener.
  // `setSidebarOpen` is a plain state setter, so closing an already-closed
  // drawer is free; the effects never open it.
  const searchKey = searchParams?.toString() ?? "";
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, searchKey, setSidebarOpen]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onClose = () => setSidebarOpen(false);
    window.addEventListener(SIDEBAR_CLOSE_EVENT, onClose);
    return () => window.removeEventListener(SIDEBAR_CLOSE_EVENT, onClose);
  }, [setSidebarOpen]);

  // ── The ONE assistant chat dock, hoisted to chrome ───────────────────────
  // Mounted once here so it persists across every `/w/[id]/*` navigation: a
  // turn keeps streaming when the user switches tabs (the bug that motivated
  // the hoist), and it is one unified conversation everywhere rather than a
  // separate per-surface thread. It binds to the workspace PRIMARY assistant
  // (the user can still switch interlocutors from the dock header) and always
  // runs at `origin="doc"` — the page-capable company assistant, identical on
  // every tab. On `/p/<pageId>` it targets the open page (`docViewId`, derived
  // from the path inside `FloatingChat`); elsewhere the path has no page so the
  // next message mints a new page. See docs/architecture/features/doc.md →
  // "One dock, every surface".
  // Resolution + the live-refresh listener moved UP to
  // `PrimaryAssistantProvider` (mounted in the workspace layout) so the doc
  // surface can read the same value instead of blocking on a second identical
  // fetch of its own. Behaviour here is unchanged: no dock until it lands.
  const { assistantId: chatAssistantId } = usePrimaryAssistant();
  useEffect(() => {
    if (chatAssistantId) {
      desktopBridge()?.setCompanionContext?.(workspaceId, chatAssistantId);
    }
  }, [chatAssistantId, workspaceId]);

  // Chat-seed routing — the default-viewer landing's chatter / inline AI box
  // hand the user into the dock with a pre-written prompt via the
  // `doc:chat-seed` window event (lib/chat-seed.ts). We stamp a fresh nonce
  // and route it to whichever chat instance is visible at this viewport — the
  // desktop dock (lg+) or the mobile drawer — so exactly one acts on it.
  // (Moved up from `DocShell` with the dock; the publishers still fire the
  // same event from inside the page surface.)
  const [seed, setSeed] = useState<RoutedSeed | null>(null);
  const [messageBrianRequest, setMessageBrianRequest] = useState<{
    nonce: number;
    target: "desktop" | "mobile";
  }>();
  const pendingMessageBrianRef = useRef(false);
  const seedNonceRef = useRef(0);
  const siriUseBrianRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onSeed(e: Event) {
      const detail = (e as CustomEvent<ChatSeed>).detail;
      if (!detail || !detail.prefill.trim()) return;
      const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
      seedNonceRef.current += 1;
      setSeed({
        prefill: detail.prefill,
        autoSend: detail.autoSend,
        docViewId: detail.docViewId,
        model: detail.model,
        researchMode: detail.researchMode,
        fileIds: detail.fileIds,
        attachedRecordingIds: detail.attachedRecordingIds,
        anchorBlockId: detail.anchorBlockId,
        assistantId: detail.assistantId,
        nonce: seedNonceRef.current,
        target: isDesktop ? "desktop" : "mobile",
      });
    }
    window.addEventListener(CHAT_SEED_EVENT, onSeed);
    return () => window.removeEventListener(CHAT_SEED_EVENT, onSeed);
  }, []);

  const revealMessageBrian = useCallback(() => {
    setMessageBrianRequest((current) => ({
      nonce: (current?.nonce ?? 0) + 1,
      target: window.matchMedia("(min-width: 1024px)").matches ? "desktop" : "mobile",
    }));
  }, []);

  useEffect(() => {
    if (dockSuppressed || !pendingMessageBrianRef.current) return;
    pendingMessageBrianRef.current = false;
    revealMessageBrian();
  }, [dockSuppressed, revealMessageBrian]);

  useEffect(
    () =>
      onDesktopMessageBrian(() => {
        if (!dockSuppressed) {
          revealMessageBrian();
          return;
        }
        pendingMessageBrianRef.current = true;
        router.push(docPagePath(workspaceId));
      }),
    [dockSuppressed, revealMessageBrian, router, workspaceId],
  );

  const runNativeUseBrian = useCallback(() => {
    const prompt = normalizeUseBrianPrompt(
      desktopBridge()?.takeUseBrianPrompt?.(),
    );
    if (!prompt) return;
    const target = window.matchMedia("(min-width: 1024px)").matches
      ? "desktop"
      : "mobile";
    seedNonceRef.current += 1;
    setSeed({
      prefill: prompt,
      autoSend: true,
      nonce: seedNonceRef.current,
      target,
    });
    if (dockSuppressed) {
      pendingMessageBrianRef.current = true;
      router.push(docPagePath(workspaceId));
    } else {
      revealMessageBrian();
    }
  }, [dockSuppressed, revealMessageBrian, router, workspaceId]);

  useEffect(
    () => onDesktopUseBrian(runNativeUseBrian),
    [runNativeUseBrian],
  );

  // The native App Intent enters through `?useBrian=`. Keep the handoff in the
  // persistent chrome so the URL fallback for a cold/not-yet-loaded window and
  // the live preload wake-up share the same open-and-send behavior.
  useEffect(() => {
    const raw = searchParams.get("useBrian");
    if (raw === null) {
      siriUseBrianRef.current = null;
      return;
    }
    if (siriUseBrianRef.current === raw) return;
    siriUseBrianRef.current = raw;

    runNativeUseBrian();

    const next = new URLSearchParams(searchParams.toString());
    next.delete("useBrian");
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`);

    // HashRouter has a second, outer file query. Clear its one-shot signal too
    // so returning to the workspace picker cannot replay an old Siri request.
    if (window.location.protocol === "file:") {
      const outer = new URL(window.location.href);
      if (outer.searchParams.has("useBrian")) {
        outer.searchParams.delete("useBrian");
        window.history.replaceState(null, "", outer.toString());
      }
    }
  }, [pathname, router, runNativeUseBrian, searchParams]);

  // Soft-navigate to a page's canonical URL. On `/p` the shell's URL→tabs effect
  // adopts it into the tab history; from another surface it opens the doc
  // page surface with that page active.
  const navigateToView = useCallback(
    (id: string | null) => {
      // Button-driven nav (no `<a>` for the document click listener to catch),
      // so light the progress bar explicitly; the pathname change ends it.
      routeProgress.start();
      router.push(docPagePath(workspaceId, id ?? undefined));
    },
    [router, workspaceId],
  );

  // ── Studio cold-start nudge ───────────────────────────────────────────
  // Non-blocking: the `studioSetupIncomplete` signal is fetched once by the
  // sidebar-data provider (shared with the home checklist) and is `null` while
  // undecided → no nudge. Shows only when the workspace has zero connected
  // connectors AND the per-workspace dismissal hasn't been set.
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !workspaceId) return;
    try {
      setNudgeDismissed(
        window.localStorage.getItem(studioNudgeDismissedKey(workspaceId)) ===
          "1",
      );
    } catch {
      setNudgeDismissed(false);
    }
  }, [workspaceId]);
  const studioNudge = studioSetupIncomplete === true && !nudgeDismissed;

  // ── Active mini-app identity and per-app resume (operator-apps.ts) ─────
  // The shared provider keeps catalogue configuration and custom grants live.
  // Existing per-app resume and legacy Suggested identity remain separate
  // from the fixed Chat destination owned by Home.
  const suggestedOpen =
    activeSurface === "p" && searchParams?.get("suggested") === "1";
  const routedOperatorApp = homeAppFromPathname(activeSurface, pathname);
  useEffect(() => {
    if (suggestedOpen) return;
    // Each mini-app keeps its own validated last pathname; Home remains Chat.
    if (routedOperatorApp) {
      writeOperatorApp(workspaceId, routedOperatorApp);
      if (pathname) {
        writeHomeAppLocation(workspaceId, routedOperatorApp, pathname);
      }
    }
  }, [homeApps, pathname, routedOperatorApp, suggestedOpen, workspaceId]);
  // localStorage is client-only; render the SSR-safe default first and
  // resolve after mount (and whenever a visit updates the cache).
  const [homeApp, setHomeApp] = useState<HomeAppEntry>(DEFAULT_OPERATOR_APP);
  useEffect(() => {
    if (
      !suggestedOpen &&
      routedOperatorApp &&
      (homeApps as string[]).includes(routedOperatorApp)
    ) {
      setHomeApp(routedOperatorApp);
    } else {
      setHomeApp(readOperatorApp(workspaceId, homeApps));
    }
  }, [homeApps, routedOperatorApp, suggestedOpen, workspaceId]);
  const activeOperatorApp = suggestedOpen ? homeApp : routedOperatorApp;
  // Home is the Chat mini-app, independent of workspace curation or the last app.
  const homeHref = `/w/${workspaceId}/chat`;
  const onDismissStudioNudge = useCallback(() => {
    setNudgeDismissed(true);
    try {
      window.localStorage.setItem(studioNudgeDismissedKey(workspaceId), "1");
    } catch {
      // Non-fatal — the nudge re-appears next session, no worse than before.
    }
  }, [workspaceId]);

  // Preserve established Home / Brain / Studio / Workflow shortcuts.
  // Home is always Chat. Typing and browser-specific modifier rules remain.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Final routes (N6): `/studio` is a redirect to its first section.
    const SURFACE_BY_KEY: Record<string, string> = {
      "2": "brain",
      "3": "studio/connectors",
      "4": "workflow",
    };
    const onKey = (e: KeyboardEvent) => {
      if (!surfaceShortcutModifierPressed(e)) return;
      const surface =
        e.key === "1"
          ? homeHref.slice(`/w/${workspaceId}/`.length)
          : SURFACE_BY_KEY[e.key];
      if (!surface) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      routeProgress.start();
      router.push(`/w/${workspaceId}/${surface}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, workspaceId, homeHref]);

  const hasSyncNotice = offlineState.offline || offlineState.pending > 0 || offlineState.paused > 0 || offlineState.reconnecting;
  const syncTitle = offlineState.paused > 0 ? t.offlineSyncPausedTitle
    : offlineState.offline ? t.offlineBannerTitle
    : offlineState.reconnecting ? t.errors.collabReconnecting
    : offlineState.pending > 0 ? t.offlineSyncPendingTitle : t.offlineStatusOnline;
  const syncDescription = offlineState.paused > 0
    ? format(t.offlineSyncPausedBody, { count: offlineState.paused })
    : offlineState.pending > 0
    ? format(offlineState.offline ? t.offlineBannerPending : t.offlineSyncPendingBody, { count: offlineState.pending })
    : offlineState.offline ? t.offlineBannerBody : "";

  return (
    <div ref={sidebarResize.containerRef} style={sidebarResize.style} data-workspace-layout data-workspace-sidebar-resizing={sidebarResize.resizing || undefined} className="h-full min-h-0 w-full">
    <WorkspaceSearchProvider workspaceId={workspaceId}>
    <WorkspaceTopbarProvider onToggleSidebar={() => setSidebarCollapsed(value => !value)}>
    <WorkspaceFileDropBoundary
      workspaceId={workspaceId}
      assistantId={chatAssistantId}
      offline={offlineState.offline}
      className="workspace-window-shell relative flex h-full w-full flex-col overflow-hidden bg-sidebar-accent/40"
    >
      <DesktopBrowserCoordinator workspaceId={workspaceId} />
      <WorkspaceTopbarHost><WorkspaceSearchFallback /></WorkspaceTopbarHost>
      <div data-workspace-surfaces className="relative flex min-h-0 w-full flex-1 overflow-hidden">
        {/* Backdrop — mobile only, dismisses the drawer on tap. */}
        {sidebarOpen && (
          <button
            type="button"
            aria-label={t.sidebarCloseAria}
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-30 bg-foreground/30 backdrop-blur-[1px] md:hidden"
          />
        )}
        {/* Sidebar — drawer-style on mobile, normal flex child on md+. */}
        <div
          className={[
            "z-40 h-full shrink-0 ease-out",
            // Tailwind v4 maps translate utilities to the CSS `translate` property,
            // so the mobile drawer slide is `translate` (not `transform`). The
            // `translate` transition is SCOPED OFF desktop (`md:transition-[width]`
            // drops it): a transition declared on `translate` primes a transform
            // paint node on this wrapper even while `translate` is `none`, and ANY
            // transform on a `[data-doc-chrome]` drag-region ancestor voids the OS
            // window-drag — the other half of the `md:translate-none` fix below.
            // On desktop only `width` animates (the collapse); the drawer slide is
            // mobile-only, so nothing translate-related touches the drag ancestor there.
            sidebarResize.resizing ? "transition-none" : "transition-[translate,width] duration-200 md:transition-[width]",
            "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[80vw] max-md:max-w-[280px] max-md:shadow-xl",
            // A closed phone drawer must also leave the keyboard/a11y tree.
            sidebarOpen ? "max-md:visible max-md:translate-x-0" : "max-md:invisible max-md:-translate-x-full",
            // Desktop: clip the fixed-width inner aside to 0 when collapsed
            // (overflow-hidden keeps its content from reflowing mid-animation).
            // `md:translate-none`, NOT `md:translate-x-0`: in the Electron desktop
            // shell the sidebar's title-bar zone (workspace switcher + icon toolbar)
            // is an OS window-drag handle (`-webkit-app-region: drag`, see globals.css
            // `.is-canvas-desktop`). Chromium disables that drag for the whole subtree
            // if ANY ancestor carries a non-`none` transform — and `translate-x-0`
            // emits `translate: 0 0` (a transform node), which silently killed dragging
            // the window by that whitespace. `translate-none` clears it. No ancestor of
            // a `[data-doc-chrome]` drag region may set transform/translate/scale/rotate.
            "md:translate-none md:static md:overflow-hidden",
            sidebarCollapsed ? "md:w-14" : "md:w-[calc(3.5rem+var(--workspace-sidebar-width,14rem))]",
          ].join(" ")}
        >
          <DocSidebar
            workspaceId={workspaceId}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
            saved={saved}
            drafts={drafts}
            teamspaces={teamspaces}
            draftPruneByid={draftPruneByid}
            activeId={activeId}
            busyNewDraft={busyNewDraft}
            onSelect={(id) => {
              navigateToView(id);
              setSidebarOpen(false);
              // Opening a page gets the Inbox flyout out of the way.
              setInboxOpen(false);
            }}
            onNewDraft={handleNewDraft}
            onAddChild={handleAddChild}
            onSave={handleSave}
            onUnsave={handleUnsave}
            onRename={handleRename}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onMove={handleMove}
            // Dialogs launched from the drawer close it (M7) - same as Settings.
            onNewTeamspace={() => {
              setCreateTeamspaceOpen(true);
              setSidebarOpen(false);
            }}
            onTeamspaceSettings={(id, tab) => {
              setTeamspaceModal({ id, tab });
              setSidebarOpen(false);
            }}
            onLeaveTeamspace={handleLeaveTeamspace}
            onDeleteTeamspace={handleDeleteTeamspace}
            inboxOpen={inboxOpen}
            onToggleInbox={() => {
              setInboxOpen(!inboxOpen);
              // On mobile the Inbox row lives inside the open sidebar drawer;
              // close it so the flyout isn't stacked behind it.
              setSidebarOpen(false);
            }}
            activeSurface={activeSurface}
            activeOperatorApp={activeOperatorApp}
            suggestedOpen={suggestedOpen}
            studioNudge={studioNudge}
            onDismissStudioNudge={onDismissStudioNudge}
            homeApps={homeApps}
            customApps={customApps}
          />
        </div>

        {/* Inbox flyout — anchored to the right edge of the left bar; overlays the
            surface, never a standalone route. A row click soft-navigates to the
            doc page surface (page mention) or the Chat surface (room mention,
            T-H7 — positioned at latest; scroll-to-message is deferred) and
            closes the panel. */}
        {!sidebarCollapsed && <WorkspaceSidebarResizeHandle {...sidebarResize.handleProps} />}
        <InboxPanel
          open={inboxOpen}
          workspaceId={workspaceId}
          sidebarCollapsed={sidebarCollapsed}
          onClose={() => setInboxOpen(false)}
          onOpenPage={(pageId) => {
            navigateToView(pageId);
            setInboxOpen(false);
          }}
          onOpenRoom={(sessionId) => {
            routeProgress.start();
            router.push(`/w/${workspaceId}/chat?s=${encodeURIComponent(sessionId)}`);
            setInboxOpen(false);
          }}
        />

        {/* Mobile-only floating hamburger — top-left, opens the drawer. Always
            available so the user has a way back to the sidebar regardless of
            surface. */}
        <button
          type="button"
          aria-label={t.sidebarOpenAria}
          onClick={() => setSidebarOpen(true)}
          // data-doc-mobile-menu: in the desktop shell a narrow window drops to
          // this mobile layout, so globals.css nudges this below the traffic lights.
          data-doc-mobile-menu
          // 44px (responsive contract M3): this is the first tap of every admin
          // flow on a phone. `left-1 top-0` keeps the whole target inside the
          // `h-11` topbar row and the `w-12` spacer every surface reserves for
          // it (doc.md → "Mobile hamburger clearance").
          className="fixed left-1 top-0 z-20 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:hidden"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        {/* The surface — the doc page shell on `/p`, or a folded-in surface
            (Brain / Studio / Workflow / …) on its own route. Each owns its inner
            chrome; the sidebar (which hosts the Home operator app-bar) is
            shared here.

            `SurfaceTransition` is a plain wrapper that plays the on-brand enter
            animation when the SURFACE changes (not on `/p/<pageId>` swaps, which
            the shell handles in place). It never keys/remounts `children`, so the
            doc shell and its Yjs socket survive every switch. */}
        <ActiveOperatorAppContext.Provider value={activeOperatorApp}>
          <div data-workspace-app-frame className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:mb-2 md:mr-2 md:rounded-r-2xl md:border-y md:border-r md:border-border",
            sidebarCollapsed && "md:rounded-l-2xl md:border-l",
          )}>
            <div data-workspace-app-body className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:pt-2 [&_[data-surface-chrome-skeleton]]:hidden">
              <SurfaceTransition className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
                {children}
              </SurfaceTransition>
            </div>
          </div>
        </ActiveOperatorAppContext.Provider>

        {/* The ONE assistant chat dock — mounted once for EVERY surface so a
            turn keeps streaming across tab switches and the conversation is
            unified. Desktop: bottom-right floating dock (lg+). Mobile: a FAB →
            drawer (< lg). While an embedded chat holds the suppression lock
            (skill editor / creator doc stage) the dock HIDES via `display:none`
            but stays MOUNTED, so an in-flight stream is not aborted. Renders
            only once the primary assistant resolves. */}
        {/* Teamspace dialogs — portaled; state above, intents from the sidebar. */}
        <TeamspaceCreateDialog
          workspaceId={workspaceId}
          open={createTeamspaceOpen}
          onOpenChange={setCreateTeamspaceOpen}
          onCreated={() => reloadSidebar()}
        />
        {modalTeamspace && (
          <TeamspaceSettingsModal
            workspaceId={workspaceId}
            teamspace={modalTeamspace}
            initialTab={teamspaceModal?.tab ?? "general"}
            open
            onOpenChange={(next) => {
              if (!next) setTeamspaceModal(null);
            }}
            onChanged={reloadSidebar}
          />
        )}

        {chatAssistantId && (
          <div className={cn(dockSuppressed && "hidden")} aria-hidden={dockSuppressed}>
            <div className="hidden lg:block">
              <FloatingChat
                workspaceId={workspaceId}
                assistantId={chatAssistantId}
                mode="floating"
                origin="doc"
                seedRequest={seed?.target === "desktop" ? seed : undefined}
                othersRun={docOthersRun}
                messageBrianRequest={
                  messageBrianRequest?.target === "desktop" ? messageBrianRequest.nonce : undefined
                }
                onMessageBrianRevealed={acknowledgeDesktopMessageBrian}
              />
            </div>
            <MobileChatDrawer
              workspaceId={workspaceId}
              assistantId={chatAssistantId}
              className="lg:hidden"
              seed={seed?.target === "mobile" ? seed : undefined}
              othersRun={docOthersRun}
              messageBrianRequest={
                messageBrianRequest?.target === "mobile" ? messageBrianRequest.nonce : undefined
              }
              onMessageBrianRevealed={acknowledgeDesktopMessageBrian}
            />
          </div>
        )}
        {/* The record button outlives the dock: a surface that hides the dock
            (Chat app, Feed, Skill creator) still gets the same floating
            button bottom-right. Brian Nearby owns capture in its own window. */}
        {dockSuppressed && !brianNearby ? <FloatingRecorderHost /> : null}
      </div>
      {/* One persistent footer: theme and sync stay over the app rail even
          when the contextual panel collapses. Auxiliary activity chips extend
          beside it, outside the live region, without remounting their tray. */}
      <div
        data-workspace-footer
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 flex w-64 max-w-full flex-col items-center text-[11px] md:z-40 md:w-14",
          sidebarOpen && "z-40",
        )}
      >
        <div className={cn("pointer-events-auto flex w-full justify-center px-2", !sidebarOpen && "max-md:hidden")}>
          <WorkspaceThemePicker />
        </div>
        <div className={cn("flex w-64 max-w-[100vw] self-start items-center pb-[env(safe-area-inset-bottom)] md:w-[calc(3.5rem+var(--workspace-sidebar-width,14rem))]", WORKSPACE_STATUS_ROW_HEIGHT_CLASS)}>
          <div
            data-workspace-sync-status
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "pointer-events-auto relative z-10 min-w-0 shrink md:flex md:w-14 md:shrink-0 md:justify-center",
              !sidebarOpen && !hasSyncNotice && "max-md:hidden",
              hasSyncNotice ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
            )}
          >
            <Popover>
              <Tooltip side="right" sideOffset={4} delay={100} appearance="rail" label={<span className="block max-w-64 whitespace-normal">{syncTitle}{syncDescription ? <span className="mt-1 block">{syncDescription}</span> : null}</span>}>
                <PopoverTrigger aria-label={syncTitle} className="flex h-11 max-w-full items-center gap-2 rounded-lg px-3 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:h-7 md:w-11 md:justify-center md:px-0">
                  {offlineState.reconnecting && !offlineState.offline && offlineState.paused === 0 ? (
                    <RefreshCw aria-hidden className="size-3 shrink-0 animate-spin" />
                  ) : (
                    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", hasSyncNotice ? "bg-amber-500" : "bg-emerald-500")} />
                  )}
                  <span className="min-w-0 truncate font-medium md:sr-only">{syncTitle}</span>
                  {syncDescription ? <span className="sr-only">{syncDescription}</span> : null}
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent side="top" align="start" sideOffset={8} aria-label={syncTitle} className="w-[min(18rem,calc(100vw-1rem))] gap-1.5 text-sm">
                <p className="font-medium">{syncTitle}</p>
                {syncDescription ? <p className="text-muted-foreground">{syncDescription}</p> : null}
              </PopoverContent>
            </Popover>
          </div>
          <div data-workspace-activity-footer className="pointer-events-none flex min-w-0 items-center gap-2 px-2 [&>*]:pointer-events-auto">
            <DesktopUpdateChip />
            <BrainIntakeTray workspaceId={workspaceId} />
          </div>
        </div>
      </div>
    </WorkspaceFileDropBoundary>
    </WorkspaceTopbarProvider>
    </WorkspaceSearchProvider>
    </div>
  );
}
