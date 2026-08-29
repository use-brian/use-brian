import { describe, expect, it, vi } from 'vitest'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { z } from 'zod'
import {
  createStallWatchdog,
  DEFAULT_STALL_IDLE_MS,
  isStalledError,
  StalledError,
  withStallSignal,
} from '../stall-watchdog.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'
import { NO_TOOL_TIMEOUT } from '../tool-executor.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import type { LLMProvider, ProviderRequest, StreamChunk } from '../../providers/types.js'
import { DEFAULT_FIRST_CHUNK_MS, DEFAULT_STREAM_IDLE_MS } from '../../providers/wrappers.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('[COMP:engine/stall-watchdog] progress-based liveness primitive', () => {
  it('fires after the idle window with no touches, aborting its signal with a StalledError', async () => {
    const onStall = vi.fn()
    const dog = createStallWatchdog({ idleMs: 40, onStall })
    expect(dog.stalled).toBeNull()
    await sleep(80)
    expect(dog.stalled).toMatchObject({ idleMs: 40, lastProgress: 'start' })
    expect(dog.signal.aborted).toBe(true)
    expect(isStalledError(dog.signal.reason)).toBe(true)
    expect(dog.error).toBeInstanceOf(StalledError)
    expect(dog.error?.message).toMatch(/stalled: no progress for 0s/)
    expect(onStall).toHaveBeenCalledTimes(1)
    dog.dispose()
  })

  it('every touch restarts the window - steady progress never stalls', async () => {
    const dog = createStallWatchdog({ idleMs: 60 })
    for (let i = 0; i < 5; i++) {
      await sleep(30)
      dog.touch(`model:text_delta#${i}`)
    }
    expect(dog.stalled).toBeNull()
    await sleep(100)
    expect(dog.stalled).toMatchObject({ lastProgress: 'model:text_delta#4' })
    dog.dispose()
  })

  it('pause() holds the clock (a wait on a human is not a stall) and resume() re-arms it', async () => {
    const dog = createStallWatchdog({ idleMs: 40 })
    dog.pause()
    await sleep(100)
    expect(dog.stalled).toBeNull()
    dog.resume()
    await sleep(80)
    expect(dog.stalled).not.toBeNull()
    dog.dispose()
  })

  it('touches and pauses propagate to the parent clock (nested loops keep their parent alive)', async () => {
    const parent = createStallWatchdog({ idleMs: 50 })
    const child = createStallWatchdog({ idleMs: 500, parent })
    for (let i = 0; i < 4; i++) {
      await sleep(30)
      child.touch('tool_end:patchPage')
    }
    expect(parent.stalled).toBeNull()
    child.pause()
    await sleep(120)
    expect(parent.stalled).toBeNull()
    child.resume()
    await sleep(120)
    expect(parent.stalled).not.toBeNull()
    child.dispose()
    parent.dispose()
  })

  it('dispose() stops the timer for good', async () => {
    const dog = createStallWatchdog({ idleMs: 30 })
    dog.dispose()
    await sleep(80)
    expect(dog.stalled).toBeNull()
    expect(dog.signal.aborted).toBe(false)
  })

  it('withStallSignal merges the parent abort with the watchdog and keeps the stall reason', async () => {
    const parent = new AbortController()
    const dog = createStallWatchdog({ idleMs: 30 })
    const merged = withStallSignal(parent.signal, dog)
    await sleep(70)
    expect(merged.aborted).toBe(true)
    expect(isStalledError(merged.reason)).toBe(true)
    dog.dispose()
  })

  it('the idle window is derived from the provider idle wrapper (two first-chunk windows), not configured', () => {
    // The watchdog must never pre-empt the layer that can retry a hung
    // stream: cold prefill window + its warm retry = the widest legitimate
    // silence, and no env knob exists to shorten or lengthen it.
    expect(DEFAULT_STALL_IDLE_MS).toBe(DEFAULT_FIRST_CHUNK_MS * 2)
    expect(DEFAULT_STALL_IDLE_MS).toBe(180_000)
    expect(DEFAULT_STALL_IDLE_MS).toBeGreaterThan(DEFAULT_STREAM_IDLE_MS)
    expect(process.env.AGENT_STALL_IDLE_MS).toBeUndefined()
  })
})

// ── Loop integration ───────────────────────────────────────────

const baseContext: ToolContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

/** A provider whose stream honours its abort signal (as a real fetch does) but otherwise never yields. */
function hangingProvider(): LLMProvider {
  return {
    name: 'hanging',
    models: ['m'],
    async *stream(request: ProviderRequest) {
      yield { type: 'message_start', model: 'm' } as StreamChunk
      await new Promise<never>((_, reject) => {
        if (request.signal?.aborted) reject(request.signal.reason)
        request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
      })
    },
    createSession() {
      throw new Error('stateless only')
    },
  }
}

