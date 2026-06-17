"use client";

// [COMP:app-web/connections-graph]
/**
 * Connections graph — the entry reader's "mini cortex" rail card.
 *
 * Renders ONE entry's ego network (the focus node + its 1-hop
 * neighbours + the edges among them, built by `lib/ego-graph.ts` from
 * the same workspace graph snapshot the Brain page fetches) on a small
 * `react-force-graph-2d` canvas. Visual grammar follows the full
 * `BrainGraphView`: nodes coloured by the `--entity-*` kind tokens
 * (`readThemeColors` is shared), the focus node ringed.
 *
 * Tuned for a ~280×190px card, where the full graph's defaults were
 * unreadable (overlapping discs, clipped layout):
 *   - the module is imported in an effect (not `next/dynamic`) so a REF
 *     reaches the instance — `zoomToFit` on engine stop keeps the whole
 *     layout inside the card instead of clipping at the edges;
 *   - stronger charge + longer link distance spread the ring of
 *     neighbours; node drag is off so the simulation settles once;
 *   - small fixed-ish node radii (degree-capped) and short truncated
 *     labels — an ego net is ≤9 nodes (`EGO_NEIGHBOR_CAP`), every node
 *     stays labelled;
 *   - node click NAVIGATES (knowledge/memory → that entry's reader,
 *     entity → its full page, skill → the editor), no drawer.
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Connections
 * graph (mini cortex)".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { BrainGraph, BrainGraphNode } from "@/lib/api/brain";
import { buildEgoGraph } from "@/lib/ego-graph";
import {
  FALLBACK_COLORS,
  readThemeColors,
  type ThemeColors,
} from "@/components/brain/graph-view";
import { useT } from "@/lib/i18n/client";

type PositionedNode = BrainGraphNode & { x?: number; y?: number };

/** The slice of the force-graph instance the card drives via ref. */
type ForceGraphInstance = {
  d3Force(name: string):
    | { strength?: (n: number) => unknown; distance?: (n: number) => unknown }
    | undefined;
  zoomToFit(durationMs?: number, paddingPx?: number): void;
};

type Props = {
  /** Workspace-wide graph snapshot (the reader fetches it once). */
  graph: BrainGraph | null;
  /** The entry the reader is showing — the ego network's focus. */
  focusId: string;
  /** Node click → navigate. The reader owns the routing. */
  onNodeClick: (node: BrainGraphNode) => void;
};

const LABEL_MAX_CHARS = 16;

function nodeRadius(degree: number): number {
  return Math.sqrt(1 + Math.min(degree, 6)) * 3;
}

export function ConnectionsGraph({ graph, focusId, onNodeClick }: Props) {
  const t = useT();
  const copy = t.brainPage.entryReader;
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphInstance | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [colors, setColors] = useState<ThemeColors>(FALLBACK_COLORS);
  // Imported in an effect instead of `next/dynamic` — dynamic() does not
  // forward refs, and the card needs the instance for zoomToFit + force
  // tuning. The import only runs client-side, so SSR stays safe.
  const [ForceGraph2D, setForceGraph2D] = useState<ComponentType<
    Record<string, unknown>
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("react-force-graph-2d").then((mod) => {
      if (!cancelled) {
        setForceGraph2D(() => mod.default as ComponentType<Record<string, unknown>>);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setColors(readThemeColors());
    const obs = new MutationObserver(() => setColors(readThemeColors()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-palette"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setDims({ w: Math.max(120, r.width), h: Math.max(120, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ego = useMemo(
    () => (graph ? buildEgoGraph(graph, focusId) : null),
    [graph, focusId],
  );

  const graphData = useMemo(() => {
    if (!ego) return { nodes: [], links: [] };
    return {
      nodes: ego.nodes.map((n) => ({ ...n }) as PositionedNode),
      links: ego.edges.map((e) => ({ ...e })),
    };
  }, [ego]);

  /** Ref callback — fires on (re)mount, when the d3 forces exist. A small
   *  card needs more repulsion + link length than the lib defaults or the
   *  ring of neighbours collapses into one blob of overlapping discs. */
  const bindFg = (instance: ForceGraphInstance | null) => {
    fgRef.current = instance;
    if (!instance) return;
    instance.d3Force("charge")?.strength?.(-90);
    instance.d3Force("link")?.distance?.(55);
  };

  const empty = ego !== null && (!ego.focusPresent || ego.nodes.length <= 1);

  return (
    <div className="flex flex-col gap-1.5">
      {/* bg matches the graph's own ground (--graph-bg, not the page
          surface) so the canvas never flashes a mismatched frame while
          the snapshot loads. */}
      <div
        ref={containerRef}
        className="relative h-48 overflow-hidden rounded-md border border-border bg-[var(--graph-bg)]"
      >
        {ego === null ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {copy.loading}
          </div>
        ) : empty ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-xs text-muted-foreground">{copy.connectionsEmpty}</p>
            <p className="text-[11px] text-muted-foreground/70">
              {copy.connectionsHint}
            </p>
          </div>
        ) : dims && ForceGraph2D ? (
          <ForceGraph2D
            // Remount per snapshot so the layout re-runs and the ref
            // callback re-applies the force tuning.
            key={`${ego.nodes.length}:${ego.edges.length}`}
            ref={bindFg as never}
            graphData={graphData}
            width={dims.w}
            height={dims.h}
            backgroundColor={colors.background}
            // Drag off → the engine settles exactly once, then zoomToFit
            // frames the whole ego net inside the card (the clipped-blob
            // failure mode this replaced).
            enableNodeDrag={false}
            cooldownTicks={80}
            onEngineStop={() => fgRef.current?.zoomToFit(200, 18)}
            nodeVal={(n: PositionedNode) => 1 + Math.min(n.degree, 6)}
            nodeRelSize={3}
            nodeLabel={(n: PositionedNode) => n.name}
            nodeCanvasObject={(
              node: PositionedNode,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => {
              const n = node;
              const r = nodeRadius(n.degree);
              const isFocus = n.id === focusId;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
              ctx.fillStyle = colors.kinds[n.kind] ?? colors.kinds.other;
              ctx.fill();
              if (isFocus) {
                ctx.lineWidth = 1.5 / globalScale;
                ctx.strokeStyle = colors.foreground;
                ctx.stroke();
              }
              // Every node stays labelled — the ego net is ≤9 nodes and
              // unlabelled dots tell the reader nothing. ~9px on screen
              // regardless of the fit zoom, truncated hard.
              const fontSize = 9 / globalScale;
              ctx.font = `${isFocus ? 600 : 400} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = isFocus ? colors.foreground : colors.muted;
              const name =
                n.name.length > LABEL_MAX_CHARS
                  ? `${n.name.slice(0, LABEL_MAX_CHARS - 1)}…`
                  : n.name;
              ctx.fillText(name, n.x ?? 0, (n.y ?? 0) + r + 2.5 / globalScale);
            }}
            nodePointerAreaPaint={(
              node: PositionedNode,
              color: string,
              ctx: CanvasRenderingContext2D,
            ) => {
              const n = node;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, nodeRadius(n.degree) + 3, 0, 2 * Math.PI);
              ctx.fill();
            }}
            linkColor={() => colors.border}
            linkWidth={0.8}
            onNodeClick={(node: PositionedNode) => {
              if (node.id !== focusId) onNodeClick(node);
            }}
            d3VelocityDecay={0.35}
          />
        ) : null}
      </div>
      {ego?.truncated && (
        <p className="text-[11px] text-muted-foreground">
          {copy.connectionsTruncated}
        </p>
      )}
    </div>
  );
}
