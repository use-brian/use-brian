import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyTopic, createTopicIdentity, registerDecisionMetadataSink, type LLMProvider, type TopicClassifierOptions } from '@use-brian/core'
import { createDecisionAttemptUsageRecorder, createDecisionRuntime, type DecisionRuntimeAttempt } from '../decision-runtime.js'
import { createWorkspaceDecisionRouteResolver } from '../workspace-decision-routing.js'

const JEV = 'typesafe-jev-1.13', OPENAI = 'openai-decisions-gpt-6-luna'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native topic identity runtime integration', () => {
  it('never treats a version-1 approved profile as version-2 execution authority', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const llm = { name: 'fixture', models: [], createSession: vi.fn(), stream: vi.fn() } as unknown as LLMProvider
    const runtime = createDecisionRuntime({ llmProvider: llm, defaultLlmModel: 'fixture', typesafeApiKey: 'fictional-key',
      resolveRoute: () => ({ mode: 'hybrid', primaryModelId: JEV, profile: {
        id: 'fictional-approved-v1', version: '1', mode: 'hybrid', operationId: 'memory.topic',
        operationVersion: '1', stateVersion: '1', questionVersion: '1', modelCatalogId: JEV, modelWireId: 'jev-1.13.0',
        evaluationSegment: 'global', status: 'approved', evidence: 'recorded', totalTimeoutMs: 2000, primaryTimeoutMs: 1000, maxAttempts: 2,
      } }),
    })
    expect(await classifyTopic({ provider: llm, model: 'fixture', decisionRuntime: runtime,
      currentMessage: 'Consider the fictional Acorn proposal.', recentUserTurns: [], replyToText: null, knownTopicsThisSession: [],
    })).toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(fetch).not.toHaveBeenCalled()
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it.each([JEV, OPENAI])('%s allocates, continues, resumes and crosses exact keys without LLM naming', async selected => {
    const workspaceId = 'fictional-workspace'
    const llm = { name: 'fixture', models: [], createSession: vi.fn(), stream: vi.fn() } as unknown as LLMProvider
    const getSystem = vi.fn(async () => ({ workspaceId, mode: 'classifier_first' as const, modelAlias: selected, updatedAt: 'now' }))
    const attempts: DecisionRuntimeAttempt[] = [], states: unknown[] = []
    const metered = vi.fn(async () => {})
    const meter = createDecisionAttemptUsageRecorder({ recordUsage: metered } as never)
    const runtime = createDecisionRuntime({ llmProvider: llm, defaultLlmModel: 'fixture',
      typesafeApiKey: 'fictional-jev-key', openaiDecisionsApiKey: 'fictional-openai-key',
      resolveRoute: createWorkspaceDecisionRouteResolver({ store: { getSystem }, configuredAdapterIds: () => ['typesafe', 'openai-decisions'] }),
      onAttempt: registerDecisionMetadataSink(async (attempt: DecisionRuntimeAttempt) => { attempts.push(attempt); await meter(attempt) }),
    })
    let state = 'shift', topic = 'new'
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      const jev = selected === JEV
      expect(String(url)).toBe(jev ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.openai.com/v1/decisions')
      const input = jev ? request.state : JSON.parse(request.input)
      states.push(input)
      const questions: Array<{ id: string; choices?: string[] }> = jev
        ? Object.entries(request.questions).map(([id, q]) => ({ id, choices: (q as any).type === 'choice' ? Object.keys((q as any).criteria) : undefined }))
        : request.questions.map((q: any) => ({ id: q.name, choices: q.type === 'choice' ? q.choices.map((c: any) => c.value) : undefined }))
      const value = (id: string) => id === 'state' ? state : topic
      const answers = questions.map(q => q.choices
        ? jev ? { type: 'choice', choice: value(q.id), confidence: 1, probabilities: Object.fromEntries(q.choices.map(c => [c, c === value(q.id) ? 1 : 0])) }
          : { name: q.id, type: 'choice', choice: value(q.id), confidence: 1, probabilities: q.choices.map(c => ({ value: c, probability: c === value(q.id) ? 1 : 0 })) }
        : jev ? { type: 'noul', noul: 1 } : { name: q.id, type: 'predicate', probability: 1 })
      return new Response(JSON.stringify({ model: jev ? 'jev-1.13.0' : 'gpt-6-luna',
        answers: jev ? Object.fromEntries(questions.map((q, i) => [q.id, answers[i]])) : answers,
        usage: { input_tokens: 9, output_tokens: 0 },
      }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const check = vi.fn(async () => {})
    const base: TopicClassifierOptions = { provider: llm, model: 'fixture', workspaceId, runId: 'first-message',
      decisionRuntime: runtime, assertInputAuthority: check, currentMessage: 'Please evaluate the fictional Acorn proposal.',
      recentUserTurns: [], replyToText: null, knownTopicsThisSession: [],
    }
    const created = await classifyTopic(base)
    const identity = createTopicIdentity({ workspaceId, runId: base.runId! })
    expect(created).toMatchObject({ topic_label: identity, state: 'shift', confidence: 1 })
    const anchored: TopicClassifierOptions = { ...base, runId: 'second-message',
      recentUserTurns: [{ text: 'The fictional Acorn proposal', topicLabel: identity }],
      knownTopicsThisSession: [identity, 'Exact Legacy CASE!'], topicAnchors: [
        { topicLabel: identity, messages: [{ role: 'user', text: 'The complete Acorn proposal' }, { role: 'assistant', text: 'All Acorn context' }] },
        { topicLabel: 'Exact Legacy CASE!', messages: [{ role: 'user', text: 'The complete Birch budget' }] },
      ],
    }
    state = 'continue'; topic = 'k0'
    expect(await classifyTopic(anchored)).toMatchObject({ topic_label: identity, state: 'continue' })
    state = 'resume'; topic = 'k0'
    expect(await classifyTopic({ ...anchored, runId: 'resumed-active-message',
      recentUserTurns: [...anchored.recentUserTurns, { text: 'An unclassified gap', topicLabel: null }],
    })).toMatchObject({ topic_label: identity, state: 'resume' })
    state = 'resume'; topic = 'k1'
    expect(await classifyTopic({ ...anchored, runId: 'third-message' })).toMatchObject({ topic_label: 'Exact Legacy CASE!', state: 'resume' })
    state = 'cross-topic'; topic = 'k0'
    expect(await classifyTopic({ ...anchored, runId: 'fourth-message' })).toMatchObject({ topic_label: identity, state: 'cross-topic', related_topics: ['Exact Legacy CASE!'] })
    expect(states[1]).toMatchObject({ topicAnchors: anchored.topicAnchors })
    expect(llm.stream).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(metered).toHaveBeenCalledTimes(5)
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(attempts).toHaveLength(5)
    expect(attempts.every(a => a.stage === 'primary_decision' && a.modelCatalogId === selected)).toBe(true)
    expect(getSystem).toHaveBeenCalledWith(workspaceId)
  })
})
