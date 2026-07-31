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
 * Fetches its own copy of the lists (the "sidebar fetches its own copy"
 * pattern the Tasks panel established) and re-fetches on
 * `CHAT_SESSIONS_REFRESH_EVENT` — the surface dispatches it when a turn
 * settles (auto-title), when a fresh session is adopted mid-turn, and when a
 * shared chat is started, so the rail tracks the conversation without either
 * side owning the other's state.
 *
 * Spec: docs/architecture/features/chat-app.md → "Sidebar panel".
 * [COMP:app-web/sidebar-panel-chat]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import {
  listWorkspaceAssistants,
  type WorkspaceAssistantSummary,
} from "@/lib/api/views";
import {
  CHAT_SESSIONS_REFRESH_EVENT,
  dispatchChatSessionsRefresh,
} from "@/lib/chat-session-events";
import {
  createWorkspaceSession,
  deleteSession,
  listSessionsForAssistants,
  listWorkspaceSessions,
  renameSessionTitle,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";

/** The Brain panel's nav-row recipe — active is the `.doc-nav-active` pill. */
const rowCls = (active: boolean) =>
  cn(
    "block w-full rounded-md px-2 py-1.5 pr-7 text-left text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

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

  const [rows, setRows] = useState<DocSession[] | null>(null);
  const [sharedRows, setSharedRows] = useState<WorkspaceSession[] | null>(null);
  const [assistants, setAssistants] = useState<WorkspaceAssistantSummary[]>([]);
  const [search, setSearch] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ambient-thread section's disclosure. Collapsed by default: those
  // threads are reachable, not top-of-mind.
  const [othersOpen, setOthersOpen] = useState(false);
  const [creatingShared, setCreatingShared] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Sessions are assistant-bound, so the unified rail merges every
      // accessible assistant's list — a thread started with a second
      // assistant (in the dock or here) must not be invisible.
      const roster = await listWorkspaceAssistants(workspaceId);
      setAssistants(roster);
      const [personal, shared] = await Promise.all([
        listSessionsForAssistants({
          workspaceId,
          assistantIds: roster.map((a) => a.id),
        }),
        listWorkspaceSessions({ workspaceId }),
      ]);
      setRows(personal);
      setSharedRows(shared);
    } catch {
      setRows((prev) => prev ?? []);
      setSharedRows((prev) => prev ?? []);
    }
  }, [workspaceId]);

  useEffect(() => {
    setRows(null);
    setSharedRows(null);
    void refresh();
  }, [refresh]);

  // The surface (and this panel itself, after a rename/delete) signals list
  // changes here — payloads are signals, never data, so just re-fetch.
  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
  }, [refresh]);

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
        await renameSessionTitle(row.id, next.trim());
        setError(null);
        await refresh();
        dispatchChatSessionsRefresh(workspaceId);
      } catch {
        setError(t.renameFailed);
      }
    },
    [refresh, t, workspaceId],
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
        // Deleting the OPEN thread: clear the URL so the surface resets to a
        // fresh chat instead of hydrating a dead session id.
        if (row.id === activeSessionId) router.replace(base, { scroll: false });
        await refresh();
        dispatchChatSessionsRefresh(workspaceId);
      } catch {
        setError(t.deleteFailed);
      }
    },
    [activeSessionId, base, refresh, router, t, workspaceId],
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
    // a property of the row, not of the surface. Shared chats are always the
    // workspace primary.
    const rowAssistant =
      "startedByUserId" in row
        ? primary
        : (row.assistantId ? assistantById.get(row.assistantId) : undefined) ??
          primary;
    return (
    <div key={row.id} className="group relative">
      <Link
        href={href}
        aria-current={row.id === activeSessionId ? "page" : undefined}
        className={rowCls(row.id === activeSessionId)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {rowAssistant && (
            <span className="shrink-0" title={rowAssistant.name}>
              <AssistantAvatar
                id={rowAssistant.id}
                name={rowAssistant.name}
                iconSeed={rowAssistant.iconSeed ?? undefined}
                size="xs"
              />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate">{row.title}</span>
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
        className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-sidebar-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      >
        <MoreHorizontal className="size-3.5" aria-hidden />
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
      await refresh();
      dispatchChatSessionsRefresh(workspaceId);
    } catch {
      setError(t.newWorkspaceChatFailed);
    } finally {
      setCreatingShared(false);
    }
  }, [base, creatingShared, refresh, router, t, workspaceId]);

  return (
    <div className="flex flex-col gap-3 px-1 pt-1">
      {view === "personal" ? (
        <Link
          href={base}
          aria-current={onChatSurface && !activeSessionId ? "page" : undefined}
          className={cn(
            rowCls(onChatSurface && !activeSessionId),
            "flex items-center gap-2 pr-2",
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
            "flex items-center gap-2 pr-2 disabled:opacity-50",
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
          "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px]",
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
            {rows === null && (
              <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
                {t.loading}
              </div>
            )}
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
            {sharedRows === null && (
              <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
                {t.loading}
              </div>
            )}
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
