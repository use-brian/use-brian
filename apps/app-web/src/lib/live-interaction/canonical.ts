/** Select only canonical voice-job messages, in question/answer pair order.
 * Never replace the thread or touch the ordinary typed-turn stream buffer. */
export function canonicalInteractionAdditions<T extends { id: string }>(
  existing: readonly { id: string }[], rows: readonly T[], pairedIds: ReadonlySet<string>,
): T[] {
  const known = new Set(existing.map((message) => message.id));
  const canonical = new Map(rows.map((message) => [message.id, message]));
  const additions: T[] = [];
  for (const id of pairedIds) {
    const message = canonical.get(id);
    if (message && !known.has(id)) { known.add(id); additions.push(message); }
  }
  return additions;
}
