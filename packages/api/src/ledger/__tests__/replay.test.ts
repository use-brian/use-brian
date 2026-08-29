/**
 * Replay - reconstruct a recorded fixture turn from its trace (payload
 * refs -> exact inputs), refuse erased payloads with an explicit error,
 * and run the reconstructed inputs through queryLoop with a variant,
 * diffing against the recorded text. This is the replay eval class's
 * engine, exercised against a recorded fixture turn end to end.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect } from 'vitest'
import { NOOP_TURN_LEDGER } from '@use-brian/core'
import type { LLMProvider, ProviderSession, StreamChunk, Message } from '@use-brian/core'
import { hashPayload, type LedgerPayloadStore } from '../payload-store.js'
import { reconstructTurnInputs, replayTurn } from '../replay.js'
import type { TurnEventRow } from '../../db/turn-ledger-store.js'

// ── A recorded fixture turn, exactly as the recorder would have written it ──

const SYSTEM = 'You are terse.'
const USER_MSG: Message = { role: 'user', content: 'what is 2+2?' }
const RESPONSE_CONTENT = [{ type: 'text', text: 'four' }]

const sysHash = hashPayload(SYSTEM)
const msgHash = hashPayload(JSON.stringify(USER_MSG))
const respHash = hashPayload(JSON.stringify(RESPONSE_CONTENT))

const fixtureEvents: TurnEventRow[] = [
  {
    id: 'e1',
    workspaceId: 'ws1',
    assistantId: 'a1',
    sessionId: 's1',
    assistantMessageId: 'msg-fixture',
    stepOrdinal: 0,
    actor: 'assistant_turn',
    kind: 'provider_call',
    metadata: { model: 'recorded-model', turn: 0, responseRef: respHash },
    payloadRefs: [sysHash, msgHash, respHash],
    sensitivity: 'internal',
    createdAt: new Date('2026-08-30T00:00:00Z'),
  },
]

function fixturePayloads(overrides: Record<string, { content: string } | { erased: true }> = {}): LedgerPayloadStore {
  const map: Record<string, { content: string } | { erased: true }> = {
    [sysHash]: { content: SYSTEM },
    [msgHash]: { content: JSON.stringify(USER_MSG) },
    [respHash]: { content: JSON.stringify(RESPONSE_CONTENT) },
    ...overrides,
  }
  return {
    put: async () => {
      throw new Error('unused')
    },
    get: async (_ws, hash) => {
      const got = map[hash]
      if (!got) return null
      return 'erased' in got ? got : { content: got.content, mediaType: 'application/json' }
    },
    erase: async () => 0,
  }
}

function scriptedProvider(text: string): LLMProvider {
  const chunks: StreamChunk[] = [
    { type: 'message_start', model: 'variant-model' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ]
  const stream = () =>
    (async function* () {
      for (const c of chunks) yield c
    })()
  const session: ProviderSession = { send: () => stream() }
  return { name: 'scripted', models: ['variant-model'], stream, createSession: () => session }
}

describe('[COMP:api/ledger-replay] reconstruction', () => {
  it('rebuilds the exact recorded inputs from payload refs', async () => {
    const inputs = await reconstructTurnInputs('msg-fixture', {
      listTraceEvents: async () => fixtureEvents,
      payloads: fixturePayloads(),
    })
    expect(inputs).not.toBeNull()
    expect(inputs!.model).toBe('recorded-model')
    expect(inputs!.systemPrompt).toBe(SYSTEM)
    expect(inputs!.messages).toEqual([USER_MSG])
    expect(inputs!.recordedText).toBe('four')
  })

  it('refuses an erased payload with an explicit error - never a silent hole', async () => {
    await expect(
      reconstructTurnInputs('msg-fixture', {
        listTraceEvents: async () => fixtureEvents,
        payloads: fixturePayloads({ [msgHash]: { erased: true } }),
      }),
    ).rejects.toThrow('erased')
  })

  it('returns null for a trace with no provider_call', async () => {
    const inputs = await reconstructTurnInputs('other', {
      listTraceEvents: async () => [],
      payloads: fixturePayloads(),
    })
    expect(inputs).toBeNull()
  })
})

describe('[COMP:api/ledger-replay] replay against a recorded fixture turn', () => {
  it('runs the reconstructed inputs through queryLoop with a variant and diffs', async () => {
    const inputs = (await reconstructTurnInputs('msg-fixture', {
      listTraceEvents: async () => fixtureEvents,
      payloads: fixturePayloads(),
    }))!
    const result = await replayTurn({
      inputs,
      provider: scriptedProvider('4'),
      ledger: NOOP_TURN_LEDGER,
      model: 'variant-model',
    })
    expect(result.replayText).toBe('4')
    expect(result.recordedText).toBe('four')
    expect(result.changed).toBe(true)
  })

  it('reports unchanged when the variant reproduces the recording', async () => {
    const inputs = (await reconstructTurnInputs('msg-fixture', {
      listTraceEvents: async () => fixtureEvents,
      payloads: fixturePayloads(),
    }))!
    const result = await replayTurn({
      inputs,
      provider: scriptedProvider('four'),
      ledger: NOOP_TURN_LEDGER,
    })
    expect(result.changed).toBe(false)
  })
})
