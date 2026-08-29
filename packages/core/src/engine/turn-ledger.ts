/**
 * Turn ledger — the engine-side recording contract for the append-only
 * turn substrate (turn_events / turn_payloads).
 *
 * `queryLoop` REQUIRES a `TurnLedger` (compile-enforced, deliberately not
 * optional: an optional param hand-threaded across ~a dozen call sites is
 * the channel-custom-llm-wiring failure shape — every closed or late call
 * site forgets it, both editions typecheck, and the only record of the
 * truth is what never got written). Lanes with nothing to persist (smoke,
 * eval fixtures) pass `NOOP_TURN_LEDGER`; a graded check
 * (`invariants/turn-ledger-lane-coverage`) keeps the no-op out of
 * production lanes.
 *
 * The recorder is a CONSUMER of the loop, not surgery on it: the loop
 * reports three facts per invocation — the trace start (system prompt +
 * initial messages), each turn's provider request (full history in
 * stateless mode, the delta in stateful mode), and each completed turn
 * (assistant response + executed tool results, the Phase 3b pairing where
 * tool inputs and outputs are already matched). Everything else
 * (hashing, payload storage, step ordinals, DB writes) lives behind this
 * interface in `@use-brian/api`'s recorder implementation.
 *
 * Every method is fire-and-forget and MUST NOT throw — the loop wraps
 * calls defensively, but implementations own their error handling
 * (log-and-continue). A ledger failure must never fail a user's turn.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 * [COMP:engine/turn-ledger]
 */

import type { AssistantResponse, ContentBlock, Message } from '../providers/types.js'

/** Who is driving this trace — the plan §4 actor vocabulary. */
export type TurnLedgerActor =
  | 'assistant_turn'
  | 'consolidation_run'
  | 'human_edit'
  | 'workflow_step'
  | 'a2a'

/**
 * Retrieval provenance for one step — the chat-auditing Phase 0 shape,
 * generalizing the `memory_recall_events` pattern. Pointer-only by design:
 * over an immutable substrate, row id + trace timestamp dereferences to
 * exact historical content (plan §4-§5).
 */
export type TurnRetrievalProvenance = {
  returnedRows: Array<{ primitive: string; rowId: string }>
  walkedEdges?: string[]
  nudgeVerdict?: Record<string, 'USED' | 'UNUSED'>
  /** Which seam produced this set (e.g. 'index_inject', 'tool_call'). */
  source?: string
}

export type TurnTraceStart = {
  actor: TurnLedgerActor
  model: string
  systemPrompt: string
  messages: Message[]
  /**
   * The persisted assistant message id when the lane has one (interactive
   * chat). Lanes without a persisted assistant row (workers, synthesis)
   * omit it and the recorder mints a UUID trace id instead.
   */
  assistantMessageId?: string
}

/** One queryLoop invocation's recording handle. */
export interface TurnTrace {
  /** The `assistant_message_id` key this trace writes under. */
  readonly traceId: string
  /**
   * Provider request for `turn`. `full` means `messages` is the complete
   * history (stateless mode); otherwise it is the delta appended since the
   * previous turn (stateful session mode) and the recorder reconstructs
   * the full request as start.messages + all deltas.
   */
  request(info: { turn: number; messages: Message[]; full: boolean }): void
  /**
   * Completed turn: the assistant response and its matched tool results
   * (the loop's Phase 3b pairing — inputs ride in the response's
   * `tool_use` blocks, outputs in `toolResults`).
   */
  turn(info: { turn: number; response: AssistantResponse; toolResults: ContentBlock[] }): void
  /** Retrieval provenance — called by the context-assembly / search seams. */
  retrieval(info: TurnRetrievalProvenance): void
  /** Confirmation / approval markers. */
  event(kind: 'confirmation' | 'approval', metadata: Record<string, unknown>): void
}

/**
 * Trace factory handed to `queryLoop`. One `startTrace` per loop
 * invocation; nested loops (workers, the doc edit-agent) receive the same
 * ledger and start child traces with their own minted ids.
 */
export interface TurnLedger {
  startTrace(info: TurnTraceStart): TurnTrace
}

const noopTrace: TurnTrace = {
  traceId: 'noop',
  request: () => {},
  turn: () => {},
  retrieval: () => {},
  event: () => {},
}

/**
 * The no-recording ledger. ONLY for lanes with nothing to persist —
 * `pnpm smoke`, eval fixtures, unit tests. Passing it from a production
 * lane silently discards that lane's history; graded by
 * `invariants/turn-ledger-lane-coverage`.
 */
export const NOOP_TURN_LEDGER: TurnLedger = {
  startTrace: () => noopTrace,
}

/** Defensive wrapper — a recorder bug must never break the loop. */
export function safeTrace(trace: TurnTrace, op: (t: TurnTrace) => void): void {
  try {
    op(trace)
  } catch (err) {
    console.warn(
      `[turn-ledger] recorder threw (ignored): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
