import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  boundScopeSources, ContextScopeAccumulator, createExecutionContext,
  type ExecutionContext, type SessionContextAuthority, type ScopeSource,
} from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import {
  bindPrivateTranscriptCredential, inheritPrivateTranscriptCredential, readPrivateTranscript,
} from '../../db/private-transcript.js'
import { restrictTitleJobAuthority } from '../session-title-worker.js'
import { restrictStateJobAuthority } from '../session-state-worker.js'
import type { SessionTitleJob } from '../../db/session-title-jobs.js'
import type { SessionStateJob } from '../../db/session-state-jobs.js'

const db = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), release: vi.fn(), applyRLSGucs: vi.fn(),
  runWithAgentAccess: vi.fn(), getPool: vi.fn(), systemQuery: vi.fn(),
}))

// Keep worker dependency exports real, but no path in this suite can open a pool.
vi.mock('../../db/client.js', async () => ({
  ...await vi.importActual<typeof import('../../db/client.js')>('../../db/client.js'),
  getAppPool: () => ({ connect: db.connect }),
  getPool: db.getPool,
  query: db.systemQuery,
  rollbackAndRelease: db.release,
  applyRLSGucs: db.applyRLSGucs,
  runWithAgentAccess: db.runWithAgentAccess,
}))

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ids = { workspace: uid(1), user: uid(2), assistant: uid(3), session: uid(4),
  userMessage: uid(5), nativeSession: uid(6), lease: uid(7), assistantMessage: uid(8) }
const ceiling = { workspaceId: ids.workspace, userId: ids.user, clearance: 'internal' as const,
  compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [ids.assistant] }
const nativeCredential = { userId: ids.user, sessionId: ids.nativeSession, authVersion: 3 }
// Deliberately different from the private host binding: queued claims are not credentials.
const titleJob: SessionTitleJob = {
  sessionId: ids.session, workspaceId: ids.workspace, actorUserId: ids.user, assistantId: ids.assistant,
  userMessageId: ids.userMessage, claims: { userId: ids.user, sessionId: uid(9), authVersion: 7 },
  authoring: { version: 1, assistantId: ids.assistant, ceiling }, generation: '1',
  claimedGeneration: '1', leaseToken: ids.lease, attempts: 1,
}
const stateJob: SessionStateJob = { ...titleJob, userMessageId: ids.userMessage, assistantMessageId: ids.assistantMessage,
  firstSequence: 1, throughSequence: 2 }
const source: ScopeSource = { workspaceId: ids.workspace, userId: ids.user, assistantId: null,
  resourceKind: 'private_transcript', resourceId: ids.session, version: '1',
  sensitivity: 'internal', compartments: [], projectIds: [] }
const capture = { source, rows: [
  { id: ids.userMessage, sequence: 1, role: 'user', timestamp: '2026-01-01T00:00:00Z',
    available: true, content: 'Please remember my choice.' },
  { id: ids.assistantMessage, sequence: 2, role: 'assistant', timestamp: '2026-01-01T00:00:01Z',
    available: true, content: 'I will remember your choice.' },
] }

function fixture(bind = true) {
  let leaseCurrent = true
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: ids.user,
      authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: ids.workspace },
    access: { ...ceiling, assistantId: ids.assistant, assistantKind: 'standard', sharedAudience: false },
    writeDefaults: { compartments: [], projectIds: [] },
    provenance: { sensitivity: 'public', compartments: [], projectIds: [] },
    authority: createAuthorityLease(ceiling, async () => leaseCurrent ? ceiling : null),
    lifecycle: { sessionId: ids.session, sessionPersisted: true, channelType: 'web', channelId: ids.session,
      transport: 'web', abortSignal: new AbortController().signal },
    surface: {}, attribution: { billingUserId: ids.user },
  })
  if (bind) bindPrivateTranscriptCredential(execution, nativeCredential)
  const authority: SessionContextAuthority = { execution, accumulator: new ContextScopeAccumulator(execution.security.provenance) }
  return { authority, revoke: () => { leaseCurrent = false } }
}

