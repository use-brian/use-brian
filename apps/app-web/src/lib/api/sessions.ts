import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Typed fetchers for the app-web session-resume flow.
 *
 * Powers the "send a message, refresh, history reappears" UX in
 * `apps/app-web/src/components/chrome/floating-chat.tsx` — on mount
 * we look up the latest session for the active workspace + assistant +
 * surface (`app_origin` — `'doc'` on the doc dock, else the workspace
 * surface the dock is mounted over), fetch its messages, and seed
 * `useChatSession`'s message list.
 *
 * Two endpoints under `packages/api/src/routes/sessions.ts`:
 *
 *   GET /api/sessions?assistantId=<id>&appOrigin=<origin>
 *     Sidebar list. Migration 187 added `app_origin` filtering — passing
 *     `?appOrigin=<origin>` returns sessions tagged with that surface plus
 *     the unscoped (NULL) rows that predate the migration, ordered by
 *     `last_active_at DESC LIMIT 50`. Workspace scoping is implicit:
 *     the assistantId is workspace-bound — every dock defaults
 *     to the workspace primary (doc-editing is a context-injected
 *     skill, not a dedicated assistant), with the chat dock offering a
 *     switcher to any other accessible workspace assistant.
 *
 *   GET /api/sessions/:id/messages
 *     Ordered by `sequence_num ASC`. Wire shape:
 *       { id, role, content, timestamp, senderUserId }
 *     where `content` is the JSONB stored on `session_messages` — either
 *     a plain string or an array of Anthropic-style content blocks
 *     (`{ type: 'text', text: '…' }`, plus tool_use / tool_result rows
 *     for assistant turns). The floating-chat consumer flattens to text
 *     the same way `apps/web` does in `chat-experience.tsx::extractText`.
 *
 * [COMP:app-web/sessions-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";
import { z } from "zod";
import type { DocumentAttachment } from "@use-brian/chat-ui";
import {
  legacyRoomPolicy,
  parseChatSessionPolicy,
  PERSONAL_CHAT_POLICY,
  type ChatSessionPolicy,
} from "@/lib/chat-session-policy";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** Sidebar list row — mirrors what /api/sessions returns. */
export type DocSession = {
  /** Metadata link only; opening it still requires current history admission. */
  recoveredFromSessionId?: string;
  transport?: string;
  id: string;
  title: string;
  /** Current admitted immutable revision identity; never an allow token. */
  titleRevisionId?: string | null;
  channelId: string;
  /** Provider channel/topic name, separate from the conversation title. */
  channelName?: string | null;
  /** ISO string — server emits a Date which JSON-serialises here. */
  lastActive: string;
  /**
   * The surface that minted the session (migrations 187/255), `null` for rows
   * predating the migration. The Chat app's sidebar rail uses it to demote
   * ambient dock threads into a collapsed "Other conversations" section —
   * `'chat'` and legacy `null` count as chat-app sessions, matching the
   * server's own `?appOrigin=` filter convention.
   */
  appOrigin: string | null;
  /**
   * The assistant the session is bound to. `GET /api/sessions` now echoes it
   * server-side (`assistantId` per row — needed by `scope=workspace`, where
   * rows span the workspace's assistants); workspace-shared rows echo it
   * too (a room binds ANY workspace assistant at creation, default the
   * primary). Sessions are assistant-bound with two per-turn-addressable
   * exceptions (rooms and the doc dock's thread — chat-app.md → "Choosing
   * an assistant"), so the Chat app still resolves this per thread.
   */
  assistantId?: string;
  /** Immutable Team/Project binding for this conversation. */
  contextGroupId?: string | null;
  contextProjectId?: string | null;
  /** The turn slot (`running` while a turn is live), for the rail's working
   *  pulse on every row (chat-parity T4). */
  status?: string;
  /** How this conversation behaves (chat-parity T1): the Chat app reads these
   *  flags, never which list the row came from. */
  policy?: ChatSessionPolicy;
  /** Humans taking part, the viewer counted; `null` when unknown (D2). */
  humanCount?: number | null;
};

/**
 * One historical row from `session_messages`. The `content` field is
 * intentionally `unknown` — the consumer flattens it via
 * `extractMessageText` (re-exported) so the renderer never sees raw
 * Anthropic content blocks.
 */
/**
 * One outbound file attachment on an assistant row (`sendFile`,
 * `session_messages.attachments`). Soft-references a `workspace_files`
 * row; download resolves through `GET /api/doc-files/:workspaceId/:fileId`.
 */
type SessionFileAttachment = {
  fileId: string;
  workspaceId: string;
  path: string;
  name: string;
  mime: string;
  sizeBytes: number;
  caption?: string;
};

export type DocSessionMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: unknown;
  /** ISO string — server emits a Date which JSON-serialises here. */
  timestamp: string;
  /** Outbound file attachments (assistant rows only). Absent/empty when none. */
  attachments?: SessionFileAttachment[];
  senderUserId: string | null;
  /** The ANSWERING assistant per assistant row (multi-assistant rooms, T9;
   *  migration 390). Null on human rows and pre-390 history — render as the
   *  session's bound assistant. */
  senderAssistantId?: string | null;
  /** Non-null marks an external provider bot. Empty string uses a neutral label. */
  publishedSenderName?: string | null;
  /** Sender's display name (`users.name` ?? email), resolved server-side so
   *  the client can attribute *other* members' comments. `null` for assistant
   *  rows and the rare unknown sender (e.g. a deleted user). */
  senderName: string | null;
  /** Sender's avatar URL, resolved server-side so the client can render *other*
   *  members' photos in comment threads. `null` for assistant rows, members
   *  with no photo (→ initials fallback), and the rare unknown sender. See
   *  `docs/architecture/platform/user-profile.md`. */
  senderAvatarUrl?: string | null;
  /** The quote this message replied to (`session_messages.reply_to_text`) —
   *  a text SNAPSHOT, so history restores the quoted block but not a link
   *  back to the row. `null` on every ordinary message. */
  replyToText?: string | null;
};

