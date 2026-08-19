/**
 * Pure client-side seams for editing a sent user message.
 *
 * Editing exists because the common repair in a room is a message that was
 * never addressed to anyone: the sentence is right, it just needs `@Name` in
 * front of it. Retyping it is the thing we are removing.
 *
 * The server independently authorizes every path this module chooses between
 * (`truncateMessagesFrom` is session-scoped; the in-place edit route is
 * sender-scoped) — this is UX resolution, never an authorization boundary.
 *
 * Spec: docs/architecture/features/chat-app.md → "Editing a sent message".
 * [COMP:app-web/message-edit]
 */

import { resolveMentionSpans } from "@use-brian/shared/mention-matching";

type EditableMessage = {
  id: string;
  role: string;
  text: string;
  /** Null on personal chats and on optimistic rows — both are the viewer's. */
  senderUserId?: string | null;
  userAttachments?: unknown[];
};

/** An optimistic row the server has not acknowledged yet. */
function isLocalOnly(id: string): boolean {
  return id.startsWith("local-");
}

/**
 * May this row be edited?
 *
 * - Own text rows only. An attachment-bearing row cannot be replayed (the
 *   cached file ids are not on the render model), same constraint as retry.
 * - It must exist server-side. Both edit paths address the row by id
 *   (`truncateFromMessageId`, or the in-place PATCH), so an optimistic row
 *   would edit nothing and repost instead. The wait is one round trip.
 * - Nothing may follow it from ANOTHER human. An edit that re-asks truncates
 *   the transcript from this row, and a room transcript is not the editor's
 *   alone to destroy. Assistant replies after it are fair game — regenerating
 *   them is the point.
 */
export function canEditUserMessage(params: {
  messages: EditableMessage[];
  index: number;
  viewerUserId: string | null;
  /** A live local or followed turn — the transcript is moving. */
  busy: boolean;
}): boolean {
  if (params.busy) return false;
  const message = params.messages[params.index];
  if (!message || message.role !== "user") return false;
  if (!message.text.trim()) return false;
  if (isLocalOnly(message.id)) return false;
  if (message.userAttachments?.length) return false;
  if (message.senderUserId && message.senderUserId !== params.viewerUserId) {
    return false;
  }
  return !params.messages
    .slice(params.index + 1)
    .some(
      (later) =>
        later.role === "user" &&
        !!later.senderUserId &&
        later.senderUserId !== params.viewerUserId,
    );
}

/**
 * What saving an edit should DO.
 *
 * - `turn` — destroy-and-regenerate through `/api/chat` with
 *   `truncateFromMessageId`: the stored row and everything after it go, the
 *   new text lands, an assistant answers. Every personal-chat edit, and any
 *   room edit that either addresses an assistant or is repairing a message
 *   that was already answered.
 * - `post` — edit the stored room row in place, run no turn. A silent room
 *   post that stays silent is a typo fix, not a question; re-sending it would
 *   duplicate the post, and answering it would put words in the room.
 */
export function resolveEditDispatch<
  T extends { id: string; name: string; mentionKind?: "assistant" | "member" },
>(params: {
  isRoom: boolean;
  newText: string;
  roster: T[];
  /** Did an assistant reply to this message? */
  answered: boolean;
}): "turn" | "post" {
  if (!params.isRoom) return "turn";
  // A roster entry with no `mentionKind` (every assistant-only caller, and
  // every existing test fixture) is treated as an assistant — unchanged
  // behavior. The room composer's merged roster (T-H5) tags members
  // explicitly, so only an ASSISTANT span routes this edit to a turn: adding
  // `@Jane Doe` on its own must stay a silent in-place edit (D-H2) even when
  // an assistant named "Jane" also exists and the merged matcher's
  // longest-name-wins picked the member.
  const addressesAssistant = resolveMentionSpans(params.newText, params.roster).some(
    (span) => (span.assistant.mentionKind ?? "assistant") === "assistant",
  );
  if (addressesAssistant) return "turn";
  return params.answered ? "turn" : "post";
}
