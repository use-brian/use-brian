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
import { queryLoop, isConnectionDropError, isEndpointUnreachableError, streamErrorCode, streamErrorCodes, type QueryEvent } from '../query-loop.js'

// ── Scripted provider with per-turn behaviour ──────────────────
//
// Each turn either yields a normal stream of chunks or throws the supplied
// error before/during iteration — letting us reproduce a `wrapIdleTimeout`
// abort, a network blip, or a partial-stream stall.

type TurnScript =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'throwBefore'; error: Error }
  | { kind: 'throwAfter'; chunks: StreamChunk[]; error: Error }

type SendCall = { messages: Message[]; sendOpts?: SendOptions }

function scriptedProvider(scripts: TurnScript[]): {
  provider: LLMProvider
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  let turn = 0

  function streamNext(): AsyncIterable<StreamChunk> {
    const script = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      if (script.kind === 'throwBefore') throw script.error
      for (const chunk of script.chunks) yield chunk
      if (script.kind === 'throwAfter') throw script.error
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

async function runLoop(provider: LLMProvider): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({ ledger: NOOP_TURN_LEDGER,
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    tools: new Map([['echo', echoTool]]),
    context: baseContext,
    maxTurns: 5,
  })) {
    events.push(e)
  }
  return events
}

describe('[COMP:engine/query-loop] Transient stream retry', () => {
  it('retries once on "Stream idle" and recovers', async () => {
    // Repro: production incident 2026-05-06 — Gemini fetch hung 30s,
    // wrapIdleTimeout threw, the chat route surfaced "I couldn't generate
    // a response" because the loop bailed without retry.
    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: new Error('Stream idle for 30000ms') },
      { kind: 'chunks', chunks: textChunks('back from the stall') },
    ])

    const events = await runLoop(provider)

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('back from the stall')

    // Status event surfaces to the consumer so the user sees something
    // is happening during the 2s backoff.
    expect(
      events.some(
        (e) => e.type === 'status' && e.message === 'Connection stalled, retrying...',
      ),
    ).toBe(true)

    // Two send() calls — the failed one plus the retry. Both received the
    // same nextMessages (the original user turn, since we failed on turn 0
    // before phase 5 builds the next-turn payload).
    expect(calls).toHaveLength(2)
    expect(calls[0].messages).toEqual(calls[1].messages)
  })

  // 3 sub-cases × 2s backoff = 6s; bump the per-test timeout above the 5s default.
  it('retries on ECONNRESET / 503 / "socket hang up"', { timeout: 10_000 }, async () => {
    for (const errMsg of ['read ECONNRESET', '503 Service Unavailable', 'socket hang up']) {
      const { provider, calls } = scriptedProvider([
        { kind: 'throwBefore', error: new Error(errMsg) },
        { kind: 'chunks', chunks: textChunks('ok') },
      ])

      const events = await runLoop(provider)
      const text = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.type === 'text_delta' ? e.text : ''))
        .join('')
      expect(text, `expected recovery for ${errMsg}`).toBe('ok')
      expect(calls).toHaveLength(2)
    }
  })

  it('retries when only err.code says ECONNRESET (message is just "aborted")', { timeout: 10_000 }, async () => {
    // Repro: production incident 2026-08-27 — Node's node:https
    // ConnResetException has message "aborted" and code ECONNRESET; the
    // message-only regex never matched, so a custom-LLM connection reset
    // killed a 5-minute turn without a retry.
    const resetErr = new Error('aborted') as NodeJS.ErrnoException
    resetErr.code = 'ECONNRESET'
    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: resetErr },
      { kind: 'chunks', chunks: textChunks('ok') },
    ])

    const events = await runLoop(provider)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('retries when the socket code is nested in err.cause (undici shape)', { timeout: 10_000 }, async () => {
    const socketErr = new Error('other side closed') as NodeJS.ErrnoException
    socketErr.code = 'UND_ERR_SOCKET'
    const wrapped = new Error('terminated', { cause: socketErr })
    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: wrapped },
      { kind: 'chunks', chunks: textChunks('ok') },
    ])

    const events = await runLoop(provider)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('does not retry after a chunk has streamed to the consumer', async () => {
    // A mid-stream stall AFTER the model already started yielding text:
    // retrying would re-render the same prefix in the UI, so the loop
    // surfaces the error instead.
    const partialChunks: StreamChunk[] = [
      { type: 'message_start', model: 'mock-model' },
      { type: 'text_delta', text: 'partial output ' },
    ]
    const { provider, calls } = scriptedProvider([
      { kind: 'throwAfter', chunks: partialChunks, error: new Error('Stream idle for 30000ms') },
    ])

    const events = await runLoop(provider)

    // The partial text was yielded, then the loop emitted an error event
    // and exited without retrying.
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('partial output ')

    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'status')).toBe(false)
    expect(calls).toHaveLength(1) // no retry attempt
  })

  it('does not retry on AbortError (user cancelled)', async () => {
    const abortErr = new Error('Aborted')
    abortErr.name = 'AbortError'

    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: abortErr },
    ])

    const events = await runLoop(provider)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(calls).toHaveLength(1) // no retry — user is gone
  })

  it('does not retry non-transient errors (e.g. 401 / schema validation)', async () => {
    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: new Error('401 invalid api key') },
    ])

    const events = await runLoop(provider)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('refreshes the retry budget per turn — a stall on the post-tool-result turn still recovers', { timeout: 10_000 }, async () => {
    // Repro: production incident 2026-06-10 (session ab96e27e, user 99c7fb99).
    // A .docx dropped into a long doc-editor session idled turn 0 (>30s prefill
    // TTFT on the oversized prompt). The warm-cache retry recovered and the
    // model called a read tool (getCurrentPage). The *next* turn re-prefilled
    // the now-larger prompt and idled the same way — but the single transient
    // retry was loop-global and already spent on turn 0, so the post-tool-result
    // stall surfaced as query_loop_error with no reply. Each turn's stall is an
    // independent transient; the budget must refresh once a turn completes.
    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: new Error('Stream idle for 30000ms') }, // turn 0: cold-prefill idle
      { kind: 'chunks', chunks: toolCallChunks('call_1', 'hi') },            // retry recovers → tool call
      { kind: 'throwBefore', error: new Error('Stream idle for 30000ms') }, // post-tool-result turn idles
      { kind: 'chunks', chunks: textChunks('recovered after the second stall') }, // retry recovers
    ])

    const events = await runLoop(provider)

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('recovered after the second stall')
    expect(events.some((e) => e.type === 'error')).toBe(false)

    // Two stalls, each followed by a recovering retry: 4 send() calls.
    expect(calls).toHaveLength(4)
    // Two distinct "retrying" statuses — one per stall.
    expect(
      events.filter(
        (e) => e.type === 'status' && e.message === 'Connection stalled, retrying...',
      ),
    ).toHaveLength(2)
  })

  it('gives up after one retry — caps cost on a sustained outage', async () => {
    const { provider, calls } = scriptedProvider([
      { kind: 'throwBefore', error: new Error('Stream idle for 30000ms') },
      { kind: 'throwBefore', error: new Error('Stream idle for 30000ms') },
      { kind: 'chunks', chunks: textChunks('would have worked') }, // never reached
    ])

    const events = await runLoop(provider)

    // Loop bails on the second consecutive idle timeout.
    expect(events.some((e) => e.type === 'error')).toBe(true)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('')
    expect(calls).toHaveLength(2) // initial + one retry, then give up
  })
})

