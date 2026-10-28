"use client";

/**
 * Chat surface sidebar panel — swapped into the persistent left sidebar while
 * the Chat operator surface is active. This IS the session rail: the
 * Personal + Workspace lists, and the rename / delete row actions — the
 * surface itself is transcript + composer only, so the app reads like every
 * other operator surface (list in the sidebar, work in the body) instead of
 * carrying a second private rail.
 * Search is owned by the shared contextual header and its Conversations filter.
 *
 * The rail FOLLOWS the surface's Personal/Workspace toggle (`?v=` — the same
 * URL state, so the two can never disagree): Personal shows "Chats" + the
 * collapsed ambient section, Workspace shows the shared list, and the
 * new-chat row swaps between the personal link and the explicit
 * shared-session create.
 *
 * "Chats" groups personal web sessions by Project and non-web sessions by
 * source channel. The dock's rolling ambient web threads — which every dock
 * exchange bumps to the top of an unsplit list — sit in the collapsed
 * "Other conversations" section: demoted, never hidden, so the unified-history
 * promise (any thread readable and continuable here) survives.
 *
 * Rows deep-link with `?s=<sessionId>` (+ `?v=workspace` for shared threads),
 * the same URL state the surface reads, so the two never need a private bus
 * to agree on which thread is open.
 *
 * Reads the SAME cached lists the surface reads (`useChatSessionsData`,
 * `lib/chat-surface-data.ts`: `chat-roster:` / `chat-sessions:` /
 * `chat-shared:` in the surface cache, mirrored to IndexedDB), so re-entering
 * Chat paints the last-known rail on the first frame and revalidates behind
 * it (instant-navigation contract N1). The panel carries no refetch listener:
 * the spine's `session` primitive and the same-tab
 * `CHAT_SESSIONS_REFRESH_EVENT` (a turn settling with an auto-title, a fresh
 * session adopted mid-turn, a shared chat started) mark the keys stale
 * through the hook, and this panel's own rename / delete patch the cached
 * rows optimistically before dispatching the same signal. The one cold state
 * (nothing cached anywhere) paints skeleton rows, never "Loading".
 *
 * Spec: docs/architecture/features/chat-app.md → "Sidebar panel".
 * [COMP:app-web/sidebar-panel-chat]
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Brain, ChevronRight, Folder, FolderOpen, LoaderCircle, MessageSquare, MoreHorizontal, Pencil, SquarePen, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { Skeleton } from "@/components/skeleton";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import styles from "./chat-sidebar-panel.module.css";
import {
  CHAT_SESSION_ACTIVITY_EVENT,
  dispatchChatSessionsRefresh,
  type ChatSessionActivityDetail,
} from "@/lib/chat-session-events";
import {
  createWorkspaceSession,
  deleteSession,
  setRoomCapture,
  renameSessionTitle,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";
import {
  patchPersonalChatSessions,
  patchSharedChatSessions,
  useChatSessionsData,
  useProjectChatSessionsData,
} from "@/lib/chat-surface-data";
import { listContextProjects, type ContextProject } from "@/lib/api/context-scopes";
import { useCachedResource } from "@/lib/surface-cache";
import { chatSessionsCacheKey, chatSharedSessionsCacheKey, surfaceDataKey } from "@/lib/surface-prefetch";
import { isRoomUnread } from "@/lib/chat-seen";

/** Compact single-line rows, with a 44px phone target (M3) and room for the row menu. */
const rowCls = (active: boolean) =>
  cn(
    "flex min-h-11 w-full items-center rounded-md px-2 py-1 pr-1 text-left text-sm transition-colors md:min-h-8 md:py-0.5",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

/** Measure the visible slot as contextual actions appear or the sidebar resizes. */
function SidebarTitle({ children }: { children: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const measure = () => setOverflow(Math.max(0, text.scrollWidth - viewport.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children]);

  return <span ref={viewportRef} className={styles.titleViewport} data-sidebar-title
    data-overflow={overflow > 0 ? "" : undefined}
    style={{
      "--chat-title-travel": `${-overflow}px`,
      "--chat-title-duration": `${Math.max(2.5, overflow / 28 + 1)}s`,
    } as CSSProperties}>
    <span ref={textRef} className={styles.titleText}>{children}</span>
  </span>;
}

/** Cold-cache fallback: rows shaped like the rail's, never a sentence (N4). */
function RailRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-0.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex min-h-11 items-center gap-2 px-2 py-1 md:min-h-8 md:py-0.5">
          <Skeleton className="h-3" style={{ width: `${44 + ((i * 19) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

const ROOM_ACTIVITY_STATUS_POLL_MS = 3_000;
const ROOM_ACTIVITY_OVERRIDE_GRACE_MS = 10_000;

type RoomActivityOverride = {
  working: boolean;
  changedAt: number;
};

export function ChatSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().chatApp;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams?.get("s") ?? null;
  /** The surface's Personal/Workspace toggle — the rail FOLLOWS it, showing
   *  one view's chats at a time so the sidebar always matches what the body
   *  says the user is looking at. */
  const view: "personal" | "workspace" =
    searchParams?.get("v") === "workspace" ? "workspace" : "personal";

  // The cached lists, shared with the surface. `null` only when nothing is
  // cached in memory or on disk - the skeleton state.
  const {
    assistants,
    personal: rows,
    shared: sharedRows,
    refreshShared,
  } = useChatSessionsData(workspaceId);
  const projects = useCachedResource(surfaceDataKey("projects", workspaceId), () => listContextProjects(workspaceId, true));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ambient-thread section's disclosure. Collapsed by default: those
  // threads are reachable, not top-of-mind.
  const [othersOpen, setOthersOpen] = useState(false);
  const [creatingShared, setCreatingShared] = useState(false);
  /** Same-tab fast path for room work. A fresh mount falls back to each
   *  workspace row's persisted `status`, so navigation/re-entry stays
   *  authoritative even when this ephemeral signal was not observed. */
  const [activityBySession, setActivityBySession] = useState<
    Record<string, RoomActivityOverride>
  >({});

  /** Reconcile the immediate same-tab signal with persisted session status
   *  whenever either list (re)paints: personal rows carry `status` too
   *  (chat-parity T4), so a personal chat pulses the same way a room does. A
   *  short grace keeps a just-started turn pulsing while the chat route is
   *  still in preflight and has not flipped the row to `running` yet. */
  useEffect(() => {
    if (!sharedRows && !rows) return;
    const byId = new Map<string, DocSession>(
      [...(rows ?? []), ...(sharedRows ?? [])].map((row) => [row.id, row]),
    );
    const now = Date.now();
    setActivityBySession((current) => {
      let changed = false;
      const next = { ...current };
      for (const [sessionId, override] of Object.entries(current)) {
        const row = byId.get(sessionId);
        const persistedWorking = row?.status === "running";
        if (
          !row ||
          persistedWorking === override.working ||
          now - override.changedAt >= ROOM_ACTIVITY_OVERRIDE_GRACE_MS
        ) {
          delete next[sessionId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sharedRows, rows]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ChatSessionActivityDetail>).detail;
      if (!detail || detail.workspaceId !== workspaceId) return;
      setActivityBySession((current) => ({
        ...current,
        [detail.sessionId]: {
          working: detail.working,
          changedAt: Date.now(),
        },
      }));
    };
    window.addEventListener(CHAT_SESSION_ACTIVITY_EVENT, handler);
    return () => window.removeEventListener(CHAT_SESSION_ACTIVITY_EVENT, handler);
  }, [workspaceId]);

  const base = `/w/${workspaceId}/chat`;
  const onChatSurface = pathname === base;

  // Channel conversations belong in their source groups regardless of origin.
  // Only ambient web threads are demoted to Other conversations, so dock
  // activity cannot displace the chats the user deliberately started here.
  const chatRows = useMemo(
    () =>
      (rows ?? []).filter((r) => (r.transport && r.transport !== "web") || r.appOrigin === "chat" || r.appOrigin == null),
    [rows],
  );
  const ambientRows = useMemo(
    () =>
      (rows ?? []).filter((r) => (!r.transport || r.transport === "web") && r.appOrigin != null && r.appOrigin !== "chat"),
    [rows],
  );
  const personalGroups = useMemo(() => {
    const projectById = new Map((projects.data ?? []).map(project => [project.id, project]));
    const groups = new Map<string, { id: string; label: string; kind: "general" | "project" | "channel"; rows: DocSession[] }>();
    for (const row of chatRows) {
      let kind: "general" | "project" | "channel" = "general";
      let id = "general";
      let label = t.generalChats;
      if (row.transport && row.transport !== "web") {
        kind = "channel";
        const channelId = row.transport === "slack" || row.transport === "feishu"
          ? row.channelId.split(":thread:")[0] : row.channelId;
        id = JSON.stringify([kind, row.transport, channelId]);
        const transport = t.roomTransport[row.transport as keyof typeof t.roomTransport] ?? row.transport;
        label = `${transport}: ${channelId}`;
      } else if (row.contextProjectId) {
        kind = "project";
        const project = projectById.get(row.contextProjectId);
        id = JSON.stringify([kind, project?.id ?? null]);
        label = project?.name ?? t.otherProjects;
      }
      const group = groups.get(id) ?? { id, label, kind, rows: [] };
      group.rows.push(row);
      groups.set(id, group);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.kind === "general") return -1;
      if (b.kind === "general") return 1;
      return b.rows[0].lastActive.localeCompare(a.rows[0].lastActive);
    });
  }, [chatRows, projects.data, t]);
  const visibleAmbient = ambientRows;
  const showAmbient = othersOpen;
  const hasWorkingRoom =
    (sharedRows ?? []).some((row) => row.status === "running") ||
    Object.values(activityBySession).some((activity) => activity.working);

  // A room may finish after the user switches to another room, at which point
  // neither of the old room's page streams remains to deliver turn_completed.
  // Poll only while work is known live; the authoritative list status then
  // settles the old row and stops this interval.
  useEffect(() => {
    if (view !== "workspace" || !hasWorkingRoom) return;
    const poll = window.setInterval(() => {
      // A forced revalidation of the cached shared list: rows stay painted
      // while the status column catches up.
      void refreshShared().catch(() => {});
    }, ROOM_ACTIVITY_STATUS_POLL_MS);
    return () => window.clearInterval(poll);
  }, [hasWorkingRoom, refreshShared, view]);

  const onRename = useCallback(
    async (row: DocSession) => {
      setMenuFor(null);
      const next = await promptDialog({
        title: t.renameTitle,
        defaultValue: row.title,
        placeholder: t.renamePlaceholder,
        confirmLabel: t.renameConfirm,
      });
      if (!next || next.trim() === row.title) return;
      try {
        const title = next.trim();
        await renameSessionTitle(row.id, title);
        setError(null);
        // Patch the cached row so the rail (and the surface's header) show
        // the new title now; the refresh signal revalidates behind it.
        const retitle = <R extends DocSession>(list: R[]): R[] =>
          list.map((r) => (r.id === row.id ? { ...r, title } : r));
        if ("startedByUserId" in row) patchSharedChatSessions(workspaceId, retitle);
        else patchPersonalChatSessions(workspaceId, retitle);
        dispatchChatSessionsRefresh(workspaceId);
      } catch {
        setError(t.renameFailed);
      }
    },
    [t, workspaceId],
  );

  /** A converged group's brain capture (unified-sessions D4); admins only. */
  const onToggleCapture = useCallback(
    async (row: WorkspaceSession) => {
      setMenuFor(null);
      const enabled = row.roomCapture === false;
      if (!(await setRoomCapture(row.id, enabled))) {
        setError(t.roomCaptureDenied);
        return;
      }
      setError(null);
      patchSharedChatSessions(workspaceId, <R extends DocSession>(list: R[]): R[] =>
        list.map((r) => (r.id === row.id ? { ...r, roomCapture: enabled } : r)));
      dispatchChatSessionsRefresh(workspaceId);
    },
    [t, workspaceId],
  );

  const onDelete = useCallback(
    async (row: DocSession) => {
      setMenuFor(null);
      const ok = await confirmDialog({
        title: t.deleteTitle,
        description: row.transport && row.transport !== "web" ? t.deleteRecordingBody : t.deleteBody,
        confirmLabel: t.deleteConfirm,
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await deleteSession(row.id);
        setError(null);
        // Deleting the OPEN thread clears only the dead session selection.
        // Keep the audience in URL state: dropping `v=workspace` here makes
        // the surface default back to Personal after a Workspace delete.
        if (row.id === activeSessionId) {
          router.replace(view === "workspace" ? `${base}?v=workspace` : base, {
            scroll: false,
          });
        }
        // Drop the row from whichever cached list held it; the refresh
        // signal revalidates behind the paint.
        const without = <R extends DocSession>(list: R[]): R[] =>
          list.filter((r) => r.id !== row.id);
        patchPersonalChatSessions(workspaceId, without);
        patchSharedChatSessions(workspaceId, without);
        dispatchChatSessionsRefresh(workspaceId);
      } catch {
        setError(t.deleteFailed);
      }
    },
    [activeSessionId, base, router, t, view, workspaceId],
  );

  const assistantById = useMemo(
    () => new Map(assistants.map((a) => [a.id, a])),
    [assistants],
  );
  const primary =
    assistants.find((a) => a.kind === "primary") ?? assistants[0] ?? null;

  const renderRow = (
    row: DocSession | WorkspaceSession,
    href: string,
  ) => {
    // Assistant identity stays in hover/focus and accessible details, leaving
    // the visible row for its title. Shared rows resolve their bound assistant.
    const rowAssistant =
      (row.assistantId ? assistantById.get(row.assistantId) : undefined) ??
      primary;
    // ONE row renderer for both rails (chat-parity T4). Unread is a DOT, not
    // a count (multiplayer chat T7), off `last_active_at` vs this device's
    // localStorage watermark, and only where another human takes part: a
    // conversation with one human (every personal chat) is always read by
    // that human, so it never dots. The open row never dots either — the
    // surface stamps the watermark as activity lands.
    const unread =
      row.humanCount !== 1 &&
      row.id !== activeSessionId &&
      isRoomUnread(workspaceId, row.id, row.lastActive);
    // The working indicator reads every row's turn slot, personal or room.
    const working = activityBySession[row.id]?.working ?? row.status === "running";
    const title = row.title === "New Chat" && row.transport && row.transport !== "web"
      ? `${t.roomTransport[row.transport as keyof typeof t.roomTransport] ?? row.transport}: ${row.channelId}`
      : row.title;
    const attribution = "startedByUserId" in row
      ? row.startedByName ? format(t.startedBy, { name: row.startedByName }) : t.startedByUnknown
      : null;
    const transport = row.transport && row.transport !== "web"
      ? t.roomTransport[row.transport as keyof typeof t.roomTransport] ?? row.transport
      : null;
    const transportDescription = transport ? format(t.roomTransportAria, { transport }) : null;
    const workingLabel = rowAssistant
      ? format(t.workingAria, { name: rowAssistant.name })
      : t.taskExecution.phase.running;
    return (
    <div key={row.id} className={cn(styles.actionHost, styles.titleHost, "relative")} data-chat-sidebar-row>
      <Tooltip side="right" label={<span className="block max-w-[min(18rem,calc(100vw-2rem))] break-words font-normal">
        <span className="block">{title}</span>
        {rowAssistant && <span className="block opacity-70">{rowAssistant.name}</span>}
        {transportDescription && <span className="block opacity-70">{transportDescription}</span>}
        {attribution && <span className="block opacity-70">{attribution}</span>}
      </span>}>
      <Link
        href={href}
        aria-current={row.id === activeSessionId ? "page" : undefined}
        className={rowCls(row.id === activeSessionId)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <SidebarTitle>{title}</SidebarTitle>
          {working && <LoaderCircle
            className="size-3.5 shrink-0 animate-spin text-sidebar-foreground/60 motion-reduce:animate-none"
            role="status" aria-hidden={false} aria-label={workingLabel}
            data-chat-working="true"
          />}
          {unread && (
            <span
              role="status"
              aria-label={t.unreadDotAria}
              title={t.unreadDotAria}
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
        </span>
        {attribution && <span className="sr-only">{attribution}</span>}
        {rowAssistant && <span className="sr-only">{rowAssistant.name}</span>}
        {transportDescription && <span className="sr-only">{transportDescription}</span>}
      </Link>
      </Tooltip>
      <button
        type="button"
        aria-label={t.rowActionsAria}
        onClick={() => setMenuFor(menuFor === row.id ? null : row.id)}
        data-open={menuFor === row.id ? "" : undefined}
        className={cn(styles.hoverAction, "absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded text-sidebar-foreground/50 transition-opacity md:right-1 md:size-6")}
      >
        <MoreHorizontal className="size-4 md:size-3.5" aria-hidden />
      </button>
      {menuFor === row.id && (
        <div className="absolute top-full right-1 z-20 mt-0.5 w-32 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <button
            type="button"
            onClick={() => void onRename(row)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent"
          >
            <Pencil className="size-3.5" aria-hidden />
            {t.rename}
          </button>
          {"roomCapture" in row && row.roomCapture !== undefined && (
            <button
              type="button"
              onClick={() => void onToggleCapture(row)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent"
            >
              <Brain className="size-3.5" aria-hidden />
              {row.roomCapture ? t.roomCaptureOff : t.roomCaptureOn}
            </button>
          )}
          <button
            type="button"
            onClick={() => void onDelete(row)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-destructive hover:bg-accent"
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t.delete}
          </button>
        </div>
      )}
    </div>
    );
  };

  /** Start a shared thread from the rail — the explicit create the surface's
   *  topbar also offers, so the Workspace view's rail has its own entry
   *  point. Lands on the fresh thread via the same URL state. */
  const startWorkspaceChat = useCallback(async (projectId: string | null = null) => {
    if (creatingShared) return;
    setCreatingShared(true);
    try {
      const created = await createWorkspaceSession(workspaceId, undefined, { contextGroupId: null, contextProjectId: projectId });
      setError(null);
      router.push(
        `${base}?v=workspace&s=${encodeURIComponent(created.id)}`,
        { scroll: false },
      );
      // The fresh room must resolve as a room the moment the surface reads
      // the list (seeded even on a cold slot); the signal revalidates.
      patchSharedChatSessions(
        workspaceId,
        (rows) => [created, ...rows.filter((r) => r.id !== created.id)],
        { seed: true },
      );
      dispatchChatSessionsRefresh(workspaceId);
    } catch {
      setError(t.newWorkspaceChatFailed);
    } finally {
      setCreatingShared(false);
    }
  }, [base, creatingShared, router, t, workspaceId]);

  return (
    <div className="-mx-1 flex min-w-0 flex-col gap-3 pt-1 md:-mx-2 md:gap-2 md:pt-0">
      {view === "personal" ? (
        <Link
          href={base}
          aria-current={onChatSurface && !activeSessionId ? "page" : undefined}
          className={cn(
            rowCls(false),
            "flex items-center gap-3 pr-2 text-base text-sidebar-foreground md:min-h-8 md:gap-2 md:pr-2 md:text-sm",
          )}
        >
          <SquarePen className="size-[18px] shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t.newChat}</span>
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => void startWorkspaceChat()}
          disabled={creatingShared}
          className={cn(
            rowCls(false),
            "flex items-center gap-3 pr-2 text-base text-sidebar-foreground md:min-h-8 md:gap-2 md:pr-2 md:text-sm disabled:opacity-50",
          )}
        >
          <SquarePen className="size-[18px] shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t.newWorkspaceChat}</span>
        </button>
      )}

      {error && (
        <p className="px-1 text-[11px] leading-snug text-destructive">{error}</p>
      )}

      {view === "personal" && (
        <div>
          <div className={sectionHeaderCls}>{t.railAria}</div>
          <div className="flex flex-col">
            {rows === null && <RailRowsSkeleton />}
            {rows !== null && personalGroups.length === 0 && (
              <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
                {t.railEmpty}
              </div>
            )}
            {Boolean(projects.error) && personalGroups.some(group => group.kind === "project") && (
              <p role="alert" className="px-2 text-xs text-destructive">{t.personalProjectsFailed}</p>
            )}
            {personalGroups.map(group => (
              <PersonalChatGroup key={group.id} workspaceId={workspaceId} group={group}
                activeSessionId={activeSessionId} renderRow={renderRow} />
            ))}
          </div>
        </div>
      )}

      {view === "workspace" && (
        <div className="flex flex-col">
          <ProjectChatGroup workspaceId={workspaceId} project={null} activeSessionId={activeSessionId}
            renderRow={renderRow} onCreate={startWorkspaceChat} creating={creatingShared} />
          {projects.loading && <RailRowsSkeleton rows={2} />}
          {Boolean(projects.error) && <p role="alert" className="px-2 text-xs text-destructive">{t.projectChatsFailed}</p>}
          {(projects.data ?? []).filter(p => p.status === "active" && p.shared?.status !== "quarantined").map(project => (
            <ProjectChatGroup key={project.id} workspaceId={workspaceId} project={project} activeSessionId={activeSessionId}
              renderRow={renderRow} onCreate={startWorkspaceChat} creating={creatingShared} />
          ))}
        </div>
      )}

      {/* The dock's rolling ambient threads — demoted below the deliberate
          lists, collapsed by default, but fully readable and continuable.
          Personal view only (they are personal sessions); hidden when none. */}
      {view === "personal" && ambientRows.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOthersOpen((v) => !v)}
            aria-expanded={showAmbient}
            className={cn(
              sectionHeaderCls,
              "group flex w-full items-center gap-1 text-left transition-colors hover:text-sidebar-foreground/70",
            )}
          >
            <span className="truncate">{t.otherConversations}</span>
            <span className="shrink-0 text-sidebar-foreground/35">
              {ambientRows.length}
            </span>
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-sidebar-foreground/35 transition-transform duration-200",
                showAmbient && "rotate-90",
              )}
            />
          </button>
          {showAmbient && (
            <div className="flex flex-col gap-0.5">
              {visibleAmbient.map((row) =>
                renderRow(row, `${base}?s=${encodeURIComponent(row.id)}`),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Personal grouping never requests a shared transcript or changes its binding. */
function PersonalChatGroup({ workspaceId, group, activeSessionId, renderRow }: {
  workspaceId: string;
  group: { id: string; label: string; kind: "general" | "project" | "channel"; rows: DocSession[] };
  activeSessionId: string | null;
  renderRow: (row: DocSession, href: string) => React.ReactNode;
}) {
  const [open, toggleOpen] = useChatGroupDisclosure(
    `doc:personal-chat-group:${chatSessionsCacheKey(workspaceId)}:${group.id}`,
    activeSessionId, group.rows.some(row => row.id === activeSessionId), group.kind === "general",
  );
  const Icon = group.kind === "channel" ? MessageSquare : open ? FolderOpen : Folder;
  return <section className="flex flex-col gap-0.5" data-personal-chat-group={group.kind}>
    <button type="button"
      className={cn(styles.titleHost, "flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent md:min-h-8")}
      aria-expanded={open} onClick={toggleOpen} title={group.label}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <SidebarTitle>{group.label}</SidebarTitle>
    </button>
    {open && <div className="flex flex-col gap-0.5 pl-[22px]">
      {group.rows.map(row => renderRow(row, `/w/${workspaceId}/chat?s=${encodeURIComponent(row.id)}`))}
    </div>}
  </section>;
}

/** Each scope has its own authorized page; a busy General list cannot hide a Project. */
function ProjectChatGroup({ workspaceId, project, activeSessionId, renderRow, onCreate, creating }: {
  workspaceId: string; project: ContextProject | null; activeSessionId: string | null;
  renderRow: (row: WorkspaceSession, href: string) => React.ReactNode;
  onCreate: (projectId: string | null) => Promise<void>; creating: boolean;
}) {
  const t = useT().chatApp;
  const rows = useProjectChatSessionsData(workspaceId, project?.id ?? null);
  const [open, toggleOpen] = useChatGroupDisclosure(
    `doc:chat-group:${chatSharedSessionsCacheKey(workspaceId, project?.id ?? null)}`,
    activeSessionId, rows.data?.some(row => row.id === activeSessionId) ?? false, project === null,
  );
  const canCreate = !project || !project.shared || project.shared.myRole === "owner" || project.shared.myRole === "participant";
  const FolderIcon = open ? FolderOpen : Folder;
  return <section className="flex flex-col gap-0.5" data-workspace-chat-group={project?.id ?? "general"}>
    <div className={cn(styles.actionHost, styles.titleHost, "relative flex items-center rounded-md hover:bg-sidebar-accent")}>
      <button type="button" className={cn(styles.groupToggle, "flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent md:min-h-8")}
        aria-expanded={open} onClick={toggleOpen} title={project?.name ?? t.generalChats}
        onPointerUp={event => {
          // Safari need not focus a tapped button. Give hoverless users a
          // stable reveal path to the adjacent compose action.
          if (event.pointerType !== "mouse") event.currentTarget.focus({ preventScroll: true });
        }}>
        <FolderIcon aria-hidden className="size-4 shrink-0" />
        <SidebarTitle>{project?.name ?? t.generalChats}</SidebarTitle>
      </button>
      {canCreate && <button type="button" className={cn(styles.hoverAction, styles.composeAction, "absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/60 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:size-8")}
        aria-label={format(t.newChatInProject, { name: project?.name ?? t.generalChats })}
        title={format(t.newChatInProject, { name: project?.name ?? t.generalChats })}
        disabled={creating} onClick={() => void onCreate(project?.id ?? null)}><SquarePen aria-hidden className="size-4" /></button>}
    </div>
    {open && <div className="flex flex-col gap-0.5 pl-[22px]">
      {rows.loading && <RailRowsSkeleton />}
      {Boolean(rows.error) && <p role="alert" className="px-2 text-xs text-destructive">{t.projectChatsFailed}</p>}
      {rows.data?.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">{t.workspaceRailEmpty}</p>}
      {rows.data?.map(row => renderRow(row, `/w/${workspaceId}/chat?v=workspace&s=${encodeURIComponent(row.id)}`))}
      {rows.hasMore && (rows.data?.length ?? 0) >= 50 && <button type="button" className="min-h-8 max-sm:min-h-11 px-2 text-sm text-muted-foreground" disabled={rows.paging} onClick={() => void rows.more()}>{t.moreChats}</button>}
    </div>}
  </section>;
}

/** Shared disclosure behavior; Personal and Work supply separate scoped keys. */
function useChatGroupDisclosure(storageKey: string, activeSessionId: string | null, containsActive: boolean, defaultOpen: boolean): [boolean, () => void] {
  const [disclosure, setDisclosure] = useState<{
    key: string; open: boolean; sessionId: string | null;
  } | null>(null);

  useEffect(() => {
    setDisclosure(null);
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved?.open === "boolean" &&
        (saved.sessionId === null || typeof saved.sessionId === "string")) {
        setDisclosure({ key: storageKey, open: saved.open, sessionId: saved.sessionId });
      }
    } catch {
      // Storage is optional: private mode and malformed preferences use defaults.
    }
  }, [storageKey]);

  useEffect(() => {
    if (!activeSessionId) return;
    // Restoring the remembered chat after mount is still the same selection.
    // A different chat releases the old collapse, including on back navigation.
    setDisclosure(current => current && current.sessionId !== activeSessionId
      ? { ...current, sessionId: null } : current);
  }, [activeSessionId]);

  const saved = disclosure?.key === storageKey ? disclosure : null;
  // Only a different selection reveals a collapsed group. Revalidation can
  // replace every row object without undoing the user's disclosure choice.
  const open = (saved?.open ?? defaultOpen) ||
    (containsActive && saved?.sessionId !== activeSessionId);
  const toggleOpen = () => {
    const next = { open: !open, sessionId: activeSessionId };
    setDisclosure({ key: storageKey, ...next });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Keep the current mount usable when persistence is unavailable.
    }
  };
  return [open, toggleOpen];
}
