import { createDbSessionStateStore } from '../../db/session-state-store.js'
import { writeSessionContextRevision, sessionContextGeneration } from '../../db/session-context-revisions.js'
import { createDbEpisodicStore } from '../../db/episodic-store.js'
import { addSessionMessage, findSessionById, readCompactSummary } from '../../db/sessions.js'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionAdapterRegistry, executeDecisionCascade, createTypeSafeDecisionProvider, type TopicClassifierOptions, bindScopeSources, executionToolContext, classifyTopic, boundScopeSources, createCompactionCircuitBreaker, type LLMProvider, type StreamFn } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { houseKeepEpisodic, runProactiveCompaction } from '../../routes/proactive-compaction.js'
import { createDecisionRuntime } from '../../decision-runtime.js'
import { assertSourceModelInputAuthority } from '../model-source-authority.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] current attended compaction boundaries', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  function provider(stream: StreamFn): LLMProvider {
    return { name: 'deterministic-context-fixture', models: ['fixture'], stream,
      createSession() { throw new Error('Stateless fixture expected') } }
  }
  async function run(f: NonNullable<typeof fixture>, current: Awaited<ReturnType<typeof f.modelContext>>, stream: StreamFn, persist = false) {
    return runProactiveCompaction({
      sessionMessages: await f.history(), timezone: 'UTC', session: f.session,
      tier: 'standard', channelClass: 'web', profile: 'linear', unconditional: true,
      provider: provider(stream), model: 'fixture', systemPrompt: 'Synthetic compaction fixture.',
      assistantId: f.assistantId, userId: current.execution.security.access.userId, ownerId: f.ownerId,
      channelType: 'web', memoryStore: createDbMemoryStore(),
      persistLongTermContext: false, persistSessionSummary: persist,
      authority: current.execution.security.authority, modelContext: current,
      circuitBreaker: createCompactionCircuitBreaker(),
    })
  }


  it('refuses withdrawn topic-classifier inputs before provider dispatch and keeps a second reader usable', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, history = await f.history(), sources = history.flatMap(boundScopeSources)
    const first = await f.modelContext(f.firstId)
    const stream = vi.fn<StreamFn>(async function* () {
      yield { type: 'text_delta', text: '{"topic_label":"fictional earlier request","state":"resume","confidence":0.9}' }
    })
    function options(current: typeof first) {
      const context = { ...executionToolContext(current.execution, { appId: 'fixture' }), scopeAccumulator: current.accumulator }
      return bindScopeSources({ provider: provider(stream), model: 'fixture',
        recentUserTurns: [{ text: 'Fictional earlier request', topicLabel: 'fictional earlier request' }],
        replyToText: 'Fictional earlier response', currentMessage: 'Fictional current request',
        knownTopicsThisSession: ['fictional earlier request'], authority: current,
        assertInputAuthority: () => assertSourceModelInputAuthority(context),
      }, sources)
    }
    await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    await expect(classifyTopic(options(first))).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(stream).not.toHaveBeenCalled()
    const second = await f.modelContext(f.secondId)
    const result = await classifyTopic(options(second))
    expect(result).toMatchObject({ topic_label: 'fictional earlier request', state: 'resume', confidence: 0.9 })
    expect(stream).toHaveBeenCalledOnce()
    expect(boundScopeSources(result)).toEqual(sources)
    expect((await f.history()).flatMap(boundScopeSources)).toEqual(sources)
  })


  async function topicOptions(f: NonNullable<typeof fixture>, stream: StreamFn, userId = f.ownerId) {
    const history = await f.history(), current = await f.modelContext(userId)
    const context = { ...executionToolContext(current.execution, { appId: 'fixture' }), scopeAccumulator: current.accumulator }
    const sources = history.flatMap(boundScopeSources)
    const text = (row: typeof history[number]) => (row.content as Array<{ type: string; text: string }>).filter(block => block.type === 'text').map(block => block.text).join(' ')
    const options = bindScopeSources<TopicClassifierOptions>({ provider: provider(stream), model: 'fixture',
      recentUserTurns: [{ text: text(history[0]), topicLabel: text(history[0]).toLowerCase() }],
      replyToText: text(history[1]), currentMessage: text(history[2]),
      knownTopicsThisSession: [text(history[0]).toLowerCase(), text(history[1]).toLowerCase()], authority: current,
      assertInputAuthority: () => assertSourceModelInputAuthority(context),
    }, sources)
    return { options, current, sources }
  }

  it('requires both private input evidence and a current host check before formatting classifier text', async () => {
    fixture = await persistentContextFixture()
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'unused' } })
    const { options, sources } = await topicOptions(fixture, stream)
    await expect(classifyTopic({ ...options })).rejects.toThrow('scope_evidence_missing')
    const missingCheck = bindScopeSources({ ...options, assertInputAuthority: undefined }, sources)
    await expect(classifyTopic(missingCheck)).rejects.toThrow('scope_evidence_missing')
    await expect(classifyTopic(bindScopeSources({ ...options, authority: undefined }, sources))).rejects.toThrow('scope_evidence_missing')
    expect(stream).not.toHaveBeenCalled()
  })

  it('does not expose an LLM topic after authority changes during the actual provider response', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    const stream = vi.fn<StreamFn>(async function* (request) {
      expect(request.assertInputAuthority).toBeTypeOf('function')
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
      yield { type: 'text_delta', text: '{"topic_label":"fictional held result","state":"shift","confidence":0.8}' }
    })
    const { options, sources } = await topicOptions(f, stream, f.firstId)
    await expect(classifyTopic(options)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(stream).toHaveBeenCalledOnce()
    expect((await f.history()).flatMap(boundScopeSources)).toEqual(sources)
  })

  it('passes the current check into a provider retry and refuses its second dispatch', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    let dispatches = 0
    const stream = vi.fn<StreamFn>(async function* (request) {
      dispatches++
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
      await request.assertInputAuthority!()
      dispatches++
      yield { type: 'text_delta', text: 'unreachable synthetic retry' }
    })
    const { options } = await topicOptions(f, stream, f.firstId)
    await expect(classifyTopic(options)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(dispatches).toBe(1)
  })

  it.each(['provider', 'parse'] as const)('keeps complete input ancestry on a healthy %s fallback', async (failure) => {
    fixture = await persistentContextFixture()
    const stream = vi.fn<StreamFn>(async function* () {
      if (failure === 'provider') throw new Error('Synthetic provider unavailable')
      yield { type: 'text_delta', text: 'Synthetic malformed response' }
    })
    const { options, sources } = await topicOptions(fixture, stream)
    const result = await classifyTopic(options)
    expect(result).toMatchObject({ topic_label: '(uncategorized)', confidence: 0 })
    expect(boundScopeSources(result)).toEqual(sources)
    expect(stream).toHaveBeenCalledOnce()
  })

  function topicRuntime(llm: LLMProvider, transport: Parameters<typeof createTypeSafeDecisionProvider>[0]['transport']) {
    const adapters = new DecisionAdapterRegistry()
    adapters.register('typesafe', () => createTypeSafeDecisionProvider({ apiKey: 'fixture-key', transport }))
    return createDecisionRuntime({ llmProvider: llm, defaultLlmModel: 'fixture', adapters,
      resolveRoute: () => ({ mode: 'hybrid', primaryModelId: 'typesafe-jev-1.13', allowSyntheticProfile: true,
        profile: { id: 'fixture-topic', version: '1', mode: 'hybrid', operationId: 'memory.topic', operationVersion: '1',
          stateVersion: '1', questionVersion: '1', modelCatalogId: 'typesafe-jev-1.13', modelWireId: 'jev-1.13.0',
          evaluationSegment: 'global', status: 'approved', evidence: 'synthetic', totalTimeoutMs: 5000, primaryTimeoutMs: 3000, maxAttempts: 2 } }),
    })
  }
  const topicResponse = () => ({ status: 200, body: { model: 'jev-1.13.0', answers: {
    state: { type: 'choice', choice: 'resume', confidence: 0.9, probabilities: { continue: 0.05, shift: 0.03, resume: 0.9, 'cross-topic': 0.02 } },
    topic: { type: 'choice', choice: 'fictional earlier request', confidence: 0.9, probabilities: { 'fictional earlier request': 0.9, 'fictional earlier response': 0.05, __new_topic__: 0.03, __uncategorized__: 0.02 } },
  } } })

  it('keeps full topic input ancestry through the actual API runtime and primary decision adapter', async () => {
    fixture = await persistentContextFixture()
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'unused' } })
    const { options, sources } = await topicOptions(fixture, stream)
    const transport = vi.fn(async (request) => {
      expect(JSON.stringify(request.body)).not.toContain('assertInputAuthority')
      expect(JSON.stringify(request.body)).toContain('fictional earlier response')
      return topicResponse()
    })
    options.decisionRuntime = topicRuntime(options.provider, transport)
    const result = await classifyTopic(options)
    expect(result).toMatchObject({ topic_label: 'fictional earlier request', state: 'resume' })
    expect(boundScopeSources(result)).toEqual(sources)
    expect(transport).toHaveBeenCalledOnce()
    expect(stream).not.toHaveBeenCalled()
  })

  it('refuses a primary decision after a real grant change instead of dispatching an LLM fallback', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'unused' } })
    const { options } = await topicOptions(f, stream, f.firstId)
    const transport = vi.fn(async () => {
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
      return topicResponse()
    })
    options.decisionRuntime = topicRuntime(options.provider, transport)
    await expect(classifyTopic(options)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(transport).toHaveBeenCalledOnce()
    expect(stream).not.toHaveBeenCalled()
    const other = await topicOptions(f, stream, f.secondId)
    other.options.decisionRuntime = topicRuntime(other.options.provider, async () => topicResponse())
    expect(await classifyTopic(other.options)).toMatchObject({ topic_label: 'fictional earlier request', state: 'resume' })
    expect(stream).not.toHaveBeenCalled()
  })


  it('waits for an in-flight real authority check after a primary deadline before any recovery', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, current = await f.modelContext(f.firstId), sources = (await f.history()).flatMap(boundScopeSources)
    current.accumulator.note({ sources })
    const context = { ...executionToolContext(current.execution, { appId: 'fixture' }), scopeAccumulator: current.accumulator }
    let enter!: () => void, release!: () => void, checks = 0, completed = false
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pendingCheck = new Promise<void>(resolve => { release = resolve })
    const complete = vi.fn(async () => ({ result: 'synthetic fallback', providerId: 'fixture', model: { catalogId: 'fixture', wireId: 'fixture' } }))
    const decision = executeDecisionCascade({ request: { runId: 'fixture-topic-deadline',
      operation: { id: 'fixture.topic.deadline', version: '1', stateVersion: '1', questionVersion: '1' },
      model: { catalogId: 'fixture', wireId: 'fixture' }, state: { message: 'Fictional current request' },
      questions: [{ kind: 'choice', id: 'topic', prompt: 'Choose the fictional topic.', options: [{ value: 'fictional' }] }],
    }, operation: {
      assertInputAuthority: async () => {
        checks++
        if (checks === 3) { enter(); await pendingCheck }
        await assertSourceModelInputAuthority(context)
      },
      decide: () => ({ kind: 'complete' as const, result: 'fictional' }), validateResult: value => value,
      safeFailure: () => 'synthetic default', completeWithLlm: complete,
    }, route: { mode: 'hybrid', allowSyntheticProfile: true,
      primary: { id: 'fixture-decision', capabilities: { primitives: ['choice'], batch: true, maxOptions: 4, maxQuestions: 4,
        maxRubricLevels: 4, maxInputTokens: 1000, uncertainty: ['unavailable'] },
        evaluate: async request => {
          await request.assertInputAuthority!()
          return { providerId: 'fixture-decision', model: request.model,
            answers: [{ questionId: 'topic', kind: 'choice', value: 'fictional', evidence: { source: 'unavailable' } }] }
        } },
      profile: { id: 'fixture-deadline', version: '1', mode: 'hybrid', operationId: 'fixture.topic.deadline', operationVersion: '1',
        stateVersion: '1', questionVersion: '1', modelCatalogId: 'fixture', modelWireId: 'fixture', evaluationSegment: 'global',
        status: 'approved', evidence: 'synthetic', totalTimeoutMs: 5000, primaryTimeoutMs: 20, maxAttempts: 2 },
    } }).then(value => { completed = true; return { value } }, error => { completed = true; return { error } })
    await entered
    // Deliberately cross only this new synthetic transport's deadline; the ACL
    // result below still comes from actual SQL and the canonical execution.
    await new Promise(resolve => setTimeout(resolve, 80))
    const whilePending = { checks, completed, fallback: complete.mock.calls.length }
    try {
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    } finally { release() }
    const outcome = await decision
    expect(whilePending).toEqual({ checks: 3, completed: false, fallback: 0 })
    expect(outcome).toMatchObject({ error: { reason: 'authority_changed', retrySafe: false } })
    expect(complete).not.toHaveBeenCalled()
  })


  it('rechecks actual API decision authority after asynchronous outcome recording before return', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, current = await f.modelContext(f.firstId), history = await f.history()
    current.accumulator.note({ sources: history.flatMap(boundScopeSources) })
    const context = { ...executionToolContext(current.execution, { appId: 'fixture' }), scopeAccumulator: current.accumulator }
    let outcomes = 0
    const runtime = createDecisionRuntime({ llmProvider: provider(async function* () {}), defaultLlmModel: 'fixture',
      onOutcome: async () => {
        outcomes++
        await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
      },
    })
    await expect(runtime.run({ request: { runId: 'fixture-topic-outcome',
      operation: { id: 'fixture.topic', version: '1', stateVersion: '1', questionVersion: '1' },
      state: { message: 'Fictional current request' },
      questions: [{ kind: 'choice', id: 'topic', prompt: 'Choose the fictional topic.', options: [{ value: 'fictional' }] }],
    }, operation: {
      assertInputAuthority: () => assertSourceModelInputAuthority(context),
      decide: () => ({ kind: 'complete', result: 'fictional' }), validateResult: result => result,
      safeFailure: () => 'synthetic fallback',
      completeWithLlm: async () => ({ result: 'fictional', providerId: 'fixture', model: { catalogId: 'fixture', wireId: 'fixture' } }),
    } })).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(outcomes).toBe(1)
  })

  it('retains nullable shared message evidence through actual replay and in-memory compaction', async () => {
    fixture = await persistentContextFixture()
    const current = await fixture.modelContext()
    const result = await run(fixture, current, async function* () { yield { type: 'text_delta', text: 'Fictional compacted answer' } })
    expect(result.compacted).toBe(true)
    expect(boundScopeSources(result.messages[0])).not.toHaveLength(0)
    expect(boundScopeSources(result.messages[0]).every(source => source.userId === null && source.assistantId === null)).toBe(true)
  })

  it('refuses a stale member before provider dispatch while another current member remains usable', async () => {
    fixture = await persistentContextFixture()
    const original = (await fixture.history()).flatMap(boundScopeSources)
    const first = await fixture.modelContext(fixture.firstId)
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'Fictional answer' } })
    await fixture.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [fixture.workspaceId, fixture.firstId])
    await expect(run(fixture, first, stream)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(stream).not.toHaveBeenCalled()
    expect((await fixture.history()).flatMap(boundScopeSources)).toEqual(original)
    const second = await fixture.modelContext(fixture.secondId)
    expect((await run(fixture, second, stream)).compacted).toBe(true)
    expect(stream).toHaveBeenCalledOnce()
  })

  it('publishes an exact bound durable summary and replays it on the admitted fast path', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, current = await f.modelContext(), history = await f.history()
    const result = await run(f, current, async function* () { yield { type: 'text_delta', text: 'Fictional certified summary' } }, true)
    expect(result.compacted).toBe(true)
    const parent = (await f.pool.query('SELECT compact_summary,compact_scope_revision_id,compact_boundary_sequence,compaction_count FROM sessions WHERE id=$1', [f.session.id])).rows[0]
    expect(parent.compact_summary).toBeNull()
    expect(parent.compact_scope_revision_id).toBeTruthy()
    expect(parent.compact_boundary_sequence).toBe(history.at(-1)!.sequenceNum)
    expect(parent.compaction_count).toBe(1)
    expect(boundScopeSources(result.messages[0])).toMatchObject([{ resourceKind: 'session_context_revision', resourceId: parent.compact_scope_revision_id }])
    expect((await findSessionById(f.session.id))?.compactSummary).toBeNull()
    const fresh = await f.modelContext(), stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'Must not run' } })
    const replay = await runProactiveCompaction({ sessionMessages: await f.history(), timezone: 'UTC', session: f.session,
      tier: 'standard', channelClass: 'web', unconditional: false, provider: provider(stream), model: 'fixture', systemPrompt: 'Synthetic fixture.',
      assistantId: f.assistantId, userId: f.ownerId, ownerId: f.ownerId, channelType: 'web', memoryStore: createDbMemoryStore(),
      persistLongTermContext: false, authority: fresh.execution.security.authority, modelContext: fresh })
    expect(stream).not.toHaveBeenCalled()
    expect(replay.compacted).toBe(false)
    expect(replay.messages[0].content).toEqual(result.messages[0].content)
    expect(replay.messages[0].content).toContain('Fictional certified summary')
    expect(boundScopeSources(replay.messages[0])).toEqual(boundScopeSources(result.messages[0]))
    expect(replay.messages).toHaveLength(2)
  })

  it('carries the admitted previous summary and its complete revision ancestry into the next compaction', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    const first = await run(f, await f.modelContext(), async function* () { yield { type: 'text_delta', text: 'Fictional earlier durable fact' } }, true)
    const firstRevision = boundScopeSources(first.messages[0])[0]
    for (const [role, text] of [['assistant', 'Fictional recent answer'], ['user', 'Fictional follow-up request'], ['assistant', 'Fictional follow-up answer'], ['user', 'Fictional latest request']]) {
      await addSessionMessage({ sessionId: f.session.id, role, content: [{ type: 'text', text }], scope: f.envelope })
    }
    const requests: string[] = []
    const second = await run(f, await f.modelContext(), async function* (request) {
      requests.push(JSON.stringify(request.messages))
      yield { type: 'text_delta', text: 'Fictional updated durable summary' }
    }, true)
    expect(second.compacted).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('Fictional earlier durable fact')
    const secondRevision = boundScopeSources(second.messages[0])[0]
    expect(secondRevision.resourceId).not.toBe(firstRevision.resourceId)
    const inputs = (await f.pool.query(`SELECT s.source_id FROM scope_derivations d JOIN scope_derivation_sources s
      ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=$1
      AND d.resource_kind='session_context_revision' AND d.resource_id=$2`, [f.workspaceId, secondRevision.resourceId])).rows.map(row => row.source_id)
    expect(inputs).toContain(firstRevision.resourceId)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_revision_contents WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(2)
  })

  it('returns the exact admitted winner and its tail when real compaction publications race', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    await f.history() // Seed once before racing the actual publications.
    let entered = 0, release!: () => void
    const bothEntered = new Promise<void>(resolve => { release = resolve })
    const currents = await Promise.all([f.modelContext(), f.modelContext()])
    const results = await Promise.all(currents.map((current, index) => run(f, current, async function* () {
      entered++
      if (entered === 2) release()
      await bothEntered
      yield { type: 'text_delta', text: `Fictional racing summary ${index}` }
    }, true)))
    expect(results.filter(result => result.compacted)).toHaveLength(1)
    const winner = results.find(result => result.compacted)!, loser = results.find(result => !result.compacted)!
    expect(loser.messages[0].content).toEqual(winner.messages[0].content)
    expect(boundScopeSources(loser.messages[0])).toEqual(boundScopeSources(winner.messages[0]))
    expect(loser.messages).toHaveLength(2)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_revision_contents WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
  })

  it('withholds a certified summary from a withdrawn member while a second current member still replays it', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    const original = await run(f, await f.modelContext(), async function* () { yield { type: 'text_delta', text: 'Fictional protected compact history' } }, true)
    const first = await f.modelContext(f.firstId), stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'Must not run' } })
    await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    await expect(run(f, first, stream, true)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(stream).not.toHaveBeenCalled()
    const second = await f.modelContext(f.secondId)
    expect((await readCompactSummary(f.session.id, second))?.summary).toEqual(original.messages[0].content)
  })

  it('keeps the persisted summary and its truncation marker within the durable cap', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    const result = await run(f, await f.modelContext(), async function* () { yield { type: 'text_delta', text: 'x'.repeat(12_000) } }, true)
    expect(result.compacted).toBe(true)
    const current = await readCompactSummary(f.session.id, await f.modelContext())
    expect(current?.summary).toEqual(result.messages[0].content)
    expect(current?.summary.length).toBeLessThanOrEqual(8_000)
    expect(current?.summary).toMatch(/\[summary truncated at cap\]$/)
  })

  it('holds historical plaintext and a purged certified pointer before model dispatch', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    await run(f, await f.modelContext(), async function* () { yield { type: 'text_delta', text: 'Fictional soon-purged history' } }, true)
    const pointer = (await f.pool.query('SELECT compact_scope_revision_id AS id FROM sessions WHERE id=$1', [f.session.id])).rows[0].id
    await f.pool.query('DELETE FROM session_context_revision_contents WHERE revision_id=$1', [pointer])
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: 'Must not run' } })
    await expect(run(f, await f.modelContext(), stream, true)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(stream).not.toHaveBeenCalled()
    expect((await f.pool.query('SELECT id FROM session_context_scope_revisions WHERE id=$1', [pointer])).rows).toHaveLength(1)
    // The same presence hold applies to historical plaintext without a receipt.
    const setup = await f.pool.connect()
    try {
      await setup.query('BEGIN')
      await setup.query('ALTER TABLE sessions DISABLE TRIGGER session_context_summary_pair')
      await setup.query("UPDATE sessions SET compact_scope_revision_id=NULL,compact_summary='Fictional held legacy summary' WHERE id=$1", [f.session.id])
      await setup.query('ALTER TABLE sessions ENABLE TRIGGER session_context_summary_pair')
      await setup.query('COMMIT')
    } finally { await setup.query('ROLLBACK'); setup.release() }
    expect((await findSessionById(f.session.id))?.compactSummary).toBeNull()
    await expect(run(f, await f.modelContext(), stream, true)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(stream).not.toHaveBeenCalled()
  })

  async function episode(f: NonNullable<typeof fixture>, topicLabel = 'fictional-topic') {
    const store = createDbEpisodicStore(), context = await f.modelContext()
    const row = await store.create({ sessionId: f.session.id, assistantId: f.assistantId, userId: f.ownerId,
      topicLabel, summary: 'Fictional durable episodic detail', messageSpan: { fromSequence: 1, toSequence: 2, turnCount: 2 },
      authority: context, derivation: { producer: 'fixture:promotion-input', sources: (await f.history()).flatMap(boundScopeSources) } })
    return { store, row }
  }
  async function mature(f: NonNullable<typeof fixture>, store: ReturnType<typeof createDbEpisodicStore>, id: string) {
    const context = await f.modelContext()
    await store.fetchByTopic({ sessionId: f.session.id, topicLabel: 'fictional-topic', authority: context })
    await store.incrementSurvivalCount([id], context)
    await store.incrementSurvivalCount([id], context)
  }

  it('publishes actual multi-topic compaction episodes with the complete admitted input ancestry', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, current = await f.modelContext(), store = createDbEpisodicStore()
    const old=Date.now()-48*60*60*1000
    const expired=await writeSessionContextRevision({sessionId:f.session.id,kind:'session_state',expectedGeneration:await sessionContextGeneration(f.session.id),
      content:{key:'fictional-resolved',status:'resolved',summary:'Fictional old resolved commitment',detail:null,source:'tool',createdAt:old,updatedAt:old,resolvedAt:old},
      authority:await f.modelContext(),derivation:{producer:'fixture:old-resolved',sources:(await f.history()).flatMap(boundScopeSources)}})
    let calls = 0
    const result = await runProactiveCompaction({ sessionMessages: await f.history(), timezone: 'UTC', session: f.session,
      tier: 'standard', channelClass: 'web', profile: 'multi-topic', unconditional: true,
      provider: provider(async function* () { yield { type: 'text_delta', text: ++calls === 1 ? '[]' :
        '## TOPIC: Fictional topic [ACTIVE]\nFictional current topic detail\nMESSAGE_SPAN: from=1 to=2 turns=2' } }),
      model: 'fixture', systemPrompt: 'Synthetic fixture.', assistantId: f.assistantId, userId: f.ownerId, ownerId: f.ownerId,
      channelType: 'web', memoryStore: createDbMemoryStore(), episodicStore: store, sessionStateStore:createDbSessionStateStore(),
      authority: current.execution.security.authority, modelContext: current, circuitBreaker: createCompactionCircuitBreaker() })
    expect(result.compacted).toBe(true)
    expect(result.episodes).toHaveLength(1)
    expect((await f.pool.query('SELECT id FROM session_state WHERE id=$1',[expired!.parentId])).rows).toHaveLength(0)
    expect((await f.pool.query('SELECT revision_id FROM session_context_revision_contents WHERE revision_id=$1',[expired!.id])).rows).toHaveLength(0)
    const stored = await store.listBySession(f.session.id, await f.modelContext())
    expect(stored).toMatchObject([{ topicLabel: 'fictional topic', summary: 'Fictional current topic detail' }])
    const inputs = (await f.pool.query(`SELECT s.source_id FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`, [f.workspaceId,boundScopeSources(stored[0])[0].resourceId])).rows.map(r => r.source_id)
    for (const source of boundScopeSources(result.episodes[0])) expect(inputs).toContain(source.resourceId)
    expect((await f.pool.query('SELECT summary,topic_label FROM episodic_memories WHERE id=$1',[stored[0].id])).rows[0]).toEqual({ summary:'',topic_label:'' })
  })

  it('evicts, keeps and promotes actual admitted episodes while retaining the promoted source', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, { store,row } = await episode(f)
    await mature(f,store,row.id)
    const cold = (await episode(f,'fictional-cold')).row
    const young = (await episode(f,'fictional-young')).row
    await store.fetchByTopic({ sessionId:f.session.id,topicLabel:'fictional-young',authority:await f.modelContext() })
    const stats = await houseKeepEpisodic({ episodicStore:store,memoryStore:createDbMemoryStore(),sessionId:f.session.id,
      assistantId:f.assistantId,userId:f.ownerId,contextAuthority:await f.modelContext() })
    expect(stats).toEqual({ promoted:1,evicted:1,kept:1 })
    const parents = (await f.pool.query('SELECT id,promoted_memory_id,survival_count FROM episodic_memories WHERE session_id=$1',[f.session.id])).rows
    expect(parents.find(p => p.id===cold.id)).toBeUndefined()
    expect(parents.find(p => p.id===young.id).survival_count).toBe(1)
    const memoryId = parents.find(p => p.id===row.id).promoted_memory_id
    expect(memoryId).toBeTruthy()
    expect((await store.listBySession(f.session.id,await f.modelContext())).map(r=>r.id)).toEqual([young.id])
    const reader = await f.execution(f.secondId)
    const memory = await createDbMemoryStore().getById(reader.security.access,memoryId)
    expect(memory).toMatchObject({ summary:'Recurring topic: fictional-topic',detail:'Fictional durable episodic detail',userId:null,assistantId:null,sensitivity:'internal' })
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_revision_contents WHERE revision_id=$1',[boundScopeSources(row)[0].resourceId])).rows[0].n).toBe(1)
    const input = (await f.pool.query(`SELECT s.source_id FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2`,[f.workspaceId,memoryId])).rows.map(r=>r.source_id)
    expect(input).toContain(boundScopeSources(row)[0].resourceId)
  })

  it('serializes concurrent promotion and returns the same publication on retry without resurrection', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, {store,row} = await episode(f)
    await mature(f,store,row.id)
    const contexts = await Promise.all([f.modelContext(),f.modelContext()])
    const results = await Promise.all(contexts.map(context=>store.promote!(row.id,context)))
    expect(results.filter(r=>r.created)).toHaveLength(1)
    expect(results[0].memoryId).toBe(results[1].memoryId)
    expect((await f.pool.query("SELECT count(*)::int AS n FROM memories WHERE workspace_id=$1 AND source='episodic-graduation'",[f.workspaceId])).rows[0].n).toBe(1)
    const memoryId=results[0].memoryId
    await f.pool.query('DELETE FROM memories WHERE workspace_id=$1 AND id=$2',[f.workspaceId,memoryId])
    expect(await store.promote!(row.id,await f.modelContext())).toEqual({memoryId,created:false})
    expect((await f.pool.query('SELECT id FROM memories WHERE id=$1',[memoryId])).rows).toHaveLength(0)
    await expect(f.pool.query('UPDATE episodic_memories SET promoted_memory_id=NULL WHERE id=$1',[row.id])).rejects.toThrow('episodic_promotion_immutable')
  })

  it('rolls memory publication back when retirement fails and retries through the same canonical port', async () => {
    fixture = await persistentContextFixture()
    const f = fixture,{store,row}=await episode(f)
    await mature(f,store,row.id)
    // Real SQL failure after canonical memory insertion, before retirement commits.
    await f.pool.query(`ALTER TABLE episodic_memories ADD CONSTRAINT fixture_retirement_failure CHECK(id<>'${row.id}'::uuid OR promoted_memory_id IS NULL) NOT VALID`)
    try {
      await expect(store.promote!(row.id,await f.modelContext())).rejects.toThrow('fixture_retirement_failure')
      expect((await f.pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND source='episodic-graduation'",[f.workspaceId])).rows).toHaveLength(0)
      expect((await f.pool.query('SELECT promoted_memory_id FROM episodic_memories WHERE id=$1',[row.id])).rows[0].promoted_memory_id).toBeNull()
    } finally { await f.pool.query('ALTER TABLE episodic_memories DROP CONSTRAINT fixture_retirement_failure') }
    expect((await store.promote!(row.id,await f.modelContext())).created).toBe(true)
  })

  it('holds a revoked promoter while a second reader uses the unchanged retired source and memory', async () => {
    fixture = await persistentContextFixture()
    const f = fixture,{store,row}=await episode(f)
    await mature(f,store,row.id)
    const first=await f.modelContext(f.firstId)
    const original=boundScopeSources(row)[0]
    await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
    await expect(store.promote!(row.id,first)).rejects.toMatchObject({ reason:'authority_changed' })
    expect((await f.pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND source='episodic-graduation'",[f.workspaceId])).rows).toHaveLength(0)
    const second=await f.modelContext(f.secondId),published=await store.promote!(row.id,second)
    expect(await createDbMemoryStore().getById(second.execution.security.access,published.memoryId)).toMatchObject({ detail:'Fictional durable episodic detail' })
    expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,original.resourceId])).rows[0].source).toMatchObject({version:original.version,held:false})
    expect(await store.listBySession(f.session.id,second)).toEqual([])
  })

  it('keeps purge holding distinct from retirement and rejects an uncertified promotion link', async () => {
    fixture = await persistentContextFixture()
    const f = fixture,{store,row}=await episode(f)
    const unrelated=await f.memory('Fictional unrelated memory')
    await expect(f.pool.query('UPDATE episodic_memories SET promoted_memory_id=$2 WHERE id=$1',[row.id,unrelated.id])).rejects.toThrow('episodic_promotion_requires_derivation')
    await expect(store.promote!(row.id,await f.modelContext())).rejects.toThrow('scope_source_changed')
    await mature(f,store,row.id)
    const published=await store.promote!(row.id,await f.modelContext())
    const source=boundScopeSources(row)[0]
    await f.pool.query('DELETE FROM session_context_revision_contents WHERE revision_id=$1',[source.resourceId])
    const second=await f.modelContext(f.secondId)
    expect(await createDbMemoryStore().getById(second.execution.security.access,published.memoryId)).toBeNull()
    await expect(store.promote!(row.id,second)).rejects.toThrow('scope_source_changed')
    expect((await f.pool.query('SELECT id FROM episodic_memories WHERE id=$1',[row.id])).rows).toHaveLength(1)
  })

  it('uses the current shared-audience memory index and persists complete extraction ancestry', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, visible = await f.memory('Fictional shared index fact')
    await f.memory('Fictional private index fact', f.ownerId)
    const rows = await f.history(), current = await f.modelContext()
    const requests: string[] = []
    const result = await runProactiveCompaction({
      sessionMessages: rows, timezone: 'UTC', session: f.session,
      tier: 'standard', channelClass: 'web', unconditional: true, provider: provider(async function* (request) {
        requests.push(JSON.stringify(request.messages))
        yield { type: 'text_delta', text: request.systemPrompt.includes('fact extraction')
          ? '[{"type":"preference","summary":"Fictional extracted preference"}]' : 'Fictional summary' }
      }), model: 'fixture', systemPrompt: 'Synthetic compaction fixture.',
      assistantId: f.assistantId, userId: f.ownerId, ownerId: f.ownerId, channelType: 'web',
      memoryStore: createDbMemoryStore(), persistSessionSummary: false,
      authority: current.execution.security.authority, modelContext: current,
    })
    expect(result.compacted).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain('Fictional shared index fact')
    expect(requests.join('')).not.toContain('Fictional private index fact')
    const facts = (await f.pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Fictional extracted preference'", [f.workspaceId])).rows
    expect(facts).toHaveLength(1)
    const sources = (await f.pool.query(`SELECT s.source_id FROM scope_derivations d
      JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.resource_id=$2`, [f.workspaceId, facts[0].id])).rows.map(row => row.source_id)
    expect(sources.sort()).toEqual([...rows.map(row => row.id), visible.id].sort())
  })

  it('aborts after contraction during generation without writing a durable summary or trimming as fallback', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, current = await f.modelContext(f.firstId)
    const result = run(f, current, async function* () {
      yield { type: 'text_delta', text: 'Fictional partial summary' }
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    }, true)
    await expect(result).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect((await f.pool.query('SELECT compact_summary FROM sessions WHERE id=$1', [f.session.id])).rows[0].compact_summary).toBeNull()
  })
})
