import { describe, it, expect } from 'vitest'
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
import type { PendingTurnInput, TurnInboxPort } from '../turn-inbox.js'

// ── Scripted provider ──────────────────────────────────────────
//
// One script per `send()`. `onChunk` fires as each chunk is handed to the
// loop, which is how a test drops a steer into the inbox *mid-stream*.

type SendCall = { messages: Message[]; sendOpts?: SendOptions }

function scriptedProvider(
  scripts: StreamChunk[][],
  onChunk?: (chunk: StreamChunk, turn: number) => void,
): { provider: LLMProvider; calls: SendCall[] } {
  const calls: SendCall[] = []
  let turn = 0

  function streamNext(): AsyncIterable<StreamChunk> {
    const script = scripts[Math.min(turn, scripts.length - 1)]
    const myTurn = turn
    turn++
    return (async function* () {
      for (const chunk of script) {
        onChunk?.(chunk, myTurn)
        yield chunk
      }
    })()
  }

  const session: ProviderSession = {
    send(messages: Message[], opts?: SendOptions) {
      calls.push({ messages, sendOpts: opts })
      return streamNext()
    },
  }

  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream: () => streamNext(),
      createSession: (_o: SessionOptions) => session,
    },
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
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

const textChunks = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

const toolCallChunks = (id: string, msg: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id, name: 'echo' },
  { type: 'tool_use_delta', id, input: JSON.stringify({ msg }) },
  { type: 'tool_use_end', id },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
]

/** Test double for the port the chat route backs with its NOTIFY-fed registry. */
function testInbox(initial: PendingTurnInput[] = []): TurnInboxPort & {
  add: (input: PendingTurnInput) => void
} {
  let waiting = [...initial]
  return {
    add: (i) => { waiting.push(i) },
    peek: () => ({
      pending: waiting.length > 0,
      steer: waiting.some((i) => i.mode === 'steer'),
    }),
    drain: () => {
      const out = waiting
      waiting = []
      return out
    },
  }
}

const queued = (text: string, id = 'in-1'): PendingTurnInput => ({
  id, text, mode: 'queued', receivedAt: Date.now(),
})
const steer = (text: string, id = 'in-1'): PendingTurnInput => ({
  id, text, mode: 'steer', receivedAt: Date.now(),
})

async function collect(
  opts: Parameters<typeof queryLoop>[0],
): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop(opts)) events.push(e)
  return events
}

const baseOptions = (provider: LLMProvider, inbox: TurnInboxPort) => ({
  provider,
  model: 'mock-model',
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: new Map([['echo', echoTool]]),
  context: baseContext,
  maxTurns: 6,
  turnInbox: inbox,
})

const textOf = (m: Message): string => {
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
    .map((b) => b.text)
    .join('\n')
}

