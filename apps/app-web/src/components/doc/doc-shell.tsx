"use client";

/**
 * Doc centre pane + chat — the `/p` surface body.
 *
 *   ┌─ (sidebar lives in WorkspaceChrome) ─┬─ Active page (PageHeader + Editor) ─┐
 *   │  hoisted up to the workspace layout   │  Empty selection state OR loaded   │
 *   └───────────────────────────────────────┴────────────────────────────────────┘
 *
 * THE HOIST (docs/architecture/features/doc.md §4). The sidebar +
 * inbox flyout used to live HERE, which made them doc-only chrome. They are
 * now hoisted into `WorkspaceChrome` (mounted by `/w/[workspaceId]/layout.tsx`),
 * so the sidebar is PERSISTENT across every surface. The sidebar data + the
 * page-mutation handlers live in the sibling `DocSidebarDataProvider`; this
 * shell reads them through `useSidebarData()` and registers an
 * `ActivePageBridge` so those handlers can keep the centre pane in sync
 * (optimistic `setActiveView`, tab-history scrub) while it's mounted.
 *
 * What this shell still owns (the centre pane, soft-nav-critical — UNCHANGED):
 *  - The active view's metadata (`activeView`) + the live Yjs `collab` keyed on
 *    the URL page id, dialed in parallel with the metadata fetch.
 *  - The tab strip + per-tab browse history (`doc-tabs.ts`) and the two
 *    URL↔tabs reconciliation effects that make `/p/<pageId>` switching a soft
 *    swap (no remount, no list flash — see `p/layout.tsx`).
 *  - The draft landing / build flow, the floating + mobile chat docks.
 *
 * Selecting a sidebar row writes the canonical `/p/<pageId>` URL (the chrome
 * does the `router.push`); the URL→tabs effect below adopts it into the active
 * tab. (Writing the legacy `/doc?viewId=` URL would hit the proxy's 301 →
 * `/p/<id>` and bounce through a full reload — the "draft won't open" bug.)
 *
 * Spec: docs/architecture/features/views.md § Phase 1 → Full-screen UI;
 *       docs/architecture/features/doc.md §4.
 *
 * [COMP:app-web/views-shell]
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  docEntryPath,
  isCaptureRequest,
  pageIdFromPathname,
  panelFromSearch,
  panelFromTabEntry,
  panelTabEntry,
  type PanelId,
} from "@/lib/doc-page-url";
import {
  activePageId,
  back,
  blankActiveTab,
  canGoBack,
  canGoForward,
  closeTab,
  dropPage,
  forward,
  initTabs,
  newTab,
  openPage,
  switchTab,
  tabPageId,
  type TabsState,
} from "@/lib/doc-tabs";
import {
  createDraft,
  commitPageCreatedEvent,
  derivePageIcon,
  getView,
  deleteView,
  setViewClearance,
  setViewFullWidth,
  setPageLinkedRecording,
  listCustomPageTemplates,
  getCustomPageTemplate,
  deleteCustomPageTemplate,
  createCustomPageTemplate,
  type NameOrigin,
  type ViewMetadata,
} from "@/lib/api/views";
import { getUserInfo } from "@/lib/user";
import { buildBreadcrumb } from "@/lib/sidebar-tree";
import { useT, format } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useSidebarData, type ActivePageBridge } from "./doc-sidebar-data";
import { DocTopBar, type TabView } from "./doc-topbar";
import { PageHeader } from "./page-header";
import { PageTitle } from "./page-title";
import { CollabPageEditor } from "./collab-page-editor";
import { RecordingPlayerProvider } from "@/lib/recordings/recording-player-context";
import { RecordingChrome } from "@/components/recordings/recording-chrome";
import { RecordingLinkControl } from "@/components/recordings/recording-link-control";
import { recordingIdFromAnchorKey } from "@/lib/recordings/anchor";
import { commentGutterWidth } from "./comment-rail";
import { useCollabProvider } from "@/lib/collab/use-collab-provider";
import { usePublishPresenceActivity } from "@/lib/collab/use-presence";
import { useAssistantRun } from "@/lib/collab/use-assistant-run";
import { AssistantRunClaw } from "./assistant-run-claw";
import { isYFragmentEmpty } from "@/lib/collab/doc-empty";
import {
  FRAGMENT_FIELD,
  instantiatePageTemplate,
  withFreshBlockIds,
  yDocToSnapshot,
  type CustomPageTemplateSummary,
} from "@use-brian/doc-model";
import { EmptyPageLanding } from "./empty-page-landing";
import { TemplateGallery } from "./template-gallery";
import { SaveAsTemplateDialog, type SaveAsTemplateInput } from "./save-as-template-dialog";
import { templateExtractionFromBlocks } from "@/lib/blueprints";
import { SuggestedView } from "./suggested-view";
import { ApprovalsPanel } from "./panels/approvals-panel";
import { AutopilotPanel } from "./panels/autopilot-panel";
import { RecordingsPanel } from "./panels/recordings-panel";
import { requestChatSeed, type ChatSeed } from "@/lib/chat-seed";
import { docChatRelay } from "@/lib/doc-chat-relay";
import { isAuthRedirectInFlight } from "@/lib/auth-fetch";
import {
  clearPendingBuild,
  stashPendingBuild,
  takePendingBuild,
} from "@/lib/pending-build";
import { PageBuildIndicator } from "./page-build-indicator";
import { subscribeBuildActivity } from "@/lib/build-activity";
import { offlineWrite } from "@/lib/offline/offline-writes";
import {
  useIsOffline,
  usePendingWrites,
  publishCollabConnected,
} from "@/lib/offline/use-offline-sync";

type ShellProps = {
  workspaceId: string;
  /**
   * Optional default doc assistant ID, forwarded to the centre-pane
   * `<CollabPageEditor>` for its on-page build / run affordances. The chat
   * dock is no longer mounted here — it lives once in `WorkspaceChrome` and
   * resolves the primary assistant itself.
   */
  assistantId?: string;
};

// Debounce windows for committing a freshly-created draft's deferred `created`
// page-event (migration 283). A blank page settles fast; a from-template page
// waits longer because there are more fields to fill before it's "real". A
// navigate-away / tab-hide flush fires immediately regardless of these.
const CREATED_COMMIT_BLANK_MS = 5_000;
const CREATED_COMMIT_TEMPLATE_MS = 15_000;

