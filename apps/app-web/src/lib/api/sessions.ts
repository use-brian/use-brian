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
import type { DocumentAttachment } from "@use-brian/chat-ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Sidebar list row — mirrors what /api/sessions returns. */
export type DocSession = {
  id: string;
  title: string;
  channelId: string;
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
   * The assistant the session is bound to. Stamped CLIENT-SIDE from the
   * per-assistant fetch (`GET /api/sessions` is assistant-scoped and doesn't
   * echo it); workspace-shared rows echo it server-side (a room binds ANY
   * workspace assistant at creation, default the primary). Sessions
   * are assistant-bound: `/api/chat` rejects a send whose `assistantId`
   * doesn't match the session's, so the Chat app resolves this per thread.
   */
  assistantId?: string;
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
  id: string;
  title: string;
  channelId: string;
  lastActive: string | Date;
  appOrigin?: string | null;
};

type RawMessageRow = {
  id: string;
  role: string;
  content: unknown;
  timestamp: string | Date;
  attachments?: SessionFileAttachment[];
  senderUserId?: string | null;
  senderAssistantId?: string | null;
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
  assistantId: string;
  /** The surface scope — the dock's `origin` (`'doc'`, `'brain'`, …). */
  appOrigin: string;
  signal?: AbortSignal;
}): Promise<DocSession | null> {
  // `workspaceId` is currently unused at the wire level — the server
  // derives workspace from the assistantId — but we accept it so the
  // caller's intent is explicit and we have a hook for future
  // multi-assistant workspaces.
  void opts.workspaceId;

  const qs = new URLSearchParams();
  qs.set("assistantId", opts.assistantId);
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
      channelId: first.channelId,
      lastActive: toIso(first.lastActive),
      appOrigin: first.appOrigin ?? null,
      assistantId: opts.assistantId,
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
 * Returns `[]` on any failure — an empty rail reads as "no history yet", which
 * is the same thing the user does next either way (start a chat).
 */
async function listSessions(opts: {
  workspaceId: string;
  assistantId: string;
  signal?: AbortSignal;
}): Promise<DocSession[]> {
  const qs = new URLSearchParams();
  qs.set("assistantId", opts.assistantId);
  qs.set("workspaceId", opts.workspaceId);
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions?${qs.toString()}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return [];
    const data = (await res.json()) as RawListRow[];
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      id: r.id,
      title: r.title,
      channelId: r.channelId,
      lastActive: toIso(r.lastActive),
      appOrigin: r.appOrigin ?? null,
      assistantId: opts.assistantId,
    }));
  } catch {
    return [];
  }
}

/**
 * The caller's sessions across EVERY given assistant, merged newest-first —
 * the Chat app's unified rail. One `listSessions` call per assistant (the
 * list route is assistant-scoped); a workspace holds a handful of assistants,
 * so the fan-out stays small and the server needs no new query shape. Each
 * row carries the `assistantId` it was fetched under, which is what lets the
 * rail show per-thread assistant icons and the surface send with the RIGHT
 * assistant when an old thread is reopened.
 */
export async function listSessionsForAssistants(opts: {
  workspaceId: string;
  assistantIds: string[];
  signal?: AbortSignal;
}): Promise<DocSession[]> {
  const lists = await Promise.all(
    opts.assistantIds.map((assistantId) =>
      listSessions({
        workspaceId: opts.workspaceId,
        assistantId,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    ),
  );
  return lists
    .flat()
    .sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0));
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
};

type RawWorkspaceRow = RawListRow & {
  status?: string;
  startedByUserId?: string;
  startedByName?: string | null;
  startedByAvatarUrl?: string | null;
  /** The room's bound assistant (rooms may bind any workspace assistant). */
  assistantId?: string;
};

function toWorkspaceSession(r: RawWorkspaceRow): WorkspaceSession {
  return {
    id: r.id,
    title: r.title,
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
  };
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
  signal?: AbortSignal;
}): Promise<WorkspaceSession[]> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/workspace?workspaceId=${encodeURIComponent(opts.workspaceId)}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return [];
    const data = (await res.json()) as RawWorkspaceRow[];
    if (!Array.isArray(data)) return [];
    return data.map(toWorkspaceSession);
  } catch {
    return [];
  }
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
): Promise<WorkspaceSession> {
  const res = await authFetch(`${API_URL}/api/sessions/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, ...(assistantId ? { assistantId } : {}) }),
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
export async function postRoomMessage(
  sessionId: string,
  message: string,
  /** The quote this post replies to, when the user picked one. Text only —
   *  the stored quote is a snapshot, not a link (see `_reply-context.ts`). */
  replyTo?: { text: string },
): Promise<{ id: string; sequenceNum: number; timestamp: string }> {
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
  return (await res.json()) as { id: string; sequenceNum: number; timestamp: string };
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
): Promise<void> {
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
 * Fetch the message history for one session. Returns `[]` on any error
 * or when the session has no messages — the caller treats both as
 * "start fresh".
 */
export async function fetchSessionMessages(
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<DocSessionMessage[]> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      opts?.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return [];
    const data = (await res.json()) as RawMessageRow[];
    if (!Array.isArray(data)) return [];
    return data.map((m) => ({
      id: m.id,
      role: (m.role as DocSessionMessage["role"]) ?? "assistant",
      content: m.content,
      timestamp: toIso(m.timestamp),
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      senderUserId: m.senderUserId ?? null,
      senderAssistantId: m.senderAssistantId ?? null,
      senderName: m.senderName ?? null,
      senderAvatarUrl: m.senderAvatarUrl ?? null,
      replyToText: m.replyToText ?? null,
    }));
  } catch {
    return [];
  }
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

/** Image content blocks carried inline in a persisted message (base64). */
function imageBlocks(content: unknown): Array<{ mimeType: string; data: string }> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is { type: string; mimeType: string; data: string } =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string" &&
      typeof (b as { data?: unknown }).data === "string" &&
      (b as { mimeType: string }).mimeType.startsWith("image/"),
  );
}

export type MessageAttachmentRef = {
  id: string;
  name: string;
  mime: string;
  /**
   * Data URL for an inline image thumbnail. Sourced from the image block the
   * message already carries, so it survives past the 7-day upload-cache TTL.
   * Absent for non-image files (rendered as an icon card) or expired/legacy
   * image rows.
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
 * `<attached_file>` markup. Image tags are matched, in order, to the message's
 * inline image blocks for their thumbnail. Returns `attachments: []` and the
 * text unchanged for any message with no attachments.
 */
export function parseMessageAttachments(content: unknown): {
  text: string;
  attachments: MessageAttachmentRef[];
} {
  const raw = rawMessageText(content);
  if (!raw.includes("<attached_file"))
    return { text: stripCommentThreadReplyTag(raw.trim()), attachments: [] };

  const imgs = imageBlocks(content);
  let imgIdx = 0;
  const attachments: MessageAttachmentRef[] = [];
  for (const match of raw.matchAll(ATTACHED_FILE_TAG_RE)) {
    const attrs = match[1] ?? "";
    const mime = tagAttr(attrs, "type");
    let dataUrl: string | undefined;
    if (mime.startsWith("image/")) {
      const block = imgs[imgIdx++];
      if (block) dataUrl = `data:${block.mimeType};base64,${block.data}`;
    }
    attachments.push({ id: tagAttr(attrs, "id"), name: tagAttr(attrs, "name"), mime, dataUrl });
  }

  const text = stripCommentThreadReplyTag(
    raw.replace(ATTACHED_FILE_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim(),
  );
  return { text, attachments };
}
