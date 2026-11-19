import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextScopeAccumulator,
  type ScopeEvidence,
} from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import {
  createExecutionContext,
  executionToolContext,
  type CreateExecutionContextInput,
} from '@use-brian/agent-runtime/security/execution-context.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import type { Session } from '../../db/sessions.js'
import type { AuthorizeDeliveryAudience } from '../delivery-authority.js'
import { createAttendedDeliveryAudienceAuthorizer, admitAttendedAudienceEvidence } from '../attended-audience.js'
import { getApplicationExecutionBinding } from '../../application-platform/execution-context.js'
import { createTurnDeliveryAdmission, ownsTurnDeliveryAdmission } from '../admission.js'

vi.mock('../attended-audience.js', () => ({
  createAttendedDeliveryAudienceAuthorizer: vi.fn(),
  admitAttendedAudienceEvidence: vi.fn(),
}))
vi.mock('../../application-platform/execution-context.js', () => ({ getApplicationExecutionBinding: vi.fn() }))

const admit = vi.mocked(admitAttendedAudienceEvidence)
const fallback = vi.fn<AuthorizeDeliveryAudience>()

function source(id: string, resourceKind = 'memory', overrides: Partial<ScopeSource> = {}): ScopeSource {
  return { workspaceId: 'workspace', userId: null, assistantId: null, sensitivity: 'internal',
    compartments: [], projectIds: [], resourceKind, resourceId: id, version: '1', ...overrides }
}
function facts(shared = false): CreateExecutionContextInput {
  return {
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant', assistantKind: 'standard',
      clearance: shared ? 'internal' : 'confidential', compartments: shared ? [] : null,
      mutationCompartments: shared ? [] : null, projectIds: shared ? [] : null, visibilityAssistantIds: ['assistant'] },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent: vi.fn(async () => {}), execute: vi.fn(async operation => operation()) },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: 'session', channelType: 'web', channelId: 'channel' },
  }
}
function fixture(options: { shared?: boolean; evidence?: ScopeEvidence; input?: CreateExecutionContextInput; session?: Partial<Session> } = {}) {
  const input = options.input ?? facts(options.shared)
  if (options.shared) input.access.sharedAudience = true
  const execution = createExecutionContext(input)
  const accumulator = new ContextScopeAccumulator(options.evidence)
  // Trusted stored-row fixture: these are all discriminator/destination fields the snapshot reads.
  const session = { id: 'session', userId: 'actor', channelType: 'web', channelId: 'channel',
    visibility: options.shared ? 'workspace' : 'personal', anchorKind: 'none', appOrigin: 'chat', mode: 'conversation',
    effectiveClearance: 'internal', contextCompartments: [], contextProjectId: null,
    ...options.session } as Session
  const context: ToolContext = { ...executionToolContext(execution, { appId: 'chat' }), scopeAccumulator: accumulator }
  const snapshot = createTurnDeliveryAdmission(execution, accumulator, session)
  return { input, execution, accumulator, session, context, snapshot }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getApplicationExecutionBinding).mockReturnValue(undefined)
  vi.mocked(createAttendedDeliveryAudienceAuthorizer).mockReturnValue(fallback)
  admit.mockImplementation(async (_execution, evidence) => evidence)
  fallback.mockImplementation(async input => ({ allowed: true, evidence: input.scopeEvidence ?? {} }))
})

