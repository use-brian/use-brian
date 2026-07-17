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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Sidebar list row — mirrors what /api/sessions returns. */
export type DocSession = {
  id: string;
  title: string;
  channelId: string;
  /** ISO string — server emits a Date which JSON-serialises here. */
  lastActive: string;
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
  /** Sender's display name (`users.name` ?? email), resolved server-side so
   *  the client can attribute *other* members' comments. `null` for assistant
   *  rows and the rare unknown sender (e.g. a deleted user). */
  senderName: string | null;
  /** Sender's avatar URL, resolved server-side so the client can render *other*
   *  members' photos in comment threads. `null` for assistant rows, members
   *  with no photo (→ initials fallback), and the rare unknown sender. See
   *  `docs/architecture/platform/user-profile.md`. */
  senderAvatarUrl?: string | null;
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
};

type RawMessageRow = {
  id: string;
  role: string;
  content: unknown;
  timestamp: string | Date;
  attachments?: SessionFileAttachment[];
  senderUserId?: string | null;
  senderName?: string | null;
  senderAvatarUrl?: string | null;
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
    };
  } catch {
    // Network / abort / parse — treat as no resume.
    return null;
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
      senderName: m.senderName ?? null,
      senderAvatarUrl: m.senderAvatarUrl ?? null,
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
