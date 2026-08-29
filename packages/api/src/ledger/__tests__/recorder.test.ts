/**
 * Turn-ledger recorder — event shapes, ordinal ordering, request-delta
 * accumulation, tool pairing, trace re-keying, pre-loop retrieval
 * buffering, and the never-fail contract.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AssistantResponse } from '@use-brian/core'

const db = vi.hoisted(() => {
  const events: Array<Record<string, unknown>> = []
  const rebinds: Array<[string, string]> = []
  return {
    events,
    rebinds,
    reset() {
      events.length = 0
      rebinds.length = 0
    },
  }
})

vi.mock('../../db/turn-ledger-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../db/turn-ledger-store.js')>()
  return {
    ...orig,
    insertTurnEvent: vi.fn(async (e: Record<string, unknown>) => {
      db.events.push(e)
    }),
    rebindTraceId: vi.fn(async (a: string, b: string) => {
      db.rebinds.push([a, b])
      for (const e of db.events) {
        if (e.assistantMessageId === a) e.assistantMessageId = b
      }
    }),
  }
})

import { createTurnLedger } from '../recorder.js'
import { hashPayload } from '../payload-store.js'
import type { LedgerPayloadStore } from '../payload-store.js'

function fakePayloads(): { store: LedgerPayloadStore; puts: string[] } {
  const puts: string[] = []
  const store: LedgerPayloadStore = {
    async put({ content }) {
      puts.push(content)
      return hashPayload(content)
    },
    async get() {
      return null
    },
    async erase() {
      return 0
    },
  }
  return { store, puts }
}

const textResponse = (text: string): AssistantResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 5, outputTokens: 3 },
  model: 'mock-model',
})

describe('[COMP:api/turn-ledger-recorder] event shapes', () => {
  beforeEach(() => db.reset())

  it('records provider_call with system + message + response refs, pointer-only', async () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({
      workspaceId: 'ws1',
      assistantId: 'as1',
      sessionId: 'se1',
      payloads: store,
    })
    const trace = handle.ledger.startTrace({
      actor: 'assistant_turn',
      model: 'mock-model',
      systemPrompt: 'sys-prompt',
      messages: [{ role: 'user', content: 'hi' }],
    })
    trace.turn({ turn: 0, response: textResponse('hello'), toolResults: [] })
    await handle.flush()

    expect(db.events).toHaveLength(1)
    const e = db.events[0] as Record<string, unknown>
    expect(e.kind).toBe('provider_call')
    expect(e.actor).toBe('assistant_turn')
    expect(e.workspaceId).toBe('ws1')
    expect(e.stepOrdinal).toBe(0)
    const refs = e.payloadRefs as string[]
    expect(refs).toContain(hashPayload('sys-prompt'))
    expect(refs).toContain(hashPayload(JSON.stringify({ role: 'user', content: 'hi' })))
    expect(refs).toContain(hashPayload(JSON.stringify(textResponse('hello').content)))
    // Pointer-only: no content strings ride in metadata.
    expect(JSON.stringify(e.metadata)).not.toContain('hello')
    expect(JSON.stringify(e.metadata)).not.toContain('sys-prompt')
  })

  it('pairs tool_use with its result and keeps ordinals in call order', async () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({ workspaceId: 'ws1', payloads: store })
    const trace = handle.ledger.startTrace({
      actor: 'assistant_turn',
      model: 'm',
      systemPrompt: 's',
      messages: [],
    })
    const response: AssistantResponse = {
      content: [
        { type: 'tool_use', id: 'c1', name: 'searchBrain', input: { query: 'q' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    }
    trace.turn({
      turn: 0,
      response,
      toolResults: [{ type: 'tool_result', toolUseId: 'c1', name: 'searchBrain', content: 'found 2 rows' }],
    })
    trace.retrieval({ returnedRows: [{ primitive: 'memory', rowId: 'm-1' }], source: 'tool_call' })
    await handle.flush()

    expect(db.events.map((e) => e.kind)).toEqual(['provider_call', 'tool_call', 'retrieval'])
    expect(db.events.map((e) => e.stepOrdinal)).toEqual([0, 1, 2])
    const tool = db.events[1] as Record<string, unknown>
    const meta = tool.metadata as Record<string, unknown>
    expect(meta.name).toBe('searchBrain')
    expect(meta.toolUseId).toBe('c1')
    expect(meta.isError).toBe(false)
    expect((tool.payloadRefs as string[])).toEqual([
      hashPayload(JSON.stringify({ query: 'q' })),
      hashPayload('found 2 rows'),
    ])
    const retrieval = db.events[2] as Record<string, unknown>
    expect((retrieval.metadata as Record<string, unknown>).returnedRows).toEqual([
      { primitive: 'memory', rowId: 'm-1' },
    ])
    expect(retrieval.payloadRefs).toEqual([])
  })

  it('accumulates request deltas in stateful mode', async () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({ workspaceId: 'ws1', payloads: store })
    const trace = handle.ledger.startTrace({
      actor: 'assistant_turn',
      model: 'm',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'first' }],
    })
    trace.turn({ turn: 0, response: textResponse('a'), toolResults: [] })
    trace.request({ turn: 1, messages: [{ role: 'user', content: 'delta' }], full: false })
    trace.turn({ turn: 1, response: textResponse('b'), toolResults: [] })
    await handle.flush()

    const second = db.events[1] as Record<string, unknown>
    const refs = second.payloadRefs as string[]
    expect(refs).toContain(hashPayload(JSON.stringify({ role: 'user', content: 'first' })))
    expect(refs).toContain(hashPayload(JSON.stringify({ role: 'user', content: 'delta' })))
  })

  it('adopts the supplied assistantMessageId for the first trace, mints for children', () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({ assistantMessageId: 'msg-real', payloads: store })
    const first = handle.ledger.startTrace({ actor: 'assistant_turn', model: 'm', systemPrompt: 's', messages: [] })
    const child = handle.ledger.startTrace({ actor: 'assistant_turn', model: 'm', systemPrompt: 's', messages: [] })
    expect(first.traceId).toBe('msg-real')
    expect(child.traceId).not.toBe('msg-real')
  })

  it('re-keys the first trace on bindAssistantMessageId', async () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({ payloads: store })
    const trace = handle.ledger.startTrace({ actor: 'assistant_turn', model: 'm', systemPrompt: 's', messages: [] })
    const minted = trace.traceId
    trace.turn({ turn: 0, response: textResponse('a'), toolResults: [] })
    handle.bindAssistantMessageId('msg-42')
    trace.event('confirmation', { toolName: 'sendFile' })
    await handle.flush()

    expect(db.rebinds).toEqual([[minted, 'msg-42']])
    // Every event now carries the real id — pre-bind via the UPDATE, post-bind directly.
    expect(db.events.every((e) => e.assistantMessageId === 'msg-42')).toBe(true)
  })

  it('buffers pre-loop retrieval provenance into the first trace', async () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({ payloads: store })
    handle.recordRetrieval({ returnedRows: [{ primitive: 'memory', rowId: 'm-9' }], source: 'index_inject' })
    handle.ledger.startTrace({ actor: 'assistant_turn', model: 'm', systemPrompt: 's', messages: [] })
    await handle.flush()

    expect(db.events).toHaveLength(1)
    expect(db.events[0].kind).toBe('retrieval')
    expect((db.events[0].metadata as Record<string, unknown>).source).toBe('index_inject')
  })

  it('actor override wins (workflow_step lane)', async () => {
    const { store } = fakePayloads()
    const handle = createTurnLedger({ actor: 'workflow_step', payloads: store })
    const trace = handle.ledger.startTrace({ actor: 'assistant_turn', model: 'm', systemPrompt: 's', messages: [] })
    trace.turn({ turn: 0, response: textResponse('x'), toolResults: [] })
    await handle.flush()
    expect(db.events[0].actor).toBe('workflow_step')
  })

  it('a failing store degrades with one warning and never throws', async () => {
    const failing: LedgerPayloadStore = {
      put: async () => {
        throw new Error('no backend')
      },
      get: async () => null,
      erase: async () => 0,
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = createTurnLedger({ payloads: failing })
      const trace = handle.ledger.startTrace({ actor: 'assistant_turn', model: 'm', systemPrompt: 's', messages: [] })
      trace.turn({ turn: 0, response: textResponse('a'), toolResults: [] })
      trace.turn({ turn: 1, response: textResponse('b'), toolResults: [] })
      await handle.flush()
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('[turn-ledger]')).length).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })
})
