/**
 * Turn audit - the pure view-model behind the Brain's Audit section
 * (`components/brain/audit-panel.tsx`).
 *
 * The chat-audit browser answers one question per assistant turn: "which
 * tools ran, which brain entries entered context, and what did it cost?"
 * The server already exposes the raw material (`GET
 * /api/sessions/:id/turns/:messageId/trace`, the epoch-routed turn ledger
 * read model); this module turns that raw trace plus the session transcript
 * into the shapes the panel renders, with no DOM and no fetch, so the
 * rules can be unit-tested:
 *
 *   - `buildAuditTurns` pairs every assistant row with the human prompt it
 *     answered (the nearest preceding user row) and pre-counts the tools it
 *     used, so the transcript rail can show a turn's shape before its trace
 *     loads.
 *   - `summarizeTrace` flattens a trace into per-step view rows plus the
 *     totals the header shows (tool calls, errors, tokens, cost, models) and
 *     the retrieval set (`retrievedRows`) - de-duplicated across steps.
 *   - `graphHighlightIds` derives the ids the brain graph should light up:
 *     every retrieved row id plus the brain row ids a tool call named in its
 *     input (`entityId`, `memoryId`, ...). Provenance is pointer-only, so
 *     the graph matches whatever ids it can and the panel lists the rest.
 *   - `parseAuditDeepLink` / `auditTurnUrl` - the `?audit=<sessionId>
 *     [&turn=<messageId>]` URL contract the chat surface links into.
 *
 * Spec: docs/architecture/features/chat-audit.md.
 * [COMP:app-web/turn-audit]
 */

import {
  extractMessageText,
  extractToolUses,
  type DocSessionMessage,
} from "@/lib/api/sessions";

// ── Wire types (mirror packages/api/src/ledger/turn-trace.ts) ──────────

type TurnTraceStep = {
  ordinal: number;
  kind: string;
  actor?: string;
  metadata: Record<string, unknown>;
  payloadRefs: string[];
  /** ISO timestamp; null on legacy steps (composed, not recorded). */
  at: string | null;
};

export type TurnTrace = {
  fidelity: "full" | "legacy";
  preEpoch: boolean | null;
  sessionId: string | null;
  steps: TurnTraceStep[];
};

// ── Transcript → turns ────────────────────────────────────────────────

export type AuditTurn = {
  /**
   * The assistant message id the trace is keyed by - the LAST assistant
   * row of the run (the chat route re-binds the ledger trace to each stored
   * assistant row in flush order, so the final one wins).
   */
  id: string;
  /** Every assistant row id in the run, in order; `id` is the last. */
  roundIds: string[];
  /** `roundIds.length` - the model rounds this reply took. */
  rounds: number;
  /** 1-based position among the session's turns. */
  index: number;
  /** ISO timestamp of the last assistant row. */
  at: string;
  /** The human prompt this turn answered (nearest preceding user row). */
  prompt: string | null;
  promptAt: string | null;
  /** The reply's plain text (the last non-empty text in the run). */
  reply: string;
  /** Tool names across the run, in call order, de-duplicated. */
  toolNames: string[];
  assistantId: string | null;
};

/** A user-role row that only carries tool results (the provider contract
 *  hands tool results back as user messages) - not a human prompt. */
