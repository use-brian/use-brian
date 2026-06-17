/**
 * Pure rendering math behind the Brain graph canvas legibility rules:
 * the flat node-radius curve, the dependency-free collision force, the
 * zoom-tiered label opacity, dim-transition easing, and the warm-start
 * position merge across snapshot refreshes.
 */

import { describe, it, expect } from "vitest";
import {
  ALPHA_EASE_EPSILON,
  GRID_TARGET_PX,
  HALO_PADDING,
  HUB_DEGREE_FLOOR,
  HUB_SMALL_GRAPH,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MIN,
  PULSE_PERIOD_MS,
  clusterLabelAlpha,
  communityHalos,
  communityLabels,
  gridStep,
  hexLuma,
  hubDegreeThreshold,
  labelAlpha,
  makeAnchorForce,
  makeClusterForce,
  makeCollideForce,
  mergePositions,
  mixHex,
  nodePhase,
  nodeRadius,
  pulsePhase,
  shadeHex,
  smoothstep,
  stepToward,
  truncateLabel,
  withAlpha,
} from "../graph-canvas";

describe("[COMP:app-web/graph-canvas] graph canvas rendering math", () => {
  describe("nodeRadius", () => {
    it("clamps to the [2.5, 7] range", () => {
      expect(nodeRadius(0)).toBe(NODE_RADIUS_MIN);
      expect(nodeRadius(12)).toBe(NODE_RADIUS_MAX);
      expect(nodeRadius(500)).toBe(NODE_RADIUS_MAX); // saturates at the cap
      expect(nodeRadius(-3)).toBe(NODE_RADIUS_MIN); // defensive
    });

    it("is monotonic and front-loaded (log curve, not sqrt)", () => {
      expect(nodeRadius(1)).toBeGreaterThan(nodeRadius(0));
      expect(nodeRadius(12)).toBeGreaterThan(nodeRadius(11));
      // The 0→3 jump reads bigger than the 9→12 jump.
      expect(nodeRadius(3) - nodeRadius(0)).toBeGreaterThan(
        nodeRadius(12) - nodeRadius(9),
      );
    });
  });

  describe("makeCollideForce", () => {
    it("pushes an overlapping pair apart to at least radii + padding", () => {
      const a = { x: 0, y: 0, degree: 12 };
      const b = { x: 1, y: 0, degree: 12 };
      const force = makeCollideForce((n) => nodeRadius(n.degree ?? 0), {
        padding: 1.5,
      });
      force.initialize([a, b]);
      for (let i = 0; i < 60; i++) force(1);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      expect(dist).toBeGreaterThanOrEqual(nodeRadius(12) * 2 + 1.5 * 2 - 0.05);
    });

    it("separates coincident nodes deterministically via the jiggle hook", () => {
      const a = { x: 5, y: 5, degree: 0 };
      const b = { x: 5, y: 5, degree: 0 };
      let flip = 1;
      const force = makeCollideForce((n) => nodeRadius(n.degree ?? 0), {
        jiggle: () => (flip = -flip) * 0.5,
      });
      force.initialize([a, b]);
      for (let i = 0; i < 60; i++) force(1);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0);
    });

    it("leaves already-separated nodes untouched", () => {
      const a = { x: 0, y: 0, degree: 0 };
      const b = { x: 100, y: 0, degree: 0 };
      const force = makeCollideForce((n) => nodeRadius(n.degree ?? 0));
      force.initialize([a, b]);
      force(1);
      expect(a).toMatchObject({ x: 0, y: 0 });
      expect(b).toMatchObject({ x: 100, y: 0 });
    });
  });

  describe("makeClusterForce", () => {
    type N = { id: string; x: number; y: number; vx: number; vy: number };
    const mk = (id: string, x: number, y: number): N => ({ id, x, y, vx: 0, vy: 0 });

    it("pulls community members toward their live centroid", () => {
      const a = mk("a", -100, 0);
      const b = mk("b", 100, 0);
      const c = mk("c", 0, 100);
      const communities = new Map([
        ["a", 0],
        ["b", 0],
        ["c", 0],
      ]);
      const force = makeClusterForce((n) => communities.get((n as N).id), {
        minSize: 3,
      });
      force.initialize([a, b, c]);
      force(1);
      // Centroid is (0, 33.3) — a is pulled right, b left, c down.
      expect(a.vx).toBeGreaterThan(0);
      expect(b.vx).toBeLessThan(0);
      expect(c.vy).toBeLessThan(0);
    });

    it("does not pull across communities and skips tiny ones", () => {
      const a = mk("a", -100, 0);
      const b = mk("b", 100, 0);
      const communities = new Map([
        ["a", 0],
        ["b", 1],
      ]);
      const force = makeClusterForce((n) => communities.get((n as N).id), {
        minSize: 3,
      });
      force.initialize([a, b]);
      force(1);
      // Both are singletons below minSize — untouched.
      expect(a.vx).toBe(0);
      expect(b.vx).toBe(0);
    });
  });

  describe("makeAnchorForce", () => {
    it("pulls a drifted node's velocity back toward the origin", () => {
      const far = { x: 500, y: -300, vx: 0, vy: 0 };
      const force = makeAnchorForce(0.04);
      force.initialize([far]);
      force(1);
      expect(far.vx).toBeLessThan(0);
      expect(far.vy).toBeGreaterThan(0);
    });

    it("leaves a node at the origin untouched", () => {
      const home = { x: 0, y: 0, vx: 0, vy: 0 };
      const force = makeAnchorForce();
      force.initialize([home]);
      force(1);
      expect(home.vx).toBe(0);
      expect(home.vy).toBe(0);
    });
  });

  describe("hubDegreeThreshold", () => {
    it("returns 0 for small graphs so every node is labelled at fit zoom", () => {
      expect(hubDegreeThreshold(Array(HUB_SMALL_GRAPH).fill(5))).toBe(0);
      expect(hubDegreeThreshold([])).toBe(0);
    });

    it("returns the top-decile degree for large graphs", () => {
      // 100 nodes, degrees 1..100 → decile cut at the 10th-highest (91).
      const degrees = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(hubDegreeThreshold(degrees)).toBe(90);
    });

    it("never drops below the floor on flat large graphs", () => {
      expect(hubDegreeThreshold(Array(100).fill(1))).toBe(HUB_DEGREE_FLOOR);
    });
  });

  describe("labelAlpha", () => {
    it("always labels emphasized nodes", () => {
      expect(
        labelAlpha({ zoomRel: 0.1, degree: 0, hubThreshold: 5, emphasized: true }),
      ).toBe(1);
    });

    it("labels hubs at fit zoom but not leaves", () => {
      const hub = labelAlpha({
        zoomRel: 1,
        degree: 9,
        hubThreshold: 5,
        emphasized: false,
      });
      const leaf = labelAlpha({
        zoomRel: 1,
        degree: 1,
        hubThreshold: 5,
        emphasized: false,
      });
      expect(hub).toBe(1);
      expect(leaf).toBe(0);
    });

    it("fades everyone in past fit zoom, fully visible by ~2x", () => {
      const mid = labelAlpha({
        zoomRel: 1.8,
        degree: 1,
        hubThreshold: 5,
        emphasized: false,
      });
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
      expect(
        labelAlpha({ zoomRel: 2.2, degree: 1, hubThreshold: 5, emphasized: false }),
      ).toBe(1);
    });
  });

  describe("smoothstep", () => {
    it("clamps below/above the ramp and is smooth inside", () => {
      expect(smoothstep(1, 2, 0.5)).toBe(0);
      expect(smoothstep(1, 2, 3)).toBe(1);
      expect(smoothstep(1, 2, 1.5)).toBeCloseTo(0.5);
    });
  });

  describe("stepToward", () => {
    it("eases toward the target and snaps within epsilon", () => {
      const step1 = stepToward(0, 1, 0.25);
      expect(step1).toBeCloseTo(0.25);
      expect(stepToward(1 - ALPHA_EASE_EPSILON / 2, 1, 0.25)).toBe(1);
    });

    it("converges in a bounded number of frames", () => {
      let a = 0;
      let frames = 0;
      while (a !== 1 && frames < 40) {
        a = stepToward(a, 1);
        frames++;
      }
      expect(a).toBe(1);
      expect(frames).toBeLessThan(25);
    });
  });

  describe("truncateLabel", () => {
    it("passes short names through and hard-truncates long ones", () => {
      expect(truncateLabel("Ada")).toBe("Ada");
      const long = "Strategic Partnership Steering Committee Q3";
      const out = truncateLabel(long);
      expect(out.length).toBeLessThanOrEqual(28);
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("mergePositions", () => {
    const prev = new Map([
      ["a", { x: 10, y: 20 }],
      ["b", { x: 30, y: 40 }],
    ]);

    it("carries positions for surviving nodes and zeroes velocity", () => {
      const nodes = [{ id: "a", vx: 9, vy: 9 }];
      mergePositions(nodes, [], prev);
      expect(nodes[0]).toMatchObject({ x: 10, y: 20, vx: 0, vy: 0 });
    });

    it("seeds a new node at its positioned neighbours' centroid", () => {
      const nodes: Array<{ id: string; x?: number; y?: number }> = [
        { id: "a" },
        { id: "b" },
        { id: "new" },
      ];
      mergePositions(
        nodes,
        [
          { source: "new", target: "a" },
          { source: "b", target: "new" },
        ],
        prev,
      );
      const fresh = nodes[2];
      // Centroid (20, 30) plus the small ring offset.
      expect(Math.hypot((fresh.x ?? 0) - 20, (fresh.y ?? 0) - 30)).toBeLessThanOrEqual(12.01);
    });

    it("leaves an unconnected new node unplaced for engine default placement", () => {
      const nodes: Array<{ id: string; x?: number }> = [{ id: "orphan" }];
      mergePositions(nodes, [], prev);
      expect(nodes[0].x).toBeUndefined();
    });
  });

  describe("withAlpha", () => {
    it("appends a 2-digit hex alpha to #RRGGBB colors", () => {
      expect(withAlpha("#ff0000", 1)).toBe("#ff0000ff");
      expect(withAlpha("#ff0000", 0)).toBe("#ff000000");
      expect(withAlpha("#0E7490", 0.4)).toBe("#0E749066");
    });

    it("returns non-6-digit-hex colors untouched", () => {
      expect(withAlpha("oklch(0.7 0.1 200)", 0.5)).toBe("oklch(0.7 0.1 200)");
      expect(withAlpha("#fff", 0.5)).toBe("#fff");
    });
  });

  describe("mixHex", () => {
    it("blends channel-wise and clamps t", () => {
      expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
      expect(mixHex("#ff0000", "#0000ff", 0)).toBe("#ff0000");
      expect(mixHex("#ff0000", "#0000ff", 1)).toBe("#0000ff");
      expect(mixHex("#ff0000", "#0000ff", 2)).toBe("#0000ff"); // clamped
    });

    it("returns the first color untouched when either input is non-hex", () => {
      expect(mixHex("oklch(0.7 0.1 200)", "#ffffff", 0.5)).toBe(
        "oklch(0.7 0.1 200)",
      );
      expect(mixHex("#ff0000", "red", 0.5)).toBe("#ff0000");
    });
  });

  describe("shadeHex", () => {
    it("lightens toward white for positive t and darkens for negative", () => {
      const base = "#3B6FE0";
      expect(hexLuma(shadeHex(base, 0.4))).toBeGreaterThan(hexLuma(base));
      expect(hexLuma(shadeHex(base, -0.4))).toBeLessThan(hexLuma(base));
      expect(shadeHex(base, 0)).toBe(base.toLowerCase());
    });
  });

  describe("hexLuma", () => {
    it("spans 0 (black) to 1 (white) and defaults non-hex to 0.5", () => {
      expect(hexLuma("#000000")).toBe(0);
      expect(hexLuma("#ffffff")).toBeCloseTo(1);
      expect(hexLuma("#808080")).toBeCloseTo(0.216, 2);
      expect(hexLuma("var(--background)")).toBe(0.5);
    });
  });

  describe("communityHalos", () => {
    const communities = new Map([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["lone", 1],
    ]);
    const of = (id: string) => communities.get(id);

    it("computes the centroid and covers the farthest member plus padding", () => {
      const nodes = [
        { id: "a", x: -30, y: 0 },
        { id: "b", x: 30, y: 0 },
        { id: "c", x: 0, y: 30 },
      ];
      const [halo] = communityHalos(nodes, of, { minSize: 3 });
      expect(halo.community).toBe(0);
      expect(halo.x).toBeCloseTo(0);
      expect(halo.y).toBeCloseTo(10);
      // Farthest member is ~31.6 from the centroid; radius covers it.
      expect(halo.r).toBeCloseTo(
        Math.hypot(30, 10) + NODE_RADIUS_MAX + HALO_PADDING,
      );
    });

    it("skips communities under minSize and unpositioned nodes", () => {
      const nodes = [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 0 },
        { id: "c" }, // no position yet — ignored
        { id: "lone", x: 99, y: 99 }, // singleton community — no halo
      ];
      const halos = communityHalos(nodes, of, { minSize: 2 });
      expect(halos).toHaveLength(1);
      expect(halos[0].community).toBe(0);
    });

    it("returns nothing when no community reaches minSize", () => {
      expect(
        communityHalos([{ id: "lone", x: 0, y: 0 }], of, { minSize: 3 }),
      ).toHaveLength(0);
    });
  });

  describe("communityLabels", () => {
    const communities = new Map([
      ["hub", 0],
      ["a", 0],
      ["b", 0],
      ["tie1", 1],
      ["tie2", 1],
      ["tie3", 1],
      ["lone", 2],
    ]);
    const of = (id: string) => communities.get(id);

    it("labels each community with its most-connected member", () => {
      const nodes = [
        { id: "a", name: "alpha", degree: 2 },
        { id: "hub", name: "Memory system", degree: 9 },
        { id: "b", name: "beta", degree: 1 },
      ];
      expect(communityLabels(nodes, of, { minSize: 3 }).get(0)).toBe(
        "Memory system",
      );
    });

    it("breaks degree ties toward the smaller name (order-independent)", () => {
      const nodes = [
        { id: "tie1", name: "Zebra", degree: 4 },
        { id: "tie2", name: "Apple", degree: 4 },
        { id: "tie3", name: "Mango", degree: 4 },
      ];
      expect(communityLabels(nodes, of, { minSize: 3 }).get(1)).toBe("Apple");
      expect(
        communityLabels([...nodes].reverse(), of, { minSize: 3 }).get(1),
      ).toBe("Apple");
    });

    it("skips communities under minSize (no heading for a micro-cluster)", () => {
      const nodes = [
        { id: "hub", name: "Memory system", degree: 9 },
        { id: "a", name: "alpha", degree: 2 },
        { id: "b", name: "beta", degree: 1 },
        { id: "lone", name: "Orphan topic", degree: 0 },
      ];
      const labels = communityLabels(nodes, of, { minSize: 3 });
      expect(labels.get(0)).toBe("Memory system");
      expect(labels.has(2)).toBe(false);
    });
  });

  describe("clusterLabelAlpha", () => {
    it("is fully on at/below the framed overview, fading out as you zoom in", () => {
      expect(clusterLabelAlpha(0.6)).toBe(1);
      expect(clusterLabelAlpha(1.0)).toBe(1);
      const mid = clusterLabelAlpha(1.4);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
      expect(clusterLabelAlpha(1.8)).toBe(0);
      expect(clusterLabelAlpha(3)).toBe(0);
    });

    it("is gone before the per-node labels fill in (no competition)", () => {
      // Per-node leaves reach full opacity by zoomRel ~2.1 (ALL_LABEL_RAMP),
      // starting at 1.4; headings are already 0 by 1.8.
      expect(clusterLabelAlpha(1.8)).toBe(0);
      expect(
        labelAlpha({ zoomRel: 1.8, degree: 1, hubThreshold: 5, emphasized: false }),
      ).toBeGreaterThan(0);
    });
  });

  describe("gridStep", () => {
    it("returns powers of two whose on-screen pitch brackets the target", () => {
      for (const scale of [0.25, 0.5, 1, 1.7, 3, 8]) {
        const step = gridStep(scale);
        expect(Math.log2(step) % 1).toBe(0);
        const pitchPx = step * scale;
        expect(pitchPx).toBeGreaterThanOrEqual(GRID_TARGET_PX / Math.SQRT2 - 1e-9);
        expect(pitchPx).toBeLessThanOrEqual(GRID_TARGET_PX * Math.SQRT2 + 1e-9);
      }
    });

    it("re-tiles at discrete levels — doubling the zoom halves the step", () => {
      expect(gridStep(2)).toBe(gridStep(1) / 2);
    });
  });

  describe("nodePhase", () => {
    it("is deterministic, in [0, 2π), and spreads across ids", () => {
      const a = nodePhase("entity-aaaa");
      expect(nodePhase("entity-aaaa")).toBe(a);
      const phases = ["a", "b", "kb:1", "kb:2", "uuid-x"].map(nodePhase);
      for (const p of phases) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(2 * Math.PI);
      }
      expect(new Set(phases.map((p) => p.toFixed(6))).size).toBeGreaterThan(3);
    });
  });

  describe("pulsePhase", () => {
    it("ramps 0 → 1 across the period and wraps", () => {
      expect(pulsePhase(0)).toBe(0);
      expect(pulsePhase(PULSE_PERIOD_MS / 2)).toBeCloseTo(0.5);
      expect(pulsePhase(PULSE_PERIOD_MS)).toBe(0);
      expect(pulsePhase(PULSE_PERIOD_MS * 2.25)).toBeCloseTo(0.25);
    });

    it("stays in [0, 1) for any time, including negatives", () => {
      for (const t of [-5000, -1, 0, 1, 99999]) {
        const p = pulsePhase(t);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(1);
      }
    });
  });
});
