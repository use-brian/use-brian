import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { buildTool } from '@use-brian/agent-runtime/tools/types.js'
import { queryLoop, type QueryEvent } from '@use-brian/agent-runtime/engine/query-loop.js'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { z } from 'zod'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { tryNativeInvocationEvidence } from '../../context-scope/native-invocation-evidence.js'
import { admitModelSourceEvidence } from '../model-source-authority.js'
const assertSourceModelInputAuthority = (context: Parameters<typeof admitModelSourceEvidence>[0]) => admitModelSourceEvidence(context, 'context')
const assertSourceModelOutputAuthority = (context: Parameters<typeof admitModelSourceEvidence>[0]) => admitModelSourceEvidence(context, 'deliver')
import { validateCallerScopeEvidence, validateAudienceScopeEvidence } from '../../context-scope/caller-evidence.js'
import { readPersistentSessionContextAncestors } from '../../db/session-context-ancestry.js'
import { readExternalSourceAncestors } from '../external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../field-evidence.js'

import { admitTurnConversationRecords } from '../../context-scope/conversation-record-admission.js'
vi.mock('../../context-scope/conversation-record-admission.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../context-scope/conversation-record-admission.js')>(),
  admitTurnConversationRecords: vi.fn(),
}))
vi.mock('../../context-scope/native-invocation-evidence.js', () => ({ tryNativeInvocationEvidence: vi.fn() }))
// None of these unrelated paths should be reached by a successful native proof.
vi.mock('../../db/client.js', () => ({ getAppPool: () => { throw new Error('Unexpected DB access') },
  applyRLSGucs: vi.fn(), rollbackAndRelease: vi.fn(), runWithAgentAccess: vi.fn() }))
vi.mock('../../db/session-context-revisions.js', () => ({ hasWorkspaceMcpRetainedAuthority: vi.fn() }))
vi.mock('../../db/session-context-ancestry.js', () => ({ readPersistentSessionContextAncestors: vi.fn() }))
vi.mock('../../context-scope/caller-evidence.js', () => ({ validateCallerScopeEvidence: vi.fn(), validateAudienceScopeEvidence: vi.fn() }))
vi.mock('../../context-scope/attended-audience.js', () => ({ createAttendedDeliveryAudienceAuthorizer: vi.fn(),
  tryValidateNativePersonalOutput: vi.fn(), tryResolveNativePersonalRecipient: vi.fn() }))
vi.mock('../session-query-context.js', () => ({ nativeSessionQueryContextSources: vi.fn() }))
vi.mock('../external-source-ancestry.js', () => ({ readExternalSourceAncestors: vi.fn() }))
vi.mock('../retained-source-authority.js', () => ({ assertPreparedExternalSourceAuthorityCurrent: vi.fn(), pinPreparedExternalSourceAuthority: vi.fn() }))
vi.mock('../source-runtime.js', () => ({ getSharedRetainedSourceAuthority: vi.fn() }))
vi.mock('../field-evidence.js', () => ({ readApplicationFieldAncestors: vi.fn() }))
vi.mock('../execution-context.js', () => ({ applyApplicationRLSContext: vi.fn(), getApplicationExecutionBinding: vi.fn(), releaseApplicationTransactionBinding: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function observe(promise: Promise<void>) {
  return promise.then(() => ({ status: 'admitted' as const }), error => ({ status: 'denied' as const, error }))
}
const floor = { projectIds: ['project-added'], compartments: ['compartment-added'] }
const native = vi.mocked(tryNativeInvocationEvidence)
function fixture(canonicalLabelsAllowed = false, independent = false) {
  const userId = 'user-race', workspaceId = 'workspace-race', assistantId = 'assistant-race'
  const assertCurrent = vi.fn(async () => {})
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId },
    access: { workspaceId, userId, assistantId, assistantKind: 'primary', clearance: canonicalLabelsAllowed ? 'confidential' : 'internal',
      compartments: [...floor.compartments, ...(canonicalLabelsAllowed ? ['canonical-private'] : [])], mutationCompartments: [], projectIds: [...floor.projectIds], visibilityAssistantIds: [] },
    authority: { assertCurrent, execute: async operation => operation() },
    writeDefaults: { compartments: [], projectIds: [] },
    lifecycle: { sessionId: 'session-race', channelId: 'fixture', channelType: 'web', abortSignal: new AbortController().signal },
  })
  const accumulator = new ContextScopeAccumulator()
  accumulator.note({ sources: [{ workspaceId, userId, assistantId, sensitivity: 'internal', compartments: [], projectIds: [],
    resourceKind: independent ? 'project_harness_revision' : 'memory', resourceId: 'memory-race', version: '1' }] })
  return { accumulator, assertCurrent, execution,
    context: { ...executionToolContext(execution, { appId: 'evidence-race-fixture' }), scopeAccumulator: accumulator } }
}