export function DocShell({ workspaceId, assistantId }: ShellProps) {
  // `assistantId` is forwarded to `<CollabPageEditor>` (the centre pane). The
  // assistant chat dock is mounted in `WorkspaceChrome`, not here.
  const t = useT().docPage;
  const workspace = useWorkspaceContext();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The active page id is the canonical `/p/<pageId>` path segment — NOT a
  // `?viewId=` query. The shell is mounted at `/w/<id>/p`, and the proxy
  // 301-redirects the legacy `/doc?viewId=` form to `/p/<id>`, so writing
  // a query URL would bounce through a hard redirect and drop the selection.
  const urlViewId = pageIdFromPathname(pathname);
  // A panel tab (Approvals / Autopilot) rides on `/p?panel=<id>` — the pane
  // renders the panel instead of a page, keeping the tab strip + sidebar. A
  // panel URL never has a `[pageId]` segment, so `urlViewId` is null here.
  const urlPanel = panelFromSearch(searchParams?.toString());
  // The single "what does the active tab point at" value the tab strip mirrors:
  // a panel entry (`panel:<id>`), a page id, or null (the Suggested-for-you
  // home). Page id and panel are mutually exclusive by construction.
  const urlEntry = urlPanel ? panelTabEntry(urlPanel) : urlViewId;

  // Sidebar lists + page-mutation handlers live in the hoisted provider
  // (`DocSidebarDataProvider`, mounted by the workspace layout). The centre
  // pane reads the lists for the breadcrumb / tab labels / landing cards, and
  // routes its own mutations (build / start-blank / auto-title) through the
  // shared `reloadSidebar` + `recordPrune` so the sidebar stays in step.
  const sidebar = useSidebarData();
  const {
    saved,
    drafts,
    landingCards,
    reloadSidebar,
    pushRecent,
    recordPrune,
    setTopError: setSidebarTopError,
    registerActivePageBridge,
    sidebarCollapsed,
    setSidebarCollapsed,
    studioSetupIncomplete,
  } = sidebar;

  const [activeView, setActiveView] = useState<ViewMetadata | null>(null);
  // Latest `activeView`, read by the active-page bridge's `getActiveView` so the
  // provider's handlers see the live open page without re-registering the bridge.
  const activeViewRef = useRef<ViewMetadata | null>(null);
  activeViewRef.current = activeView;
  // One Yjs/Hocuspocus connection for the active page, owned here at the shell
  // level (lifted out of CollabPageEditor) and passed to the editor. Keyed on
  // the URL page id — known the instant a sidebar row is clicked — NOT on
  // `activeView?.id`, which only resolves after the `getView` metadata fetch.
  // Keying on the URL dials the socket in PARALLEL with that fetch (the new
  // page's body starts syncing while its metadata loads) instead of serializing
  // behind it; the hook reconnects on change and holds no socket when null (the
  // empty-selection state).
  const collab = useCollabProvider(urlViewId);

  // Publish this tab's "actively viewing" flag into awareness so peers dim our
  // face-pile avatar when we background the tab / switch apps. One mount per
  // provider, beside the provider it writes to.
  usePublishPresenceActivity(collab.provider);

  // Live "an assistant is working on this page" state (any member, any channel),
  // read off the same awareness as the face-pile. Drives the ambient working
  // claw + status pill, and the chat composer's double-text guard below.
  const assistantRun = useAssistantRun(collab.provider);

  // Feed the collab socket into the global connectivity classifier: a live doc
  // losing its sync socket flips the app to "degraded" (Offline pill; metadata
  // writes queue) even while `navigator.onLine` stays true. "connecting"
  // counts as up so the initial dial doesn't flash the pill; reset on unmount
  // so a closed doc doesn't pin the app degraded.
  useEffect(() => {
    publishCollabConnected(collab.status !== "disconnected");
    return () => publishCollabConnected(true);
  }, [collab.status]);

  // App-level offline state, read from the global signal (the single driver
  // lives in WorkspaceChrome).
  const offline = useIsOffline();
  const pendingWrites = usePendingWrites();

  // Whether the active page's body is empty, recomputed live off the synced Yjs
  // doc. Gates the draft landing (alongside the placeholder title): a fresh
  // draft is the "what do you want to see?" surface only while it has no content
  // — the instant a build (the landing prompt, or a corner-chat turn) adds a
  // block, the editor takes over, so nothing is ever stranded behind the prompt.
  const [docEmpty, setDocEmpty] = useState(false);
  useEffect(() => {
    const doc = collab.doc;
    if (!doc || !collab.synced) {
      setDocEmpty(false);
      return;
    }
    const frag = doc.getXmlFragment(FRAGMENT_FIELD);
    const recompute = () => setDocEmpty(isYFragmentEmpty(frag));
    recompute();
    frag.observeDeep(recompute);
    return () => frag.unobserveDeep(recompute);
  }, [collab.doc, collab.synced]);

  // The just-created draft (set by "+ New draft" / add-child). It forces the
  // landing through the create → navigate → sync window — before `pageView`
  // resolves (`getView` round-trip) and before the doc syncs — so opening a new
  // draft paints the prompt instantly instead of flashing the editor skeleton +
  // comment band. We do NOT optimistically set `activeView` for this: that would
  // mismatch the lagging URL (`activeView` = new id, `urlViewId` = old page) and
  // blink the previous page under a skeleton. Cleared the moment the draft syncs,
  // from which point the normal placeholder + `docEmpty` gate takes over.
  const [newDraftId, setNewDraftId] = useState<string | null>(null);
  useEffect(() => {
    if (newDraftId && newDraftId === urlViewId && collab.synced) {
      setNewDraftId(null);
    }
  }, [newDraftId, urlViewId, collab.synced]);

  // Drafts the user chose to write by hand — the landing's "Start with a blank
  // page" escape hatch. Membership forces the editor (not the prompt) for that
  // page even while it's still an empty placeholder, so an explicit "skip AI"
  // choice isn't undone by the placeholder gate. A Set so reopening one of these
  // still-empty drafts doesn't bounce back to the landing, and so multiple
  // blanked drafts coexist across a session.
  const [blankDraftIds, setBlankDraftIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Metadata for the page the URL currently points at, or null during the brief
  // window after a switch while its `getView` is still in flight. The centre
  // pane renders a chrome skeleton over the already-syncing editor in that
  // window rather than tearing the whole pane down — so switching drafts no
  // longer flashes an empty "Loading…" pane or rebuilds the editor from blank.
  const pageView = activeView && activeView.id === urlViewId ? activeView : null;

  // Local user identity for the collaboration cursor + presence avatar.
  const user = useMemo(() => {
    const info = getUserInfo();
    return {
      id: info?.id ?? "me",
      name: info?.name?.trim() || info?.email || "You",
      avatarUrl: info?.avatarUrl,
    };
  }, []);

  // Desktop sidebar collapse (`sidebarCollapsed` / `setSidebarCollapsed`) lives
  // in the hoisted provider — the sidebar it sizes is now in `WorkspaceChrome`,
  // but the toggle button stays in this shell's top bar (Row 1). The inbox
  // flyout is likewise owned by the provider + rendered by `WorkspaceChrome`.

  // ── Tab strip + per-tab browse history — the top "layer" (Row 1) ──────
  // The active tab's current ENTRY is the source of truth for what the pane
  // shows — a page id, a panel sentinel (`panel:<id>`, Approvals / Autopilot),
  // or null (the Suggested-for-you home). It is mirrored into the URL
  // (`/p/<id>` or `/p?panel=<id>`) by the sync effect below, and the
  // pathname/query-keyed reads load the body. Seeded once from the URL;
  // session-scoped (survives soft nav, resets on reload). `doc-tabs.ts` treats
  // every entry as an opaque string, so panel entries flow through unchanged.
  const [tabsState, setTabsState] = useState<TabsState>(() =>
    initTabs(urlEntry),
  );
  const tabsActiveEntry = activePageId(tabsState);
  const tabsActiveEntryRef = useRef(tabsActiveEntry);
  tabsActiveEntryRef.current = tabsActiveEntry;
  // Latest URL-derived entry, read by the tabs → URL effect for COMPARISON only
  // (never as a trigger — see below). Updated every render so the effect sees
  // the committed URL when it runs.
  const urlEntryRef = useRef(urlEntry);
  urlEntryRef.current = urlEntry;

  // tabs → URL: mirror the active tab's current entry into the canonical URL.
  // Triggered ONLY by the active entry (the tab side owns this direction); it
  // reads the URL entry through a ref purely to no-op once they already match.
  //
  // The URL entry must NOT be a dependency. If it were, an EXTERNAL url change —
  // the editor's "/"→Page `router.push`, floating-chat's `router.replace`, a
  // deep link, browser back/forward — would re-fire this effect in the render
  // where `urlEntry` has advanced but `tabsActiveEntry` still lags by one
  // commit. It would then `router.replace` the URL back to the stale active
  // entry, while the URL → tabs effect simultaneously adopts the new one, leaving
  // the two a half-step out of phase forever: the page and its child page
  // ping-pong endlessly. Reacting to the active entry alone lets the URL → tabs
  // effect own external changes and this effect own tab-driven ones; both guard
  // on equality, so they converge.
  useEffect(() => {
    if (urlEntryRef.current !== tabsActiveEntry) {
      router.replace(docEntryPath(workspaceId, tabsActiveEntry));
    }
  }, [tabsActiveEntry, workspaceId, router]);

  // URL → tabs: reconcile a URL change from OUTSIDE the tab actions — a
  // chat-created draft auto-navigation (`floating-chat` calls `router.replace`
  // directly), a page link, a `?panel=` deep link, a redirect from the legacy
  // `/approvals` / `/goals` routes, a deep link followed in-session. Reacting to
  // `urlEntry` alone (latest active entry read via the ref) keeps a tab switch's
  // not-yet-synced URL from being mistaken for an external change; both effects
  // guard on equality, so they converge with no ping-pong.
  useEffect(() => {
    if (urlEntry === tabsActiveEntryRef.current) return;
    setTabsState((s) => (urlEntry ? openPage(s, urlEntry) : blankActiveTab(s)));
  }, [urlEntry]);

  const [activeError, setActiveError] = useState<string | null>(null);
  // Centre-pane errors (build / full-width / clearance) route through the
  // provider's single `topError` channel so there's one banner; `setTopError`
  // here is the provider's setter (aliased `setSidebarTopError` above).
  const setTopError = setSidebarTopError;
  const topError = sidebar.topError;

  // Recents + `reloadSidebar` + `pushRecent` are owned by the hoisted provider;
  // this shell consumes them (destructured above).

  // Reflect a server-side title/icon change into the open page without a
  // refetch for the active view. Two producers route here:
  //
  //   1. **Auto-title** (migration 218) — the editor's `onAutoTitled` and the
  //      AI auto-title SSE. The name settles to `'auto'` and the *suggested*
  //      icon is adopted only when the page still has none (`v.icon ?? icon`),
  //      mirroring the server's `COALESCE(icon, …)` so a user-chosen emoji is
  //      never clobbered.
  //   2. **Explicit `setTitle`/`setIcon`** via `patchPage` — arrives with
  //      `overwrite: true` + the authoritative `nameOrigin`, so the committed
  //      icon is applied directly (including a `null` that *clears* it; the
  //      COALESCE guard would wrongly keep the stale emoji).
  //
  // `reloadSidebar` then refreshes the sidebar rows, breadcrumb, and inactive
  // tabs to the server's committed values (those surfaces read the fetched
  // list, not `activeView`).
  const applyAutoTitle = useCallback(
    (
      id: string,
      title: string,
      icon: string | null,
      opts?: { nameOrigin?: NameOrigin; overwrite?: boolean },
    ) => {
      setActiveView((v) =>
        v && v.id === id
          ? {
              ...v,
              name: title,
              nameOrigin: opts?.nameOrigin ?? "auto",
              icon: opts?.overwrite ? icon : v.icon ?? icon,
            }
          : v,
      );
      reloadSidebar();
    },
    [reloadSidebar],
  );

  // (The `doc:draft-created` → `reloadSidebar` bridge now lives in the
  // hoisted provider, beside the list fetch it refreshes.)

  // Title/icon stream bridge: floating-chat relays the `doc_title_update`
  // SSE as a `doc:title-updated` window event. Two producers feed it — the
  // post-turn AI auto-title (migration 218; suggested icon, COALESCE) and an
  // explicit `setTitle`/`setIcon` `patchPage` (authoritative, `overwrite`).
  // Apply both to the open page so the change is visible without a refetch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          pageId?: string;
          title?: string;
          icon?: string | null;
          nameOrigin?: NameOrigin;
          overwrite?: boolean;
        }>
      ).detail;
      if (!detail?.pageId || !detail.title) return;
      applyAutoTitle(detail.pageId, detail.title, detail.icon ?? null, {
        nameOrigin: detail.nameOrigin,
        overwrite: detail.overwrite,
      });
    };
    window.addEventListener("doc:title-updated", handler);
    return () => window.removeEventListener("doc:title-updated", handler);
  }, [applyAutoTitle]);

  // Chat-seed bridge moved up to `WorkspaceChrome` with the dock — the doc
  // landing's chatter still fires the same `doc:chat-seed` event
  // (`requestChatSeed`, below); the chrome subscribes and routes it. The dock
  // lives above this shell now, so the routing must too.

  // Page-collab guard relay. The "another member is running on this page"
  // warning needs the page's Yjs provider (`assistantRun`), which only exists
  // here. The dock reads it from the module-level relay (it can't be passed
  // down — the dock is an ANCESTOR now). Publish on change; clear on unmount
  // (leaving `/p`) so the banner never lingers on a non-doc surface. See
  // lib/doc-chat-relay.ts.
  const docOthersRun =
    assistantRun && user && assistantRun.actor.id !== user.id
      ? assistantRun
      : null;
  useEffect(() => {
    docChatRelay.setOthersRun(docOthersRun);
    return () => docChatRelay.setOthersRun(null);
  }, [docOthersRun]);

  // ── Page-body build indicator ─────────────────────────────────────────
  // A landing prompt pre-creates a draft and runs the build with the corner
  // chat collapsed; the page body fills via Yjs. To make that work visible
  // *on the page*, the editor renders `<PageBuildIndicator>` (under the page
  // comment composer) whenever `buildingPageId` is the active page — the
  // indicator pulls the live detail (tool timeline + streaming text) off the
  // build-activity bus itself, so the shell only owns *visibility*, not the
  // per-token content. We subscribe here purely to clear `buildingPageId`
  // when the turn finishes: wait until we've actually seen it stream (so the
  // pre-stream tick doesn't clear early), then drop the banner when it stops.
  const [buildingPageId, setBuildingPageId] = useState<string | null>(null);
  const buildingPageIdRef = useRef<string | null>(null);
  buildingPageIdRef.current = buildingPageId;
  // Whether the active page has an inline comment anchor (reported by the
  // editor). When it does — and the page is the constrained reading column on a
  // wide viewport — the content shifts left to reserve a right gutter so the
  // comment rail can dock beside it (Notion-style). See comment-rail.tsx.
  const [pageHasComments, setPageHasComments] = useState(false);

  // ── Custom page templates (migration 281) ────────────────────────────
  // The save-as-template dialog target (page id + prefill), the landing
  // "Start from a template" gallery, its loaded custom rows, and the id of a
  // transient draft being authored "from scratch" as a template (drives the
  // Finish/Discard banner).
  const [saveTemplateFor, setSaveTemplateFor] = useState<{
    pageId: string;
    name: string;
    icon: string | null;
    /** When true, the page is a throwaway authoring draft removed after save. */
    transient: boolean;
  } | null>(null);
  const [landingGalleryOpen, setLandingGalleryOpen] = useState(false);
  // A template chosen on the empty-page landing, handed to the open draft's
  // editor to seed in place (see `seedPageFromTemplate`). Cleared once the
  // editor reports the blocks inserted (`onTemplateSeeded`).
  const [seedTemplate, setSeedTemplate] = useState<
    { kind: "builtin"; id: string } | { kind: "custom"; id: string } | null
  >(null);

  // ── Deferred `created` page-event commit (migration 283) ──────────────
  // A freshly-created interactive draft (blank / from-template) holds its
  // `created` workflow trigger until the user engages (debounced typing) or
  // leaves (navigates away / hides the tab) — so an empty, just-minted page
  // never fires automations on its own. Template drafts wait longer (more
  // fields to fill in). The server flips the pending flag atomically, so the
  // typing debounce and the leave-flush together fire the workflow exactly once.
  // Drafts a template was applied to this session → the longer debounce.
  const templateSeededDraftIdsRef = useRef<Set<string>>(new Set());
  // viewIds already committed (client-side guard; the server dedupes too).
  const createdCommittedRef = useRef<Set<string>>(new Set());
  // The viewId that currently owes a created-commit (null = nothing pending).
  const pendingCreatedViewIdRef = useRef<string | null>(null);
  const createdDebounceTimerRef = useRef<number | undefined>(undefined);

  const commitCreatedEvent = useCallback((viewId: string | null) => {
    if (!viewId || createdCommittedRef.current.has(viewId)) return;
    createdCommittedRef.current.add(viewId);
    if (pendingCreatedViewIdRef.current === viewId) {
      pendingCreatedViewIdRef.current = null;
    }
    window.clearTimeout(createdDebounceTimerRef.current);
    void commitPageCreatedEvent(viewId).catch(() => {
      // best-effort: a failed commit must never block editing or navigation
    });
  }, []);

  // Typing settles → commit (debounced; longer for template drafts). Wired to
  // the editor's `onContentChange`.
  const handleDraftContentChange = useCallback(() => {
    const viewId = pendingCreatedViewIdRef.current;
    if (!viewId) return;
    const debounceMs = templateSeededDraftIdsRef.current.has(viewId)
      ? CREATED_COMMIT_TEMPLATE_MS
      : CREATED_COMMIT_BLANK_MS;
    window.clearTimeout(createdDebounceTimerRef.current);
    createdDebounceTimerRef.current = window.setTimeout(
      () => commitCreatedEvent(viewId),
      debounceMs,
    );
  }, [commitCreatedEvent]);

  const [landingCustomTemplates, setLandingCustomTemplates] = useState<
    CustomPageTemplateSummary[]
  >([]);

  // Track which open page (if any) still owes its deferred `created` event,
  // re-read from page metadata so a reloaded-but-uncommitted draft re-arms.
  useEffect(() => {
    if (
      pageView?.createdEventPending &&
      !createdCommittedRef.current.has(pageView.id)
    ) {
      pendingCreatedViewIdRef.current = pageView.id;
    }
  }, [pageView]);

  // Leave by navigation → flush the page we left, even if untouched.
  const prevPendingNavRef = useRef(urlViewId);
  useEffect(() => {
    const prev = prevPendingNavRef.current;
    prevPendingNavRef.current = urlViewId;
    if (prev && prev !== urlViewId && pendingCreatedViewIdRef.current === prev) {
      commitCreatedEvent(prev);
    }
  }, [urlViewId, commitCreatedEvent]);

  // Leave by hiding the tab → flush the current pending draft immediately.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        commitCreatedEvent(pendingCreatedViewIdRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [commitCreatedEvent]);
  const [templateAuthoringId, setTemplateAuthoringId] = useState<string | null>(null);
  // Track viewport width so the reserved comment gutter scales with it. Applied
  // as an INLINE padding (not a Tailwind class) so React Fast-Refresh delivers
  // it even when the dev server's CSS hot-reload is stale.
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const commentGutter =
    pageHasComments && pageView && !pageView.fullWidth
      ? commentGutterWidth(viewportWidth)
      : 0;
  // A brand-new, untouched draft (placeholder title) that isn't mid-build shows
  // the same "What do you want to see?" prompt as a blank tab — an empty draft
  // and an empty tab are the same "haven't decided what this page is" state,
  // except the draft already has an id, so a submit builds *into* it (no comment
  // band, no bare editor). Once a build starts (`buildingPageId`) or the page
  // auto/user-titles, the editor takes over so the construction streams onto it.
  //
  // Emptiness: while the doc is still syncing a placeholder draft is *presumed
  // empty* (a freshly-created one is — this is what kills the open-flicker where
  // the title + comment band + editor skeleton flashed before the prompt). The
  // instant it syncs, the real `docEmpty` check takes over, so a placeholder page
  // that somehow has content (e.g. a build whose auto-title failed) is never
  // stranded behind the prompt — it just resolves to the editor a frame later.
  //
  // The `newDraftId` latch covers the earlier window still: right after "+ New
  // draft", `pageView` is null (its `getView` is in flight), so the placeholder
  // gate can't fire yet — the latch forces the landing until the draft syncs. A
  // running build always wins (the editor must show the stream).
  // "Start with a blank page" wins over every landing trigger: once the user
  // opts to write the page by hand, the editor must hold even though the draft
  // is still an empty placeholder (which would otherwise re-assert the prompt).
  const startedBlank = urlViewId !== null && blankDraftIds.has(urlViewId);
  const isDraftLanding =
    !startedBlank &&
    buildingPageId !== urlViewId &&
    ((newDraftId !== null && newDraftId === urlViewId) ||
      (!!pageView &&
        pageView.nameOrigin === "placeholder" &&
        (!collab.synced || docEmpty)));
  const buildStartedRef = useRef(false);
  useEffect(
    () =>
      subscribeBuildActivity((a) => {
        if (!buildingPageIdRef.current) return;
        if (a.isStreaming) {
          buildStartedRef.current = true;
        } else if (buildStartedRef.current) {
          buildStartedRef.current = false;
          setBuildingPageId(null);
        }
      }),
    [],
  );

  // Latest `handleBuildPage`, for the resume effect to call without taking it
  // as a dep (its identity changes every render). Assigned during render just
  // after the function is defined.
  const buildPageRef = useRef<
    | ((
        text: string,
        opts: {
          model: ChatSeed["model"];
          researchMode: boolean;
          fileIds?: string[];
        },
        targetViewId?: string,
        fromResume?: boolean,
      ) => void)
    | null
  >(null);
  // One-shot guard so the resume can't re-fire on later renders of this mount.
  const buildResumedRef = useRef(false);

  // Resume a build interrupted by the auth-refresh redirect. `handleBuildPage`
  // stashes its intent before the (possibly redirecting) `createDraft`; on the
  // full-page return we replay it exactly once. `take` is single-consume and
  // the replay passes `fromResume` (no re-stash), so a still-broken session
  // can't loop; a short TTL stops a stale prompt resurrecting on a later visit.
  // See docs/architecture/platform/auth.md → "A sub-app refresh discards
  // in-flight work".
  useEffect(() => {
    if (buildResumedRef.current) return;
    buildResumedRef.current = true;
    const pending = takePendingBuild(workspaceId, Date.now());
    if (!pending) return;
    buildPageRef.current?.(
      pending.text,
      {
        model: pending.model,
        researchMode: pending.researchMode,
        fileIds: pending.fileIds,
      },
      pending.targetViewId,
      true,
    );
  }, [workspaceId]);

  // (Both sidebar lists are fetched by the hoisted provider, above this shell;
  // they survive `/p/<pageId>` soft swaps because the provider lives in the
  // workspace layout, keyed on the stable route `workspaceId`.)

  // Fetch the active view's metadata + page whenever the URL viewId
  // changes (or the workspace switches). Also caches each draft's
  // `autoPruneAt` for sidebar caption rendering — the list endpoint
  // doesn't ship it.
  useEffect(() => {
    if (!urlViewId) {
      setActiveView(null);
      setActiveError(null);
      return;
    }
    let cancelled = false;
    setActiveError(null);
    getView(urlViewId)
      .then((meta) => {
        if (cancelled) return;
        setActiveView(meta);
        // Record the open — covers deep links / direct loads that don't
        // route through `navigateToView` (saved-only filter happens at
        // render time).
        pushRecent(meta.id);
        if (meta.state === "draft") {
          recordPrune(meta.id, meta.autoPruneAt);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setActiveError(message);
        setActiveView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [urlViewId, pushRecent, recordPrune]);

  function navigateToView(id: string | null) {
    // Navigate the ACTIVE tab; the canonical `/p/<id>` URL follows via the
    // tabs → URL effect (never replaced directly here). A non-null id opens
    // (pushes) the page into the active tab's history; null blanks that tab
    // (the breadcrumb's workspace-home crumb).
    if (id) {
      pushRecent(id);
      setTabsState((s) => openPage(s, id));
    } else {
      setTabsState(blankActiveTab);
    }
  }

  // Open a panel (Approvals / Autopilot) in a NEW tab and focus it — the home
  // dock's needs-you cards call this. Deduped: if a tab already shows the
  // panel, focus THAT tab instead of spawning a duplicate. The tabs → URL
  // effect then mirrors the active entry to `/p?panel=<id>`, and the render
  // branch below paints the panel in the centre pane.
  const openPanelInNewTab = useCallback((panel: PanelId) => {
    const entry = panelTabEntry(panel);
    setTabsState((s) => {
      const existing = s.tabs.find((tb) => tabPageId(tb) === entry);
      if (existing) return switchTab(s, existing.key);
      return openPage(newTab(s), entry);
    });
  }, []);

  // ── Active-page bridge ─────────────────────────────────────────────────
  // Register the centre-pane handles the hoisted provider's mutation handlers
  // call through (optimistic `setActiveView`, tab-history scrub, navigation,
  // new-draft latch). Stable callbacks, registered for this shell's lifetime;
  // off `/p` the provider holds no bridge and skips the optimistic part.
  useEffect(() => {
    const bridge: ActivePageBridge = {
      getActiveView: () => activeViewRef.current,
      setActiveView: (updater) => setActiveView(updater),
      dropFromTabs: (id) => setTabsState((s) => dropPage(s, id)),
      navigate: (id) => navigateToView(id),
      latchNewDraft: (id) => setNewDraftId(id),
    };
    return registerActivePageBridge(bridge);
    // navigateToView is a stable hoisted closure; the bridge reads live state
    // via refs/setters, so it never needs re-registering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerActivePageBridge]);

  // Desktop quick-capture: the desktop shell loads `…/p?capture=1` on the global
  // hotkey to ask doc to drop the user straight into a fresh blank draft.
  // Fire the provider's `handleNewDraft` once on mount — it navigates to the new
  // page's URL (which has no `capture` param), so the request can't re-trigger,
  // and the ref guards against a double-run within this mount. See
  // docs/architecture/features/app-desktop.md → "quick-capture.ts".
  const captureHandledRef = useRef(false);
  useEffect(() => {
    if (captureHandledRef.current) return;
    if (typeof window === "undefined") return;
    if (!isCaptureRequest(window.location.search)) return;
    captureHandledRef.current = true;
    void sidebar.handleNewDraft();
    // Run once on shell mount; handleNewDraft is a stable provider callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop shell chrome: tag <html> when running inside the Electron desktop
  // app (apps/app-desktop), whose preload exposes `window.usebrianDesktop` (+ legacy `window.sidanclawDesktop`).
  // The `is-canvas-desktop` class gates the desktop-only chrome in globals.css —
  // a draggable title-bar strip that clears the macOS traffic lights and
  // non-selectable app chrome. layout.tsx also stamps this before paint (for the
  // production no-flash path); doing it here too makes it robust to that script
  // being absent (e.g. a stale dev root layout) and survives hydration. No-op in
  // a normal browser, where neither desktop bridge global is defined.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      usebrianDesktop?: { platform?: string };
      sidanclawDesktop?: { platform?: string };
    };
    const desktop = w.usebrianDesktop ?? w.sidanclawDesktop;
    if (!desktop) return;
    document.documentElement.classList.add("is-canvas-desktop");
    // Windows keeps a standard OS frame (no macOS traffic lights), so zero the
    // title-bar inset via `is-canvas-desktop-win` — see globals.css.
    if (desktop.platform === "win32") {
      document.documentElement.classList.add("is-canvas-desktop-win");
    }
  }, []);

  // Landing's "Start with a blank page" on a blank tab (no page open): mint a
  // draft and open it straight in the editor, skipping the AI prompt. Same
  // create/navigate as `handleNewDraft`, minus the `newDraftId` latch (which
  // exists to *hold* the landing) and plus a `blankDraftIds` entry so the
  // placeholder gate doesn't re-assert the prompt once the draft syncs.
  async function handleStartBlankNew() {
    setTopError(null);
    try {
      const created = await createDraft({ workspaceId });
      reloadSidebar();
      recordPrune(created.id, created.autoPruneAt);
      setBlankDraftIds((prev) => new Set(prev).add(created.id));
      navigateToView(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.createDraftFailed, { message }));
    }
  }

  // ── Custom templates ────────────────────────────────────────────────

  // Open the save-as-template dialog for a page, prefilled from its title/icon.
  async function handleSaveAsTemplate(pageId: string, transient = false) {
    try {
      const view = await getView(pageId);
      setSaveTemplateFor({ pageId, name: view.name, icon: view.icon, transient });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.createDraftFailed, { message }));
    }
  }

  // Persist the dialog: snapshot the source page's current blocks into a custom
  // template. A transient authoring draft is removed once the template is saved.
  async function submitSaveTemplate(input: SaveAsTemplateInput) {
    const target = saveTemplateFor;
    if (!target) return;
    // Snapshot the LIVE blocks from the Yjs doc, not the REST `saved_views.page`
    // snapshot (which lags the collaborative doc and is empty for a fresh page).
    // The save target is always the currently-open page, so `collab.doc` is its
    // doc. Fall back to the persisted page only when the doc isn't ready.
    const blocks =
      collab.doc && target.pageId === urlViewId
        ? yDocToSnapshot(collab.doc).page.blocks
        : ((await getView(target.pageId)).page?.blocks ?? []);
    if (blocks.length === 0) {
      // Nothing to save — surface a friendly error in the dialog (the server's
      // min(1) check is the backstop) instead of a raw 400.
      throw new Error(t.saveTemplateDialog.emptyError);
    }
    // The client `Block` is a narrow local shape; the server re-validates the
    // snapshot with the canonical block schema, so the cast is safe. Derive the
    // blueprint `extraction` spec from the blocks so a WYSIWYG-authored blueprint
    // (heading + extraction_slot) persists as a blueprint (extraction != null)
    // rather than a plain skeleton — otherwise it never surfaces in the
    // Blueprints library or the blueprint pickers. Undefined for a slot-free
    // page keeps it a plain template. See structural-synthesis.md.
    const extraction = templateExtractionFromBlocks(blocks as never);
    await createCustomPageTemplate(workspaceId, { ...input, blocks: blocks as never, extraction });
    setSaveTemplateFor(null);
    if (target.transient) {
      setTemplateAuthoringId((cur) => (cur === target.pageId ? null : cur));
      await deleteView(target.pageId).catch(() => {});
      reloadSidebar();
      navigateToView(null);
    }
  }

  // "New template" → author from scratch: mint a blank draft, mark it as the
  // authoring target (drives the Finish/Discard banner), and open it.
  async function handleNewTemplate() {
    setTopError(null);
    try {
      const created = await createDraft({ workspaceId, name: t.newTemplateTitle });
      reloadSidebar();
      recordPrune(created.id, created.autoPruneAt);
      setBlankDraftIds((prev) => new Set(prev).add(created.id));
      setTemplateAuthoringId(created.id);
      navigateToView(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.createDraftFailed, { message }));
    }
  }

  // Discard a from-scratch authoring draft without saving it as a template.
  async function discardTemplateAuthoring(pageId: string) {
    setTemplateAuthoringId((cur) => (cur === pageId ? null : cur));
    await deleteView(pageId).catch(() => {});
    reloadSidebar();
    navigateToView(null);
  }

  // Create a brand-new page seeded from a template (the landing "Start from a
  // template" pick). Built-in → instantiate Markdown; custom → fetch blocks +
  // fresh ids. Then navigate to the new page.
  // "Start from a template" on the empty-page landing. The landing is only
  // shown over an existing empty draft (`urlViewId` — see `isDraftLanding`), so
  // we fill THAT draft in place rather than minting a second page: drop the
  // landing (mounts the live editor on the current draft) and hand the template
  // to the editor via `seedTemplate`, which inserts its blocks at the top once
  // it goes live (the same Yjs insert path the "/template" slash item uses).
  // This is the fix for "a template made a new page and stranded the blank one".
  // Fallback (no current draft — not reachable from this landing entry point):
  // mint a new draft seeded through the `/views/draft` `blocks` seam.
  async function seedPageFromTemplate(
    source: { kind: "builtin"; id: string } | { kind: "custom"; id: string },
  ) {
    setLandingGalleryOpen(false);
    if (urlViewId) {
      // A from-template draft fills in slower (more fields), so its deferred
      // `created` event waits the longer debounce (migration 283).
      templateSeededDraftIdsRef.current.add(urlViewId);
      setSeedTemplate(source);
      handleStartBlankDraft(urlViewId);
      return;
    }
    try {
      let blocks;
      if (source.kind === "builtin") {
        const instance = instantiatePageTemplate(source.id, { genId: () => crypto.randomUUID() });
        blocks = instance?.blocks ?? [];
      } else {
        const tpl = await getCustomPageTemplate(workspaceId, source.id);
        blocks = withFreshBlockIds(tpl.blocks, () => crypto.randomUUID());
      }
      if (blocks.length === 0) {
        await handleStartBlankNew();
        return;
      }
      const created = await createDraft({
        workspaceId,
        blocks: blocks as never,
      });
      reloadSidebar();
      recordPrune(created.id, created.autoPruneAt);
      setBlankDraftIds((prev) => new Set(prev).add(created.id));
      navigateToView(created.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.createDraftFailed, { message }));
    }
  }

  // Load custom templates when the landing gallery opens.
  useEffect(() => {
    if (!landingGalleryOpen) return;
    void listCustomPageTemplates(workspaceId)
      .then(setLandingCustomTemplates)
      .catch(() => setLandingCustomTemplates([]));
  }, [landingGalleryOpen, workspaceId]);

  // Landing's "Start with a blank page" on an already-open empty draft: the
  // page exists, so just drop its landing. Mark it blank (mounts the editor)
  // and release the `newDraftId` latch so it can't snap the prompt back.
  function handleStartBlankDraft(viewId: string) {
    setNewDraftId((cur) => (cur === viewId ? null : cur));
    setBlankDraftIds((prev) => new Set(prev).add(viewId));
  }

  // Default-viewer landing → "build me a page". Unlike the floating dock
  // (which streams the reply in the corner), this pre-creates the draft and
  // navigates to it *immediately*, then hands the prompt to the chat anchored
  // to that page (`docViewId`). The model edits the open page via
  // `patchPage`, so the construction streams onto the **page body** itself
  // (live Yjs), with the corner chat left collapsed — the page is the show.
  // Pre-creating is also why this doesn't depend on a server "page created"
  // navigation signal: doc's `renderPage` emits none (only `renderView`
  // does, and that tool is stripped for doc assistants).
  async function handleBuildPage(
    text: string,
    opts: { model: ChatSeed["model"]; researchMode: boolean; fileIds?: string[] },
    targetViewId?: string,
    fromResume = false,
  ) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setTopError(null);
    // Stash the intent so it survives the mandatory auth-refresh full-page
    // redirect: `createDraft` below is an `authFetch` POST, and in production a
    // 401 bounces the whole browser to usebrian.ai and back, reloading this page
    // and dropping `trimmed` (React state). The resume effect replays it on
    // return. A replay (`fromResume`) never re-stashes, so a still-broken
    // session can't loop. See docs/architecture/platform/auth.md → "A sub-app
    // refresh discards in-flight work".
    if (!fromResume) {
      stashPendingBuild({
        workspaceId,
        text: trimmed,
        model: opts.model,
        researchMode: opts.researchMode,
        fileIds: opts.fileIds,
        targetViewId,
        ts: Date.now(),
      });
    }
    try {
      // Blank tab → mint a fresh draft and navigate into it. Empty draft (the
      // draft landing, where the page is already open) → build into THAT page —
      // it's the same "describe what you want" surface, it just already has an id.
      let pageId = targetViewId;
      if (!pageId) {
        const created = await createDraft({ workspaceId });
        reloadSidebar();
        recordPrune(created.id, created.autoPruneAt);
        navigateToView(created.id);
        pageId = created.id;
      }
      // Surface the build on the page body (indicator) until the turn finishes;
      // setting `buildingPageId` also swaps the draft landing for the live
      // editor (see `isDraftLanding`) so the construction streams onto the body.
      buildStartedRef.current = false;
      setBuildingPageId(pageId);
      requestChatSeed({
        prefill: trimmed,
        autoSend: true,
        docViewId: pageId,
        model: opts.model,
        researchMode: opts.researchMode,
        ...(opts.fileIds && opts.fileIds.length > 0
          ? { fileIds: opts.fileIds }
          : {}),
      });
      // The turn is seeded — intent fulfilled, drop the stash.
      clearPendingBuild();
      // Backstop: if the turn never streams (e.g. a rapid second submit hit
      // the chat while a prior turn was in flight), the stream-end effect
      // never fires — drop the banner so it can't wedge. No-ops once the
      // build has actually started (the effect owns clearing from there).
      window.setTimeout(() => {
        if (!buildStartedRef.current) {
          setBuildingPageId((cur) => (cur === pageId ? null : cur));
        }
      }, 60_000);
    } catch (err) {
      // Keep the stash ONLY when the throw is the auth redirect unloading the
      // page (so the build replays on return). Any other failure is terminal
      // here — clear it so a later reload can't silently re-fire the build.
      if (!isAuthRedirectInFlight()) clearPendingBuild();
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.createDraftFailed, { message }));
    }
  }

  // Keep the resume effect (below) pointed at the current `handleBuildPage`
  // closure without taking it as an effect dep — its identity changes every
  // render. Assigning a ref during render is the sanctioned "latest callback"
  // pattern (idempotent, reads no external mutable state).
  buildPageRef.current = handleBuildPage;

  // Sidebar page mutations (add-child / rename / rename-value / duplicate /
  // reparent / save / unsave / delete / set-icon) live in the hoisted provider
  // (`DocSidebarDataProvider`). This shell consumes the ones its centre-pane
  // chrome raises (PageHeader / PageTitle): `handleRenameValue`,
  // `handleDuplicate`, `handleSetIcon` — destructured below.
  const {
    handleRenameValue,
    handleDuplicate,
    handleSetIcon,
  } = sidebar;

  // Flip a page's Notion-style "Full width" mode. Optimistic: patch the active
  // view immediately so the body re-measures without waiting on the network,
  // then commit the write and reconcile with the server's authoritative
  // metadata. On failure, roll the optimistic change back and surface the
  // error (mirrors handleSetIcon's error handling — no silent catch).
  async function handleToggleFullWidth(id: string, next: boolean) {
    setTopError(null);
    const previous = activeView;
    if (activeView?.id === id) {
      setActiveView((v) => (v && v.id === id ? { ...v, fullWidth: next } : v));
    }
    try {
      // Optimistic state is already applied above; offline this queues for replay
      // (no throw → no rollback), online it calls the API + reconciles.
      await offlineWrite({
        kind: "view.fullWidth",
        coalesceKey: `view.fullWidth:${id}`,
        payload: { id, fullWidth: next },
        exec: () => setViewFullWidth(id, next),
        onResult: (updated) => {
          if (activeView?.id === id) setActiveView(updated);
        },
      });
    } catch (err) {
      if (previous?.id === id) setActiveView(previous);
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.fullWidthUpdateFailed, { message }));
    }
  }

  // Page-level clearance (migration 212). Same optimistic-then-reconcile shape
  // as full-width. The server rejects a value above the member's own clearance
  // (403) — caught here, rolled back, surfaced. Declassify is confirmed in the
  // pill before this runs.
  async function handleChangeClearance(
    id: string,
    next: "public" | "internal" | "confidential",
  ) {
    setTopError(null);
    const previous = activeView;
    if (activeView?.id === id) {
      setActiveView((v) => (v && v.id === id ? { ...v, clearance: next } : v));
    }
    try {
      await offlineWrite({
        kind: "view.clearance",
        coalesceKey: `view.clearance:${id}`,
        payload: { id, clearance: next },
        exec: () => setViewClearance(id, next),
        onResult: (updated) => {
          if (activeView?.id === id) setActiveView(updated);
        },
      });
    } catch (err) {
      if (previous?.id === id) setActiveView(previous);
      const message = err instanceof Error ? err.message : String(err);
      setTopError(format(t.clearanceUpdateFailed, { message }));
    }
  }

  function handleActiveDeletedFromHeader() {
    if (activeView) setTabsState((s) => dropPage(s, activeView.id));
    setActiveView(null);
    reloadSidebar();
  }

  const allRows = useMemo(() => [...saved, ...drafts], [saved, drafts]);

  // Recents + the landing cards (recents-or-freshest-saved) are owned by the
  // hoisted provider; the centre-pane landing reads `landingCards` from it.

  // Ancestor breadcrumb for the active page. Built from the combined
  // row list so a draft sub-page under a saved parent still resolves
  // its chain.
  const breadcrumb = useMemo(
    () => buildBreadcrumb(allRows, activeView?.id ?? null),
    [allRows, activeView],
  );

  // Resolve each open tab to its display label/icon for the top-layer strip.
  // A panel tab (`panel:<id>`) resolves to its fixed label + glyph; the active
  // page tab prefers the freshest `activeView` metadata; the others read the
  // sidebar row list; a blank tab resolves to null → a "New tab" chip.
  const tabViews = useMemo<TabView[]>(() => {
    const byId = new Map(allRows.map((r) => [r.id, r] as const));
    const panelLabel: Record<PanelId, string> = {
      approvals: t.topbarPanelApprovals,
      goals: t.topbarPanelAutopilot,
      recordings: t.topbarPanelRecordings,
    };
    return tabsState.tabs.map((tab) => {
      const entry = tabPageId(tab);
      const panel = panelFromTabEntry(entry);
      if (panel) {
        return {
          key: tab.key,
          pageId: null,
          panel,
          isActive: tab.key === tabsState.activeKey,
          title: panelLabel[panel],
          icon: null,
        };
      }
      const pageId = entry;
      const meta =
        pageId && activeView?.id === pageId
          ? activeView
          : pageId
            ? byId.get(pageId)
            : undefined;
      return {
        key: tab.key,
        pageId,
        isActive: tab.key === tabsState.activeKey,
        title: meta?.name ?? null,
        icon: meta?.icon ?? null,
        entity: meta?.entity,
        viewType: meta?.viewType,
        nameOrigin: meta?.nameOrigin,
      };
    });
  }, [
    tabsState,
    allRows,
    activeView,
    t.topbarPanelApprovals,
    t.topbarPanelAutopilot,
    t.topbarPanelRecordings,
  ]);

  return (
    <div
      // data-sidebar-collapsed: in the desktop shell, when the sidebar is
      // collapsed the tab bar slides under the macOS traffic lights, so
      // globals.css gives it left clearance only in that state. (The sidebar
      // itself + inbox flyout + mobile hamburger now live in `WorkspaceChrome`,
      // hoisted to the workspace layout; this shell renders only the centre
      // pane + chat docks.)
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="relative flex h-full w-full overflow-hidden"
    >
      {/* Bundled-desktop offline indicator (gated; never shows on web/thin). */}
      {offline && (
        <div className="pointer-events-none fixed bottom-3 left-3 z-50 rounded-full border border-amber-300/40 bg-amber-100/90 px-3 py-1 text-[11px] font-medium text-amber-900 shadow-sm dark:border-amber-700/40 dark:bg-amber-950/80 dark:text-amber-200">
          {pendingWrites > 0
            ? format(t.offlinePending, { count: pendingWrites })
            : t.offline}
        </div>
      )}
      <main className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
        {/* Ambient "the assistant is working on this page" claw + status pill,
            behind the editor content. Visible only while a run is active. */}
        <AssistantRunClaw run={assistantRun} />
        {/* Top "layer" (Row 1) — PERSISTENT across every state (loaded page,
            blank tab, empty selection, error): sidebar toggle, browse-history
            arrows, and the open-tab strip. The breadcrumb + action navbar
            (Row 2, PageHeader) sits BELOW it, only when a page is loaded. */}
        <DocTopBar
          tabs={tabViews}
          canBack={canGoBack(tabsState)}
          canForward={canGoForward(tabsState)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          onBack={() => setTabsState(back)}
          onForward={() => setTabsState(forward)}
          onSwitchTab={(key) => setTabsState((s) => switchTab(s, key))}
          onCloseTab={(key) => setTabsState((s) => closeTab(s, key))}
          onNewTab={() => setTabsState(newTab)}
        />
        {topError && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {topError}
          </div>
        )}
        {/* Panel tab (Approvals / Autopilot / Recordings) — takes precedence
            over the Suggested home (a panel URL has no `[pageId]`, so
            `urlViewId` is null and the home branch would otherwise match). The
            panel owns its own header + scrolling; we give it a filled flex
            column to sit in.

            A keyed record, not a ternary: this was `panel === "approvals" ? A :
            Autopilot`, which silently renders Autopilot for ANY panel that is
            not approvals — a third panel would have looked wired up and shown
            the wrong board. `Record<PanelId, …>` makes the next one a compile
            error instead. */}
        {urlPanel ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {
              (
                {
                  approvals: <ApprovalsPanel />,
                  goals: <AutopilotPanel />,
                  recordings: <RecordingsPanel />,
                } satisfies Record<PanelId, ReactNode>
              )[urlPanel]
            }
          </div>
        ) : null}
        {!urlPanel && !urlViewId && !activeError && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* Home IS the assistant's full-width "Suggested for you" surface;
                its slim build bar (onBuild) keeps the type-a-prompt page-build
                flow that the old centered hero used to own. The needs-you cards
                open Approvals / Autopilot as panel tabs (onOpenPanel). Spec:
                docs/architecture/features/home-dock.md. */}
            <SuggestedView
              workspaceId={workspaceId}
              assistantId={assistantId}
              userName={user.name}
              onOpenPanel={openPanelInNewTab}
              onBuild={(text) =>
                handleBuildPage(text, {
                  model: "pro",
                  researchMode: false,
                  fileIds: [],
                })
              }
            />
          </div>
        )}
        {!urlPanel && activeError && (
          <div className="m-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {activeError}
          </div>
        )}
        {urlViewId && !activeError && (
          <>
            {/* Row 2 chrome. `pageView` is the loaded metadata for THIS url; while
                it's still in flight (the brief post-switch window) we paint a
                height-matched skeleton instead of the real navbar — the editor
                below stays mounted and keeps syncing, so a switch never tears the
                whole centre pane down or flashes an empty "Loading…" state. */}
            {pageView ? (
              <PageHeader
                view={pageView}
                breadcrumb={breadcrumb}
                provider={collab.provider}
                status={collab.status}
                synced={collab.synced}
                onNavigate={navigateToView}
                onMutated={(next) => {
                  setActiveView(next);
                  if (next.state === "draft") {
                    recordPrune(next.id, next.autoPruneAt);
                  }
                  reloadSidebar();
                }}
                onDeleted={handleActiveDeletedFromHeader}
                onRenameValue={handleRenameValue}
                onDuplicate={handleDuplicate}
                onSaveAsTemplate={(id) => void handleSaveAsTemplate(id)}
                fullWidth={pageView.fullWidth}
                onToggleFullWidth={(next) =>
                  handleToggleFullWidth(pageView.id, next)
                }
                memberClearance={workspace.clearance}
                onChangeClearance={(next) =>
                  handleChangeClearance(pageView.id, next)
                }
                assistantId={assistantId}
                currentUser={user}
              />
            ) : (
              <div
                data-doc-chrome
                aria-hidden
                className="flex h-12 items-center border-b border-border pl-3 pr-2 md:pl-4 md:pr-3"
              >
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              </div>
            )}
            {isDraftLanding ? (
              // Empty, untouched draft → the blank-tab "What do you want to
              // see?" prompt instead of a title + comment band + bare editor.
              // A submit builds into THIS draft (`urlViewId`); the moment the
              // build starts, `isDraftLanding` flips false and the editor below
              // mounts so the construction streams onto the page body.
              <div className="flex-1 min-h-0 overflow-y-auto">
                <EmptyPageLanding
                  workspaceId={workspaceId}
                  assistantId={assistantId}
                  cards={landingCards}
                  onOpenCard={navigateToView}
                  onSubmitPrompt={(text, opts) =>
                    handleBuildPage(text, opts, urlViewId)
                  }
                  onStartBlank={() => handleStartBlankDraft(urlViewId)}
                  onStartFromTemplate={() => setLandingGalleryOpen(true)}
                />
              </div>
            ) : (
              <div
                data-comment-gutter={commentGutter > 0 ? "" : undefined}
                style={
                  commentGutter > 0 ? { paddingRight: commentGutter } : undefined
                }
                className="flex-1 min-h-0 overflow-y-auto overflow-x-clip px-4 py-4 transition-[padding] duration-200 md:px-10 md:py-6 lg:px-16"
              >
                {/* Page-width wrapper. Default (false) is a centered constrained
                    reading column (~720px via `.doc-page-content`); `true` is
                    the full pane width. The outer px-4 / md:px-10 / lg:px-16
                    padding above keeps gutters on both sides in both modes (so
                    full-width pages and moderate-width panes don't bleed to the
                    edge); the top bar stays full-bleed.
                    When the page has inline comments, `xl:pr` reserves a right
                    gutter (on wide screens) so the content shifts left and the
                    comment rail docks beside it. */}
                <div
                  className={
                    pageView?.fullWidth ? "w-full" : "doc-page-content"
                  }
                >
                  {/* The big editable title lives in the body (Notion-style),
                      since the navbar now shows the breadcrumb, not the title.
                      A skeleton title holds the same vertical space while the
                      page metadata resolves, so the body doesn't jump. */}
                  {pageView && templateAuthoringId === pageView.id ? (
                    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                      <span className="text-foreground">{t.templateAuthoringBanner}</span>
                      <span className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSaveAsTemplate(pageView.id, true)}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          {t.templateAuthoringFinish}
                        </button>
                        <button
                          type="button"
                          onClick={() => void discardTemplateAuthoring(pageView.id)}
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/60"
                        >
                          {t.templateAuthoringDiscard}
                        </button>
                      </span>
                    </div>
                  ) : null}
                  {pageView ? (
                    <PageTitle
                      name={pageView.name}
                      icon={pageView.icon}
                      fallback={derivePageIcon({
                        entity: pageView.entity,
                        viewType: pageView.viewType,
                        nameOrigin: pageView.nameOrigin,
                      })}
                      isPlaceholder={pageView.nameOrigin === "placeholder"}
                      canEdit
                      onRename={(name) => handleRenameValue(pageView.id, name)}
                      onSetIcon={(icon) => handleSetIcon(pageView.id, icon)}
                    />
                  ) : (
                    <div className="mb-4 flex flex-col gap-1" aria-hidden>
                      <div className="size-12" />
                      <div className="h-9 w-2/3 animate-pulse rounded bg-muted md:h-10" />
                    </div>
                  )}
                  <RecordingPlayerProvider
                    // Two ways a page gets a recording: a synthesis brief's
                    // `anchor_key` (`recording-synthesis:<id>`), or a MANUAL
                    // link a user set (`linkedRecordingId`, migration 339). The
                    // anchor-derived one wins — a real brief's recording is its
                    // identity, not a choice. Null on a page with neither, so
                    // the provider is inert and `[H:MM:SS]` text stays prose.
                    recordingId={
                      recordingIdFromAnchorKey(pageView?.anchorKey) ??
                      pageView?.linkedRecordingId ??
                      null
                    }
                  >
                  {/* The recording surface: player + transcript + action items,
                      as CHROME above the doc (never blocks — a block is content
                      the user can delete, orphaning the page's citations). See
                      recordings.md → "The brief page IS the recording surface".
                      When the page has NO recording, offer to link one. */}
                  {workspaceId && pageView
                    ? (() => {
                        const anchorRec = recordingIdFromAnchorKey(pageView.anchorKey);
                        const recId = anchorRec ?? pageView.linkedRecordingId;
                        if (!recId) {
                          return (
                            <RecordingLinkControl
                              viewId={pageView.id}
                              workspaceId={workspaceId}
                              onLinked={(meta) => setActiveView(meta)}
                            />
                          );
                        }
                        return (
                          <RecordingChrome
                            recordingId={recId}
                            workspaceId={workspaceId}
                            title={pageView.name ?? ""}
                            // Unlink only a MANUAL link — an anchor-derived
                            // recording is the brief's identity, nothing to
                            // re-link it to.
                            {...(anchorRec
                              ? {}
                              : {
                                  onUnlink: () => {
                                    void setPageLinkedRecording(pageView.id, null).then(setActiveView);
                                  },
                                })}
                          />
                        );
                      })()
                    : null}
                  <CollabPageEditor
                    collab={collab}
                    canEdit
                    user={user}
                    viewId={urlViewId}
                    nameOrigin={pageView?.nameOrigin}
                    onAutoTitled={(title, icon) =>
                      applyAutoTitle(urlViewId, title, icon)
                    }
                    assistantId={assistantId}
                    buildSlot={
                      buildingPageId === urlViewId ? <PageBuildIndicator /> : null
                    }
                    onCommentsPresenceChange={setPageHasComments}
                    onNewTemplate={() => void handleNewTemplate()}
                    seedTemplate={seedTemplate}
                    onTemplateSeeded={() => setSeedTemplate(null)}
                    onContentChange={handleDraftContentChange}
                  />
                  </RecordingPlayerProvider>
                </div>
              </div>
            )}
          </>
        )}
      </main>
      {/* The assistant chat dock is no longer mounted here — it lives once in
          `WorkspaceChrome` (the persistent workspace layout) so a turn keeps
          streaming across tab switches and the conversation is unified. This
          shell only publishes the page-collab guard into `docChatRelay`
          (above) for the hoisted dock to read. */}

      {/* Landing "Start from a template" picker — seeds a brand-new page from
          the chosen built-in or custom template. */}
      {landingGalleryOpen ? (
        <TemplateGallery
          customTemplates={landingCustomTemplates}
          onPick={(id) => void seedPageFromTemplate({ kind: "builtin", id })}
          onPickCustom={(id) => void seedPageFromTemplate({ kind: "custom", id })}
          onDeleteCustom={(id) => {
            void deleteCustomPageTemplate(workspaceId, id).then(() =>
              listCustomPageTemplates(workspaceId)
                .then(setLandingCustomTemplates)
                .catch(() => {}),
            );
          }}
          onNewTemplate={() => {
            setLandingGalleryOpen(false);
            void handleNewTemplate();
          }}
          onClose={() => setLandingGalleryOpen(false)}
        />
      ) : null}

      {/* Save-as-template metadata dialog (⋯ menu + the authoring banner's
          Finish step). The block snapshot is read in `submitSaveTemplate`. */}
      {saveTemplateFor ? (
        <SaveAsTemplateDialog
          initialName={saveTemplateFor.name}
          initialIcon={saveTemplateFor.icon}
          onSubmit={submitSaveTemplate}
          onClose={() => setSaveTemplateFor(null)}
        />
      ) : null}
    </div>
  );
}
