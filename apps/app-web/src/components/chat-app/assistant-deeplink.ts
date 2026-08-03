/** Resolve a first-party app deep link without weakening session binding. */
export function resolveRequestedFreshAssistant(
  requestedId: string | null,
  assistants: { id: string }[],
): string | null {
  if (!requestedId) return null;
  return assistants.some((assistant) => assistant.id === requestedId)
    ? requestedId
    : null;
}
