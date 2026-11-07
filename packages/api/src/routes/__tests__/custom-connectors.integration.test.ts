/**
 * One owner for custom MCP lifecycle coverage across HTTP, encryption and SQL.
 * Only the remote MCP service is substituted. Auth middleware is outside this
 * factory's contract; identities below are the authenticated request context.
 * Required by the native operation-stores acceptance lane; never self-skips.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { customConnectorRoutes } from '../custom-connectors.js'
import { createDbConnectorStore } from '../../db/connector-store.js'
import { encryptCredentials } from '../../db/credential-crypto.js'
import { getAppPool, getPool, query } from '../../db/client.js'

const discover = vi.hoisted(() => vi.fn())
vi.mock('../../mcp/client.js', () => ({ discoverMcpServer: discover }))
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

const key = randomBytes(32)
const store = createDbConnectorStore(key)
const base = { name: 'Fixture MCP', url: 'https://mcp.example.test/sse' }
let owner: string

function app(userId: string | undefined = owner, encryptionKey: Buffer | null = key) {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => { req.userId = userId; next() })
  server.use('/api/connectors', customConnectorRoutes({ connectorStore: createDbConnectorStore(encryptionKey) }))
  return request(server)
}
async function user() {
  const id = randomUUID()
  await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [id])
  return id
}
async function create(auth: Record<string, unknown> = {}) {
  const response = await app().post('/api/connectors/custom').send({ ...base, ...auth }).expect(200)
  expect(response.body.connectorInstanceId).toBe(response.body.connector.id)
  expect(response.body.connector).toMatchObject({ custom: true, connected: false })
  for (const field of ['bearerToken', 'headerValue', 'oauthClientSecret']) {
    if (typeof auth[field] === 'string') expect(response.text).not.toContain(auth[field])
  }
  return response.body.id as string
}
const patch = (id: string, auth: Record<string, unknown>) =>
  app().patch(`/api/connectors/custom/${id}`).send({ ...base, ...auth })
const probe = (id: string) => app().post(`/api/connectors/custom/${id}/test`)
async function saved(id: string, userId = owner) {
  return (await createDbConnectorStore(key).list(userId)).find(row => row.connectorId === id)
}
async function blob(id: string) {
  return (await query<{ credentials: Buffer | null; credentials_type: string }>(
    'SELECT credentials, credentials_type FROM connector_instance WHERE user_id=$1 AND provider=$2', [owner, id],
  )).rows[0]
}
beforeEach(async () => {
  owner = await user()
  discover.mockReset().mockResolvedValue({ tools: [{ name: 'lookup' }] })
})

describe('[COMP:api/custom-connectors-route] [COMP:api/connector-store] persisted custom MCP lifecycle', () => {
  it('creates, connects, edits, rotates and deletes a bearer connector without exposing its secret', async () => {
    const id = await create({ authType: 'bearer', bearerToken: 'fixture-original-secret' })
    const initial = await saved(id)
    expect(initial?.credentialsType).toBe('bearer')
    expect(JSON.stringify(initial)).not.toContain('fixture-original-secret')
    expect((await blob(id)).credentials?.includes(Buffer.from('fixture-original-secret'))).toBe(false)
    expect(await store.getCredentials(owner, id)).toBeNull() // disconnected is revoked for the legacy reader
    expect((await probe(id).expect(200)).body).toEqual({ ok: true, toolCount: 1, connected: true })
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, { Authorization: 'Bearer fixture-original-secret' })
    expect((await saved(id))?.connected).toBe(true)
    await patch(id, { name: 'Renamed', authType: 'bearer', bearerToken: '' }).expect(200)
    expect(await saved(id)).toMatchObject({ id: initial?.id, name: 'Renamed', connected: true })
    expect((await store.list(owner))).toHaveLength(1)
    expect(await store.getAuthCredentials(owner, id)).toEqual({ type: 'bearer', token: 'fixture-original-secret' })
    const rotated = await patch(id, { authType: 'bearer', bearerToken: 'fixture-rotated-secret' }).expect(200)
    expect(JSON.stringify(rotated.body)).not.toContain('fixture-rotated-secret')
    await probe(id).expect(200)
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, { Authorization: 'Bearer fixture-rotated-secret' })
    await app().delete(`/api/connectors/custom/${id}`).expect(204)
    expect(await saved(id)).toBeUndefined()
    expect(await store.getCredentials(owner, id)).toBeNull()
    expect(await store.getAuthCredentials(owner, id)).toBeNull()
    expect(await store.getConfig(owner, id)).toEqual({})
    expect(await store.setConnected(owner, id, true)).toBeNull()
    await app().delete(`/api/connectors/custom/${id}`).expect(404)
  })

  it('preserves custom-header edits, requires a value to rename, and clears both secret and display metadata', async () => {
    const id = await create({ authType: 'custom_header', headerName: 'X-Api-Key', headerValue: 'fixture-header-secret' })
    expect(await store.getConfig(owner, id)).toMatchObject({ authHeaderName: 'X-Api-Key' })
    await patch(id, { authType: 'custom_header', headerName: 'X-Api-Key', headerValue: '' }).expect(200)
    await patch(id, { authType: 'custom_header', headerName: 'X-Other' }).expect(400)
    await probe(id).expect(200)
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, { 'X-Api-Key': 'fixture-header-secret' })
    await patch(id, { authType: 'custom_header', headerName: 'X-Other', headerValue: 'fixture-replacement' }).expect(200)
    await probe(id).expect(200)
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, { 'X-Other': 'fixture-replacement' })
    await patch(id, { authType: 'none' }).expect(200)
    expect(await blob(id)).toMatchObject({ credentials: null, credentials_type: 'none' })
    expect(await store.getConfig(owner, id)).toMatchObject({ authHeaderName: null })
    await probe(id).expect(200)
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, {})
  })

  it('keeps legacy OAuth creation and blank edits, rejects partial/type changes, and rotates to bearer', async () => {
    const id = await create({ oauthClientId: 'fixture-client', oauthClientSecret: 'fixture-oauth-secret' })
    await patch(id, { authType: 'oauth' }).expect(200)
    await patch(id, { authType: 'oauth', oauthClientId: 'half-filled' }).expect(400)
    await patch(id, { authType: 'bearer' }).expect(400)
    expect(await store.getAuthCredentials(owner, id)).toEqual({ type: 'oauth', client_id: 'fixture-client', client_secret: 'fixture-oauth-secret' })
    await probe(id).expect(200)
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, {})
    expect(await store.getCredentials(owner, id)).toEqual({ type: 'oauth', client_id: 'fixture-client', client_secret: 'fixture-oauth-secret' })
    await patch(id, { authType: 'bearer', bearerToken: 'fixture-bearer' }).expect(200)
    await probe(id).expect(200)
    expect(discover).toHaveBeenLastCalledWith(base.url, base.name, { Authorization: 'Bearer fixture-bearer' })
  })

  it('isolates users even when they address the same provider id', async () => {
    const id = await create({ authType: 'bearer', bearerToken: 'fixture-owner-secret' })
    const other = await user()
    expect(await store.list(other)).toEqual([])
    expect(await store.getAuthCredentials(other, id)).toBeNull()
    await app(other).post(`/api/connectors/custom/${id}/test`).expect(404)
    await app(other).delete(`/api/connectors/custom/${id}`).expect(404)
    // Missing-id PATCH intentionally upserts for the caller, never edits another owner.
    await app(other).patch(`/api/connectors/custom/${id}`).send({ ...base, name: 'Other owner', authType: 'none' }).expect(200)
    expect((await saved(id, other))?.name).toBe('Other owner')
    expect((await saved(id))?.name).toBe(base.name)
    expect(await store.getAuthCredentials(owner, id)).toEqual({ type: 'bearer', token: 'fixture-owner-secret' })
    await app(other).delete(`/api/connectors/custom/${id}`).expect(204)
    expect(await saved(id)).toBeDefined()
    expect(discover).not.toHaveBeenCalled()
  })

  it('requires an authenticated identity on every custom endpoint', async () => {
    const anonymous = app('')
    await anonymous.post('/api/connectors/custom').send(base).expect(401)
    await anonymous.patch('/api/connectors/custom/missing').send(base).expect(401)
    await anonymous.post('/api/connectors/custom/missing/test').expect(401)
    await anonymous.delete('/api/connectors/custom/missing').expect(401)
    expect(await store.list(owner)).toEqual([])
    expect(discover).not.toHaveBeenCalled()
  })

  it.each([
    ['missing URL', { url: '' }],
    ['missing name', { name: '' }],
    ['missing bearer', { authType: 'bearer' }],
    ['invalid header name', { authType: 'custom_header', headerName: 'X Bad', headerValue: 'value' }],
    ['header injection', { authType: 'custom_header', headerName: 'X-Key', headerValue: 'value\r\nInjected: yes' }],
    ['oversized secret', { authType: 'bearer', bearerToken: 'x'.repeat(8193) }],
  ])('rejects %s without committing a connector', async (_name, invalid) => {
    await app().post('/api/connectors/custom').send({ ...base, ...invalid }).expect(400)
    expect(await store.list(owner)).toEqual([])
  })

  it('protects built-in credentials from custom edits and probes, and rejects missing probes', async () => {
    await store.upsert(owner, { connectorId: 'gmail', name: 'Mail', connected: true, credentials: { client_id: 'fixture-client', client_secret: 'fixture-refresh' } })
    await patch('gmail', { authType: 'none' }).expect(400)
    await probe('gmail').expect(400)
    await probe('missing').expect(404)
    expect(await store.getCredentials(owner, 'gmail')).toEqual({ client_id: 'fixture-client', client_secret: 'fixture-refresh' })
    expect(discover).not.toHaveBeenCalled()
  })

  it.each([
    ['generic', new Error('Upstream private response: fixture-upstream-secret'), 'Could not reach the MCP server'],
    ['HTTP', Object.assign(new Error('fixture-upstream-secret'), { code: 401 }), 'Server returned HTTP 401'],
  ])('persists disconnection and sanitizes a %s probe failure', async (_name, error, message) => {
    const id = await create()
    await probe(id).expect(200)
    discover.mockRejectedValueOnce(error)
    expect((await probe(id).expect(200)).body).toEqual({ ok: false, connected: false, error: message })
    expect((await saved(id))?.connected).toBe(false)
  })

  it('fails closed without an encryption key and commits no credential row', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await app(owner, null).post('/api/connectors/custom').send({ ...base, authType: 'bearer', bearerToken: 'fixture-secret' }).expect(500)
      expect(response.text).not.toContain('fixture-secret')
      expect(await store.list(owner)).toEqual([])
    } finally { log.mockRestore() }
  })

  it('normalizes old untyped encrypted OAuth blobs and updates only the oldest legacy instance', async () => {
    const id = await create()
    const original = await saved(id)
    await query('UPDATE connector_instance SET credentials=$1, credentials_type=\'oauth\', created_at=now()-interval \'1 day\' WHERE id=$2',
      [encryptCredentials({ client_id: 'fixture-legacy', client_secret: 'fixture-legacy-secret' }, key), original?.id])
    await query(`INSERT INTO connector_instance(scope,user_id,provider,label,custom,created_by)
      VALUES('user',$1,$2,'Second instance',true,$1)`, [owner, id])
    expect(await store.getAuthCredentials(owner, id)).toEqual({ type: 'oauth', client_id: 'fixture-legacy', client_secret: 'fixture-legacy-secret' })
    await patch(id, { name: 'First renamed' }).expect(200)
    expect((await store.list(owner)).map(row => row.name).sort()).toEqual(['First renamed', 'Second instance'])
    expect(await store.getAuthCredentials(owner, id)).toMatchObject({ client_id: 'fixture-legacy' })
  })
})
