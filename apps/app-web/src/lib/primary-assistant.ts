/**
 * Pure pick of the assistant a workspace-level chat dock should default to:
 * the workspace primary, else the first listed assistant, else none.
 *
 * Used by `WorkspaceChrome` to resolve the `assistantId` it hands the one
 * hoisted `<FloatingChat origin="doc">` dock (the dock needs a concrete id
 * for session resume; the user can still switch interlocutors from the dock
 * header). IO-free so vitest exercises it without React.
 *
 * [COMP:app-web/primary-assistant]
 */

/** The minimal slice of `WorkspaceAssistantSummary` the pick reads. */
export type AssistantPickCandidate = {
  id: string;
  kind: string;
};

export function pickPrimaryAssistant<T extends AssistantPickCandidate>(
  list: readonly T[],
): T | null {
  return list.find((a) => a.kind === "primary") ?? list[0] ?? null;
}
