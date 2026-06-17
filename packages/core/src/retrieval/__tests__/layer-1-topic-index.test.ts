import { describe, it, expect } from 'vitest'
import {
  classifyTopicTags,
  assembleTopicBiasedMemoryIndex,
  runLayer1TopicIndex,
  type TopicAnalysis,
} from '../layer-1-topic-index.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import type { MemoryEntry } from '../../memory/context-builder.js'

function mockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    models: ['mock'],
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
    },
  } as unknown as LLMProvider
}

function throwingProvider(): LLMProvider {
  return {
    name: 'mock',
    models: ['mock'],
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    stream() {
      throw new Error('provider exploded')
    },
  } as unknown as LLMProvider
}

function mem(
  id: string,
  summary: string,
  tags: string[],
): MemoryEntry {
  // Post-Phase-4 (retire-memory-type): no `type` field on MemoryEntry.
  return { id, summary, tags, appId: null }
}

const baseAnalyzerOpts: {
  recentUserTurns: never[]
  currentMessage: string
  sessionHistoryTags: never[]
} = {
  recentUserTurns: [],
  currentMessage: 'hi',
  sessionHistoryTags: [],
}

describe('[COMP:retrieval/layer-1-topic] classifyTopicTags', () => {
  it('parses ranked tags + intent shift + confidence', async () => {
    const result = await classifyTopicTags({
      provider: mockProvider(
        '{"inferred_topic_tags":["domain:marketing","project:acme"],"inferred_intent_shift":"high","confidence":0.85}',
      ),
      model: 'mock',
      ...baseAnalyzerOpts,
    })
    expect(result.inferred_topic_tags).toEqual(['domain:marketing', 'project:acme'])
    expect(result.inferred_intent_shift).toBe('high')
    expect(result.confidence).toBe(0.85)
    expect(result.model).toBe('mock')
  })

  it('tolerates markdown fences around JSON', async () => {
    const result = await classifyTopicTags({
      provider: mockProvider(
        '```json\n{"inferred_topic_tags":["x"],"inferred_intent_shift":"low","confidence":0.5}\n```',
      ),
      model: 'mock',
      ...baseAnalyzerOpts,
    })
    expect(result.inferred_topic_tags).toEqual(['x'])
    expect(result.inferred_intent_shift).toBe('low')
  })

  it('falls back when JSON cannot be parsed', async () => {
    const result = await classifyTopicTags({
      provider: mockProvider('sorry, no JSON for you'),
      model: 'mock',
      ...baseAnalyzerOpts,
    })
    expect(result.inferred_topic_tags).toEqual([])
    expect(result.inferred_intent_shift).toBe('none')
    expect(result.confidence).toBe(0)
  })

  it('falls back when the provider call itself throws', async () => {
    const result = await classifyTopicTags({
      provider: throwingProvider(),
      model: 'mock',
      ...baseAnalyzerOpts,
    })
    expect(result.confidence).toBe(0)
    expect(result.usage).toBeNull()
    // No model echo when the call never reached the provider.
    expect(result.model).toBeUndefined()
  })

  it('clamps confidence and coerces invalid intent_shift to none', async () => {
    const result = await classifyTopicTags({
      provider: mockProvider(
        '{"inferred_topic_tags":["x"],"inferred_intent_shift":"sideways","confidence":2.5}',
      ),
      model: 'mock',
      ...baseAnalyzerOpts,
    })
    expect(result.confidence).toBe(1)
    expect(result.inferred_intent_shift).toBe('none')
  })

  it('normalizes + dedupes tags and caps at 3', async () => {
    const result = await classifyTopicTags({
      provider: mockProvider(
        '{"inferred_topic_tags":["  Domain:Marketing!  ","domain:marketing","Project Acme","Other","fifth"],"inferred_intent_shift":"none","confidence":0.6}',
      ),
      model: 'mock',
      ...baseAnalyzerOpts,
    })
    // First two collapse to the same normalized tag → 1 entry; "Project Acme"
    // → "project_acme"; "Other" → "other"; cap stops there at 3.
    expect(result.inferred_topic_tags).toEqual(['domain:marketing', 'project_acme', 'other'])
  })

  it('drops tags not in allowedTags when strict mode is requested', async () => {
    const result = await classifyTopicTags({
      provider: mockProvider(
        '{"inferred_topic_tags":["domain:marketing","domain:rogue"],"inferred_intent_shift":"none","confidence":0.5}',
      ),
      model: 'mock',
      ...baseAnalyzerOpts,
      allowedTags: ['domain:marketing', 'domain:sales'],
    })
    expect(result.inferred_topic_tags).toEqual(['domain:marketing'])
  })
})

