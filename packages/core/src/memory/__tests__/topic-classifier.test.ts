import { describe, it, expect } from 'vitest'
import { classifyTopic } from '../topic-classifier.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

/**
 * Build a minimal mock provider whose stream emits the given JSON as a
 * single text_delta. Used to exercise classifyTopic's parsing without
 * hitting a real model.
 */
function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
    },
  } as unknown as LLMProvider
}

describe('[COMP:memory/topic-classifier] classifyTopic', () => {
  it('parses a continue classification', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"brian cheng research","state":"continue","confidence":0.9}'),
      model: 'mock',
      recentUserTurns: [{ text: 'Tell me about Brian', topicLabel: 'brian cheng research' }],
      replyToText: null,
      currentMessage: 'what else does he do?',
      knownTopicsThisSession: ['brian cheng research'],
    })
    expect(result.topic_label).toBe('brian cheng research')
    expect(result.state).toBe('continue')
    expect(result.confidence).toBe(0.9)
  })

  it('parses shift state', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"movie discussion","state":"shift","confidence":0.8}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'what do you know about Eternal Sunshine?',
      knownTopicsThisSession: [],
    })
    expect(result.state).toBe('shift')
    expect(result.topic_label).toBe('movie discussion')
  })

  it('parses cross-topic and keeps related_topics', async () => {
    const result = await classifyTopic({
      provider: mockProvider(
        '{"topic_label":"brian cheng research","state":"cross-topic","confidence":0.85,"related_topics":["cyn birthday"]}',
      ),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'should I introduce Brian to Cyn?',
      knownTopicsThisSession: ['brian cheng research', 'cyn birthday'],
    })
    expect(result.state).toBe('cross-topic')
    expect(result.related_topics).toEqual(['cyn birthday'])
  })

  it('normalizes labels (lowercase + strip trailing punctuation)', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"  Brian Cheng Research!  ","state":"continue","confidence":0.7}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.topic_label).toBe('brian cheng research')
  })

  it('tolerates markdown fences around JSON', async () => {
    const result = await classifyTopic({
      provider: mockProvider('```json\n{"topic_label":"x","state":"continue","confidence":0.5}\n```'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.topic_label).toBe('x')
    expect(result.confidence).toBe(0.5)
  })

  it('falls back on parse failure', async () => {
    const result = await classifyTopic({
      provider: mockProvider('sorry, I cannot classify this'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.topic_label).toBe('(uncategorized)')
    expect(result.state).toBe('continue')
    expect(result.confidence).toBe(0)
  })

  it('clamps out-of-range confidence', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"x","state":"continue","confidence":2.5}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.confidence).toBe(1)
  })

  it('ignores unknown state and defaults to continue', async () => {
    const result = await classifyTopic({
      provider: mockProvider('{"topic_label":"x","state":"nonsense","confidence":0.6}'),
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.state).toBe('continue')
  })

  it('falls back when the provider throws', async () => {
    const provider = {
      createSession() {
        return { thoughtSignature: undefined } as never
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamChunk> {
        throw new Error('model unavailable')
      },
    } as unknown as LLMProvider
    const result = await classifyTopic({
      provider,
      model: 'mock',
      recentUserTurns: [],
      replyToText: null,
      currentMessage: 'hi',
      knownTopicsThisSession: [],
    })
    expect(result.confidence).toBe(0)
  })
})
