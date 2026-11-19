import { describe, it, expect } from 'vitest'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { z } from 'zod'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import { buildTool } from '../../tools/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'

// ── Scripted provider ──────────────────────────────────────────
// Same shape as query-loop.force-text-explain.test.ts: each send() consumes
// the next script and clamps to the last once exhausted.
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

const echoTool = buildTool({
  name: 'echo',
  description: 'Echo input back',
  inputSchema: z.object({ msg: z.string() }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    return { data: { echoed: input.msg } }
  },
})

const baseContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'assistant-call',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

/**
 * The production shape: the model narrates its plan, emits a tool call, and
 * the stream is then closed with `stopReason: 'end_turn'` — which is what a
 * mid-turn wrapper truncation does (`wrapTextLoopPrevention` once text has
 * already been emitted downstream, and the fallback wrapper's synthetic
 * close). `stopReason` therefore says "terminal" while the CONTENT still
 * carries a `tool_use` block.
 */
const truncatedNarrationTurn = (id: string, narration: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text: narration },
  { type: 'tool_use_start', id, name: 'echo' },
  { type: 'tool_use_delta', id, input: '{"msg":"hi"}' },
  { type: 'tool_use_end', id },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
]

const textChunks = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

// Verbatim from prod run 86d1c152 (step `save_cursor`, 2026-08-05): the whole
// text the model produced alongside its tool call.
const NARRATION = ' Then produce the final result.\n\n'
// A clean synthesis — must not trip looksLikeInstructionLeak (second person,
// no "the user").
const SYNTHESIS = 'I checked the merge timestamp and it matches what you already had, so nothing needed updating.'

async function runLoop(provider: LLMProvider): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({ ledger: NOOP_TURN_LEDGER,
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'save the cursor' }],
    tools: new Map([['echo', echoTool]]),
    context: baseContext,
    // Both caps deliberately generous — neither is reached, so this exercises
    // the Phase 4 terminal exit and nothing else.
    maxTurns: 10,
    maxToolCalls: 10,
  })) {
    events.push(e)
  }
  return events
}

/**
 * Reproduces how a delivery path assembles its deliverable: skip any turn
 * carrying a `tool_use` block (mid-reasoning narration), join the rest. This
 * is the rule in packages/api/src/inter-assistant/executor.ts, graded by the
 * `turn-text-assembly` invariant.
 */
function assembleDeliverable(events: QueryEvent[]): string {
  return events
    .filter((e): e is QueryEvent & { type: 'assistant_turn' } => e.type === 'assistant_turn')
    .filter((e) => !e.response.content.some((b) => b.type === 'tool_use'))
    .map((e) =>
      e.response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
        .map((b) => b.text)
        .join(''),
    )
    .join('\n')
    .trim()
}

describe('[COMP:engine/query-loop] Terminal-turn rescue — stopReason says terminal, content carries a tool call', () => {
  it('synthesizes a closing turn when the terminal turn carries a tool_use block', async () => {
    const provider = scriptedProvider([
      truncatedNarrationTurn('t1', NARRATION),
      textChunks(JSON.stringify({ message: SYNTHESIS })),
    ])

    const events = await runLoop(provider)

    const complete = events.find((e) => e.type === 'turn_complete')
    if (complete?.type !== 'turn_complete') throw new Error('expected turn_complete')

    // The loop must not hand a tool-call-carrying turn out as its final word.
    expect(complete.response.content.some((b) => b.type === 'tool_use')).toBe(false)
    expect(
      complete.response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ).toBe(SYNTHESIS)
  })

  it('leaves a non-empty deliverable for a consult that drops non-terminal turns', async () => {
    const provider = scriptedProvider([
      truncatedNarrationTurn('t1', NARRATION),
      textChunks(JSON.stringify({ message: SYNTHESIS })),
    ])

    const events = await runLoop(provider)

    // The regression: narration riding alongside the tool call satisfied the
    // old lexical `hasText` guard, so no synthesis ran and the consult
    // assembled '' → thrown as `empty_response` (prod run 86d1c152).
    const deliverable = assembleDeliverable(events)
    expect(deliverable).not.toBe('')
    expect(deliverable).toContain('nothing needed updating')
    expect(deliverable).not.toContain('Then produce the final result')
  })

  it('does not fire when the terminal turn is a clean text turn', async () => {
    const provider = scriptedProvider([textChunks('All set - cursor saved.')])

    const events = await runLoop(provider)

    // Exactly one model turn: no rescue call was made.
    const turns = events.filter((e) => e.type === 'assistant_turn')
    expect(turns).toHaveLength(1)
    expect(assembleDeliverable(events)).toBe('All set - cursor saved.')
  })
})

const invocationResourceTurn: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id: 'resource-1', name: 'reserve_resource' },
  { type: 'tool_use_delta', id: 'resource-1', input: '{}' },
  { type: 'tool_use_end', id: 'resource-1' },
  { type: 'tool_use_start', id: 'resource-2', name: 'reserve_resource' },
  { type: 'tool_use_delta', id: 'resource-2', input: '{}' },
  { type: 'tool_use_end', id: 'resource-2' },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
]

describe('[COMP:engine/query-loop] Invocation finalizers', () => {
  it('runs a keyed finalizer once after a normal terminal turn', async () => {
    let finalized = 0
    const resourceTool = buildTool({
      name: 'reserve_resource',
      description: 'Reserve one test resource',
      inputSchema: z.object({}),
      isConcurrencySafe: true,
      async execute(_input, context) {
        context.registerInvocationFinalizer?.('test-resource', async () => {
          finalized++
        })
        return { data: 'reserved' }
      },
    })
    const events: QueryEvent[] = []

    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: scriptedProvider([invocationResourceTurn, textChunks('Finished.')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'use the resource' }],
      tools: new Map([['reserve_resource', resourceTool]]),
      context: baseContext,
    })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === 'turn_complete')).toBe(true)
    expect(finalized).toBe(1)
  })

  it('runs finalizers when a consumer stops iterating before turn_complete', async () => {
    let finalized = 0
    const resourceTool = buildTool({
      name: 'reserve_resource',
      description: 'Reserve one test resource',
      inputSchema: z.object({}),
      isConcurrencySafe: true,
      async execute(_input, context) {
        context.registerInvocationFinalizer?.('test-resource', async () => {
          finalized++
        })
        return { data: 'reserved' }
      },
    })

    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: scriptedProvider([invocationResourceTurn, textChunks('Finished.')]),
      model: 'mock-model',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'use the resource' }],
      tools: new Map([['reserve_resource', resourceTool]]),
      context: baseContext,
    })) {
      if (event.type === 'tool_result') break
    }

    expect(finalized).toBe(1)
  })
})
