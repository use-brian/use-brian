/**
 * Reclassifier — extract decision + `noOpinion` count + age-filter opt-in.
 *
 * Focused unit tests for the parts of `runReclassification` that
 * shipped with the 2026-05-28 brain-heal fix:
 *   * "extract" decision: one row per `extract_targets` entry, never
 *     auto-applied, target_kind carries the proposed primitive bucket.
 *   * `noOpinion` count: memories the LLM omitted from its output are
 *     surfaced as a separate bucket so the chat-side report doesn't
 *     paraphrase "kept by silence" as "brain is optimal".
 *   * `filterMemoriesForReclassification({ includeRecent: true })`:
 *     drops the 24h guardrail for user-initiated heal.
 *
 * [COMP:brain/reclassifier]
 */

import { describe, it, expect, vi } from 'vitest'
import {
  runReclassification,
  filterMemoriesForReclassification,
  type MemoryForReclassification,
  type ReclassificationDeps,
} from '../reclassifier.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import type {
  BrainCandidateCreateParams,
  BrainCandidateStore,
} from '../../brain/candidates-types.js'

function makeProvider(rawJson: string): LLMProvider {
  async function* stream(): AsyncIterable<StreamChunk> {
    yield { type: 'message_start', model: 'gemini-flash' }
    yield { type: 'text_delta', text: rawJson }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
    }
  }
  return {
    name: 'mock',
    models: ['gemini-flash'],
    stream: vi.fn(() => stream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

function makeCandidates(): {
  store: BrainCandidateStore
  calls: BrainCandidateCreateParams[]
} {
  const calls: BrainCandidateCreateParams[] = []
  const store: BrainCandidateStore = {
    async enqueue(params) {
      calls.push(params)
      return { id: `cand_${calls.length}` }
    },
    async listPending() {
      return []
    },
    async listRecent() {
      return []
    },
    async getById() {
      return null
    },
    async markApplied() {
      return null
    },
    async markDismissed() {
      return null
    },
    async markUndone() {
      return null
    },
  }
  return { store, calls }
}

function memory(id: string, summary: string, createdAt = new Date('2025-01-01')): MemoryForReclassification {
  return {
    id,
    summary,
    detail: null,
    tags: [],
    scope: 'shared',
    sensitivity: 'internal',
    workspaceId: 'ws_1',
    userId: 'u_1',
    assistantId: 'a_1',
    createdByUserId: 'u_1',
    createdByAssistantId: 'a_1',
    createdAt,
  }
}

function unusedStore<T>(): T {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`unexpected call to mock store: ${String(prop)}`)
      },
    },
  ) as T
}

const baseDeps = (
  candidatesStore: BrainCandidateStore,
  rawLlmOutput: string,
  memories: MemoryForReclassification[],
): ReclassificationDeps => ({
  memories,
  entities: [],
  workspaceId: 'ws_1',
  actorUserId: 'u_1',
  actorAssistantId: 'a_1',
  memoryStore: unusedStore(),
  taskStore: unusedStore(),
  entityLinks: unusedStore(),
  candidates: candidatesStore,
  provider: makeProvider(rawLlmOutput),
  model: 'gemini-flash',
})

describe('[COMP:brain/reclassifier] extract decision', () => {
  it('enqueues one candidate per target — multi-entity memory spawns multiple rows', async () => {
    const { store, calls } = makeCandidates()
    const llmJson = JSON.stringify({
      decisions: [
        {
          memory_id: 'm_1',
          decision: 'extract',
          extract_targets: [
            {
              kind: 'crm_contact',
              display_name: 'Harry Ho',
              summary: 'Founder and MD of AOGB Professional Services Group',
            },
            { kind: 'entity', display_name: 'AOGB Professional Services Group', entity_kind: 'company' },
            { kind: 'entity', display_name: 'The Chinese University of Hong Kong', entity_kind: 'company' },
          ],
          reason: 'memory bundles a person plus two organizations',
          confidence: 0.9,
        },
      ],
    })

    const result = await runReclassification(
      baseDeps(store, llmJson, [memory('m_1', 'Harry Ho founded AOGB and went to CUHK')]),
    )

    expect(result.enqueuedExtract).toBe(3)
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.suggestedAction)).toEqual(['extract', 'extract', 'extract'])
    expect(calls.every((c) => c.autoApplied === false)).toBe(true)
    expect(calls.map((c) => c.targetKind)).toEqual(['crm_contact', 'entity', 'entity'])
    expect(calls.every((c) => c.targetId == null)).toBe(true)

    const firstValue = calls[0].suggestedValue as { kind: string; displayName: string; summary?: string }
    expect(firstValue.kind).toBe('crm_contact')
    expect(firstValue.displayName).toBe('Harry Ho')
    expect(firstValue.summary).toContain('AOGB')
  })

  it('counts the unresolved bucket when extract_targets is empty', async () => {
    const { store, calls } = makeCandidates()
    const llmJson = JSON.stringify({
      decisions: [
        {
          memory_id: 'm_1',
          decision: 'extract',
          extract_targets: [],
          reason: 'forgot to fill targets',
        },
      ],
    })

    const result = await runReclassification(
      baseDeps(store, llmJson, [memory('m_1', 'whatever')]),
    )

    expect(result.enqueuedExtract).toBe(0)
    expect(result.unresolvedTargets).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('tracks `noOpinion` for memories the LLM silently omitted', async () => {
    const { store } = makeCandidates()
    // 3 memories considered; LLM only emits a decision for one of them.
    const llmJson = JSON.stringify({
      decisions: [
        { memory_id: 'm_1', decision: 'keep', reason: 'looks fine' },
      ],
    })

    const result = await runReclassification(
      baseDeps(store, llmJson, [memory('m_1', 'one'), memory('m_2', 'two'), memory('m_3', 'three')]),
    )

    expect(result.kept).toBe(1)
    expect(result.noOpinion).toBe(2)
  })
})

describe('[COMP:brain/reclassifier] filterMemoriesForReclassification — includeRecent opt-in', () => {
  const now = new Date('2026-05-28T12:00:00Z')
  const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000)
  const thirtyHoursAgo = new Date(now.getTime() - 30 * 60 * 60 * 1000)

  const memories: MemoryForReclassification[] = [
    memory('recent', 'fresh', tenHoursAgo),
    memory('older', 'aged', thirtyHoursAgo),
  ]

  it('drops <24h memories by default (REM-attached path)', () => {
    const out = filterMemoriesForReclassification(memories, new Map(), now)
    expect(out.map((m) => m.id)).toEqual(['older'])
  })

  it('keeps <24h memories when includeRecent: true (user-initiated heal)', () => {
    const out = filterMemoriesForReclassification(memories, new Map(), now, {
      includeRecent: true,
    })
    expect(out.map((m) => m.id).sort()).toEqual(['older', 'recent'])
  })
})
