import { describe, expect, it, vi } from 'vitest'
import { classifyTopic, type TopicClassifierOptions } from '../topic-classifier.js'
import { createTopicIdentity, isTopicIdentity } from '../topic-identity.js'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'
import type { DecisionAnswer, DecisionRequest } from '../../decisions/index.js'
import { bindScopeSources, boundScopeSources } from '../../security/source-evidence.js'
import { ContextScopeAccumulator } from '../../security/context-scope.js'
import type { SessionContextAuthority } from '../session-state-types.js'
import type { LLMProvider } from '../../providers/types.js'

const opaque = createTopicIdentity({ workspaceId: 'workspace', runId: 'earlier' })
function provider(json = '{}'): LLMProvider {
  return { name: 'fixture', models: [], createSession: () => ({}),
    stream: vi.fn(async function* () { yield { type: 'text_delta', text: json } }) } as unknown as LLMProvider
}
const choice = (questionId: string, value: string, confidence = 0.9): DecisionAnswer =>
  ({ questionId, kind: 'choice', value, evidence: { source: 'native_distribution', confidence } })
const related = (i: number, value: boolean, confidence = 0.85): DecisionAnswer =>
  ({ questionId: `related_k${i}`, kind: 'boolean', value, evidence: { source: 'native_distribution', confidence } })
function options(llm: LLMProvider, extra: Partial<TopicClassifierOptions> = {}): TopicClassifierOptions {
  return { provider: llm, model: 'mock', workspaceId: 'workspace', runId: 'current',
    recentUserTurns: [], replyToText: null, currentMessage: 'Please consider the new proposal in detail',
    knownTopicsThisSession: [], ...extra }
}
function native(answers: DecisionAnswer[], llm = provider(), inspect?: (request: DecisionRequest) => void) {
  return executionFixture({ llm, primary: fixtureDecisionProvider(async request => {
    inspect?.(request)
    return { providerId: 'fixture-decision', model: request.model, answers }
  }) })
}

