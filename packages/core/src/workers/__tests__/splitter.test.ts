import { describe, expect, it, vi } from 'vitest'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'
import { classifySplit } from '../splitter.js'

const MESSAGE = 'Compare the fictional Acorn and Birch markets, then separately map their regulatory risks.'

function providerWith(rawText: string): LLMProvider {
  async function* stream(): AsyncIterable<StreamChunk> {
    yield { type: 'message_start', model: 'fixture-llm' }
    yield { type: 'text_delta', text: rawText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 8 },
    }
  }
  return {
    name: 'fixture-llm',
    models: ['fixture-llm'],
    stream: vi.fn(() => stream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

describe('[COMP:workers/splitter] classifySplit', () => {
  it('preserves the LLM-only split result shape', async () => {
    const provider = providerWith('{"split":true,"tasks":["Research Acorn.","Research Birch."]}')
    const result = await classifySplit({ provider, message: MESSAGE })
    expect(result).toEqual({
      tasks: ['Research Acorn.', 'Research Birch.'],
      usage: { inputTokens: 20, outputTokens: 8 },
      model: 'fixture-llm',
    })
  })

  it('accepts a terminal no-split decision without an LLM call', async () => {
    const llm = providerWith('{"split":true,"tasks":["A","B"]}')
    const runtime = executionFixture({
      llm,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{
          kind: 'boolean',
          questionId: 'split',
          value: false,
          pTrue: 0.03,
          evidence: { source: 'native_distribution' },
        }],
      })),
    })

    const result = await classifySplit({ provider: llm, message: MESSAGE, decisionRuntime: runtime })

    expect(result.tasks).toBeNull()
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('uses exactly one LLM generation when the decision says to split', async () => {
    const llm = providerWith('{"split":true,"tasks":["Research Acorn.","Research Birch."]}')
    const runtime = executionFixture({
      llm,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{
          kind: 'boolean',
          questionId: 'split',
          value: true,
          pTrue: 0.96,
          evidence: { source: 'native_distribution' },
        }],
      })),
    })

    const result = await classifySplit({ provider: llm, message: MESSAGE, decisionRuntime: runtime })

    expect(result.tasks).toEqual(['Research Acorn.', 'Research Birch.'])
    expect(llm.stream).toHaveBeenCalledOnce()
  })

  it('rejects unbounded generated task lists', async () => {
    const provider = providerWith('{"split":true,"tasks":["A","B","C","D"]}')
    const result = await classifySplit({ provider, message: MESSAGE })
    expect(result.tasks).toBeNull()
  })
})