/**
 * Raw row shape returned by the list endpoint. The server emits
 * `lastActive` as a Date — JSON.stringify turns that into an ISO string,
 * but we type it loosely (string | Date) so a hypothetical SSR consumer
 * passing the already-parsed object through doesn't need to re-coerce.
 */
type RawListRow = {
  recoveredFromSessionId?: string;
  id: string;
  title: string;
  /** Current admitted immutable revision identity; never an allow token. */
  titleRevisionId?: string | null;
  channelId: string;
  /** Provider channel/topic name, separate from the conversation title. */
  channelName?: string | null;
  lastActive: string | Date;
  appOrigin?: string | null;
  /** The session's bound assistant (echoed per row; spans assistants under
   *  `scope=workspace`). */
  assistantId?: string;
  /** Where the conversation happened (`web`, `telegram`, `slack`, ...).
   *  Echoed by the list route; only `channels=all` returns non-web rows. */
  channelType?: string;
  contextGroupId?: string | null;
  contextProjectId?: string | null;
  status?: string;
  policy?: unknown;
  humanCount?: number | null;
};

type RawMessageRow = {
  id: string;
  role: string;
  content: unknown;
  timestamp: string | Date;
  attachments?: SessionFileAttachment[];
  senderUserId?: string | null;
  senderAssistantId?: string | null;
  publishedSenderName?: string | null;
  senderName?: string | null;
  senderAvatarUrl?: string | null;
  replyToText?: string | null;
};

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Fetch the most recently active session for the given workspace +
 * assistant + surface (`appOrigin` — `'doc'` for the doc dock, else the
 * non-doc workspace surface). Returns `null` when none exist or the
 * request fails (silent fail — the caller starts a fresh chat instead of
 * surfacing an error toast).
 *
 * The list endpoint orders by `last_active_at DESC`; we take the first
 * row. Workspace scoping is implicit through the assistant — the
 * assistant is workspace-bound.
 *
 * Accepts an optional `signal` so a host effect can cancel mid-flight
 * when the assistant id changes.
 */
