"use client";

/**
 * WorkflowBoard (app-web) — n8n-style visual illustration of a workflow.
 *
 * Ported from `apps/web/src/components/workflow/workflow-board.tsx` (app
 * consolidation §5a). Renders the trigger plus every step as nodes on a
 * dotted-grid doc, laid out left-to-right by DAG depth (longest path
 * from the start step), connected by SVG bezier edges. Branch steps fan out
 * two tone-coded edges (true / false).
 *
 * It is a *view* surface: nodes are clickable so the detail page can jump
 * to the matching editor. Layout is automatic — no drag, no on-doc
 * editing (that stays in the step/trigger editors).
 *
 * Spec: docs/architecture/features/workflow.md → "Board view".
 * [COMP:app-web/workflow]
 */

import { useMemo } from "react";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { ViewListRow } from "@/lib/api/views";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowTrigger,
} from "@/lib/api/workflow";
import { cn } from "@/lib/utils";

// ── Doc geometry ──────────────────────────────────────────────────────

const NODE_W = 210;
const NODE_H = 84;
const GAP_X = 80;
const GAP_Y = 32;
const PAD = 40;

const colX = (col: number) => PAD + col * (NODE_W + GAP_X);
const rowY = (row: number) => PAD + row * (NODE_H + GAP_Y);

// ── Types ────────────────────────────────────────────────────────────────

type NodeKind = "trigger" | WorkflowStep["type"];
type EdgeTone = "default" | "true" | "false";

type PlacedNode = {
  key: string; // "trigger" | step.id
  kind: NodeKind;
  x: number;
  y: number;
  step?: WorkflowStep;
};

type PlacedEdge = {
  id: string;
  from: string;
  to: string;
  tone: EdgeTone;
};

type Layout = {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
};

type Props = {
  definition: WorkflowDefinition;
  trigger: WorkflowTrigger;
  assistants: StudioAssistantSummary[];
  /** Workspace page roster — resolves page-anchor chips to page titles. */
  pages?: ViewListRow[];
  selectedKey?: string | null;
  onSelectStep?: (stepId: string) => void;
  onSelectTrigger?: () => void;
};

// ── Layout ───────────────────────────────────────────────────────────────

function successorsOf(
  step: WorkflowStep,
  orderedIds: string[],
): { to: string | null; tone: EdgeTone }[] {
  if (step.type === "branch") {
    return [
      { to: step.nextStepIdIfTrue, tone: "true" },
      { to: step.nextStepIdIfFalse, tone: "false" },
    ];
  }
  if (step.nextStepId !== undefined) {
    return [{ to: step.nextStepId, tone: "default" }];
  }
  // Sequential fall-through to the next step in array order.
  const idx = orderedIds.indexOf(step.id);
  if (idx >= 0 && idx < orderedIds.length - 1) {
    return [{ to: orderedIds[idx + 1], tone: "default" }];
  }
  return [];
}