describe('[COMP:engine/query-loop] Mid-turn input drain points', () => {
  it('takes a queued message at the turn boundary, alongside the tool results', async () => {
    const inbox = testInbox()
    const { provider, calls } = scriptedProvider(
      [toolCallChunks('t1', 'first'), textChunks('done')],
      (chunk) => {
        // Arrives while the model is calling a tool — the classic case.
        if (chunk.type === 'tool_use_end') inbox.add(queued('also check Jack'))
      },
    )

    const events = await collect(baseOptions(provider, inbox))

    const applied = events.find((e) => e.type === 'turn_input')
    expect(applied).toBeDefined()
    expect(applied?.type === 'turn_input' && applied.mode).toBe('queued')

    // Second send carries the tool results AND the queued message in one
    // user-role message — no extra round trip.
    const second = calls[1].messages[calls[1].messages.length - 1]
    expect(second.role).toBe('user')
    expect(textOf(second)).toContain('also check Jack')
    expect(
      Array.isArray(second.content) &&
        second.content.some((b) => b.type === 'tool_result'),
    ).toBe(true)
  })

  it('takes a message that lands at the terminal boundary and keeps going', async () => {
    // The "sent it just as the answer arrived" case: without the terminal
    // drain this falls back to a whole fresh turn.
    const inbox = testInbox()
    const { provider, calls } = scriptedProvider(
      [textChunks('here is the answer'), textChunks('and about Jack...')],
      (chunk, turn) => {
        if (turn === 0 && chunk.type === 'message_end') inbox.add(queued('what about Jack?'))
      },
    )

    const events = await collect(baseOptions(provider, inbox))

    expect(events.filter((e) => e.type === 'turn_input')).toHaveLength(1)
    // The loop continued instead of exiting: a second model call happened and
    // exactly one terminal marker was emitted for the whole run.
    expect(calls).toHaveLength(2)
    expect(textOf(calls[1].messages[0])).toContain('what about Jack?')
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(1)
  })

  it('emits turn_input BEFORE the model is handed the text', async () => {
    // The consumer persists the user row on this event; it must not race the
    // reply that answers it.
    const inbox = testInbox()
    const order: string[] = []
    const { provider } = scriptedProvider(
      [textChunks('first answer'), textChunks('second answer')],
      (chunk, turn) => {
        if (turn === 0 && chunk.type === 'message_end') inbox.add(queued('follow-up'))
        if (turn === 1 && chunk.type === 'message_start') order.push('second-send')
      },
    )

    for await (const e of queryLoop(baseOptions(provider, inbox))) {
      if (e.type === 'turn_input') order.push('turn_input')
    }

    expect(order).toEqual(['turn_input', 'second-send'])
  })

  it('does nothing at all when no inbox is wired', async () => {
    const { provider, calls } = scriptedProvider([textChunks('plain answer')])
    const events = await collect({
      ...baseOptions(provider, testInbox()),
      turnInbox: undefined,
    })
    expect(events.some((e) => e.type === 'turn_input')).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('[COMP:engine/query-loop] Steer', () => {
  it('interrupts the in-flight response when nothing visible has streamed', async () => {
    const inbox = testInbox()
    const { provider, calls } = scriptedProvider(
      [
        // Turn 0: thinking only, then a long text the user never sees because
        // the steer lands first.
        [
          { type: 'message_start', model: 'mock-model' },
          { type: 'thinking_delta', text: 'considering the old plan' },
          { type: 'text_delta', text: 'THE ABANDONED ANSWER' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        textChunks('using last Friday then'),
      ],
      (chunk, turn) => {
        if (turn === 0 && chunk.type === 'thinking_delta') {
          inbox.add(steer('no, use last Friday'))
        }
      },
    )

    const events = await collect(baseOptions(provider, inbox))

    // The abandoned response never reached the consumer.
    const streamed = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(streamed).toBe('using last Friday then')
    expect(streamed).not.toContain('ABANDONED')

    // Re-entry re-sends the SAME payload (the provider never committed the
    // interrupted turn) with the steer folded into the trailing user message.
    expect(calls).toHaveLength(2)
    const resent = calls[1].messages[calls[1].messages.length - 1]
    expect(resent.role).toBe('user')
    expect(textOf(resent)).toContain('hello')
    expect(textOf(resent)).toContain('no, use last Friday')
    expect(textOf(resent)).toContain('mode="steer"')
  })

  it('waits for the next boundary once the reply is already on screen', async () => {
    const inbox = testInbox()
    const { provider, calls } = scriptedProvider(
      [
        [
          { type: 'message_start', model: 'mock-model' },
          { type: 'text_delta', text: 'partial answer ' },
          { type: 'text_delta', text: 'that must survive' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        textChunks('now redirecting'),
      ],
      (chunk, turn) => {
        // Steer arrives AFTER the first visible chunk.
        if (turn === 0 && chunk.type === 'text_delta' && chunk.text.startsWith('partial')) {
          inbox.add(steer('actually, stop'))
        }
      },
    )

    const events = await collect(baseOptions(provider, inbox))

    // The turn the user was watching finished intact...
    const streamed = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(streamed).toContain('partial answer that must survive')
    // ...and the steer was taken at the terminal boundary instead.
    expect(events.filter((e) => e.type === 'turn_input')).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(textOf(calls[1].messages[0])).toContain('actually, stop')
  })

  it('does not interrupt for a plain queued message', async () => {
    const inbox = testInbox()
    const { provider, calls } = scriptedProvider(
      [
        [
          { type: 'message_start', model: 'mock-model' },
          { type: 'thinking_delta', text: 'thinking' },
          { type: 'text_delta', text: 'the full first answer' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        textChunks('and the follow-up'),
      ],
      (chunk, turn) => {
        if (turn === 0 && chunk.type === 'thinking_delta') inbox.add(queued('one more thing'))
      },
    )

    const events = await collect(baseOptions(provider, inbox))

    const streamed = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(streamed).toContain('the full first answer')
    expect(calls).toHaveLength(2)
  })

  it('skips the plan-gate continuation for the turn a steer lands on', async () => {
    // The user redirected the work — forcing the model to finish the plan it
    // just abandoned burns budget on the wrong task.
    const inbox = testInbox()
    let planReads = 0
    const { provider } = scriptedProvider(
      [textChunks('first answer'), textChunks('redirected answer')],
      (chunk, turn) => {
        if (turn === 0 && chunk.type === 'message_end') inbox.add(steer('different direction'))
      },
    )

    await collect({
      ...baseOptions(provider, inbox),
      planGate: {
        status: async () => {
          planReads++
          return { open: 2, total: 3, openSteps: [{ key: 'a', description: 'x' }] }
        },
      },
    })

    // The first terminal evaluation consults the plan and nudges; the steer
    // interrupts that nudged turn; the terminal evaluation after it skips the
    // gate and the loop ends. One read, not two.
    expect(planReads).toBe(1)
  })
})