beforeEach(() => {
  vi.resetAllMocks()
  db.getPool.mockImplementation(() => { throw new Error('Unexpected system pool access') })
  db.systemQuery.mockImplementation(() => { throw new Error('Unexpected system query') })
  db.connect.mockResolvedValue({ query: db.query })
  db.applyRLSGucs.mockResolvedValue(undefined)
  db.release.mockResolvedValue(undefined)
  db.runWithAgentAccess.mockImplementation((_access, callback) => callback())
  db.query.mockImplementation(async (sql: string) => {
    if (sql === 'SELECT capture_private_transcript($1,$2,$3,$4,$5) AS value') return { rows: [{ value: capture }] }
    if (['BEGIN', 'COMMIT', 'ROLLBACK', "SELECT set_config('app.v2_assistant_id',$1,true)"].includes(sql)) return { rows: [] }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
})

const workers = [
  { name: 'title', restrict: (a: SessionContextAuthority, current: () => Promise<boolean>, signal: AbortSignal) =>
    restrictTitleJobAuthority(a, JSON.parse(JSON.stringify(titleJob)), current, signal), changed: 'title_job_changed' },
  { name: 'state', restrict: (a: SessionContextAuthority, current: () => Promise<boolean>, signal: AbortSignal) =>
    restrictStateJobAuthority(a, JSON.parse(JSON.stringify(stateJob)), current, signal), changed: 'state_job_changed' },
]

describe.each(workers)('$name job private transcript authority', ({ restrict, changed }) => {
  function restrictedFixture(bind = true) {
    const f = fixture(bind), controller = new AbortController()
    let current = true
    const restricted = restrict(f.authority, async () => current, controller.signal)
    return { ...f, restricted, controller, supersede: () => { current = false } }
  }

  it('inherits the native credential across the execution wrapper and retains bound transcript evidence', async () => {
    const f = restrictedFixture()
    expect(f.restricted.execution).not.toBe(f.authority.execution)
    expect(f.restricted.accumulator).toBe(f.authority.accumulator)
    expect(f.restricted.execution.lifecycle.abortSignal).toBe(f.controller.signal)
    const rows = await readPrivateTranscript(f.restricted, ids.session, 2)
    expect(rows?.map(row => row.content)).toEqual([
      [{ type: 'text', text: 'Please remember my choice.' }],
      [{ type: 'text', text: 'I will remember your choice.' }],
    ])
    expect(rows).not.toBeNull()
    expect(boundScopeSources(rows!)).toEqual([source])
    for (const row of rows!) expect(boundScopeSources(row)).toEqual([source])
    expect(f.authority.accumulator.evidence.sources).toEqual([source])
    expect(db.query.mock.calls).toEqual([
      ['BEGIN'], ["SELECT set_config('app.v2_assistant_id',$1,true)", [ids.assistant]],
      ['SELECT capture_private_transcript($1,$2,$3,$4,$5) AS value',
        [ids.workspace, ids.session, nativeCredential.sessionId, nativeCredential.authVersion, 2]],
      ['COMMIT'],
    ])
    expect(db.connect).toHaveBeenCalledOnce()
    expect(db.applyRLSGucs).toHaveBeenCalledWith(expect.objectContaining({ query: db.query }), ids.user)
    expect(db.runWithAgentAccess).toHaveBeenCalledWith(f.authority.execution.security.access, expect.any(Function))
    expect(db.release).toHaveBeenCalledOnce()
  })

  it('cannot mint a private credential from valid serialized job claims without an original binding', async () => {
    const f = restrictedFixture(false)
    expect(await readPrivateTranscript(f.authority, ids.session, 2)).toBeNull()
    expect(await readPrivateTranscript(f.restricted, ids.session, 2)).toBeNull()
    expect(db.connect).not.toHaveBeenCalled()
    expect(db.query).not.toHaveBeenCalled()
  })

  it.each(['superseded', 'aborted', 'revoked'] as const)('blocks a %s lease before any database query', async reason => {
    const f = restrictedFixture()
    if (reason === 'superseded') f.supersede()
    if (reason === 'aborted') f.controller.abort(new Error('job_aborted'))
    if (reason === 'revoked') f.revoke()
    const read = readPrivateTranscript(f.restricted, ids.session, 2)
    if (reason === 'revoked') await expect(read).rejects.toMatchObject({ reason: 'authority_changed' })
    else await expect(read).rejects.toThrow(reason === 'aborted' ? 'job_aborted' : changed)
    expect(db.runWithAgentAccess).not.toHaveBeenCalled()
    expect(db.connect).not.toHaveBeenCalled()
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('private transcript credential inheritance guards', () => {
  const changes: Array<{ name: string; change: (e: ExecutionContext) => ExecutionContext }> = [
    { name: 'access object', change: e => ({ ...e, security: { ...e.security, access: { ...e.security.access } } }) },
    { name: 'identity object', change: e => ({ ...e, identity: { ...e.identity } }) },
    { name: 'session source', change: e => ({ ...e, lifecycle: { ...e.lifecycle, sessionId: uid(20) } }) },
    { name: 'ownership', change: e => ({ ...e, ownership: { kind: 'workspace', workspaceId: uid(21) } }) },
    { name: 'assistant', change: e => ({ ...e, assistant: { ...e.assistant, id: uid(22) } }) },
    { name: 'surface', change: e => ({ ...e, surface: { readOnly: true } }) },
    { name: 'ceiling', change: e => ({ ...e, security: { ...e.security, ceiling: { ...e.security.ceiling } } }) },
    { name: 'provenance', change: e => ({ ...e, security: { ...e.security, provenance: { ...e.security.provenance } } }) },
    { name: 'channel source', change: e => ({ ...e, lifecycle: { ...e.lifecycle, channelId: uid(23) } }) },
  ]
  it.each(changes)('rejects a changed $name without binding the other execution', async ({ change }) => {
    const { authority } = fixture(), other = change(authority.execution)
    expect(() => inheritPrivateTranscriptCredential(authority.execution, other)).toThrow('scope_source_changed')
    expect(await readPrivateTranscript({ ...authority, execution: other }, other.lifecycle.sessionId, 2)).toBeNull()
    expect(db.connect).not.toHaveBeenCalled()
    expect(db.query).not.toHaveBeenCalled()
  })
})
