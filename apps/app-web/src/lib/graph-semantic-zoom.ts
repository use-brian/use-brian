// [COMP:app-web/graph-semantic-zoom]
/** Pure decisions for the Brain graph's server-backed semantic zoom. */

export const SEMANTIC_ZOOM_EXPAND_AT = 1.65;
export const SEMANTIC_ZOOM_COLLAPSE_AT = 0.72;
const SEMANTIC_ZOOM_TARGET_RADIUS_PX = 130;

export type ScreenGroupTarget = {
  id: string;
  x: number;
  y: number;
};

export type SemanticZoomDecision =
  | { type: "expand"; groupId: string }
  | { type: "collapse" }
  | { type: "none" };

export function semanticZoomDecision(input: {
  relativeZoom: number;
  hasParentScope: boolean;
  targetPoint: { x: number; y: number };
  groups: ScreenGroupTarget[];
}): SemanticZoomDecision {
  if (
    input.hasParentScope &&
    input.relativeZoom <= SEMANTIC_ZOOM_COLLAPSE_AT
  ) {
    return { type: "collapse" };
  }
  if (input.relativeZoom < SEMANTIC_ZOOM_EXPAND_AT) {
    return { type: "none" };
  }

  let closest: ScreenGroupTarget | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const group of input.groups) {
    const distance = Math.hypot(
      group.x - input.targetPoint.x,
      group.y - input.targetPoint.y,
    );
    if (
      distance < closestDistance ||
      (distance === closestDistance && group.id < (closest?.id ?? ""))
    ) {
      closest = group;
      closestDistance = distance;
    }
  }
  if (!closest || closestDistance > SEMANTIC_ZOOM_TARGET_RADIUS_PX) {
    return { type: "none" };
  }
  return { type: "expand", groupId: closest.id };
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
