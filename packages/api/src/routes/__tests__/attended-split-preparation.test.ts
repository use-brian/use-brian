import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindScopeSources, boundScopeSources, ContextScopeAccumulator, type SessionContextAuthority, type LLMProvider, type SplitResult } from '@use-brian/core'
import type { Session, SessionMessage } from '../../db/sessions.js'
import { captureAttendedSessionClassification, forkAttendedSessionClassification, prepareAttendedSplitMessage } from '../attended-session-context.js'

const spies = vi.hoisted(() => ({ query: vi.fn(), proof: vi.fn(), classify: vi.fn() }))
vi.mock('@use-brian/core', async original => ({ ...await original<typeof import('@use-brian/core')>(),
  classifySplit: spies.classify, executionToolContext: (execution: unknown, base: object) => ({ ...base, executionContext: execution }),
}))
vi.mock('../../db/session-query-reader.js', () => ({ readAdmittedSessionQuery: spies.query, captureSessionTopics: vi.fn(), sessionQueryRootMetadata: vi.fn() }))
vi.mock('../../application-platform/model-source-authority.js', () => ({ assertSourceModelInputAuthority: spies.proof, ownsNativeAttendedAssembly: vi.fn() }))

const body = 'A fictional authored request requiring an independent splitter assessment.'
const result: SplitResult = { tasks: ['Fictional lookup A', 'Fictional lookup B'], usage: { inputTokens: 8, outputTokens: 4 }, model: 'fixture-model' }
async function fixture(content: unknown = [{ type: 'text', text: body }]) {
  const controller = new AbortController()
  const authority = { execution: { security: { authority: { assertCurrent: vi.fn().mockResolvedValue(undefined) }, access: { workspaceId: 'workspace-fixture' } }, lifecycle: { abortSignal: controller.signal } }, accumulator: new ContextScopeAccumulator() } as unknown as SessionContextAuthority
  const session = { id: 'session-fixture' } as Session
  const message = { id: 'message-fixture', sessionId: session.id, role: 'user', sequenceNum: 1, content } as SessionMessage
  const source = { workspaceId: 'workspace-fixture', userId: 'user-fixture', assistantId: null, sensitivity: 'public' as const, compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: message.id, version: '1' }
  const query = bindScopeSources({ history: [message] }, [source])
  spies.query.mockResolvedValue(query)
  const capture = await captureAttendedSessionClassification({ authority, session, message })
  const branch = forkAttendedSessionClassification({ authority, session, message, capture })
  const provider = { name: 'routing' } as LLMProvider
  const input = { authority: branch.authority, session, message, capture: branch.capture, provider, rawMessage: body, signal: controller.signal }
  return { authority, branch, input, provider, controller, source }
}
beforeEach(() => {
  vi.clearAllMocks()
  spies.proof.mockResolvedValue(undefined)
  spies.classify.mockImplementation(async options => { await options.assertInputAuthority(); return structuredClone(result) })
})

describe('admitted early Standard splitter result', () => {
  it('retains legacy routing and acquires new source authority when consumed', async () => {
    const f = await fixture()
    const start = Date.now()
    const prepared = await prepareAttendedSplitMessage(f.input)
    expect(prepared).toBeDefined()
    const options = spies.classify.mock.calls[0]![0]
    expect(options.message).toBe(body)
    expect(options.provider).toBe(f.provider)
    expect(options.model).toBeUndefined()
    expect(options.decisionRuntime).toBeUndefined()
    expect(options.deadlineAt).toBeGreaterThanOrEqual(start + 8000)
    expect(boundScopeSources(options)).toEqual([f.source])
    expect(prepared!.matches(body, f.provider)).toBe(true)
    expect(prepared!.matches(body + ' changed', f.provider)).toBe(false)
    expect(prepared!.matches(body, { ...f.provider })).toBe(false)
    const before = spies.proof.mock.calls.length
    expect(await prepared!.read()).toMatchObject(result)
    expect(spies.proof.mock.calls.length).toBe(before + 1)
    expect(spies.classify).toHaveBeenCalledTimes(1)
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it.each([
    { content: [{ type: 'text', text: body + ' changed' }] },
    { content: [{ type: 'text', text: body }, { type: 'image', data: 'fictional' }] },
  ])('does not classify different or mixed canonical input', async ({ content }) => {
    const f = await fixture(content)
    expect(await prepareAttendedSplitMessage(f.input)).toBeUndefined()
    expect(spies.classify).not.toHaveBeenCalled()
  })
  it('retains source refusal at dispatch rather than treating it as no-split', async () => {
    const f = await fixture()
    const refusal = new Error('Fictional inaccessible source')
    spies.proof.mockRejectedValueOnce(refusal)
    await expect(prepareAttendedSplitMessage(f.input)).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('refuses a completed data result after revocation at consumption', async () => {
    const f = await fixture()
    const prepared = await prepareAttendedSplitMessage(f.input)
    spies.proof.mockRejectedValueOnce(new Error('Fictional revoked source'))
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(spies.classify).toHaveBeenCalledTimes(1)
  })
  it('claims consumption before awaiting its proof, so concurrent reads cannot both win', async () => {
    const f = await fixture()
    const prepared = await prepareAttendedSplitMessage(f.input)
    const before = spies.proof.mock.calls.length
    const outcomes = await Promise.allSettled([prepared!.read(), prepared!.read()])
    expect(outcomes[0].status).toBe('fulfilled')
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { reason: 'authority_changed' } })
    expect(spies.proof.mock.calls.length).toBe(before + 1)
  })
  it('does not allow a refused consumption attempt to be retried into success', async () => {
    const f = await fixture()
    const prepared = await prepareAttendedSplitMessage(f.input)
    spies.proof.mockRejectedValueOnce(new Error('Fictional transient refusal'))
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
    const before = spies.proof.mock.calls.length
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(spies.proof.mock.calls.length).toBe(before)
  })
  it.each(['sessionId', 'role', 'sequenceNum'] as const)('fences mutable message %s identity', async field => {
    const f = await fixture()
    const prepared = await prepareAttendedSplitMessage(f.input)
    if (field === 'sequenceNum') f.input.message.sequenceNum++
    else if (field === 'role') f.input.message.role = 'assistant'
    else f.input.message.sessionId = 'other-session-fixture'
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('fences the root authority as well as the fork', async () => {
    const f = await fixture()
    const prepared = await prepareAttendedSplitMessage(f.input)
    ;(f.authority as { execution: SessionContextAuthority['execution'] }).execution = { ...f.authority.execution }
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('does not expose task prompts in the usage summary and pins model output bytes', async () => {
    const f = await fixture()
    const mutable = structuredClone(result)
    spies.classify.mockImplementationOnce(async options => { await options.assertInputAuthority(); return mutable })
    const prepared = await prepareAttendedSplitMessage(f.input)
    mutable.tasks![0] = 'Changed after preparation'
    expect(Object.keys(prepared!)).toEqual(['usage', 'model', 'matches', 'read'])
    expect((await prepared!.read()).tasks).toEqual(result.tasks)
  })
  it('does not consume prepared work after a caller cancellation', async () => {
    const f = await fixture()
    const prepared = await prepareAttendedSplitMessage(f.input)
    const reason = new Error('Fictional stopped turn')
    f.controller.abort(reason)
    await expect(prepared!.read()).rejects.toBe(reason)
  })
})
