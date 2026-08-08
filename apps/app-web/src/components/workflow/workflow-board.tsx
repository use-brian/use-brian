"use client";

/**
 * WorkflowBoard (app-web) — n8n-style drag-to-wire canvas for a workflow.
 *
 * Since 2026-08 the board is an EDITOR, not just an illustration:
 *  - nodes drag freely; positions persist on `definition.layout` (keyed by
 *    step id + the reserved `__trigger` key), auto-layout seats any node
 *    without an entry;
 *  - dropping a dragged node ONTO a wire rearranges the flow: the step is
 *    spliced out of its current wiring and inserted between the wire's
 *    endpoints (`insertStepIntoEdge`); the candidate wire highlights with a
 *    "Release to insert here" chip while dragging;
 *  - every node carries an output port (branch: two, tone-coded true/false);
 *    dragging a wire from a port onto another node connects them — a second
 *    target on a normal step's port becomes a parallel fan-out array
 *    (`nextStepId: [...]`, implicit join downstream);
 *  - clicking an edge selects it and offers a remove control (removing the
 *    implicit sequential fall-through pins `nextStepId: null`); the trigger
 *    port ADDS entry steps (`startStepId` array = trigger fan-out, every
 *    entry starts in parallel), and a trigger edge is removable while
 *    another remains — the last one re-targets by wiring the port instead;
 *  - illegal wires (self, duplicate, cycle, fan-out past the width cap) are
 *    refused with a transient notice — the graph edits live in
 *    `@/lib/workflow-canvas` (pure, unit-tested).
 *
 * Nodes stay clickable (select → the detail page opens that node's editor)
 * and the live-run overlay is unchanged: step nodes badge their live state,
 * edges feeding running steps animate, the trigger pulses. Parallel runs
 * can light several nodes at once.
 *
 * Spec: docs/architecture/features/workflow.md → "Web builder UI".
 * [COMP:app-web/workflow]
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { ViewListRow } from "@/lib/api/views";
import type {
  WorkflowDefinition,
  WorkflowNodePosition,
  WorkflowStep,
  WorkflowTrigger,
} from "@/lib/api/workflow";
import {
  MAX_FAN_OUT_WIDTH,
  NODE_H,
  NODE_W,
  PAD,
  TRIGGER_KEY,
  boardExtent,
  canvasEdges,
  connectEdge,
  edgeCurveOffset,
  edgeInsertionCandidate,
  insertStepIntoEdge,
  joinFanIn,
  parkedJoinStepIds,
  portAnchor,
  redundantTriggerEdgeKeys,
  removeEdge,
  resolvePositions,
  unreachableStepIds,
  type CanvasEdge,
  type EdgeTone,
  type PortRef,
} from "@/lib/workflow-canvas";
import {
  isActivelyExecuting,
  type LiveRunView,
  type StepLiveState,
} from "@/lib/workflow-live-run";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────

type NodeKind = "trigger" | WorkflowStep["type"];

type Props = {
  definition: WorkflowDefinition;
  trigger: WorkflowTrigger;
  assistants: StudioAssistantSummary[];
  /** Workspace page roster — resolves page-anchor chips to page titles. */
  pages?: ViewListRow[];
  selectedKey?: string | null;
  /**
   * Live overlay for an in-flight run (`useWorkflowLiveRun`). When set, step
   * nodes badge their live state (spinner / check / cross / pause), the edge
   * feeding the running step animates, and the trigger node pulses. Null
   * renders the neutral board.
   */
  live?: LiveRunView | null;
  onSelectStep?: (stepId: string) => void;
  onSelectTrigger?: () => void;
  /**
   * Receives the rewired/repositioned definition on every canvas edit (node
   * drop, wire connect, edge removal). Absent → the board is read-only.
   */
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  /** Force read-only (managed workflows). Default: editable when onDefinitionChange is set. */
  editable?: boolean;
};

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

// ── Live-run overlay ─────────────────────────────────────────────────────

