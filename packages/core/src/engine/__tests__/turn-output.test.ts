import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  AssistantResponse,
  LLMProvider,
  Message,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StopReason,
  StreamChunk,
} from '../../providers/types.js'
import { askQuestionTool } from '../../tools/base/ask-question.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'
import { createTurnOutputCollector } from '../turn-output.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'

function response(content: AssistantResponse['content']): AssistantResponse {
  return {
    content,
    stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'fixture-model',
  }
}

function assistantTurn(value: AssistantResponse): QueryEvent {
  return { type: 'assistant_turn', response: value, toolResults: [] }
}

describe('[COMP:engine/turn-output] final output selection', () => {
  it('drops whole tool-bearing turns and preserves the two formatting contracts', () => {
    const compact = createTurnOutputCollector()
    const channel = createTurnOutputCollector({ format: 'channel' })
    const events: QueryEvent[] = [
      assistantTurn(response([
        { type: 'text', text: 'private plan' },
        { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
      ])),
      assistantTurn(response([
        { type: 'text', text: 'First' },
        { type: 'text', text: ' answer' },
      ])),
      assistantTurn(response([{ type: 'text', text: 'Second response' }])),
    ]
    for (const event of events) {
      compact.observe(event)
      channel.observe(event)
    }

    expect(compact.select()).toEqual({ kind: 'text', text: 'First answer\nSecond response' })
    expect(channel.select()).toEqual({ kind: 'text', text: 'First\n answer\nSecond response' })
  })

  it('reads response references at selection time and never appends turn_complete twice', () => {
    const collector = createTurnOutputCollector()
    const final = response([{ type: 'text', text: 'Verified answer' }])
    collector.observe(assistantTurn(final))
    final.content.push({ type: 'text', text: '\n\nSome values remain unverified.' })
    collector.observe({
      type: 'turn_complete',
      response: final,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    })

    expect(collector.select()).toEqual({
      kind: 'text',
      text: 'Verified answer\n\nSome values remain unverified.',
    })
  })

  it('cuts every pre-nudge response and does not revive it after an empty turn', () => {
    const collector = createTurnOutputCollector()
    collector.observe(assistantTurn(response([{ type: 'text', text: 'Unverified 42%' }])))
    collector.observe({ type: 'grounding_nudge', matchedCue: '42%', unbackedCount: 1 })
    collector.observe(assistantTurn(response([])))

    expect(collector.select()).toEqual({ kind: 'empty', reason: 'text_withheld' })
  })

  it('gives a validated engine question precedence and advances only explicitly', () => {
    const collector = createTurnOutputCollector()
    collector.observe(assistantTurn(response([{ type: 'text', text: 'Draft answer' }])))
    collector.observe({
      type: 'question',
      question: 'Which account?',
      options: ['Personal', 'Company'],
    })

    const selected = collector.select()
    expect(selected).toEqual({
      kind: 'question',
      question: { question: 'Which account?', options: ['Personal', 'Company'] },
    })
    expect(collector.select()).toEqual(selected)
    collector.advanceDelivery()
    expect(collector.select()).toEqual({ kind: 'empty', reason: 'no_model_output' })
  })

  it('classifies tool-only, withheld text, and absent model output in precedence order', () => {
    const tools = createTurnOutputCollector()
    tools.observe(assistantTurn(response([
      { type: 'text', text: 'narration' },
      { type: 'tool_use', id: 'tool-2', name: 'send', input: {} },
    ])))
    expect(tools.select()).toEqual({ kind: 'empty', reason: 'tools_only' })

    const withheld = createTurnOutputCollector()
    withheld.observe(assistantTurn(response([{ type: 'text', text: '   ' }])))
    expect(withheld.select()).toEqual({ kind: 'empty', reason: 'text_withheld' })

    expect(createTurnOutputCollector().select()).toEqual({
      kind: 'empty',
      reason: 'no_model_output',
    })
  })
})

function scriptedProvider(scripts: StreamChunk[][]): LLMProvider {
  let turn = 0
  const next = (): AsyncIterable<StreamChunk> => {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(_messages: Message[], _options?: SendOptions) {
      return next()
    },
  }
  return {
    name: 'scripted',
    models: ['fixture-model'],
    stream: () => next(),
    createSession: (_options: SessionOptions) => session,
  }
}

const context: ToolContext = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'turn-output-test',
  channelType: 'assistant-call',
  channelId: 'channel-1',
  abortSignal: new AbortController().signal,
}

const textChunks = (text: string, stopReason: StopReason = 'end_turn'): StreamChunk[] => [
  { type: 'message_start', model: 'fixture-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason, usage: { inputTokens: 2, outputTokens: 2 } },
]

const emptyChunks: StreamChunk[] = [
  { type: 'message_start', model: 'fixture-model' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 0 } },
]

const questionChunks: StreamChunk[] = [
  { type: 'message_start', model: 'fixture-model' },
  { type: 'tool_use_start', id: 'question-1', name: 'askQuestion' },
  { type: 'tool_use_delta', id: 'question-1', input: '{"question":"Which one?","options":["A","B"]}' },
  { type: 'tool_use_end', id: 'question-1' },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 2 } },
]

const rescueChunks: StreamChunk[] = [
  { type: 'message_start', model: 'fixture-model' },
  { type: 'text_delta', text: 'I should call a tool.' },
  { type: 'tool_use_start', id: 'missing-1', name: 'missingTool' },
  { type: 'tool_use_delta', id: 'missing-1', input: '{}' },
  { type: 'tool_use_end', id: 'missing-1' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } },
]

