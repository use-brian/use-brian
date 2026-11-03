/**
 * Turn trace - epoch routing: full for turns with turn_events rows,
 * legacy composition for pre-epoch turns (content-derived steps + usage
 * summary, labelled), null for unknown ids, and the session ownership
 * guard input (sessionId rides the result for the route to verify).
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect } from 'vitest'
import {
  createTurnTraceReader,
  legacyRetrievalStep,
  legacyStepsFromContent,
} from '../turn-trace.js'
import type { TurnEventRow } from '../../db/turn-ledger-store.js'

const EPOCH = new Date('2026-08-29T00:00:00Z')

const fullEvents: TurnEventRow[] = [
  {
    id: 'e1',
    workspaceId: 'ws1',
    assistantId: 'a1',
    sessionId: 'sess-1',
    assistantMessageId: 'msg-1',
    stepOrdinal: 0,
    actor: 'assistant_turn',
    kind: 'retrieval',
    metadata: { returnedRows: [{ primitive: 'memory', rowId: 'm-1' }] },
    payloadRefs: [],
    sensitivity: 'internal',
    createdAt: new Date('2026-08-30T10:00:00Z'),
  },
  {
    id: 'e2',
    workspaceId: 'ws1',
    assistantId: 'a1',
    sessionId: 'sess-1',
    assistantMessageId: 'msg-1',
    stepOrdinal: 1,
    actor: 'assistant_turn',
    kind: 'provider_call',
    metadata: { model: 'mock', turn: 0 },
    payloadRefs: ['hash-sys', 'hash-msg', 'hash-resp'],
    sensitivity: 'internal',
    createdAt: new Date('2026-08-30T10:00:01Z'),
  },
]

describe('[COMP:api/turn-trace] epoch routing', () => {
  it('retains a durable host invocation in fallback audit without inventing a provider call', () => {
    const observation = { type: 'host_observation', version: 1, id: 'host-read-1', name: 'googleCalendarListEvents',
      input: { calendarId: 'fictional-calendar' }, content: 'Fictional meeting at noon', isError: false }
    expect(legacyStepsFromContent([observation])).toEqual([{ ordinal: 0, kind: 'tool_call', at: null,
      metadata: { origin: 'host', name: observation.name, toolUseId: observation.id,
        input: observation.input, result: observation.content, isError: false } }])
  })
  it('post-epoch turn resolves fidelity full with ordinal-ordered pointer steps', async () => {
    const read = createTurnTraceReader({
      listTraceEvents: async () => fullEvents,
      getLedgerEpoch: async () => EPOCH,
      loadMessage: async () => {
        throw new Error('legacy path must not run')
      },
      loadUsageNear: async () => null,
      loadLegacyRecalls: async () => {
        throw new Error('legacy path must not run')
      },
    })
    const trace = await read('msg-1')
    expect(trace?.fidelity).toBe('full')
    expect(trace?.preEpoch).toBe(false)
    expect(trace?.sessionId).toBe('sess-1')
    expect(trace?.steps.map((s) => s.kind)).toEqual(['retrieval', 'provider_call'])
    expect(trace?.steps[1].payloadRefs).toEqual(['hash-sys', 'hash-msg', 'hash-resp'])
    // Pointer-only: no content in metadata.
    expect(JSON.stringify(trace?.steps[1].metadata)).not.toContain('hello')
  })

  it('pre-epoch turn composes fidelity legacy from persisted content + usage', async () => {
    const read = createTurnTraceReader({
      listTraceEvents: async () => [],
      getLedgerEpoch: async () => EPOCH,
      loadMessage: async () => ({
        id: 'msg-old',
        sessionId: 'sess-9',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'searchBrain', input: { query: 'q' } },
          { type: 'tool_result', toolUseId: 'c1', name: 'searchBrain', content: 'found' },
          { type: 'text', text: 'the answer' },
        ],
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      loadUsageNear: async () => ({ calls: 3, inputTokens: 900, outputTokens: 120, costUsd: 0.01 }),
      loadLegacyRecalls: async () => [],
    })
    const trace = await read('msg-old')
    expect(trace?.fidelity).toBe('legacy')
    expect(trace?.preEpoch).toBe(true)
    expect(trace?.sessionId).toBe('sess-9')
    expect(trace?.steps.map((s) => s.kind)).toEqual(['tool_call', 'response_text', 'usage_summary'])
    const tool = trace!.steps[0]
    expect(tool.metadata.name).toBe('searchBrain')
    expect(tool.metadata.result).toBe('found')
    expect(trace!.steps[2].metadata.approximate).toBe(true)
  })

  it('pre-epoch turn folds memory_recall_events into one leading retrieval step', async () => {
    const read = createTurnTraceReader({
      listTraceEvents: async () => [],
      getLedgerEpoch: async () => EPOCH,
      loadMessage: async () => ({
        id: 'msg-old',
        sessionId: 'sess-9',
        role: 'assistant',
        content: [{ type: 'text', text: 'the answer' }],
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      loadUsageNear: async () => null,
      loadLegacyRecalls: async () => [
        { memoryId: 'm-2', recallKind: 'index_inject', createdAt: new Date('2026-08-01T00:00:01Z') },
        { memoryId: 'm-1', recallKind: 'index_inject', createdAt: new Date('2026-08-01T00:00:00Z') },
        { memoryId: 'm-2', recallKind: 'tool_call', createdAt: new Date('2026-08-01T00:00:02Z') },
      ],
    })
    const trace = await read('msg-old')
    expect(trace?.fidelity).toBe('legacy')
    expect(trace?.steps.map((s) => s.kind)).toEqual(['retrieval', 'response_text'])
    expect(trace?.steps.map((s) => s.ordinal)).toEqual([0, 1])
    const retrieval = trace!.steps[0]
    expect(retrieval.metadata.source).toBe('memory_recall_events')
    expect(retrieval.metadata.returnedRows).toEqual([
      { primitive: 'memory', rowId: 'm-2' },
      { primitive: 'memory', rowId: 'm-1' },
    ])
    expect(retrieval.metadata.recallKinds).toEqual({
      'm-2': ['index_inject', 'tool_call'],
      'm-1': ['index_inject'],
    })
    expect(retrieval.at?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('a failing recall read degrades to no retrieval step, never a failed trace', async () => {
    const read = createTurnTraceReader({
      listTraceEvents: async () => [],
      getLedgerEpoch: async () => EPOCH,
      loadMessage: async () => ({
        id: 'msg-old',
        sessionId: 'sess-9',
        role: 'assistant',
        content: [{ type: 'text', text: 'the answer' }],
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      loadUsageNear: async () => null,
      loadLegacyRecalls: async () => {
        throw new Error('table missing')
      },
    })
    const trace = await read('msg-old')
    expect(trace?.steps.map((s) => s.kind)).toEqual(['response_text'])
  })

  it('returns null for an unknown id and for non-assistant messages', async () => {
    const read = createTurnTraceReader({
      listTraceEvents: async () => [],
      getLedgerEpoch: async () => EPOCH,
      loadMessage: async (id) =>
        id === 'user-msg'
          ? { id, sessionId: 's', role: 'user', content: [], createdAt: new Date() }
          : null,
      loadUsageNear: async () => null,
      loadLegacyRecalls: async () => [],
    })
    expect(await read('nope')).toBeNull()
    expect(await read('user-msg')).toBeNull()
  })
})

describe('[COMP:api/turn-trace] legacy recall folding', () => {
  it('returns null for no recalls', () => {
    expect(legacyRetrievalStep([])).toBeNull()
  })
})

describe('[COMP:api/turn-trace] legacy content composition', () => {
  it('handles string and empty content without throwing', () => {
    expect(legacyStepsFromContent('just text')).toEqual([])
    expect(legacyStepsFromContent(null)).toEqual([])
    expect(legacyStepsFromContent([])).toEqual([])
  })

  it('pairs tool_use with tool_result and marks missing results', () => {
    const steps = legacyStepsFromContent([
      { type: 'tool_use', id: 'a', name: 'x', input: {} },
    ])
    expect(steps[0].metadata.result).toBeNull()
  })
})