describe('[COMP:retrieval/layer-1-topic] assembleTopicBiasedMemoryIndex', () => {
  const noSignal: TopicAnalysis = {
    inferred_topic_tags: [],
    inferred_intent_shift: 'none',
    confidence: 0,
  }

  it('returns empty for empty candidates', () => {
    const out = assembleTopicBiasedMemoryIndex({
      candidates: [],
      analysis: noSignal,
      sessionHistoryTags: [],
    })
    expect(out).toEqual([])
  })

  it('boosts tag-overlapping memories above non-overlapping ones (low intent shift)', () => {
    const candidates: MemoryEntry[] = [
      mem('a', 'general fact about cooking pasta dishes', []),
      mem('b', 'completely different subject about travel plans', []),
      mem('c', 'fact mentioning recent marketing campaign data', ['domain:marketing']),
    ]
    const out = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: {
        inferred_topic_tags: ['domain:marketing'],
        inferred_intent_shift: 'low',
        confidence: 0.7,
      },
      sessionHistoryTags: ['domain:marketing'],
      k: 3,
    })
    // Tag-matching row should be first despite being last by recency.
    expect(out[0].id).toBe('c')
  })

  it('boosts minority-topic content when intent_shift is high', () => {
    const candidates: MemoryEntry[] = [
      mem('hist1', 'pasta recipe one', ['domain:cooking']),
      mem('hist2', 'pasta recipe two', ['domain:cooking']),
      mem('hist3', 'pasta recipe three', ['domain:cooking']),
      // Minority — not in session history.
      mem('minor', 'launch press release note', ['domain:marketing']),
    ]
    const lowShift = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: {
        inferred_topic_tags: [],
        inferred_intent_shift: 'low',
        confidence: 0.5,
      },
      sessionHistoryTags: ['domain:cooking'],
      k: 4,
    })
    const highShift = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: {
        inferred_topic_tags: [],
        inferred_intent_shift: 'high',
        confidence: 0.8,
      },
      sessionHistoryTags: ['domain:cooking'],
      k: 4,
    })
    const minorLowIdx = lowShift.findIndex((m) => m.id === 'minor')
    const minorHighIdx = highShift.findIndex((m) => m.id === 'minor')
    // High shift pulls the minority-topic row earlier in the list.
    expect(minorHighIdx).toBeLessThan(minorLowIdx)
  })

  it('preserves input order when strength = 0 (no topic filter)', () => {
    const candidates: MemoryEntry[] = [
      mem('a', 'alpha fact about the alpha topic widely discussed', []),
      mem('b', 'beta context distinct from alpha gamma delta', ['domain:marketing']),
      mem('c', 'gamma matter unrelated to alpha or beta entirely', []),
    ]
    const out = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: {
        inferred_topic_tags: ['domain:marketing'],
        inferred_intent_shift: 'low',
        confidence: 0.9,
      },
      sessionHistoryTags: [],
      topicFilterStrength: 0,
      mmrLambda: 1, // pure relevance — no diversity reshuffling
      k: 3,
    })
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('MMR picks a diverse second when top is part of a near-duplicate cluster', () => {
    const candidates: MemoryEntry[] = [
      mem('dup1', 'budget spreadsheet quarterly review numbers analysis report', []),
      mem('dup2', 'budget spreadsheet quarterly review numbers analysis report', []),
      mem('diff', 'completely orthogonal travel itinerary tokyo kyoto plan', []),
    ]
    const out = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: noSignal,
      sessionHistoryTags: [],
      mmrLambda: 0.5,
      k: 2,
    })
    expect(out).toHaveLength(2)
    const ids = out.map((m) => m.id)
    expect(ids[0]).toBe('dup1')
    // The diverse row should be picked over the near-duplicate.
    expect(ids[1]).toBe('diff')
  })

  it('respects the k cap', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      mem(`m${i}`, `summary line number ${i} for testing purposes`, []),
    )
    const out = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: noSignal,
      sessionHistoryTags: [],
      k: 4,
    })
    expect(out).toHaveLength(4)
  })

  it('downweights non-matching rows but does NOT drop them (soft filter)', () => {
    const candidates: MemoryEntry[] = [
      mem('match', 'tag matching row first', ['domain:marketing']),
      mem('nomatch', 'untagged row that should still appear', []),
    ]
    const out = assembleTopicBiasedMemoryIndex({
      candidates,
      analysis: {
        inferred_topic_tags: ['domain:marketing'],
        inferred_intent_shift: 'low',
        confidence: 1,
      },
      sessionHistoryTags: [],
      topicFilterStrength: 1, // maximum soft strength
      k: 5,
    })
    // Both still present — soft filter never zeroes a candidate.
    expect(out.map((m) => m.id).sort()).toEqual(['match', 'nomatch'])
  })
})

describe('[COMP:retrieval/layer-1-topic] runLayer1TopicIndex', () => {
  it('classifies then assembles end-to-end', async () => {
    const candidates: MemoryEntry[] = [
      mem('a', 'cooking recipe note', ['domain:cooking']),
      mem('b', 'campaign briefing summary', ['domain:marketing']),
    ]
    const result = await runLayer1TopicIndex({
      provider: mockProvider(
        '{"inferred_topic_tags":["domain:marketing"],"inferred_intent_shift":"low","confidence":0.8}',
      ),
      model: 'mock',
      recentUserTurns: [],
      currentMessage: 'tell me about the campaign',
      sessionHistoryTags: ['domain:marketing'],
      candidates,
      k: 2,
    })
    expect(result.analysis.inferred_topic_tags).toEqual(['domain:marketing'])
    expect(result.memoryIndex[0].id).toBe('b')
  })

  it('degenerates to plain recency ordering when classifier falls back', async () => {
    const candidates: MemoryEntry[] = [
      mem('a', 'first row recency wins', ['domain:cooking']),
      mem('b', 'second row', ['domain:marketing']),
    ]
    const result = await runLayer1TopicIndex({
      provider: mockProvider('not json at all'),
      model: 'mock',
      recentUserTurns: [],
      currentMessage: 'hi',
      sessionHistoryTags: [],
      candidates,
      k: 2,
    })
    expect(result.analysis.confidence).toBe(0)
    expect(result.memoryIndex.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