function isToolResultRow(m: DocSessionMessage): boolean {
  return (
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every(
      (b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result",
    )
  );
}

/**
 * Group the transcript into turns: one turn per RUN of assistant rows
 * between human prompts. A multi-round reply persists one assistant row per
 * model round with tool-result user rows in between; those rows are one
 * answer to one prompt, and the ledger keys the whole run by its last row.
 * Tool/system rows are skipped. In a room a different answering assistant
 * starts a new run (two assistants, two turns). A leading run with no
 * preceding prompt (a greeting) has `prompt: null`.
 */
export function buildAuditTurns(messages: DocSessionMessage[]): AuditTurn[] {
  const turns: AuditTurn[] = [];
  let prompt: string | null = null;
  let promptAt: string | null = null;
  let run: {
    ids: string[];
    toolNames: string[];
    reply: string;
    at: string;
    assistantId: string | null;
    prompt: string | null;
    promptAt: string | null;
  } | null = null;
  const flush = () => {
    if (!run) return;
    turns.push({
      id: run.ids[run.ids.length - 1]!,
      roundIds: run.ids,
      rounds: run.ids.length,
      index: turns.length + 1,
      at: run.at,
      prompt: run.prompt,
      promptAt: run.promptAt,
      reply: run.reply,
      toolNames: run.toolNames,
      assistantId: run.assistantId,
    });
    run = null;
  };
  for (const m of messages) {
    if (m.role === "user") {
      // Tool results ride as user rows - the same run continues.
      if (isToolResultRow(m)) continue;
      flush();
      prompt = extractMessageText(m.content).trim() || null;
      promptAt = m.timestamp;
      continue;
    }
    if (m.role !== "assistant") continue;
    const assistantId = m.senderAssistantId ?? null;
    if (run && assistantId && run.assistantId && run.assistantId !== assistantId) flush();
    if (!run) {
      run = { ids: [], toolNames: [], reply: "", at: m.timestamp, assistantId, prompt, promptAt };
    }
    run.ids.push(m.id);
    run.at = m.timestamp;
    if (assistantId && !run.assistantId) run.assistantId = assistantId;
    for (const use of extractToolUses(m.content)) {
      if (!run.toolNames.includes(use.name)) run.toolNames.push(use.name);
    }
    const text = extractMessageText(m.content).trim();
    if (text) run.reply = text;
  }
  flush();
  return turns;
}

/** Newest first, without changing the chronological numbering or rounds. */
export function filterAuditTurns(turns: readonly AuditTurn[], query: string): AuditTurn[] {
  const needle = query.trim().toLowerCase();
  return turns.filter((turn) => !needle ||
    [turn.prompt ?? "", turn.reply, ...turn.toolNames].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  ).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.index - a.index);
}

/**
 * One trace for a multi-round turn. The ledger keys a post-epoch run by its
 * LAST row, so a `full` trace there already holds every round and is
 * returned as-is. A pre-epoch run has a per-row legacy composition instead:
 * concatenate the rounds' steps in order (ordinals renumbered), keeping only
 * the last round's `usage_summary` (each round's near-message window sums
 * the same rows). `null` when no round produced a trace.
 */
export function mergeTurnTraces(traces: Array<TurnTrace | null>): TurnTrace | null {
  const present = traces.filter((t): t is TurnTrace => t !== null);
  if (present.length === 0) return null;
  const last = present[present.length - 1]!;
  if (last.fidelity === "full") return last;
  if (present.length === 1) return last;
  const steps: TurnTraceStep[] = [];
  let usage: TurnTraceStep | null = null;
  for (const t of present) {
    for (const s of [...t.steps].sort((a, b) => a.ordinal - b.ordinal)) {
      if (s.kind === "usage_summary") {
        usage = s;
        continue;
      }
      steps.push({ ...s, ordinal: steps.length });
    }
  }
  if (usage) steps.push({ ...usage, ordinal: steps.length });
  return {
    fidelity: "legacy",
    preEpoch: last.preEpoch,
    sessionId: last.sessionId ?? present[0]!.sessionId,
    steps,
  };
}

// ── Trace → summary ───────────────────────────────────────────────────

export type RetrievedRow = {
  primitive: string;
  rowId: string;
  /** Which seam produced it (`index_inject`, `memory_recall_events`, ...). */
  source: string | null;
  verdict: "USED" | "UNUSED" | null;
};

type AuditStepKind =
  | "retrieval"
  | "provider_call"
  | "tool_call"
  | "response_text"
  | "usage_summary"
  | "confirmation"
  | "approval"
  | "mutation"
  | "other";

export type AuditStepView = {
  key: string;
  ordinal: number;
  kind: AuditStepKind;
  at: string | null;
  /** Tool steps. */
  toolName?: string;
  isError?: boolean;
  hasResult?: boolean;
  /** Legacy tool steps carry the input/result inline; full-fidelity steps
   *  carry payload refs (`payloadRefs[0]` = input, `[1]` = result). */
  input?: unknown;
  result?: string | null;
  /** Provider-call steps. */
  model?: string;
  /** The exact request a full-fidelity model call put on the wire, as
   *  payload refs: the system prompt (when one was sent), every message in
   *  order, and the response. Absent on legacy traces. */
  prompt?: ProviderPromptRefs;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  turn?: number;
  /** Retrieval steps. */
  rows?: RetrievedRow[];
  source?: string | null;
  /** Legacy response text. */
  text?: string;
  /** Legacy usage summary. */
  calls?: number;
  costUsd?: number;
  approximate?: boolean;
  payloadRefs: string[];
};

