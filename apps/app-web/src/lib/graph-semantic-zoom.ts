// [COMP:app-web/graph-semantic-zoom]
/** Pure lifecycle decisions for the Brain graph's server-backed drill-down. */

/**
 * The full graph skeleton is a cold-start affordance only. A group/search
 * projection request must preserve the already-painted canvas; replacing it
 * with the skeleton destroys spatial context and makes every zoom feel like a
 * route reload.
 */
export function shouldShowGraphLoader(input: {
  initialLoading: boolean;
  scopeLoading: boolean;
  hasDimensions: boolean;
  hasRenderer: boolean;
}): boolean {
  return input.initialLoading || !input.hasDimensions || !input.hasRenderer;
}

export function graphScopeCacheKey(input: {
  workspaceId: string;
  viewpointAssistantId?: string | null;
  showMemory?: boolean;
  scopeId?: string | null;
  focusQuery?: string | null;
}): string {
  return [
    input.workspaceId,
    input.viewpointAssistantId ?? "",
    input.showMemory ? "memory" : "",
    input.scopeId ?? "overview",
    input.focusQuery?.trim().toLocaleLowerCase() ?? "",
  ].join("\u0000");
}
