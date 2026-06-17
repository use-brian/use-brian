"use client";

/**
 * Persistent workspace chrome — the left sidebar + inbox flyout that wrap
 * EVERY `/w/[workspaceId]/*` surface (Brain / Studio / Workflow / Approvals /
 * Knowledge-base / the doc page tree).
 *
 * THE HOIST (docs/plans/doc-web-app-consolidation.md §4). The sidebar used
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

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  docPagePath,
  pageIdFromPathname,
  surfaceFromPathname,
} from "@/lib/doc-page-url";
import { useT } from "@/lib/i18n/client";
import { routeProgress } from "@/lib/route-progress";
import { useChatDockSuppressed } from "@/lib/chat-dock-suppress";
import { useDocChatOthersRun } from "@/lib/doc-chat-relay";
import { useOfflineSync } from "@/lib/offline/use-offline-sync";
import { cn } from "@/lib/utils";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { pickPrimaryAssistant } from "@/lib/primary-assistant";
import { CHAT_SEED_EVENT, type ChatSeed } from "@/lib/chat-seed";
import { DocSidebar } from "./doc-sidebar";
import { InboxPanel } from "./inbox-panel";
import { useSidebarData } from "./doc-sidebar-data";
import { FloatingChat } from "@/components/chrome/floating-chat";
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
  anchorBlockId?: string;
  nonce: number;
  target: "desktop" | "mobile";
};

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
  const router = useRouter();
  const pathname = usePathname();
  // The single connectivity driver for the bundled desktop app — mounted here
  // (chrome is on every surface) so the global offline flag + write-queue flush
  // run app-wide, not just on the doc page. No-op on web/thin shell.
  useOfflineSync();
  const activeSurface = surfaceFromPathname(pathname);
  // Views that embed their OWN chat (the skill editor / the skill creator's
  // doc stage) take a suppression hold — two docks never coexist on a surface.
  // The hoisted dock HIDES (not unmounts) while suppressed, so a turn that's
  // already streaming survives the suppression window.
  const dockSuppressed = useChatDockSuppressed();
  // Page-collab "another member is running on this page" guard, published by
  // `DocShell` (the only place with the page's Yjs provider); null off `/p`.
  const docOthersRun = useDocChatOthersRun();
  const {
    saved,
    drafts,
    draftPruneByid,
    busyNewDraft,
    inboxOpen,
    setInboxOpen,
    sidebarCollapsed,
    sidebarOpen,
    setSidebarOpen,
    studioSetupIncomplete,
    handleNewDraft,
    handleAddChild,
    handleSave,
    handleUnsave,
    handleRename,
    handleDuplicate,
    handleDelete,
    handleMove,
  } = useSidebarData();

  // The active page id is the canonical `/p/<pageId>` path segment — used only
  // to highlight the matching sidebar row. Pathname-derived (NOT the centre
  // pane's fetched metadata), so it's correct on every surface; `null` off `/p`.
  const activeId = activeSurface === "p" ? pageIdFromPathname(pathname) : null;

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
  const [chatAssistantId, setChatAssistantId] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    listWorkspaceAssistants(workspaceId)
      .then((list) => {
        if (cancelled) return;
        setChatAssistantId(pickPrimaryAssistant(list)?.id ?? null);
      })
      .catch(() => {
        /* no list → no dock this load; a later workspace change retries */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Chat-seed routing — the default-viewer landing's chatter / inline AI box
  // hand the user into the dock with a pre-written prompt via the
  // `doc:chat-seed` window event (lib/chat-seed.ts). We stamp a fresh nonce
  // and route it to whichever chat instance is visible at this viewport — the
  // desktop dock (lg+) or the mobile drawer — so exactly one acts on it.
  // (Moved up from `DocShell` with the dock; the publishers still fire the
  // same event from inside the page surface.)
  const [seed, setSeed] = useState<RoutedSeed | null>(null);
  const seedNonceRef = useRef(0);
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
        anchorBlockId: detail.anchorBlockId,
        nonce: seedNonceRef.current,
        target: isDesktop ? "desktop" : "mobile",
      });
    }
    window.addEventListener(CHAT_SEED_EVENT, onSeed);
    return () => window.removeEventListener(CHAT_SEED_EVENT, onSeed);
  }, []);

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
  const onDismissStudioNudge = useCallback(() => {
    setNudgeDismissed(true);
    try {
      window.localStorage.setItem(studioNudgeDismissedKey(workspaceId), "1");
    } catch {
      // Non-fatal — the nudge re-appears next session, no worse than before.
    }
  }, [workspaceId]);

  // ⌘/Ctrl+1/2/3/4 jump to Home / Brain / Studio / Workflow — preserving the web
  // PageToggle's shortcuts now that the toggle is dropped (§4). Numbered left to
  // right in toolbar order: ⌘1 is Home (the `/p` page surface), then Brain /
  // Studio / Workflow on 2 / 3 / 4. Ignored while typing in an
  // input/textarea/contenteditable so it never hijacks editor or form keystrokes;
  // Shift/Alt-modified combos are left alone too.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SURFACE_BY_KEY: Record<string, string> = {
      "1": "p",
      "2": "brain",
      "3": "studio",
      "4": "workflow",
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const surface = SURFACE_BY_KEY[e.key];
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
  }, [router, workspaceId]);

  return (
    <div className="relative flex h-full w-full overflow-hidden">
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
          "transition-[translate,width] duration-200 md:transition-[width]",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[80vw] max-md:max-w-[280px] max-md:shadow-xl",
          sidebarOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
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
          sidebarCollapsed ? "md:w-0" : "md:w-64",
        ].join(" ")}
      >
        <DocSidebar
          workspaceId={workspaceId}
          saved={saved}
          drafts={drafts}
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
          inboxOpen={inboxOpen}
          onToggleInbox={() => {
            setInboxOpen(!inboxOpen);
            // On mobile the Inbox row lives inside the open sidebar drawer;
            // close it so the flyout isn't stacked behind it.
            setSidebarOpen(false);
          }}
          activeSurface={activeSurface}
          studioNudge={studioNudge}
          onDismissStudioNudge={onDismissStudioNudge}
        />
      </div>

      {/* Inbox flyout — anchored to the right edge of the left bar; overlays the
          surface, never a standalone route. A row click soft-navigates to the
          doc page surface (and closes the panel). */}
      <InboxPanel
        open={inboxOpen}
        workspaceId={workspaceId}
        sidebarCollapsed={sidebarCollapsed}
        onClose={() => setInboxOpen(false)}
        onOpenPage={(pageId) => {
          navigateToView(pageId);
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
        className="fixed left-2 top-2 z-20 inline-flex h-9 w-9 items-center justify-center rounded-md bg-background/80 text-foreground shadow ring-1 ring-border backdrop-blur md:hidden"
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
          chrome; the sidebar is shared here. */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {children}
      </div>

      {/* The ONE assistant chat dock — mounted once for EVERY surface so a
          turn keeps streaming across tab switches and the conversation is
          unified. Desktop: bottom-right floating dock (lg+). Mobile: a FAB →
          drawer (< lg). While an embedded chat holds the suppression lock
          (skill editor / creator doc stage) the dock HIDES via `display:none`
          but stays MOUNTED, so an in-flight stream is not aborted. Renders
          only once the primary assistant resolves. */}
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
            />
          </div>
          <MobileChatDrawer
            workspaceId={workspaceId}
            assistantId={chatAssistantId}
            className="lg:hidden"
            seed={seed?.target === "mobile" ? seed : undefined}
            othersRun={docOthersRun}
          />
        </div>
      )}
    </div>
  );
}
