/**
 * Turn trace — the audit API's read model (plan §9, §3).
 *
 * `getTurnTrace(assistantMessageId)` resolves the epoch cut:
 *
 *  - **`fidelity: 'full'`** — the turn has `turn_events` rows (post-epoch
 *    lanes): every step in ordinal order, pointer-only (payload hashes
 *    resolve through the member-gated payload route, never inline).
 *  - **`fidelity: 'legacy'`** — no trace exists (pre-epoch turns, and any
 *    turn recorded before its lane was wired): a best-effort composition
 *    from what already exists — the persisted `session_messages` content
 *    (tool traces ride inside it), the `memory_recall_events` rows the
 *    message id threads (folded into one leading `retrieval` step - the
 *    only per-turn provenance older history has), plus a cost summary
 *    from `usage_tracking` near the message. No as-of, no payloads. That
 *    is the accepted, PERMANENT state of pre-epoch history — nothing here
 *    is ever backfilled (D6).
 *
 * Deleting the legacy branch is the whole cleanup if the product ever
 * stops caring about pre-epoch turns.
 *
 * Spec: docs/architecture/engine/turn-ledger.md → "The audit read model"
 * [COMP:api/turn-trace]
 */

import { query } from '../db/client.js'
import { parseHostObservation } from '@use-brian/shared'
import { getLedgerEpoch, listTraceEvents } from '../db/turn-ledger-store.js'

export type TurnTraceStep = {
  ordinal: number
  kind: string
  actor?: string
  metadata: Record<string, unknown>
  payloadRefs?: string[]
  at: Date | null
}

export type TurnTraceResult = {
  fidelity: 'full' | 'legacy'
  /** True when the turn predates the ledger epoch (null when unknowable). */
  preEpoch: boolean | null
  sessionId: string | null
  steps: TurnTraceStep[]
}

export type LegacyMessageRow = {
  id: string
  sessionId: string
  role: string
  content: unknown
  createdAt: Date
}

/** A pre-epoch memory recall (migration 167) - the one provenance record
 *  that predates the ledger, keyed by the same assistant message id. */
export type LegacyRecallRow = {
  memoryId: string
  recallKind: string
  createdAt: Date
}

export type TurnTraceDeps = {
  listTraceEvents: typeof listTraceEvents
  getLedgerEpoch: typeof getLedgerEpoch
  loadMessage: (assistantMessageId: string) => Promise<LegacyMessageRow | null>
  loadUsageNear: (sessionId: string, at: Date) => Promise<{ calls: number; inputTokens: number; outputTokens: number; costUsd: number } | null>
  /**
   * Memory provenance for a pre-epoch turn: `memory_recall_events` rows
   * attached to the assistant message. The legacy composition folds them
   * into ONE leading `retrieval` step (source `memory_recall_events`) so a
   * pre-epoch turn still lights up the memories it was answered from -
   * that table is the only per-turn provenance older history has.
   */
  loadLegacyRecalls: (assistantMessageId: string) => Promise<LegacyRecallRow[]>
}

async function defaultLoadMessage(assistantMessageId: string): Promise<LegacyMessageRow | null> {
  const res = await query(
    `SELECT id, session_id, role, content, created_at FROM session_messages WHERE id = $1`,
    [assistantMessageId],
  )
  const r = res.rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    role: r.role as string,
    content: r.content,
    createdAt: r.created_at as Date,
  }
}

async function defaultLoadUsageNear(
  sessionId: string,
  at: Date,
): Promise<{ calls: number; inputTokens: number; outputTokens: number; costUsd: number } | null> {
  const res = await query(
    `SELECT count(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS in_tok,
            COALESCE(SUM(output_tokens), 0) AS out_tok,
            COALESCE(SUM(actual_cost_usd), 0) AS cost
       FROM usage_tracking
      WHERE session_id = $1
        AND created_at BETWEEN $2::timestamptz - interval '30 minutes' AND $2::timestamptz + interval '1 minute'`,
    [sessionId, at],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))
  const r = res.rows[0]
  if (!r) return null
  return {
    calls: Number(r.calls ?? 0),
    inputTokens: Number(r.in_tok ?? 0),
    outputTokens: Number(r.out_tok ?? 0),
    costUsd: Number(r.cost ?? 0),
  }
}

async function defaultLoadLegacyRecalls(assistantMessageId: string): Promise<LegacyRecallRow[]> {
  const res = await query(
    `SELECT memory_id, recall_kind, created_at
       FROM memory_recall_events
      WHERE assistant_message_id = $1
      ORDER BY created_at ASC, memory_id ASC
      LIMIT 200`,
    [assistantMessageId],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))
  return res.rows.map((r) => ({
    memoryId: String(r.memory_id),
    recallKind: String(r.recall_kind ?? 'index_inject'),
    createdAt: r.created_at as Date,
  }))
}

