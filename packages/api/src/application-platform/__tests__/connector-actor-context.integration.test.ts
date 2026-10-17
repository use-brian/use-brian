import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createExecutionContext } from '@use-brian/core'
import { createConnectorActorVerifier, createBoundedConnectorReplayConsumer, type ConnectorActorClaims } from '@use-brian/brian-app/connector'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createConnectorActorKeyStore } from '../connector-actor-keys.js'
import { connectorActorMetadataRoutes } from '../connector-actor-metadata.js'
import { mintConnectorActorAssertion } from '../connector-actor-context.js'
import { createConnectorActorFetch } from '../connector-actor-transport.js'
import { callRemoteMcpTool, discoverMcpServer } from '../../mcp/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/connector-actor-context] real encrypted keys and MCP dispatch', () => {
  const pool = getPool(), encryptionKey = randomBytes(32), keys = createConnectorActorKeyStore(encryptionKey)
  const workspaceId = randomUUID(), connectorInstanceId = randomUUID(), assistantId = randomUUID(), userId = randomUUID()
  const issuer = () => `https://${randomUUID()}.installation.example`
  afterAll(async () => { await getAppPool().end(); await pool.end() })
  function execution() {
    return createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId } }, ownership: { kind: 'workspace', workspaceId },
      access: { workspaceId, userId, assistantId, assistantKind: 'primary', clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [] },
      writeDefaults: { compartments: [], projectIds: [] }, authority: { assertCurrent: async () => {}, execute: async operation => operation() },
      lifecycle: { sessionId: randomUUID(), channelId: 'fixture', channelType: 'web', abortSignal: new AbortController().signal } })
  }
  function ports() { return { ...keys, admit: async () => ({ bindingRevision: '1', actor: { kind: 'human' as const, userId, authenticationKind: 'native_session' as const } }) } }
  function verify(configuredIssuer: string, audience: string) {
    return createConnectorActorVerifier({ issuer: configuredIssuer, audience, workspaceId, connectorInstanceId, consumeReplay: createBoundedConnectorReplayConsumer(),
      trustedKey: async kid => {
        const jwks = await keys.publicJwks(configuredIssuer), jwk = jwks.keys.find(item => item.kid === kid)
        return jwk ? { key: createPublicKey({ key: jwk, format: 'jwk' }) } : null
      } })
  }
  it('persists only encrypted private material and denies direct app-role key/audit reads', async () => {
    const configuredIssuer = issuer(), created = await keys.rotateSystem(configuredIssuer)
    const row = (await pool.query('SELECT encrypted_private_key,public_jwk FROM connector_actor_signing_keys WHERE kid=$1', [created.kid])).rows[0]
    expect(row.encrypted_private_key.toString()).not.toContain('PRIVATE KEY'); expect(row.public_jwk).not.toHaveProperty('d')
    expect(await keys.loadActiveKey(configuredIssuer)).toMatchObject({ kid: created.kid })
    expect(await createConnectorActorKeyStore(Buffer.from(encryptionKey)).loadActiveKey(configuredIssuer)).toMatchObject({ kid: created.kid })
    expect(await createConnectorActorKeyStore(randomBytes(32)).loadActiveKey(configuredIssuer)).toBeNull()
    // The fixture grants table privileges after migration, so RLS itself must still withhold these rows.
    expect((await queryWithRLS(userId, 'SELECT kid FROM connector_actor_signing_keys')).rows).toEqual([])
    expect((await queryWithRLS(userId, 'SELECT kid FROM connector_actor_key_events')).rows).toEqual([])
    const projected = await queryWithRLS(userId, 'SELECT connector_actor_public_jwks($1) AS jwks', [configuredIssuer])
    expect(projected.rows[0].jwks.keys).toEqual([row.public_jwk])
    expect(JSON.stringify(projected.rows[0])).not.toMatch(/PRIVATE KEY|encrypted_private_key|pkcs8/)
    expect(await keys.publicJwks(issuer())).toEqual({ keys: [] })
  })
  it('serves only configured-issuer public JWKS without credentials and keeps errors content-free', async () => {
    const configuredIssuer = issuer(), created = await keys.rotateSystem(configuredIssuer), http = express()
    http.use(connectorActorMetadataRoutes(configuredIssuer, value => keys.publicJwks(value)))
    const response = await request(http).get('/.well-known/usebrian-connector-jwks.json')
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.keys).toEqual([expect.objectContaining({ kid: created.kid, crv: 'Ed25519' })])
    expect(Object.keys(response.body.keys[0]).sort()).toEqual(['alg','crv','kid','kty','use','x'])
    const failed = express(); failed.use(connectorActorMetadataRoutes(configuredIssuer, async () => { throw new Error('PRIVATE KEY secret') }))
    const unavailable = await request(failed).get('/.well-known/usebrian-connector-jwks.json')
    expect(unavailable.status).toBe(503); expect(unavailable.body).toEqual({ error: 'connector_identity_unavailable' })
  })
  it('serializes rotations, retains retiring public keys for the last window and emergency-revokes them', async () => {
    const configuredIssuer = issuer(), initial = await keys.rotateSystem(configuredIssuer), binding = { issuer: configuredIssuer, audience: 'https://source.example/mcp', workspaceId, connectorInstanceId }
    const bytes = { method: 'POST', target: '/mcp', body: Buffer.from('{}') }
    const signed = await mintConnectorActorAssertion(execution(), binding, bytes, ports())
    const rotated = await Promise.all([keys.rotateSystem(configuredIssuer), keys.rotateSystem(configuredIssuer)])
    const rows = (await pool.query("SELECT kid,status,extract(epoch FROM retain_until-retired_at)::integer AS seconds FROM connector_actor_signing_keys WHERE issuer=$1", [configuredIssuer])).rows
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1)
    expect(rows.filter(row => row.status === 'retiring')).toHaveLength(2)
    expect(rows.filter(row => row.status === 'retiring').every(row => row.seconds >= 65)).toBe(true)
    expect((await keys.publicJwks(configuredIssuer)).keys.map(row => row.kid).sort()).toEqual([initial.kid,...rotated.map(row => row.kid)].sort())
    expect(await keys.keyCurrent(initial.kid)).toBe(false)
    expect(await verify(configuredIssuer, binding.audience)(signed, bytes)).toMatchObject({ actor: { userId } })
    expect(await keys.revokeSystem(configuredIssuer, initial.kid)).toBe(true)
    expect(await keys.revokeSystem(configuredIssuer, initial.kid)).toBe(false)
    await expect(verify(configuredIssuer, binding.audience)(signed, bytes)).rejects.toMatchObject({ code: 'assertion_invalid' })
    await expect(pool.query("UPDATE connector_actor_signing_keys SET status='active',retired_at=NULL,retain_until=NULL,revoked_at=NULL WHERE kid=$1", [initial.kid])).rejects.toMatchObject({ code: '22023' })
    await expect(pool.query('UPDATE connector_actor_signing_keys SET issuer=$2 WHERE kid=$1', [rotated[0].kid,issuer()])).rejects.toMatchObject({ code: '22023' })
    const audit = (await pool.query('SELECT operation FROM connector_actor_key_events WHERE kid=$1 ORDER BY created_at,id', [initial.kid])).rows
    expect(audit.map(row => row.operation)).toEqual(['created','retiring','revoked'])
    await expect(pool.query("UPDATE connector_actor_key_events SET operation='created' WHERE kid=$1", [initial.kid])).rejects.toMatchObject({ code: '22023' })
  })
  it('refuses malformed public keys even through a privileged fixture insert', async () => {
    const configuredIssuer = issuer(), created = await keys.rotateSystem(configuredIssuer)
    const row = (await pool.query('SELECT encrypted_private_key,public_jwk FROM connector_actor_signing_keys WHERE kid=$1', [created.kid])).rows[0]
    const kid = randomUUID(), { x: _removed, ...incomplete } = row.public_jwk
    await expect(pool.query('INSERT INTO connector_actor_signing_keys(kid,issuer,encrypted_private_key,public_jwk) VALUES($1,$2,$3,$4)',
      [kid,issuer(),row.encrypted_private_key,{ ...incomplete,kid }])).rejects.toMatchObject({ code: '23514' })
  })
  it('verifies exact MCP initialize/discovery/call envelopes at a real local HTTP source', async () => {
    const configuredIssuer = issuer(), audience = 'https://source.example/mcp', verified: ConnectorActorClaims[] = []
    await keys.rotateSystem(configuredIssuer)
    const verifyActor = verify(configuredIssuer, audience), source = express()
    source.use(express.raw({ type: 'application/json', limit: '1mb' }))
    source.all('/mcp', async (req, res) => {
      if (req.headers.authorization !== 'Bearer fictional-source-transport') { res.sendStatus(401); return }
      try {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        const actor = await verifyActor(String(req.headers['x-usebrian-actor-assertion'] ?? ''), { method: req.method, target: req.originalUrl, body: bytes })
        // This suite certifies wire identity only; the independent business-ACL fixture is separate P3/P5 work.
        verified.push(actor)
        expect(req.headers['x-usebrian-user-id']).toBe(userId); expect(req.headers['x-usebrian-assistant-id']).toBe(assistantId)
        const server = new McpServer({ name: 'Actor wire fixture', version: '1' })
        server.registerTool('currentActor', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ actor: actor.actor, assistant: actor.executingAssistantId }) }] }))
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.once('close', () => { void transport.close(); void server.close() })
        await server.connect(transport)
        await transport.handleRequest(req, res, bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined)
      } catch { if (!res.headersSent) res.status(403).json({ error: 'actor_denied' }) }
    })
    const listener = source.listen(0, '127.0.0.1'); await once(listener, 'listening')
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp?tenant=one%2Ftwo`
    const dispatch = createConnectorActorFetch(execution(), url, { issuer: configuredIssuer, audience, workspaceId, connectorInstanceId }, ports())
    try {
      expect((await discoverMcpServer(url, 'Actor fixture', { Authorization: 'Bearer fictional-source-transport' }, dispatch)).tools.map(tool => tool.name)).toEqual(['currentActor'])
      const result = JSON.parse(await callRemoteMcpTool(url, 'currentActor', {}, { Authorization: 'Bearer fictional-source-transport', 'X-UseBrian-Actor-Assertion': 'forged' }, dispatch) as string)
      expect(result).toEqual({ actor: { kind: 'human', userId, authenticationKind: 'native_session' }, assistant: assistantId })
      expect(verified.length).toBeGreaterThanOrEqual(6)
      expect(new Set(verified.map(actor => actor.jti)).size).toBe(verified.length)
      expect(verified.every(actor => actor.request.target === '/mcp?tenant=one%2Ftwo')).toBe(true)
      await keys.revokeSystem(configuredIssuer, (await keys.loadActiveKey(configuredIssuer))!.kid)
      const before = verified.length
      await expect(discoverMcpServer(url, 'Actor fixture', { Authorization: 'Bearer fictional-source-transport' }, dispatch)).rejects.toThrow()
      expect(verified).toHaveLength(before)
    } finally { await new Promise<void>(resolve => listener.close(() => resolve())) }
  })
})
