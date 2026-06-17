// [COMP:app-web/graph-communities]
/**
 * Community detection for the Brain graph — deterministic multi-level
 * Louvain (modularity local-moving + aggregation), no dependencies.
 *
 * Powers the Obsidian-style cluster rendering in `graph-view.tsx`: the
 * detected communities feed (1) the cluster-gravity force + the
 * intra/inter link split (so communities form spatially separated
 * "firework" blobs instead of one mass) and (2) the optional group color
 * mode (color = community, the way Obsidian's path-groups color its
 * vault graph).
 *
 * WHY NOT LABEL PROPAGATION. LPA needs random tie-breaking to work; any
 * deterministic tie rule (e.g. smallest label) floods one label across
 * bridge edges — two cliques joined by a single edge merge into one
 * community. Modularity local-moving has no such failure: moving a
 * bridge node into the far community is a negative-gain move, so
 * bridges stay bridges.
 *
 * WHY MULTI-LEVEL. Phase 1 alone (local moving) is granular — on a
 * ~50-node true community it settles into several 5–15 node
 * sub-communities, and the dense edges BETWEEN those sub-communities
 * then drag the rendered blobs back into one mixed mass. The standard
 * Louvain aggregation phase — collapse each community into a
 * super-node (intra edges become self-loops), re-run local moving,
 * repeat until stable — recovers the coarse structure.
 *
 * Determinism: nodes are processed in sorted-id order, candidate
 * communities in ascending id order, ties broken toward the smallest
 * community id. Edge order can't matter (adjacency is aggregated
 * first).
 *
 * Community ids are re-indexed by DESCENDING size (ties by the smallest
 * member id) so id 0 is always the largest community — the group
 * palette assigns its most distinct hues to the biggest clusters.
 *
 * Spec: docs/architecture/brain/graph-view.md → "Frontend".
 */

export type CommunityResult = {
  /** node id → community index (0 = largest community). */
  byId: Map<string, number>;
  /** Total number of communities (isolated nodes are singletons). */
  count: number;
  /** Member count per community index. */
  sizes: number[];
};

const MAX_SWEEPS = 20;
const MAX_LEVELS = 6;
const EPSILON = 1e-12;

type Level = {
  /** Adjacency per node: neighbour → edge weight (self excluded). */
  adj: Array<Map<number, number>>;
  /** Self-loop weight per node (intra edges of an aggregated community). */
  selfLoop: number[];
};

/**
 * Louvain phase 1 on one level: every node starts in its own community;
 * repeatedly move each node to the neighbouring community with the
 * highest modularity gain until a sweep makes no moves. `m` is the total
 * edge weight of the ORIGINAL graph (invariant across levels).
 */
function localMove(level: Level, m: number): number[] {
  const n = level.adj.length;
  // Degree includes self-loops twice, per the modularity definition.
  const degree = level.adj.map((nbrs, i) => {
    let s = 2 * level.selfLoop[i];
    for (const w of nbrs.values()) s += w;
    return s;
  });
  const community = level.adj.map((_, i) => i);
  const sigmaTot = degree.slice();

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (level.adj[i].size === 0) continue;
      const cur = community[i];
      const weightTo = new Map<number, number>();
      for (const [nb, w] of level.adj[i]) {
        const c = community[nb];
        weightTo.set(c, (weightTo.get(c) ?? 0) + w);
      }
      // Detach i, then compare gains. The constant factors of the
      // modularity-gain formula cancel across candidates, leaving
      //   gain(C) = w(i→C) − Σtot(C)·k(i) / 2m
      sigmaTot[cur] -= degree[i];
      let best = cur;
      let bestGain =
        (weightTo.get(cur) ?? 0) - (sigmaTot[cur] * degree[i]) / (2 * m);
      const candidates = [...weightTo.keys()].sort((a, b) => a - b);
      for (const c of candidates) {
        if (c === cur) continue;
        const gain =
          (weightTo.get(c) ?? 0) - (sigmaTot[c] * degree[i]) / (2 * m);
        if (
          gain > bestGain + EPSILON ||
          (Math.abs(gain - bestGain) <= EPSILON && c < best)
        ) {
          best = c;
          bestGain = gain;
        }
      }
      sigmaTot[best] += degree[i];
      if (best !== cur) {
        community[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
}

/** Renumber community labels densely (0..k-1, by first appearance). */
function compact(labels: number[]): { labels: number[]; count: number } {
  const remap = new Map<number, number>();
  const out = labels.map((label) => {
    let dense = remap.get(label);
    if (dense == null) {
      dense = remap.size;
      remap.set(label, dense);
    }
    return dense;
  });
  return { labels: out, count: remap.size };
}

/** Collapse communities into super-nodes for the next Louvain level. */
function aggregate(level: Level, labels: number[], count: number): Level {
  const adj: Array<Map<number, number>> = Array.from(
    { length: count },
    () => new Map(),
  );
  const selfLoop = new Array<number>(count).fill(0);
  labels.forEach((c, i) => {
    selfLoop[c] += level.selfLoop[i];
    for (const [nb, w] of level.adj[i]) {
      const cnb = labels[nb];
      if (cnb === c) {
        // Each intra edge is seen from both endpoints; halve into the loop.
        selfLoop[c] += w / 2;
      } else {
        adj[c].set(cnb, (adj[c].get(cnb) ?? 0) + w);
      }
    }
  });
  return { adj, selfLoop };
}

export function detectCommunities(
  nodes: Array<{ id: string }>,
  edges: Array<{ source: string; target: string }>,
): CommunityResult {
  const ids = nodes.map((n) => n.id).sort();
  const indexOf = new Map<string, number>();
  ids.forEach((id, i) => indexOf.set(id, i));

  // Weighted adjacency over sorted indices (duplicate edges accumulate
  // weight). Edges referencing unknown endpoints (clearance-filtered
  // nodes) and self-loops are skipped rather than crashing.
  let level: Level = {
    adj: ids.map(() => new Map()),
    selfLoop: new Array<number>(ids.length).fill(0),
  };
  let m = 0; // total edge weight, invariant across levels
  for (const e of edges) {
    const a = indexOf.get(e.source);
    const b = indexOf.get(e.target);
    if (a == null || b == null || a === b) continue;
    level.adj[a].set(b, (level.adj[a].get(b) ?? 0) + 1);
    level.adj[b].set(a, (level.adj[b].get(a) ?? 0) + 1);
    m += 1;
  }

  // Multi-level: local-move, then aggregate and repeat until a level
  // stops merging. `assignment[i]` tracks each ORIGINAL node's community
  // in the current level's numbering.
  let assignment = ids.map((_, i) => i);
  if (m > 0) {
    for (let depth = 0; depth < MAX_LEVELS; depth++) {
      const { labels, count } = compact(localMove(level, m));
      assignment = assignment.map((c) => labels[c]);
      if (count === level.adj.length) break; // no merges — converged
      level = aggregate(level, labels, count);
    }
  }

  // Re-index by size desc (ties by smallest member index → stable).
  const members = new Map<number, number[]>();
  assignment.forEach((label, i) => {
    const list = members.get(label) ?? [];
    list.push(i);
    members.set(label, list);
  });
  const ranked = [...members.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[1][0] - b[1][0];
  });

  const byId = new Map<string, number>();
  const sizes: number[] = [];
  ranked.forEach(([, memberIdxs], communityIndex) => {
    sizes.push(memberIdxs.length);
    for (const i of memberIdxs) byId.set(ids[i], communityIndex);
  });

  return { byId, count: ranked.length, sizes };
}
