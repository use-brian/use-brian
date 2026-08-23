/**
 * Pure client-side seams for multi-assistant room replies.
 *
 * Mention parsing decides WHICH assistants the Chat surface asks. The server
 * independently validates the response group and every assistant's room
 * clearance; this module must never be treated as an authorization boundary.
 *
 * The actual mention matching (spans, trailing-query parsing, candidate
 * filtering) has moved to `@use-brian/shared/mention-matching` so the server
 * can re-validate a room message against the SAME rules the composer used to
 * paint it — see docs/plans/room-human-mentions.md → T-H5. This module
 * re-exports those symbols for existing import paths, and keeps the
 * genuinely app-specific (React/DOM-aware) helpers.
 *
 * Spec: docs/architecture/features/chat-app.md → "Choosing an assistant".
 * [COMP:app-web/multi-assistant-response]
 */

export {
  MAX_ROOM_RESPONDERS,
  mentionCandidatesFor,
  resolveMentionQuery,
  resolveMentionSpans,
  resolveMentionedAssistants,
  trailingMentionQuery,
  type AssistantLike,
  type MentionQuery,
  type MentionSpan,
  type MentionTarget,
} from "@use-brian/shared/mention-matching";

import {
  MAX_ROOM_RESPONDERS,
  resolveMentionSpans,
  type AssistantLike,
  type MentionTarget,
} from "@use-brian/shared/mention-matching";

/**
 * The room composer's own discriminator (docs/plans/room-human-mentions.md
 * T-H5). `MentionTarget` deliberately carries no `kind` field — adding one
 * there would collide with the real, unrelated `WorkspaceAssistantSummary.kind`
 * ('primary' | 'standard' | 'app') and break structural assignability at
 * every existing assistant-only call site. This is the caller-owned type the
 * plan says to define locally: a merged roster entry knows whether picking
 * it wakes a paid model turn or just pings a teammate.
 */
export type RoomMentionKind = "assistant" | "member";
export type RoomMentionTarget = MentionTarget & { mentionKind: RoomMentionKind };

export type PartitionedRoomMentions<T extends RoomMentionTarget> = {
  /** Distinct assistants mentioned, in textual order, deduped and capped —
   *  feeds the existing multi-assistant send routing (T9) unchanged. */
  assistants: T[];
  /** Distinct members mentioned, in textual order, deduped and capped — a UI
   *  hint only; the server independently re-resolves the persisted text and
   *  is authoritative (T-H2). */
  members: T[];
};

/**
 * Resolve every `@mention` across a MERGED assistant+member roster and
 * partition the result by kind, in ONE pass over `resolveMentionSpans`
 * (T-H5/D-H2).
 *
 * This must run over the merged roster in a single pass rather than calling
 * `resolveMentionedAssistants` against an assistants-only roster and a
 * members-only roster separately: `resolveMentionSpans`'s longest-name-wins
 * rule can only pick ONE winner at a given position, and running it twice
 * against two disjoint sub-rosters would let both partitions claim the same
 * span (assistant "Jane" and member "Jane Doe" both "matching" `@Jane Doe`).
 * Only a single pass over the full roster reproduces the server's
 * `resolveRoomMentions` decision, which is what keeps the client's `addressed`
 * boolean and the eventual server turn-or-post decision from disagreeing.
 *
 * Assistants must be ordered first in the roster the caller passes in: an
 * exact name TIE then resolves to the assistant (D-H3), the same ordering
 * trick `resolveRoomMentions` uses server-side.
 */
export function partitionRoomMentions<T extends RoomMentionTarget>(
  text: string,
  roster: T[],
  max = MAX_ROOM_RESPONDERS,
): PartitionedRoomMentions<T> {
  const assistants: T[] = [];
  const members: T[] = [];
  const seenAssistants = new Set<string>();
  const seenMembers = new Set<string>();
  for (const span of resolveMentionSpans(text, roster)) {
    const target = span.assistant;
    if (target.mentionKind === "assistant") {
      if (seenAssistants.has(target.id) || assistants.length >= max) continue;
      seenAssistants.add(target.id);
      assistants.push(target);
    } else {
      if (seenMembers.has(target.id) || members.length >= max) continue;
      seenMembers.add(target.id);
      members.push(target);
    }
  }
  return { assistants, members };
}

/**
 * Is the composer's assistant chip a live PICKER, or a static label?
 *
 * Three rules, and the middle one is the whole point:
 *   - a fresh pane picks the assistant its new session/room will bind;
 *   - an open ROOM keeps picking — the binding is the room's default voice,
 *     movable by anyone who can post (`PATCH /api/sessions/:id/assistant`);
 *   - an open PERSONAL thread does NOT — one person, one assistant, and
 *     switching mid-thread would hand another assistant's soul and memory a
 *     transcript written for someone else.
 *
 * A single-assistant workspace has nothing to pick between, so the chip
 * degrades to the label in every case.
 *
 * Spec: docs/architecture/features/chat-app.md → "Choosing an assistant".
 */
export function isAssistantPickerLive(params: {
  /** An open thread, vs. the fresh new-chat pane. */
  hasOpenSession: boolean;
  /** The pane is a room — an open shared thread, or the Workspace hero. */
  paneIsRoom: boolean;
  rosterSize: number;
}): boolean {
  if (params.rosterSize < 2) return false;
  return !params.hasOpenSession || params.paneIsRoom;
}

/** Move the active autocomplete option, wrapping at either end. */
export function nextMentionSelectionIndex(
  current: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count <= 0) return 0;
  const safeCurrent = current >= 0 && current < count ? current : 0;
  return (safeCurrent + direction + count) % count;
}

/**
 * Map a composer keydown to an autocomplete selection move. Arrow keys are
 * the messaging-app convention and the only way to move the selection;
 * anything else returns null (not a navigation key). Tab is deliberately
 * absent — it accepts, see `acceptsMentionSelection`.
 */
export function mentionNavigationDelta(key: string): 1 | -1 | null {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  return null;
}

/**
 * Does this keydown confirm the highlighted option? Enter is the messaging
 * convention; Tab is the editor-autocomplete one, and every popup a user
 * meets elsewhere (their editor, their shell) completes on it rather than
 * advancing — advancing is what the arrows are for.
 *
 * Shift+Tab confirms too. It has no separate meaning while the popup is open,
 * and letting it fall through would walk focus out of the composer and strand
 * an open popup behind it.
 */
export function acceptsMentionSelection(
  key: string,
  shiftKey: boolean,
): boolean {
  if (key === "Tab") return true;
  return key === "Enter" && !shiftKey;
}

/** Replace the trailing partial `@` query with a confirmed assistant name. */
export function completeTrailingAssistantMention(
  text: string,
  name: string,
): string {
  return text.replace(/@[^@]*$/, () => `@${name} `);
}

/** Select the assistant whose activity the Work Bench is rendering. */
export function resolveWorkBenchAssistant<T extends AssistantLike>(params: {
  roster: T[];
  fallback: T | null;
  localActive: boolean;
  localAssistantId: string | null;
  remoteActive: boolean;
  remoteAssistantId: string | null;
  waitingForInput: boolean;
}): T | null {
  const responderId = params.localActive || params.waitingForInput
    ? params.localAssistantId
    : params.remoteActive
      ? params.remoteAssistantId
      : null;
  return (
    (responderId
      ? params.roster.find((assistant) => assistant.id === responderId)
      : undefined) ?? params.fallback
  );
}