describe('[COMP:memory/topic-identity] host identity and continuity', () => {
  it('allocates replay-stable new keys, isolated by workspace/run, never content or names', async () => {
    const llm = provider()
    const decisionRuntime = native([choice('state', 'shift'), choice('topic', 'new')], llm)
    const run = (extra: Partial<TopicClassifierOptions> = {}) => classifyTopic(options(llm, { decisionRuntime, ...extra }))
    const first = await run()
    expect(first.topic_label).toBe(createTopicIdentity({ workspaceId: 'workspace', runId: 'current' }))
    expect((await run({ currentMessage: 'Different content on replay' })).topic_label).toBe(first.topic_label)
    expect((await run({ runId: 'another' })).topic_label).not.toBe(first.topic_label)
    expect((await run({ workspaceId: 'another' })).topic_label).not.toBe(first.topic_label)
    const absent = await run({ runId: undefined })
    expect(isTopicIdentity(absent.topic_label)).toBe(true)
    expect((await run({ runId: undefined })).topic_label).not.toBe(absent.topic_label)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it.each(['__new_topic__', '__uncategorized__', 'new', 'unknown', 'k0', ' Legacy CASE! ', opaque])(
    'continues exact legacy/opaque identity %s with collision-free choice tokens', async key => {
      const llm = provider()
      const decisionRuntime = native([choice('state', 'continue'), choice('topic', 'k0')], llm, request => {
        expect(request.operation).toEqual({ id: 'memory.topic', version: '2', stateVersion: '2', questionVersion: '2' })
        const topic = request.questions.find(question => question.id === 'topic')!
        expect(topic.kind === 'choice' && topic.options.map(option => option.value)).toEqual(['k0', 'new', 'unknown'])
      })
      const result = await classifyTopic(options(llm, { decisionRuntime, knownTopicsThisSession: [key],
        recentUserTurns: [{ text: 'Source discussion', topicLabel: key }] }))
      expect(result).toMatchObject({ topic_label: key, state: 'continue', confidence: 0.9 })
      expect(llm.stream).not.toHaveBeenCalled()
    })

  it('resumes another exact key and retains all cross-topic related keys with conservative confidence', async () => {
    const llm = provider()
    const history = { knownTopicsThisSession: [opaque, 'Legacy Topic', 'third', 'fourth'],
      recentUserTurns: [{ text: 'Prior context', topicLabel: opaque }] }
    const resume = await classifyTopic(options(llm, { ...history,
      decisionRuntime: native([choice('state', 'resume'), choice('topic', 'k1')], llm) }))
    expect(resume).toMatchObject({ topic_label: 'Legacy Topic', state: 'resume' })
    const cross = await classifyTopic(options(llm, { ...history, decisionRuntime: native([
      choice('state', 'cross-topic'), choice('topic', 'k0'), related(0, true), related(1, true),
      related(2, true), related(3, true, 0.71),
    ], llm) }))
    expect(cross).toMatchObject({ topic_label: opaque, state: 'cross-topic',
      related_topics: ['Legacy Topic', 'third', 'fourth'], confidence: 0.71 })
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('allows exact-key resumption of the prior topic after compacted or unclassified context', async () => {
    const llm = provider()
    const result = await classifyTopic(options(llm, { knownTopicsThisSession: [opaque],
      recentUserTurns: [{ text: 'Earlier named context', topicLabel: opaque }, { text: 'An unclassified gap', topicLabel: null }],
      decisionRuntime: native([choice('state', 'resume'), choice('topic', 'k0'), related(0, true)], llm),
    }))
    expect(result).toMatchObject({ topic_label: opaque, state: 'resume', confidence: 0.9 })
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('reserves the previous identity in the bounded 20 and keeps the full anchor catalog', async () => {
    const llm = provider(), text = 'evidence '.repeat(2000) + 'END-OF-ANCHOR'
    const topicAnchors = [{ topicLabel: opaque, messages: [{ role: 'assistant' as const, text }] }]
    const decisionRuntime = native([choice('state', 'continue'), choice('topic', 'k0')], llm, request => {
      expect(request.questions).toHaveLength(22)
      const state = request.state as Record<string, unknown>
      expect(state.priorTopicToken).toBe('k0')
      expect(state.topicCatalog).toEqual(expect.arrayContaining([{ token: 'k0', topicLabel: opaque }]))
      expect(state.topicAnchors).toEqual(topicAnchors)
    })
    const result = await classifyTopic(options(llm, { decisionRuntime, topicAnchors,
      knownTopicsThisSession: Array.from({ length: 30 }, (_, i) => `legacy-${i}`),
      recentUserTurns: [{ text: 'prior', topicLabel: opaque }] }))
    expect(result.topic_label).toBe(opaque)
  })

  it('snapshots anchors, recent turns, reply, message and known keys before awaiting admission', async () => {
    let release!: () => void
    const admitted = new Promise<void>(resolve => { release = resolve })
    const llm = provider(), text = 'untruncated '.repeat(1000)
    const topicAnchors = [{ topicLabel: opaque, messages: [{ role: 'system' as const, text }] }]
    const recentUserTurns = [{ text: 'prior original', topicLabel: opaque }]
    const knownTopicsThisSession = [opaque]
    const decisionRuntime = native([choice('state', 'continue'), choice('topic', 'k0')], llm, request => {
      expect(request.state).toMatchObject({ topicAnchors: [{ topicLabel: opaque, messages: [{ role: 'system', text }] }],
        recentUserTurns: [{ text: 'prior original', topicLabel: opaque }], replyToText: 'reply original',
        currentMessage: 'message original' })
    })
    const opts = options(llm, { decisionRuntime, topicAnchors, recentUserTurns, knownTopicsThisSession,
      currentMessage: 'message original', replyToText: 'reply original', assertInputAuthority: () => admitted })
    const pending = classifyTopic(opts)
    topicAnchors[0]!.messages[0]!.text = 'mutated'
    topicAnchors[0]!.topicLabel = 'mutated'
    recentUserTurns[0]!.text = 'mutated'
    recentUserTurns[0]!.topicLabel = 'mutated'
    knownTopicsThisSession[0] = 'mutated'
    opts.replyToText = opts.currentMessage = 'mutated'
    opts.runId = 'mutated'
    release()
    expect((await pending).topic_label).toBe(opaque)
  })

  it.each([
    [choice('state', 'continue'), choice('topic', 'k1')],
    [choice('state', 'shift'), choice('topic', 'k0')],
    [choice('state', 'cross-topic'), choice('topic', 'new')],
    [choice('state', 'cross-topic'), choice('topic', 'k0'), related(0, false)],
    [choice('state', 'cross-topic'), choice('topic', 'k0'), related(0, false), related(1, false)],
    [choice('state', 'cross-topic'), choice('topic', 'k0'), related(0, false), choice('related_k1', 'true')],
    [choice('state', 'cross-topic'), choice('topic', 'k0'), related(0, false), related(1, true), related(1, true)],
    [choice('state', 'cross-topic'), choice('topic', 'k0'), related(0, false), related(1, true), related(2, true)],
  ])('rejects malformed or contradictory native selections %#', async (...answers) => {
    const llm = provider()
    const result = await classifyTopic(options(llm, { knownTopicsThisSession: [opaque, 'second'],
      recentUserTurns: [{ text: 'prior', topicLabel: opaque }], decisionRuntime: native(answers, llm) }))
    expect(result.confidence).toBe(0)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it.each(['llm_only', 'shadow'] as const)('preserves %s legacy naming only without opaque history', async mode => {
    const llm = provider('{"topic_label":"Old Legacy","state":"shift","confidence":0.9}')
    const decisionRuntime = executionFixture({ llm, mode,
      primary: fixtureDecisionProvider(async request => ({ providerId: 'fixture-decision', model: request.model,
        answers: [choice('state', 'shift'), choice('topic', 'new')] })) })
    expect((await classifyTopic(options(llm, { decisionRuntime }))).topic_label).toBe('old legacy')
    expect((await classifyTopic(options(llm, { decisionRuntime, knownTopicsThisSession: [opaque] }))).confidence).toBe(0)
  })

  it.each([false, true])('uses decision-only LLM with opaque history, runtime=%s', async runtime => {
    const llm = provider('{"topic":"k0","topic_label":"human rename attempt","state":"continue","confidence":0.8}')
    const result = await classifyTopic(options(llm, { knownTopicsThisSession: [opaque],
      recentUserTurns: [{ text: 'actual evidence', topicLabel: opaque }],
      ...(runtime ? { decisionRuntime: executionFixture({ llm, mode: 'llm_only' }) } : {}) }))
    expect(result).toMatchObject({ topic_label: opaque, confidence: 0.8 })
    const prompt = vi.mocked(llm.stream).mock.calls[0]![0].messages[0]!.content
    expect(prompt).toContain('actual evidence')
    expect(prompt).toContain('Never generate a topic name or identity')
  })

  it('uses decision-only failover after a native transport error even with legacy-only history', async () => {
    const llm = provider('{"topic":"new","state":"shift","confidence":0.7}')
    const decisionRuntime = executionFixture({ llm, primary: fixtureDecisionProvider(async () => { throw new Error('synthetic failure') }) })
    const result = await classifyTopic(options(llm, { decisionRuntime, knownTopicsThisSession: ['Legacy'] }))
    expect(result.topic_label).toBe(createTopicIdentity({ workspaceId: 'workspace', runId: 'current' }))
    expect(llm.stream).toHaveBeenCalledOnce()
  })

  it('keeps trivial reuse exact for opaque and mixed-case legacy keys', async () => {
    const llm = provider()
    for (const key of [opaque, ' Mixed Legacy! ']) {
      expect((await classifyTopic(options(llm, { currentMessage: 'test',
        recentUserTurns: [{ text: 'context', topicLabel: key }] }))).topic_label).toBe(key)
    }
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('never admits the uncategorized fallback as a reusable known identity', async () => {
    const llm = provider()
    const decisionRuntime = native([choice('state', 'shift'), choice('topic', 'new')], llm, request => {
      expect(request.state).toMatchObject({ topicCatalog: [], priorTopicToken: null })
      expect(request.questions).toHaveLength(2)
    })
    expect(isTopicIdentity((await classifyTopic(options(llm, { decisionRuntime,
      knownTopicsThisSession: ['(uncategorized)'],
      recentUserTurns: [{ text: 'no signal', topicLabel: '(uncategorized)' }] }))).topic_label)).toBe(true)
  })

  it.each([-1, 1.01, Infinity, -Infinity, NaN, '0.5', null])('never reviews under invalid explicit threshold %s', async reviewBelow => {
    const llm = provider()
    const decisionRuntime = executionFixture({ llm, profilePolicy: { reviewBelow },
      primary: fixtureDecisionProvider(async request => ({ providerId: 'fixture-decision', model: request.model,
        answers: [choice('state', 'shift', 0.2), choice('topic', 'new', 0.2)] })) })
    const result = await classifyTopic(options(llm, { decisionRuntime }))
    if (typeof reviewBelow === 'number' && !Number.isFinite(reviewBelow)) {
      // The cascade rejects non-JSON policy before operation dispatch.
      expect(result.confidence).toBe(0)
    } else {
      expect(result).toMatchObject({ state: 'shift', confidence: 0.2 })
      expect(isTopicIdentity(result.topic_label)).toBe(true)
    }
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('reviews valid low-confidence native new selections only under explicit policy, without naming', async () => {
    const llm = provider('{"state":"shift","topic":"new","confidence":0.8}')
    const decisionRuntime = executionFixture({ llm, profilePolicy: { reviewBelow: 0.5 },
      primary: fixtureDecisionProvider(async request => ({ providerId: 'fixture-decision', model: request.model,
        answers: [choice('state', 'shift', 0.2), choice('topic', 'new', 0.2)] })) })
    const result = await classifyTopic(options(llm, { decisionRuntime }))
    expect(result).toMatchObject({ topic_label: createTopicIdentity({ workspaceId: 'workspace', runId: 'current' }),
      state: 'shift', confidence: 0.8 })
    expect(llm.stream).toHaveBeenCalledOnce()
    expect(vi.mocked(llm.stream).mock.calls[0]![0].messages[0]!.content).toContain('Never generate a topic name or identity')
  })

  it('preserves admitted anchor source evidence and refuses a final native result after revocation', async () => {
    const llm = provider(), accumulator = new ContextScopeAccumulator()
    const authority = { execution: { security: { authority: { assertCurrent: async () => {} } },
      lifecycle: { abortSignal: new AbortController().signal } }, accumulator } as unknown as SessionContextAuthority
    const source = { workspaceId: 'workspace', userId: null, assistantId: null, sensitivity: 'confidential' as const,
      compartments: ['finance'], projectIds: [], resourceKind: 'memory', resourceId: 'anchor-source', version: '1' }
    let revoked = false
    const decisionRuntime = native([choice('state', 'shift'), choice('topic', 'new')], llm)
    const input = bindScopeSources(options(llm, { decisionRuntime, authority,
      topicAnchors: [{ topicLabel: 'Legacy', messages: [{ role: 'assistant', text: 'admitted evidence' }] }],
      assertInputAuthority: async () => {
        if (revoked) throw Object.assign(new Error('revoked'), { reason: 'authority_changed', retrySafe: false })
      } }), [source])
    const result = await classifyTopic(input)
    expect(boundScopeSources(result)).toEqual([source])
    const refusingRuntime = native([choice('state', 'shift'), choice('topic', 'new')], llm, () => { revoked = true })
    const refusing = bindScopeSources({ ...input, decisionRuntime: refusingRuntime }, [source])
    await expect(classifyTopic(refusing)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(llm.stream).not.toHaveBeenCalled()
  })

})
