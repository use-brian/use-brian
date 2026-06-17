/**
 * Pure 1-hop ego-network builder behind the entry reader's connections
 * graph. Verifies focus resolution, neighbour collection from either
 * edge endpoint, the neighbour cap (kept by degree, flagged truncated),
 * neighbour↔neighbour edge retention, and in-subgraph degree recompute.
 */

import { describe, it, expect } from "vitest";
import { buildEgoGraph } from "../ego-graph";
import type { BrainGraph } from "@/lib/api/brain";

function node(id: string, degree = 0) {
  return { id, kind: "knowledge" as const, name: id, sensitivity: "internal" as const, degree };
}

function edge(source: string, target: string) {
  return { id: `${source}:${target}`, source, target, type: "related", sensitivity: "internal" as const };
}

describe("[COMP:app-web/ego-graph] buildEgoGraph", () => {
  const graph: BrainGraph = {
    nodes: [node("a", 3), node("b", 2), node("c", 1), node("d", 1), node("far", 1)],
    edges: [edge("a", "b"), edge("c", "a"), edge("b", "c"), edge("d", "far")],
    truncated: false,
  };

  it("returns the focus plus 1-hop neighbours and edges among them", () => {
    const ego = buildEgoGraph(graph, "a");
    expect(ego.focusPresent).toBe(true);
    expect(ego.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    // The b↔c neighbour edge survives so triangles render as triangles.
    expect(ego.edges.map((e) => e.id).sort()).toEqual(["a:b", "b:c", "c:a"]);
  });

  it("recomputes degree within the subgraph", () => {
    const ego = buildEgoGraph(graph, "a");
    const byId = new Map(ego.nodes.map((n) => [n.id, n.degree]));
    expect(byId.get("a")).toBe(2);
    expect(byId.get("b")).toBe(2);
    expect(byId.get("c")).toBe(2);
  });

  it("reports an absent focus instead of throwing", () => {
    const ego = buildEgoGraph(graph, "ghost");
    expect(ego.focusPresent).toBe(false);
    expect(ego.nodes).toEqual([]);
  });

  it("caps neighbours by descending degree and flags truncation", () => {
    const big: BrainGraph = {
      nodes: [node("hub"), ...Array.from({ length: 5 }, (_, i) => node(`n${i}`, i))],
      edges: Array.from({ length: 5 }, (_, i) => edge("hub", `n${i}`)),
      truncated: false,
    };
    const ego = buildEgoGraph(big, "hub", 2);
    expect(ego.truncated).toBe(true);
    // n4 + n3 have the highest workspace degree — they survive the cap.
    expect(ego.nodes.map((n) => n.id).sort()).toEqual(["hub", "n3", "n4"]);
  });

  it("handles a focus with no connections", () => {
    const ego = buildEgoGraph(graph, "far");
    expect(ego.focusPresent).toBe(true);
    expect(ego.nodes.map((n) => n.id).sort()).toEqual(["d", "far"]);
    expect(ego.edges).toHaveLength(1);
  });
});