describe('[COMP:api/private-transcript] native web delivery admission', () => {
  it('admits complete evidence afresh for every text/reasoning chunk', async () => {
    const f = fixture({ evidence: { sources: [source('initial')] } })
    expect(f.snapshot).toBeDefined()
    expect(Object.isFrozen(f.snapshot)).toBe(true)
    expect(admit).not.toHaveBeenCalled()
    for (let chunk = 0; chunk < 100; chunk++) await f.snapshot!.authorizeDelivery(f.context)
    expect(admit).toHaveBeenCalledTimes(100)
    expect(admit).toHaveBeenLastCalledWith(f.execution, f.accumulator.evidence,
      expect.objectContaining({ userId: 'actor', workspaceId: 'workspace', visibilityAssistantIds: null }), { directHumanSource: true })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('submits all source observations with the accumulated label floor', async () => {
    const a = source('a', 'memory', { compartments: ['finance'], projectIds: ['project-a'] })
    const b = source('b', 'workspace_file', { sensitivity: 'confidential', compartments: ['legal'], projectIds: ['project-b'] })
    const f = fixture({ evidence: { sources: [a] } })
    await f.snapshot!.authorizeDelivery(f.context)
    f.accumulator.note({ sources: [b] })
    await f.snapshot!.authorizeDelivery(f.context)
    expect(admit.mock.calls[1][1]).toEqual({ sensitivity: 'confidential', compartments: ['finance', 'legal'],
      projectIds: ['project-a', 'project-b'], sources: [a, b] })
    await f.snapshot!.authorizeDelivery(f.context)
    expect(admit).toHaveBeenCalledTimes(3)
  })

  it('revalidates a changed sensitivity floor even without new sources', async () => {
    const f = fixture({ evidence: { sources: [source('a')] } })
    await f.snapshot!.authorizeDelivery(f.context)
    f.accumulator.note({ sensitivity: 'confidential', compartments: ['finance'], projectIds: ['project'] })
    admit.mockRejectedValueOnce(new Error('floor denied'))
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow('floor denied')
    expect(admit.mock.calls[1][1]).toEqual({ sensitivity: 'confidential', compartments: ['finance'], projectIds: ['project'], sources: [source('a')] })
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('keeps the actor but admits against the correct private/shared recipient axis (shared=%s)', async shared => {
    const f = fixture({ shared, evidence: { sources: [source('a')] } })
    await f.snapshot!.authorizeDelivery(f.context)
    expect(admit.mock.calls[0][0]).toBe(f.execution)
    expect(f.execution.security.access.userId).toBe('actor')
    expect(admit.mock.calls[0][2]).toMatchObject({ userId: shared ? '' : 'actor', visibilityAssistantIds: null })
    expect(admit.mock.calls[0][3]).toEqual({ directHumanSource: !shared })
    expect(f.execution.security.ceiling.visibilityAssistantIds).toEqual(['assistant'])
  })

  it('admits an already room-bounded department execution without losing its grant', async () => {
    const input = facts(true)
    input.access.departmentRead = { workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant',
      base: 'internal', departments: {}, contextDepartment: null, binding: null, cap: null }
    const f = fixture({ shared: true, input })
    expect(f.snapshot).toBeDefined()
    await f.snapshot!.authorizeDelivery(f.context)
    expect(admit).toHaveBeenCalledWith(f.execution, f.accumulator.evidence,
      expect.objectContaining({ userId: '', clearance: 'internal', compartments: [], projectIds: [] }), { directHumanSource: false })
    expect(admit.mock.calls[0][2].departmentRead).toBeUndefined()
    expect(f.execution.security.ceiling.departmentRead).toEqual(input.access.departmentRead)
  })

  it('does not export delivery permission as model-input, live execution, or writer authority', async () => {
    const f = fixture()
    const modelInput = vi.fn(async () => { throw new Error('model input denied') })
    const context = { ...f.context, admitModelInput: modelInput }
    await f.snapshot!.authorizeDelivery(context)
    expect(modelInput).not.toHaveBeenCalled()
    await expect(context.admitModelInput()).rejects.toThrow('model input denied')
    expect(f.execution.security.authority).toBe(f.input.authority)
    expect(f.execution.security.writeDefaults).toEqual(f.input.writeDefaults)
    expect(f.context.authority).toBe(f.input.authority)
    expect(f.snapshot).not.toHaveProperty('admitModelInput')
    expect(f.snapshot).not.toHaveProperty('execute')
  })

  it.each([
    ['missing native authentication', (i: CreateExecutionContextInput) => { i.identity = { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor' } } }],
    ['verified channel', (i: CreateExecutionContextInput) => { i.identity = { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor', authenticationKind: 'verified_channel' } } }],
    ['system invocation', (i: CreateExecutionContextInput) => { i.identity = { kind: 'system', purpose: 'worker', jobId: 'job' } }],
    ['system read', (i: CreateExecutionContextInput) => { i.access.systemRead = true; i.surface = { systemRead: true } }],
    ['external transport', (i: CreateExecutionContextInput) => { i.lifecycle.channelType = 'slack' }],
    ['different session', (i: CreateExecutionContextInput) => { i.lifecycle.sessionId = 'other' }],
    ['different channel', (i: CreateExecutionContextInput) => { i.lifecycle.channelId = 'other' }],
    ['independent provenance', (i: CreateExecutionContextInput) => { i.provenance = { sources: [source('provenance', 'external_source')] } }],
    ['native provenance', (i: CreateExecutionContextInput) => { i.provenance = { sources: [source('provenance')] } }],
    ['shared access for private destination', (i: CreateExecutionContextInput) => { i.access.sharedAudience = true }],
  ] as const)('does not qualify unsupported profile: %s', (_name, change) => {
    const input = facts(); change(input)
    expect(fixture({ input }).snapshot).toBeUndefined()
    expect(admit).not.toHaveBeenCalled()
    expect(createAttendedDeliveryAudienceAuthorizer).not.toHaveBeenCalled()
  })

  it.each([
    { userId: 'another-owner' }, { visibility: 'workspace' }, { appOrigin: 'doc' }, { channelType: 'slack' },
  ])('does not qualify mismatched or non-chat session %j', session => {
    expect(fixture({ session }).snapshot).toBeUndefined()
  })

  it.each([
    ['unbounded compartments', (i: CreateExecutionContextInput) => { i.access.compartments = null }],
    ['unbounded projects', (i: CreateExecutionContextInput) => { i.access.projectIds = null }],
    ['above-room clearance', (i: CreateExecutionContextInput) => { i.access.clearance = 'confidential' }],
    ['above-room compartments', (i: CreateExecutionContextInput) => { i.access.compartments = ['finance'] }],
    ['above-room projects', (i: CreateExecutionContextInput) => { i.access.projectIds = ['project'] }],
  ] as const)('declines shared snapshot with %s', (_name, change) => {
    const input = facts(true)
    change(input)
    expect(fixture({ shared: true, input }).snapshot).toBeUndefined()
    expect(admit).not.toHaveBeenCalled()
    expect(createAttendedDeliveryAudienceAuthorizer).not.toHaveBeenCalled()
  })

  it.each(['compartments', 'projects', 'assistant visibility', 'mutation compartments'] as const)('refuses changed %s after successful admission', async kind => {
    const f = fixture({ shared: true })
    await f.snapshot!.authorizeDelivery(f.context)
    const ceiling = f.execution.security.ceiling
    if (kind === 'compartments') (ceiling.compartments as string[]).push('finance')
    else if (kind === 'projects') (ceiling.projectIds as string[]).push('project')
    else if (kind === 'assistant visibility') (ceiling.visibilityAssistantIds as string[]).push('other')
    else (ceiling.mutationCompartments as string[]).push('finance')
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each(['ceiling', 'sessionId', 'channelId', 'channelType'] as const)('refuses mutation of frozen %s', async kind => {
    const f = fixture({ shared: true })
    await f.snapshot!.authorizeDelivery(f.context)
    if (kind === 'ceiling') {
      expect(() => Object.assign(f.execution.security, { ceiling: { ...f.execution.security.ceiling } })).toThrow(TypeError)
    } else {
      expect(() => Object.assign(f.execution.lifecycle, { [kind]: 'other' })).toThrow(TypeError)
    }
    // The rejected mutation cannot change the response's destination or grant.
    await f.snapshot!.authorizeDelivery(f.context)
    expect(admit).toHaveBeenCalledTimes(2)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not qualify application-bound execution', () => {
    vi.mocked(getApplicationExecutionBinding).mockReturnValue({} as NonNullable<ReturnType<typeof getApplicationExecutionBinding>>)
    expect(fixture().snapshot).toBeUndefined()
  })

  it('makes an admission failure sticky', async () => {
    const f = fixture()
    admit.mockRejectedValueOnce(new Error('revoked'))
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow('revoked')
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each(['actor', 'accumulator', 'response', 'authority'] as const)('refuses another %s and permanently invalidates the original admission', async kind => {
    const f = fixture()
    await f.snapshot!.authorizeDelivery(f.context)
    const otherFacts = facts()
    if (kind === 'actor') {
      otherFacts.access.userId = 'another-actor'
      otherFacts.identity = { kind: 'attended', principal: { kind: 'workspace_member', userId: 'another-actor', authenticationKind: 'native_session' } }
    }
    const other = fixture({ input: otherFacts })
    const wrong: ToolContext = kind === 'accumulator' ? { ...f.context, scopeAccumulator: new ContextScopeAccumulator() }
      : kind === 'authority' ? { ...f.context, authority: other.context.authority } : other.context
    await expect(f.snapshot!.authorizeDelivery(wrong)).rejects.toThrow()
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it('admits external evidence on every output through the same source operation', async () => {
    const f = fixture({ shared: true, evidence: { sources: [source('external', 'external_source')] } })
    for (let chunk = 0; chunk < 4; chunk++) await f.snapshot!.authorizeDelivery(f.context)
    expect(admit).toHaveBeenCalledTimes(4)
    expect(admit).toHaveBeenLastCalledWith(f.execution, f.accumulator.evidence,
      expect.objectContaining({ userId: '', workspaceId: 'workspace' }), { directHumanSource: false })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('retains discovered external ancestry in every subsequent admission', async () => {
    const field = source('field', 'application_field'), external = source('external', 'external_source')
    const f = fixture({ evidence: { sources: [field] } })
    admit.mockResolvedValueOnce({ sources: [field, external] })
    await f.snapshot!.authorizeDelivery(f.context)
    f.accumulator.note({ sources: [source('new-native')] })
    await f.snapshot!.authorizeDelivery(f.context)
    await f.snapshot!.authorizeDelivery(f.context)
    expect(admit).toHaveBeenCalledTimes(3)
    expect(fallback).not.toHaveBeenCalled()
    expect(admit.mock.calls[1][1].sources).toEqual([field, external, source('new-native')])
    expect(admit.mock.calls[2][1]).toEqual(f.accumulator.evidence)
  })

  it.each(['memory', 'external_source'])('refuses a revoked %s source on an unchanged next output', async kind => {
    const f = fixture({ evidence: { sources: [source('source', kind)] } })
    await f.snapshot!.authorizeDelivery(f.context)
    admit.mockRejectedValueOnce(new Error('source revoked'))
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow('source revoked')
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(2)
    expect(admit.mock.calls[1][1]).toEqual(admit.mock.calls[0][1])
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each(['native', 'external'] as const)('refuses evidence mutation during async %s admission and stays invalid', async kind => {
    const f = fixture({ evidence: { sources: [source('a', kind === 'native' ? 'memory' : 'external_source')] } })
    const gate = deferred<void>()
    admit.mockImplementationOnce(async (_execution, evidence) => { await gate.promise; return evidence })
    const pending = f.snapshot!.authorizeDelivery(f.context)
    f.accumulator.note({ sources: [source('arrived-while-awaiting')] })
    gate.resolve()
    await expect(pending).rejects.toThrow()
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit.mock.calls.length + fallback.mock.calls.length).toBe(1)
  })

  it.each(['execution', 'context'] as const)('honors %s cancellation with unchanged evidence', async kind => {
    const controller = new AbortController(), input = facts()
    if (kind === 'execution') input.lifecycle.abortSignal = controller.signal
    const f = fixture({ input })
    const context = kind === 'context' ? { ...f.context, abortSignal: controller.signal } : f.context
    await f.snapshot!.authorizeDelivery(context)
    controller.abort()
    await expect(f.snapshot!.authorizeDelivery(context)).rejects.toThrow()
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it('denies cancellation while admission is awaiting', async () => {
    const controller = new AbortController(), gate = deferred<ScopeEvidence>()
    const f = fixture()
    admit.mockReturnValueOnce(gate.promise)
    const pending = f.snapshot!.authorizeDelivery({ ...f.context, abortSignal: controller.signal })
    controller.abort()
    gate.resolve({})
    await expect(pending).rejects.toThrow()
    expect(fallback).not.toHaveBeenCalled()
  })
  it('binds the original execution and rejects copied admission ownership',()=>{
    const f=fixture(),other=fixture()
    expect(ownsTurnDeliveryAdmission(f.snapshot!,f.context)).toBe(true)
    expect(ownsTurnDeliveryAdmission({...f.snapshot!},f.context)).toBe(false)
    expect(ownsTurnDeliveryAdmission(f.snapshot!,other.context)).toBe(false)
  })
  it.each(['dispose','abort'] as const)('refuses pending output after %s without reviving a fresh context',async transition=>{
    const controller=new AbortController(),input=facts()
    input.lifecycle.abortSignal=controller.signal
    const f=fixture({input}),gate=deferred<void>()
    admit.mockImplementationOnce(async(_execution,evidence)=>{await gate.promise;return evidence})
    const pending=expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    if(transition==='dispose')f.snapshot!.dispose();else controller.abort()
    gate.resolve()
    await pending
    f.snapshot!.dispose()
    expect(ownsTurnDeliveryAdmission(f.snapshot!,f.context)).toBe(false)
    await expect(f.snapshot!.authorizeDelivery({...f.context})).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })

})
