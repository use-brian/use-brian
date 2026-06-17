/**
 * Deterministic label-propagation community detection behind the Brain
 * graph's cluster physics + group color mode. Verifies community
 * separation on bridged cliques, singleton isolation, size-ranked
 * re-indexing, and run-to-run determinism.
 */

import { describe, it, expect } from "vitest";
import { detectCommunities } from "../graph-communities";

function nodes(...ids: string[]) {
  return ids.map((id) => ({ id }));
}

function edge(source: string, target: string) {
  return { source, target };
}

/** Fully connect a set of ids. */
function clique(...ids: string[]) {
  const edges = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      edges.push(edge(ids[i], ids[j]));
    }
  }
  return edges;
}

describe("[COMP:app-web/graph-communities] detectCommunities", () => {
  it("separates two cliques joined by a single bridge edge", () => {
    const ns = nodes("a1", "a2", "a3", "a4", "b1", "b2", "b3");
    const es = [
      ...clique("a1", "a2", "a3", "a4"),
      ...clique("b1", "b2", "b3"),
      edge("a1", "b1"), // the bridge
    ];
    const { byId, count } = detectCommunities(ns, es);
    expect(count).toBe(2);
    // Each clique is internally uniform…
    expect(byId.get("a2")).toBe(byId.get("a3"));
    expect(byId.get("a2")).toBe(byId.get("a4"));
    expect(byId.get("b1")).toBe(byId.get("b2"));
    expect(byId.get("b2")).toBe(byId.get("b3"));
    // …and the cliques differ.
    expect(byId.get("a2")).not.toBe(byId.get("b2"));
  });

  it("ranks community 0 as the largest", () => {
    const ns = nodes("a1", "a2", "z1", "z2", "z3", "z4", "z5");
    const es = [...clique("a1", "a2"), ...clique("z1", "z2", "z3", "z4", "z5")];
    const { byId, sizes } = detectCommunities(ns, es);
    // The 5-clique outranks the 2-clique regardless of id order.
    expect(byId.get("z1")).toBe(0);
    expect(byId.get("a1")).toBe(1);
    expect(sizes[0]).toBe(5);
    expect(sizes[1]).toBe(2);
  });

  it("keeps isolated nodes as singleton communities", () => {
    const ns = nodes("a1", "a2", "a3", "lone");
    const es = clique("a1", "a2", "a3");
    const { byId, count, sizes } = detectCommunities(ns, es);
    expect(count).toBe(2);
    expect(byId.get("lone")).toBe(1);
    expect(sizes[1]).toBe(1);
  });

  it("skips edges whose endpoints are not in the node set", () => {
    const ns = nodes("a", "b");
    const es = [edge("a", "b"), edge("a", "ghost"), edge("ghost", "b")];
    const { count } = detectCommunities(ns, es);
    expect(count).toBe(1);
  });

  it("is deterministic across runs and input edge order", () => {
    const ns = nodes("a1", "a2", "a3", "b1", "b2", "b3", "c1");
    const es = [
      ...clique("a1", "a2", "a3"),
      ...clique("b1", "b2", "b3"),
      edge("a3", "b1"),
      edge("c1", "a1"),
    ];
    const first = detectCommunities(ns, es);
    const second = detectCommunities(ns, [...es].reverse());
    expect([...first.byId.entries()].sort()).toEqual(
      [...second.byId.entries()].sort(),
    );
  });

  it("handles an empty graph", () => {
    const { byId, count, sizes } = detectCommunities([], []);
    expect(byId.size).toBe(0);
    expect(count).toBe(0);
    expect(sizes).toEqual([]);
  });

  it("recovers planted communities via aggregation (multi-level)", () => {
    // 4 planted communities of 24 nodes, each with a local tree
    // (branching 4) + ring + deterministic chords (~3 edges/node), and
    // single bridges between adjacent communities. Phase-1-only Louvain
    // fragments 24-node communities into sub-blobs; the aggregation
    // levels must merge them back.
    const SIZE = 24;
    const COMS = 4;
    const ns: Array<{ id: string }> = [];
    const es: Array<{ source: string; target: string }> = [];
    const id = (c: number, k: number) =>
      `c${c}-n${String(k).padStart(2, "0")}`;
    for (let c = 0; c < COMS; c++) {
      for (let k = 0; k < SIZE; k++) {
        ns.push({ id: id(c, k) });
        if (k > 0) es.push(edge(id(c, k), id(c, Math.floor(k / 4)))); // tree
        es.push(edge(id(c, k), id(c, (k + 1) % SIZE))); // ring
        if (k % 3 === 0) es.push(edge(id(c, k), id(c, (k * 7 + 3) % SIZE))); // chords
      }
      if (c > 0) es.push(edge(id(c - 1, 0), id(c, 0))); // bridge
    }
    const { byId, count } = detectCommunities(ns, es);
    // Every planted community must be internally uniform…
    for (let c = 0; c < COMS; c++) {
      const labels = new Set<number>();
      for (let k = 0; k < SIZE; k++) labels.add(byId.get(id(c, k))!);
      expect(labels.size).toBe(1);
    }
    // …and distinct from the others.
    expect(count).toBe(COMS);
  });
});
