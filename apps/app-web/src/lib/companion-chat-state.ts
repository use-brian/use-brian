export type CompanionChatPhase =
  | "idle"
  | "loading"
  | "thinking"
  | "responding"
  | "action-required";

/** Map the existing chat lifecycle onto the companion's small visual vocabulary. */
export function companionChatPhase(input: {
  isStreaming: boolean;
  hasStreamingText: boolean;
  requiresAction: boolean;
  isLoading: boolean;
}): CompanionChatPhase {
  if (input.requiresAction) return "action-required";
  if (input.isStreaming) return input.hasStreamingText ? "responding" : "thinking";
  if (input.isLoading) return "loading";
  return "idle";
}
