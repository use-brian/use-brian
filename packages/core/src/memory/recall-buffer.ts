/**
 * Per-turn memory-recall buffer.
 *
 * Recall events for a turn (which memories landed in the index, which
 * the model fetched via `getMemory`) arrive *before* the assistant
 * message commits to the session — when we don't yet have an
 * `assistant_message_id` to anchor them on. Naively writing recalls
 * during the turn forces a second UPDATE pass once the message lands,
 * and means a partial row sits in the DB if the turn errors out.
 *
 * The buffer keeps recalls in memory until either:
 *
 *   1. `flush()` is called with the freshly-saved `assistantMessageId`,
 *      at which point all queued recalls are batch-inserted with the id
 *      already attached. This is the happy path.
 *
 *   2. `discard()` is called if the turn errored before the message was
 *      saved. No DB writes happen, the buffer empties.
 *
 * Recall sources partition by `recallKind`:
 *
 *   - `'index_inject'` — memory landed in the per-turn memory index
 *     built at turn start. High volume (10-40 ids per turn). Recorded
 *     once at the top of the turn.
 *
 *   - `'tool_call'`    — model explicitly called `getMemory` and got a
 *     hit. Lower volume; recorded inside the tool itself.
 *
 *   - `'consolidation'` — read during a background consolidation phase.
 *     Lower priority; deferred wiring per task spec. The buffer is
 *     general enough to accept it when the worker is updated.
 *
 * The buffer is per-turn, not per-session — instantiate one for each
 * `queryLoop` invocation. Reuse across turns would lump recalls from a
 * later turn under an earlier message id.
 *
 * The recall sink interface is injected so this module stays free of
 * DB / `pg` dependencies. The adapter in
 * `packages/api/src/db/memory-recall-events-store.ts` provides the
 * concrete implementation; tests can pass an in-memory spy.
 *
 * [COMP:brain/memory-recall-buffer]
 *
 * See `docs/architecture/context-engine/memory-system.md` →
 * "Recall-outcome tagging".
 */

import type { Sensitivity } from '../security/sensitivity.js'

export type MemoryRecallKind = 'index_inject' | 'tool_call' | 'consolidation'

/**
 * The minimal interface the buffer needs from the DB layer. Match the
 * concrete `recordRecallBatch` signature in
 * `packages/api/src/db/memory-recall-events-store.ts`.
 *
 * `Sensitivity` is unused on the sink — declared on the import line so
 * downstream type changes in the security module stay catchable here
 * if the buffer ever grows a sensitivity-aware filter.
 */
export type MemoryRecallSink = {
  recordRecallBatch(params: {
    memoryIds: readonly string[]
    sessionId: string
    workspaceId: string
    userId: string
    recallKind: MemoryRecallKind
    assistantMessageId?: string | null
  }): Promise<void>
}

export type MemoryRecallBufferOptions = {
  sink: MemoryRecallSink
  sessionId: string
  workspaceId: string
  userId: string
}

export type MemoryRecallBuffer = {
  /**
   * Queue one recall. Cheap — pushes onto the in-memory partition for
   * `kind`. Same id queued twice in the same partition is de-duped at
   * flush time (the sink also de-dupes, but doing it here saves an
   * allocation for the common reflective-recall pattern where the
   * model fetches the same memory twice within one turn).
   */
  push(memoryId: string, kind: MemoryRecallKind): void
  /**
   * Queue many recalls for the same kind. Used at turn start when the
   * per-turn memory index is built.
   */
  pushMany(memoryIds: readonly string[], kind: MemoryRecallKind): void
  /**
   * Persist every queued recall with the supplied `assistantMessageId`.
   * Empty partitions are skipped. Errors propagate — the chat route
   * catches them and logs without failing the turn.
   *
   * After flush the buffer is emptied — repeated flushes are a no-op.
   */
  flush(assistantMessageId: string): Promise<void>
  /**
   * Drop every queued recall without writing. Use when the turn errored
   * before the assistant message could be saved.
   */
  discard(): void
  /**
   * Inspect the buffer without flushing. Returns a snapshot keyed by
   * kind. Useful for tests and instrumentation; not load-bearing.
   */
  snapshot(): Record<MemoryRecallKind, readonly string[]>
}

/** Touch the import so eslint+tsc don't complain about the JSDoc reference. */
const _unusedSensitivity: Sensitivity | undefined = undefined
void _unusedSensitivity

/**
 * Construct a buffer for a single turn. Caller owns the lifecycle:
 * push recalls during the turn, flush after the message commits, or
 * discard on error.
 *
 * The store is supplied via the `sink` dependency so this module stays
 * out of the DB driver — the API layer plugs in a thin adapter over
 * `recordRecallBatch`.
 */
export function createMemoryRecallBuffer(
  opts: MemoryRecallBufferOptions,
): MemoryRecallBuffer {
  const queues: Record<MemoryRecallKind, Set<string>> = {
    index_inject: new Set(),
    tool_call: new Set(),
    consolidation: new Set(),
  }

  return {
    push(memoryId, kind) {
      if (!memoryId) return
      queues[kind].add(memoryId)
    },
    pushMany(memoryIds, kind) {
      for (const id of memoryIds) {
        if (id) queues[kind].add(id)
      }
    },
    async flush(assistantMessageId) {
      const kinds: MemoryRecallKind[] = ['index_inject', 'tool_call', 'consolidation']
      for (const kind of kinds) {
        const set = queues[kind]
        if (set.size === 0) continue
        const memoryIds = Array.from(set)
        // Clear before await — if the same buffer's flush is called
        // again (it shouldn't be, but defensive), the second call sees
        // an empty partition and no-ops instead of double-inserting.
        set.clear()
        await opts.sink.recordRecallBatch({
          memoryIds,
          sessionId: opts.sessionId,
          workspaceId: opts.workspaceId,
          userId: opts.userId,
          recallKind: kind,
          assistantMessageId,
        })
      }
    },
    discard() {
      queues.index_inject.clear()
      queues.tool_call.clear()
      queues.consolidation.clear()
    },
    snapshot() {
      return {
        index_inject: Array.from(queues.index_inject),
        tool_call: Array.from(queues.tool_call),
        consolidation: Array.from(queues.consolidation),
      }
    },
  }
}
