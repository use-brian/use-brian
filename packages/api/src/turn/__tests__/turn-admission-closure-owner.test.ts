/** [COMP:api/turn-admission-closure] The turn owner opens one admission closure
 * for its invocation's lease when it binds model preparation and disposes it in
 * `finish`: the closure is turn state, never module state, and never reaches
 * another lease, another execution or a later turn. Only lease SQL is fake. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { createExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'
vi.mock('../lease.js', async importOriginal => ({ ...await importOriginal<typeof import('../lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'closure-token', turnId: 'd'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import { beginClosureAdmission, openTurnAdmissionClosure } from '../../context-scope/admission-closure.js'

const identity = { workspace: '00000000-0000-4000-8000-000000000051', assistant: 'closure-assistant', user: 'closure-user', session: 'closure-session' }
const provider = { name: 'unused', models: [], stream() { throw new Error('unused') } } as unknown as LLMProvider
const services = { provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null }
const owners: AssistantTurn[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.finish('failed') })

function execution() {
  const authority: CurrentAuthorityBoundary = { assertCurrent: vi.fn(async () => {}), async execute(operation) { return operation() } }
  return createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.user, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: identity.workspace },
    access: { workspaceId: identity.workspace, userId: identity.user, assistantId: identity.assistant, assistantKind: 'standard', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [identity.assistant] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: identity.session, channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal } })
}
async function owner() {
  const turn = await openAssistantTurn({ sessionId: identity.session, assistantId: identity.assistant, policy: { admission: 'personal' }, abortController: new AbortController() })
  owners.push(turn)
  return turn
}

describe('[COMP:api/turn-admission-closure] the turn owner owns its admission closure', () => {
  it('opens the closure for the bound execution and disposes it when the turn finishes', async () => {
    const turn = await owner(), bound = execution()
    expect(beginClosureAdmission(bound)).toBeUndefined()
    turn.bindModelPreparation({ kind: 'execution', toolProfile: 'web', execution: bound, assertCurrent: async () => {} }, services)
    expect(beginClosureAdmission(bound)).toBeDefined()
    expect(turn.admissionClosureStats()).toEqual({ proofs: 0, discoveries: 0, sharedProofs: 0, extendedProofs: 0, sharedDiscoveries: 0, witnesses: 0, discarded: 0 })
    await turn.finish('completed')
    expect(beginClosureAdmission(bound)).toBeUndefined()
    expect(turn.admissionClosureStats()).toBeUndefined()
  })

  it('never reaches another execution, another lease or a second owner of the same lease', async () => {
    const turn = await owner(), bound = execution(), other = execution()
    turn.bindModelPreparation({ kind: 'execution', toolProfile: 'web', execution: bound, assertCurrent: async () => {} }, services)
    // Another execution has its own lease: no closure.
    expect(beginClosureAdmission(other)).toBeUndefined()
    // A copy holding the same lease is not the bound execution: no closure.
    expect(beginClosureAdmission({ ...bound, security: { ...bound.security } })).toBeUndefined()
    // A second closure cannot be opened on a lease that already has one.
    expect(openTurnAdmissionClosure(bound)).toBeUndefined()
    const second = await owner()
    second.bindModelPreparation({ kind: 'execution', toolProfile: 'web', execution: bound, assertCurrent: async () => {} }, services)
    expect(second.admissionClosureStats()).toBeUndefined()
    await turn.finish('completed')
    // After the first turn ends, a later turn on the same lease starts empty.
    const later = openTurnAdmissionClosure(bound)
    expect(later?.stats()).toEqual({ proofs: 0, discoveries: 0, sharedProofs: 0, extendedProofs: 0, sharedDiscoveries: 0, witnesses: 0, discarded: 0 })
    later?.dispose()
  })
})
