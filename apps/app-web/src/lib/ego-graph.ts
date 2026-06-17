// [COMP:app-web/ego-graph]
/**
 * Pure 1-hop ego-network builder for the entry reader's connections
 * graph (the "mini cortex"). Filters the workspace-wide brain graph
 * snapshot (`GET /api/brain/graph`) down to one focus node, its direct
 * neighbours, and the edges among them — no new endpoint, the reader
 * reuses the same snapshot the Brain page already fetches.
 *
 * Neighbour cap: a hub entry (e.g. an index page) can have dozens of
 * wikilinks; the rail card is ~280×190px, and past ~9 labelled nodes it
 * becomes an unreadable blob (the 16-cap shipped first and failed
 * exactly that way on a real KB index). Neighbours are kept by
 * descending degree (the most-connected context wins) and `truncated`
 * flags the cut for the caller's caption.
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Connections
 * graph (mini cortex)".
 */

import type { BrainGraph } from "@/lib/api/brain";

export const EGO_NEIGHBOR_CAP = 8;

export function buildEgoGraph(
  graph: BrainGraph,
  focusId: string,
  neighborCap: number = EGO_NEIGHBOR_CAP,
): BrainGraph & { focusPresent: boolean } {
  const focus = graph.nodes.find((n) => n.id === focusId);
  if (!focus) {
    return { nodes: [], edges: [], truncated: false, focusPresent: false };
  }

  // Direct neighbour ids from any edge touching the focus.
  const neighborIds = new Set<string>();
  for (const e of graph.edges) {
    if (e.source === focusId) neighborIds.add(e.target);
    else if (e.target === focusId) neighborIds.add(e.source);
  }
  neighborIds.delete(focusId);

  const neighbors = graph.nodes.filter((n) => neighborIds.has(n.id));
  neighbors.sort((a, b) => b.degree - a.degree);
  const truncated = neighbors.length > neighborCap;
  const kept = neighbors.slice(0, neighborCap);
  const keptIds = new Set<string>([focusId, ...kept.map((n) => n.id)]);

  // Edges among the kept set — focus spokes plus neighbour↔neighbour
  // links, so triangles render as triangles.
  const edges = graph.edges.filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target) && e.source !== e.target,
  );

  // Recompute degree within the subgraph so node sizing reflects what
  // is actually drawn, not the workspace-wide connectivity.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  return {
    nodes: [focus, ...kept].map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    edges,
    truncated,
    focusPresent: true,
  };
}