/** Node border/ring per live step state (selected still wins). */
const LIVE_NODE_RING: Record<StepLiveState, string> = {
  running: "border-primary/70 ring-2 ring-primary/25 shadow-md",
  waiting: "border-amber-500/60 ring-2 ring-amber-500/20",
  completed: "border-emerald-500/50",
  failed: "border-red-500/60",
  skipped: "border-border opacity-70",
};

/**
 * Corner badge showing what the live run is doing with this step: a spinner
 * while the assistant works it, a pause glyph on a wait/approval, check /
 * cross / dash once resolved. Icon-only (nodes are 210px wide) — the state
 * name rides the title/aria-label.
 */
function LiveStateBadge({
  state,
  t,
}: {
  state: StepLiveState;
  t: Dictionary;
}) {
  const label = t.workflowPage.board.stepState[state];
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border border-background shadow-sm",
        state === "running" && "bg-primary text-primary-foreground",
        state === "waiting" && "bg-amber-500 text-white",
        state === "completed" && "bg-emerald-500 text-white",
        state === "failed" && "bg-red-500 text-white",
        state === "skipped" && "bg-muted text-muted-foreground",
      )}
    >
      {state === "running" ? (
        <svg {...common} className="animate-spin">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
      ) : state === "waiting" ? (
        <svg {...common}>
          <path d="M9 5v14M15 5v14" />
        </svg>
      ) : state === "completed" ? (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : state === "failed" ? (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      ) : (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      )}
    </span>
  );
}

// ── Edge geometry ────────────────────────────────────────────────────────

const EDGE_STROKE: Record<EdgeTone, string> = {
  default: "var(--muted-foreground)",
  true: "#10b981",
  false: "#ef4444",
};

function bezierPath(sx: number, sy: number, tx: number, ty: number): string {
  const curve = edgeCurveOffset(sx, tx);
  return `M ${sx},${sy} C ${sx + curve},${sy} ${tx - curve},${ty} ${tx},${ty}`;
}

/** Cubic-bezier midpoint for the same control points as `bezierPath`. */
function bezierMidpoint(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const curve = edgeCurveOffset(sx, tx);
  // t = 0.5 on the cubic: (P0 + 3P1 + 3P2 + P3) / 8.
  return {
    x: (sx + 3 * (sx + curve) + 3 * (tx - curve) + tx) / 8,
    y: (sy + 3 * sy + 3 * ty + ty) / 8,
  };
}

// ── Interaction state ────────────────────────────────────────────────────

type NodeDrag = {
  key: string;
  /** Pointer offset inside the node at grab time. */
  dx: number;
  dy: number;
  /** Node position at grab time (movement threshold reference). */
  ox: number;
  oy: number;
  x: number;
  y: number;
  /** Becomes true after the movement threshold — suppresses the click. */
  moved: boolean;
  /** Wire the node currently hovers close enough to splice into on drop. */
  insertEdgeKey: string | null;
};

type WireDrag = {
  from: PortRef;
  tone: EdgeTone;
  /** Source anchor (board coords). */
  sx: number;
  sy: number;
  /** Cursor (board coords). */
  x: number;
  y: number;
  /** Node the wire currently hovers (drop candidate). */
  overKey: string | null;
};

// ── Component ────────────────────────────────────────────────────────────

