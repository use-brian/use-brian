import { describe, expect, it } from "vitest";
import {
  SEMANTIC_ZOOM_COLLAPSE_AT,
  SEMANTIC_ZOOM_EXPAND_AT,
  graphScopeCacheKey,
  semanticZoomDecision,
} from "@/lib/graph-semantic-zoom";

describe("[COMP:app-web/graph-semantic-zoom] semantic zoom decisions", () => {
  const groups = [
    { id: "group-a", x: 100, y: 100 },
    { id: "group-b", x: 400, y: 300 },
  ];

  it("expands the group nearest the zoom focal point above the threshold", () => {
    expect(
      semanticZoomDecision({
        relativeZoom: SEMANTIC_ZOOM_EXPAND_AT,
        hasParentScope: false,
        targetPoint: { x: 110, y: 105 },
        groups,
      }),
    ).toEqual({ type: "expand", groupId: "group-a" });
  });

  it("does not expand when the zoom ends away from a group", () => {
    expect(
      semanticZoomDecision({
        relativeZoom: 2,
        hasParentScope: false,
        targetPoint: { x: 700, y: 700 },
        groups,
      }),
    ).toEqual({ type: "none" });
  });

  it("uses a separate lower threshold to collapse the current scope", () => {
    expect(
      semanticZoomDecision({
        relativeZoom: SEMANTIC_ZOOM_COLLAPSE_AT,
        hasParentScope: true,
        targetPoint: { x: 0, y: 0 },
        groups,
      }),
    ).toEqual({ type: "collapse" });
  });

  it("does not collapse the workspace overview", () => {
    expect(
      semanticZoomDecision({
        relativeZoom: 0.1,
        hasParentScope: false,
        targetPoint: { x: 0, y: 0 },
        groups,
      }),
    ).toEqual({ type: "none" });
  });

  it("keys scope cache entries by viewer projection and normalized focus", () => {
    const base = graphScopeCacheKey({
      workspaceId: "ws",
      viewpointAssistantId: "assistant",
      showMemory: true,
      scopeId: "group-a",
      focusQuery: "  Acme  ",
    });
    expect(base).toBe(
      graphScopeCacheKey({
        workspaceId: "ws",
        viewpointAssistantId: "assistant",
        showMemory: true,
        scopeId: "group-a",
        focusQuery: "acme",
      }),
    );
    expect(base).not.toBe(
      graphScopeCacheKey({
        workspaceId: "ws",
        viewpointAssistantId: "other",
        showMemory: true,
        scopeId: "group-a",
        focusQuery: "acme",
      }),
    );
  });
});
