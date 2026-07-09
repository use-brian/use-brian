"use client";

/**
 * Left sidebar for the Doc surface — Notion-style nested sub-pages.
 *
 * Top to bottom:
 *  - Workspace switcher (existing pill).
 *  - Top nav — a horizontal Notion-style icon toolbar, left to right: Home
 *    (→ `/w/[id]/p`), then the SURFACE rows Brain (→ `/w/[id]/brain`), Studio
 *    (→ `/studio`), Workflow (→ `/workflow`), then the utilities
 *    Inbox (toggles the left-anchored Inbox flyout panel — owned by the chrome —
 *    with an unread-count badge) and Search (toggles a client-side title filter).
 *    Items are icon-only with a hover/focus tooltip (name + ⌘ shortcut); exactly
 *    ONE item at a time expands into a labeled `.doc-nav-active` pill (icon +
 *    name), the way Notion emphasizes the current section. Normally that's the
 *    active surface (`activeSurface`, via `surfaceFromPathname`); when a utility
 *    toggle (Inbox / Search) is open IT owns the pill instead and the surface
 *    drops to a highlighted icon, so a label can never collide with a second
 *    pill and truncate. Studio shows a dismissable cold-start "Set up" nudge
 *    while the workspace has no connected connector.
 *  - Teamspace sections (docs/architecture/features/teamspaces.md) — one
 *    collapsible section per teamspace the viewer belongs to (icon +
 *    name), each rendering ITS OWN nested tree (`buildTree` over that
 *    teamspace's saved + draft rows via `groupRowsByTeamspace`; draft
 *    rows keep their save/prune affordances). Section hover reveals `⋯`
 *    (Add members / Settings / Leave / Delete, gated by `canManage` /
 *    `isDefault`) and `+` (new page in that teamspace). Drag a row ONTO
 *    another to nest it; drop in the gap BETWEEN rows to reorder; drop
 *    on a SECTION HEADER to file the page at that section's root.
 *  - A subtle "New teamspace" affordance under the teamspace block.
 *  - Private — the caller's `teamspaceId === null` pages, same tree
 *    treatment, `+` only (creates with `teamspaceId: null`).
 *
 * The tree DnD lives in a `<DndContext>` *scoped to this sidebar* —
 * deliberately separate from the page-renderer's block-reorder context
 * (root CLAUDE.md / task brief). Search is a lightweight substring
 * filter over loaded rows, not a Cmd-K palette (its flat hit list is
 * NOT sectioned by teamspace).
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
import { Tooltip } from "@/components/ui/tooltip";
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
  Brain,
  ChevronRight,
  GitBranch,
  Home,
  Inbox,
  Megaphone,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
} from "lucide-react";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/client";
import { useIsOffline } from "@/lib/offline/use-offline-sync";
import { useTheme, THEME_PRESETS, currentPresetId } from "@/lib/theme";
import { useCustomThemes } from "@/lib/custom-themes";
import { CreateThemeDialog } from "@/components/doc/create-theme-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import type { DocTheme } from "@/lib/api/doc-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { derivePageIcon, type ViewListRow } from "@/lib/api/views";
import type { Teamspace } from "@/lib/api/teamspaces";
import {
  buildTree,
  groupRowsByTeamspace,
  savedAncestorIds,
  type TreeNode,
} from "@/lib/sidebar-tree";
import { parseSectionDropId, sectionDropId } from "@/lib/sidebar-sections";
import { surfaceShortcutLabel } from "@/lib/surface-shortcuts";
import { fetchInboxBadgeCount } from "@/lib/api/inbox";
import { INBOX_CHANGED_EVENT } from "@/lib/inbox-events";
import { DOC_COMMENTS_CHANGED_EVENT } from "@/lib/comment-events";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { DocSidebarRow } from "./doc-sidebar-row";
import { HomeDock } from "./home-dock";
import { SidebarTreeNode, parseDropId } from "./sidebar-tree-node";
import { EmptySearchResults } from "./empty-states";
import { BrainSidebarPanel } from "./sidebar-panels/brain-sidebar-panel";
import { StudioSidebarPanel } from "./sidebar-panels/studio-sidebar-panel";
import { WorkflowSidebarPanel } from "./sidebar-panels/workflow-sidebar-panel";
import { FeedSidebarPanel } from "./sidebar-panels/feed-sidebar-panel";

export type SidebarMove = {
  viewId: string;
  nestParentId: string | null;
  /** Target sibling index among the new parent's children. */
  position: number;
  /**
   * Target teamspace for a ROOT drop (`nestParentId: null`): a teamspace id
   * files the page into that section, `null` files it Private, omitted keeps
   * the current teamspace. Ignored when `nestParentId` is a page — the child
   * adopts the parent's teamspace server-side.
   */
  teamspaceId?: string | null;
};