export function WorkflowBoard({
  definition,
  trigger,
  assistants,
  pages = [],
  selectedKey,
  live,
  onSelectStep,
  onSelectTrigger,
  onDefinitionChange,
  editable,
}: Props) {
  const t = useT();
  const canEdit = (editable ?? true) && !!onDefinitionChange;
  const boardRef = useRef<HTMLDivElement | null>(null);

  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Transient refusal notice.
  useEffect(() => {
    if (!notice) return;
    const tid = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(tid);
  }, [notice]);

  const positions = useMemo(() => resolvePositions(definition), [definition]);
  const displayPositions = useMemo(() => {
    if (!nodeDrag) return positions;
    return { ...positions, [nodeDrag.key]: { x: nodeDrag.x, y: nodeDrag.y } };
  }, [positions, nodeDrag]);

  const edges = useMemo(() => canvasEdges(definition), [definition]);
  const selectedEdge = useMemo(
    () => edges.find((e) => e.key === selectedEdgeKey) ?? null,
    [edges, selectedEdgeKey],
  );
  const stepById = useMemo(
    () => new Map(definition.steps.map((s) => [s.id, s])),
    [definition],
  );
  const unreachable = useMemo(
    () => unreachableStepIds(definition),
    [definition],
  );
  const fanIn = useMemo(() => joinFanIn(definition), [definition]);
  const redundantTrigger = useMemo(
    () => redundantTriggerEdgeKeys(definition),
    [definition],
  );

  const extent = boardExtent(displayPositions);
  const width = Math.max(
    extent.width,
    320,
    wireDrag ? wireDrag.x + PAD : 0,
  );
  const height = Math.max(
    extent.height,
    220,
    wireDrag ? wireDrag.y + PAD : 0,
  );

  const triggerKind = trigger.kind;
  const triggerPrimary = t.workflowPage.triggerShort[triggerKind];
  const liveStates = live?.stepStates;
  const runActive = live ? isActivelyExecuting(live.status) : false;
  // Joins the active run has parked — one inbound path settled, another
  // still pending. A parked step has no step-run row, so absence from
  // stepStates is the signal.
  const parkedJoins = useMemo(
    () =>
      runActive && liveStates
        ? parkedJoinStepIds(definition, liveStates)
        : new Set<string>(),
    [definition, liveStates, runActive],
  );

  const toBoard = (e: { clientX: number; clientY: number }) => {
    const rect = boardRef.current?.getBoundingClientRect();
    return rect
      ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
      : { x: 0, y: 0 };
  };

  // ── Node dragging ───────────────────────────────────────────────────

  const onNodePointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    key: string,
  ) => {
    if (!canEdit || e.button !== 0) return;
    // Ports handle their own pointerdown (stopPropagation).
    const pos = displayPositions[key];
    if (!pos) return;
    const p = toBoard(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setNodeDrag({
      key,
      dx: p.x - pos.x,
      dy: p.y - pos.y,
      ox: pos.x,
      oy: pos.y,
      x: pos.x,
      y: pos.y,
      moved: false,
      insertEdgeKey: null,
    });
  };

  const onNodePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!nodeDrag) return;
    const p = toBoard(e);
    const x = Math.max(0, p.x - nodeDrag.dx);
    const y = Math.max(0, p.y - nodeDrag.dy);
    const moved =
      nodeDrag.moved ||
      Math.abs(x - nodeDrag.ox) > 3 ||
      Math.abs(y - nodeDrag.oy) > 3;
    const insertEdgeKey = moved
      ? (edgeInsertionCandidate(
          definition,
          positions,
          nodeDrag.key,
          x + NODE_W / 2,
          y + NODE_H / 2,
        )?.key ?? null)
      : null;
    setNodeDrag({ ...nodeDrag, x, y, moved, insertEdgeKey });
  };

  const onNodePointerUp = (key: string) => {
    if (!nodeDrag || nodeDrag.key !== key) return;
    const wasDrag = nodeDrag.moved;
    if (wasDrag && onDefinitionChange) {
      const layout = {
        ...(definition.layout ?? {}),
        [key]: { x: Math.round(nodeDrag.x), y: Math.round(nodeDrag.y) },
      };
      let next: WorkflowDefinition = { ...definition, layout };
      const dropEdge = nodeDrag.insertEdgeKey
        ? edges.find((e) => e.key === nodeDrag.insertEdgeKey)
        : undefined;
      if (dropEdge) {
        const result = insertStepIntoEdge(definition, key, dropEdge);
        if (result.ok) {
          next = { ...result.definition, layout };
        } else if (result.reason === "width") {
          setNotice(
            format(t.workflowPage.board.wireRefusedWidth, {
              n: String(MAX_FAN_OUT_WIDTH),
            }),
          );
        }
      }
      onDefinitionChange(next);
    }
    setNodeDrag(null);
    if (!wasDrag) {
      // Plain click — select the node.
      if (key === TRIGGER_KEY) onSelectTrigger?.();
      else onSelectStep?.(key);
    }
  };

  // ── Wire dragging (ports) ───────────────────────────────────────────

  const onPortPointerDown = (
    e: ReactPointerEvent<HTMLElement>,
    from: PortRef,
    tone: EdgeTone,
  ) => {
    if (!canEdit || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const key = from.kind === "trigger" ? TRIGGER_KEY : from.stepId;
    const pos = displayPositions[key];
    if (!pos) return;
    const anchor = portAnchor(
      pos,
      tone,
      from.kind === "step" && stepById.get(from.stepId)?.type === "branch",
    );
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toBoard(e);
    setWireDrag({ from, tone, sx: anchor.x, sy: anchor.y, x: p.x, y: p.y, overKey: null });
  };

  const nodeKeyAtPoint = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const nodeEl = el?.closest?.("[data-node-key]") as HTMLElement | null;
    return nodeEl?.dataset.nodeKey ?? null;
  };

  const onPortPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!wireDrag) return;
    const p = toBoard(e);
    const overKey = nodeKeyAtPoint(e.clientX, e.clientY);
    setWireDrag({ ...wireDrag, x: p.x, y: p.y, overKey });
  };

  const onPortPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!wireDrag) return;
    const targetKey = nodeKeyAtPoint(e.clientX, e.clientY);
    setWireDrag(null);
    if (!targetKey || targetKey === TRIGGER_KEY || !onDefinitionChange) return;
    const result = connectEdge(definition, wireDrag.from, targetKey);
    if (result.ok) {
      onDefinitionChange(result.definition);
      setSelectedEdgeKey(null);
    } else {
      const b = t.workflowPage.board;
      setNotice(
        result.reason === "cycle"
          ? b.wireRefusedCycle
          : result.reason === "width"
            ? format(b.wireRefusedWidth, { n: String(MAX_FAN_OUT_WIDTH) })
            : result.reason === "self"
              ? b.wireRefusedSelf
              : b.wireRefusedDuplicate,
      );
    }
  };

  // ── Edge removal ────────────────────────────────────────────────────

  const onRemoveEdge = (edge: CanvasEdge) => {
    if (!onDefinitionChange) return;
    onDefinitionChange(removeEdge(definition, edge));
    setSelectedEdgeKey(null);
  };

  // ── Render ──────────────────────────────────────────────────────────

  const renderPort = (
    from: PortRef,
    tone: EdgeTone,
    pos: WorkflowNodePosition,
    isBranch: boolean,
    title: string,
  ) => {
    const anchor = portAnchor(pos, tone, isBranch);
    return (
      <span
        key={`port-${from.kind === "trigger" ? TRIGGER_KEY : `${from.stepId}:${tone}`}`}
        role="button"
        title={title}
        aria-label={title}
        onPointerDown={(e) => onPortPointerDown(e, from, tone)}
        onPointerMove={onPortPointerMove}
        onPointerUp={onPortPointerUp}
        className={cn(
          "absolute z-20 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center",
          "cursor-crosshair touch-none",
        )}
        style={{ left: anchor.x, top: anchor.y }}
      >
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full border-2 bg-background transition-transform hover:scale-125",
            tone === "true"
              ? "border-emerald-500"
              : tone === "false"
                ? "border-red-500"
                : "border-muted-foreground/70 hover:border-primary",
          )}
        />
      </span>
    );
  };

  return (
    <div
      className="rounded-xl border border-border overflow-auto bg-muted/20 relative"
      style={{ maxHeight: "68vh" }}
    >
      <div
        ref={boardRef}
        className={cn("relative", nodeDrag?.moved && "select-none")}
        style={{
          width,
          height,
          // Dotted grid — the n8n doc texture. Scrolls with content.
          backgroundImage:
            "radial-gradient(circle, var(--border) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          backgroundPosition: `${PAD / 2}px ${PAD / 2}px`,
        }}
        onPointerDown={() => setSelectedEdgeKey(null)}
      >
        {/* Edge layer */}
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          aria-hidden
          style={{ pointerEvents: "none" }}
        >
          {edges.map((edge) => {
            const src = displayPositions[edge.from];
            const tgt = displayPositions[edge.to];
            if (!src || !tgt) return null;
            const isBranch = stepById.get(edge.from)?.type === "branch";
            const a = portAnchor(src, edge.tone, !!isBranch);
            const tx = tgt.x;
            const ty = tgt.y + NODE_H / 2;
            // An edge feeding the live run's active step flows (dash march);
            // one feeding an already-completed step reads as traversed.
            const targetState = liveStates?.[edge.to];
            const activeEdge = targetState === "running";
            const doneEdge =
              targetState === "completed" || targetState === "waiting";
            const isSelected = selectedEdgeKey === edge.key;
            const insertTarget =
              !!nodeDrag?.moved && nodeDrag.insertEdgeKey === edge.key;
            // A wire leaving an unreachable step is dead: it never fires. A
            // redundant trigger wire (its entry step already waits on
            // another path) gets the same faint treatment.
            const redundantWire =
              edge.source === "trigger" && redundantTrigger.has(edge.key);
            const deadEdge = unreachable.has(edge.from) || redundantWire;
            const stroke = insertTarget
              ? "var(--primary)"
              : isSelected
                ? "var(--primary)"
                : activeEdge
                  ? "var(--primary)"
                  : doneEdge && edge.tone === "default"
                    ? "#10b981"
                    : EDGE_STROKE[edge.tone];
            const d = bezierPath(a.x, a.y, tx, ty);
            return (
              <g key={edge.key}>
                <path
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={insertTarget ? 3.5 : isSelected ? 3 : activeEdge ? 2.5 : 2}
                  strokeOpacity={
                    insertTarget || isSelected || activeEdge || doneEdge
                      ? 0.9
                      : deadEdge
                        ? 0.25
                        : edge.tone === "default"
                          ? edge.source === "fallthrough"
                            ? 0.45
                            : 0.5
                          : 0.8
                  }
                  strokeDasharray={
                    insertTarget
                      ? "6 6"
                      : activeEdge
                        ? "7 7"
                        : deadEdge
                          ? "4 4"
                          : undefined
                  }
                >
                  {activeEdge && (
                    <animate
                      attributeName="stroke-dashoffset"
                      from="28"
                      to="0"
                      dur="0.9s"
                      repeatCount="indefinite"
                    />
                  )}
                </path>
                {/* Fat invisible twin — the click target for selection (and
                    the only hoverable element: the svg layer itself is
                    pointer-events none). */}
                {canEdit && (
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedEdgeKey(isSelected ? null : edge.key);
                    }}
                  >
                    {redundantWire && (
                      <title>{t.workflowPage.board.triggerWireRedundant}</title>
                    )}
                  </path>
                )}
                <circle cx={tx} cy={ty} r={3.5} fill={stroke} />
              </g>
            );
          })}

          {/* In-flight wire */}
          {wireDrag && (
            <path
              d={bezierPath(wireDrag.sx, wireDrag.sy, wireDrag.x, wireDrag.y)}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={2}
              strokeDasharray="6 6"
              strokeOpacity={0.85}
            />
          )}
        </svg>

        {/* Branch edge labels (true / false) */}
        {edges
          .filter((e) => e.tone !== "default")
          .map((edge) => {
            const src = displayPositions[edge.from];
            const tgt = displayPositions[edge.to];
            if (!src || !tgt) return null;
            const mx = (src.x + NODE_W + tgt.x) / 2;
            const my = (src.y + tgt.y + NODE_H) / 2;
            return (
              <span
                key={`label-${edge.key}`}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 pointer-events-none",
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

        {/* Drop-to-insert chip at the candidate wire's midpoint */}
        {nodeDrag?.moved &&
          nodeDrag.insertEdgeKey &&
          (() => {
            const edge = edges.find((e) => e.key === nodeDrag.insertEdgeKey);
            if (!edge) return null;
            const src = displayPositions[edge.from];
            const tgt = displayPositions[edge.to];
            if (!src || !tgt) return null;
            const isBranch = stepById.get(edge.from)?.type === "branch";
            const a = portAnchor(src, edge.tone, !!isBranch);
            const mid = bezierMidpoint(a.x, a.y, tgt.x, tgt.y + NODE_H / 2);
            return (
              <span
                className={cn(
                  "pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap",
                  "rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5",
                  "text-[10px] font-medium text-primary shadow-sm backdrop-blur",
                )}
                style={{ left: mid.x, top: mid.y }}
              >
                {t.workflowPage.board.dropToInsert}
              </span>
            );
          })()}

        {/* Selected-edge remove control at the curve midpoint. A trigger
            edge is removable only while a sibling entry step remains. */}
        {selectedEdge &&
          canEdit &&
          (selectedEdge.source !== "trigger" ||
            (Array.isArray(definition.startStepId) &&
              definition.startStepId.length > 1)) &&
          (() => {
            const src = displayPositions[selectedEdge.from];
            const tgt = displayPositions[selectedEdge.to];
            if (!src || !tgt) return null;
            const isBranch = stepById.get(selectedEdge.from)?.type === "branch";
            const a = portAnchor(src, selectedEdge.tone, !!isBranch);
            const mid = bezierMidpoint(a.x, a.y, tgt.x, tgt.y + NODE_H / 2);
            return (
              <button
                type="button"
                title={t.workflowPage.board.removeConnection}
                aria-label={t.workflowPage.board.removeConnection}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemoveEdge(selectedEdge)}
                className={cn(
                  "absolute z-30 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center",
                  "rounded-full border border-red-500/60 bg-card text-red-600 dark:text-red-400 shadow-sm",
                  "hover:bg-red-500 hover:text-white transition-colors",
                )}
                style={{ left: mid.x, top: mid.y }}
              >
                <svg
                  width={11}
                  height={11}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            );
          })()}

        {/* Node layer */}
        {[
          { key: TRIGGER_KEY, kind: "trigger" as NodeKind, step: undefined },
          ...definition.steps.map((s) => ({
            key: s.id,
            kind: s.type as NodeKind,
            step: s as WorkflowStep | undefined,
          })),
        ].map((node) => {
          const pos = displayPositions[node.key];
          if (!pos) return null;
          const selected = selectedKey === node.key;
          const liveState =
            node.kind === "trigger" ? undefined : liveStates?.[node.key];
          const content =
            node.kind === "trigger"
              ? {
                  typeLabel: t.workflowPage.board.triggerLabel,
                  primary: triggerPrimary,
                  secondary: "",
                }
              : describeStep(node.step!, assistants, pages, t);
          const isBranch = node.step?.type === "branch";
          const dropTarget =
            wireDrag?.overKey === node.key && node.kind !== "trigger";
          const orphan =
            node.kind !== "trigger" && unreachable.has(node.key);
          const joinCount =
            node.kind !== "trigger" ? (fanIn.get(node.key) ?? 0) : 0;
          const isJoin = joinCount >= 2;
          const parked = !liveState && parkedJoins.has(node.key);
          return (
            <div key={node.key}>
              <div
                data-node-key={node.key}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => onNodePointerDown(e, node.key)}
                onPointerMove={onNodePointerMove}
                onPointerUp={() => onNodePointerUp(node.key)}
                onClick={() => {
                  // Read-only boards never enter the drag path — plain click.
                  if (canEdit) return;
                  if (node.key === TRIGGER_KEY) onSelectTrigger?.();
                  else onSelectStep?.(node.key);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (node.key === TRIGGER_KEY) onSelectTrigger?.();
                    else onSelectStep?.(node.key);
                  }
                }}
                className={cn(
                  "absolute flex items-start gap-2.5 rounded-xl border bg-card p-3 text-left shadow-sm transition",
                  "hover:shadow-md hover:border-primary/50",
                  canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                  orphan && "border-dashed opacity-75 hover:opacity-100",
                  nodeDrag?.key === node.key && nodeDrag.moved && "z-30 shadow-lg opacity-100",
                  dropTarget
                    ? "border-primary ring-2 ring-primary/40"
                    : selected
                      ? "border-primary ring-2 ring-primary/30"
                      : liveState
                        ? LIVE_NODE_RING[liveState]
                        : "border-border",
                )}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: NODE_W,
                  height: NODE_H,
                  ...(canEdit ? { touchAction: "none" as const } : {}),
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
                {liveState && <LiveStateBadge state={liveState} t={t} />}
                {parked && (
                  <span
                    title={t.workflowPage.board.waitingOnPaths}
                    aria-label={t.workflowPage.board.waitingOnPaths}
                    className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-amber-500 text-white shadow-sm"
                  >
                    <svg
                      width={11}
                      height={11}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M7 3h10M7 21h10M8 3v3l4 4 4-4V3M8 21v-3l4-4 4 4v3" />
                    </svg>
                  </span>
                )}
                {node.kind === "trigger" && runActive && (
                  <span
                    className="absolute -top-1 -right-1 flex h-3 w-3"
                    title={t.workflowPage.board.runActive}
                    aria-label={t.workflowPage.board.runActive}
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                  </span>
                )}
              </div>

              {/* Semantics chips under the node: orphan nudge + join contract. */}
              {(orphan || isJoin) && (
                <span
                  className="absolute z-10 flex items-center gap-1"
                  style={{ left: pos.x + 8, top: pos.y + NODE_H + 6 }}
                >
                  {orphan && (
                    <span
                      title={t.workflowPage.board.neverRunsHint}
                      className={cn(
                        "whitespace-nowrap rounded-full border px-2 py-0.5",
                        "border-amber-400/60 bg-amber-500/15 text-[10px] font-medium",
                        "text-amber-700 dark:text-amber-300",
                      )}
                    >
                      {t.workflowPage.board.neverRuns}
                    </span>
                  )}
                  {isJoin && (
                    <span
                      title={t.workflowPage.board.joinsPathsHint}
                      className={cn(
                        "whitespace-nowrap rounded-full border px-2 py-0.5",
                        "border-border bg-card text-[10px] font-medium",
                        "text-muted-foreground",
                      )}
                    >
                      {format(t.workflowPage.board.joinsPaths, {
                        n: String(joinCount),
                      })}
                    </span>
                  )}
                </span>
              )}

              {/* Output ports */}
              {canEdit &&
                (node.kind === "trigger"
                  ? renderPort(
                      { kind: "trigger" },
                      "default",
                      pos,
                      false,
                      t.workflowPage.board.portConnect,
                    )
                  : isBranch
                    ? [
                        renderPort(
                          { kind: "step", stepId: node.key, port: "true" },
                          "true",
                          pos,
                          true,
                          `${t.workflowPage.board.portConnect} · ${t.workflowPage.board.branchTrue}`,
                        ),
                        renderPort(
                          { kind: "step", stepId: node.key, port: "false" },
                          "false",
                          pos,
                          true,
                          `${t.workflowPage.board.portConnect} · ${t.workflowPage.board.branchFalse}`,
                        ),
                      ]
                    : renderPort(
                        { kind: "step", stepId: node.key },
                        "default",
                        pos,
                        false,
                        t.workflowPage.board.portConnect,
                      ))}
            </div>
          );
        })}

      </div>

      {/* Transient wire-refusal notice — pinned to the visible viewport. */}
      {notice && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-40 flex justify-center">
          <span className="rounded-full border border-amber-400/60 bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 shadow-sm backdrop-blur">
            {notice}
          </span>
        </div>
      )}
    </div>
  );
}
