/**
 * Pure `@mention` matching, shared by the room composer (client) and the
 * server-side mention resolver.
 *
 * These are pure client-side seams originally written for assistant mentions
 * only (`apps/app-web/src/components/chat-app/multi-assistant-response.ts`)
 * and hoisted here so the server can re-validate a room message's mentions
 * against the SAME rules the composer used to paint them — longest-name-wins
 * at an overlapping position, the `isNameContinuation` boundary guard so
 * `@Jane` never matches inside `@Janet`, and multi-word names (mention text
 * can contain spaces, so a query cannot stop at one).
 *
 * This module must never be treated as an authorization boundary: it decides
 * WHICH names in a string look mentioned, not who is allowed to see the
 * result. The server independently re-resolves the persisted text against a
 * clearance-filtered roster.
 *
 * Spec: docs/architecture/features/chat-app.md → "Choosing an assistant";
 * docs/plans/room-human-mentions.md → T-H5.
 * [COMP:shared/mention-matching]
 */

/** Bounds one explicit room send to the small-team product ceiling. */
export const MAX_ROOM_RESPONDERS = 8;

/**
 * The minimum a mention target must expose. Deliberately NOT discriminated:
 * every matching function is generic over `<T extends MentionTarget>` and
 * returns `T`, so a caller passing a merged roster gets its own richer type
 * (and its own discriminator field) back unchanged. Adding a `kind` here
 * would collide with `WorkspaceAssistantSummary.kind`
 * ('primary' | 'standard' | 'app'), which is a real, unrelated field.
 */
export type MentionTarget = { id: string; name: string };

/**
 * @deprecated Use {@link MentionTarget}. Kept as an alias so call sites that
 * still name `AssistantLike` keep compiling.
 */
export type AssistantLike = MentionTarget;

type MentionMatch<T> = {
  assistant: T;
  index: number;
  end: number;
};

function isNameContinuation(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

/** One resolved `@Name` occurrence, as a range over the text. */
export type MentionSpan<T> = {
  assistant: T;
  /** Index of the `@`. */
  start: number;
  /** Index one past the last character of the name. */
  end: number;
};

/**
 * Locate every `@Name` occurrence in textual order.
 *
 * At an overlapping position the longest name wins (`@Sales EU` over
 * `@Sales`), and an accepted span occupies its range so no shorter name can
 * be read out of the middle of it.
 *
 * This is the ONE matching rule behind both what the composer paints as a
 * mention chip and who the send actually addresses — a token that looks
 * resolved must be the token that answers.
 */
export function resolveMentionSpans<T extends MentionTarget>(
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
 * Resolve every distinct mentioned target in textual order.
 *
 * Repeating the same target still produces one reply/notification. The cap
 * bounds one explicit send to the small-team product ceiling.
 */
export function resolveMentionedAssistants<T extends MentionTarget>(
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

/** The trailing `@…` the composer is currently completing. */
export type MentionQuery = {
  /** Index of the `@`. */
  at: number;
  /** What the user has typed after it (may contain spaces — names do). */
  partial: string;
};

/** Names can contain spaces, so the query cannot stop at one. */
export const TRAILING_MENTION = /(^|\s)@([^@]*)$/;

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
export function mentionCandidatesFor<T extends MentionTarget>(
  query: MentionQuery | null,
  roster: T[],
): T[] {
  if (!query) return [];
  const partial = query.partial.toLocaleLowerCase();
  return roster.filter((assistant) =>
    assistant.name.toLocaleLowerCase().startsWith(partial),
  );
}
