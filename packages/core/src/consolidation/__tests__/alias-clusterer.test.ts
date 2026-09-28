import { describe, expect, it, vi } from 'vitest'

import type { EntityKind, EntityRecord } from '../../entities/types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'
import { clusterEntityAliases } from '../alias-clusterer.js'

function entity(id: string, displayName: string, kind: EntityKind = 'company'): EntityRecord {
  return { id, displayName, kind, aliases: [] } as unknown as EntityRecord
}

function providerFor(json: string): LLMProvider {
  async function* stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'text_delta', text: json } as StreamChunk
  }
  return {
    name: 'mock',
    models: ['mock'],
    createSession: vi.fn(),
    stream: vi.fn(() => stream()),
  } as unknown as LLMProvider
}

describe('[COMP:brain/alias-clusterer] classifier cascade', () => {
  it('accepts a terminal no-cluster decision without invoking the LLM', async () => {
    const llm = providerFor('{"clusters":[]}')
    const result = await clusterEntityAliases({
      entities: [entity('e1', 'Example Co'), entity('e2', 'Different Co')],
      provider: llm,
      model: 'mock',
      workspaceId: 'w1',
      decisionRuntime: executionFixture({
        llm,
        primary: fixtureDecisionProvider(async (request) => ({
          providerId: 'fixture-decision',
          model: request.model,
          answers: [{
            questionId: 'has_alias_clusters',
            kind: 'boolean',
            value: false,
            pTrue: 0.01,
            evidence: { source: 'native_distribution', confidence: 0.99 },
          }],
        })),
      }),
    })
    expect(result).toEqual([])
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('uses one LLM completion and rejects overlapping or cross-kind transitive clusters', async () => {
    const llm = providerFor(JSON.stringify({
      clusters: [
        { canonical_id: 'e1', alias_ids: ['e2'], reasoning: 'Clear abbreviation.', confidence: 0.95 },
        { canonical_id: 'e2', alias_ids: ['e3'], reasoning: 'Overlaps the first cluster.', confidence: 0.9 },
        { canonical_id: 'e3', alias_ids: ['p1'], reasoning: 'Cross-kind collision.', confidence: 0.9 },
      ],
    }))
    const result = await clusterEntityAliases({
      entities: [
        entity('e1', 'Example Company'),
        entity('e2', 'Example Co'),
        entity('e3', 'Example Holdings'),
        entity('p1', 'Example Company', 'person'),
      ],
      provider: llm,
      model: 'mock',
      workspaceId: 'w1',
      decisionRuntime: executionFixture({
        llm,
        primary: fixtureDecisionProvider(async (request) => ({
          providerId: 'fixture-decision',
          model: request.model,
          answers: [{
            questionId: 'has_alias_clusters',
            kind: 'boolean',
            value: true,
            pTrue: 0.96,
            evidence: { source: 'native_distribution', confidence: 0.96 },
          }],
        })),
      }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ canonicalEntityId: 'e1', aliasEntityIds: ['e2'] })
    expect(llm.stream).toHaveBeenCalledTimes(1)
  })
})