export type ProviderPromptRefs = {
  systemRef: string | null;
  messageRefs: string[];
  responseRef: string | null;
};

/**
 * Split a `provider_call` event's refs (`[system?, ...messages, response]`,
 * engine/turn-ledger.md) using its `messageCount`. Without the count the
 * system prompt cannot be told from the first message, so every ref but the
 * response is treated as a message.
 */
export function providerPromptRefs(
  refs: readonly string[],
  messageCount: number | undefined,
): ProviderPromptRefs | undefined {
  if (refs.length === 0) return undefined;
  const responseRef = refs.at(-1) ?? null;
  const body = refs.slice(0, -1);
  const hasSystem = messageCount !== undefined && body.length === messageCount + 1;
  return {
    systemRef: hasSystem ? body[0]! : null,
    messageRefs: hasSystem ? body.slice(1) : body,
    responseRef,
  };
}

export type TraceSummary = {
  fidelity: "full" | "legacy";
  preEpoch: boolean | null;
  steps: AuditStepView[];
  toolCalls: number;
  toolErrors: number;
  providerCalls: number;
  retrievedRows: RetrievedRow[];
  inputTokens: number;
  outputTokens: number;
  /** Null when the trace carries no cost (full-fidelity traces do not). */
  costUsd: number | null;
  usageApproximate: boolean;
  models: string[];
};

const KNOWN_KINDS: ReadonlySet<AuditStepKind> = new Set([
  "retrieval",
  "provider_call",
  "tool_call",
  "response_text",
  "usage_summary",
  "confirmation",
  "approval",
  "mutation",
]);

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Provider usage arrives in whichever casing the provider used. */
export function usageTokens(usage: unknown): { input: number; output: number } {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0 };
  const u = usage as Record<string, unknown>;
  const input =
    asNumber(u.inputTokens) ?? asNumber(u.input_tokens) ?? asNumber(u.promptTokens) ?? 0;
  const output =
    asNumber(u.outputTokens) ??
    asNumber(u.output_tokens) ??
    asNumber(u.completionTokens) ??
    0;
  return { input, output };
}

function parseRows(
  metadata: Record<string, unknown>,
): { rows: RetrievedRow[]; source: string | null } {
  const source = asString(metadata.source) ?? null;
  const verdicts =
    metadata.nudgeVerdict && typeof metadata.nudgeVerdict === "object"
      ? (metadata.nudgeVerdict as Record<string, unknown>)
      : {};
  const raw = Array.isArray(metadata.returnedRows) ? metadata.returnedRows : [];
  // One row per entry, in first-retrieved order: a seam that injected the
  // same memory twice (two index passes in one turn) is one access, not two.
  const rows = new Map<string, RetrievedRow>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const rowId = asString(row.rowId) ?? asString(row.row_id);
    if (!rowId) continue;
    const primitive = asString(row.primitive) ?? "other";
    const key = `${primitive}:${rowId}`;
    if (rows.has(key)) continue;
    const verdict = verdicts[rowId];
    rows.set(key, {
      primitive,
      rowId,
      source,
      verdict: verdict === "USED" || verdict === "UNUSED" ? verdict : null,
    });
  }
  return { rows: [...rows.values()], source };
}

