import type { LLMProvider, ProviderRequest, StreamChunk } from '../../providers/types.js'
import type { DecisionRequest } from '../types.js'

export function decisionRequest(): DecisionRequest {
  return {
    runId: 'run-fictional-1',
    operation: {
      id: 'fixture.intent',
      version: '1',
      stateVersion: '1',
      questionVersion: '1',
    },
    model: { catalogId: 'fixture-model', wireId: 'fixture-wire-v1' },
    state: { message: 'Please compare the fictional Acorn and Birch plans.' },
    questions: [{
      kind: 'choice',
      id: 'intent',
      prompt: 'Which bounded intent best matches the message?',
      options: [
        { value: 'ordinary', description: 'A normal request' },
        { value: 'research', description: 'A multi-source investigation' },
      ],
    }],
  }
}

export function llmProviderWithJson(json: unknown, calls: ProviderRequest[] = []): LLMProvider {
  const stream = async function* (request: ProviderRequest): AsyncIterable<StreamChunk> {
    calls.push(request)
    yield { type: 'message_start', model: request.model }
    yield { type: 'text_delta', text: JSON.stringify(json) }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 4 },
    }
  }
  return {
    name: 'fixture-llm',
    models: ['fixture-wire-v1'],
    stream,
    createSession: () => ({ send: async function* () {} }),
  }
}