function toolCallThenText(toolName: string): LLMProvider {
  let call = 0
  return {
    name: 'scripted',
    models: ['m'],
    async *stream() {
      const chunks: StreamChunk[] = call++ === 0
        ? [
            { type: 'message_start', model: 'm' },
            { type: 'tool_use_start', id: 't1', name: toolName },
            { type: 'tool_use_delta', id: 't1', input: '{}' },
            { type: 'tool_use_end', id: 't1' },
            { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
          ]
        : [
            { type: 'message_start', model: 'm' },
            { type: 'text_delta', text: 'done' },
            { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
          ]
      for (const c of chunks) yield c
    },
    createSession() {
      throw new Error('stateless only')
    },
  }
}

async function collect(events: AsyncIterable<QueryEvent>): Promise<QueryEvent[]> {
  const out: QueryEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('[COMP:engine/stall-watchdog] query loop under stallIdleMs', () => {
  it('a provider that goes silent past the idle window ends the loop with a typed StalledError', async () => {
    const events = await collect(queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: hangingProvider(),
      model: 'm',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: new Map(),
      context: baseContext,
      stateless: true,
      stallIdleMs: 60,
    }))
    const error = events.find((e) => e.type === 'error') as Extract<QueryEvent, { type: 'error' }> | undefined
    expect(error).toBeDefined()
    expect(isStalledError(error!.error)).toBe(true)
    expect(error!.error.message).toMatch(/stalled: no progress/)
  })

  it('a tool that ignores its abort signal and sits silent is abandoned when the watchdog fires; the loop ends typed', async () => {
    let toolStarted = false
    const stuck = buildTool({
      name: 'stuck',
      description: 'never returns and ignores abort',
      inputSchema: z.object({}),
      timeoutMs: NO_TOOL_TIMEOUT,
      async execute() {
        toolStarted = true
        await new Promise(() => {})
        return { data: 'unreachable' }
      },
    })
    const started = Date.now()
    const events = await collect(queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: toolCallThenText('stuck'),
      model: 'm',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: new Map([['stuck', stuck]]),
      context: baseContext,
      stateless: true,
      stallIdleMs: 80,
    }))
    expect(toolStarted).toBe(true)
    // Returned promptly - not pinned on the stuck promise.
    expect(Date.now() - started).toBeLessThan(2_000)
    const error = events.find((e) => e.type === 'error') as Extract<QueryEvent, { type: 'error' }> | undefined
    expect(error).toBeDefined()
    expect(isStalledError(error!.error)).toBe(true)
  })

  it('a slow tool that reports progress through context.progress keeps the loop alive', async () => {
    const slowButAlive = buildTool({
      name: 'slow',
      description: 'works for a while, touching progress',
      inputSchema: z.object({}),
      timeoutMs: NO_TOOL_TIMEOUT,
      async execute(_input, context) {
        for (let i = 0; i < 6; i++) {
          await sleep(30)
          context.progress?.touch(`slow:step${i}`)
        }
        return { data: 'finished' }
      },
    })
    const events = await collect(queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: toolCallThenText('slow'),
      model: 'm',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: new Map([['slow', slowButAlive]]),
      context: baseContext,
      stateless: true,
      stallIdleMs: 90, // < the tool's 180ms total, > its 30ms progress cadence
    }))
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(true)
  })

  it('a nested loop under a stall watchdog forwards its progress to the parent clock', async () => {
    const parent = createStallWatchdog({ idleMs: 90 })
    const inner = buildTool({
      name: 'child',
      description: 'runs a child loop that streams for a while',
      inputSchema: z.object({}),
      timeoutMs: NO_TOOL_TIMEOUT,
      async execute(_input, context) {
        const drip: LLMProvider = {
          name: 'drip',
          models: ['m'],
          async *stream() {
            yield { type: 'message_start', model: 'm' } as StreamChunk
            for (let i = 0; i < 6; i++) {
              await sleep(30)
              yield { type: 'text_delta', text: 'x' } as StreamChunk
            }
            yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk
          },
          createSession() {
            throw new Error('stateless only')
          },
        }
        await collect(queryLoop({ ledger: NOOP_TURN_LEDGER,
          provider: drip,
          model: 'm',
          systemPrompt: 'child',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          tools: new Map(),
          context,
          stateless: true,
          stallIdleMs: 500,
        }))
        return { data: 'child done' }
      },
    })
    const events = await collect(queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: toolCallThenText('child'),
      model: 'm',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: new Map([['child', inner]]),
      context: { ...baseContext, progress: parent },
      stateless: true,
    }))
    expect(parent.stalled).toBeNull()
    expect(events.some((e) => e.type === 'error')).toBe(false)
    parent.dispose()
  })
})