export function summarizeTrace(trace: TurnTrace): TraceSummary {
  const steps: AuditStepView[] = [];
  const retrieved = new Map<string, RetrievedRow>();
  const models: string[] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let providerCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let usageApproximate = false;

  const ordered = [...trace.steps].sort((a, b) => a.ordinal - b.ordinal);
  for (const step of ordered) {
    const kind: AuditStepKind = KNOWN_KINDS.has(step.kind as AuditStepKind)
      ? (step.kind as AuditStepKind)
      : "other";
    const m = step.metadata ?? {};
    const view: AuditStepView = {
      key: `${step.ordinal}:${kind}`,
      ordinal: step.ordinal,
      kind,
      at: step.at,
      payloadRefs: step.payloadRefs ?? [],
    };
    switch (kind) {
      case "retrieval": {
        const { rows, source } = parseRows(m);
        view.rows = rows;
        view.source = source;
        for (const row of rows) {
          const key = `${row.primitive}:${row.rowId}`;
          const prev = retrieved.get(key);
          // A USED verdict from any step wins over an absent one.
          if (!prev || (prev.verdict === null && row.verdict !== null)) {
            retrieved.set(key, row);
          }
        }
        break;
      }
      case "provider_call": {
        providerCalls += 1;
        view.model = asString(m.model);
        view.stopReason = asString(m.stopReason);
        view.turn = asNumber(m.turn);
        view.prompt = providerPromptRefs(view.payloadRefs, asNumber(m.messageCount));
        const tokens = usageTokens(m.usage);
        view.inputTokens = tokens.input;
        view.outputTokens = tokens.output;
        inputTokens += tokens.input;
        outputTokens += tokens.output;
        if (view.model && !models.includes(view.model)) models.push(view.model);
        break;
      }
      case "tool_call": {
        toolCalls += 1;
        view.toolName = asString(m.name) ?? "tool";
        view.isError = m.isError === true;
        if (view.isError) toolErrors += 1;
        view.hasResult =
          m.hasResult === true || (m.result !== undefined && m.result !== null);
        view.turn = asNumber(m.turn);
        if (m.input !== undefined) view.input = m.input;
        if (typeof m.result === "string") view.result = m.result;
        else if (m.result === null) view.result = null;
        break;
      }
      case "response_text":
        view.text = asString(m.text) ?? "";
        break;
      case "usage_summary": {
        view.calls = asNumber(m.calls);
        view.inputTokens = asNumber(m.inputTokens) ?? 0;
        view.outputTokens = asNumber(m.outputTokens) ?? 0;
        view.costUsd = asNumber(m.costUsd);
        view.approximate = m.approximate === true;
        inputTokens += view.inputTokens;
        outputTokens += view.outputTokens;
        if (view.costUsd !== undefined) costUsd = (costUsd ?? 0) + view.costUsd;
        if (view.approximate) usageApproximate = true;
        break;
      }
      default:
        break;
    }
    steps.push(view);
  }

  return {
    fidelity: trace.fidelity,
    preEpoch: trace.preEpoch,
    steps,
    toolCalls,
    toolErrors,
    providerCalls,
    retrievedRows: [...retrieved.values()],
    inputTokens,
    outputTokens,
    costUsd,
    usageApproximate,
    models,
  };
}

// ── Graph highlight ───────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tool-input keys that name a brain row. Kept narrow on purpose: a free
 *  `id` on an unrelated tool (a Slack channel id, a file id) must not
 *  light up a random graph node that happens to share the value. */
const ROW_ID_KEYS: readonly string[] = [
  // The retrieval layer's canonical keys (`getEntity` takes `id_or_name`;
  // `provenance` / `markUseful` / `getRowHistory` take `row_id`). Only a
  // UUID-shaped value counts here; a name under `id_or_name` rides the
  // name highlight instead (`graphHighlightNames`).
  "row_id",
  "rowId",
  "id_or_name",
  "idOrName",
  "entityId",
  "entity_id",
  "memoryId",
  "memory_id",
  "knowledgeId",
  "knowledge_id",
  "targetEntityId",
  "sourceEntityId",
  "contactId",
  "companyId",
  "dealId",
  "skillRowId",
];

/**
 * Ids the graph should spotlight for a turn: every retrieved row plus the
 * brain rows a tool named in its input. Order = first appearance.
 */
export function graphHighlightIds(
  summary: Pick<TraceSummary, "retrievedRows" | "steps">,
): string[] {
  const out: string[] = [];
  const push = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const row of summary.retrievedRows) push(row.rowId);
  for (const step of summary.steps) {
    if (step.kind !== "tool_call" || !step.input || typeof step.input !== "object") continue;
    const input = step.input as Record<string, unknown>;
    for (const key of ROW_ID_KEYS) {
      const value = input[key];
      if (typeof value === "string" && UUID_RE.test(value)) push(value);
      if (Array.isArray(value)) {
        for (const v of value) if (typeof v === "string" && UUID_RE.test(v)) push(v);
      }
    }
  }
  return out;
}

/**
 * Tools whose INPUT names a brain row (`getEntity`, `getMemory`,
 * `updateContact`, …). On a full-fidelity trace inputs live behind payload
 * hashes, so the panel dereferences these eagerly (bounded by
 * `EAGER_TOOL_INPUT_CAP`) to light their rows on the graph without the
 * reviewer expanding every call. Search-style tools carry a query, not ids,
 * and stay lazy.
 */
