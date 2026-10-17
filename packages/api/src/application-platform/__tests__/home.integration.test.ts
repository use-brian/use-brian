import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { parseManifest } from '@use-brian/brian-app'
import { getPool, getAppPool, queryWithRLS } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { getHomeApp, consumeHomeAppBudget } from '../../db/home-apps-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { homeAppRoutes } from '../../routes/home-apps.js'
import { brainMcpRoutes } from '../../brain-mcp/server.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { mintBridgeToken, parseBridgeToken } from '../../home-apps/tokens.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { authenticateApplicationHome, captureApplicationHomeBinding } from '../home-auth.js'
import { buildHomeApplicationMcpProfile } from '../mcp.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-auth] existing Home bridge application binding', () => {
  const pool = getPool(), ownerId = randomUUID(), viewerId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  const appId = randomUUID(), homeId = randomUUID(), grantId = randomUUID(), secret = 'fictional-home-application-signing-secret'
  const store = createDbDocEntityStore({ actorUserId: ownerId }), service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
  let typeId: string, recordId: string, otherId: string, nativeToken: string
  const parsed = parseManifest({ manifestVersion: 1, name: 'Example request viewer', entry: 'index.html', scopes: { data: 'none', application: {
    moduleKey: 'records', resources: [{ typeKey: 'request', actions: ['read', 'query', 'history', 'patch', 'command:record_patch'], readFields: ['title'], writeFields: ['title'] }],
  } } })
  if (!parsed.ok) throw new Error('Invalid fixture manifest')
  const manifest = parsed.manifest
  const http = express(); http.use(express.json())
  http.use('/api/applications', applicationPlatformRoutes({ service, home: { signingSecret: secret, consumeBudget: consumeHomeAppBudget } }))
  http.use('/api/home-apps', homeAppRoutes({ requireAuth: requireAuth(secret), filesApi: {} as never, signingSecret: secret,
    apiOrigin: 'https://api.example', appOrigin: 'https://host.example', applicationBinding: captureApplicationHomeBinding }))
  http.use('/api/brain/mcp', brainMcpRoutes({ brainKeyStore: {} as never, memoryTools: {} as never, taskTools: {} as never,
    crmTools: {} as never, retrievalTools: {} as never, homeApps: { secret, getApp: getHomeApp, consumeBudget: consumeHomeAppBudget,
      applicationProfile: req => buildHomeApplicationMcpProfile(req, secret, service) } }))
  beforeAll(async () => {
    for (const id of [ownerId, viewerId]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)", [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Home application fixture',$2)", [workspaceId, ownerId])
    for (const [id, role] of [[ownerId, 'owner'], [viewerId, 'member']]) await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspaceId, id, role])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Example Home assistant',$2,$3,'primary','confidential')", [assistantId, ownerId, workspaceId])
    const schema = await store.createEntityType({ workspaceId, name: 'Home requests', createdBy: ownerId, properties: [
      { name: 'title', config: { kind: 'text' }, required: true }, { name: 'cost', config: { kind: 'number', format: 'decimal' } },
    ] }); typeId = schema.id
    for (const [index, title] of ['Visible Home request', 'Another viewer request'].entries()) {
      const row = await store.createEntity({ workspaceId, entityTypeId: typeId, data: { title: { kind: 'text', value: title }, cost: { kind: 'number', value: 25 } },
        sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId })
      if (index === 0) recordId = row.id; else otherId = row.id
    }
    await pool.query(`INSERT INTO workspace_home_apps(id,workspace_id,kind,name,manifest,granted_scopes,granted_by,status,daily_call_limit)
      VALUES($1,$2,'assistant','Example request viewer',$3,$4,$5,'active',100)`, [homeId, workspaceId, manifest, manifest.scopes, ownerId])
    await pool.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,home_app_id,executing_assistant_id,created_by_user_id)
      VALUES($1,$2,'records','Example Home application','home_app',$3,$4,$5)`, [appId, workspaceId, homeId, assistantId, ownerId])
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,
      actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
      VALUES($1,$2,$3,'member',$4,$5,$6,'request',ARRAY['read','query','history','patch','command:record_patch'],ARRAY['title','cost'],ARRAY['title','cost'],$7,'{}','{}','confidential',now()-interval '1 hour')`,
    [grantId, appId, workspaceId, viewerId, ownerId, { kind: 'generic', entityTypeId: typeId }, { kind: 'ids', ids: [recordId] }])
    const session = await authSessionStore.create(viewerId, { deviceLabel: 'Fixture Home browser', userAgent: 'Fixture Home browser', ipAddress: '127.0.0.1' })
    nativeToken = createTokens(viewerId, secret, session!).accessToken
  })
  afterAll(async () => {
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]); await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId, viewerId]])
    await getAppPool().end(); await pool.end()
  })
  async function binding() {
    const row = (await pool.query(`INSERT INTO application_home_bindings(app_id,workspace_id,home_app_id,principal_user_id,maximum_grants,maximum_hash,home_state_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,'','',statement_timestamp()+interval '10 minutes') RETURNING id,maximum_grants`,
    [appId, workspaceId, homeId, viewerId, JSON.stringify([{ grants: [{ id: grantId }] }])])).rows[0]
    return { id: row.id as string, maximum: row.maximum_grants, token: mintBridgeToken({ appId: homeId, workspaceId, userId: viewerId,
      scope: 'none', applicationBindingId: row.id, maxClearance: null, secret }) }
  }
  function decode(response: { text: string; body: unknown }) {
    const data = response.text.split('\n').find(line => line.startsWith('data: '))
    return data ? JSON.parse(data.slice(6)) : response.body
  }
  function mcp(token: string, method: string, params?: unknown) {
    return request(http).post('/api/brain/mcp').set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2025-11-25').send({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })
  }
  it('keeps native session capture closed before qualification and refuses older bridge/bundle/session audiences', async () => {
    const session = await request(http).get(`/api/home-apps/${homeId}/session`).set('Authorization', `Bearer ${nativeToken}`)
    expect(session.status).toBe(200); expect(session.body.applicationAvailable).toBe(false)
    const bridge = parseBridgeToken({ token: session.body.bridgeToken, secret })
    expect(bridge.ok && bridge.payload.scope).toBe('none'); expect(bridge.ok && bridge.payload.applicationBindingId).toBeUndefined()
    expect(await captureApplicationHomeBinding(viewerId, homeId)).toBeNull()
    expect((await request(http).get(`/api/applications/${appId}/catalog`).set('Authorization', `Bearer ${nativeToken}`)).status).toBe(401)
    expect((await mcp(session.body.bridgeToken, 'tools/list')).status).toBe(401)
    await expect(queryWithRLS(viewerId, `INSERT INTO application_home_bindings(app_id,workspace_id,home_app_id,principal_user_id,maximum_grants,maximum_hash,home_state_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,'','',now()+interval '5 minutes')`, [appId, workspaceId, homeId, viewerId, JSON.stringify([{ grants: [{ id: grantId }] }])])).rejects.toMatchObject({ code: '42501' })
  })
  it('intersects immutable Home field requirements with the real viewer and reuses the existing MCP budget and canonical command', async () => {
    const first = await binding()
    expect(first.maximum[0].grants[0].readFields).toEqual(['title']); expect(first.maximum[0].grants[0].writeFields).toEqual(['title'])
    const proof = await authenticateApplicationHome(first.token, appId, secret)
    expect(proof?.userId).toBe(viewerId)
    await expect(resolveApplicationExecutionContext({ home: { ...proof! } })).rejects.toMatchObject({ code: 'grant_revoked' })
    const list = await mcp(first.token, 'tools/list')
    expect(list.status).toBe(200); expect(decode(list).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['applicationCatalog', 'applicationQuery', 'applicationCommand'])
    const read = await mcp(first.token, 'tools/call', { name: 'applicationQuery', arguments: { queryKey: 'get', input: { type: 'request', id: recordId } } })
    expect(JSON.parse(decode(read).result.content[0].text).values).toEqual({ title: { kind: 'text', value: 'Visible Home request' } })
    const other = await mcp(first.token, 'tools/call', { name: 'applicationQuery', arguments: { queryKey: 'get', input: { type: 'request', id: otherId } } })
    expect(decode(other).result.isError).toBe(true)
    const args = { name: 'applicationCommand', arguments: { commandKey: 'record_patch', command: { idempotencyKey: randomUUID(), input: {
      operation: 'patch', type: 'request', id: recordId, expectedVersion: '1', data: { title: { kind: 'text', value: 'Home committed once' } },
    } } } }
    const committed = await mcp(first.token, 'tools/call', args), next = await binding(), replay = await mcp(next.token, 'tools/call', args)
    expect(decode(committed).result.isError).toBeUndefined()
    expect(JSON.parse(decode(replay).result.content[0].text)).toEqual(JSON.parse(decode(committed).result.content[0].text))
    expect((await store.getEntity(workspaceId, recordId))?.recordVersion).toBe('2')
    expect((await store.getEntity(workspaceId, recordId))?.data.cost).toEqual({ kind: 'number', value: 25 })
    expect((await pool.query('SELECT daily_used FROM workspace_home_apps WHERE id=$1', [homeId])).rows[0].daily_used).toBe(5)
  })
  it('invalidates running and renewed Home proofs after consent/state contraction and enforces the shared daily budget', async () => {
    const active = await binding(), proof = (await authenticateApplicationHome(active.token, appId, secret))!
    const execution = await resolveApplicationExecutionContext({ home: proof })
    await pool.query("UPDATE workspace_home_apps SET daily_call_limit=1,daily_used=0,daily_window_date=CURRENT_DATE WHERE id=$1", [homeId])
    expect((await mcp(active.token, 'tools/list')).status).toBe(200)
    expect((await mcp(active.token, 'tools/list')).status).toBe(429)
    await pool.query("UPDATE workspace_home_apps SET status='disabled',updated_at=clock_timestamp() WHERE id=$1", [homeId])
    await expect(service.query(execution, 'records', 'get', { type: 'request', id: recordId })).rejects.toThrow('Access changed')
    expect(await authenticateApplicationHome(active.token, appId, secret)).toBeNull()
    expect((await mcp(active.token, 'tools/list')).status).toBe(401)
    await pool.query("UPDATE workspace_home_apps SET status='active',updated_at=clock_timestamp() WHERE id=$1", [homeId])
    expect(await authenticateApplicationHome(active.token, appId, secret)).toBeNull()
  })
  it('intersects a narrower signed clearance and current member floor without exposing hidden fields or rewriting a binding', async () => {
    const active = await binding()
    const publicToken = mintBridgeToken({ appId: homeId, workspaceId, userId: viewerId, scope: 'none', applicationBindingId: active.id, maxClearance: 'public', secret })
    const narrow = (await authenticateApplicationHome(publicToken, appId, secret))!
    const narrowExecution = await resolveApplicationExecutionContext({ home: narrow })
    expect(narrowExecution.security.access.clearance).toBe('public')
    await expect(service.query(narrowExecution, 'records', 'get', { type: 'request', id: recordId })).rejects.toMatchObject({ code: 'access_unavailable' })
    await expect(pool.query("UPDATE application_home_bindings SET maximum_grants='[]' WHERE id=$1", [active.id])).rejects.toMatchObject({ code: '22023' })
    const full = (await authenticateApplicationHome(active.token, appId, secret))!, execution = await resolveApplicationExecutionContext({ home: full })
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, viewerId])
    try {
      await expect(service.query(execution, 'records', 'get', { type: 'request', id: recordId })).rejects.toThrow('Access changed')
      const fresh = await resolveApplicationExecutionContext({ home: (await authenticateApplicationHome(active.token, appId, secret))! })
      await expect(service.query(fresh, 'records', 'get', { type: 'request', id: recordId })).rejects.toMatchObject({ code: 'access_unavailable' })
    } finally { await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, viewerId]) }
  })
})