export async function fetchLatestSession(opts: {
  workspaceId: string;
  /** Required on the per-assistant path; ignored under `scope: 'workspace'`. */
  assistantId?: string;
  /** The surface scope — the dock's `origin` (`'doc'`, `'brain'`, …). */
  appOrigin: string;
  /**
   * `'workspace'` lists the caller's sessions across EVERY assistant in
   * `workspaceId` instead of one assistant's. The doc dock resumes with it:
   * its thread is per-turn addressable, so the latest doc thread is the
   * resume target no matter which assistant is currently picked.
   */
  scope?: "workspace";
  signal?: AbortSignal;
}): Promise<DocSession | null> {
  const qs = new URLSearchParams();
  if (opts.scope === "workspace") {
    qs.set("workspaceId", opts.workspaceId);
    qs.set("scope", "workspace");
  } else {
    if (!opts.assistantId) return null;
    qs.set("assistantId", opts.assistantId);
  }
  qs.set("appOrigin", opts.appOrigin);

  try {
    const res = await authFetch(
      `${API_URL}/api/sessions?${qs.toString()}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return null;
    const data = (await res.json()) as RawListRow[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    return {
      id: first.id,
      title: first.title,
      ...(first.titleRevisionId !== undefined ? {titleRevisionId: first.titleRevisionId} : {}),
      channelId: first.channelId,
      lastActive: toIso(first.lastActive),
      appOrigin: first.appOrigin ?? null,
      assistantId: first.assistantId ?? opts.assistantId,
      contextGroupId: first.contextGroupId ?? null,
      contextProjectId: first.contextProjectId ?? null,
    };
  } catch {
    // Network / abort / parse — treat as no resume.
    return null;
  }
}

/**
 * The caller's own web sessions for an assistant, newest first — the Chat
 * app's Personal rail (chat-app.md → "Personal view").
 *
 * Deliberately sends NO `appOrigin`: T3 makes Personal a *unified* history, so
 * a thread started in the floating dock and one started here are the same list.
 * Filtering by origin would split a user's history across two surfaces for no
 * reason they could see.
 *
 * Cached lists use strict mode: a failed read must not replace history with
 * a successful empty value. Legacy best-effort consumers can omit it.
 */
export async function listPersonalSessions(opts: {
  workspaceId: string;
  assistantId?: string;
  archived?: boolean;
  strict?: boolean;
  before?: { lastActive: string; id: string };
  signal?: AbortSignal;
}): Promise<DocSession[]> {
  const qs = new URLSearchParams();
  qs.set("scope", "workspace");
  qs.set("channels", "all");
  qs.set("workspaceId", opts.workspaceId);
  if (opts.archived) qs.set("archived", "true");
  if (opts.before) { qs.set("before", opts.before.lastActive); qs.set("beforeId", opts.before.id); }
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions?${qs.toString()}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) {
      if (opts.strict) throw new Error(`chat_list_failed: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as RawListRow[];
    if (!Array.isArray(data)) {
      if (opts.strict) throw new Error("chat_list_invalid_response");
      return [];
    }
    return data.map((r) => ({
      id: r.id,
      ...(r.recoveredFromSessionId ? { recoveredFromSessionId: r.recoveredFromSessionId } : {}),
      title: r.title,
      ...(r.titleRevisionId !== undefined ? {titleRevisionId: r.titleRevisionId} : {}),
      channelId: r.channelId,
      ...(r.channelName ? { channelName: r.channelName } : {}),
      lastActive: toIso(r.lastActive),
      appOrigin: r.appOrigin ?? null,
      assistantId: r.assistantId ?? opts.assistantId,
      transport: r.channelType ?? "web",
      contextGroupId: r.contextGroupId ?? null,
      contextProjectId: r.contextProjectId ?? null,
      ...(r.status ? { status: r.status } : {}),
      // An older server sends no policy: every row on this list is a
      // personal chat, a room with one human (chat-parity D1).
      policy: parseChatSessionPolicy(r.policy) ?? PERSONAL_CHAT_POLICY,
      humanCount: typeof r.humanCount === "number" ? r.humanCount : 1,
    }));
  } catch (error) {
    if (opts.strict) throw error;
    return [];
  }
}

/**
 * A workspace-shared chat row — the Chat app's Workspace rail. Same shape as
 * `DocSession` plus the starter identity for the "Started by" chip and the
 * live `status` (a `running` session has a teammate mid-turn).
 */
export type WorkspaceSession = DocSession & {
  status: string;
  startedByUserId: string;
  startedByName: string | null;
  startedByAvatarUrl: string | null;
  /**
   * The wire the room lives on: `web` for a Chat app room, or the provider of
   * a converged group (`telegram`, `slack`, ...) that the rail badges.
   * Absent means web.
   */
  transport?: string;
  /** A converged group's brain capture (D4); absent on web rooms. */
  roomCapture?: boolean;
};

type RawWorkspaceRow = RawListRow & {
  status?: string;
  startedByUserId?: string;
  startedByName?: string | null;
  startedByAvatarUrl?: string | null;
  /** The room's bound assistant (rooms may bind any workspace assistant). */
  assistantId?: string;
  transport?: string;
  roomCapture?: boolean;
};

function toWorkspaceSession(r: RawWorkspaceRow): WorkspaceSession {
  return {
    id: r.id,
    title: r.title,
      ...(r.titleRevisionId !== undefined ? {titleRevisionId: r.titleRevisionId} : {}),
    channelId: r.channelId,
    lastActive: toIso(r.lastActive),
    // Shared chats are always `app_origin='chat'` (the isSharedChatSession
    // predicate) — the server list doesn't bother echoing it.
    appOrigin: r.appOrigin ?? "chat",
    status: r.status ?? "idle",
    startedByUserId: r.startedByUserId ?? "",
    startedByName: r.startedByName ?? null,
    startedByAvatarUrl: r.startedByAvatarUrl ?? null,
    ...(r.assistantId ? { assistantId: r.assistantId } : {}),
    contextGroupId: r.contextGroupId ?? null,
    contextProjectId: r.contextProjectId ?? null,
    transport: r.transport ?? "web",
    ...(r.roomCapture !== undefined ? { roomCapture: r.roomCapture } : {}),
    policy: parseChatSessionPolicy(r.policy) ?? legacyRoomPolicy(r.transport),
    humanCount: typeof r.humanCount === "number" ? r.humanCount : null,
  };
}

/**
 * One conversation as `GET /api/sessions/:id` reads it (chat-parity T1): the
 * row fields plus the policy and human count, for a thread not (yet) in a
 * list this client holds. Rooms carry the starter identity.
 */
export type ChatSessionSummary = DocSession & {
  audience: "personal" | "workspace";
  transport: string;
  startedByUserId?: string;
  startedByName?: string | null;
  startedByAvatarUrl?: string | null;
  policy: ChatSessionPolicy;
};

/** Read one conversation's summary; `null` when absent, unreadable or on failure. */
export async function getChatSessionSummary(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChatSessionSummary | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}`,
      signal ? { signal } : {},
    );
    if (!res.ok) return null;
    const r = (await res.json()) as RawWorkspaceRow & {
      audience?: string;
      transport?: string;
    };
    const policy = parseChatSessionPolicy(r.policy);
    if (!r?.id || !policy) return null;
    return {
      id: r.id,
      ...(r.recoveredFromSessionId ? { recoveredFromSessionId: r.recoveredFromSessionId } : {}),
      title: r.title,
      ...(r.titleRevisionId !== undefined ? {titleRevisionId: r.titleRevisionId} : {}),
      channelId: r.channelId,
      lastActive: toIso(r.lastActive),
      appOrigin: r.appOrigin ?? null,
      ...(r.assistantId ? { assistantId: r.assistantId } : {}),
      contextGroupId: r.contextGroupId ?? null,
      contextProjectId: r.contextProjectId ?? null,
      ...(r.status ? { status: r.status } : {}),
      audience: r.audience === "workspace" ? "workspace" : "personal",
      transport: r.transport ?? "web",
      ...(r.startedByUserId ? { startedByUserId: r.startedByUserId } : {}),
      ...(r.startedByName !== undefined ? { startedByName: r.startedByName } : {}),
      ...(r.startedByAvatarUrl !== undefined ? { startedByAvatarUrl: r.startedByAvatarUrl } : {}),
      policy,
      humanCount: typeof r.humanCount === "number" ? r.humanCount : null,
    };
  } catch {
    return null;
  }
}

/**
 * Switch a converged group's brain capture (`PATCH
 * /api/sessions/:id/room-capture`, unified-sessions D4). Workspace admins
 * only; returns false when the server refused.
 */
export async function setRoomCapture(sessionId: string, enabled: boolean): Promise<boolean> {
  try {
    const res = await authFetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/room-capture`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Archive changes only the current viewer's session-list preference. */
export async function setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
  const res = await authFetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) throw new Error("chat_archive_failed");
}