const BRAIN_ROW_TOOL_RE =
  /^(get|update|save|delete|read|adjust|link|unlink|merge|verify)(Entity|Memory|Contact|Company|Deal|KnowledgeEntry|Task|Skill)\b/i;

export function isBrainRowTool(name: string | undefined): boolean {
  return typeof name === "string" && BRAIN_ROW_TOOL_RE.test(name);
}

const EAGER_TOOL_INPUT_CAP = 20;

/** The hashes to dereference eagerly for a summary: brain-row tool calls
 *  whose input is not inline yet, in step order, capped. */
export function eagerToolInputRefs(
  summary: Pick<TraceSummary, "steps">,
): Array<{ key: string; hash: string }> {
  const out: Array<{ key: string; hash: string }> = [];
  for (const step of summary.steps) {
    if (step.kind !== "tool_call" || step.input !== undefined) continue;
    if (!isBrainRowTool(step.toolName)) continue;
    const hash = step.payloadRefs[0];
    if (!hash) continue;
    out.push({ key: step.key, hash });
    if (out.length >= EAGER_TOOL_INPUT_CAP) break;
  }
  return out;
}

/** Fill dereferenced inputs into a summary's steps (missing ones only). */
export function withToolInputs(
  summary: TraceSummary,
  inputs: Record<string, unknown>,
): TraceSummary {
  if (Object.keys(inputs).length === 0) return summary;
  return {
    ...summary,
    steps: summary.steps.map((step) =>
      step.kind === "tool_call" && step.input === undefined && step.key in inputs
        ? { ...step, input: inputs[step.key] }
        : step,
    ),
  };
}

/** Tool-input keys under which a brain-row tool names its target by NAME
 *  (`getEntity({ id_or_name: "Acme" })`). Never search queries. */
const ROW_NAME_KEYS: readonly string[] = [
  "id_or_name",
  "idOrName",
  "name",
  "entityName",
  "displayName",
];

const HIGHLIGHT_NAME_CAP = 20;

/**
 * Entry NAMES a turn's brain-row tool calls looked up (lower-cased,
 * trimmed, de-duplicated, capped). A name is not a pointer - two entries
 * may share one - so the graph matches these client-side against the
 * projection it already holds (no server reveal, no counts) and lights
 * whatever carries that name. Complements `graphHighlightIds` for the
 * common case where the model addressed an entity by name.
 */
export function graphHighlightNames(summary: Pick<TraceSummary, "steps">): string[] {
  const out: string[] = [];
  for (const step of summary.steps) {
    if (step.kind !== "tool_call" || !isBrainRowTool(step.toolName)) continue;
    if (!step.input || typeof step.input !== "object") continue;
    const input = step.input as Record<string, unknown>;
    for (const key of ROW_NAME_KEYS) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const name = value.trim().toLowerCase();
      if (!name || UUID_RE.test(name) || out.includes(name)) continue;
      out.push(name);
      if (out.length >= HIGHLIGHT_NAME_CAP) return out;
    }
  }
  return out;
}

export type GraphAccessStep = {
  key: string;
  /** The trace step this access belongs to (`AuditStepView.key`). */
  stepKey: string;
  kind: "retrieval" | "tool_call";
  toolName?: string;
  /** Retrieval accesses: the one entry this access lit, so the trace list
   *  can mark the same row the graph is pulsing. */
  rowId?: string;
  ids: string[];
  names: string[];
};

export const AUDIT_ACCESS_STEP_MS = 1400;

/**
 * Recorded accesses only, in execution order. Never infer a graph path.
 * A retrieval step is replayed one entry at a time in the order it returned
 * them; a brain-row tool call is one access.
 */
export function graphAccessSteps(summary: Pick<TraceSummary, "steps">): GraphAccessStep[] {
  return [...summary.steps].sort((a, b) => a.ordinal - b.ordinal).flatMap((step): GraphAccessStep[] => {
    if (step.kind === "retrieval") {
      return (step.rows ?? []).map((row) => ({
        key: `${step.key}:${row.primitive}:${row.rowId}`,
        stepKey: step.key,
        kind: "retrieval" as const,
        rowId: row.rowId,
        ids: [row.rowId],
        names: [],
      }));
    }
    if (!(step.kind === "tool_call" && isBrainRowTool(step.toolName))) return [];
    const scoped = { steps: [step], retrievedRows: [] };
    const ids = graphHighlightIds(scoped);
    const names = graphHighlightNames(scoped);
    if (ids.length === 0 && names.length === 0) return [];
    return [{ key: step.key, stepKey: step.key, kind: "tool_call" as const,
      toolName: step.toolName, ids, names }];
  });
}