async function run(eventsFor: StreamChunk[][], tools = new Map(), maxTurns = 4): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const event of queryLoop({
    ledger: NOOP_TURN_LEDGER,
    provider: scriptedProvider(eventsFor),
    model: 'fixture-model',
    systemPrompt: 'Answer the user.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools,
    context,
    maxTurns,
  })) {
    events.push(event)
  }
  return events
}

function expectCompleteResponseWasYielded(events: QueryEvent[]): void {
  const completeIndex = events.findIndex((event) => event.type === 'turn_complete')
  expect(completeIndex).toBeGreaterThan(-1)
  const complete = events[completeIndex]
  if (complete?.type !== 'turn_complete') throw new Error('expected turn_complete')
  const preceding = events
    .slice(0, completeIndex)
    .reverse()
    .find((event): event is Extract<QueryEvent, { type: 'assistant_turn' }> =>
      event.type === 'assistant_turn' && event.response === complete.response)
  expect(preceding).toBeDefined()
}

describe('[COMP:engine/turn-output] queryLoop terminal response contract', () => {
  const lookup = buildTool({
    name: 'listItems',
    description: 'List the current items.',
    inputSchema: z.object({}),
    async execute() { return { data: { items: ['Alpha', 'Beta', 'Gamma'] } } },
  })
  const lookupChunks = (id: string): StreamChunk[] => [
    { type: 'message_start', model: 'fixture-model' },
    { type: 'tool_use_start', id, name: 'listItems' },
    { type: 'tool_use_delta', id, input: '{}' },
    { type: 'tool_use_end', id },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 2 } },
  ]

  it.each<StopReason>(['incomplete', 'max_tokens'])(
    'replaces a %s draft when recovery resumes tools before synthesizing',
    async (stopReason) => {
      const draft = 'Three items:\n1. Alpha\n2. Beta\n3. Gamma'
      const replacement = 'The three current items are Alpha, Beta and Gamma.'
      const events = await run([
        lookupChunks('lookup-1'),
        textChunks(draft, stopReason),
        lookupChunks('lookup-2'),
        textChunks(replacement),
      ], new Map([['listItems', lookup]]))

      // Exercise the canonical selector with actual engine events for both
      // messaging and delegated/public output, retaining the transcript.
      for (const format of ['channel', 'compact'] as const) {
        const collector = createTurnOutputCollector({ format })
        for (const event of events) collector.observe(event)
        expect(collector.select()).toEqual({ kind: 'text', text: replacement })
      }
      expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(2)
      expect(events.filter((event) => event.type === 'assistant_turn')).toHaveLength(4)
      expect(events.some((event) => event.type === 'assistant_turn'
        && event.response.content.some((block) => block.type === 'text' && block.text === draft))).toBe(true)
      expectCompleteResponseWasYielded(events)
    },
  )

  it.each<StopReason>(['incomplete', 'max_tokens'])(
    'does not revive a %s draft when tool recovery ends empty',
    async (stopReason) => {
      const events = await run([
        lookupChunks('lookup-1'),
        textChunks('Three unfinished items: Alpha, Beta, Gamma', stopReason),
        lookupChunks('lookup-2'),
        emptyChunks,
      ], new Map([['listItems', lookup]]), 7)
      const collector = createTurnOutputCollector({ format: 'channel' })
      for (const event of events) collector.observe(event)
      expect(collector.select()).toEqual({ kind: 'empty', reason: 'tools_only' })
      expectCompleteResponseWasYielded(events)
    },
  )

  it.each<StopReason>(['incomplete', 'max_tokens'])(
    'preserves a %s fragment when recovery continues directly with text',
    async (stopReason) => {
      const events = await run([
        lookupChunks('lookup-1'),
        textChunks('First item: Alpha.', stopReason),
        textChunks('Second item: Beta.'),
      ], new Map([['listItems', lookup]]))
      for (const format of ['channel', 'compact'] as const) {
        const collector = createTurnOutputCollector({ format })
        for (const event of events) collector.observe(event)
        expect(collector.select()).toEqual({ kind: 'text', text: 'First item: Alpha.\nSecond item: Beta.' })
      }
      expectCompleteResponseWasYielded(events)
    },
  )

  it('yields the normal terminal response through assistant_turn first', async () => {
    expectCompleteResponseWasYielded(await run([textChunks('Done.')]))
  })

  it('yields the question terminal response through assistant_turn first', async () => {
    expectCompleteResponseWasYielded(await run(
      [questionChunks],
      new Map([['askQuestion', askQuestionTool]]),
    ))
  })

  it.each<StopReason>(['incomplete', 'max_tokens'])(
    'preserves the current question when a %s draft is retracted',
    async (stopReason) => {
      const events = await run(
        [textChunks('An unfinished answer', stopReason), questionChunks],
        new Map([['askQuestion', askQuestionTool]]),
      )
      const collector = createTurnOutputCollector()
      for (const event of events) collector.observe(event)
      expect(collector.select()).toMatchObject({
        kind: 'question',
        question: { question: 'Which one?', options: ['A', 'B'] },
      })
      expectCompleteResponseWasYielded(events)
    },
  )

  it('yields the exhausted empty response through assistant_turn first', async () => {
    expectCompleteResponseWasYielded(await run([emptyChunks]))
  })

  it('yields a terminal-rescue response through assistant_turn first', async () => {
    const events = await run([
      rescueChunks,
      textChunks('{"message":"I could not finish the tool action."}'),
    ])
    expectCompleteResponseWasYielded(events)
  })
})
