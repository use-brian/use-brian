/** [COMP:api/turn-kernel] The original owner's main-turn history acquisition:
 * reader selection, exact reader arguments, the invocation binding before and
 * after the read, Stop, once-per-owner, evidence noting and the preparation
 * SQL frame. Only lease SQL and the readers are fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { createExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import {
  bindScopeSources,
  boundScopeSources
} from '@use-brian/agent-runtime/security/source-evidence.js'
import type { CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'
vi.mock('../lease.js', async importOriginal => ({ ...await importOriginal<typeof import('../lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'history-token', turnId: 'c'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import { abortLocalTurn } from '../lease.js'
import { configureTurnHistoryReaders, type TurnHistoryReaders } from '../history.js'
import { configureHarnessTurnContext } from '../../project-harness/turn-context.js'
import { currentTurnFrame, setTurnSqlRecording } from '../../db/turn-sql-accounting.js'
import type { SessionMessage } from '../../db/sessions.js'

const identity = { workspace: '00000000-0000-4000-8000-000000000050', assistant: 'history-assistant', user: 'history-user', session: 'history-session' }
const provider = { name: 'unused', models: [], stream() { throw new Error('unused') } } as unknown as LLMProvider
const owners: AssistantTurn[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.finish('failed'); configureTurnHistoryReaders(null); configureHarnessTurnContext(null); setTurnSqlRecording(undefined) })
beforeEach(() => vi.clearAllMocks())

const source = (id: string): ScopeSource => ({ workspaceId: identity.workspace, userId: null, assistantId: identity.assistant, sensitivity: 'internal',
  compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: id, version: '1' })
const row = (id: string) => bindScopeSources({ id, sessionId: identity.session, role: 'user', content: [{ type: 'text', text: 'Fictional row' }], sequenceNum: 1 } as unknown as SessionMessage, [source(id)])

async function fixture(lane: 'web' | 'resume' = 'web') {
  const abort = new AbortController()
  const authority: CurrentAuthorityBoundary = { assertCurrent: vi.fn(async () => {}), async execute(operation) { return operation() } }
  const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.user, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: identity.workspace },
    access: { workspaceId: identity.workspace, userId: identity.user, assistantId: identity.assistant, assistantKind: 'standard', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [identity.assistant] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: identity.session, channelType: 'web', channelId: 'fixture', abortSignal: abort.signal } })
  const owner = await openAssistantTurn({ sessionId: identity.session, assistantId: identity.assistant, policy: { admission: 'personal' }, abortController: abort })
  owners.push(owner)
  const services = { provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null }
  // Durable resume binds its canonical execution under its own lane; its stored read carries no native authority.
  const accumulator = new ContextScopeAccumulator()
  owner.bindModelPreparation({ kind: 'execution', toolProfile: lane, execution, scopeAccumulator: accumulator, assertCurrent: async () => {} }, services)
  return { owner, abort, execution, native: { execution, accumulator }, accumulator }
}

function readers(overrides: Partial<TurnHistoryReaders> = {}) {
  const value = {
    native: vi.fn(async () => ({ messages: [row('native-1')], frame: { native: true } as never, readTurnCount: vi.fn(async () => 3) })),
    stored: vi.fn(async () => [row('stored-1')]),
    ...overrides,
  }
  configureTurnHistoryReaders(value)
  return value
}

describe('[COMP:api/turn-kernel] owner prepareHistory', () => {
  it('selects the native reader for the bound authority with exactly the adapter arguments and notes evidence', async () => {
    const r = readers(), f = await fixture()
    const history = await f.owner.prepareHistory({ native: f.native, fromSequence: 7, evidence: f.accumulator })
    expect(r.native).toHaveBeenCalledExactlyOnceWith(f.native, identity.session, 7, undefined)
    expect(r.stored).not.toHaveBeenCalled()
    expect(history).toMatchObject({ source: 'native', frame: { native: true } })
    expect(Object.isFrozen(history)).toBe(true)
    expect(boundScopeSources(history.messages[0]!)).toEqual([source('native-1')])
    expect(f.accumulator.evidence.sources?.map(entry => entry.resourceId)).toContain('native-1')
  })

  it('uses the classifier continuation instead of a second native read', async () => {
    const r = readers(), f = await fixture()
    const classified = { readHistory: vi.fn(async () => ({ messages: [row('classified-1')], frame: {} as never, readTurnCount: async () => 1 })) }
    const history = await f.owner.prepareHistory({ native: f.native, fromSequence: null, classified })
    expect(classified.readHistory).toHaveBeenCalledExactlyOnceWith(f.native, null)
    expect(r.native).not.toHaveBeenCalled()
    expect(history.messages.map(entry => entry.id)).toEqual(['classified-1'])
  })

  it('reads the stored transcript with the adapter projection, held rows excluded by the reader', async () => {
    const r = readers(), f = await fixture()
    const project = vi.fn(async (rows: SessionMessage[]) => rows.filter(() => false))
    const history = await f.owner.prepareHistory({ native: null, fromSequence: null, projectStored: project })
    expect(r.stored).toHaveBeenCalledExactlyOnceWith(identity.session, { fromSequence: null })
    expect(project).toHaveBeenCalledOnce()
    expect(history).toMatchObject({ source: 'stored', messages: [] })
    // Durable resume passes no window: the reader gets no fromSequence key.
    const g = await fixture('resume')
    await g.owner.prepareHistory({ native: null })
    expect(r.stored).toHaveBeenLastCalledWith(identity.session, {})
  })

  it('refuses a native authority that is not the owner execution, on every lane including resume', async () => {
    readers()
    const f = await fixture(), other = await fixture()
    expect(() => f.owner.prepareHistory({ native: other.native })).toThrow(expect.objectContaining({ reason: 'authority_changed' }))
    const g = await fixture('resume')
    expect(() => g.owner.prepareHistory({ native: f.native })).toThrow(expect.objectContaining({ reason: 'authority_changed' }))
  })

  it('runs once, only before run preparation, and refuses its result after Stop during the read', async () => {
    let release!: () => void
    const r = readers({ native: vi.fn(() => new Promise<Awaited<ReturnType<TurnHistoryReaders['native']>>>(resolve => {
      release = () => resolve({ messages: [], frame: {} as never, readTurnCount: async () => 0 }) })) })
    const f = await fixture()
    const reading = f.owner.prepareHistory({ native: f.native })
    const outcome = expect(reading).rejects.toBeDefined()
    expect(() => f.owner.prepareHistory({ native: f.native })).toThrow('already started')
    await vi.waitFor(() => expect(r.native).toHaveBeenCalled())
    abortLocalTurn(identity.session, 'history-token')
    release(); await outcome
  })

  it('reads inside the owner preparation SQL frame while recording', async () => {
    setTurnSqlRecording(true)
    const frames: Array<string | undefined> = []
    readers({ stored: vi.fn(async () => { frames.push(currentTurnFrame()?.frameId); return [] }) })
    const f = await fixture()
    await f.owner.prepareHistory({ native: null })
    expect(frames).toEqual(['preparation'])
    expect(currentTurnFrame()).toBeUndefined()
  })
})

it('[COMP:api/turn-kernel] harness retains the bound accumulator on lanes that do not read history', async () => {
  const f = await fixture()
  await f.owner.prepareMainModel({ kind: 'web', plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false })
  const resolver = vi.fn(async () => ({ name: 'project_harness' as const, content: 'contract' }))
  configureHarnessTurnContext(resolver)
  await f.owner.prepareRun({ systemPrompt: 'policy', messages: [], candidateTools: new Map() })
  expect(resolver).toHaveBeenCalledExactlyOnceWith(f.execution, expect.any(Map), f.accumulator)
})

it('[COMP:api/turn-kernel] history cannot replace the accumulator adopted with the original invocation', async () => {
  const r = readers(), f = await fixture()
  expect(() => f.owner.prepareHistory({ native: null, evidence: new ContextScopeAccumulator() })).toThrow('original turn accumulator')
  expect(r.stored).not.toHaveBeenCalled()
  expect(r.native).not.toHaveBeenCalled()
  await f.owner.prepareHistory({ native: f.native })
  expect(r.native).toHaveBeenCalledOnce()
})

it('[COMP:api/turn-kernel] harness receives the privately retained history accumulator, never adapter assembly data', async () => {
  readers()
  const f = await fixture()
  const original = f.accumulator, foreign = new ContextScopeAccumulator()
  const reading = f.owner.prepareHistory({ native: f.native })
  await reading
  f.native.accumulator = foreign
  await f.owner.prepareMainModel({ kind: 'web', plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false })
  const resolver = vi.fn(async () => ({ name: 'project_harness' as const, content: 'contract' }))
  configureHarnessTurnContext(resolver)
  const result = await f.owner.prepareRun({ systemPrompt: 'policy', messages: [], candidateTools: new Map(),
    // Even an untyped old adapter cannot substitute its own accumulator.
    scopeAccumulator: foreign } as Parameters<AssistantTurn['prepareRun']>[0])
  expect(resolver).toHaveBeenCalledExactlyOnceWith(f.execution, expect.any(Map), original)
  expect(result.grounding.runtimeContext).toBe('')
})