beforeEach(() => { vi.resetAllMocks() })

for (const [boundary, guard, kind] of [
  ['input', assertSourceModelInputAuthority, 'caller'],
  ['output', assertSourceModelOutputAuthority, 'audience'],
] as const) describe(`model ${boundary} native evidence snapshot races`, () => {
  // Failed/oversized tool reads can retain a floor without returning any new
  // source payload. Model that boundary state directly; no reader/DB is mocked
  // into pretending that the failed read itself was successful.
  it('admits a successful superseded snapshot only after a second fresh proof sees the added retained floor', async () => {
    const f = fixture(), entered = deferred<void>(), secondEntered = deferred<void>()
    const first = deferred<ScopeEvidence>(), second = deferred<ScopeEvidence>()
    native.mockImplementationOnce(async () => { entered.resolve(); return first.promise })
      .mockImplementationOnce(async () => { secondEntered.resolve(); return second.promise })
    const result = observe(guard(f.context))
    await entered.promise
    expect(native.mock.calls[0][1]).toMatchObject({ projectIds: [], compartments: [] })
    f.accumulator.note(floor)
    first.resolve(native.mock.calls[0][1])
    const next = await Promise.race([secondEntered.promise.then(() => 'second-proof'), result.then(() => 'settled')])
    // Always release the deferred proof, even when the baseline fails this assertion.
    second.resolve(f.accumulator.evidence)
    const outcome = await result
    if (next === 'settled') {
      expect(outcome).toMatchObject({ status: 'denied', error: { reason: 'authority_changed', retrySafe: false } })
    }
    expect(next).toBe('second-proof')
    expect(native).toHaveBeenCalledTimes(2)
    expect(native.mock.calls[1]).toEqual([f.execution, f.accumulator.evidence, f.execution.security.ceiling, kind, undefined])
    expect(outcome).toEqual({ status: 'admitted' })
  })

  it('does not revalidate an identical canonical floor', async () => {
    const f = fixture(), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    f.accumulator.note(floor)
    native.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
    const result = observe(guard(f.context))
    await entered.promise
    f.accumulator.note({ projectIds: [...floor.projectIds, ...floor.projectIds], compartments: [...floor.compartments] })
    proof.resolve(native.mock.calls[0][1])
    expect(await result).toEqual({ status: 'admitted' })
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('never retries a real lease failure combined with evidence growth, and keeps denial sticky', async () => {
    const f = fixture(), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    const failure = new Error('lease revoked')
    native.mockImplementationOnce(async () => { await f.assertCurrent(); entered.resolve(); const current = await proof.promise; await f.assertCurrent(); return current })
    f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure)
    const result = observe(guard(f.context))
    await entered.promise
    f.accumulator.note(floor)
    proof.resolve(native.mock.calls[0][1])
    expect(await result).toMatchObject({ status: 'denied', error: { cause: failure, reason: 'authority_changed', retrySafe: false } })
    f.assertCurrent.mockResolvedValue(undefined)
    await expect(guard(f.context)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(native).toHaveBeenCalledTimes(1)
    expect(f.assertCurrent).toHaveBeenCalledTimes(2)
  })

  it('never retries a native proof error even when the retained floor grew', async () => {
    const f = fixture(), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    const failure = new SourceProtocolError('source_access_denied')
    native.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
    const result = observe(guard(f.context))
    await entered.promise
    f.accumulator.note(floor)
    proof.reject(failure)
    expect(await result).toMatchObject({ status: 'denied', error: failure })
    await expect(guard(f.context)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('does not let a pending successful candidate revive an execution denied by a concurrent candidate', async () => {
    const f = fixture(), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    native.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
      .mockRejectedValueOnce(new SourceProtocolError('source_access_denied'))
    const pending = observe(guard(f.context))
    await entered.promise
    await expect(guard(f.context)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    proof.resolve(native.mock.calls[0][1])
    expect(await pending).toMatchObject({ status: 'denied', error: { reason: 'authority_changed', retrySafe: false } })
    await expect(guard(f.context)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(native).toHaveBeenCalledTimes(2)
  })
})

// Exercise the API guard itself as the engine's output callback. Only the
// native proof is mocked; queryLoop and its eager tool executor are real.
it('freshly admits overlapping thinking with the early Project floor before the tool store returns', async () => {
  const f = fixture()
  const started = deferred<void>(), releaseTool = deferred<void>(), noted = deferred<void>()
  const releaseStore = deferred<void>(), captured = deferred<void>(), proof = deferred<ScopeEvidence>()
  const freshCaptured = deferred<void>(), freshProof = deferred<void>(), thinkingDelivered = deferred<void>()
  const events: QueryEvent[] = [], timeline: string[] = []
  let armProof = false, awaitingFresh = false, storeReturned = false
  let capturedSnapshot: ScopeEvidence | undefined, freshSnapshot: ScopeEvidence | undefined
  const source = { ...f.accumulator.evidence.sources![0], resourceId: 'tool-result', compartments: ['result-only'] }
  native.mockImplementation(async (_execution, evidence) => {
    if (armProof) {
      armProof = false
      awaitingFresh = true
      capturedSnapshot = evidence
      timeline.push('proof-captured')
      captured.resolve()
      return proof.promise
    }
    if (awaitingFresh) {
      awaitingFresh = false
      freshSnapshot = evidence
      timeline.push('fresh-proof')
      freshCaptured.resolve()
      await freshProof.promise
    }
    return evidence
  })
  const tool = buildTool({
    name: 'observe', description: 'Read a fictional Project', inputSchema: z.object({}),
    isReadOnly: true, isConcurrencySafe: true,
    async execute(_input, current) {
      started.resolve()
      await releaseTool.promise
      current.scopeAccumulator!.noteProjectIds(floor.projectIds)
      timeline.push('project-noted')
      noted.resolve()
      // Keep result-only labels out of the accumulator until after thinking
      // admission: the race must concern the reader's early retained floor.
      await releaseStore.promise
      storeReturned = true
      return { data: { value: 'Fictional Project' }, scopeEvidence: { sources: [source] } }
    },
  })
  const send = vi.fn(() => (async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'message_start', model: 'fixture-model' }
    if (send.mock.calls.length === 1) {
      yield { type: 'tool_use_start', id: 'call-project', name: 'observe' }
      yield { type: 'tool_use_delta', id: 'call-project', input: '{}' }
      yield { type: 'tool_use_end', id: 'call-project' }
      await started.promise
      armProof = true
      yield { type: 'thinking_delta', text: 'Overlapping Project reasoning' }
      yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
    } else {
      yield { type: 'text_delta', text: 'Final Project answer' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    }
  })())
  const provider: LLMProvider = {
    name: 'fixture', models: ['fixture-model'], createSession: () => ({ send }),
    stream: () => { throw new Error('Unexpected stateless provider fallback') },
  }
  const context = { ...f.context, admitModelInput: assertSourceModelInputAuthority,
    admitModelOutput: assertSourceModelInputAuthority }
  const running = (async () => {
    for await (const event of queryLoop({
      provider, model: 'fixture-model', systemPrompt: 'Fictional context',
      messages: [{ role: 'user', content: 'Read a fictional Project' }],
      tools: new Map([['observe', tool]]), context, ledger: NOOP_TURN_LEDGER, maxTurns: 2,
    })) {
      events.push(event)
      if (event.type === 'thinking_delta') {
        timeline.push('thinking-delivered')
        thinkingDelivered.resolve()
      }
    }
  })()
  const outcome = observe(running)
  try {
    await captured.promise
    expect(capturedSnapshot).toMatchObject({ projectIds: [], compartments: [] })
    expect(storeReturned).toBe(false)
    expect(events.some(event => event.type === 'thinking_delta')).toBe(false)
    releaseTool.resolve()
    await noted.promise
    expect(f.accumulator.evidence).toMatchObject({ projectIds: floor.projectIds, compartments: [] })
    proof.resolve(capturedSnapshot!)
    // A broken guard can deny and settle rather than invoking a fresh proof.
    expect(await Promise.race([freshCaptured.promise.then(() => 'fresh'), outcome.then(() => 'settled')])).toBe('fresh')
    expect(freshSnapshot).toMatchObject({ projectIds: floor.projectIds, compartments: [] })
    expect(storeReturned).toBe(false)
    expect(events.some(event => event.type === 'thinking_delta')).toBe(false)
    freshProof.resolve()
    expect(await Promise.race([thinkingDelivered.promise.then(() => 'thinking'), outcome.then(() => 'settled')])).toBe('thinking')
    expect(storeReturned).toBe(false)
    expect(events.some(event => event.type === 'tool_result')).toBe(false)
    releaseStore.resolve()
    expect(await outcome).toEqual({ status: 'admitted' })
  } finally {
    releaseTool.resolve(); releaseStore.resolve(); proof.resolve(capturedSnapshot ?? {}); freshProof.resolve()
    await outcome
  }
  expect(timeline).toEqual(['proof-captured', 'project-noted', 'fresh-proof', 'thinking-delivered'])
  expect(send).toHaveBeenCalledTimes(2)
  expect(events).toContainEqual({ type: 'text_delta', text: 'Final Project answer' })
  const results = events.flatMap(event => event.type === 'tool_result' ? event.results : [])
  expect(results).toEqual([expect.objectContaining({ toolUseId: 'call-project', content: expect.stringContaining('Fictional Project') })])
  expect(JSON.stringify(results)).not.toContain('scopeEvidence')
  expect(f.accumulator.evidence).toMatchObject({ projectIds: floor.projectIds, compartments: ['result-only'], sources: expect.arrayContaining([source]) })
  expect(native.mock.calls.at(-1)?.[1]).toMatchObject({ projectIds: floor.projectIds, compartments: ['result-only'], sources: expect.arrayContaining([source]) })
})

// Each adapter represents a fresh boundary operation, not a cached allow.
const admissionKinds = ['input', 'output', 'ordinary input', 'ordinary output'] as const
function admissionFixture(kind: typeof admissionKinds[number], canonicalLabelsAllowed = false) {
  const f = fixture(canonicalLabelsAllowed, kind.startsWith('ordinary'))
  const prove = vi.fn<(evidence: ScopeEvidence) => Promise<ScopeEvidence | null>>()
  native.mockImplementation(async (_execution, evidence) => prove(evidence))
  if (kind.startsWith('ordinary')) {
    native.mockResolvedValue(null)
    vi.mocked(readPersistentSessionContextAncestors).mockResolvedValue([])
    vi.mocked(readExternalSourceAncestors).mockResolvedValue([])
    vi.mocked(readApplicationFieldAncestors).mockResolvedValue([])
    vi.mocked(validateCallerScopeEvidence).mockImplementation(async evidence => (await prove(evidence))!)
    vi.mocked(validateAudienceScopeEvidence).mockImplementation(async evidence => (await prove(evidence))!)
  }
  const admit = async () => {
    if (kind === 'input' || kind === 'ordinary input') return assertSourceModelInputAuthority(f.context)
    if (kind === 'output' || kind === 'ordinary output') return assertSourceModelOutputAuthority(f.context)
  }
  return { ...f, prove, admit }
}

for (const kind of admissionKinds) describe(`${kind} admission liveness and security`, () => {
  it('starts a fresh proof after successful supersession, retaining the latest native source pointer', async () => {
    const f = admissionFixture(kind), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    f.prove.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
      .mockImplementation(async evidence => evidence)
    const pending = observe(f.admit())
    await entered.promise
    const old = f.prove.mock.calls[0][0]
    f.accumulator.note({ ...floor, sources: old.sources!.map(source => ({ ...source, version: '2' })) })
    proof.resolve(old)
    expect(await pending).toEqual({ status: 'admitted' })
    expect(f.prove).toHaveBeenCalledTimes(2)
    expect(f.prove.mock.calls[1][0]).toMatchObject({ ...floor, sources: [expect.objectContaining({ version: '2' })] })
    expect(f.accumulator.evidence.sources?.[0].version).toBe('2')
  })

  // Regression: successful canonicalization may discover a higher historical
  // label than the next source revision exposes. Keep ONLY its label floor,
  // never merge its stale native pointers, before preparing a fresh proof.
  it('retains and revalidates successful canonical sensitivity/compartment floors when a concurrent tool adds a project', async () => {
    const f = admissionFixture(kind, true), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    const canonicalFloor = { sensitivity: 'confidential' as const, compartments: ['canonical-private'] }
    f.prove.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
      .mockImplementation(async evidence => {
        if (evidence.sensitivity === 'confidential' && evidence.compartments?.includes('canonical-private')) {
          // The first candidate admitted these labels under the original
          // ceiling. Fresh authority has since lost the compartment.
          throw new SourceProtocolError('source_access_denied')
        }
        return evidence
      })
    const pending = observe(f.admit())
    await entered.promise
    const old = f.prove.mock.calls[0][0]
    f.accumulator.note({ projectIds: ['project-added'], sources: old.sources!.map(source => ({ ...source, version: '2' })) })
    proof.resolve({ ...old, ...canonicalFloor })
    const outcome = await pending
    expect(f.prove).toHaveBeenCalledTimes(2)
    expect(f.prove.mock.calls[1][0]).toMatchObject({ ...canonicalFloor, projectIds: ['project-added'],
      sources: [expect.objectContaining({ version: '2' })] })
    expect(f.accumulator.evidence).toMatchObject({ ...canonicalFloor, projectIds: ['project-added'],
      sources: [expect.objectContaining({ version: '2' })] })
    expect(outcome).toMatchObject({ status: 'denied', error: { retrySafe: false } })
  })

  it('bounds continuous successful supersession to 32 candidates and makes exhaustion sticky', async () => {
    const f = admissionFixture(kind)
    f.prove.mockImplementation(async evidence => {
      f.accumulator.note({ projectIds: [`churn-${f.prove.mock.calls.length}`] })
      return evidence
    })
    expect(await observe(f.admit())).toMatchObject({ status: 'denied', error: { reason: 'authority_changed', retrySafe: false } })
    expect(f.prove).toHaveBeenCalledTimes(32)
    expect(await observe(f.admit())).toMatchObject({ status: 'denied' })
    expect(f.prove).toHaveBeenCalledTimes(32)
  })

  it('does not begin a proof after cancellation', async () => {
    const f = admissionFixture(kind), controller = new AbortController()
    f.context.abortSignal = controller.signal
    controller.abort(new Error('cancelled before admission'))
    expect(await observe(f.admit())).toMatchObject({ status: 'denied', error: { retrySafe: false } })
    expect(f.prove).not.toHaveBeenCalled()
  })

  it('checks cancellation after an awaited successful proof, without retrying supersession', async () => {
    const f = admissionFixture(kind), controller = new AbortController(), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    f.context.abortSignal = controller.signal
    f.prove.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
    const pending = observe(f.admit())
    await entered.promise
    f.accumulator.note(floor)
    controller.abort(new Error('cancelled during proof'))
    proof.resolve(f.prove.mock.calls[0][0])
    expect(await pending).toMatchObject({ status: 'denied', error: { retrySafe: false } })
    expect(f.prove).toHaveBeenCalledTimes(1)
    expect(await observe(f.admit())).toMatchObject({ status: 'denied' })
    expect(f.prove).toHaveBeenCalledTimes(1)
  })

  it('never retries an actual proof denial despite simultaneous evidence growth', async () => {
    const f = admissionFixture(kind), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    const failure = new SourceProtocolError('source_access_denied')
    f.prove.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
    const pending = observe(f.admit())
    await entered.promise
    f.accumulator.note(floor)
    proof.reject(failure)
    expect(await pending).toMatchObject({ status: 'denied', error: failure })
    expect(await observe(f.admit())).toMatchObject({ status: 'denied' })
    expect(f.prove).toHaveBeenCalledTimes(1)
  })

  it('does not let a concurrent successful candidate revive a denied execution', async () => {
    const f = admissionFixture(kind), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    f.prove.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
      .mockRejectedValueOnce(new SourceProtocolError('source_access_denied'))
    const pending = observe(f.admit())
    await entered.promise
    expect(await observe(f.admit())).toMatchObject({ status: 'denied' })
    proof.resolve(f.prove.mock.calls[0][0])
    expect(await pending).toMatchObject({ status: 'denied' })
    expect(f.prove).toHaveBeenCalledTimes(2)
  })
})


describe('conversation frontier candidates retain their positive owner', () => {
  it('re-admits records plus the complete newly raised fresh-source floor', async () => {
    const f = fixture(), entered = deferred<void>(), proof = deferred<Awaited<ReturnType<typeof admitTurnConversationRecords>>>()
    const record = { ...f.accumulator.evidence.sources![0], resourceKind: 'conversation_record', resourceId: 'record' }
    f.accumulator.note({ sources: [record] })
    native.mockImplementation(async (_execution, evidence) => evidence)
    const destination = { sensitivity: 'confidential', compartments: ['raised'], projectIds: ['fresh'] } as Awaited<ReturnType<typeof admitTurnConversationRecords>>['destination']
    vi.mocked(admitTurnConversationRecords).mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
      .mockResolvedValue({ sources: [record], destination })
    const pending = assertSourceModelInputAuthority(f.context)
    await entered.promise
    f.accumulator.note({ projectIds: ['fresh'], compartments: ['raised'] })
    proof.resolve({ sources: [record], destination })
    await pending
    expect(admitTurnConversationRecords).toHaveBeenCalledTimes(2)
    expect(admitTurnConversationRecords).toHaveBeenLastCalledWith(f.execution, [record], 'dispatch')
    expect(native.mock.calls[1][1]).toMatchObject({ projectIds: ['fresh'], compartments: ['raised'] })
    expect(f.accumulator.evidence.sources).toContainEqual(record)
  })
  it('a rejected record destination floor is never retried or made deliverable', async () => {
    const f = fixture()
    const record = { ...f.accumulator.evidence.sources![0], resourceKind: 'conversation_record', resourceId: 'record' }
    f.accumulator.note({ sources: [record], compartments: ['not-in-destination'] })
    native.mockImplementation(async (_execution, evidence) => evidence)
    vi.mocked(admitTurnConversationRecords).mockResolvedValue({ sources: [record], destination: {
      generation: '1', sensitivity: 'internal', compartments: [], projectIds: [] } as Awaited<ReturnType<typeof admitTurnConversationRecords>>['destination'] })
    await expect(assertSourceModelInputAuthority(f.context)).rejects.toMatchObject({ reason: 'authority_changed' })
    await expect(assertSourceModelInputAuthority(f.context)).rejects.toThrow()
    expect(admitTurnConversationRecords).toHaveBeenCalledTimes(1)
  })
})