// ── Raw prompt ──────────────────────────────────────────────────────

export type PromptMessageView = {
  role: "user" | "assistant" | "system" | "other";
  text: string;
};

/**
 * Render one recorded request message (`JSON.stringify(Message)`, the
 * recorder's message payload) as readable text: text blocks verbatim, tool
 * calls and results labelled with their JSON, media as a placeholder. A
 * payload that is not a message JSON is shown as-is, never dropped.
 */
export function formatPromptMessage(raw: string): PromptMessageView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { role: "other", text: raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { role: "other", text: raw };
  }
  const message = parsed as Record<string, unknown>;
  const role =
    message.role === "user" || message.role === "assistant" || message.role === "system"
      ? message.role
      : "other";
  return { role, text: formatPromptContent(message.content) };
}

/** The response ref holds the content-block array, not a whole message. */
export function formatPromptResponse(raw: string): PromptMessageView {
  try {
    return { role: "assistant", text: formatPromptContent(JSON.parse(raw) as unknown) };
  } catch {
    return { role: "assistant", text: raw };
  }
}

function formatPromptContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null, null, 2);
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return String(block);
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "text":
          return typeof b.text === "string" ? b.text : "";
        case "tool_use":
          return `[tool call: ${asString(b.name) ?? "tool"}]\n${JSON.stringify(b.input ?? {}, null, 2)}`;
        case "tool_result":
          return `[tool result${b.isError === true || b.is_error === true ? ", error" : ""}]\n${formatPromptContent(b.content)}`;
        case "image":
        case "document":
        case "file":
          return `[${b.type}]`;
        default:
          return JSON.stringify(b, null, 2);
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

// ── Presentation helpers ──────────────────────────────────────────────

/** `searchBrain` -> "Search brain"; `shopify_list_products` -> "Shopify list products". */
export function humanizeToolName(name: string): string {
  const spaced = name
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.length === 0 ? name : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/** A retrieved row's primitive folded to the labels the panel has copy for. */
export type RetrievedPrimitiveLabel =
  | "memory"
  | "entity"
  | "knowledge"
  | "file"
  | "episode"
  | "other";

export function retrievedPrimitiveLabel(primitive: string): RetrievedPrimitiveLabel {
  switch (primitive) {
    case "memory":
    case "memories":
      return "memory";
    case "entity":
    case "person":
    case "company":
    case "project":
    case "deal":
    case "product":
    case "repository":
    case "contact":
      return "entity";
    case "knowledge":
    case "knowledge_entry":
      return "knowledge";
    case "kb_chunk":
    case "file":
    case "file_segment":
    case "workspace_file":
      return "file";
    case "episode":
      return "episode";
    default:
      return "other";
  }
}

/** Pretty-print a JSON payload (or leave non-JSON text alone), bounded. */
export function formatPayloadPreview(text: string, maxChars = 4000): string {
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON - show as-is
  }
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

/** Compact "12.3k" token formatting for the header chips. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Deep link ─────────────────────────────────────────────────────────

const AUDIT_SESSION_PARAM = "audit";
const AUDIT_TURN_PARAM = "turn";

export type AuditDeepLink = { sessionId: string; turnId: string | null };

export function parseAuditDeepLink(params: URLSearchParams): AuditDeepLink | null {
  const sessionId = params.get(AUDIT_SESSION_PARAM)?.trim();
  if (!sessionId) return null;
  const turnId = params.get(AUDIT_TURN_PARAM)?.trim();
  return { sessionId, turnId: turnId && turnId.length > 0 ? turnId : null };
}

/** `/w/<ws>/brain?audit=<sessionId>[&turn=<messageId>]` - "" origin = relative. */
export function auditTurnUrl(
  origin: string,
  workspaceId: string,
  sessionId: string,
  turnId?: string | null,
): string {
  const q = new URLSearchParams({ [AUDIT_SESSION_PARAM]: sessionId });
  if (turnId) q.set(AUDIT_TURN_PARAM, turnId);
  return `${origin}/w/${workspaceId}/brain?${q.toString()}`;
}
