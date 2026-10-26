"use client";

/**
 * Left sidebar for the Doc surface — Notion-style nested sub-pages.
 *
 * A persistent icon rail switches workspace areas; its avatar opens the menu
 * directly, and the contextual panel keeps per-surface navigation. Home is Chat,
 * and App store discovers and pins mini-apps. Phones use labelled drawer rows.
 * Spec: docs/architecture/features/workspace-navigation.md.
 *
 * The tree DnD lives in a `<DndContext>` *scoped to this sidebar* —
 * deliberately separate from the page-renderer's block-reorder context
 * (root CLAUDE.md / task brief). Search is owned by WorkspaceChrome.
 *
 * Row expand/collapse state persists in `localStorage` keyed per
 * workspace (`doc:sidebar:collapsed:<workspaceId>`); section collapse
 * state likewise (`doc:sidebar:sections:<workspaceId>`).
 *
 * The parent (the `DocSidebarDataProvider` via `WorkspaceChrome`) owns all
 * data + mutations; this component renders + raises intent callbacks.
 *
 * [COMP:app-web/views-sidebar]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { inboxCacheKey, surfaceDataKey } from "@/lib/surface-prefetch";
import { listContextProjects } from "@/lib/api/context-scopes";
import {
  markSurfaceCacheStale,
  readSurfaceCache,
  useCachedResource,
} from "@/lib/surface-cache";
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  Users,
  Compass,
  Bell,
} from "lucide-react";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import type { CustomHomeApp } from "@/lib/api/home-apps";
import {
  sidebarSurfaceForHome,
  type HomeAppEntry,
} from "@/lib/operator-apps";
import { WorkspaceAppTitleHost } from "@/components/chrome/workspace-topbar";
import { WorkspaceAppRail } from "./workspace-app-rail";
import { WorkspaceSearchSlot } from "@/components/workspace-search/workspace-search-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format, useT } from "@/lib/i18n/client";
import { useIsOffline } from "@/lib/offline/use-offline-sync";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { type ViewListRow } from "@/lib/api/views";
import type { Teamspace } from "@/lib/api/teamspaces";
import {
  buildTree,
  dispatchReparentWithContextConfirmation,
  groupRowsBySharedProject,
  groupRowsByTeamspace,
  savedAncestorIds,
  type ContextAwareReparentMove,
  type TreeNode,
} from "@/lib/sidebar-tree";
import { parseSectionDropId, sectionDropId } from "@/lib/sidebar-sections";
import { fetchInbox, type InboxPayload } from "@/lib/api/inbox";
import { DOC_COMMENTS_CHANGED_EVENT } from "@/lib/comment-events";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { SidebarTreeNode, parseDropId } from "./sidebar-tree-node";
import { BrainSidebarPanel } from "./sidebar-panels/brain-sidebar-panel";
import { StudioSidebarPanel } from "./sidebar-panels/studio-sidebar-panel";
import { ProjectsSidebarPanel } from "@/components/projects/projects-navigation";
import { OrganizationSidebarPanel } from "./sidebar-panels/organization-sidebar-panel";
import { WorkflowSidebarPanel } from "./sidebar-panels/workflow-sidebar-panel";
import { FeedSidebarPanel } from "./sidebar-panels/feed-sidebar-panel";
import { TasksSidebarPanel } from "./sidebar-panels/tasks-sidebar-panel";
import { CrmSidebarPanel } from "./sidebar-panels/crm-sidebar-panel";
import { BrowsersSidebarPanel } from "./sidebar-panels/browsers-sidebar-panel";
import { ChatSidebarPanel } from "./sidebar-panels/chat-sidebar-panel";
import { OfficeSidebarPanel } from "./sidebar-panels/office-sidebar-panel";
import { ShopifySidebarPanel } from "./sidebar-panels/shopify-sidebar-panel";
import { LiveSidebarPanel } from "./sidebar-panels/live-sidebar-panel";
import { useLiveRoster } from "@/components/live/use-live-roster";
import { summarizeRosterItems } from "@/lib/live-roster";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

/**
 * Height of the workspace status row: 28px desktop / 44px phone plus safe area.
 * Shared by the slot this sidebar reserves and by the overlay
 * `WorkspaceChrome` lays over it, so the two halves cannot drift.
 */
export const WORKSPACE_STATUS_ROW_HEIGHT_CLASS =
  "h-[calc(2.75rem+env(safe-area-inset-bottom))] md:h-[calc(1.75rem+env(safe-area-inset-bottom))]";

export type SidebarMove = ContextAwareReparentMove;

/** Section-collapse localStorage key (per workspace) — the section analog of
 *  `collapseKey` below. Values: section key → collapsed (default expanded). */
function sectionsKey(workspaceId: string): string {
  return `doc:sidebar:sections:${workspaceId}`;
}