/**
 * The workspace's shared chats (`GET /api/sessions/workspace`), newest first.
 *
 * Clearance-filtered server-side: a session above the caller's clearance is
 * simply absent, with no "you lack clearance" row — the existence of the
 * conversation is itself the thing being withheld. Returns `[]` on failure.
 */
export async function listWorkspaceSessions(opts: {
  workspaceId: string;
  archived?: boolean;
  signal?: AbortSignal;
  strict?: boolean;
  contextProjectId?: string | null;
  before?: { lastActive: string; id: string };
}): Promise<WorkspaceSession[]> {
  try {
    const query = new URLSearchParams({ workspaceId: opts.workspaceId });
    if (opts.archived) query.set("archived", "true");
    if (opts.contextProjectId !== undefined) query.set("contextProjectId", opts.contextProjectId ?? "general");
    if (opts.before) { query.set("before", opts.before.lastActive); query.set("beforeId", opts.before.id); }
    const res = await authFetch(
      `${API_URL}/api/sessions/workspace?${query}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) {
      if (opts.strict) throw new Error(`chat_list_failed: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as RawWorkspaceRow[];
    if (!Array.isArray(data)) {
      if (opts.strict) throw new Error("chat_list_invalid_response");
      return [];
    }
    return data.map(toWorkspaceSession);
  } catch (error) {
    if (opts.strict) throw error;
    return [];
  }
}

/**
 * A row in the chat-audit browser's session list: the caller's own session
 * on ANY channel plus the workspace's shared rooms, with the channel it ran
 * on so the rail can label a Telegram thread as such.
 */
export type AuditSession = DocSession & {
  channelType: string;
  /** `true` for a workspace-shared room (listed for every member). */
  shared: boolean;
};

/**
 * Every conversation the viewer may audit in a workspace, newest first
 * (`docs/architecture/features/chat-audit.md` -> "Session list"):
 *
 *   - own sessions across every assistant and every channel
 *     (`GET /api/sessions?scope=workspace&channels=all`), and
 *   - the workspace's shared rooms (`GET /api/sessions/workspace`), which
 *     the server already clearance-filters.
 *
 * Merged and de-duplicated by id (a room the viewer started appears in
 * both). Returns `[]` on failure - the rail reads as "nothing to audit yet".
 */
export async function listAuditSessions(opts: {
  workspaceId: string;
  signal?: AbortSignal;
}): Promise<AuditSession[]> {
  const qs = new URLSearchParams({
    workspaceId: opts.workspaceId,
    scope: "workspace",
    channels: "all",
  });
  const [own, shared] = await Promise.all([
    (async () => {
      try {
        const res = await authFetch(
          `${API_URL}/api/sessions?${qs.toString()}`,
          opts.signal ? { signal: opts.signal } : {},
        );
        if (!res.ok) return [] as AuditSession[];
        const data = (await res.json()) as RawListRow[];
        if (!Array.isArray(data)) return [] as AuditSession[];
        return data.map<AuditSession>((r) => ({
          id: r.id,
          title: r.title,
      ...(r.titleRevisionId !== undefined ? {titleRevisionId: r.titleRevisionId} : {}),
          channelId: r.channelId,
          lastActive: toIso(r.lastActive),
          appOrigin: r.appOrigin ?? null,
          ...(r.assistantId ? { assistantId: r.assistantId } : {}),
          contextGroupId: r.contextGroupId ?? null,
          contextProjectId: r.contextProjectId ?? null,
          channelType: r.channelType ?? "web",
          shared: false,
        }));
      } catch {
        return [] as AuditSession[];
      }
    })(),
    listWorkspaceSessions({
      workspaceId: opts.workspaceId,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  ]);
  const byId = new Map<string, AuditSession>();
  for (const s of own) byId.set(s.id, s);
  for (const s of shared) {
    byId.set(s.id, {
      id: s.id,
      title: s.title,
      ...(s.titleRevisionId !== undefined ? {titleRevisionId: s.titleRevisionId} : {}),
      channelId: s.channelId,
      lastActive: s.lastActive,
      appOrigin: s.appOrigin,
      ...(s.assistantId ? { assistantId: s.assistantId } : {}),
      contextGroupId: s.contextGroupId ?? null,
      contextProjectId: s.contextProjectId ?? null,
      channelType: "web",
      shared: true,
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0,
  );
}

/**
 * Start a workspace-shared chat (`POST /api/sessions/workspace`). Explicit
 * create rather than a flag on the first turn, so the thread is listable by
 * teammates from the moment it is started, not from the first message.
 */
export async function createWorkspaceSession(
  workspaceId: string,
  /** Bind the room to a specific workspace assistant (default: primary).
   *  The binding is per-room for its lifetime - per-turn routing is P3. */
  assistantId?: string,
  context?: { contextGroupId: string | null; contextProjectId: string | null; expectedPolicyRevision?:string },
): Promise<WorkspaceSession> {
  const res = await authFetch(`${API_URL}/api/sessions/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, ...(assistantId ? { assistantId } : {}), ...context }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Create failed: ${res.status}`);
  }
  return toWorkspaceSession((await res.json()) as RawWorkspaceRow);
}

/**
 * Move a room's bound (default) assistant
 * (`PATCH /api/sessions/:id/assistant`).
 *
 * Rooms only — a personal thread stays bound for its lifetime. The server
 * admits exactly the assistants that could already answer here by `@`
 * mention (same workspace, not cleared above the room), so a refusal is a
 * real answer worth showing the user rather than a transport failure:
 * the thrown message is the server's own sentence.
 */
export async function rebindWorkspaceSessionAssistant(
  sessionId: string,
  assistantId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/assistant`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assistantId }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Assistant change failed: ${res.status}`);
  }
}

/**
 * Post into a room WITHOUT running a turn (`POST /api/sessions/:id/messages`
 * — multiplayer chat T2). Send = post, instantly, for every member; the
 * assistant replies only when addressed (an ordinary `/api/chat` send).
 * Never busy-gated.
 */
/** A member named in the text who cannot read this room (D-H4) — the sender
 *  is told, the message still posts, and no row is written for them. */
export type UnreachableMention = { id: string; name: string };

export async function postRoomMessage(
  sessionId: string,
  message: string,
  /** The quote this post replies to, when the user picked one. Text only —
   *  the stored quote is a snapshot, not a link (see `_reply-context.ts`). */
  replyTo?: { text: string },
): Promise<{
  id: string;
  sequenceNum: number;
  timestamp: string;
  unreachableMentions: UnreachableMention[];
}> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        ...(replyTo ? { replyTo: { text: replyTo.text } } : {}),
      }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Post failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    id: string;
    sequenceNum: number;
    timestamp: string;
    unreachableMentions?: UnreachableMention[];
  };
  return { ...body, unreachableMentions: body.unreachableMentions ?? [] };
}

