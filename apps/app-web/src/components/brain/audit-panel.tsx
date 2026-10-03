"use client";

/**
 * Audit panel — the DETAIL half of the Brain Audit master-detail (the
 * chat-history audit browser, docs/plans/chat-auditing.md Phase C, open
 * single-player slice).
 *
 * The sidebar's `AuditSessionList` picks a conversation; this pane steps
 * through it one assistant turn at a time and shows, for the selected turn:
 *
 *   - the TRANSCRIPT rail (left on `lg+`, below the graph on smaller panes):
 *     every turn as prompt → reply, with the tools it used and a fidelity
 *     dot; the selected turn expands its STEP TRACE inline — retrieval
 *     (which entries entered context), model calls (model, stop reason,
 *     tokens), tool calls (name, error flag, input/result on demand through
 *     the member-gated payload route), the legacy usage summary;
 *   - the BRAIN GRAPH (right / top) with the turn's retrieved entries lit
 *     up (`BrainGraphView.highlightIds` → the server's exact-id focus), and
 *     the RETRIEVED ENTRIES list under the retrieval step with each row's
 *     resolved name, its nudge verdict, whether it is on the graph, and a
 *     Reveal action that re-scopes the graph to it.
 *
 * Read model: `fetchSessionMessages` (the transcript), `fetchTurnTrace`
 * (the epoch-routed ledger trace), `fetchTurnPayload` (content, on demand),
 * `fetchBrainRow` / `getKnowledgeEntry` (row names, clearance-scoped).
 * Everything the panel derives is pure and tested in `lib/turn-audit.ts`.
 *
 * Deliberately NOT here (plan §5.7-5.8 still open, closed overlay): the
 * consolidation directive action and report-to-us.
 *
 * Spec: docs/architecture/features/chat-audit.md.
 * [COMP:app-web/brain-audit]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  FileText,
  MessageSquareText,
  Pause,
  Play,
  RotateCcw,
  Route,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import {
  fetchSessionMessages,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import { fetchTurnPayload, fetchTurnTrace } from "@/lib/api/turn-trace";
import {
  getKnowledgeEntry,
  type BrainGraph,
  type BrainGraphNode,
  type BrainRow,
} from "@/lib/api/brain";
import { fetchBrainRow } from "@/lib/api/brain-inbox";
import type { BrainContentCacheScope } from "@/lib/offline/brain-content-cache";
import {
  buildAuditTurns,
  AUDIT_ACCESS_STEP_MS,
  eagerToolInputRefs,
  filterAuditTurns,
  formatPayloadPreview,
  formatTokens,
  graphHighlightIds,
  graphHighlightNames,
  graphAccessSteps,
  humanizeToolName,
  mergeTurnTraces,
  retrievedPrimitiveLabel,
  summarizeTrace,
  withToolInputs,
  type AuditStepView,
  type AuditTurn,
  type GraphAccessStep,
  type RetrievedRow,
  type TraceSummary,
} from "@/lib/turn-audit";
import { BrainGraphView } from "@/components/brain/graph-view";
import { AuditPromptDialog, type AuditPromptTarget } from "@/components/brain/audit-prompt-dialog";
import { Skeleton } from "@/components/skeleton";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";

type Props = {
  workspaceId: string;
  sessionId: string | null;
  /** The selected assistant message id (the trace key). */
  turnId: string | null;
  onSelectTurn: (turnId: string | null) => void;
  /** Reports the loaded turn list so the page can drive the topbar pager. */
  onTurnsLoaded: (turns: AuditTurn[]) => void;
  /** The workspace graph overview (the page's cached fetch). */
  graph: BrainGraph | null;
  viewpointAssistantId: string | null;
  cacheScope: BrainContentCacheScope | null;
  onOpenRow: (row: BrainRow) => void;
  onSelectSkillNode?: (skillRowId: string) => void;
};

type ResolvedRow = {
  name: string;
  kind: BrainRow["kind"];
  row: BrainRow;
  /** The graph node this entry draws as when the projection lacks it. */
  node: BrainGraphNode;
} | null;

type PayloadState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "erased" }
  | { status: "error" };

const glassChip =
  "inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground";