/** Section-collapse localStorage key (per workspace) — the section analog of
 *  `collapseKey` below. Values: section key → collapsed (default expanded). */
function sectionsKey(workspaceId: string): string {
  return `doc:sidebar:sections:${workspaceId}`;
}

type Props = {
  workspaceId: string;
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
  onNewDraft: (teamspaceId?: string | null) => void;
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
   * matching nav row (Brain / Studio / Workflow, and Home for `'p'`). `null`
   * when no surface matches (e.g. the workspace root).
   */
  activeSurface: WorkspaceSurface | null;
  /**
   * Studio cold-start nudge: `true` while the workspace has no connected
   * connector AND the per-workspace dismissal hasn't been set. Shows a subtle
   * "Set up" pill + dot on the Studio row.
   */
  studioNudge: boolean;
  /** Dismiss the Studio nudge (persists per workspace in localStorage). */
  onDismissStudioNudge: () => void;
  /**
   * Whether the Feed surface is available for this workspace (hosted edition
   * AND at least one connected distribution profile — the `feedProfiles`
   * probe in `DocSidebarDataProvider`). Gates the Feed nav row; the routes
   * themselves stay deep-linkable for trial onboarding.
   */
  feedEnabled: boolean;
};

function collapseKey(workspaceId: string): string {
  return `doc:sidebar:collapsed:${workspaceId}`;
}

/**
 * Classes for a horizontal nav item. Three states:
 *  - `!active`            -> 28px icon-only square (with hover wash).
 *  - `active && labeled`  -> a `.doc-nav-active` pill (icon + name), visibly
 *                            larger, the way Notion emphasizes the current item.
 *  - `active && !labeled` -> the active background but still icon-only (the
 *                            highlighted-but-not-the-pill state).
 *
 * Callers enforce a single-pill invariant (see `surfacePill`/`searchPill`/
 * `inboxPill`): at most one item is ever `labeled`, so the one label fits and
 * two pills can't collide and truncate. `transition-all` eases the bg/grow.
 */
function navItemCls(active: boolean, labeled: boolean): string {
  const base =
    "inline-flex h-7 shrink-0 items-center rounded-md text-sidebar-foreground/65 transition-all";
  if (active && labeled) {
    return `${base} doc-nav-active gap-1.5 px-2 text-[13px] font-medium text-sidebar-accent-foreground`;
  }
  if (active) {
    return `${base} w-7 justify-center doc-nav-active text-sidebar-accent-foreground`;
  }
  return `${base} w-7 justify-center hover:bg-sidebar-accent hover:text-sidebar-accent-foreground`;
}

