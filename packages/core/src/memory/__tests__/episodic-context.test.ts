import { describe, it, expect, vi } from 'vitest'
import { fetchEpisodicContext } from '../episodic-context.js'
import type { EpisodicStore, EpisodicMemoryRecord } from '../episodic-types.js'
import type { TopicClassification } from '../topic-classifier.js'

function record(topic: string, summary: string, daysAgo = 0): EpisodicMemoryRecord {
  return {
    id: `id-${topic}-${daysAgo}`,
    userId: 'u1',
    assistantId: 'a1',
    sessionId: 's1',
    topicLabel: topic,
    summary,
    messageSpan: { fromSequence: 1, toSequence: 2, turnCount: 2 },
    entityRefs: null,
    createdAt: new Date(Date.now() - daysAgo * 86400_000),
    lastAccessedAt: new Date(Date.now() - daysAgo * 86400_000),
    accessCount: 0,
    survivalCount: 0,
  }
}

function makeStore(rows: EpisodicMemoryRecord[]): EpisodicStore {
  return {
    create: vi.fn(),
    fetchByTopic: vi.fn(async ({ topicLabel, limit }) =>
      rows.filter((r) => r.topicLabel === topicLabel).slice(0, limit ?? 3),
    ),
    fetchBySession: vi.fn(async () => rows),
    listTopicsBySession: vi.fn(async () => Array.from(new Set(rows.map((r) => r.topicLabel)))),
    listBySession: vi.fn(async () => rows),
    deleteById: vi.fn(),
    incrementSurvivalCount: vi.fn(),
  }
}

describe('[COMP:memory/episodic-context] fetchEpisodicContext', () => {
  it('returns null for continue state (no injection needed)', async () => {
    const store = makeStore([record('x', 'something')])
    const c: TopicClassification = { topic_label: 'x', state: 'continue', confidence: 0.9 }
    const result = await fetchEpisodicContext({ store, sessionId: 's1', classification: c })
    expect(result).toBeNull()
  })

  it('returns null for shift state (no prior episodic rows possible)', async () => {
    const store = makeStore([])
    const c: TopicClassification = { topic_label: 'new topic', state: 'shift', confidence: 0.9 }
    const result = await fetchEpisodicContext({ store, sessionId: 's1', classification: c })
    expect(result).toBeNull()
  })

  it('returns null for zero-confidence / uncategorized', async () => {
    const store = makeStore([record('x', 'something')])
    const c: TopicClassification = { topic_label: '(uncategorized)', state: 'continue', confidence: 0 }
    const result = await fetchEpisodicContext({ store, sessionId: 's1', classification: c })
    expect(result).toBeNull()
  })

  it('returns null when the store has no matching rows', async () => {
    const store = makeStore([])
    const c: TopicClassification = { topic_label: 'x', state: 'resume', confidence: 0.8 }
    const result = await fetchEpisodicContext({ store, sessionId: 's1', classification: c })
    expect(result).toBeNull()
  })

  it('injects topic history on resume', async () => {
    const store = makeStore([
      record('brian', 'User confirmed Brian is Deloitte Tax Manager, CUHK grad'),
      record('brian', 'Earlier turn about Brian\'s education', 1),
    ])
    const c: TopicClassification = { topic_label: 'brian', state: 'resume', confidence: 0.9 }
    const result = await fetchEpisodicContext({ store, sessionId: 's1', classification: c })
    expect(result).not.toBeNull()
    expect(result).toContain('# Relevant topic history')
    expect(result).toContain('brian')
    expect(result).toContain('Deloitte Tax Manager')
  })

  it('merges active + related topics on cross-topic', async () => {
    const store = makeStore([
      record('brian', 'Brian works at Deloitte'),
      record('cyn', 'Cyn is a crypto KOL'),
    ])
    const c: TopicClassification = {
      topic_label: 'brian',
      state: 'cross-topic',
      confidence: 0.8,
      related_topics: ['cyn'],
    }
    const result = await fetchEpisodicContext({ store, sessionId: 's1', classification: c })
    expect(result).toContain('brian')
    expect(result).toContain('cyn')
    expect(result).toContain('Deloitte')
    expect(result).toContain('crypto KOL')
  })
})
