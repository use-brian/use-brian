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

/**
 * Resolve every distinct `@Assistant Name` in textual order.
 *
 * At an overlapping position the longest name wins (`@Sales EU` over
 * `@Sales`). Repeating the same assistant still produces one reply. The cap
 * bounds one explicit send to the small-team product ceiling.
 */
export function resolveMentionedAssistants<T extends AssistantLike>(
  text: string,
  roster: T[],
  max = MAX_ROOM_RESPONDERS,
): T[] {
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
  const result: T[] = [];
  const seen = new Set<string>();
  let occupiedUntil = -1;
  for (const match of candidates) {
    if (match.index < occupiedUntil || seen.has(match.assistant.id)) continue;
    result.push(match.assistant);
    seen.add(match.assistant.id);
    occupiedUntil = match.end;
    if (result.length >= max) break;
  }
  return result;
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
