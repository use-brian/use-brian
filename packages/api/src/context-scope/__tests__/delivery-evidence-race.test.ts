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

vi.mock('../../db/channel-integrations.js', () => ({ getGroupAudienceBindingsSystem: vi.fn() }))
vi.mock('../../db/channel-identity-bindings.js', () => ({ isWechatRecipientCurrentSystem: vi.fn() }))
vi.mock('../conversation-record-admission.js', () => ({ recordEvidenceParts: () => null }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn() }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn() }))
vi.mock('../../db/sessions.js', () => ({ findSessionByChannel: vi.fn(), readSessionById: vi.fn() }))
vi.mock('../../db/client.js', () => ({ getPool: () => { throw new Error('Unexpected DB access') }, getAppPool: () => { throw new Error('Unexpected DB access') }, query: vi.fn() }))
vi.mock('../resolve-turn-scope.js', () => ({ projectRoomAudienceCeiling: vi.fn(), resolveLiveAccessCeilingSystem: vi.fn() }))
// Isolate the current destination owner; these source/page paths have their own suites.
vi.mock('../native-page-delivery.js', () => ({ tryAdmitNativePageTurnDelivery: vi.fn(), tryReadNativePageTurnAnchor: vi.fn() }))
vi.mock('../caller-evidence.js', () => ({ assertScopeEvidenceFitsCeiling: vi.fn() }))
vi.mock('../../application-platform/model-source-authority.js', () => ({ admitModelSourceEvidence: vi.fn() }))
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

describe('[COMP:api/delivery-authority] current destination owner evidence candidates', () => {
  it('re-admits a superseded successful proof retaining labels, not old pointers', async () => {
    const f = fixture({ evidence: { sources: [source('a', 'session_message')] } })
    const entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    admit.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
    const pending = f.snapshot!.authorizeDelivery(f.context)
    await entered.promise
    f.accumulator.note({ sources: [source('a', 'session_message', { version: '2' })], projectIds: ['fresh'] })
    proof.resolve({ sources: [source('a', 'session_message')], sensitivity: 'confidential', compartments: ['canonical'] })
    await pending
    expect(admit).toHaveBeenCalledTimes(2)
    expect(admit.mock.calls[1][1]).toMatchObject({ sensitivity: 'confidential', compartments: ['canonical'], projectIds: ['fresh'],
      sources: [expect.objectContaining({ version: '2' })] })
    expect(f.accumulator.evidence.sources).toEqual([source('a', 'session_message', { version: '2' })])
    expect(admit.mock.calls[1][0]).toBe(f.execution)
  })
  it('never retries a thrown recipient denial despite evidence growth', async () => {
    const f = fixture()
    const failure = new Error('Fictional recipient revoked')
    admit.mockImplementationOnce(async () => { f.accumulator.noteProjectIds(['raised']); throw failure })
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toBe(failure)
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })
  it('a concurrent successful candidate cannot revive a denied destination', async () => {
    const f = fixture(), entered = deferred<void>(), proof = deferred<ScopeEvidence>()
    admit.mockImplementationOnce(async () => { entered.resolve(); return proof.promise })
    const pending = f.snapshot!.authorizeDelivery(f.context).then(() => false, () => true)
    await entered.promise
    admit.mockRejectedValueOnce(new Error('Fictional recipient revoked'))
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    proof.resolve({}); expect(await pending).toBe(true)
    expect(admit).toHaveBeenCalledTimes(2)
  })
  it('bounds successful churn to 32 and retains sticky exhaustion', async () => {
    const f = fixture()
    admit.mockImplementation(async (_execution, evidence) => { f.accumulator.noteProjectIds(['raised-' + admit.mock.calls.length]); return evidence })
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(32)
  })
  it('cancellation after successful admission releases no output and starts no new candidate', async () => {
    const controller = new AbortController(), input = facts()
    input.lifecycle.abortSignal = controller.signal
    const f = fixture({ input })
    admit.mockImplementationOnce(async (_execution, evidence) => { f.accumulator.noteProjectIds(['raised']); controller.abort(); return evidence })
    await expect(f.snapshot!.authorizeDelivery(f.context)).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(1)
  })
})
