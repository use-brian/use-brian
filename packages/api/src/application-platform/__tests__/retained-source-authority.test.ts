import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createExecutionContext, type ScopeSource } from '@use-brian/core'
import type { PoolClient } from 'pg'
import { SOURCE_PROTOCOL_VERSION, type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
vi.mock('../../db/client.js', () => ({ getPool: vi.fn() }))
vi.mock('../source-store.js', () => ({ pinExternalSourceOperation: vi.fn(async () => {}), resolveNativeSourceRecipientCeiling: vi.fn() }))
import { getPool } from '../../db/client.js'
import { pinExternalSourceOperation, resolveNativeSourceRecipientCeiling } from '../source-store.js'
import { createRetainedSourceAuthorityCoordinator, pinPreparedExternalSourceAuthority } from '../retained-source-authority.js'

// These are batching/token-contract tests. Independent source rights are exercised by the real DB/HTTP fixture.
describe('[COMP:api/external-source-access] retained source batching and token binding', () => {
  beforeEach(() => vi.clearAllMocks())
  function fixture(count: number, identical = false) {
    const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), instanceId = randomUUID(), profileId = randomUUID()
    const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId }, access: { workspaceId,userId,assistantId,assistantKind: 'primary',clearance: 'confidential',compartments: [],mutationCompartments: [],projectIds: [],visibilityAssistantIds: [] },
      authority: { assertCurrent: vi.fn(async () => {}), execute: async operation => operation() }, writeDefaults: { compartments: [], projectIds: [] },
      lifecycle: { sessionId: randomUUID(),channelType: 'web',channelId: 'fixture',abortSignal: new AbortController().signal } })
    const sources: ScopeSource[] = Array.from({ length: count }, (_,index) => ({ workspaceId,userId: null,assistantId: null,
      resourceKind: 'external_source',resourceId: randomUUID(),version: String(index + 1),sensitivity: 'internal',compartments: [],projectIds: [] }))
    const rows = sources.map((source,index) => ({ id: source.resourceId,version: source.version,profileId,instanceId,sensitivity: source.sensitivity,compartments: [],projectIds: [],
      observation: { resource: { type: 'case',id: identical ? 'same' : String(index),contentVersion: '1',policyVersion: '1' },fields: ['description'],retention: { mode: 'governed' } } }))
    const query = vi.fn(async (_sql: string, values: unknown[]) => ({ rows: rows.filter(row => (values[1] as string[]).includes(row.id)) }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const authorize = vi.fn(async (request: SourceAuthorizationRequest) => ({ request,response: { version: SOURCE_PROTOCOL_VERSION,tenant: 'fixture',operationId: request.operationId,decisions: [] },requestDigest: 'fixture' }))
    const factory = vi.fn(async () => ({ execution,authorize }))
    const instances = { getAuthCredentialsSystem: vi.fn(async () => ({ type: 'bearer',token: 'fictional-transport' })) }
    vi.mocked(resolveNativeSourceRecipientCeiling).mockResolvedValue(execution.security.ceiling)
    const coordinator = createRetainedSourceAuthorityCoordinator({ factory: factory as never, instances: instances as never })
    return { execution,sources,rows,query,authorize,factory,coordinator,userId }
  }
  it('batches paired derive/retain requests under one operation without dropping observations', async () => {
    const f = fixture(121), token = await f.coordinator.prepare(f.execution, f.sources, 'retain')
    expect(f.query).toHaveBeenCalledTimes(2); expect(f.factory).toHaveBeenCalledTimes(1)
    const requests = f.authorize.mock.calls.map(([request]) => request)
    expect(requests.map(request => request.items.length)).toEqual([100,100,42])
    expect(requests.every(request => request.operationId === token.operationId)).toBe(true)
    expect(requests.flatMap(request => request.items).filter(item => item.action === 'derive')).toHaveLength(121)
    const client = { query: vi.fn(async () => ({ rows: [{ xid: '7',pid: 11,actor: f.userId }] })) } as unknown as PoolClient
    await pinPreparedExternalSourceAuthority(client, f.execution, token)
    expect(vi.mocked(pinExternalSourceOperation).mock.calls.flatMap(call => call[3])).toEqual(f.sources)
    await expect(pinPreparedExternalSourceAuthority(client, f.execution, structuredClone(token))).rejects.toMatchObject({ code: 'source_access_denied' })
    vi.mocked(client.query).mockResolvedValue({ rows: [{ xid: '8',pid: 11,actor: f.userId }] } as never)
    await expect(pinPreparedExternalSourceAuthority(client, f.execution, token)).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(pinExternalSourceOperation).toHaveBeenCalledTimes(3)
  })
  it('coalesces identical field checks while retaining every observation and rejecting conflicting copies', async () => {
    const f = fixture(3, true), token = await f.coordinator.prepare(f.execution, [...f.sources,f.sources[0]], 'retain')
    expect(f.authorize.mock.calls[0][0].items).toHaveLength(2)
    const client = { query: vi.fn(async () => ({ rows: [{ xid: '7',pid: 11,actor: f.userId }] })) } as unknown as PoolClient
    await pinPreparedExternalSourceAuthority(client, f.execution, token)
    expect(vi.mocked(pinExternalSourceOperation).mock.calls[0][3]).toEqual(f.sources)
    await expect(f.coordinator.prepare(f.execution, [f.sources[0],{ ...f.sources[0],version: 'changed' }], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    await expect(f.coordinator.prepare(f.execution, [{ ...f.sources[0],workspaceId: randomUUID() }], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(f.authorize).toHaveBeenCalledTimes(1)
  })
  it('expands native roots without losing external obligations and refuses unknown ancestry before HTTP', async () => {
    const f = fixture(1), root = { ...f.sources[0],resourceKind: 'memory',resourceId: randomUUID() }
    f.query.mockImplementation(async (sql: string, values: unknown[]) => sql.includes('read_external_source_dependencies')
      ? { rows: [{ nodeVersion: f.sources[0].version, source: f.sources[0] }] } as never
      : { rows: f.rows.filter(row => (values[1] as string[]).includes(row.id)) })
    const token = await f.coordinator.prepare(f.execution, [root], 'context')
    expect(f.query.mock.calls[0][0]).toContain('read_external_source_dependencies')
    expect(f.authorize.mock.calls[0][0].items[0].resource).toEqual(f.rows[0].observation.resource)
    f.query.mockResolvedValueOnce({ rows: [{ nodeVersion: 'missing', source: null }] } as never)
    await expect(f.coordinator.prepare(f.execution, [root], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    f.query.mockResolvedValueOnce({ rows: [{ nodeVersion: 'changed', source: f.sources[0] }] } as never)
    await expect(f.coordinator.prepare(f.execution, [root], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    f.query.mockResolvedValueOnce({ rows: [{ nodeVersion: f.sources[0].version, source: f.sources[0] }] } as never)
    await expect(f.coordinator.prepare(f.execution, [{ ...root,userId: randomUUID() }], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(f.authorize).toHaveBeenCalledTimes(1)
    f.query.mockResolvedValueOnce({ rows: [] } as never)
    const client = { query: vi.fn() } as unknown as PoolClient
    await expect(pinPreparedExternalSourceAuthority(client, f.execution, token)).rejects.toMatchObject({ code: 'source_access_denied' })
    await expect(pinPreparedExternalSourceAuthority(client, f.execution, token)).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(client.query).not.toHaveBeenCalled()
  })
  it('refuses missing or changed observations before network authorization', async () => {
    const f = fixture(1)
    f.rows[0].version = 'changed'
    await expect(f.coordinator.prepare(f.execution, f.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    f.rows.length = 0
    await expect(f.coordinator.prepare(f.execution, f.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(f.factory).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled()
  })
})
