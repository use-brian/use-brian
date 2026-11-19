import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'

const fixture = vi.hoisted(() => ({ query: vi.fn(), rollback: vi.fn(), release: vi.fn() }))
vi.mock('../client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../client.js')>(),
  getAppPool: () => ({ connect: async () => ({ query: fixture.query, release: fixture.release }) }),
  applyRLSGucs: vi.fn(), rollbackAndRelease: fixture.rollback,
  runWithAgentAccess: async (_access: unknown, run: () => Promise<unknown>) => run(),
}))
vi.mock('../../application-platform/external-source-ancestry.js', () => ({ readExternalSourceAncestors: async () => [] }))
vi.mock('../../application-platform/field-evidence.js', () => ({ readApplicationFieldAncestors: async () => [] }))
vi.mock('../../application-platform/source-runtime.js', () => ({ getSharedRetainedSourceAuthority: () => undefined }))
vi.mock('../../application-platform/execution-context.js', () => ({
  applyApplicationRLSContext: vi.fn(), releaseApplicationTransactionBinding: vi.fn(), getApplicationExecutionBinding: () => undefined,
}))
vi.mock('../../context-scope/caller-evidence.js', () => ({ validateCallerScopeEvidence: async () => ({}) }))
import { withSessionMessagePublication } from '../session-context-revisions.js'

describe('[COMP:api/session-publication-completion] bounded deferred proof', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixture.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS bypass') ? [{ bypass: false }] : [] }))
  })
  function setup() {
    const abort = new AbortController()
    const assertCurrent = vi.fn(async () => {}),markOperationMayHaveExecuted=vi.fn()
    const authority = { accumulator: new ContextScopeAccumulator(), execution: {
      identity: { kind: 'attended', principal: { kind: 'workspace_member' } }, assistant: { id: 'assistant' },
      security: { access: { workspaceId: 'workspace', userId: 'reader' }, ceiling: {}, authority: { assertCurrent,markOperationMayHaveExecuted } },
      lifecycle: { sessionId: 'session', abortSignal: abort.signal },
    } } as unknown as SessionContextAuthority
    return { authority, abort, assertCurrent,markOperationMayHaveExecuted }
  }
  it('runs all deferred checks before its last authority check and COMMIT', async () => {
    const { authority, assertCurrent } = setup()
    const order: string[] = []
    fixture.query.mockImplementation(async (sql: string) => { order.push(sql); return { rows: sql.includes('AS bypass') ? [{ bypass: false }] : [] } })
    assertCurrent.mockImplementation(async () => { order.push('authority') })
    const measurements: string[] = []
    const measure = async <T>(name: string, run: () => Promise<T>): Promise<T> => { measurements.push(name); return run() }
    await expect(withSessionMessagePublication(authority, [], async () => { order.push('write'); return 'saved' }, { measure })).resolves.toBe('saved')
    expect(order.slice(order.indexOf('write'), order.indexOf('COMMIT') + 1)).toEqual(['write', 'SET CONSTRAINTS ALL IMMEDIATE', 'authority', 'COMMIT'])
    expect(measurements).toContain('publication_constraints')
    expect(fixture.release).toHaveBeenCalledOnce()
    expect(fixture.rollback).not.toHaveBeenCalled()
  })
  it.each(['timeout', 'abort', 'authority'] as const)('rolls back a %s during deferred completion without committing', async failure => {
    const { authority, abort, assertCurrent } = setup()
    fixture.query.mockImplementation(async (sql: string) => {
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        if (failure === 'timeout') throw Object.assign(new Error('statement timeout'), { code: '57014' })
        if (failure === 'abort') abort.abort()
        if (failure === 'authority') assertCurrent.mockRejectedValueOnce(new Error('authority changed'))
      }
      return { rows: sql.includes('AS bypass') ? [{ bypass: false }] : [] }
    })
    await expect(withSessionMessagePublication(authority, [], async () => 'saved')).rejects.toThrow()
    expect(fixture.query.mock.calls.map(call => call[0])).not.toContain('COMMIT')
    expect(fixture.rollback).toHaveBeenCalledOnce()
  })
  it('owns post-commit uncertainty without a duplicate route authority bracket or replay',async()=>{
    const {authority,assertCurrent,markOperationMayHaveExecuted}=setup()
    assertCurrent.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('Fictional post-commit authority withdrawal'))
    const write=vi.fn(async()=> 'saved')
    await expect(withSessionMessagePublication(authority,[],write)).rejects.toMatchObject({retrySafe:false,operationMayHaveExecuted:true})
    expect(write).toHaveBeenCalledOnce()
    expect(markOperationMayHaveExecuted).toHaveBeenCalledOnce()
    expect(fixture.query.mock.calls.filter(call=>call[0]==='COMMIT')).toHaveLength(1)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

})