describe('[COMP:engine/query-loop] Connection-drop classification', () => {
  it('streamErrorCode reads the code off the error or its cause chain', () => {
    const bare = new Error('aborted') as NodeJS.ErrnoException
    bare.code = 'ECONNRESET'
    expect(streamErrorCode(bare)).toBe('ECONNRESET')

    const nested = new Error('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })
    expect(streamErrorCode(nested)).toBe('UND_ERR_SOCKET')

    expect(streamErrorCode(new Error('plain'))).toBeUndefined()
    expect(streamErrorCode('not an error')).toBeUndefined()
  })

  it('streamErrorCodes collects the whole chain — an SDK code cannot mask a nested socket code', () => {
    const wrapper = new Error('request failed', {
      cause: Object.assign(new Error('aborted'), { code: 'ECONNRESET' }),
    }) as NodeJS.ErrnoException
    wrapper.code = 'insufficient_quota'
    expect(streamErrorCodes(wrapper)).toEqual(['insufficient_quota', 'ECONNRESET'])
    expect(isConnectionDropError(wrapper)).toBe(true)

    // A plain-object cause counts too — not every thrower wraps in an Error.
    const plainCause = new Error('terminated', { cause: { code: 'ECONNRESET' } })
    expect(streamErrorCodes(plainCause)).toEqual(['ECONNRESET'])

    // A cyclic cause chain terminates.
    const cyclic = new Error('a') as Error & { cause?: unknown }
    cyclic.cause = cyclic
    expect(streamErrorCodes(cyclic)).toEqual([])
  })

  it('isEndpointUnreachableError: ENOTFOUND/ECONNREFUSED are unreachable, not a drop', () => {
    const dns = new Error('getaddrinfo ENOTFOUND llm.example') as NodeJS.ErrnoException
    dns.code = 'ENOTFOUND'
    expect(isEndpointUnreachableError(dns)).toBe(true)
    expect(isConnectionDropError(dns)).toBe(false)

    const refused = new Error('connect ECONNREFUSED 203.0.113.7:443') as NodeJS.ErrnoException
    refused.code = 'ECONNREFUSED'
    expect(isEndpointUnreachableError(refused)).toBe(true)
    expect(isConnectionDropError(refused)).toBe(false)

    const reset = new Error('aborted') as NodeJS.ErrnoException
    reset.code = 'ECONNRESET'
    expect(isEndpointUnreachableError(reset)).toBe(false)

    const userAbort = new Error('Aborted')
    userAbort.name = 'AbortError'
    expect(isEndpointUnreachableError(userAbort)).toBe(false)
  })

  it('isConnectionDropError: socket resets yes, aborts and app errors no', () => {
    const reset = new Error('aborted') as NodeJS.ErrnoException
    reset.code = 'ECONNRESET'
    expect(isConnectionDropError(reset)).toBe(true)
    expect(isConnectionDropError(new Error('socket hang up'))).toBe(true)
    expect(isConnectionDropError(new Error('fetch failed'))).toBe(true)

    const userAbort = new Error('Aborted')
    userAbort.name = 'AbortError'
    expect(isConnectionDropError(userAbort)).toBe(false)
    expect(isConnectionDropError(new Error('401 invalid api key'))).toBe(false)
    // Gateway 5xx is transient (retried) but NOT a connection drop — the
    // endpoint answered, so "please retry" copy would be misleading there.
    expect(isConnectionDropError(new Error('503 Service Unavailable'))).toBe(false)
  })
})
