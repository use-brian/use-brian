import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { externalServiceCanonicalRoutes } from './canonical.js'
import type { ExternalServiceContext } from './context.js'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'

const serviceId = '10000000-0000-4000-8000-000000000001'
const context = { version: 1, serviceId, workspaceId: '10000000-0000-4000-8000-000000000002',
  userId: '10000000-0000-4000-8000-000000000003', authorizationId: '10000000-0000-4000-8000-000000000004', scope: 'read_write', revision: '1' } as ExternalServiceContext
function fixture(scope: 'read' | 'read_write' = 'read_write') {
  const authority = { assertCurrent: vi.fn(async () => {}) }
  const execution = { security: { authority } } as unknown as ExecutionContext
  const authenticate = vi.fn(async () => ({ ...context, scope }))
  const resolve = vi.fn(async () => execution)
  const service = { query: vi.fn(async () => ({ records: [] })), command: vi.fn(async () => ({ effect: 'committed' })),
    reconcile: vi.fn(async () => ({ state: 'uncertain' })) }
  const app = express(); app.use('/api/external-services/:serviceId', externalServiceCanonicalRoutes({ authenticate, resolve, service } as never))
  const post = (mode: string, body: object) => request(app).post(`/api/external-services/${serviceId}/canonical/${mode}`).set('Authorization', 'Bearer oat_fixture').send(body)
  return { app, post, service, authenticate, resolve, execution, authority }
}
describe('[COMP:api/external-services] canonical service transport', () => {
  it('uses current OAuth identity for canonical owners without admitting caller modules or identity', async () => {
    const f = fixture()
    expect((await f.post('query', { key: 'query', input: { type: 'company', query: {} } })).status).toBe(200)
    expect(f.service.query).toHaveBeenCalledWith(f.execution, 'native', 'query', { type: 'company', query: {} })
    expect((await f.post('query', { key: 'query', input: {}, moduleKey: 'erp', userId: context.userId })).status).toBe(400)
    expect(f.service.query).toHaveBeenCalledTimes(1)
  })
  it('rejects absent credentials, revoked contexts and a different service audience before owner access', async () => {
    const f = fixture()
    expect((await request(f.app).post(`/api/external-services/${serviceId}/canonical/query`).send({ key: 'get', input: {} })).status).toBe(401)
    f.authenticate.mockResolvedValueOnce(null as never)
    expect((await f.post('query', { key: 'get', input: {} })).status).toBe(401)
    f.authenticate.mockResolvedValueOnce({ ...context, serviceId: context.workspaceId })
    expect((await f.post('query', { key: 'get', input: {} })).status).toBe(401)
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.service.query).not.toHaveBeenCalled()
  })
  it('requires write consent for mutations and reconciliation and rejects non-CRM commands', async () => {
    const f = fixture('read'), body = { key: 'create_company', command: { idempotencyKey: 'fixture', input: { name: 'Fictional' } } }
    expect((await f.post('command', body)).status).toBe(403)
    expect((await f.post('reconcile', body)).status).toBe(403)
    expect(f.service.command).not.toHaveBeenCalled(); expect(f.service.reconcile).not.toHaveBeenCalled()
    const writer = fixture()
    expect((await writer.post('command', { ...body, key: 'create_task' })).status).toBe(400)
    expect((await writer.post('command', body)).status).toBe(200)
    expect(writer.service.command).toHaveBeenCalledWith(writer.execution, 'native', body.key, body.command)
  })
  it('preserves a committed effect when access changes after the canonical owner returns', async () => {
    const f = fixture()
    f.authority.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApplicationPlatformError('access_unavailable', 'Changed'))
    const response = await f.post('command', { key: 'create_company', command: { idempotencyKey: 'fixture', input: { name: 'Fictional' } } })
    expect(response.status).toBe(403); expect(response.body).toMatchObject({ effect: 'committed', retrySafe: false })
  })
  it('exposes equivalent read-only MCP discovery with no mutation tools', async () => {
    const f = fixture('read')
    const response = await request(f.app).post(`/api/external-services/${serviceId}/canonical/mcp`)
      .set('Authorization', 'Bearer oat_fixture').set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2025-03-26').send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(response.status).toBe(200)
    expect(response.text).toContain('canonicalQuery'); expect(response.text).not.toContain('canonicalCommand')
  })
  it('advertises bounded canonical file candidates through the shared MCP query vocabulary',async()=>{
    const f=fixture('read')
    const response=await request(f.app).post(`/api/external-services/${serviceId}/canonical/mcp`).set('Authorization','Bearer oat_fixture').set('Accept','application/json, text/event-stream').send({jsonrpc:'2.0',id:1,method:'tools/list'})
    expect(response.status).toBe(200);expect(response.text).toContain('file_candidates')
    expect((await f.post('query',{key:'file_candidates',input:{query:'file',limit:101}})).status).toBe(400)
  })

})