/**
 * The room's `@mention` roster (`GET /api/sessions/:id/mentionable`,
 * docs/plans/room-human-mentions.md T-H4) — assistants plus ONLY the
 * workspace members who pass THIS room's clearance. Already filtered
 * server-side: the client must do no clearance logic of its own with the
 * result (D-H4).
 */
export async function fetchMentionableRoster(
  sessionId: string,
): Promise<{
  assistants: { id: string; name: string }[];
  members: { id: string; name: string }[];
}> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/mentionable`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Mentionable roster failed: ${res.status}`);
  }
  return (await res.json()) as {
    assistants: { id: string; name: string }[];
    members: { id: string; name: string }[];
  };
}

/**
 * Stop the turn running in a session (`POST /api/chat/stop`).
 *
 * The caller does not need to know whether the turn is alive or already a
 * phantom — the server aborts a live one and reclaims a dead one, and reports
 * which it did in `via`. Any member who can read the room may call it: a stuck
 * turn blocks everybody, so recovery must not wait for one specific person.
 *
 * Idempotent. A turn that already ended answers `{ stopped: false }` rather
 * than erroring, so two members hitting Stop on the same card both get a calm
 * result.
 */
export async function stopTurn(
  sessionId: string,
): Promise<{ stopped: boolean; via?: string; reason?: string }> {
  const res = await authFetch(`${API_URL}/api/chat/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Stop failed: ${res.status}`);
  }
  return (await res.json()) as { stopped: boolean; via?: string; reason?: string };
}