function computeLayout(def: WorkflowDefinition): Layout {
  const steps = def.steps;
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const orderedIds = steps.map((s) => s.id);

  // Column = longest path from the start step. Relaxation converges in at
  // most `steps.length` passes; the cap also guards against a cyclic
  // definition (the schema allows nextStepId to point anywhere).
  const colMap = new Map<string, number>();
  if (stepById.has(def.startStepId)) colMap.set(def.startStepId, 0);
  for (let pass = 0; pass <= steps.length; pass++) {
    let changed = false;
    for (const step of steps) {
      const c = colMap.get(step.id);
      if (c === undefined) continue;
      for (const edge of successorsOf(step, orderedIds)) {
        if (!edge.to || !stepById.has(edge.to)) continue;
        if ((colMap.get(edge.to) ?? -1) < c + 1) {
          colMap.set(edge.to, c + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Steps unreachable from the start get parked in a trailing column.
  let maxReached = 0;
  for (const c of colMap.values()) maxReached = Math.max(maxReached, c);
  for (const s of steps) {
    if (!colMap.has(s.id)) colMap.set(s.id, maxReached + 1);
  }

  // Rows: stack steps that share a column, in definition order.
  const byColumn = new Map<number, string[]>();
  for (const s of steps) {
    const c = colMap.get(s.id)!;
    const bucket = byColumn.get(c);
    if (bucket) bucket.push(s.id);
    else byColumn.set(c, [s.id]);
  }
  const rowMap = new Map<string, number>();
  for (const ids of byColumn.values()) {
    ids.forEach((id, row) => rowMap.set(id, row));
  }

  // The trigger occupies column 0; steps shift one column right.
  const nodes: PlacedNode[] = [
    { key: "trigger", kind: "trigger", x: colX(0), y: rowY(0) },
  ];
  let maxColIdx = 0;
  let maxRowIdx = 0;
  for (const s of steps) {
    const col = colMap.get(s.id)! + 1;
    const row = rowMap.get(s.id)!;
    maxColIdx = Math.max(maxColIdx, col);
    maxRowIdx = Math.max(maxRowIdx, row);
    nodes.push({ key: s.id, kind: s.type, step: s, x: colX(col), y: rowY(row) });
  }

  const edges: PlacedEdge[] = [];
  if (stepById.has(def.startStepId)) {
    edges.push({
      id: "trigger->start",
      from: "trigger",
      to: def.startStepId,
      tone: "default",
    });
  }
  for (const s of steps) {
    for (const edge of successorsOf(s, orderedIds)) {
      if (!edge.to || !stepById.has(edge.to)) continue;
      edges.push({
        id: `${s.id}->${edge.to}:${edge.tone}`,
        from: s.id,
        to: edge.to,
        tone: edge.tone,
      });
    }
  }

  return {
    nodes,
    edges,
    width: PAD * 2 + (maxColIdx + 1) * NODE_W + maxColIdx * GAP_X,
    height: PAD * 2 + (maxRowIdx + 1) * NODE_H + maxRowIdx * GAP_Y,
  };
}

// ── Node content ─────────────────────────────────────────────────────────

function assistantLabel(
  ref: string,
  assistants: StudioAssistantSummary[],
  t: Dictionary,
): string {
  if (ref === "primary") return t.workflowPage.board.primaryAssistant;
  const match = assistants.find((a) => a.id === ref);
  return match ? match.name : `${ref.slice(0, 8)}…`;
}

function waitLabel(step: Extract<WorkflowStep, { type: "wait" }>): string {
  if (step.until) {
    const d = step.until.duration;
    const parts: string[] = [];
    if (d.days) parts.push(`${d.days}d`);
    if (d.hours) parts.push(`${d.hours}h`);
    if (d.minutes) parts.push(`${d.minutes}m`);
    return parts.join(" ") || "-";
  }
  return step.at?.datetime ?? "-";
}

/** Page-anchor chip for an assistant_call node's secondary line. */
function pageAnchorChip(
  step: Extract<WorkflowStep, { type: "assistant_call" }>,
  pages: ViewListRow[],
  t: Dictionary,
): string | null {
  const b = t.workflowPage.builder;
  if (!step.page) return null;
  if ("create" in step.page) return b.pageAnchorChipCreate;
  if ("fromStep" in step.page) {
    return format(b.pageAnchorChipEdit, { name: step.page.fromStep });
  }
  const anchorId = step.page.id;
  const page = pages.find((p) => p.id === anchorId);
  return format(b.pageAnchorChipEdit, {
    name: page?.name || `${anchorId.slice(0, 8)}…`,
  });
}

function format(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function describeStep(
  step: WorkflowStep,
  assistants: StudioAssistantSummary[],
  pages: ViewListRow[],
  t: Dictionary,
): { typeLabel: string; primary: string; secondary: string } {
  const desc = step.description?.trim();
  const b = t.workflowPage.builder;
  switch (step.type) {
    case "assistant_call": {
      const detail = assistantLabel(step.target.assistantId, assistants, t);
      const chip = pageAnchorChip(step, pages, t);
      const secondary = desc ? detail : step.id;
      return {
        typeLabel: b.stepTypeAssistantCall,
        primary: desc || detail,
        secondary: chip ? `${secondary} · ${chip}` : secondary,
      };
    }
    case "tool_call": {
      const detail = step.toolName || step.id;
      return {
        typeLabel: b.stepTypeToolCall,
        primary: desc || detail,
        secondary: desc ? detail : step.id,
      };
    }
    case "wait": {
      const detail = waitLabel(step);
      return {
        typeLabel: b.stepTypeWait,
        primary: desc || detail,
        secondary: desc ? detail : step.id,
      };
    }
    case "branch":
      return {
        typeLabel: b.stepTypeBranch,
        primary: desc || b.stepTypeBranch,
        secondary: step.id,
      };
  }
}

const TONE_CHIP: Record<NodeKind, string> = {
  trigger: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  assistant_call: "bg-primary/15 text-primary",
  tool_call: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  wait: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  branch: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

function NodeIcon({ kind }: { kind: NodeKind }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "trigger":
      return <svg {...common}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>;
    case "assistant_call":
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="12" rx="2" />
          <path d="M12 8V4M8 2h8M8 13v2M16 13v2" />
        </svg>
      );
    case "tool_call":
      return (
        <svg {...common}>
          <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-2.4 2.5-2.5Z" />
        </svg>
      );
    case "wait":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "branch":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7M8.4 7.2 15.6 8.4M8 16l8-4.5" />
        </svg>
      );
  }
}

// ── Edge geometry ────────────────────────────────────────────────────────

const EDGE_STROKE: Record<EdgeTone, string> = {
  default: "var(--muted-foreground)",
  true: "#10b981",
  false: "#ef4444",
};

function edgePath(src: PlacedNode, tgt: PlacedNode): string {
  const sx = src.x + NODE_W;
  const sy = src.y + NODE_H / 2;
  const tx = tgt.x;
  const ty = tgt.y + NODE_H / 2;
  const curve = Math.max(36, Math.abs(tx - sx) / 2);
  return `M ${sx},${sy} C ${sx + curve},${sy} ${tx - curve},${ty} ${tx},${ty}`;
}

// ── Component ────────────────────────────────────────────────────────────

export function WorkflowBoard({
  definition,
  trigger,
  assistants,
  pages = [],
  selectedKey,
  onSelectStep,
  onSelectTrigger,
}: Props) {
  const t = useT();
  const layout = useMemo(() => computeLayout(definition), [definition]);
  const nodeByKey = useMemo(
    () => new Map(layout.nodes.map((n) => [n.key, n])),
    [layout],
  );

  const triggerKind = trigger.kind;
  const triggerPrimary = t.workflowPage.triggerShort[triggerKind];

  return (
    <div
      className="rounded-xl border border-border overflow-auto bg-muted/20"
      style={{ maxHeight: "68vh" }}
    >
      <div
        className="relative"
        style={{
          width: Math.max(layout.width, 320),
          height: Math.max(layout.height, 220),
          // Dotted grid — the n8n doc texture. Scrolls with content.
          backgroundImage:
            "radial-gradient(circle, var(--border) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          backgroundPosition: `${PAD / 2}px ${PAD / 2}px`,
        }}
      >
        {/* Edge layer */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          {layout.edges.map((edge) => {
            const src = nodeByKey.get(edge.from);
            const tgt = nodeByKey.get(edge.to);
            if (!src || !tgt) return null;
            const stroke = EDGE_STROKE[edge.tone];
            const tx = tgt.x;
            const ty = tgt.y + NODE_H / 2;
            return (
              <g key={edge.id}>
                <path
                  d={edgePath(src, tgt)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={2}
                  strokeOpacity={edge.tone === "default" ? 0.5 : 0.8}
                />
                <circle cx={tx} cy={ty} r={3.5} fill={stroke} />
              </g>
            );
          })}
        </svg>

        {/* Branch edge labels (true / false) */}
        {layout.edges
          .filter((e) => e.tone !== "default")
          .map((edge) => {
            const src = nodeByKey.get(edge.from);
            const tgt = nodeByKey.get(edge.to);
            if (!src || !tgt) return null;
            const mx = (src.x + NODE_W + tgt.x) / 2;
            const my = (src.y + tgt.y + NODE_H) / 2;
            return (
              <span
                key={`label-${edge.id}`}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 rounded px-1.5 py-0.5",
                  "text-[10px] font-medium border bg-card",
                  edge.tone === "true"
                    ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                    : "text-red-600 dark:text-red-400 border-red-500/40",
                )}
                style={{ left: mx, top: my }}
              >
                {edge.tone === "true"
                  ? t.workflowPage.board.branchTrue
                  : t.workflowPage.board.branchFalse}
              </span>
            );
          })}

        {/* Node layer */}
        {layout.nodes.map((node) => {
          const selected = selectedKey === node.key;
          const content =
            node.kind === "trigger"
              ? {
                  typeLabel: t.workflowPage.board.triggerLabel,
                  primary: triggerPrimary,
                  secondary: "",
                }
              : describeStep(node.step!, assistants, pages, t);
          return (
            <button
              key={node.key}
              type="button"
              onClick={() =>
                node.kind === "trigger"
                  ? onSelectTrigger?.()
                  : onSelectStep?.(node.key)
              }
              className={cn(
                "absolute flex items-start gap-2.5 rounded-xl border bg-card p-3 text-left shadow-sm transition",
                "hover:shadow-md hover:border-primary/50",
                selected
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-border",
              )}
              style={{
                left: node.x,
                top: node.y,
                width: NODE_W,
                height: NODE_H,
              }}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  TONE_CHIP[node.kind],
                )}
              >
                <NodeIcon kind={node.kind} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {content.typeLabel}
                </span>
                <span className="truncate text-sm font-medium leading-tight">
                  {content.primary}
                </span>
                {content.secondary && (
                  <span className="truncate text-xs text-muted-foreground leading-tight">
                    {content.secondary}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
