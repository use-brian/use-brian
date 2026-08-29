/**
 * Turn-ledger recorder — the api-side implementation of the core
 * `TurnLedger` contract queryLoop requires.
 *
 * One recorder per lane invocation (`createTurnLedger` at the call site
 * that starts the loop). The recorder:
 *  - adopts the lane's persisted assistant message id as the trace key
 *    (first `startTrace`), minting UUIDs for child traces (workers, the
 *    doc edit-agent) that arrive through `ToolContext.turnLedger`;
 *  - content-addresses every payload (sha256) through the
 *    `LedgerPayloadStore` — message-level hashing is what collapses the
 *    naive ~2.1 GB/mo full-request capture to unique content only
 *    (plan §8);
 *  - assigns step ordinals in enqueue order on a serialized write chain,
 *    fire-and-forget: a ledger failure logs once and NEVER fails the turn.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 * [COMP:api/turn-ledger-recorder]
 */

import { randomUUID } from 'node:crypto'
import type {
  AssistantResponse,
  ContentBlock,
  Message,
  TurnLedger,
  TurnLedgerActor,
  TurnRetrievalProvenance,
  TurnTrace,
  TurnTraceStart,
} from '@use-brian/core'
import { insertTurnEvent, rebindTraceId, type TurnEventKind } from '../db/turn-ledger-store.js'
import type { LedgerPayloadStore } from './payload-store.js'

export type TurnLedgerContext = {
  workspaceId?: string | null
  assistantId?: string | null
  sessionId?: string | null
  /** Overrides the actor the loop reports (e.g. 'workflow_step', 'a2a'). */
  actor?: TurnLedgerActor
  sensitivity?: string
  /** The lane's persisted assistant message id — adopted by the FIRST trace. */
  assistantMessageId?: string
  payloads: LedgerPayloadStore
}

export type TurnLedgerHandle = {
  ledger: TurnLedger
  /**
   * Retrieval provenance from seams that run BEFORE the loop starts
   * (context assembly, the memory index inject). Buffered and drained
   * into the first trace.
   */
  recordRetrieval(info: TurnRetrievalProvenance): void
  /**
   * Re-key the FIRST trace to the persisted assistant message id once the
   * lane knows it (the chat flush site). No-op when the id was supplied
   * up front or nothing was recorded.
   */
  bindAssistantMessageId(realId: string): void
  /** Await all enqueued writes — tests and graceful shutdown only. */
  flush(): Promise<void>
}

