import type { Message } from "@use-brian/chat-ui";
import type { MessageAttachmentRef } from "@/lib/api/sessions";

/** Kept structural so the grouping seam remains compatible while the
 * document-viewer attachment graduates into the shared chat-ui package. */
type TranscriptDocumentAttachment = {
  id: string;
  title: string;
  content: string;
  format: "text" | "markdown";
  sourceName?: string;
};

/**
 * The Chat app's renderable transcript row. Shared-room attribution and
 * restored human attachments are host concerns, so they stay outside the
 * host-agnostic chat-ui package.
 */
export type ChatSurfaceMessage = Message & {
  senderName?: string;
  /** Who posted a human row in a room. Null/absent on personal chats and on
   *  optimistic rows — both cases are the viewer's own message. */
  senderUserId?: string | null;
  senderAssistantId?: string | null;
  userAttachments?: MessageAttachmentRef[];
  documents?: TranscriptDocumentAttachment[];
};

/** Per-row presentation metadata for the group-chat transcript timeline. */
export type TranscriptRowMeta = {
  /** Set when this row opens a new local calendar day — the surface renders
   *  a centered day separator above it. */
  daySeparator: Date | null;
  /** Set when this row opens a new sender group — the surface renders the
   *  name · time header. Continuations render tightened, header-less. */
  startsGroup: boolean;
};

/** Messages closer together than this from the same sender read as one
 *  burst — the messaging-app grouping window. */
const GROUP_WINDOW_MS = 5 * 60_000;

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** One sender for grouping purposes: the human (attributed rows group by
 *  name; unattributed rows are the viewer's own) or the answering assistant. */
function transcriptSenderKey(message: {
  role: string;
  senderName?: string;
  senderAssistantId?: string | null;
}): string {
  return message.role === "user"
    ? `user:${message.senderName ?? ""}`
    : `assistant:${message.senderAssistantId ?? ""}`;
}

/**
 * Compute the day-separator and sender-group boundaries for a transcript.
 * A new local calendar day always starts a group; within a day, a change of
 * sender or a gap above the grouping window does.
 */
export function computeTranscriptRowMeta(
  messages: Array<{
    role: string;
    timestamp: Date;
    senderName?: string;
    senderAssistantId?: string | null;
  }>,
): TranscriptRowMeta[] {
  return messages.map((message, index) => {
    const previous = index > 0 ? messages[index - 1] : null;
    // An unparseable timestamp never breaks the timeline: it draws no
    // separator and groups purely by sender.
    const timeKnown = Number.isFinite(message.timestamp.getTime());
    const newDay =
      timeKnown &&
      (!previous ||
        !Number.isFinite(previous.timestamp.getTime()) ||
        !sameLocalDay(previous.timestamp, message.timestamp));
    const startsGroup =
      newDay ||
      !previous ||
      transcriptSenderKey(previous) !== transcriptSenderKey(message) ||
      message.timestamp.getTime() - previous.timestamp.getTime() > GROUP_WINDOW_MS;
    return {
      daySeparator: newDay ? message.timestamp : null,
      startsGroup,
    };
  });
}

/**
 * The day separator's label: relative for the two days the reader holds in
 * their head, an explicit date beyond that (year only when it differs).
 */
export function formatTranscriptDayLabel(
  day: Date,
  now: Date,
  locale: string,
  labels: { today: string; yesterday: string },
): string {
  if (sameLocalDay(day, now)) return labels.today;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDay(day, yesterday)) return labels.yesterday;
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(day.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(day);
}

/** The compact per-group time chip (locale-aware hour:minute). */
export function formatTranscriptTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function mergeUnique<T>(
  earlier: T[] | undefined,
  later: T[] | undefined,
  keyOf: (entry: T) => string,
): T[] | undefined {
  if (!earlier?.length) return later?.length ? [...later] : undefined;
  if (!later?.length) return [...earlier];

  const merged = [...earlier];
  const positions = new Map(merged.map((entry, index) => [keyOf(entry), index]));
  for (const entry of later) {
    const key = keyOf(entry);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, merged.length);
      merged.push(entry);
    } else {
      // A later persisted row is authoritative for a re-emitted attachment or
      // tool id, while retaining the original chronological position.
      merged[position] = entry;
    }
  }
  return merged;
}

function sameAssistantRun(
  earlier: ChatSurfaceMessage,
  later: ChatSurfaceMessage,
): boolean {
  return (
    earlier.role === "assistant" &&
    later.role === "assistant" &&
    (earlier.senderAssistantId ?? null) === (later.senderAssistantId ?? null)
  );
}

function mergeAssistantRows(
  earlier: ChatSurfaceMessage,
  later: ChatSurfaceMessage,
): ChatSurfaceMessage {
  const merged: ChatSurfaceMessage = {
    ...earlier,
    ...later,
    // Match the live answer-segmentation rule: a later non-empty segment
    // replaces intermediate narration. An empty final bookkeeping row keeps
    // the last answer, but still supplies the persisted id/time for actions.
    text: later.text.trim().length > 0 ? later.text : earlier.text,
  };

  merged.attachments = mergeUnique(
    earlier.attachments,
    later.attachments,
    (entry) => entry.id,
  );
  merged.userAttachments = mergeUnique(
    earlier.userAttachments,
    later.userAttachments,
    (entry) => entry.id,
  );
  merged.fileAttachments = mergeUnique(
    earlier.fileAttachments,
    later.fileAttachments,
    (entry) => entry.fileId,
  );
  merged.citations = mergeUnique(
    earlier.citations,
    later.citations,
    (entry) => entry.url,
  );
  merged.toolsUsed = mergeUnique(
    earlier.toolsUsed,
    later.toolsUsed,
    (entry) => entry.id,
  );
  merged.views = mergeUnique(
    earlier.views,
    later.views,
    (entry) => entry.toolUseId,
  );
  merged.documents = mergeUnique(
    earlier.documents,
    later.documents,
    (entry) => entry.id,
  );

  return merged;
}

/**
 * Fold storage-level assistant rows into presentation-level logical runs.
 *
 * The API persists one assistant row per query-loop tool round to preserve
 * tool_use/tool_result pairing. After non-renderable tool-result carriers are
 * filtered out, those rows are adjacent. A human row or a different answering
 * assistant is a hard boundary; otherwise the rows render as one message and
 * therefore one avatar.
 */
export function coalesceAssistantRunMessages(
  messages: ChatSurfaceMessage[],
): ChatSurfaceMessage[] {
  const rendered: ChatSurfaceMessage[] = [];
  for (const message of messages) {
    const previous = rendered.at(-1);
    if (previous && sameAssistantRun(previous, message)) {
      rendered[rendered.length - 1] = mergeAssistantRows(previous, message);
    } else {
      rendered.push(message);
    }
  }
  return rendered;
}