export function AuditPanel({
  workspaceId,
  sessionId,
  turnId,
  onSelectTurn,
  onTurnsLoaded,
  graph,
  viewpointAssistantId,
  cacheScope,
  onOpenRow,
  onSelectSkillNode,
}: Props) {
  const t = useT();
  const copy = t.brainPage.audit;

  // ── Transcript ────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<DocSessionMessage[] | null>(null);
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const selectedRowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const refresh = () => setRefresh((value) => value + 1);
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
  }, []);
  useEffect(() => {
    setMessages(null);
    if (!sessionId) return;
    const controller = new AbortController();
    void fetchSessionMessages(sessionId, { signal: controller.signal }).then((rows) => {
      if (!controller.signal.aborted) setMessages(rows);
    });
    return () => controller.abort();
  }, [sessionId, refresh]);

  const turns = useMemo(() => (messages ? buildAuditTurns(messages) : null), [messages]);
  const visibleTurns = useMemo(() => turns ? filterAuditTurns(turns, search) : [], [turns, search]);

  // Report the turn list; default the selection to the newest turn when
  // nothing (or a stale id from another session) is selected.
  const onTurnsLoadedRef = useRef(onTurnsLoaded);
  onTurnsLoadedRef.current = onTurnsLoaded;
  useEffect(() => {
    onTurnsLoadedRef.current(visibleTurns);
    if (!turns) return;
    if (visibleTurns.length === 0) {
      if (turnId !== null) onSelectTurn(null);
      return;
    }
    if (!turnId || !visibleTurns.some((turn) => turn.id === turnId)) {
      const linked = visibleTurns.find((turn) => turn.roundIds.includes(turnId ?? ""));
      onSelectTurn((linked ?? visibleTurns[0])!.id);
    }
  }, [turns, visibleTurns, turnId, onSelectTurn]);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [turnId, visibleTurns]);

  // ── Trace ─────────────────────────────────────────────────────────────
  const [trace, setTrace] = useState<{ turnId: string; summary: TraceSummary | null } | null>(
    null,
  );
  useEffect(() => {
    if (!sessionId || !turnId) {
      setTrace(null);
      return;
    }
    const controller = new AbortController();
    const roundIds = turns?.find((turn) => turn.id === turnId)?.roundIds ?? [turnId];
    void (async () => {
      // The ledger keys a post-epoch run by its last row, so that trace
      // already holds every round. A pre-epoch run has one legacy
      // composition per row instead - fetch the earlier rounds too and
      // merge, so the tools of round 1 are not lost behind round 3's text.
      const last = await fetchTurnTrace(sessionId, turnId, { signal: controller.signal });
      let merged = last;
      if ((!last || last.fidelity === "legacy") && roundIds.length > 1) {
        const earlier = await Promise.all(
          roundIds
            .slice(0, -1)
            .map((id) => fetchTurnTrace(sessionId, id, { signal: controller.signal })),
        );
        merged = mergeTurnTraces([...earlier, last]);
      }
      if (controller.signal.aborted) return;
      setTrace({ turnId, summary: merged ? summarizeTrace(merged) : null });
    })();
    return () => controller.abort();
  }, [sessionId, turnId, turns]);

  const rawSummary = trace && trace.turnId === turnId ? trace.summary : undefined;
  const traceLoading = Boolean(sessionId && turnId) && rawSummary === undefined;

  // Full-fidelity traces keep tool inputs behind payload hashes. The inputs
  // of BRAIN-ROW tools (getEntity, getMemory, ...) are what name the rows the
  // graph should light, so dereference those eagerly (bounded) instead of
  // waiting for the reviewer to expand each call. Keyed by turn so a stale
  // turn's inputs never bleed into the next.
  const [toolInputs, setToolInputs] = useState<{ turnId: string; inputs: Record<string, unknown> }>(
    () => ({ turnId: "", inputs: {} }),
  );
  useEffect(() => {
    if (!sessionId || !turnId || !rawSummary) return;
    const refs = eagerToolInputRefs(rawSummary);
    if (refs.length === 0) return;
    let cancelled = false;
    void Promise.all(
      refs.map(async ({ key, hash }) => {
        const payload = await fetchTurnPayload(sessionId, hash);
        if (!payload || payload.kind !== "text") return null;
        try {
          return [key, JSON.parse(payload.text) as unknown] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const inputs: Record<string, unknown> = {};
      for (const entry of entries) if (entry) inputs[entry[0]] = entry[1];
      setToolInputs({ turnId, inputs });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, turnId, rawSummary]);

  const summary = useMemo(
    () =>
      rawSummary && toolInputs.turnId === turnId
        ? withToolInputs(rawSummary, toolInputs.inputs)
        : rawSummary,
    [rawSummary, toolInputs, turnId],
  );

  const highlightIds = useMemo(() => {
    if (!summary) return null;
    const ids = graphHighlightIds(summary);
    return ids.length > 0 ? new Set(ids) : null;
  }, [summary]);
  // Entities the turn looked up BY NAME (`getEntity({ id_or_name })`) - the
  // graph matches these against its node names, since a name is no pointer.
  const highlightNames = useMemo(() => {
    if (!summary) return null;
    const names = graphHighlightNames(summary);
    return names.length > 0 ? new Set(names) : null;
  }, [summary]);

  const accesses = useMemo(() => summary ? graphAccessSteps(summary) : [], [summary]);
  const accessKey = JSON.stringify([sessionId, turnId, accesses]);
  // `cycle` counts loop passes so a one-access turn still re-pulses.
  const [playback, setPlayback] = useState({ key: "", index: 0, playing: false, run: 0, cycle: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [graphReady, setGraphReady] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== "hidden");
    updateMotion();
    updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  useEffect(() => {
    setPlayback({ key: accessKey, index: 0, playing: !reducedMotion && accesses.length > 0, run: 0, cycle: 0 });
  }, [accessKey, reducedMotion, accesses.length]);
  const playing = playback.key === accessKey && playback.playing && !reducedMotion;
  const activeAccess = playback.key === accessKey ? accesses[playback.index] : undefined;
  useEffect(() => {
    if (!playing || !documentVisible || !graphReady) return;
    // Loops: after the last access the replay holds one extra beat, then
    // starts over from the first, until paused or the turn changes.
    const last = playback.index + 1 >= accesses.length;
    const timer = window.setTimeout(() => setPlayback((current) =>
      current.index + 1 < accesses.length
        ? { ...current, index: current.index + 1 }
        : { ...current, index: 0, cycle: current.cycle + 1 },
    ), last ? AUDIT_ACCESS_STEP_MS * 2 : AUDIT_ACCESS_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, playback.index, playback.run, playback.cycle, accessKey, accesses.length, documentVisible, graphReady]);

  // Which highlighted ids the graph could actually place (reported by the
  // canvas after each projection) — drives the On graph / Not on graph
  // label per retrieved row.
  const [graphVisible, setGraphVisible] = useState<{
    visibleIds: Set<string>;
    groupCounts: Record<string, number>;
  }>(() => ({ visibleIds: new Set(), groupCounts: {} }));
  const handleHighlightResolved = useCallback(
    (info: { visibleIds: string[]; groupCounts: Record<string, number> }) => {
      setGraphVisible({ visibleIds: new Set(info.visibleIds), groupCounts: info.groupCounts });
    },
    [],
  );
  const [revealId, setRevealId] = useState<string | null>(null);
  useEffect(() => {
    setRevealId(null);
  }, [turnId]);

  // ── Retrieved row names ───────────────────────────────────────────────
  const resolvedRef = useRef<Map<string, ResolvedRow>>(new Map());
  const [resolved, setResolved] = useState<Map<string, ResolvedRow>>(new Map());
  useEffect(() => {
    if (!summary || summary.retrievedRows.length === 0) return;
    let cancelled = false;
    const pending = summary.retrievedRows
      .slice(0, 40)
      .filter((row) => !resolvedRef.current.has(`${row.primitive}:${row.rowId}`));
    if (pending.length === 0) {
      setResolved(new Map(resolvedRef.current));
      return;
    }
    void Promise.all(
      pending.map(async (row) => {
        const key = `${row.primitive}:${row.rowId}`;
        const value = await resolveRow(workspaceId, row, viewpointAssistantId, cacheScope);
        resolvedRef.current.set(key, value);
      }),
    ).then(() => {
      if (!cancelled) setResolved(new Map(resolvedRef.current));
    });
    return () => {
      cancelled = true;
    };
  }, [summary, workspaceId, viewpointAssistantId, cacheScope]);

  // Every resolved retrieved entry, as the node the graph draws when its
  // projection lacks it (unlinked memories are never in the graph route's
  // projection). The graph skips the ones it already has.
  const auditEntries = useMemo(() => {
    if (!summary) return undefined;
    const nodes: BrainGraphNode[] = [];
    for (const row of summary.retrievedRows.slice(0, 40)) {
      const res = resolved.get(`${row.primitive}:${row.rowId}`);
      if (res) nodes.push(res.node);
    }
    return nodes.length > 0 ? nodes : undefined;
  }, [summary, resolved]);

  const [promptTarget, setPromptTarget] = useState<AuditPromptTarget | null>(null);
  useEffect(() => {
    setPromptTarget(null);
  }, [turnId]);

  // ── Payload expansion (tool input / result) ───────────────────────────
  const [payloads, setPayloads] = useState<Record<string, PayloadState>>({});
  const loadPayload = useCallback(
    (hash: string) => {
      if (!sessionId) return;
      setPayloads((prev) => (prev[hash] ? prev : { ...prev, [hash]: { status: "loading" } }));
      void fetchTurnPayload(sessionId, hash).then((payload) => {
        setPayloads((prev) => ({
          ...prev,
          [hash]:
            payload === null
              ? { status: "error" }
              : payload.kind === "erased"
                ? { status: "erased" }
                : { status: "ready", text: formatPayloadPreview(payload.text) },
        }));
      });
    },
    [sessionId],
  );

  const graphPane = (
    /* A flex COLUMN, not a plain block: the graph's root is `flex-1 min-h-0`
       and only fills a flex parent - in a block it measured its own empty
       height and painted a 200px strip. */
    <section className="relative order-1 flex h-[280px] max-h-[42%] min-h-[200px] min-w-0 shrink-0 flex-col lg:order-2 lg:h-auto lg:max-h-none lg:flex-1 lg:min-h-0" aria-label={copy.brainAccess}>
      <div className="flex min-h-8 max-sm:min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 py-1">
        <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-medium">{copy.brainAccess}</p>
          <p className="truncate text-muted-foreground" role="status">
            {traceLoading ? copy.traceLoading : activeAccess
              ? `${format(copy.accessPosition, { current: playback.index + 1, total: accesses.length })} · ${activeAccess.toolName ? humanizeToolName(activeAccess.toolName) : copy.steps.retrieval}`
              : summary ? copy.noRecordedAccess : copy.traceUnavailable}
          </p>
        </div>
        {accesses.length > 0 && <>
          {reducedMotion ? (
            <button type="button" aria-label={copy.nextAccess} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:size-8" onClick={() => setPlayback((current) => ({ ...current, index: (current.index + 1) % accesses.length }))}>
              <ChevronRight className="size-4" aria-hidden />
            </button>
          ) : (
            <button type="button" aria-label={playing ? copy.pauseReplay : copy.playReplay} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:size-8" onClick={() => setPlayback((current) => ({ ...current, playing: !current.playing }))}>
              {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            </button>
          )}
          <button type="button" aria-label={copy.replay} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:size-8" onClick={() => setPlayback((current) => ({ key: accessKey, index: 0, playing: !reducedMotion, run: current.run + 1, cycle: 0 }))}>
            <RotateCcw className="size-4" aria-hidden />
          </button>
        </>}
      </div>
      <BrainGraphView
        graph={graph ?? { nodes: [], edges: [], truncated: false }}
        workspaceId={workspaceId}
        viewpointAssistantId={viewpointAssistantId}
        showMemory
        loading={graph === null}
        highlightIds={highlightIds}
        highlightNames={highlightNames}
        highlightRevealId={revealId}
        auditEntries={auditEntries}
        accessIds={activeAccess?.ids}
        accessNames={activeAccess?.names}
        accessPulseKey={playing ? `${accessKey}:${playback.index}:${playback.run}:${playback.cycle}` : null}
        onAccessReady={setGraphReady}
        auditMode
        onHighlightResolved={handleHighlightResolved}
        onSelect={onOpenRow}
        onSelectSkillNode={onSelectSkillNode}
      />
      {((highlightIds && highlightIds.size > 0) || (highlightNames && highlightNames.size > 0)) && (
        <div className="pointer-events-none absolute bottom-12 left-1/2 z-10 hidden max-w-[80%] -translate-x-1/2 rounded-md border border-[var(--graph-overlay-border)] bg-[var(--graph-overlay)] px-2.5 py-1 text-center text-[11px] text-[var(--graph-overlay-fg)] shadow-sm backdrop-blur-md lg:block">
          {copy.graphHint}
        </div>
      )}
    </section>
  );

  if (!sessionId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="order-2 flex shrink-0 flex-col items-center justify-center gap-2 border-t border-border px-8 py-10 text-center lg:order-1 lg:w-[400px] lg:border-r lg:border-t-0 xl:w-[440px]">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Route className="size-5" aria-hidden />
          </span>
          <p className="text-sm font-medium text-foreground">{copy.pickSessionTitle}</p>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {copy.pickSessionBody}
          </p>
        </aside>
        {graphPane}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      <aside className="order-2 flex min-h-0 min-w-0 flex-1 flex-col border-t border-border lg:order-1 lg:w-[400px] lg:flex-none lg:border-r lg:border-t-0 xl:w-[440px]">
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-md border border-input px-2 focus-within:border-ring [&_:focus-visible]:shadow-none">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.searchTurns} aria-label={copy.searchTurns} className="h-11 min-w-0 flex-1 bg-transparent md:h-8 text-base outline-none md:text-sm [&::-webkit-search-cancel-button]:appearance-none" />
            {search && <button type="button" onClick={() => setSearch("")} aria-label={copy.clearSearch} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:size-8"><X className="size-4" aria-hidden /></button>}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground" role="status">{search.trim() ? format(copy.matchingTurns, { count: visibleTurns.length, total: turns?.length ?? 0 }) : copy.newestFirst}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {turns === null ? (
            <TurnsSkeleton />
          ) : turns.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm font-medium text-foreground">{copy.noTurnsTitle}</p>
              <p className="mt-1 text-xs text-muted-foreground">{copy.noTurnsBody}</p>
            </div>
          ) : visibleTurns.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-muted-foreground">{copy.noMatchingTurns}</p>
          ) : (
            <ol className="flex flex-col">
              {visibleTurns.map((turn) => {
                const selected = turn.id === turnId;
                return (
                  <li key={turn.id} ref={selected ? selectedRowRef : undefined} className="border-b border-border/70">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectTurn(turn.id);
                        if (selected) setPlayback((current) => ({
                          ...current, index: 0, playing: !reducedMotion && accesses.length > 0,
                          run: current.run + 1, cycle: 0,
                        }));
                      }}
                      aria-pressed={selected}
                      className={cn(
                        "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors",
                        selected ? "bg-muted/40" : "hover:bg-muted/25",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          {format(copy.turnLabel, { index: turn.index })}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">{formatClock(turn.at)}</span>
                        {turn.rounds > 1 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{format(copy.roundsMany, { count: turn.rounds })}</span>
                          </>
                        )}
                        <span className="ml-auto inline-flex items-center gap-1">
                          <Wrench className="size-3" aria-hidden />
                          {turn.toolNames.length === 0
                            ? copy.noTools
                            : turn.toolNames.length === 1
                              ? copy.toolsUsedOne
                              : format(copy.toolsUsedMany, { count: turn.toolNames.length })}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-[12.5px] text-muted-foreground">
                        {turn.prompt ?? (
                          <span className="italic">{copy.noPrompt}</span>
                        )}
                      </p>
                      <p
                        className={cn(
                          "text-[13px] leading-snug text-foreground",
                          selected ? "line-clamp-6" : "line-clamp-2",
                        )}
                      >
                        {turn.reply}
                      </p>
                    </button>
                    {selected && (
                      <TurnTrace
                        turn={turn}
                        summary={summary}
                        loading={traceLoading}
                        resolved={resolved}
                        graphVisible={graphVisible}
                        revealId={revealId}
                        onReveal={setRevealId}
                        onOpenRow={onOpenRow}
                        payloads={payloads}
                        loadPayload={loadPayload}
                        activeAccess={activeAccess ?? null}
                        onViewPrompt={setPromptTarget}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
      {graphPane}
      <AuditPromptDialog
        sessionId={sessionId}
        target={promptTarget}
        onClose={() => setPromptTarget(null)}
      />
    </div>
  );
}

// ── Step trace ──────────────────────────────────────────────────────────

function TurnTrace({
  summary,
  loading,
  resolved,
  graphVisible,
  revealId,
  onReveal,
  onOpenRow,
  payloads,
  loadPayload,
  activeAccess,
  onViewPrompt,
}: {
  turn: AuditTurn;
  summary: TraceSummary | null | undefined;
  loading: boolean;
  resolved: Map<string, ResolvedRow>;
  graphVisible: { visibleIds: Set<string>; groupCounts: Record<string, number> };
  revealId: string | null;
  onReveal: (id: string | null) => void;
  onOpenRow: (row: BrainRow) => void;
  payloads: Record<string, PayloadState>;
  loadPayload: (hash: string) => void;
  activeAccess: GraphAccessStep | null;
  onViewPrompt: (target: AuditPromptTarget) => void;
}) {
  const t = useT();
  const copy = t.brainPage.audit;

  if (loading) {
    return (
      <div className="flex flex-col gap-2 px-4 pb-4" aria-busy="true">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-full rounded-md" />
        <Skeleton className="h-8 w-[88%] rounded-md" />
        <Skeleton className="h-8 w-[76%] rounded-md" />
      </div>
    );
  }
  if (summary === null || summary === undefined) {
    return (
      <p className="px-4 pb-4 text-xs text-muted-foreground">{copy.traceUnavailable}</p>
    );
  }

  const retrievedCount = summary.retrievedRows.length;
  // The header's Full prompt opens the turn's LAST model call: requests are
  // cumulative, so it holds everything earlier rounds sent too.
  const lastCall = [...summary.steps].reverse().find(
    (step) => step.kind === "provider_call" && step.prompt,
  );
  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4">
      {/* Header chips - the turn's shape at a glance. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(glassChip, summary.fidelity === "legacy" && "text-amber-700 dark:text-amber-400")}
          title={summary.fidelity === "legacy" ? copy.fidelityLegacyHint : undefined}
        >
          <ShieldCheck className="size-3" aria-hidden />
          {summary.fidelity === "full" ? copy.fidelityFull : copy.fidelityLegacy}
        </span>
        <span className={glassChip}>
          <Wrench className="size-3" aria-hidden />
          {summary.toolCalls === 1
            ? copy.summary.toolsOne
            : format(copy.summary.toolsMany, { count: summary.toolCalls })}
        </span>
        {summary.toolErrors > 0 && (
          <span className={cn(glassChip, "text-red-600 dark:text-red-400")}>
            <AlertTriangle className="size-3" aria-hidden />
            {format(copy.summary.failed, { count: summary.toolErrors })}
          </span>
        )}
        <span className={glassChip}>
          <Database className="size-3" aria-hidden />
          {retrievedCount === 1
            ? copy.summary.retrievedOne
            : format(copy.summary.retrievedMany, { count: retrievedCount })}
        </span>
        {summary.inputTokens + summary.outputTokens > 0 && (
          <span className={glassChip} title={summary.models.join(", ")}>
            <Cpu className="size-3" aria-hidden />
            {format(copy.summary.tokens, {
              input: formatTokens(summary.inputTokens),
              output: formatTokens(summary.outputTokens),
            })}
            {summary.usageApproximate ? ` (${copy.summary.approx})` : ""}
          </span>
        )}
        {summary.costUsd !== null && summary.costUsd > 0 && (
          <span className={glassChip}>
            {format(copy.summary.cost, { cost: summary.costUsd.toFixed(4) })}
          </span>
        )}
        {lastCall?.prompt && (
          <button
            type="button"
            onClick={() => onViewPrompt(promptTargetOf(lastCall))}
            className={cn(glassChip, "min-h-11 text-foreground hover:bg-muted md:min-h-0")}
          >
            <FileText className="size-3" aria-hidden />
            {copy.prompt.open}
          </button>
        )}
      </div>

      <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {copy.traceHeading}
      </h4>
      <ol className="relative flex flex-col gap-1 border-l border-border pl-3">
        {summary.steps.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            resolved={resolved}
            graphVisible={graphVisible}
            revealId={revealId}
            onReveal={onReveal}
            onOpenRow={onOpenRow}
            payloads={payloads}
            loadPayload={loadPayload}
            activeAccess={activeAccess}
            onViewPrompt={onViewPrompt}
          />
        ))}
      </ol>
      {summary.fidelity === "legacy" && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {copy.fidelityLegacyHint}
        </p>
      )}
    </div>
  );
}

function StepRow({
  step,
  resolved,
  graphVisible,
  revealId,
  onReveal,
  onOpenRow,
  payloads,
  loadPayload,
  activeAccess,
  onViewPrompt,
}: {
  step: AuditStepView;
  resolved: Map<string, ResolvedRow>;
  graphVisible: { visibleIds: Set<string>; groupCounts: Record<string, number> };
  revealId: string | null;
  onReveal: (id: string | null) => void;
  onOpenRow: (row: BrainRow) => void;
  payloads: Record<string, PayloadState>;
  loadPayload: (hash: string) => void;
  activeAccess: GraphAccessStep | null;
  onViewPrompt: (target: AuditPromptTarget) => void;
}) {
  const t = useT();
  const copy = t.brainPage.audit;
  const [open, setOpen] = useState(step.kind === "retrieval");
  // The replay is on this step right now (the graph is pulsing its entries).
  const replaying = activeAccess?.stepKey === step.key;
  const [showInput, setShowInput] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const Icon =
    step.kind === "retrieval"
      ? Search
      : step.kind === "provider_call"
        ? Cpu
        : step.kind === "tool_call"
          ? Wrench
          : step.kind === "response_text"
            ? MessageSquareText
            : step.kind === "usage_summary"
              ? Database
              : ShieldCheck;

  const title =
    step.kind === "tool_call"
      ? humanizeToolName(step.toolName ?? "tool")
      : step.kind === "retrieval"
        ? copy.steps.retrieval
        : step.kind === "provider_call"
          ? copy.steps.providerCall
          : step.kind === "response_text"
            ? copy.steps.responseText
            : step.kind === "usage_summary"
              ? copy.steps.usageSummary
              : step.kind === "confirmation"
                ? copy.steps.confirmation
                : step.kind === "approval"
                  ? copy.steps.approval
                  : step.kind === "mutation"
                    ? copy.steps.mutation
                    : copy.steps.other;

  const subtitle = (() => {
    switch (step.kind) {
      case "retrieval": {
        const n = step.rows?.length ?? 0;
        const src = sourceLabel(step.source, copy.steps.source);
        return `${src} · ${n === 1 ? copy.steps.rowsOne : format(copy.steps.rowsMany, { count: n })}`;
      }
      case "provider_call":
        return [
          step.model,
          step.turn !== undefined ? format(copy.steps.round, { turn: step.turn + 1 }) : null,
          (step.inputTokens ?? 0) + (step.outputTokens ?? 0) > 0
            ? format(copy.summary.tokens, {
                input: formatTokens(step.inputTokens ?? 0),
                output: formatTokens(step.outputTokens ?? 0),
              })
            : null,
          step.stopReason ? format(copy.steps.stopReason, { reason: step.stopReason }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "tool_call":
        return [
          step.toolName,
          step.isError ? copy.steps.failed : null,
          step.hasResult === false ? copy.steps.noResult : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "usage_summary":
        return `${format(copy.summary.tokens, {
          input: formatTokens(step.inputTokens ?? 0),
          output: formatTokens(step.outputTokens ?? 0),
        })}${step.approximate ? ` (${copy.summary.approx})` : ""}`;
      default:
        return "";
    }
  })();

  const expandable =
    step.kind === "retrieval" ||
    step.kind === "tool_call" ||
    step.kind === "response_text";

  const inputHash = step.payloadRefs[0];
  const resultHash = step.payloadRefs[1];

  return (
    <li className="relative">
      <span
        aria-hidden
        className={cn(
          "absolute -left-[17px] top-2 size-2 rounded-full border border-background",
          step.kind === "tool_call" && step.isError
            ? "bg-red-500"
            : step.kind === "retrieval" || replaying
              ? "bg-[var(--graph-highlight)]"
              : "bg-muted-foreground/50",
          replaying && "ring-2 ring-[var(--graph-highlight)]/40 motion-safe:animate-pulse",
        )}
      />
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
          expandable ? "hover:bg-muted/40" : "cursor-default",
          replaying && step.kind === "tool_call" && "bg-[var(--graph-highlight)]/10",
        )}
      >
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-foreground">{title}</span>
          {subtitle && (
            <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
          )}
        </span>
        {expandable &&
          (open ? (
            <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ))}
      </button>

      {open && step.kind === "retrieval" && (
        <RetrievedRows
          rows={step.rows ?? []}
          resolved={resolved}
          graphVisible={graphVisible}
          revealId={revealId}
          onReveal={onReveal}
          onOpenRow={onOpenRow}
          activeRowId={replaying ? activeAccess?.rowId ?? null : null}
        />
      )}

      {step.kind === "provider_call" && step.prompt && (
        <button
          type="button"
          onClick={() => onViewPrompt(promptTargetOf(step))}
          className="mx-1.5 mb-1 inline-flex min-h-11 items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline md:min-h-0"
        >
          <FileText className="size-3" aria-hidden />
          {copy.prompt.view}
        </button>
      )}

      {open && step.kind === "response_text" && step.text && (
        <p className="mx-1.5 mb-1 whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1.5 text-[12px] leading-relaxed text-foreground/90">
          {step.text.length > 1200 ? `${step.text.slice(0, 1200)}…` : step.text}
        </p>
      )}

      {open && step.kind === "tool_call" && (
        <div className="mx-1.5 mb-1 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            {(step.input !== undefined || inputHash) && (
              <button
                type="button"
                onClick={() => {
                  setShowInput((v) => !v);
                  if (!showInput && step.input === undefined && inputHash) loadPayload(inputHash);
                }}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showInput ? copy.steps.hideInput : copy.steps.showInput}
              </button>
            )}
            {(step.result !== undefined || resultHash) && (
              <button
                type="button"
                onClick={() => {
                  setShowResult((v) => !v);
                  if (!showResult && step.result === undefined && resultHash) loadPayload(resultHash);
                }}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showResult ? copy.steps.hideResult : copy.steps.showResult}
              </button>
            )}
          </div>
          {showInput && (
            <PayloadBlock
              inline={step.input !== undefined ? formatPayloadPreview(JSON.stringify(step.input)) : null}
              state={inputHash ? payloads[inputHash] : undefined}
            />
          )}
          {showResult && (
            <PayloadBlock
              inline={
                step.result === null
                  ? copy.steps.noResult
                  : step.result !== undefined
                    ? formatPayloadPreview(step.result)
                    : null
              }
              state={resultHash ? payloads[resultHash] : undefined}
            />
          )}
        </div>
      )}
    </li>
  );
}

function PayloadBlock({
  inline,
  state,
}: {
  inline: string | null;
  state: PayloadState | undefined;
}) {
  const t = useT();
  const copy = t.brainPage.audit.steps;
  let text: string;
  if (inline !== null) text = inline;
  else if (!state || state.status === "loading") text = copy.loadingPayload;
  else if (state.status === "erased") text = copy.erased;
  else if (state.status === "error") text = copy.payloadUnavailable;
  else text = state.text;
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/90">
      {text}
    </pre>
  );
}

function RetrievedRows({
  rows,
  resolved,
  graphVisible,
  revealId,
  onReveal,
  onOpenRow,
  activeRowId,
}: {
  rows: RetrievedRow[];
  resolved: Map<string, ResolvedRow>;
  graphVisible: { visibleIds: Set<string>; groupCounts: Record<string, number> };
  revealId: string | null;
  onReveal: (id: string | null) => void;
  onOpenRow: (row: BrainRow) => void;
  activeRowId: string | null;
}) {
  const t = useT();
  const copy = t.brainPage.audit.retrieved;
  if (rows.length === 0) {
    return <p className="mx-1.5 mb-1 text-[11px] text-muted-foreground">{copy.none}</p>;
  }
  return (
    <ul className="mx-1.5 mb-1 flex flex-col gap-0.5">
      {rows.map((row) => {
        const key = `${row.primitive}:${row.rowId}`;
        const res = resolved.get(key);
        const onGraph = graphVisible.visibleIds.has(row.rowId);
        const active = activeRowId === row.rowId;
        const kindLabel = copy.kinds[retrievedPrimitiveLabel(row.primitive)];
        return (
          <li
            key={key}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] transition-colors duration-300",
              active ? "bg-[var(--graph-highlight)]/12" : "hover:bg-muted/40",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                onGraph || active ? "bg-[var(--graph-highlight)]" : "bg-muted-foreground/30",
                active && "ring-2 ring-[var(--graph-highlight)]/40 motion-safe:animate-pulse",
              )}
            />
            <button
              type="button"
              disabled={!res}
              onClick={() => res && onOpenRow(res.row)}
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                res ? "text-foreground hover:underline" : "italic text-muted-foreground",
              )}
              title={res?.name}
            >
              {res === undefined ? (
                <Skeleton className="inline-block h-3 w-32 align-middle" />
              ) : res === null ? (
                copy.unresolved
              ) : (
                res.name
              )}
            </button>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {kindLabel}
            </span>
            {row.verdict && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[10px] font-medium",
                  row.verdict === "USED"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {row.verdict === "USED" ? copy.used : copy.unused}
              </span>
            )}
            {onGraph ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">{copy.onGraph}</span>
            ) : (
              <button
                type="button"
                onClick={() => onReveal(revealId === row.rowId ? null : row.rowId)}
                className={cn(
                  "shrink-0 rounded px-1.5 text-[10px] font-medium transition-colors",
                  revealId === row.rowId
                    ? "bg-[var(--graph-highlight)]/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={copy.offGraph}
              >
                {copy.reveal}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TurnsSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 border-b border-border/70 px-4 py-3">
          <Skeleton className="h-2.5 w-28" />
          <Skeleton className="h-3 w-[70%]" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-[86%]" />
        </div>
      ))}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function promptTargetOf(step: AuditStepView): AuditPromptTarget {
  return {
    prompt: step.prompt!,
    model: step.model,
    turn: step.turn,
    inputTokens: step.inputTokens,
  };
}

function sourceLabel(
  source: string | null | undefined,
  labels: { index_inject: string; memory_recall_events: string; nudge: string; tool_call: string; other: string },
): string {
  switch (source) {
    case "index_inject":
      return labels.index_inject;
    case "memory_recall_events":
      return labels.memory_recall_events;
    case "nudge":
      return labels.nudge;
    case "tool_call":
      return labels.tool_call;
    default:
      return labels.other;
  }
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Resolve one retrieved row to a name + drawer-ready BrainRow, clearance-scoped
 *  (a row above the viewer's clearance 404s and renders as unavailable). */
async function resolveRow(
  workspaceId: string,
  row: RetrievedRow,
  viewpointAssistantId: string | null,
  cacheScope: BrainContentCacheScope | null,
): Promise<ResolvedRow> {
  const label = retrievedPrimitiveLabel(row.primitive);
  try {
    if (label === "memory") {
      const detail = await fetchBrainRow(workspaceId, "memory", row.rowId, cacheScope);
      if (!detail) return null;
      const name = String(detail.body.summary ?? detail.body.detail ?? "").trim() || row.rowId;
      return {
        name,
        kind: "memories",
        row: { id: row.rowId, kind: "memories", name },
        node: graphNode(row.rowId, "memory", name, detail.body.sensitivity),
      };
    }
    if (label === "entity") {
      const detail = await fetchBrainRow(workspaceId, "entity", row.rowId, cacheScope);
      if (!detail) return null;
      const kind = String(detail.body.kind ?? "other");
      const mapped: BrainRow["kind"] =
        kind === "person" ||
        kind === "company" ||
        kind === "project" ||
        kind === "deal" ||
        kind === "product" ||
        kind === "repository"
          ? kind
          : "other";
      const name = String(detail.body.display_name ?? detail.body.name ?? row.rowId);
      return {
        name,
        kind: mapped,
        row: { id: row.rowId, kind: mapped, name },
        node: graphNode(row.rowId, mapped, name, detail.body.sensitivity),
      };
    }
    if (label === "knowledge") {
      const entry = await getKnowledgeEntry(row.rowId, workspaceId, viewpointAssistantId, cacheScope);
      if (!entry) return null;
      return {
        name: entry.title,
        kind: "knowledge",
        row: { id: entry.id, kind: "knowledge", name: entry.title },
        node: graphNode(entry.id, "knowledge", entry.title, entry.sensitivity),
      };
    }
    return null;
  } catch {
    return null;
  }
}

const SENSITIVITIES: readonly string[] = ["public", "internal", "confidential", "restricted"];

function graphNode(
  id: string,
  kind: BrainGraphNode["kind"],
  name: string,
  sensitivity: unknown,
): BrainGraphNode {
  return {
    id,
    kind,
    name,
    sensitivity: (typeof sensitivity === "string" && SENSITIVITIES.includes(sensitivity)
      ? sensitivity
      : "internal") as BrainGraphNode["sensitivity"],
    degree: 0,
  };
}
