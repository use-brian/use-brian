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
  senderAssistantId?: string | null;
  userAttachments?: MessageAttachmentRef[];
  documents?: TranscriptDocumentAttachment[];
};

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
