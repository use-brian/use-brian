/**
 * queryLoop <-> TurnLedger integration: the loop reports the trace start,
 * each provider request, and each completed turn (Phase 3b pairing) to the
 * REQUIRED ledger option, stamps the ledger onto the ToolContext for
 * nested loops, and never lets a recorder failure break a turn.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
  AssistantResponse,
  ContentBlock,
} from '../../providers/types.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import { queryLoop } from '../query-loop.js'
import type { TurnLedger, TurnTrace, TurnTraceStart } from '../turn-ledger.js'

function scriptedProvider(scripts: StreamChunk[][]): LLMProvider {
  let turn = 0
  function streamNext(): AsyncIterable<StreamChunk> {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(_messages: Message[], _opts?: SendOptions) {
      return streamNext()
    },
  }
  return {
    name: 'scripted',
    models: ['mock-model'],
    stream: () => streamNext(),
    createSession: (_o: SessionOptions) => session,
  }
}

const textTurn = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

const toolTurn: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id: 'call-1', name: 'echo' },
  { type: 'tool_use_delta', id: 'call-1', input: '{"msg":"hi"}' },
  { type: 'tool_use_end', id: 'call-1' },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 2 } },
]

const baseContext: ToolContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

type Recorded = {
  starts: TurnTraceStart[]
  requests: Array<{ turn: number; messages: Message[]; full: boolean }>
  turns: Array<{ turn: number; response: AssistantResponse; toolResults: ContentBlock[] }>
}

function recordingLedger(): { ledger: TurnLedger; recorded: Recorded } {
  const recorded: Recorded = { starts: [], requests: [], turns: [] }
  const trace: TurnTrace = {
    traceId: 'trace-1',
    request: (info) => recorded.requests.push(info),
    turn: (info) => recorded.turns.push(info),
    retrieval: () => {},
    event: () => {},
  }
  return {
    recorded,
    ledger: {
      startTrace(info) {
        recorded.starts.push(info)
        return trace
      },
    },
  }
}

const echoTool = buildTool({
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({ msg: z.string() }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    return { data: { echoed: input.msg } }
  },
})

describe('[COMP:engine/turn-ledger] queryLoop ledger recording', () => {
  it('reports trace start, per-turn request, and completed turn', async () => {
    const { ledger, recorded } = recordingLedger()
    for await (const _e of queryLoop({
      ledger,
      provider: scriptedProvider([textTurn('hello')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: new Map(),
      context: baseContext,
      maxTurns: 3,
    })) {
      // drain
    }
    expect(recorded.starts).toHaveLength(1)
    expect(recorded.starts[0].systemPrompt).toBe('sys')
    expect(recorded.starts[0].actor).toBe('assistant_turn')
    expect(recorded.requests).toHaveLength(1)
    // Stateful mode: the request is the delta, not the full history.
    expect(recorded.requests[0].full).toBe(false)
    expect(recorded.turns).toHaveLength(1)
    const text = recorded.turns[0].response.content.find((b) => b.type === 'text')
    expect(text && 'text' in text ? text.text : '').toBe('hello')
  })

  it('records tool turns with paired results (Phase 3b pairing)', async () => {
    const { ledger, recorded } = recordingLedger()
    for await (const _e of queryLoop({
      ledger,
      provider: scriptedProvider([toolTurn, textTurn('done')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: new Map([['echo', echoTool]]),
      context: baseContext,
      maxTurns: 4,
    })) {
      // drain
    }
    expect(recorded.turns).toHaveLength(2)
    const first = recorded.turns[0]
    const toolUse = first.response.content.find((b) => b.type === 'tool_use')
    expect(toolUse && 'name' in toolUse ? toolUse.name : '').toBe('echo')
    const result = first.toolResults.find((b) => b.type === 'tool_result')
    expect(result && 'toolUseId' in result ? result.toolUseId : '').toBe('call-1')
    // Second turn recorded a second request (the tool-result delta).
    expect(recorded.requests).toHaveLength(2)
  })

  it('stamps the ledger onto the ToolContext for nested loops', async () => {
    const { ledger } = recordingLedger()
    let seen: TurnLedger | undefined
    const probeTool = buildTool({
      name: 'echo',
      description: 'probe',
      inputSchema: z.object({ msg: z.string() }),
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute(_input, context) {
        seen = context.turnLedger
        return { data: { ok: true } }
      },
    })
    for await (const _e of queryLoop({
      ledger,
      provider: scriptedProvider([toolTurn, textTurn('done')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: new Map([['echo', probeTool]]),
      context: baseContext,
      maxTurns: 4,
    })) {
      // drain
    }
    expect(seen).toBe(ledger)
  })

  it('a throwing recorder never breaks the turn', async () => {
    const throwingLedger: TurnLedger = {
      startTrace() {
        return {
          traceId: 'boom',
          request: () => {
            throw new Error('recorder bug')
          },
          turn: () => {
            throw new Error('recorder bug')
          },
          retrieval: () => {
            throw new Error('recorder bug')
          },
          event: () => {
            throw new Error('recorder bug')
          },
        }
      },
    }
    const events: string[] = []
    for await (const e of queryLoop({
      ledger: throwingLedger,
      provider: scriptedProvider([textTurn('survived')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: new Map(),
      context: baseContext,
      maxTurns: 2,
    })) {
      events.push(e.type)
    }
    expect(events).toContain('turn_complete')
  })

  it('a throwing startTrace disables recording but the turn completes', async () => {
    const ledger: TurnLedger = {
      startTrace() {
        throw new Error('startTrace bug')
      },
    }
    const events: string[] = []
    for await (const e of queryLoop({
      ledger,
      provider: scriptedProvider([textTurn('ok')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: new Map(),
      context: baseContext,
      maxTurns: 2,
    })) {
      events.push(e.type)
    }
    expect(events).toContain('turn_complete')
  })
})