type Props = {
  workspaceId: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  saved: ViewListRow[];
  drafts: ViewListRow[];
  /** Teamspaces the viewer belongs to (General first) — one section each. */
  teamspaces: Teamspace[];
  /** Map of viewId → autoPruneAt for draft rows (the list endpoint omits it). */
  draftPruneByid: Record<string, string | null>;
  activeId: string | null;
  busyNewDraft: boolean;
  onSelect: (id: string) => void;
  /** Create a page: a teamspace id files it there, `null` = Private,
   *  omitted = the server default (General). */
  onNewDraft: (teamspaceId?: string | null, sharedProjectId?: string) => void;
  onAddChild: (parentId: string) => void;
  onSave: (id: string) => void;
  onUnsave: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** Drop ONTO a row (reparent under it), BETWEEN rows (reorder), or on a
   *  SECTION HEADER (file at that teamspace's root — `move.teamspaceId`). */
  onMove: (move: SidebarMove) => void;
  /** Open the "New teamspace" dialog (owned by the chrome). */
  onNewTeamspace: () => void;
  /** Open the teamspace settings modal on the given tab (owned by the chrome). */
  onTeamspaceSettings: (teamspaceId: string, tab: "general" | "members") => void;
  /** Leave a non-default teamspace (confirm + mutate in the provider). */
  onLeaveTeamspace: (teamspaceId: string) => void;
  /** Delete a non-default teamspace (confirm + mutate in the provider). */
  onDeleteTeamspace: (teamspaceId: string) => void;
  /** Whether the Inbox flyout panel is open (drives the nav row's active
   *  state). The panel itself is owned + rendered by the chrome. */
  inboxOpen: boolean;
  /** Toggle the Inbox flyout panel (replaces the old `/w/[id]/inbox` link). */
  onToggleInbox: () => void;
  /**
   * The active top-level surface (`surfaceFromPathname`) — highlights the
   * matching rail destination (Home is Chat). `null`
   * when no surface matches (e.g. the workspace root).
   */
  activeSurface: WorkspaceSurface | null;
  /** Active strip entry. On the explicit Suggested landing this remains the
   *  cached app underneath the briefing rather than pretending Page was used. */
  activeOperatorApp: HomeAppEntry | null;
  /** Keeps the sticky app's sidebar body mounted while the briefing is open. */
  suggestedOpen: boolean;
  /**
   * Studio cold-start nudge: `true` while the workspace has no connected
   * connector AND the per-workspace dismissal hasn't been set. Shows a subtle
   * "Set up" pill + dot on the Studio row.
   */
  studioNudge: boolean;
  /** Dismiss the Studio nudge (persists per workspace in localStorage). */
  onDismissStudioNudge: () => void;
  /** Workspace curation for App store, in
   *  order (`workspaces.home_apps`). Carried by `WorkspaceChrome` from the
   *  sidebar-data provider, which owns the fetch + live repair. */
  homeApps: readonly HomeAppEntry[];
  /** Custom app metadata and current renderability for App store. */
  customApps: readonly CustomHomeApp[];
};

function collapseKey(workspaceId: string): string {
  return `doc:sidebar:collapsed:${workspaceId}`;
}

export function DocSidebar(props: Props) {
  const copy = useT();
  const t = copy.docPage;
  // Teamspace management still requires a connection; pages can be created locally.
  const offline = useIsOffline();
  const { workspaceId, saved, drafts, activeId } = props;
  const activeOperatorApp = props.activeOperatorApp;
  // Suggested always routes through `/p`, but it is only borrowing Page's
  // content pane. Keep the sticky Home app's sidebar body underneath it so the
  // first daily landing cannot look like the sidebar failed to load.
  const sidebarSurface = sidebarSurfaceForHome(
    props.activeSurface,
    activeOperatorApp,
    props.suggestedOpen,
  );
  // Live is a persistent workspace signal, not only a destination. Keep its
  // roster subscription in the never-unmounting chrome so the top-level badge
  // updates while the user works on any surface. The Live sidebar receives the
  // same snapshot below instead of starting a second copy of this loader.
  const liveRoster = useLiveRoster(workspaceId);
  const liveActiveCount = summarizeRosterItems(liveRoster.items).active;
  // ── Inbox unread badge (pending assistant replies + unread mentions) ──
  // Reads the SAME slot the Inbox flyout fills (`inboxCacheKey`, instant-
  // navigation contract N2), so one request serves the badge and the flyout:
  // the flyout's per-row optimistic patches move the badge at once, its
  // revalidate-on-open lands here too, and `INBOX_REFRESH_EVENT` (T-H8, a
  // room `@mention` recorded from ANY tab, device, or teammate) reaches this
  // never-unmounting layout through the one spine map
  // (`surface-cache-invalidation.ts` -> `inbox:<wid>`), not a listener here.
  // `doc:inbox-changed` needs no listener either: its only dispatcher is the
  // flyout, and every site that dispatches it has already written the slot.
  // The two listeners kept are same-tab, non-spine signals that change the
  // count without touching the slot: the AI posting or resolving a comment
  // (`doc:comments-changed` moves the pending-reply count) and window focus;
  // both mark the slot stale so the count revalidates behind the paint.
  // A failed revalidation keeps the last count (the fetcher returns the
  // previous payload rather than rejecting, so a stale slot never re-runs
  // against a failing endpoint); a cold failure reads as no badge.
  const inboxKey = inboxCacheKey(workspaceId);
  const inbox = useLeasedResource<InboxPayload>(inboxKey, async () => {
    try {
      return await fetchInbox(workspaceId);
    } catch (err) {
      const previous = readSurfaceCache<InboxPayload>(inboxKey).data;
      if (previous !== undefined) return previous;
      throw err;
    }
  });
  const inboxCount = inbox.data
    ? inbox.data.pendingCount + inbox.data.unreadMentionCount
    : 0;
  useEffect(() => {
    const mark = () => markSurfaceCacheStale(inboxKey);
    window.addEventListener(DOC_COMMENTS_CHANGED_EVENT, mark);
    window.addEventListener("focus", mark);
    return () => {
      window.removeEventListener(DOC_COMMENTS_CHANGED_EVENT, mark);
      window.removeEventListener("focus", mark);
    };
  }, [inboxKey]);

  // ── Persisted expand/collapse state (per workspace) ─────────────────
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(collapseKey(workspaceId));
      setExpanded(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setExpanded({});
    }
  }, [workspaceId]);
  const toggleExpand = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = { ...prev, [id]: !(prev[id] ?? false) };
        try {
          window.localStorage.setItem(
            collapseKey(workspaceId),
            JSON.stringify(next),
          );
        } catch {
          // Non-fatal — expand state is a convenience, not load-bearing.
        }
        return next;
      });
    },
    [workspaceId],
  );

  // ── Persisted teamspace collapse state (per workspace) ──────────────
  // Keys: teamspace ids. `true` = collapsed; teamspaces default to EXPANDED
  // (a fresh workspace should show its page trees, not a wall of closed
  // headers). Private is not collapsible, so it has no key here.
  const [sectionCollapsed, setSectionCollapsed] = useState<
    Record<string, boolean>
  >({});
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(sectionsKey(workspaceId));
      setSectionCollapsed(
        raw ? (JSON.parse(raw) as Record<string, boolean>) : {},
      );
    } catch {
      setSectionCollapsed({});
    }
  }, [workspaceId]);
  const toggleSection = useCallback(
    (key: string) => {
      setSectionCollapsed((prev) => {
        const next = { ...prev, [key]: !(prev[key] ?? false) };
        try {
          window.localStorage.setItem(
            sectionsKey(workspaceId),
            JSON.stringify(next),
          );
        } catch {
          // Non-fatal — section state is a convenience, not load-bearing.
        }
        return next;
      });
    },
    [workspaceId],
  );

  // ── Derived sections ─────────────────────────────────────────────────
  // Group the full page set (saved ∪ drafts, so a freshly created sub-page
  // draft nests under its saved parent instead of stranding flat) by
  // teamspace, then fold ONE directory tree per section. A child renders
  // nested under whichever ancestor it belongs to, never at a section root —
  // unless its denormalized `teamspaceId` drifted from its parent's, in which
  // case `buildTree`'s orphan promotion roots it in its OWN section (visible
  // beats vanished).
  const allRows = useMemo(() => [...saved, ...drafts], [saved, drafts]);
  const rowsByTeamspace = useMemo(
    () => groupRowsByTeamspace(allRows),
    [allRows],
  );
  const sectionTrees = useMemo(() => {
    const trees = new Map<string, TreeNode[]>();
    for (const ts of props.teamspaces) {
      trees.set(ts.id, buildTree(rowsByTeamspace.get(ts.id) ?? []));
    }
    return trees;
  }, [props.teamspaces, rowsByTeamspace]);
  // Private = the caller's unfiled pages, PLUS any row referencing a
  // teamspace missing from the list (a mid-reload or drifted row) — the
  // crash-safe fallback so no visible row is ever dropped from the sidebar.
  const privateTree = useMemo(() => {
    const known = new Set(props.teamspaces.map((ts) => ts.id));
    const rows = [...(rowsByTeamspace.get(null) ?? [])];
    for (const [key, groupRows] of rowsByTeamspace) {
      if (key !== null && !known.has(key)) rows.push(...groupRows);
    }
    return buildTree(rows);
  }, [props.teamspaces, rowsByTeamspace]);
  // Pages filed inside a saved (Favorites) subtree are *kept by ancestry* —
  // the parent's save covers them, so they show no per-page "Save page" CTA
  // and the prune worker spares them (same rule, server-side). Derived once
  // over the full row set and read by every row renderer below.
  const keptByAncestry = useMemo(() => savedAncestorIds(allRows), [allRows]);
  // Shared Project collections (D25, project-shared-spaces.md -> "Pages"):
  // one per visible shared Project. The registry rides the viewer-keyed
  // Projects cache, which `workspace_config` signals mark stale.
  const projectRegistry = useCachedResource(surfaceDataKey("projects", workspaceId), () => listContextProjects(workspaceId, true));
  const sharedProjects = useMemo(() => (projectRegistry.data ?? []).filter((project) => project.shared), [projectRegistry.data]);
  const projectTrees = useMemo(() => {
    const groups = groupRowsBySharedProject(allRows);
    return new Map([...groups].map(([projectId, rows]) => [projectId, buildTree(rows)]));
  }, [allRows]);
  // ── DnD ──────────────────────────────────────────────────────────────
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
  }

  async function confirmAndMove(move: SidebarMove) {
    const moved = allRows.find((row) => row.id === move.viewId);
    await dispatchReparentWithContextConfirmation(
      allRows,
      move,
      () =>
        confirmDialog({
          title: t.moveContextConfirmTitle,
          description: format(t.moveContextConfirm, {
            name: moved?.name?.trim() || t.breadcrumbUntitled,
          }),
          confirmLabel: t.moveContextConfirmAction,
          cancelLabel: t.cancel,
        }),
      props.onMove,
    );
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = event;
    if (!over) return;
    const draggedId = String(active.id);

    // Section-header drop — file the dragged page (and, server-side, its
    // whole subtree) at that teamspace's root, appended after its roots.
    const section = parseSectionDropId(String(over.id));
    if (section) {
      const sectionRoots = allRows.filter(
        (r) =>
          r.nestParentId === null &&
          (r.teamspaceId ?? null) === section.teamspaceId,
      );
      await confirmAndMove({
        viewId: draggedId,
        nestParentId: null,
        position: sectionRoots.length,
        teamspaceId: section.teamspaceId,
      });
      return;
    }

    const target = parseDropId(String(over.id));
    if (!target) return;
    if (target.nodeId === draggedId) return; // dropped on self

    if (target.intent === "onto") {
      // Reparent under the target; append to the end of its children. The
      // child adopts the target's teamspace server-side — no teamspaceId here.
      const siblings = allRows.filter((r) => r.nestParentId === target.nodeId);
      await confirmAndMove({
        viewId: draggedId,
        nestParentId: target.nodeId,
        position: siblings.length,
      });
      return;
    }

    // intent === "after": reorder as a sibling directly after target. Root
    // siblings are scoped to the target's SECTION (root positions order
    // within a teamspace group), and the move carries that teamspace so a
    // cross-section gap drop files the page where it visually landed.
    const targetRow = allRows.find((r) => r.id === target.nodeId);
    if (!targetRow) return;
    const parentId = targetRow.nestParentId;
    const targetTeamspaceId = targetRow.teamspaceId ?? null;
    const siblings = allRows
      .filter((r) =>
        parentId === null
          ? r.nestParentId === null &&
            (r.teamspaceId ?? null) === targetTeamspaceId
          : r.nestParentId === parentId,
      )
      .sort((a, b) => a.position - b.position);
    const targetIdx = siblings.findIndex((r) => r.id === target.nodeId);
    // Insert after the target. The server re-packs positions, so a
    // 1-based "after" index is a safe target.
    await confirmAndMove({
      viewId: draggedId,
      nestParentId: parentId,
      position: targetIdx + 1,
      ...(parentId === null ? { teamspaceId: targetTeamspaceId } : {}),
    });
  }

  // One recursive tree row, shared by every section so they render
  // identically (chevron toggle, nesting, DnD); the node itself shows the
  // Save action + prune caption only on `state: 'draft'` rows.
  const renderRoot = (node: TreeNode) => (
    <SidebarTreeNode
      key={node.row.id}
      node={node}
      activeId={activeId}
      expanded={expanded}
      onToggleExpand={toggleExpand}
      onSelect={props.onSelect}
      onAddChild={props.onAddChild}
      onRename={props.onRename}
      onDuplicate={props.onDuplicate}
      onSave={props.onSave}
      onUnsave={props.onUnsave}
      onDelete={props.onDelete}
      draftPruneByid={props.draftPruneByid}
      keptByAncestry={keptByAncestry}
      onMoveToRoot={(id) => {
        // "Move to root" stays WITHIN the row's own section — appended after
        // that teamspace group's current roots.
        const moved = allRows.find((r) => r.id === id);
        const tsKey = moved?.teamspaceId ?? null;
        props.onMove({
          viewId: id,
          nestParentId: null,
          position: allRows.filter(
            (r) => r.nestParentId === null && (r.teamspaceId ?? null) === tsKey,
          ).length,
          teamspaceId: tsKey,
        });
      }}
      draggingId={draggingId}
    />
  );

  // A section's body — the tree, or a muted empty caption when expanded with
  // nothing inside (mirrors the per-row "No pages inside" treatment).
  const renderSectionBody = (nodes: TreeNode[]) =>
    nodes.length === 0 ? (
      <div className="select-none py-1 pl-7 pr-1 text-[13px] text-sidebar-foreground/40">
        {t.sidebarNoPagesInside}
      </div>
    ) : (
      <ul className="space-y-0.5">{nodes.map(renderRoot)}</ul>
    );

  return (
    <aside className="relative flex h-full w-full shrink-0 text-sidebar-foreground md:w-[calc(3.5rem+var(--workspace-sidebar-width,14rem))]">
      {/* One responsive menu/settings owner, anchored over the desktop rail head or
          the phone drawer head. It stays mounted while the panel collapses. */}
      <div data-workspace-menu-host data-doc-chrome className="absolute left-0 top-0 z-20 flex h-14 w-16 items-center justify-center md:top-3 md:h-16 md:w-14">
        <WorkspaceSwitcher iconOnly />
      </div>
      <WorkspaceAppRail workspaceId={workspaceId} activeSurface={props.activeSurface} activeApp={activeOperatorApp} homeApps={props.homeApps} customApps={props.customApps} liveCount={liveActiveCount} studioNudge={props.studioNudge} onDismissStudioNudge={props.onDismissStudioNudge} />
      <div id="workspace-context-sidebar" data-doc-context-sidebar className={`doc-sidebar-surface flex h-full min-w-0 flex-1 flex-col border-r border-sidebar-border md:mb-2 md:mt-3 md:h-[calc(100%-1.25rem)] md:w-[var(--workspace-sidebar-width,14rem)] md:flex-none md:rounded-l-2xl md:border-y md:border-l ${props.sidebarCollapsed ? "md:hidden" : ""}`}>
      <div data-doc-chrome data-workspace-context-heading className="flex h-14 md:h-16 shrink-0 items-center gap-1 px-2 md:px-4">
        <WorkspaceAppTitleHost className="pl-14 md:pl-0" />
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" data-inbox-trigger aria-haspopup="dialog" aria-controls="workspace-inbox" aria-expanded={props.inboxOpen} aria-label={t.iconInboxAria} aria-pressed={props.inboxOpen} title={t.iconInboxAria} onClick={props.onToggleInbox} className="relative flex size-11 items-center justify-center rounded-md text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground md:size-8">
            <Bell className="size-[18px]" aria-hidden />
            {inboxCount > 0 && <span aria-label={format(t.iconInboxBadgeAria, { count: inboxCount })} className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
          </button>
          {!props.sidebarCollapsed && <div className="hidden md:block"><WorkspaceSearchSlot placement="sidebar" /></div>}
        </div>
        {/* Invite members, first-class in the drawer head on a phone
            (responsive contract M1; plan §6 decision 1): hamburger, Invite,
            form = 3 taps, the same as desktop, instead of going through the
            switcher popover. Opens the same Members section the popover's
            button opens and closes the drawer (M7). Hidden from `md`, where
            the popover button is one click away. */}
        <button
          type="button"
          onClick={() => {
            openWorkspaceSettings("ws-members");
            requestSidebarClose();
          }}
          aria-label={copy.workspaceSwitcher.inviteMembers}
          title={copy.workspaceSwitcher.inviteMembers}
          data-sidebar-invite
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:hidden"
        >
          <UserPlus className="size-[18px]" aria-hidden />
        </button>
      </div>

      <WorkspaceAppRail mobile workspaceId={workspaceId} activeSurface={props.activeSurface} activeApp={activeOperatorApp} homeApps={props.homeApps} customApps={props.customApps} liveCount={liveActiveCount} studioNudge={props.studioNudge} onDismissStudioNudge={props.onDismissStudioNudge} />

      <div className="doc-sidebar-scroll flex-1 min-h-0 overflow-y-auto px-2 pb-4 pt-2 md:px-3">
        {/* Surface-aware body. Suggested borrows `/p` for its content pane but
            resolves this body from the sticky Home app, so first load keeps the
            selected app's navigation visible. Page shows the page tree; Office
            / Brain / Studio / Workflow / Tasks / CRM / Browsers / Chat /
            Organization swap in
            their own panel; every other surface renders nothing here. */}
        {sidebarSurface === "office" ? (
          <OfficeSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "brain" ? (
          <BrainSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "studio" ? (
          <StudioSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "workflow" ? (
          <WorkflowSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "feed" ? (
          <FeedSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "tasks" ? (
          <TasksSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "crm" ? (
          <CrmSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "computer" ? (
          <BrowsersSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "chat" ? (
          <ChatSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "shopify" ? (
          <ShopifySidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "projects" ? (
          <ProjectsSidebarPanel key={workspaceId} workspaceId={workspaceId} />
        ) : sidebarSurface === "organization" ? (
          <OrganizationSidebarPanel workspaceId={workspaceId} />
        ) : sidebarSurface === "live" ? (
          <LiveSidebarPanel
            workspaceId={workspaceId}
            roster={liveRoster}
            inboxOpen={props.inboxOpen}
            inboxCount={inboxCount}
            onToggleInbox={props.onToggleInbox}
          />
        ) : null}

        {sidebarSurface === "p" && (
          <>
        {/* Teamspace sections + Private — one nested tree per section (saved
            and draft rows together; drafts keep their prune captions). A
            single `<DndContext>` spans every section so a row can be dragged
            between them, and each section HEADER is a drop zone that files
            the page at that section's root. */}
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {/* "Teamspaces" group label — wraps every teamspace row, with a
                hover `⋯` housing "New teamspace" (no collapse-all: the group
                itself never folds, only individual teamspaces do). */}
            <TeamspacesGroupHeader
              onNewTeamspace={props.onNewTeamspace}
              disabled={offline}
              offlineTitle={offline ? t.offlineUnavailable : undefined}
            />

            {props.teamspaces.map((ts) => (
              <TeamspaceRow
                key={ts.id}
                teamspace={ts}
                collapsed={sectionCollapsed[ts.id] ?? false}
                onToggle={() => toggleSection(ts.id)}
                onNewPage={() => props.onNewDraft(ts.id)}
                newPageDisabled={props.busyNewDraft}
                dragging={draggingId !== null}
                onOpenSettings={(tab) => props.onTeamspaceSettings(ts.id, tab)}
                onLeave={() => props.onLeaveTeamspace(ts.id)}
                onDelete={() => props.onDeleteTeamspace(ts.id)}
              >
                {/* Stable Brief entry for a Department-owned teamspace
                    (project-briefs.md); identity is the Department, not a page title. */}
                {ts.workspaceGroupId ? (
                  <Link
                    href={`/w/${props.workspaceId}/briefs/department/${ts.workspaceGroupId}`}
                    className="flex min-h-8 items-center gap-1.5 rounded px-2 text-sm text-sidebar-foreground/80 hover:bg-muted max-sm:min-h-11"
                  >
                    <Compass className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{copy.briefs.departmentEntry}</span>
                  </Link>
                ) : null}
                {renderSectionBody(sectionTrees.get(ts.id) ?? [])}
              </TeamspaceRow>
            ))}

            {/* Projects — shared Project collections. A page here is shared
                with that Project's participants; moves in or out are refused
                server-side, so these sections are not drop targets. */}
            {sharedProjects.length > 0 || projectTrees.size > 0 ? (
              <section className="mt-4" aria-label={copy.contextScope.sharedProjects.pagesSection}>
                <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
                  {copy.contextScope.sharedProjects.pagesSection}
                </div>
                {[...sharedProjects.map((project) => ({ id: project.id, name: project.name, writable: project.status === "active"
                    && (project.shared?.myRole === "owner" || project.shared?.myRole === "participant") })),
                  ...[...projectTrees.keys()].filter((id) => !sharedProjects.some((p) => p.id === id))
                    .map((id) => ({ id, name: copy.contextScope.sharedProjects.badge, writable: false }))]
                  .map((project) => (
                  <div key={project.id} className="group/proj">
                    <div className="flex items-center rounded px-1">
                      <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/80" title={project.name}>{project.name}</span>
                      {project.writable ? (
                        <button
                          type="button"
                          aria-label={format(copy.contextScope.sharedProjects.newProjectPage, { name: project.name })}
                          disabled={props.busyNewDraft}
                          onClick={() => props.onNewDraft(undefined, project.id)}
                          className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground opacity-100 hover:bg-muted hover:text-foreground disabled:opacity-50 md:size-5 md:opacity-0 md:group-hover/proj:opacity-100"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                    {renderSectionBody(projectTrees.get(project.id) ?? [])}
                  </div>
                ))}
              </section>
            ) : null}

            {/* Private — the caller's unfiled pages (`teamspaceId: null`), a
                plain group label + `+` (create private) + drop zone (drag a
                page here to make it private). No manage menu. */}
            <PrivateGroupSection
              onNewPage={() => props.onNewDraft(null)}
              newPageDisabled={props.busyNewDraft}
              dragging={draggingId !== null}
            >
              {privateTree.length > 0 && (
                <ul className="space-y-0.5">{privateTree.map(renderRoot)}</ul>
              )}
            </PrivateGroupSection>
          </DndContext>
          </>
        )}
      </div>

      {/* The single persistent footer overlays this phone-only reserved slot.
          Desktop theme and sync controls occupy the leftmost app rail. */}
      <div data-doc-sidebar-footer-slot aria-hidden className="shrink-0 md:hidden">
        <div className="h-11" />
        <div className={WORKSPACE_STATUS_ROW_HEIGHT_CLASS} />
      </div>
      </div>
    </aside>
  );
}

/**
 * The "Teamspaces" group label — a single uppercase heading above every
 * teamspace row (Notion's group header). It deliberately does NOT collapse
 * the whole group (only individual teamspaces fold); its one action is a
 * hover-revealed `⋯` housing "New teamspace", so the create affordance lives
 * in the menu rather than an always-on button.
 *
 * [COMP:app-web/teamspace-sections]
 */
function TeamspacesGroupHeader({
  onNewTeamspace,
  disabled,
  offlineTitle,
}: {
  onNewTeamspace: () => void;
  disabled: boolean;
  offlineTitle?: string;
}) {
  const t = useT().docPage;
  return (
    <div className="group/tsgroup mt-1 mb-1 flex items-center px-1">
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
        {t.sidebarTeamspacesGroup}
      </span>
      {/* Visible at rest on a phone (responsive contract M2: "New teamspace"
          has no other entry point), hover-revealed from `md`. */}
      <div className="flex items-center opacity-100 transition-opacity md:pointer-events-none md:opacity-0 md:group-hover/tsgroup:opacity-100 md:group-hover/tsgroup:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={t.sidebarTeamspacesMenuAria}
                className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground md:size-5"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem
              disabled={disabled}
              onClick={onNewTeamspace}
              {...(offlineTitle ? { title: offlineTitle } : {})}
            >
              {t.sidebarNewTeamspace}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * One teamspace, rendered in the **page-row** treatment (icon + normal-case
 * title, not the uppercase section-label look) so it reads like the pages
 * beneath it. Differences from a page row: clicking the row toggles
 * collapse/expand instead of navigating (a teamspace has no page view), and
 * the whole row is a DROP ZONE (`sectionDropId`) that files a dropped page at
 * this teamspace's root. Hover reveals the teamspace `⋯` (Add members /
 * Settings / Leave / Delete via `TeamspaceSectionMenu`) then `+` (new page
 * here), out of flow like a page row's actions. Its child page tree renders
 * indented beneath so the nesting reads.
 *
 * [COMP:app-web/teamspace-sections]
 */
function TeamspaceRow({
  teamspace,
  collapsed,
  onToggle,
  onNewPage,
  newPageDisabled,
  newPageTitle,
  dragging,
  onOpenSettings,
  onLeave,
  onDelete,
  children,
}: {
  teamspace: Teamspace;
  collapsed: boolean;
  onToggle: () => void;
  onNewPage: () => void;
  newPageDisabled: boolean;
  newPageTitle?: string;
  /** True while any sidebar row is being dragged (hides hover actions). */
  dragging: boolean;
  onOpenSettings: (tab: "general" | "members") => void;
  onLeave: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const t = useT().docPage;
  const drop = useDroppable({ id: sectionDropId(teamspace.id) });
  const title = teamspace.name?.trim() ? teamspace.name : t.breadcrumbUntitled;
  return (
    <>
      <div
        ref={drop.setNodeRef}
        className={[
          "group/row relative flex items-center gap-0.5 rounded-md pr-1 text-sm",
          "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          drop.isOver ? "ring-1 ring-primary" : "",
        ].join(" ")}
      >
        {/* Leading icon↔chevron toggle, exactly like a page row — the
            teamspace icon (emoji or a default) at rest, swapping to a
            disclosure chevron on hover (rotated when expanded). Clicking it
            (or the title) folds the teamspace. */}
        <div className="flex h-7 shrink-0 items-center self-stretch pl-1">
          <button
            type="button"
            aria-label={collapsed ? t.sidebarExpandAria : t.sidebarCollapseAria}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="relative flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <span className="flex items-center justify-center opacity-100 transition-opacity md:group-hover/row:opacity-0">
              {teamspace.icon ? (
                <span className="text-[15px] leading-none">{teamspace.icon}</span>
              ) : (
                <Users className="size-4 text-sidebar-foreground/55" />
              )}
            </span>
            <ChevronRight
              aria-hidden
              className={[
                // The icon<->chevron swap is a hover affordance; a finger has
                // no hover, so below `md` the icon stays and the chevron is
                // not rendered (the toggle's aria-label carries the state).
                "absolute inset-0 m-auto size-3.5 transition-[transform,opacity] max-md:hidden md:opacity-0 md:group-hover/row:opacity-100",
                collapsed ? "" : "rotate-90",
              ].join(" ")}
            />
          </button>
        </div>

        {/* Title — toggles collapse (a teamspace has no page view to open).
            State is conveyed by the leading toggle's aria-label (mirroring
            the page rows), so no aria-expanded here — that attribute is
            reserved for the `⋯` trigger, which the hover-keep-open selector
            below keys off. Pads right on hover to clear the out-of-flow
            actions. */}
        <button
          type="button"
          onClick={onToggle}
          title={title}
          className="flex min-w-0 flex-1 items-center py-1 pr-[4.5rem] text-left md:pr-0 md:group-hover/row:pr-14 md:group-focus-within/row:pr-14"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        </button>

        {/* Hover actions — teamspace `⋯` then `+` (new page here). Also
            revealed while the `⋯` menu is open (`has-[aria-expanded]`, which
            in this row can only be the dropdown trigger). */}
        {!dragging && (
          <div className="absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 opacity-100 transition-opacity md:pointer-events-none md:opacity-0 md:group-hover/row:opacity-100 md:group-hover/row:pointer-events-auto md:group-focus-within/row:opacity-100 md:group-focus-within/row:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto">
            <TeamspaceSectionMenu
              teamspace={teamspace}
              onOpenSettings={onOpenSettings}
              onLeave={onLeave}
              onDelete={onDelete}
            />
            <button
              type="button"
              aria-label={t.sidebarSectionNewPageAria}
              disabled={newPageDisabled}
              title={newPageTitle}
              onClick={(e) => {
                e.stopPropagation();
                onNewPage();
              }}
              className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 md:size-6"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {/* Child pages, indented so the nesting under the teamspace reads. */}
      {!collapsed && <div className="pl-3">{children}</div>}
    </>
  );
}

/**
 * The "Private" group — the caller's unfiled (`teamspaceId: null`) pages. A
 * plain uppercase group label (not a page row: Private is not a teamspace and
 * has nothing to manage), carrying a hover `+` to create a private page and a
 * drop zone so dragging a page here privatises it. The page tree renders
 * directly beneath; the whole group is hidden when the caller has no private
 * pages. Always visible (Notion's model): it is both the create affordance
 * for a private page (`+`) and the drop target that privatises a dragged page,
 * so it can't be hidden when empty or there'd be no way to reach it.
 */
function PrivateGroupSection({
  onNewPage,
  newPageDisabled,
  newPageTitle,
  dragging,
  children,
}: {
  onNewPage: () => void;
  newPageDisabled: boolean;
  newPageTitle?: string;
  dragging: boolean;
  children: React.ReactNode;
}) {
  const t = useT().docPage;
  const drop = useDroppable({ id: sectionDropId(null) });
  return (
    <section className="mt-4">
      <div
        ref={drop.setNodeRef}
        className={[
          "group/priv mb-1 flex items-center rounded px-1",
          drop.isOver ? "ring-1 ring-primary" : "",
        ].join(" ")}
      >
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
          {t.sidebarPrivate}
        </span>
        {!dragging && (
          <div className="flex items-center opacity-100 transition-opacity md:pointer-events-none md:opacity-0 md:group-hover/priv:opacity-100 md:group-hover/priv:pointer-events-auto">
            <button
              type="button"
              aria-label={t.sidebarSectionNewPageAria}
              disabled={newPageDisabled}
              title={newPageTitle}
              onClick={(e) => {
                e.stopPropagation();
                onNewPage();
              }}
              className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 md:size-5"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * The section-header `⋯` menu for a teamspace. Management entries (Add
 * members / Teamspace settings / Delete) show only with `canManage` — the
 * single management gate off the list response. Leave shows for ANY member
 * on a non-default teamspace; Delete additionally needs `canManage`. The
 * General (default) teamspace can be neither left nor deleted, so a plain
 * General member gets no menu at all (returns null → `+` only).
 */
function TeamspaceSectionMenu({
  teamspace,
  onOpenSettings,
  onLeave,
  onDelete,
}: {
  teamspace: Teamspace;
  onOpenSettings: (tab: "general" | "members") => void;
  onLeave: () => void;
  onDelete: () => void;
}) {
  const t = useT().docPage;
  const canManage = teamspace.canManage;
  const canLeave = !teamspace.isDefault;
  const canDelete = canManage && !teamspace.isDefault;
  if (!canManage && !canLeave) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t.teamspaceMenuAria}
            onClick={(e) => e.stopPropagation()}
            className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground md:size-5"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        }
      />
      <DropdownMenuContent>
        {canManage && (
          <>
            <DropdownMenuItem onClick={() => onOpenSettings("members")}>
              {t.teamspaceMenuAddMembers}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenSettings("general")}>
              {t.teamspaceMenuSettings}
            </DropdownMenuItem>
          </>
        )}
        {canLeave && (
          <DropdownMenuItem onClick={onLeave}>
            {t.teamspaceMenuLeave}
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              {t.teamspaceMenuDelete}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