/**
 * Rewrite one of your own room posts in place
 * (`PATCH /api/sessions/:id/messages/:messageId`).
 *
 * The silent half of editing: a post nobody was asked to answer is repaired
 * where it stands. An edit that ADDRESSES an assistant goes through
 * `/api/chat` with `truncateFromMessageId` instead, because it needs a turn.
 */
export async function editRoomMessage(
  sessionId: string,
  messageId: string,
  message: string,
): Promise<{ unreachableMentions: UnreachableMention[] }> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Edit failed: ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    unreachableMentions?: UnreachableMention[];
  };
  return { unreachableMentions: body.unreachableMentions ?? [] };
}

/**
 * Room typing beacon (`POST /api/sessions/:id/typing`). Fire-and-forget
 * presence: errors are swallowed — a lost beacon only delays the indicator,
 * and the server's staleness sweep clears any flag whose beacons stop.
 */
export async function postSessionTyping(
  sessionId: string,
  isTyping: boolean,
): Promise<void> {
  try {
    await authFetch(
      `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/typing`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isTyping }),
      },
    );
  } catch {
    // Best-effort by design.
  }
}

/** Rename a session (`PATCH /api/sessions/:id`). Throws on rejection so the
 *  rail can surface why (403 on someone else's private thread). */
export async function renameSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Rename failed: ${res.status}`);
  }
}

/** Delete a session (`DELETE /api/sessions/:id`). Throws on rejection — a 409
 *  means a turn is still running, which the caller shows as a retry hint. */
export async function deleteSession(sessionId: string): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Delete failed: ${res.status}`);
  }
}

/**
 * Strict readers reject failures so they can preserve the painted transcript.
 * Legacy callers retain their best-effort empty fallback.
 */
export async function fetchSessionMessages(
  sessionId: string,
  opts?: { signal?: AbortSignal; strict?: boolean },
): Promise<DocSessionMessage[]> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      opts?.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { code?: unknown } | null;
      throw new SessionHistoryError(res.status, body?.code === "session_history_unavailable" ? body.code : null);
    }
    const data = (await res.json()) as RawMessageRow[];
    if (!Array.isArray(data)) throw new Error("chat_history_invalid_response");
    return data.map((m) => ({
      id: m.id,
      role: (m.role as DocSessionMessage["role"]) ?? "assistant",
      content: m.content,
      timestamp: toIso(m.timestamp),
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      senderUserId: m.senderUserId ?? null,
      senderAssistantId: m.senderAssistantId ?? null,
      publishedSenderName: m.publishedSenderName ?? null,
      senderName: m.senderName ?? null,
      senderAvatarUrl: m.senderAvatarUrl ?? null,
      replyToText: m.replyToText ?? null,
    }));
  } catch (error) {
    if (opts?.strict) throw error;
    return [];
  }
}

class SessionHistoryError extends Error {
  constructor(readonly status: number, readonly code: "session_history_unavailable" | null) {
    super(`chat_history_failed: ${status}`);
  }
}
export function isSessionHistoryUnavailable(error: unknown): boolean {
  return error instanceof SessionHistoryError && error.status === 403 && error.code === "session_history_unavailable";
}

const recoveryPreview = z.object({
  sessionId: z.string().uuid(), workspaceId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["available", "busy"]), continuationSessionId: z.string().uuid().nullable(),
  contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(),
}).strict();
const recoveryResult = z.object({
  sessionId: z.string().uuid(), assistantId: z.string().uuid(), workspaceId: z.string().uuid(), replayed: z.boolean(),
  channelId: z.string(), lastActive: z.string().datetime({ offset: true }), status: z.string(),
  contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(),
  policy: z.unknown().transform((value, context) => {
    const parsed = parseChatSessionPolicy(value);
    if (!parsed) { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid recovered chat policy" }); return z.NEVER; }
    return parsed;
  }),
}).strict();
export type ChatRecoveryResult = z.infer<typeof recoveryResult>;
class RecoveryError extends Error {
  constructor(readonly reason: "busy" | "changed" | "unavailable" | "failed") { super(`chat_recovery_${reason}`); }
}
export function chatRecoveryFailure(error: unknown): "busy" | "changed" | "unavailable" | "failed" {
  return error instanceof RecoveryError ? error.reason : "failed";
}
async function recoveryResponse(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new RecoveryError(code === "session_recovery_busy" ? "busy" : code === "session_recovery_changed" ? "changed"
      : res.status === 401 || res.status === 403 || res.status === 404 ? "unavailable" : "failed");
  }
  return body;
}
/** Metadata proposal only. Every apply independently rechecks current authority. */
export async function inspectChatRecovery(sessionId: string, workspaceId: string, signal?: AbortSignal) {
  const res = await authFetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/recovery?${new URLSearchParams({ workspaceId })}`, { signal });
  const value = recoveryPreview.parse(await recoveryResponse(res));
  if (value.sessionId !== sessionId || value.workspaceId !== workspaceId) throw new RecoveryError("unavailable");
  return value;
}
/** Repeating the same source/owner operation returns its existing continuation. */
export async function recoverChat(sessionId: string, workspaceId: string, expectedRevision: string, signal?: AbortSignal): Promise<ChatRecoveryResult> {
  const res = await authFetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/recovery`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, expectedRevision }),
  });
  const value = recoveryResult.parse(await recoveryResponse(res));
  if (value.workspaceId !== workspaceId || value.sessionId === sessionId) throw new RecoveryError("unavailable");
  return value;
}

