"use client";

/**
 * Chat surface sidebar panel — swapped into the persistent left sidebar while
 * the Chat operator surface is active. This IS the session rail: search, the
 * Personal + Workspace lists, and the rename / delete row actions — the
 * surface itself is transcript + composer only, so the app reads like every
 * other operator surface (list in the sidebar, work in the body) instead of
 * carrying a second private rail.
 *
 * The rail FOLLOWS the surface's Personal/Workspace toggle (`?v=` — the same
 * URL state, so the two can never disagree): Personal shows "Chats" + the
 * collapsed ambient section, Workspace shows the shared list, and the
 * new-chat row swaps between the personal link and the explicit
 * shared-session create.
 *
 * "Chats" lists only sessions minted in the Chat app (`app_origin='chat'` +
 * legacy null-origin). The dock's rolling ambient threads — which every dock
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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Brain, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { Skeleton } from "@/components/skeleton";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
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
} from "@/lib/chat-surface-data";
import { isRoomUnread } from "@/lib/chat-seen";

/** The Brain panel's nav-row recipe — active is the `.doc-nav-active` pill.
 *  44px rows below `md` (responsive contract M3: "chat history rows 44px"),
 *  with room on the right for the touch-sized row menu. */
const rowCls = (active: boolean) =>
  cn(
    "flex min-h-11 w-full items-center rounded-md px-2 py-1.5 pr-11 text-left text-sm transition-colors md:min-h-0 md:pr-7",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

/** Cold-cache fallback: rows shaped like the rail's, never a sentence (N4). */
function RailRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-0.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex min-h-11 items-center gap-2 px-2 py-1.5 md:min-h-0">
          <Skeleton className="size-4 shrink-0 rounded-full" />
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
  const [search, setSearch] = useState("");
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
   *  whenever the shared list (re)paints. A short grace keeps a just-started
   *  turn pulsing while the chat route is still in preflight and has not
   *  flipped the row to `running` yet. */
  useEffect(() => {
    if (!sharedRows) return;
    const byId = new Map(sharedRows.map((row) => [row.id, row]));
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
  }, [sharedRows]);

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

  const needle = search.trim().toLowerCase();
  // "Chats" carries only sessions minted in the Chat app (`app_origin='chat'`,
  // plus legacy null-origin rows — the server's own `?appOrigin=` convention).
  // Everything else is the dock's rolling ambient threads: every dock exchange
  // bumps their `last_active`, so unsplit they permanently squat at the top of
  // the list above chats the user deliberately started here. They stay
  // reachable (and continuable) under the collapsed "Other conversations"
  // section — demoted, never hidden.
  const chatRows = useMemo(
    () =>
      (rows ?? []).filter((r) => r.appOrigin === "chat" || r.appOrigin == null),
    [rows],
  );
  const ambientRows = useMemo(
    () =>
      (rows ?? []).filter((r) => r.appOrigin != null && r.appOrigin !== "chat"),
    [rows],
  );
  const visible = useMemo(
    () =>
      needle
        ? chatRows.filter((r) => r.title.toLowerCase().includes(needle))
        : chatRows,
    [needle, chatRows],
  );
  const visibleAmbient = useMemo(
    () =>
      needle
        ? ambientRows.filter((r) => r.title.toLowerCase().includes(needle))
        : ambientRows,
    [needle, ambientRows],
  );
  const visibleShared = useMemo(
    () =>
      needle
        ? (sharedRows ?? []).filter((r) => r.title.toLowerCase().includes(needle))
        : (sharedRows ?? []),
    [needle, sharedRows],
  );
  // A search that hits an ambient thread must surface it — a collapsed match
  // reads as "not found".
  const showAmbient = othersOpen || (needle.length > 0 && visibleAmbient.length > 0);
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
        description: t.deleteBody,
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
    // Every row names its interlocutor with the assistant's creature icon —
    // sessions are assistant-bound, so "which assistant is this chat with" is
    // a property of the row, not of the surface. Shared rows echo their bound
    // assistant server-side (a room binds ANY workspace assistant at
    // creation, default the primary).
    const rowAssistant =
      (row.assistantId ? assistantById.get(row.assistantId) : undefined) ??
      primary;
    // Unread is a DOT, not a count (multiplayer chat T7): shared rows only,
    // off `last_active_at` vs this device's localStorage watermark. The open
    // room never dots — the surface stamps the watermark as activity lands.
    const unread =
      "startedByUserId" in row &&
      row.id !== activeSessionId &&
      isRoomUnread(workspaceId, row.id, row.lastActive);
    const working =
      "startedByUserId" in row &&
      (activityBySession[row.id]?.working ?? row.status === "running");
    return (
    <div key={row.id} className="group relative">
      <Link
        href={href}
        aria-current={row.id === activeSessionId ? "page" : undefined}
        className={rowCls(row.id === activeSessionId)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {rowAssistant && (
            <span
              className={cn(
                "shrink-0",
                working && "animate-pulse motion-reduce:animate-none",
              )}
              role={working ? "status" : undefined}
              aria-label={
                working
                  ? format(t.workingAria, { name: rowAssistant.name })
                  : undefined
              }
              title={
                working
                  ? format(t.workingAria, { name: rowAssistant.name })
                  : rowAssistant.name
              }
              data-chat-working={working ? "true" : undefined}
            >
              <AssistantAvatar
                id={rowAssistant.id}
                name={rowAssistant.name}
                iconSeed={rowAssistant.iconSeed ?? undefined}
                size="xs"
              />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 truncate">{row.title}</span>
              {"transport" in row && row.transport && row.transport !== "web" && (
                <span
                  aria-label={format(t.roomTransportAria, {
                    transport: t.roomTransport[row.transport as keyof typeof t.roomTransport] ?? row.transport,
                  })}
                  className="shrink-0 rounded border border-sidebar-border px-1 text-[10px] leading-4 text-sidebar-foreground/60"
                >
                  {t.roomTransport[row.transport as keyof typeof t.roomTransport] ?? row.transport}
                </span>
              )}
              {unread && (
                <span
                  role="status"
                  aria-label={t.unreadDotAria}
                  title={t.unreadDotAria}
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              )}
            </span>
            {"startedByUserId" in row && (
              <span className="mt-0.5 block truncate text-[11px] text-sidebar-foreground/50">
                {row.startedByName
                  ? format(t.startedBy, { name: row.startedByName })
                  : t.startedByUnknown}
              </span>
            )}
          </span>
        </span>
      </Link>
      <button
        type="button"
        aria-label={t.rowActionsAria}
        onClick={() => setMenuFor(menuFor === row.id ? null : row.id)}
        // Always visible with a 44px hit box on a phone (responsive contract
        // M2 / M3): the row itself navigates on tap, so a hidden 18px menu
        // made rename / delete a blind hunt there. Desktop keeps the
        // hover reveal at its compact size.
        className="absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded text-sidebar-foreground/50 opacity-100 transition-opacity focus:opacity-100 md:right-1 md:size-6 md:opacity-0 md:group-hover:opacity-100"
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
  const startWorkspaceChat = useCallback(async () => {
    if (creatingShared) return;
    setCreatingShared(true);
    try {
      const created = await createWorkspaceSession(workspaceId);
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
    <div className="flex flex-col gap-3 px-1 pt-1">
      {view === "personal" ? (
        <Link
          href={base}
          aria-current={onChatSurface && !activeSessionId ? "page" : undefined}
          className={cn(
            rowCls(onChatSurface && !activeSessionId),
            "flex items-center gap-2 pr-2 md:pr-2",
          )}
        >
          <Plus className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t.newChat}</span>
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => void startWorkspaceChat()}
          disabled={creatingShared}
          className={cn(
            rowCls(false),
            "flex items-center gap-2 pr-2 md:pr-2 disabled:opacity-50",
          )}
        >
          <Plus className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t.newWorkspaceChat}</span>
        </button>
      )}

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t.searchPlaceholder}
        aria-label={t.searchPlaceholder}
        className={cn(
          "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[16px] md:text-[12px]",
          "outline-none focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground/60",
        )}
      />

      {error && (
        <p className="px-1 text-[11px] leading-snug text-destructive">{error}</p>
      )}

      {view === "personal" && (
        <div>
          <div className={sectionHeaderCls}>{t.railAria}</div>
          <div className="flex flex-col gap-0.5">
            {rows === null && <RailRowsSkeleton />}
            {rows !== null && visible.length === 0 && (
              <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
                {t.railEmpty}
              </div>
            )}
            {visible.map((row) =>
              renderRow(row, `${base}?s=${encodeURIComponent(row.id)}`),
            )}
          </div>
        </div>
      )}

      {view === "workspace" && (
        <div>
          <div className={sectionHeaderCls}>{t.viewWorkspace}</div>
          <div className="flex flex-col gap-0.5">
            {sharedRows === null && <RailRowsSkeleton />}
            {sharedRows !== null && visibleShared.length === 0 && (
              <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
                {t.workspaceRailEmpty}
              </div>
            )}
            {visibleShared.map((row) =>
              renderRow(
                row,
                `${base}?v=workspace&s=${encodeURIComponent(row.id)}`,
              ),
            )}
          </div>
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
