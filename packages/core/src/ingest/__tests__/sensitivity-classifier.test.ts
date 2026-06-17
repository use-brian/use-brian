import { describe, it, expect, vi } from 'vitest'

import { AnalyticsLogger, type AnalyticsEvent, type AnalyticsStore } from '../../analytics/logger.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import type { Sensitivity } from '../../security/sensitivity.js'
import {
  classifySensitivity,
  type SensitivityClassifierInput,
} from '../sensitivity-classifier.js'

/**
 * Mock provider whose stream emits the given JSON as a single text_delta
 * followed by message_end. Mirrors the topic-classifier test helper.
 */
function mockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    models: ['mock'],
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

function throwingProvider(message: string): LLMProvider {
  return {
    name: 'mock',
    models: ['mock'],
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error(message)
    },
  } as unknown as LLMProvider
}

/** Capturing fake — only `record`/`recordBatch` are used by AnalyticsLogger. */
function fakeAnalyticsStore(): { store: AnalyticsStore; events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = []
  const store: AnalyticsStore = {
    async record(event) {
      events.push(event)
    },
    async recordBatch(batch) {
      events.push(...batch)
    },
    async getDailyReport() {
      throw new Error('not used in tests')
    },
    async getWeeklyReport() {
      throw new Error('not used in tests')
    },
    async pruneOldEvents() {
      throw new Error('not used in tests')
    },
    async listErrors() {
      throw new Error('not used in tests')
    },
    async summarizeErrors() {
      throw new Error('not used in tests')
    },
  }
  return { store, events }
}

function baseInput(overrides: Partial<SensitivityClassifierInput> = {}): SensitivityClassifierInput {
  return {
    episodeId: 'ep-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    assistantId: 'a-1',
    channelSensitivity: 'internal' as Sensitivity,
    summary: 'Conversation about Q3 planning and headcount.',
    memories: [{ summary: 'Team plans to hire two engineers next quarter.' }],
    ...overrides,
  }
}

describe('[COMP:brain/sensitivity-classifier] classifySensitivity', () => {
  it('parses inferred sensitivity and brief reason', async () => {
    const result = await classifySensitivity({
      provider: mockProvider(
        '{"inferred_sensitivity":"confidential","brief_reason":"discusses individual compensation"}',
      ),
      model: 'mock',
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    expect(result).not.toBeNull()
    expect(result!.inferredSensitivity).toBe('confidential')
    expect(result!.briefReason).toBe('discusses individual compensation')
    expect(result!.drifted).toBe(true)
    expect(result!.model).toBe('mock')
    expect(result!.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('logs a sensitivity_drift_flagged event when inferred > channel', async () => {
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const result = await classifySensitivity({
      provider: mockProvider(
        '{"inferred_sensitivity":"confidential","brief_reason":"HR performance review"}',
      ),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    await analytics.flush()

    expect(result?.drifted).toBe(true)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.eventName).toBe('sensitivity_drift_flagged')
    expect(ev.userId).toBe('u-1')
    expect(ev.assistantId).toBe('a-1')
    expect(ev.metadata).toMatchObject({
      episode_id: 'ep-1',
      workspace_id: 'ws-1',
      channel_sensitivity: 'internal',
      inferred_sensitivity: 'confidential',
      brief_reason: 'HR performance review',
    })
  })

  it('does NOT log when inferred equals channel', async () => {
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const result = await classifySensitivity({
      provider: mockProvider(
        '{"inferred_sensitivity":"internal","brief_reason":"routine planning"}',
      ),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    await analytics.flush()

    expect(result?.drifted).toBe(false)
    expect(events).toHaveLength(0)
  })

  it('does NOT log when inferred is lower than channel', async () => {
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const result = await classifySensitivity({
      provider: mockProvider(
        '{"inferred_sensitivity":"internal","brief_reason":"general project chat"}',
      ),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'confidential' }),
    })
    await analytics.flush()

    expect(result?.inferredSensitivity).toBe('internal')
    expect(result?.drifted).toBe(false)
    expect(events).toHaveLength(0)
  })

  it('tolerates ```json fences around the JSON object', async () => {
    const result = await classifySensitivity({
      provider: mockProvider(
        '```json\n{"inferred_sensitivity":"public","brief_reason":"public announcement draft"}\n```',
      ),
      model: 'mock',
      input: baseInput({ channelSensitivity: 'public' }),
    })
    expect(result?.inferredSensitivity).toBe('public')
    expect(result?.briefReason).toBe('public announcement draft')
  })

  it('returns null and does not log when the model returns an unknown sensitivity tier', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const result = await classifySensitivity({
      provider: mockProvider(
        '{"inferred_sensitivity":"top_secret","brief_reason":"classified ops"}',
      ),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    await analytics.flush()

    expect(result).toBeNull()
    expect(events).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns null and does not log when the response is not parseable JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const result = await classifySensitivity({
      provider: mockProvider('sorry, I cannot classify this'),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    await analytics.flush()

    expect(result).toBeNull()
    expect(events).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns null and does not log when the provider throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const result = await classifySensitivity({
      provider: throwingProvider('model unavailable'),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    await analytics.flush()

    expect(result).toBeNull()
    expect(events).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('truncates the brief reason to ≤200 characters before logging', async () => {
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    const longReason = 'a'.repeat(500)
    const result = await classifySensitivity({
      provider: mockProvider(
        `{"inferred_sensitivity":"confidential","brief_reason":"${longReason}"}`,
      ),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal' }),
    })
    await analytics.flush()

    expect(result?.briefReason.length).toBeLessThanOrEqual(200)
    expect(events).toHaveLength(1)
    const reason = events[0].metadata.brief_reason as string
    expect(reason.length).toBeLessThanOrEqual(200)
  })

  it('omits assistantId from the event when input.assistantId is null', async () => {
    const { store, events } = fakeAnalyticsStore()
    const analytics = new AnalyticsLogger(store, { flushIntervalMs: 1, maxBufferSize: 1 })

    await classifySensitivity({
      provider: mockProvider(
        '{"inferred_sensitivity":"confidential","brief_reason":"finance discussion"}',
      ),
      model: 'mock',
      analytics,
      input: baseInput({ channelSensitivity: 'internal', assistantId: null }),
    })
    await analytics.flush()

    expect(events).toHaveLength(1)
    expect(events[0].assistantId).toBeUndefined()
  })
})