/**
 * Fold pre-epoch memory recalls into one `retrieval` step in the Phase 0
 * provenance shape (`returnedRows` + `source`), de-duplicated by memory id
 * with the recall kinds preserved per row. Returns null when there is
 * nothing to fold, so the caller adds no empty step.
 */
export function legacyRetrievalStep(recalls: LegacyRecallRow[]): TurnTraceStep | null {
  if (recalls.length === 0) return null
  const kinds = new Map<string, Set<string>>()
  let earliest: Date | null = null
  for (const r of recalls) {
    const set = kinds.get(r.memoryId) ?? new Set<string>()
    set.add(r.recallKind)
    kinds.set(r.memoryId, set)
    if (r.createdAt instanceof Date && (!earliest || r.createdAt < earliest)) earliest = r.createdAt
  }
  return {
    ordinal: 0,
    kind: 'retrieval',
    metadata: {
      returnedRows: [...kinds.keys()].map((rowId) => ({ primitive: 'memory', rowId })),
      recallKinds: Object.fromEntries([...kinds].map(([id, set]) => [id, [...set].sort()])),
      source: 'memory_recall_events',
    },
    at: earliest,
  }
}

/** Compose legacy steps from a persisted assistant message's content blocks. */
export function legacyStepsFromContent(content: unknown): TurnTraceStep[] {
  const blocks = Array.isArray(content) ? content : []
  const steps: TurnTraceStep[] = []
  const resultsById = new Map<string, Record<string, unknown>>()
  for (const b of blocks) {
    const block = b as Record<string, unknown>
    if (block.type === 'tool_result') resultsById.set(String(block.toolUseId), block)
  }
  let ordinal = 0
  for (const b of blocks) {
    const block = b as Record<string, unknown>
    const observation = parseHostObservation(block)
    if (observation) {
      steps.push({ ordinal: ordinal++, kind: 'tool_call', at: null,
        metadata: { origin: 'host', name: observation.name, toolUseId: observation.id,
          input: observation.input, result: observation.content, isError: observation.isError } })
      continue
    }
    if (block.type === 'text') {
      steps.push({
        ordinal: ordinal++,
        kind: 'response_text',
        metadata: { text: String(block.text ?? '') },
        at: null,
      })
    } else if (block.type === 'tool_use') {
      const result = resultsById.get(String(block.id))
      steps.push({
        ordinal: ordinal++,
        kind: 'tool_call',
        metadata: {
          name: String(block.name ?? ''),
          toolUseId: String(block.id ?? ''),
          input: block.input ?? {},
          ...(result ? { result: result.content, isError: result.isError === true } : { result: null }),
        },
        at: null,
      })
    }
  }
  return steps
}

export function createTurnTraceReader(overrides: Partial<TurnTraceDeps> = {}) {
  const deps: TurnTraceDeps = {
    listTraceEvents,
    getLedgerEpoch,
    loadMessage: defaultLoadMessage,
    loadUsageNear: defaultLoadUsageNear,
    loadLegacyRecalls: defaultLoadLegacyRecalls,
    ...overrides,
  }

  return async function getTurnTrace(assistantMessageId: string): Promise<TurnTraceResult | null> {
    const events = await deps.listTraceEvents(assistantMessageId)
    if (events.length > 0) {
      const epoch = await deps.getLedgerEpoch()
      return {
        fidelity: 'full',
        preEpoch: epoch ? events[0].createdAt < epoch : null,
        sessionId: events[0].sessionId,
        steps: events.map((e) => ({
          ordinal: e.stepOrdinal,
          kind: e.kind,
          actor: e.actor,
          metadata: e.metadata,
          payloadRefs: e.payloadRefs,
          at: e.createdAt,
        })),
      }
    }

    const message = await deps.loadMessage(assistantMessageId)
    if (!message || message.role !== 'assistant') return null
    const epoch = await deps.getLedgerEpoch()
    const [recalls, usage] = await Promise.all([
      deps.loadLegacyRecalls(assistantMessageId).catch(() => [] as LegacyRecallRow[]),
      deps.loadUsageNear(message.sessionId, message.createdAt),
    ])
    const recallStep = legacyRetrievalStep(recalls)
    const contentSteps = legacyStepsFromContent(message.content)
    // The recall step leads (context assembly runs before the model speaks);
    // content-derived steps renumber after it.
    const steps: TurnTraceStep[] = recallStep
      ? [recallStep, ...contentSteps.map((s) => ({ ...s, ordinal: s.ordinal + 1 }))]
      : contentSteps
    if (usage && usage.calls > 0) {
      steps.push({
        ordinal: steps.length,
        kind: 'usage_summary',
        metadata: { ...usage, approximate: true },
        at: null,
      })
    }
    return {
      fidelity: 'legacy',
      preEpoch: epoch ? message.createdAt < epoch : null,
      sessionId: message.sessionId,
      steps,
    }
  }
}

export const getTurnTrace = createTurnTraceReader()
