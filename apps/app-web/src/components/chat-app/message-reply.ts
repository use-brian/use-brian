/**
 * Pure client-side seams for quoting a message in a reply.
 *
 * Replying exists because a room transcript is not linear. A message that
 * lands six posts after the thing it answers reads as a non-sequitur, and in
 * a room with several people and several assistants that is the ordinary
 * case, not the edge one. The quote is what makes the referent explicit.
 *
 * It is the referent for the MODEL too, not only for the reader: the chat
 * route resolves `replyTo` through `_reply-context.ts` and renders it into
 * the turn as a `# Reply context` block, and in a room a reply to an
 * ASSISTANT message counts as addressing that assistant (`detectRoomAddress`)
 * exactly like an `@mention`. So quoting one row of a table and asking "why
 * did this jump?" asks about that row, and asks the assistant that wrote it.
 *
 * Two rules worth keeping:
 *
 * - **A quote is TEXT, not a link.** The server stores a snapshot
 *   (`session_messages.reply_to_text`) rather than a foreign key. That is
 *   deliberate on both ends: a selection quote has no row of its own to point
 *   at, and a snapshot still reads correctly after the original is edited or
 *   truncated away by someone else's re-ask. The cost is that a restored
 *   quote knows what was said but not who said it or where it is, which is
 *   why `ReplyTo.id` / `.role` / `.authorName` are compose-time only.
 * - **The selection wins when there is one.** Quoting a 2,000-word answer to
 *   ask about one number in it tells the model nothing. Selecting the number
 *   first is the whole affordance, so a live selection inside the message
 *   always beats the message body.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Replying to a message".
 * [COMP:app-web/message-reply]
 */

import type { ReplyTo } from "@use-brian/chat-ui";

/**
 * Wire cap for a quote. Generous, because a deliberate selection IS the
 * referent and clipping it changes the question — this only exists so a
 * select-all on a huge answer cannot bloat every turn that follows.
 */
export const REPLY_QUOTE_MAX_CHARS = 1000;

/** Display cap for the composer chip and the transcript's quoted block. */
const REPLY_QUOTE_DISPLAY_CHARS = 160;

type QuotableMessage = {
  id: string;
  role: string;
  text: string;
  /** The assistant that wrote this row, on assistant rows in a room. */
  senderAssistantId?: string | null;
};

/** An optimistic row the server has not acknowledged yet. */
function isLocalOnly(id: string): boolean {
  return id.startsWith("local-");
}

/**
 * Flatten a quote to one line and cap it, for display only.
 *
 * Markdown quotes arrive with newlines, table pipes and list bullets in them;
 * a chip above the composer is one line of context, not a rendering surface.
 */
export function condenseQuote(
  text: string,
  max: number = REPLY_QUOTE_DISPLAY_CHARS,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * May this row be quoted?
 *
 * Both roles, unlike editing — quoting a teammate or an assistant is the
 * common case, and it writes nothing to their message. The one hard
 * requirement is a server-acknowledged id: `replyTo.id` is what the route
 * looks up to decide whether the quoted row was an assistant's (and so
 * whether this reply addresses it), and an optimistic `local-` id resolves to
 * nothing. The wait is one round trip.
 */
export function canReplyToMessage(
  message?: QuotableMessage | null,
): boolean {
  if (!message) return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (!message.text.trim()) return false;
  return !isLocalOnly(message.id);
}

/**
 * The text the user has selected, if that selection lies entirely inside
 * `container`.
 *
 * Both ends are checked, not just one: a drag that starts inside a message
 * and ends in the next one is not a quote of either, and silently quoting the
 * half that happens to be the anchor would be worse than quoting nothing.
 *
 * Structurally typed rather than taking `HTMLElement` / `Selection` so the
 * rule is testable without a DOM (app-web's vitest is node-only by default).
 */
export function selectionTextWithin(
  container: { contains(node: Node | null): boolean } | null | undefined,
  selection:
    | {
        isCollapsed: boolean
        anchorNode: Node | null
        focusNode: Node | null
        toString(): string
      }
    | null
    | undefined,
): string | null {
  if (!container || !selection || selection.isCollapsed) return null;
  if (!container.contains(selection.anchorNode)) return null;
  if (!container.contains(selection.focusNode)) return null;
  const text = selection.toString().trim();
  return text ? text : null;
}

/**
 * Build the pending reply target for a Reply click.
 *
 * `selection` is whatever `selectionTextWithin` returned for this row: when
 * it is present it becomes the quote, otherwise the message body does.
 * Returns null for a row that cannot be quoted, so the caller can gate the
 * affordance and the action on the same predicate.
 */
export function buildReplyTarget(params: {
  message: QuotableMessage;
  /** Live selection inside this message, if any. */
  selection?: string | null;
  /** Display label for the quoted author, for the "Replying to X" line. */
  authorName?: string | null;
}): ReplyTo | null {
  const { message } = params;
  if (!canReplyToMessage(message)) return null;
  const selected = params.selection?.trim() ?? "";
  const text = (selected || message.text).trim().slice(0, REPLY_QUOTE_MAX_CHARS).trim();
  if (!text) return null;
  return {
    id: message.id,
    role: message.role as "user" | "assistant",
    text,
    ...(params.authorName ? { authorName: params.authorName } : {}),
    // Routing, not display: a reply to an assistant is answered by THAT
    // assistant. Only meaningful on assistant rows.
    ...(message.role === "assistant" && message.senderAssistantId
      ? { assistantId: message.senderAssistantId }
      : {}),
  };
}
