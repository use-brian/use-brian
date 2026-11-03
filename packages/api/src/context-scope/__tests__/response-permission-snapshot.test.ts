import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextScopeAccumulator, createExecutionContext, executionToolContext,
  type CreateExecutionContextInput, type ScopeEvidence, type ScopeSource, type ToolContext,
} from '@use-brian/core'
import type { Session } from '../../db/sessions.js'
import type { AuthorizeDeliveryAudience } from '../delivery-authority.js'
import { createAttendedDeliveryAudienceAuthorizer, validateAttendedAudienceEvidence } from '../attended-audience.js'
import { getApplicationExecutionBinding } from '../../application-platform/execution-context.js'
import { createWebResponsePermissionSnapshot, ownsWebResponsePermissionSnapshot } from '../response-permission-snapshot.js'

vi.mock('../attended-audience.js', () => ({
  createAttendedDeliveryAudienceAuthorizer: vi.fn(),
  validateAttendedAudienceEvidence: vi.fn(),
}))
vi.mock('../../application-platform/execution-context.js', () => ({ getApplicationExecutionBinding: vi.fn() }))

const admit = vi.mocked(validateAttendedAudienceEvidence)
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
  const snapshot = createWebResponsePermissionSnapshot(execution, accumulator, session)
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

describe('native web response delivery snapshot', () => {
  it('admits the first output once and uses its receipt across many text/reasoning chunks', async () => {
    const f = fixture({ evidence: { sources: [source('initial')] } })
    expect(f.snapshot).toBeDefined()
    expect(Object.isFrozen(f.snapshot)).toBe(true)
    expect(admit).not.toHaveBeenCalled()
    for (let chunk = 0; chunk < 100; chunk++) await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit).toHaveBeenCalledExactlyOnceWith(f.execution, f.accumulator.evidence,
      expect.objectContaining({ userId: 'actor', workspaceId: 'workspace', visibilityAssistantIds: null }), { directHumanSource: true })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('submits only new source observations while preserving the full accumulated label floor', async () => {
    const a = source('a', 'memory', { compartments: ['finance'], projectIds: ['project-a'] })
    const b = source('b', 'workspace_file', { sensitivity: 'confidential', compartments: ['legal'], projectIds: ['project-b'] })
    const f = fixture({ evidence: { sources: [a] } })
    await f.snapshot!.assertOutputAuthority(f.context)
    f.accumulator.note({ sources: [b] })
    await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit.mock.calls[1][1]).toEqual({ sensitivity: 'confidential', compartments: ['finance', 'legal'],
      projectIds: ['project-a', 'project-b'], sources: [b] })
    await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it('revalidates a changed sensitivity floor even without new sources', async () => {
    const f = fixture({ evidence: { sources: [source('a')] } })
    await f.snapshot!.assertOutputAuthority(f.context)
    f.accumulator.note({ sensitivity: 'confidential', compartments: ['finance'], projectIds: ['project'] })
    admit.mockRejectedValueOnce(new Error('floor denied'))
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow('floor denied')
    expect(admit.mock.calls[1][1]).toEqual({ sensitivity: 'confidential', compartments: ['finance'], projectIds: ['project'], sources: [] })
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('keeps the actor but admits against the correct private/shared recipient axis (shared=%s)', async shared => {
    const f = fixture({ shared, evidence: { sources: [source('a')] } })
    await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit.mock.calls[0][0]).toBe(f.execution)
    expect(f.execution.security.access.userId).toBe('actor')
    expect(admit.mock.calls[0][2]).toMatchObject({ userId: shared ? '' : 'actor', visibilityAssistantIds: null })
    expect(admit.mock.calls[0][3]).toEqual({ directHumanSource: !shared })
    expect(f.execution.security.ceiling.visibilityAssistantIds).toEqual(['assistant'])
  })

  it('does not export delivery permission as model-input, live execution, or writer authority', async () => {
    const f = fixture()
    const modelInput = vi.fn(async () => { throw new Error('model input denied') })
    const context = { ...f.context, assertModelInputAuthority: modelInput }
    await f.snapshot!.assertOutputAuthority(context)
    expect(modelInput).not.toHaveBeenCalled()
    await expect(context.assertModelInputAuthority()).rejects.toThrow('model input denied')
    expect(f.execution.security.authority).toBe(f.input.authority)
    expect(f.execution.security.writeDefaults).toEqual(f.input.writeDefaults)
    expect(f.context.authority).toBe(f.input.authority)
    expect(f.snapshot).not.toHaveProperty('assertModelInputAuthority')
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

  it.each(['compartments', 'projects', 'assistant visibility', 'mutation compartments'] as const)('refuses changed %s even after an unchanged receipt', async kind => {
    const f = fixture({ shared: true })
    await f.snapshot!.assertOutputAuthority(f.context)
    const ceiling = f.execution.security.ceiling
    if (kind === 'compartments') (ceiling.compartments as string[]).push('finance')
    else if (kind === 'projects') (ceiling.projectIds as string[]).push('project')
    else if (kind === 'assistant visibility') (ceiling.visibilityAssistantIds as string[]).push('other')
    else (ceiling.mutationCompartments as string[]).push('finance')
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each(['ceiling', 'sessionId', 'channelId', 'channelType'] as const)('refuses mutation of frozen %s', async kind => {
    const f = fixture({ shared: true })
    await f.snapshot!.assertOutputAuthority(f.context)
    if (kind === 'ceiling') {
      expect(() => Object.assign(f.execution.security, { ceiling: { ...f.execution.security.ceiling } })).toThrow(TypeError)
    } else {
      expect(() => Object.assign(f.execution.lifecycle, { [kind]: 'other' })).toThrow(TypeError)
    }
    // The rejected mutation cannot change the response's destination or grant.
    await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not qualify application-bound execution', () => {
    vi.mocked(getApplicationExecutionBinding).mockReturnValue({} as NonNullable<ReturnType<typeof getApplicationExecutionBinding>>)
    expect(fixture().snapshot).toBeUndefined()
  })

  it('makes an admission failure sticky', async () => {
    const f = fixture()
    admit.mockRejectedValueOnce(new Error('revoked'))
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow('revoked')
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each(['actor', 'accumulator', 'response', 'authority'] as const)('refuses receipt reuse on another %s and poisons the original snapshot', async kind => {
    const f = fixture()
    await f.snapshot!.assertOutputAuthority(f.context)
    const otherFacts = facts()
    if (kind === 'actor') {
      otherFacts.access.userId = 'another-actor'
      otherFacts.identity = { kind: 'attended', principal: { kind: 'workspace_member', userId: 'another-actor', authenticationKind: 'native_session' } }
    }
    const other = fixture({ input: otherFacts })
    const wrong: ToolContext = kind === 'accumulator' ? { ...f.context, scopeAccumulator: new ContextScopeAccumulator() }
      : kind === 'authority' ? { ...f.context, authority: other.context.authority } : other.context
    expect(ownsWebResponsePermissionSnapshot(f.snapshot!, f.context)).toBe(true)
    expect(ownsWebResponsePermissionSnapshot(f.snapshot!, wrong)).toBe(false)
    await expect(f.snapshot!.assertOutputAuthority(wrong)).rejects.toThrow()
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it('cannot forge snapshot ownership with a copied object', () => {
    const f = fixture()
    expect(ownsWebResponsePermissionSnapshot({ ...f.snapshot! }, f.context)).toBe(false)
  })

  it('uses live fallback on every external-source output, including unchanged chunks', async () => {
    const f = fixture({ shared: true, evidence: { sources: [source('external', 'external_source')] } })
    for (let chunk = 0; chunk < 4; chunk++) await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(4)
    expect(fallback).toHaveBeenLastCalledWith({ workspaceId: 'workspace', assistantId: 'assistant', userId: 'actor',
      channelType: 'web', channelId: 'channel', sessionId: 'session', recipientType: 'group', scopeEvidence: f.accumulator.evidence })
  })

  it('discovers external ancestry through a native field and makes live fallback sticky', async () => {
    const field = source('field', 'application_field'), external = source('external', 'external_source')
    const f = fixture({ evidence: { sources: [field] } })
    admit.mockResolvedValueOnce({ sources: [field, external] })
    // Even if fallback returns only native evidence, discovering independent ancestry is permanent.
    fallback.mockResolvedValue({ allowed: true, evidence: {} })
    await f.snapshot!.assertOutputAuthority(f.context)
    f.accumulator.note({ sources: [source('new-native')] })
    await f.snapshot!.assertOutputAuthority(f.context)
    await f.snapshot!.assertOutputAuthority(f.context)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(3)
    expect(fallback.mock.calls[1][0].scopeEvidence?.sources).toEqual([field, source('new-native')])
  })

  it('does not reuse an earlier native receipt after external evidence arrives', async () => {
    const f = fixture({ evidence: { sources: [source('native')] } })
    await f.snapshot!.assertOutputAuthority(f.context)
    f.accumulator.note({ sources: [source('external', 'external_source')] })
    await f.snapshot!.assertOutputAuthority(f.context)
    fallback.mockResolvedValueOnce({ allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'source_unverifiable' })
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it.each(['native', 'external'] as const)('refuses evidence mutation during async %s admission and stays invalid', async kind => {
    const f = fixture({ evidence: { sources: [source('a', kind === 'native' ? 'memory' : 'external_source')] } })
    const gate = deferred<void>()
    if (kind === 'native') admit.mockImplementationOnce(async (_execution, evidence) => { await gate.promise; return evidence })
    else fallback.mockImplementationOnce(async input => { await gate.promise; return { allowed: true, evidence: input.scopeEvidence! } })
    const pending = f.snapshot!.assertOutputAuthority(f.context)
    f.accumulator.note({ sources: [source('arrived-while-awaiting')] })
    gate.resolve()
    await expect(pending).rejects.toThrow()
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit.mock.calls.length + fallback.mock.calls.length).toBe(1)
  })

  it.each(['execution', 'context'] as const)('honors %s cancellation even on the unchanged receipt path', async kind => {
    const controller = new AbortController(), input = facts()
    if (kind === 'execution') input.lifecycle.abortSignal = controller.signal
    const f = fixture({ input })
    const context = kind === 'context' ? { ...f.context, abortSignal: controller.signal } : f.context
    await f.snapshot!.assertOutputAuthority(context)
    controller.abort()
    await expect(f.snapshot!.assertOutputAuthority(context)).rejects.toThrow()
    await expect(f.snapshot!.assertOutputAuthority(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it('denies cancellation while admission is awaiting', async () => {
    const controller = new AbortController(), gate = deferred<ScopeEvidence>()
    const f = fixture()
    admit.mockReturnValueOnce(gate.promise)
    const pending = f.snapshot!.assertOutputAuthority({ ...f.context, abortSignal: controller.signal })
    controller.abort()
    gate.resolve({})
    await expect(pending).rejects.toThrow()
    expect(fallback).not.toHaveBeenCalled()
  })
})
