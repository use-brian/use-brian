/**
 * Pure client-side seams for multi-assistant room replies.
 *
 * Mention parsing decides WHICH assistants the Chat surface asks. The server
 * independently validates the response group and every assistant's room
 * clearance; this module must never be treated as an authorization boundary.
 *
 * Spec: docs/architecture/features/chat-app.md → "Choosing an assistant".
 * [COMP:app-web/multi-assistant-response]
 */

const MAX_ROOM_RESPONDERS = 8;

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

type AssistantLike = {
  id: string;
  name: string;
};

type MentionMatch<T> = {
  assistant: T;
  index: number;
  end: number;
};

function isNameContinuation(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

/** One resolved `@Assistant Name` occurrence, as a range over the text. */
export type MentionSpan<T> = {
  assistant: T;
  /** Index of the `@`. */
  start: number;
  /** Index one past the last character of the name. */
  end: number;
};

/**
 * Locate every `@Assistant Name` occurrence in textual order.
 *
 * At an overlapping position the longest name wins (`@Sales EU` over
 * `@Sales`), and an accepted span occupies its range so no shorter name can
 * be read out of the middle of it.
 *
 * This is the ONE matching rule behind both what the composer paints as a
 * mention chip and who the send actually addresses — a token that looks
 * resolved must be the token that answers.
 */
export function resolveMentionSpans<T extends AssistantLike>(
  text: string,
  roster: T[],
): MentionSpan<T>[] {
  const lower = text.toLocaleLowerCase();
  const candidates: MentionMatch<T>[] = [];

  for (const assistant of roster) {
    const name = assistant.name.trim().toLocaleLowerCase();
    if (!name) continue;
    const needle = `@${name}`;
    let from = 0;
    for (;;) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const end = index + needle.length;
      if (!isNameContinuation(lower[end])) {
        candidates.push({ assistant, index, end });
      }
      from = index + 1;
    }
  }

  candidates.sort((a, b) => a.index - b.index || b.end - a.end);
  const spans: MentionSpan<T>[] = [];
  let occupiedUntil = -1;
  for (const match of candidates) {
    if (match.index < occupiedUntil) continue;
    spans.push({ assistant: match.assistant, start: match.index, end: match.end });
    occupiedUntil = match.end;
  }
  return spans;
}

/**
 * Resolve every distinct mentioned assistant in textual order.
 *
 * Repeating the same assistant still produces one reply. The cap bounds one
 * explicit send to the small-team product ceiling.
 */
export function resolveMentionedAssistants<T extends AssistantLike>(
  text: string,
  roster: T[],
  max = MAX_ROOM_RESPONDERS,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const span of resolveMentionSpans(text, roster)) {
    if (seen.has(span.assistant.id)) continue;
    result.push(span.assistant);
    seen.add(span.assistant.id);
    if (result.length >= max) break;
  }
  return result;
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

/** The trailing `@…` the composer is currently completing. */
export type MentionQuery = {
  /** Index of the `@`. */
  at: number;
  /** What the user has typed after it (may contain spaces — names do). */
  partial: string;
};

/** Assistant names contain spaces, so the query cannot stop at one. */
const TRAILING_MENTION = /(^|\s)@([^@]*)$/;

/** The `@…` run at the end of the text, or null when there is none. */
export function trailingMentionQuery(text: string): MentionQuery | null {
  const match = text.match(TRAILING_MENTION);
  if (!match) return null;
  return { at: (match.index ?? 0) + match[1].length, partial: match[2] };
}

/**
 * Decide whether the `@` autocomplete should be open, and carry the dismissal
 * anchor forward.
 *
 * Two suppressions, both anchored to a SPECIFIC `@` so that a new mention
 * later in the same message always reopens the popup:
 *
 * - **Already completed.** A confirmed mention keeps the trailing-`@` shape
 *   (`@Blendit `) because names may contain spaces, so the regex alone cannot
 *   tell a resolved token from a partial one — which is why picking `@Blendit`
 *   used to leave `@Blendit Media` hanging as a live suggestion. Anything the
 *   user types after the completion is prose. Deleting back INTO the name
 *   breaks the prefix and the popup returns, which is how `@Blendit` is
 *   extended to `@Blendit Media`.
 * - **Dismissed.** Escape or a click outside closes the popup for that `@`;
 *   it stays closed while the user keeps typing that token. The anchor is
 *   dropped as soon as the trailing `@` is gone, so the next `@` opens fresh.
 */
export function resolveMentionQuery(params: {
  text: string;
  /** The composer value produced by the last accepted completion. */
  completedInput: string | null;
  /** Text before the `@` the user dismissed. */
  dismissedPrefix: string | null;
}): { query: MentionQuery | null; dismissedPrefix: string | null } {
  const query = trailingMentionQuery(params.text);
  if (!query) return { query: null, dismissedPrefix: null };
  if (
    params.completedInput !== null &&
    params.text.startsWith(params.completedInput) &&
    query.at < params.completedInput.length
  ) {
    return { query: null, dismissedPrefix: params.dismissedPrefix };
  }
  if (
    params.dismissedPrefix !== null &&
    params.text.slice(0, query.at) === params.dismissedPrefix
  ) {
    return { query: null, dismissedPrefix: params.dismissedPrefix };
  }
  return { query, dismissedPrefix: params.dismissedPrefix };
}

/** Roster entries whose name starts with what has been typed after the `@`. */
export function mentionCandidatesFor<T extends AssistantLike>(
  query: MentionQuery | null,
  roster: T[],
): T[] {
  if (!query) return [];
  const partial = query.partial.toLocaleLowerCase();
  return roster.filter((assistant) =>
    assistant.name.toLocaleLowerCase().startsWith(partial),
  );
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