export function createTurnLedger(ctx: TurnLedgerContext): TurnLedgerHandle {
  let chain: Promise<void> = Promise.resolve()
  let warned = false
  const pendingRetrievals: TurnRetrievalProvenance[] = []
  let firstTrace: TraceImpl | null = null

  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op).catch((err) => {
      if (!warned) {
        warned = true
        console.warn(
          `[turn-ledger] write failed (recording degraded for this lane): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
  }

  class TraceImpl implements TurnTrace {
    private _traceId: string
    private readonly actor: TurnLedgerActor
    private ordinal = 0
    /** Cumulative request-message refs (deltas appended in stateful mode). */
    private messageRefs: string[] = []
    private systemRef: string | null = null
    private startMessages: Message[]

    get traceId(): string {
      return this._traceId
    }

    /**
     * Re-key: rows already enqueued carry the old id and the chained
     * UPDATE (serialized after them) re-keys those; rows enqueued after
     * this call read the new id directly. Race-free on the write chain.
     */
    rebind(realId: string): void {
      const oldId = this._traceId
      if (oldId === realId) return
      this._traceId = realId
      enqueue(() => rebindTraceId(oldId, realId))
    }

    constructor(start: TurnTraceStart, traceId: string) {
      this._traceId = traceId
      this.actor = ctx.actor ?? start.actor
      this.startMessages = start.messages
      // Hash the system prompt + initial messages up front so even a trace
      // whose first provider call never happens (immediate abort) records
      // what the lane was going to send.
      enqueue(async () => {
        this.systemRef = await ctx.payloads.put({
          workspaceId: ctx.workspaceId,
          content: start.systemPrompt,
          mediaType: 'text/plain',
          sensitivity: ctx.sensitivity,
        })
        this.messageRefs = await this.putMessages(this.startMessages)
      })
    }

    private async putMessages(messages: Message[]): Promise<string[]> {
      const refs: string[] = []
      for (const m of messages) {
        refs.push(
          await ctx.payloads.put({
            workspaceId: ctx.workspaceId,
            content: JSON.stringify(m),
            sensitivity: ctx.sensitivity,
          }),
        )
      }
      return refs
    }

    private writeEvent(kind: TurnEventKind, metadata: Record<string, unknown>, payloadRefs: string[]): void {
      const stepOrdinal = this.ordinal++
      enqueue(() =>
        insertTurnEvent({
          workspaceId: ctx.workspaceId,
          assistantId: ctx.assistantId,
          sessionId: ctx.sessionId,
          assistantMessageId: this.traceId,
          stepOrdinal,
          actor: this.actor,
          kind,
          metadata,
          payloadRefs,
          sensitivity: ctx.sensitivity,
        }),
      )
    }

    request(info: { turn: number; messages: Message[]; full: boolean }): void {
      const { messages, full } = info
      enqueue(async () => {
        const refs = await this.putMessages(messages)
        if (full) this.messageRefs = refs
        else this.messageRefs = [...this.messageRefs, ...refs]
      })
    }

    turn(info: { turn: number; response: AssistantResponse; toolResults: ContentBlock[] }): void {
      const { turn, response, toolResults } = info
      // Ordinals are assigned SYNCHRONOUSLY in call order (the serialized
      // chain then inserts in the same order) so a retrieval recorded
      // between turns can never land out of sequence.
      const providerOrdinal = this.ordinal++
      // provider_call: request refs (system + cumulative messages) + response.
      enqueue(async () => {
        const responseRef = await ctx.payloads.put({
          workspaceId: ctx.workspaceId,
          content: JSON.stringify(response.content),
          sensitivity: ctx.sensitivity,
        })
        const stepOrdinal = providerOrdinal
        await insertTurnEvent({
          workspaceId: ctx.workspaceId,
          assistantId: ctx.assistantId,
          sessionId: ctx.sessionId,
          assistantMessageId: this.traceId,
          stepOrdinal,
          actor: this.actor,
          kind: 'provider_call',
          metadata: {
            turn,
            model: response.model,
            stopReason: response.stopReason,
            usage: response.usage as unknown as Record<string, unknown>,
            messageCount: this.messageRefs.length,
            responseRef,
          },
          payloadRefs: [...(this.systemRef ? [this.systemRef] : []), ...this.messageRefs, responseRef],
          sensitivity: ctx.sensitivity,
        })
      })
      // tool_call: one event per tool_use block, paired with its result.
      const resultsById = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>()
      for (const b of toolResults) {
        if (b.type === 'tool_result') resultsById.set(b.toolUseId, b)
      }
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const result = resultsById.get(block.id)
        const toolOrdinal = this.ordinal++
        enqueue(async () => {
          const inputRef = await ctx.payloads.put({
            workspaceId: ctx.workspaceId,
            content: JSON.stringify(block.input ?? {}),
            sensitivity: ctx.sensitivity,
          })
          const resultRef = result
            ? await ctx.payloads.put({
                workspaceId: ctx.workspaceId,
                content: result.content,
                mediaType: 'text/plain',
                sensitivity: ctx.sensitivity,
              })
            : null
          const stepOrdinal = toolOrdinal
          await insertTurnEvent({
            workspaceId: ctx.workspaceId,
            assistantId: ctx.assistantId,
            sessionId: ctx.sessionId,
            assistantMessageId: this.traceId,
            stepOrdinal,
            actor: this.actor,
            kind: 'tool_call',
            metadata: {
              turn,
              name: block.name,
              toolUseId: block.id,
              isError: result?.isError === true,
              hasResult: result != null,
            },
            payloadRefs: resultRef ? [inputRef, resultRef] : [inputRef],
            sensitivity: ctx.sensitivity,
          })
        })
      }
    }

    retrieval(info: TurnRetrievalProvenance): void {
      // Pointer-only by design — ids in metadata, no payloads. Over the
      // immutable substrate, id + timestamp dereferences to exact content.
      this.writeEvent(
        'retrieval',
        {
          returnedRows: info.returnedRows,
          ...(info.walkedEdges?.length ? { walkedEdges: info.walkedEdges } : {}),
          ...(info.nudgeVerdict ? { nudgeVerdict: info.nudgeVerdict } : {}),
          ...(info.source ? { source: info.source } : {}),
        },
        [],
      )
    }

    event(kind: 'confirmation' | 'approval', metadata: Record<string, unknown>): void {
      this.writeEvent(kind, metadata, [])
    }
  }

  const ledger: TurnLedger = {
    startTrace(start: TurnTraceStart): TurnTrace {
      const isFirst = firstTrace == null
      const trace = new TraceImpl(start, isFirst && ctx.assistantMessageId ? ctx.assistantMessageId : randomUUID())
      if (isFirst) {
        firstTrace = trace
        for (const r of pendingRetrievals.splice(0)) trace.retrieval(r)
      }
      return trace
    },
  }

  return {
    ledger,
    recordRetrieval(info: TurnRetrievalProvenance): void {
      if (firstTrace) firstTrace.retrieval(info)
      else pendingRetrievals.push(info)
    },
    bindAssistantMessageId(realId: string): void {
      firstTrace?.rebind(realId)
    },
    flush(): Promise<void> {
      return chain
    },
  }
}