/**
 * Flatten the JSONB `content` field of a `session_messages` row to a
 * plain text string. Mirrors `apps/web`'s `extractText` helper exactly
 * — the wire shape is the same, so the logic is shared.
 *
 * The Anthropic content-block shape is `Array<{ type, ... }>` where
 * `text` blocks carry a `text` string. Assistant turns may also include
 * `tool_use` / `tool_result` blocks which we drop here (they have no
 * direct rendering in the doc chat panel — tool calls only surface
 * live via SSE, not on resume).
 */
/**
 * The chat route wraps each attachment in a
 * `<attached_file id=.. name=.. type=..>…</attached_file>` block so the file
 * rides into the model prompt. Humans should never see that markup — collapse
 * each wrapper to a tidy "📎 <name>" affordance. Text attachments inline their
 * whole body inside the wrapper, so leaving it raw would dump file content into
 * the comment too. No-op for any text without an attachment wrapper.
 */
export function stripAttachmentMarkup(text: string): string {
  if (!text.includes("<attached_file")) return text;
  return text
    .replace(
      /<attached_file\b[^>]*?\bname="([^"]*)"[^>]*>[\s\S]*?<\/attached_file>/g,
      (_match, name: string) => `📎 ${name}`,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Unwrap a model-confabulated `<comment-thread-reply pageId="…">…</comment-thread-reply>`
 * wrapper from a doc comment body. No prompt defines this tag — the doc
 * assistant sometimes invents it around a thread reply; left raw the markers
 * render as literal tag soup and leak an internal page UUID. The open/close
 * markers are removed but the inner reply prose is kept; a half-streamed opener
 * is dropped too. The server now strips this before persist (so new replies are
 * clean); this mirror also scrubs pre-fix rows already in `session_messages`.
 * Mirrors `stripCommentThreadReplyTag` in `@use-brian/shared` (kept inline to
 * avoid pulling the shared barrel into the browser bundle — the same reason
 * `stripFollowUps` is inlined in `floating-chat.tsx`).
 */
export function stripCommentThreadReplyTag(text: string): string {
  if (!text.includes("comment-thread-reply")) return text;
  return text
    .replace(/<\/?comment-thread-reply\b[^>]*>/gi, "")
    .replace(/<comment-thread-reply\b[^>]*$/i, "")
    .trimEnd();
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return stripAttachmentMarkup(content);
  if (Array.isArray(content)) {
    return stripAttachmentMarkup(rawMessageText(content));
  }
  return "";
}

/**
 * The `tool_use` blocks of a persisted assistant turn — name + parsed input,
 * in call order. Feeds the post-turn activity receipt on session reload
 * (`chat-activity.tsx`): the client re-narrates each call from its input the
 * same way the live stream does. Durations are live-only and not restored.
 */
export function extractToolUses(
  content: unknown,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const uses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    uses.push({
      id: typeof b.id === "string" ? b.id : `tool_${uses.length}`,
      name: b.name,
      input:
        b.input && typeof b.input === "object"
          ? (b.input as Record<string, unknown>)
          : {},
    });
  }
  return uses;
}

/** Validate either a live document_payload or a persisted tool input. */
export function parsePresentedDocumentPayload(
  value: unknown,
  fallbackId?: string,
): DocumentAttachment | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id =
    typeof input.toolUseId === "string"
      ? input.toolUseId
      : typeof input.id === "string"
        ? input.id
        : fallbackId;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const sourceName =
    typeof input.sourceName === "string" ? input.sourceName.trim() : "";
  const documentContent = input.content;
  const format = input.format === "markdown" ? "markdown" : "text";
  if (
    !id ||
    !title ||
    title.length > 512 ||
    typeof documentContent !== "string" ||
    documentContent.length === 0 ||
    documentContent.length > 250_000 ||
    sourceName.length > 512
  ) {
    return null;
  }
  return {
    id,
    title,
    content: documentContent,
    format,
    ...(sourceName ? { sourceName } : {}),
  };
}