export function DocSidebar(props: Props) {
  const t = useT().docPage;
  // Creating a page isn't supported offline (no server id) — disable the entry
  // in the bundled app when offline. No-op on web/thin (gate keeps it false).
  const offline = useIsOffline();
  const { workspaceId, saved, drafts, activeId } = props;

  // ── Inbox unread badge (pending assistant replies + unread mentions) ──
  // Refetched on mount, on window focus, when the Inbox marks items read
  // (`doc:inbox-changed`), and when the AI posts/resolves a comment
  // (`doc:comments-changed` — that changes the pending-reply count).
  const [inboxCount, setInboxCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetchInboxBadgeCount(workspaceId).then((n) => {
        if (!cancelled) setInboxCount(n);
      });
    };
    refresh();
    window.addEventListener(INBOX_CHANGED_EVENT, refresh);
    window.addEventListener(DOC_COMMENTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(INBOX_CHANGED_EVENT, refresh);
      window.removeEventListener(DOC_COMMENTS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [workspaceId]);

  // ── Search filter (lightweight client-side substring) ───────────────
  // The page-title search only makes sense on Home (`'p'`), where the page tree
  // is the body. Close + clear it when leaving Home so the single-pill nav logic
  // (`searchPill` → `utilityPillOpen`) can't get stuck open on another surface.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (props.activeSurface !== "p") {
      setSearchOpen(false);
      setQuery("");
    }
  }, [props.activeSurface]);

  // ── One labeled pill at a time (keeps the row inside the ~240px bar) ──
  // The active surface is normally THE pill (Notion-style "current section").
  // But Inbox / Search are toggles a user opens *while on* a surface, so when
  // one is open it owns the pill (full label) and the surface drops to a
  // highlighted icon. Search wins if both are somehow open. So at most one
  // label ever shows -> two pills can never collide and truncate (the "Sea" bug).
  const searchPill = searchOpen;
  const inboxPill = props.inboxOpen && !searchOpen;
  const utilityPillOpen = searchPill || inboxPill;
  /** True when surface `s` is the current route. */
  const surfaceActive = (s: WorkspaceSurface) => props.activeSurface === s;
  /** True when surface `s` should render as the labeled pill (no utility owns it). */
  const surfacePill = (s: WorkspaceSurface) => surfaceActive(s) && !utilityPillOpen;
  const matches = useCallback(
    (row: ViewListRow) => !q || row.name.toLowerCase().includes(q),
    [q],
  );

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
  // Search stays a flat hit list (the tree's nesting would otherwise bury a
  // match under a collapsed parent) — saved hits and draft hits, each in its
  // own section so the prune captions + Save affordance stay correct.
  const searchHits = useMemo(
    () => (q ? saved.filter(matches) : []),
    [q, saved, matches],
  );
  const draftHits = useMemo(
    () => (q ? drafts.filter(matches) : []),
    [q, drafts, matches],
  );

  // ── DnD ──────────────────────────────────────────────────────────────
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
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
      props.onMove({
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
      props.onMove({
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
    props.onMove({
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
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border doc-sidebar-surface text-sidebar-foreground">
      {/* Workspace switcher. In the desktop shell this row is the title-bar
          head: it drops below the macOS traffic lights and is an OS window-drag
          handle (the switcher button itself opts back out) — see the
          `.is-canvas-desktop` block in globals.css. */}
      <div data-doc-chrome data-doc-sidebar-head className="flex items-center px-2 pt-2.5 pb-1">
        <WorkspaceSwitcher />
      </div>

      {/* Top nav — horizontal icon toolbar (Notion-style). Every item is an icon
          with a hover/focus tooltip (name + ⌘ shortcut); exactly ONE item at a
          time expands into a labeled `.doc-nav-active` pill that spells out its
          name (see `searchPill`/`inboxPill`/`surfacePill` above) — the way Notion
          emphasizes the current section. Order: Home / Brain / Studio / Workflow
          (primary surfaces), then Inbox / Search (utilities). When a utility is
          open it owns the pill and the current surface stays a highlighted icon,
          so a long label can't collide with a second pill and truncate. `pt-1`
          keeps the Inbox/Studio corner badges off the top edge.
          `data-doc-chrome`: in the desktop shell this whole title-bar zone is an
          OS window-drag handle, so the gaps between icons and the empty space to
          the right of Search drag the window; the icon links/buttons opt back out
          via the `[data-doc-chrome] :is(a, button, …)` rule in globals.css. */}
      <nav data-doc-chrome className="flex flex-row items-center gap-0.5 px-2 pt-1 pb-1.5">
        {/* Home — first of the ⌘/Ctrl+1/2/3/4 surface shortcuts (wired in
            WorkspaceChrome). The chip label is browser-dependent
            (`surfaceShortcutLabel`): ⌘n on mac, ⌃n on mac Firefox (which
            reserves ⌘+digit for tab switching), Ctrl+n elsewhere. */}
        <Tooltip label={t.iconHome} shortcut={surfaceShortcutLabel(1)}>
          <Link
            href={`/w/${workspaceId}/p`}
            aria-label={t.iconHomeAria}
            className={navItemCls(surfaceActive("p"), !utilityPillOpen)}
          >
            <Home className="size-[17px] shrink-0" />
            {surfacePill("p") ? (
              <span className="whitespace-nowrap">{t.iconHome}</span>
            ) : null}
          </Link>
        </Tooltip>

        {/* Surface destinations (consolidation §4) — Brain / Studio / Workflow,
            with ⌘/Ctrl+2/3/4 shortcuts (wired in WorkspaceChrome). Studio shows
            the cold-start nudge dot until the workspace connects its first tool. */}
        <Tooltip label={t.iconBrain} shortcut={surfaceShortcutLabel(2)}>
          <Link
            href={`/w/${workspaceId}/brain`}
            aria-label={t.iconBrainAria}
            className={navItemCls(surfaceActive("brain"), !utilityPillOpen)}
          >
            <Brain className="size-[17px] shrink-0" />
            {surfacePill("brain") ? (
              <span className="whitespace-nowrap">{t.iconBrain}</span>
            ) : null}
          </Link>
        </Tooltip>
        <Tooltip label={t.iconStudio} shortcut={surfaceShortcutLabel(3)}>
          <Link
            href={`/w/${workspaceId}/studio`}
            aria-label={t.iconStudioAria}
            className={navItemCls(surfaceActive("studio"), !utilityPillOpen) + " relative"}
          >
            <SlidersHorizontal className="size-[17px] shrink-0" />
            {surfacePill("studio") ? (
              <span className="whitespace-nowrap">{t.iconStudio}</span>
            ) : null}
            {props.studioNudge ? (
              <span
                aria-label={t.studioSetupNudgeAria}
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar"
              />
            ) : null}
          </Link>
        </Tooltip>
        <Tooltip label={t.iconWorkflow} shortcut={surfaceShortcutLabel(4)}>
          <Link
            href={`/w/${workspaceId}/workflow`}
            aria-label={t.iconWorkflowAria}
            className={navItemCls(surfaceActive("workflow"), !utilityPillOpen)}
          >
            <GitBranch className="size-[17px] shrink-0" />
            {surfacePill("workflow") ? (
              <span className="whitespace-nowrap">{t.iconWorkflow}</span>
            ) : null}
          </Link>
        </Tooltip>
        {/* Feed — the ported feed-web operator app. Hosted-only and shown only
            when the workspace has a connected distribution profile
            (`feedEnabled`); the routes stay deep-linkable regardless. */}
        {props.feedEnabled ? (
          <Tooltip label={t.iconFeed} shortcut="⌘5">
            <Link
              href={`/w/${workspaceId}/feed`}
              aria-label={t.iconFeedAria}
              className={navItemCls(surfaceActive("feed"), !utilityPillOpen)}
            >
              <Megaphone className="size-[17px] shrink-0" />
              {surfacePill("feed") ? (
                <span className="whitespace-nowrap">{t.iconFeed}</span>
              ) : null}
            </Link>
          </Tooltip>
        ) : null}
        {/* Goals board (`/goals`) deliberately has NO nav slot — like Approvals,
            it is attention-routed: the home-dock Autopilot card + the Brain task
            panel are its entry points (docs/architecture/features/goals.md). */}

        {/* Utilities — Inbox (toggles the flyout) + Search (client-side filter).
            Either expands to its full label when open (and owns the single pill). */}
        <Tooltip label={t.iconInbox}>
          <button
            type="button"
            aria-label={t.iconInboxAria}
            aria-pressed={props.inboxOpen}
            onClick={props.onToggleInbox}
            className={navItemCls(props.inboxOpen, inboxPill) + " relative"}
          >
            <Inbox className="size-[17px] shrink-0" />
            {inboxPill ? (
              <span className="whitespace-nowrap">{t.iconInbox}</span>
            ) : null}
            {inboxCount > 0 ? (
              <span
                aria-label={t.iconInboxBadgeAria.replace("{count}", String(inboxCount))}
                className="absolute -right-0.5 -top-0.5 inline-flex min-w-[15px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[15px] text-primary-foreground ring-2 ring-sidebar"
              >
                {inboxCount > 99 ? "99+" : inboxCount}
              </span>
            ) : null}
          </button>
        </Tooltip>
        {/* Search filters the page tree, so it's a Home-only utility. */}
        {props.activeSurface === "p" && (
          <Tooltip label={t.iconSearch}>
            <button
              type="button"
              aria-label={t.iconSearchAria}
              aria-pressed={searchOpen}
              onClick={() => {
                setSearchOpen((v) => {
                  if (v) setQuery("");
                  return !v;
                });
              }}
              className={navItemCls(searchOpen, searchPill)}
            >
              <Search className="size-[17px] shrink-0" />
              {searchPill ? (
                <span className="whitespace-nowrap">{t.iconSearch}</span>
              ) : null}
            </button>
          </Tooltip>
        )}
      </nav>

      {/* Search input — revealed by the Search icon (Home only). */}
      {searchOpen && props.activeSurface === "p" && (
        <div className="px-2 pb-2">
          <input
            type="text"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.sidebarSearchPlaceholder}
            aria-label={t.iconSearchAria}
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-4">
        {/* Surface-aware body. The page tree (Favorites / Drafts / search) shows
            ONLY on Home (`'p'`); Brain / Studio / Workflow swap in their own
            controls; every other surface (approvals, knowledge-base, root)
            renders nothing here. */}
        {props.activeSurface === "brain" ? (
          <BrainSidebarPanel workspaceId={workspaceId} />
        ) : props.activeSurface === "studio" ? (
          <StudioSidebarPanel workspaceId={workspaceId} />
        ) : props.activeSurface === "workflow" ? (
          <WorkflowSidebarPanel workspaceId={workspaceId} />
        ) : props.activeSurface === "feed" ? (
          <FeedSidebarPanel workspaceId={workspaceId} />
        ) : null}

        {props.activeSurface === "p" && (
          <>
        {/* Search mode — flat hit lists (saved, then drafts). Nesting is
            dropped here on purpose so a buried match isn't hidden under a
            collapsed parent. */}
        {q && (
          <>
            <SectionLabel>{t.sidebarFavorites}</SectionLabel>
            {searchHits.length === 0 && draftHits.length === 0 ? (
              <EmptySearchResults />
            ) : (
              <ul className="space-y-0.5">
                {searchHits.map((row) => (
                  <li key={row.id}>
                    <FlatRow
                      row={row}
                      active={row.id === activeId}
                      onSelect={props.onSelect}
                      onAddChild={props.onAddChild}
                      onRename={props.onRename}
                      onDuplicate={props.onDuplicate}
                      onUnsave={props.onUnsave}
                      onDelete={props.onDelete}
                    />
                  </li>
                ))}
              </ul>
            )}
            {draftHits.length > 0 && (
              <>
                <SectionLabel>{t.sidebarDrafts}</SectionLabel>
                <ul className="space-y-0.5">
                  {draftHits.map((row) => (
                    <li key={row.id}>
                      <DocSidebarRow
                        row={row}
                        active={row.id === activeId}
                        autoPruneAt={props.draftPruneByid[row.id] ?? null}
                        inSavedSubtree={keptByAncestry.has(row.id)}
                        onSelect={props.onSelect}
                        onSave={props.onSave}
                        onDelete={props.onDelete}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {/* Teamspace sections + Private — one nested tree per section (saved
            and draft rows together; drafts keep their prune captions). A
            single `<DndContext>` spans every section so a row can be dragged
            between them, and each section HEADER is a drop zone that files
            the page at that section's root. */}
        {!q && (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {/* Home Dock — single "Suggested for you" entry, pinned above the
                sections, badged with the live needs-you total off the shared
                dock. The suggestions render in the content pane
                (SuggestedView). Spec: docs/architecture/features/home-dock.md. */}
            <HomeDock workspaceId={workspaceId} />

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
                newPageDisabled={props.busyNewDraft || offline}
                newPageTitle={offline ? t.offlineUnavailable : undefined}
                dragging={draggingId !== null}
                onOpenSettings={(tab) => props.onTeamspaceSettings(ts.id, tab)}
                onLeave={() => props.onLeaveTeamspace(ts.id)}
                onDelete={() => props.onDeleteTeamspace(ts.id)}
              >
                {renderSectionBody(sectionTrees.get(ts.id) ?? [])}
              </TeamspaceRow>
            ))}

            {/* Private — the caller's unfiled pages (`teamspaceId: null`), a
                plain group label + `+` (create private) + drop zone (drag a
                page here to make it private). No manage menu. */}
            <PrivateGroupSection
              onNewPage={() => props.onNewDraft(null)}
              newPageDisabled={props.busyNewDraft || offline}
              newPageTitle={offline ? t.offlineUnavailable : undefined}
              dragging={draggingId !== null}
            >
              {privateTree.length > 0 && (
                <ul className="space-y-0.5">{privateTree.map(renderRoot)}</ul>
              )}
            </PrivateGroupSection>
          </DndContext>
        )}
          </>
        )}
      </div>

      {/* Palette picker — quick access pinned to the bottom-left corner. The
          canonical control also lives in Settings → Appearance; both call
          `setPalette` from the theme provider. A single compact flat row (no
          label-over-box "double boxing"). */}
      <div className="border-t border-sidebar-border px-2 py-1.5">
        <PalettePicker />
      </div>
    </aside>
  );
}

/**
 * Bottom-left theme picker — a single **compact flat row** (no label-over-box
 * "double boxing"): the active theme's colour dot + name + chevron; clicking
 * opens the dropdown menu. The menu lists theme PRESETS ("Default" / "Default
 * Dark" flip light↔dark), then any workspace custom themes, then "Create your
 * own". Each row carries a **mini colour dot** illustrating the theme. Custom
 * themes additionally reveal **edit** + **delete** on hover: edit hands off to
 * Settings → Preferences (rename / refine / delete live there); delete confirms
 * then removes via the provider. A preset entry sets the palette (`data-palette`
 * + `doc:palette`) and the mode (`.dark` + `doc:theme`).
 */
// Sentinel select value for the trailing "Create your own…" action — selecting
// it opens the generate dialog instead of applying a theme.
const CREATE_THEME_VALUE = "__create_theme__";

// Colour stops for the two built-in presets' dots, mirroring the `--primary` /
// `--background` notion tokens in globals.css (light vs dark). Decorative only —
// if those notion tokens change, update here.
const PRESET_DOT_COLORS: Record<string, string[]> = {
  default: ["#2383E2", "#FFFFFF"],
  "default-dark": ["#529CCA", "#191919"],
};

// The selected theme reads as a persistent highlighted row (the focused look)
// instead of a right-aligned tick — that keeps the right edge free so the
// per-row hover actions sit flush right rather than dodging a check gutter.
const SELECTED_ROW_CLS =
  "data-[selected]:bg-accent data-[selected]:font-medium data-[selected]:text-accent-foreground";

/** A mini circle illustrating a theme — vertical colour stops inside a bordered
 *  round swatch. Same visual language as the Settings swatch. */
function ThemeDot({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-full border border-border/60">
      {colors.map((c, i) => (
        <span key={`${i}-${c}`} className="flex-1" style={{ background: c }} />
      ))}
    </span>
  );
}

/** Dot colours for a custom theme: primary / accent / background from its light
 *  token map (the same triple the Settings swatch uses). */
function customDotColors(theme: DocTheme): string[] {
  const { primary, "accent-2": accent, background } = theme.tokens.light;
  return [primary, accent, background].filter(Boolean) as string[];
}

function PalettePicker() {
  const t = useT();
  const { palette, resolved, customThemeId, setPalette, setMode } = useTheme();
  const { themes, applyTheme, deleteTheme } = useCustomThemes();
  const [createOpen, setCreateOpen] = useState(false);
  // Controlled so the per-row edit / delete buttons can close the menu before
  // handing off to Settings / the confirm dialog.
  const [open, setOpen] = useState(false);

  // Value→label map for the trigger display: built-in presets + custom themes.
  const itemLabels: Record<string, string> = {
    default: t.settings.general.paletteNotion,
    "default-dark": t.settings.general.paletteDefaultDark,
    [CREATE_THEME_VALUE]: t.settings.general.createYourOwn,
  };
  for (const theme of themes) itemLabels[`custom:${theme.id}`] = theme.name;

  // The active value: a custom theme (custom:<id>) or the matching built-in preset.
  const activeValue =
    palette === "custom" && customThemeId
      ? `custom:${customThemeId}`
      : currentPresetId(palette, resolved) ?? "default";

  // Dot colours for the active theme shown in the flat trigger.
  const activeDot = activeValue.startsWith("custom:")
    ? (() => {
        const th = themes.find((x) => x.id === activeValue.slice("custom:".length));
        return th ? customDotColors(th) : [];
      })()
    : PRESET_DOT_COLORS[activeValue] ?? [];

  const onValueChange = (v: string | null) => {
    if (!v) return;
    if (v === CREATE_THEME_VALUE) {
      setCreateOpen(true);
      return;
    }
    if (v.startsWith("custom:")) {
      const theme = themes.find((th) => th.id === v.slice("custom:".length));
      if (theme) applyTheme(theme);
      return;
    }
    const preset = THEME_PRESETS.find((p) => p.id === v);
    if (!preset) return;
    setPalette(preset.palette);
    if (preset.mode) setMode(preset.mode);
  };

  // Revising a theme's look (rename / refine / delete) lives in Settings — the
  // picker is a quick switcher, so the pencil hands off to that surface.
  const onEditTheme = () => {
    setOpen(false);
    openWorkspaceSettings("preferences");
  };

  const onDeleteTheme = async (theme: DocTheme) => {
    setOpen(false);
    const ok = await confirmDialog({
      description: t.settings.general.customThemeDeleteConfirm,
      confirmLabel: t.settings.general.customThemeDelete,
      cancelLabel: t.common.cancel,
      variant: "destructive",
    });
    if (ok) await deleteTheme(theme.id);
  };

  return (
    <>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={activeValue}
        onValueChange={onValueChange}
        items={itemLabels}
      >
        <SelectTrigger className="h-8 w-full justify-between gap-2 rounded-md border-0 bg-transparent px-2 text-xs font-normal text-sidebar-foreground shadow-none hover:bg-sidebar-accent dark:bg-transparent dark:hover:bg-sidebar-accent">
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <ThemeDot colors={activeDot} />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent align="start" className="min-w-[var(--anchor-width)]">
          {THEME_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id} indicator={false} className={SELECTED_ROW_CLS}>
              <ThemeDot colors={PRESET_DOT_COLORS[p.id] ?? []} />
              <span className="truncate">{itemLabels[p.id]}</span>
            </SelectItem>
          ))}
          {themes.length > 0 ? <SelectSeparator /> : null}
          {themes.map((theme) => (
            <div key={theme.id} className="group/theme relative">
              <SelectItem value={`custom:${theme.id}`} indicator={false} className={SELECTED_ROW_CLS}>
                <ThemeDot colors={customDotColors(theme)} />
                <span className="truncate">{theme.name}</span>
              </SelectItem>
              {/* Hover-revealed actions, flush to the right edge (no tick gutter
                  to dodge now). The container carries the row's highlight bg so
                  it masks the name end on hover — the title runs full-width at
                  rest. Siblings of the item, not children, so a click can't
                  select the row; the handlers also close the menu first. */}
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-accent pl-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/theme:opacity-100">
                <button
                  type="button"
                  aria-label={`${t.settings.general.customThemeEdit}: ${theme.name}`}
                  title={t.settings.general.customThemeEdit}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onEditTheme();
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`${t.settings.general.customThemeDelete}: ${theme.name}`}
                  title={t.settings.general.customThemeDelete}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    void onDeleteTheme(theme);
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
          <SelectSeparator />
          <SelectItem value={CREATE_THEME_VALUE} indicator={false}>
            {t.settings.general.createYourOwn}
          </SelectItem>
        </SelectContent>
      </Select>
      <CreateThemeDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
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
    <div className="group/tsgroup mt-4 mb-1 flex items-center px-1">
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
        {t.sidebarTeamspacesGroup}
      </span>
      <div className="flex items-center opacity-0 pointer-events-none transition-opacity group-hover/tsgroup:opacity-100 group-hover/tsgroup:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={t.sidebarTeamspacesMenuAria}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
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
            <span className="flex items-center justify-center opacity-100 transition-opacity group-hover/row:opacity-0">
              {teamspace.icon ? (
                <span className="text-[15px] leading-none">{teamspace.icon}</span>
              ) : (
                <Users className="size-4 text-sidebar-foreground/55" />
              )}
            </span>
            <ChevronRight
              aria-hidden
              className={[
                "absolute inset-0 m-auto size-3.5 opacity-0 transition-[transform,opacity] group-hover/row:opacity-100",
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
          className="flex min-w-0 flex-1 items-center py-1 pr-0 text-left group-hover/row:pr-14 group-focus-within/row:pr-14"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        </button>

        {/* Hover actions — teamspace `⋯` then `+` (new page here). Also
            revealed while the `⋯` menu is open (`has-[aria-expanded]`, which
            in this row can only be the dropdown trigger). */}
        {!dragging && (
          <div className="absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-within/row:opacity-100 group-focus-within/row:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto">
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
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
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
          <div className="flex items-center opacity-0 pointer-events-none transition-opacity group-hover/priv:opacity-100 group-hover/priv:pointer-events-auto">
            <button
              type="button"
              aria-label={t.sidebarSectionNewPageAria}
              disabled={newPageDisabled}
              title={newPageTitle}
              onClick={(e) => {
                e.stopPropagation();
                onNewPage();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
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
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
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

function SectionLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-1 px-1 ${className}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
        {children}
      </span>
    </div>
  );
}

/** A flat (non-tree) saved row — Recents + search hits. Same hover
 * affordances as the tree node (overflow `…` menu, then add-child `+`)
 * so every page row behaves identically, minus the nesting chevron +
 * DnD. The leading icon is a static glyph (the page emoji, else the
 * type-derived fallback) — flat rows have no children, so there's no
 * disclosure toggle and no emoji picker here (icons are set from the
 * page header). The title runs full-width at rest and truncates on hover
 * / focus to clear the out-of-flow row actions. */
function FlatRow({
  row,
  active,
  onSelect,
  onAddChild,
  onRename,
  onDuplicate,
  onUnsave,
  onDelete,
}: {
  row: ViewListRow;
  active: boolean;
  onSelect: (id: string) => void;
  onAddChild: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onUnsave: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT().docPage;
  const title = row.name?.trim() ? row.name : t.breadcrumbUntitled;
  const Icon = derivePageIcon({
    entity: row.entity,
    viewType: row.viewType,
    nameOrigin: row.nameOrigin,
  });
  return (
    <div
      className={[
        "group/row relative flex w-full items-center gap-1.5 rounded-md pl-2 pr-1 text-sm",
        active
          ? "doc-nav-active font-medium"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {row.icon ? (
          <span className="text-[15px] leading-none">{row.icon}</span>
        ) : (
          <Icon className="size-4 text-sidebar-foreground/55" />
        )}
      </span>
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        title={title}
        className="doc-nav-title min-w-0 flex-1 truncate py-1 pr-0 text-left group-hover/row:pr-14 group-focus-within/row:pr-14"
      >
        {title}
      </button>

      {/* Hover affordances — overflow menu (…) then add-child (+). Out of
          flow so the title runs full-width at rest; revealed on hover /
          focus-within / while the … menu is open. */}
      <div className="absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-within/row:opacity-100 group-focus-within/row:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={t.sidebarRowMenu}
                onClick={(e) => e.stopPropagation()}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => onRename(row.id)}>
              {t.sidebarRowRename}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDuplicate(row.id)}>
              {t.sidebarRowDuplicate}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onUnsave(row.id)}>
              {t.sidebarRowUnsave}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDelete(row.id)}
            >
              {t.sidebarRowDelete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          aria-label={t.sidebarAddChildAria}
          onClick={(e) => {
            e.stopPropagation();
            onAddChild(row.id);
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