/**
 * Restore raw-document cards from persisted `presentDocument` tool-use
 * inputs. The server validates the same shape before emitting a live payload;
 * history is still untrusted JSON, so the client repeats the narrow boundary
 * check before handing content to the renderer.
 *
 * Keep the 250k ceiling aligned with MAX_PRESENTED_DOCUMENT_CHARS in core.
 * [COMP:app-web/chat-document-viewer]
 */
export function extractPresentedDocuments(content: unknown): DocumentAttachment[] {
  if (!Array.isArray(content)) return [];
  const documents: DocumentAttachment[] = [];
  const seen = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (
      b.type !== "tool_use" ||
      b.name !== "presentDocument" ||
      typeof b.id !== "string" ||
      seen.has(b.id)
    ) {
      continue;
    }
    const document = parsePresentedDocumentPayload(b.input, b.id);
    if (!document) continue;
    seen.add(document.id);
    documents.push(document);
  }
  return documents;
}

/** Join the text blocks of a message verbatim (wrappers NOT stripped). */
function rawMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

/** Mimes whose bytes ride the message row and are previewable client-side. */
function isPreviewableAttachmentMime(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf";
}

/**
 * Inline media content blocks carried in a persisted message (base64) —
 * images plus natively-attached PDFs. The chat route pushes both down the
 * same inline `image` block lane, so a PDF's bytes ride the message row
 * exactly like an image's do. Store-only files (e.g. a PDF above the inline
 * threshold) carry no block, which is why matching back to tags is by
 * name + mime family rather than raw order.
 */
function inlineMediaBlocks(
  content: unknown,
): Array<{ mimeType: string; data: string; name?: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is { type: string; mimeType: string; data: string; name?: unknown } =>
        !!b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "image" &&
        typeof (b as { mimeType?: unknown }).mimeType === "string" &&
        typeof (b as { data?: unknown }).data === "string" &&
        isPreviewableAttachmentMime((b as { mimeType: string }).mimeType),
    )
    .map((b) => ({
      mimeType: b.mimeType,
      data: b.data,
      name: typeof b.name === "string" ? b.name : undefined,
    }));
}

export type MessageAttachmentRef = {
  id: string;
  name: string;
  mime: string;
  /**
   * Data URL for an inline image thumbnail / PDF preview. Sourced from the
   * media block the message already carries, so it survives past the 7-day
   * upload-cache TTL. On the live-send path this is instead the composer
   * chip's `blob:` object URL. Absent for non-previewable files (rendered as
   * an icon card), store-only rows, and expired/legacy rows.
   */
  dataUrl?: string;
};

const ATTACHED_FILE_TAG_RE = /<attached_file\b([^>]*)>[\s\S]*?<\/attached_file>/g;

function tagAttr(attrs: string, key: string): string {
  const m = attrs.match(new RegExp(`\\b${key}="([^"]*)"`));
  return m ? m[1] : "";
}

/**
 * Split a persisted message into its human text and a structured attachment
 * list, so the renderer can show file cards / image thumbnails instead of raw
 * `<attached_file>` markup. Image / PDF tags are matched to the message's
 * inline media blocks for their preview bytes — by block name when the block
 * carries one, else by mime family in order (a store-only file has a tag but
 * no block, so raw positional zipping would shift every later assignment).
 * Returns `attachments: []` and the text unchanged for any message with no
 * attachments.
 */
export function parseMessageAttachments(content: unknown): {
  text: string;
  attachments: MessageAttachmentRef[];
} {
  const raw = rawMessageText(content);
  if (!raw.includes("<attached_file"))
    return { text: stripCommentThreadReplyTag(raw.trim()), attachments: [] };

  const media = inlineMediaBlocks(content);
  const used: boolean[] = new Array(media.length).fill(false);
  const family = (m: string) => (m === "application/pdf" ? "pdf" : "image");
  const takeBlock = (name: string, mime: string) => {
    const want = family(mime);
    let idx = media.findIndex(
      (b, i) => !used[i] && b.name !== undefined && b.name === name && family(b.mimeType) === want,
    );
    if (idx === -1) idx = media.findIndex((b, i) => !used[i] && family(b.mimeType) === want);
    if (idx === -1) return undefined;
    used[idx] = true;
    return media[idx];
  };

  const attachments: MessageAttachmentRef[] = [];
  for (const match of raw.matchAll(ATTACHED_FILE_TAG_RE)) {
    const attrs = match[1] ?? "";
    const mime = tagAttr(attrs, "type");
    const name = tagAttr(attrs, "name");
    let dataUrl: string | undefined;
    if (isPreviewableAttachmentMime(mime)) {
      const block = takeBlock(name, mime);
      if (block) dataUrl = `data:${block.mimeType};base64,${block.data}`;
    }
    attachments.push({ id: tagAttr(attrs, "id"), name, mime, dataUrl });
  }

  const text = stripCommentThreadReplyTag(
    raw.replace(ATTACHED_FILE_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim(),
  );
  return { text, attachments };
}
