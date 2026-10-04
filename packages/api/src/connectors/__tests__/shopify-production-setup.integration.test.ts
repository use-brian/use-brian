import { randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import pg, { type PoolClient } from 'pg'
import { refreshShopifyInstanceCredentials } from '../shopify-rotation.js'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
const provider = vi.hoisted(() => ({ graphql: vi.fn(), exchange: vi.fn(), refresh: vi.fn(), hmac: vi.fn() }))
vi.mock('../../shopify/client.js', async original => ({ ...await original<typeof import('../../shopify/client.js')>(),
  shopifyGraphql: provider.graphql, exchangeShopifyAuthorizationCode: provider.exchange, refreshShopifyTokens: provider.refresh, verifyShopifyOAuthQueryHmac: provider.hmac,
}))
import { getPool, getAppPool } from '../../db/client.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createDbConnectorStore } from '../../db/connector-store.js'
import { createConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { connectorRoutes } from '../../routes/connectors.js'
import { connectorSetupProviders } from '../setup-providers.js'
import { createTransactionalConnectorSetup } from '../transactional-setup.js'
import { connectorReconnectProjection } from '../reconnect-projection.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), key = randomBytes(32)
afterAll(async () => { await getAppPool().end(); await pool.end() })
beforeEach(() => {
  vi.clearAllMocks()
  provider.hmac.mockReturnValue(true)
  provider.refresh.mockResolvedValue({ shopDomain: 'fixture.myshopify.com', accessToken: 'rotated-secret', refreshToken: 'rotated-refresh', expiresAt: '2035-01-01' })
  provider.exchange.mockResolvedValue({ accessToken: 'provider-secret', refreshToken: 'refresh-secret', expiresAt: '2030-01-01' })
  provider.graphql.mockResolvedValue({ shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'fixture.myshopify.com' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } })
})
async function fixture(afterSetupQuery?: (sql: string, client: PoolClient) => Promise<void>) {
  const actor = randomUUID(), workspaceId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [actor])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Shopify',$2,false)", [workspaceId, actor])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, actor])
  const team = await createDbWorkspaceGroupStore().createTeam(actor, workspaceId, { name: 'Shared', key: 'shared' })
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2 WHERE workspace_id=$1", [workspaceId, team.id])
  const expectedPolicyRevision = String((await pool.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [workspaceId])).rows[0].revision)
  const session = (await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Fixture') RETURNING id", [actor])).rows[0].id
  const setupPool = new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await pool.connect()
      return new Proxy(client, { get(c, p) {
        if (p === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(c.query, c, args)
          await afterSetupQuery?.(String(args[0]), c)
          return result
        }
        const value = Reflect.get(c, p)
        return typeof value === 'function' ? value.bind(c) : value
      } })
    }
    return Reflect.get(target, property)
  } })
  const service = createTransactionalConnectorSetup({ pool: setupPool, encryptionKey: key, adapters: connectorSetupProviders() })
  // Exercise the production projection behind actual HTTP with the application
  // database role, not just superuser fixtures or a mocked metadata reader.
  service.reconnectProjection = (actor, session, workspace, instance) => connectorReconnectProjection({
    pool: getAppPool(), supportsProvider: provider => connectorSetupProviders().has(provider),
  }, actor, session, workspace, instance)
  const instances = createConnectorInstanceStore(key)
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    req.userId = String(req.headers['x-actor'] ?? actor)
    if (req.headers['x-session'] !== 'none') req.authSessionId = String(req.headers['x-session'] ?? session)
    next()
  })
  app.use('/api/connectors', connectorRoutes({ setupService: service, shopifySetupRedirectUri: 'https://app.example/api/auth/callback/shopify',
    connectorStore: createDbConnectorStore(key), connectorInstanceStore: instances,
    shopifyVerifyToken: async () => ({ myshopifyDomain: 'fixture.myshopify.com' }),
  }))
  const selection = { workspaceId, expectedPolicyRevision, operation: 'create', ownership: 'workspace', sensitivity: 'internal' }
  const start = async (patch = {}) => request(app).post('/api/connectors/shopify/app-credentials').send({
    setup: { ...selection, ...patch }, shopDomain: 'fixture.myshopify.com', clientId: 'merchant-app', clientSecret: 'merchant-secret',
  })
  const callback = (s: { id: string; state: string }, patch = {}) => request(app).post('/api/connectors/shopify/oauth-callback').send({
    setupId: s.id, workspaceId, params: { shop: 'fixture.myshopify.com', code: 'provider-code', state: s.state, hmac: 'signed' }, ...patch,
  })
  const approve = async (id: string) => {
    const review = await request(app).post(`/api/connectors/setups/${id}/review`).send({})
    expect(review.status).toBe(200); expect(JSON.stringify(review.body)).not.toContain('secret')
    const digest = review.body.digest
    expect((await request(app).post(`/api/connectors/setups/${id}/consent`).send({ digest })).body.status).toBe('ready')
    const active = await request(app).post(`/api/connectors/setups/${id}/activate`).send({ digest })
    expect(active.body.status).toBe('active')
    return active.body.result.instanceId as string
  }
  return { app, actor, workspaceId, session, selection, start, callback, approve, instances, team }
}
async function projectionActor(workspaceId: string, role: 'admin' | 'member') {
  const actor = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [actor])
  await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, actor, role])
  const session = (await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Projection') RETURNING id", [actor])).rows[0].id
  return { actor, session }
}
describe('actual Shopify connector HTTP setup paths', () => {
  it('durably fences a lost refresh response before exchange and never reuses the old token after restart', async () => {
    provider.exchange.mockResolvedValueOnce({ accessToken: 'expired-secret', refreshToken: 'expired-refresh', expiresAt: '2020-01-01' })
    const f = await fixture(), start = await f.start()
    await f.callback(start.body); const id = await f.approve(start.body.id)
    const before = (await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials
    provider.refresh.mockImplementationOnce(async () => {
      // Independent connection proves this is COMMITTED before the provider
      // consumes anything, rather than merely an uncommitted local marker.
      expect((await pool.query('SELECT status,encrypted_result FROM connector_rotation_attempts WHERE instance_id=$1', [id])).rows).toEqual([{ status: 'uncertain', encrypted_result: null }])
      throw new Error('provider consumed token but response was lost')
    })
    const firstProcess = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    try { await expect(refreshShopifyInstanceCredentials(firstProcess, key, id)).rejects.toThrow('connector_rotation_uncertain') }
    finally { await firstProcess.end() }
    const restartedProcess = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    try { await expect(refreshShopifyInstanceCredentials(restartedProcess, key, id)).rejects.toThrow('connector_rotation_uncertain') }
    finally { await restartedProcess.end() }
    expect(provider.refresh).toHaveBeenCalledTimes(1)
    expect((await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials).toEqual(before)
    // Recovery is a fresh reviewed OAuth reconnect, not an automatic retry of
    // the uncertain exchange. Keep the fingerprint fence after recovery.
    const reconnect = await f.start({ operation: 'reconnect', instanceId: id })
    expect((await f.callback(reconnect.body)).body.status).toBe('pending_review')
    expect(await f.approve(reconnect.body.id)).toBe(id)
    expect((await pool.query('SELECT status,encrypted_result FROM connector_rotation_attempts WHERE instance_id=$1', [id])).rows).toEqual([{ status: 'reconnect_required', encrypted_result: null }])
    expect(JSON.stringify(await f.instances.refreshShopifyCredentialsSystem!(id))).toContain('refresh-secret')
    expect(provider.refresh).toHaveBeenCalledTimes(1)
  })

  it('persists an encrypted refresh result before a verification 503 and resumes verification, never exchange, with max-one pools', async () => {
    provider.exchange.mockResolvedValueOnce({ accessToken: 'expired-secret', refreshToken: 'expired-refresh', expiresAt: '2020-01-01' })
    const f = await fixture(), start = await f.start()
    await f.callback(start.body); const id = await f.approve(start.body.id)
    const before = (await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials
    provider.graphql.mockRejectedValueOnce(new Error('503 identity service unavailable'))
    await expect(f.instances.refreshShopifyCredentialsSystem!(id)).rejects.toThrow('connector_rotation_failed')
    const attempt = (await pool.query('SELECT status,encrypted_result FROM connector_rotation_attempts WHERE instance_id=$1', [id])).rows[0]
    expect(attempt.status).toBe('pending_verification')
    expect((attempt.encrypted_result as Buffer).includes(Buffer.from('rotated-secret'))).toBe(false)
    expect((await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials).toEqual(before)
    const app = await getAppPool().connect()
    try {
      await app.query('BEGIN'); await app.query("SELECT set_config('app.current_user_id',$1,true)", [f.actor])
      expect((await app.query('SELECT * FROM connector_rotation_attempts WHERE instance_id=$1', [id])).rowCount).toBe(0)
    } finally { await app.query('ROLLBACK'); app.release() }
    const first = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    const second = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    try {
      const [a, b] = await Promise.all([refreshShopifyInstanceCredentials(first, key, id), refreshShopifyInstanceCredentials(second, key, id)])
      expect(a).toEqual(b); expect(JSON.stringify(a)).toContain('rotated-refresh')
    } finally { await first.end(); await second.end() }
    expect(provider.refresh).toHaveBeenCalledTimes(1)
    expect((await pool.query('SELECT status,encrypted_result FROM connector_rotation_attempts WHERE instance_id=$1', [id])).rows).toEqual([{ status: 'published', encrypted_result: null }])
  })

  it.each(['verification', 'publication'] as const)('fails closed when slow %s consumes the refreshed token lifetime', async (phase) => {
    provider.exchange.mockResolvedValueOnce({ accessToken: 'expired-secret', refreshToken: 'expired-refresh', expiresAt: '2020-01-01' })
    const f = await fixture(), start = await f.start()
    await f.callback(start.body); const id = await f.approve(start.body.id)
    const before = (await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    provider.refresh.mockResolvedValueOnce({ shopDomain: 'fixture.myshopify.com', accessToken: 'rotated-secret', refreshToken: 'rotated-refresh', expiresAt: new Date(now + 121000).toISOString() })
    if (phase === 'verification') provider.graphql.mockImplementationOnce(async () => {
      now += 65000
      return { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'fixture.myshopify.com' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } }
    })
    let publishing = false
    const slowPool = new Proxy(pool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await pool.connect()
        return new Proxy(client, { get(c, p) {
          if (p === 'query') return async (...args: unknown[]) => {
            const result = await Reflect.apply(c.query, c, args)
            if (String(args[0]).includes("SET status='published'")) publishing = true
            if (String(args[0]) === 'COMMIT' && publishing && phase === 'publication') { now += 65000; publishing = false }
            return result
          }
          const value = Reflect.get(c, p)
          return typeof value === 'function' ? value.bind(c) : value
        } })
      }
      return Reflect.get(target, property)
    } })
    try {
      await expect(refreshShopifyInstanceCredentials(slowPool, key, id)).rejects.toThrow('connector_rotation_reconnect_required')
      await expect(f.instances.refreshShopifyCredentialsSystem!(id)).rejects.toThrow('connector_rotation_reconnect_required')
      expect(provider.refresh).toHaveBeenCalledTimes(1)
      const attempts = (await pool.query('SELECT status,encrypted_result FROM connector_rotation_attempts WHERE instance_id=$1', [id])).rows
      expect(attempts.length).toBe(phase === 'verification' ? 1 : 2)
      for (const attempt of attempts) expect(attempt).toEqual({ status: 'reconnect_required', encrypted_result: null })
      if (phase === 'verification') expect((await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials).toEqual(before)
    } finally { clock.mockRestore() }
  })

  it('rolls back all publication when the original session expires after the final publication write', async () => {
    for (const operation of ['create', 'reconnect'] as const) {
      let armed = false, reached = false, session = ''
      const f = await fixture(async (sql, client) => {
        if (!armed || !sql.startsWith('DELETE FROM connector_setup_staged_credentials')) return
        armed = false; reached = true
        // Deterministic database-clock gate AFTER credentials, identity, active
        // receipt and staged cleanup have all been written in this transaction.
        await client.query("SELECT pg_sleep_until(expires_at+interval '20 milliseconds') FROM auth_sessions WHERE id=$1", [session])
      })
      session = f.session
      let start = await f.start(), instanceId: string | undefined, before: Buffer | undefined
      await f.callback(start.body)
      if (operation === 'reconnect') {
        instanceId = await f.approve(start.body.id)
        before = (await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [instanceId])).rows[0].credentials
        start = await f.start({ operation: 'reconnect', instanceId }); await f.callback(start.body)
      }
      const review = await request(f.app).post(`/api/connectors/setups/${start.body.id}/review`).send({})
      await request(f.app).post(`/api/connectors/setups/${start.body.id}/consent`).send({ digest: review.body.digest })
      await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [session])
      armed = true
      const response = await request(f.app).post(`/api/connectors/setups/${start.body.id}/activate`).send({ digest: review.body.digest })
      expect(reached).toBe(true)
      expect(response.body.error).toBe('connector_setup_authority_expired')
      expect((await pool.query('SELECT status,result_ids FROM connector_pending_setups WHERE id=$1', [start.body.id])).rows[0]).toEqual({ status: 'ready', result_ids: null })
      expect((await pool.query('SELECT 1 FROM connector_setup_staged_credentials WHERE setup_id=$1', [start.body.id])).rowCount).toBe(1)
      if (instanceId) expect((await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [instanceId])).rows[0].credentials).toEqual(before)
      else {
        expect(await f.instances.listByWorkspaceSystem(f.workspaceId)).toEqual([])
        expect((await pool.query('SELECT 1 FROM connector_setup_identity WHERE setup_id=$1', [start.body.id])).rowCount).toBe(0)
      }
    }
  }, 15000)

  it('rotates through the real store once under concurrency without a ready setup or generic credential bypass', async () => {
    provider.exchange.mockResolvedValueOnce({ accessToken: 'expired-secret', refreshToken: 'expired-refresh', expiresAt: '2020-01-01' })
    const f = await fixture(), start = await f.start()
    await f.callback(start.body); const id = await f.approve(start.body.id)
    let entered!: () => void, release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    provider.refresh.mockImplementationOnce(async () => { entered(); await gate; return { shopDomain: 'fixture.myshopify.com', accessToken: 'rotated-secret', refreshToken: 'rotated-refresh', expiresAt: '2035-01-01' } })
    const first = f.instances.refreshShopifyCredentialsSystem!(id)
    await inside
    const second = f.instances.refreshShopifyCredentialsSystem!(id)
    try { await pool.query("UPDATE connector_instance SET health_status='degraded' WHERE id=$1", [id]) }
    finally { release() }
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1]); expect(provider.refresh).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(results[0])).toContain('rotated-refresh')
    expect((await f.instances.getSystem(id))!.compartments).toEqual([f.team.compartmentKey])
    expect((await pool.query('SELECT * FROM connector_setup_rotation_receipts WHERE instance_id=$1', [id])).rowCount).toBe(0)
    await expect(f.instances.updateCredentialsSystem(id, { type: 'oauth', client_id: 'shopify_oauth', client_secret: 'forged' })).rejects.toThrow('connector_setup_required')
  })

  it('does not rotate to a provider-expanded permission tuple', async () => {
    provider.exchange.mockResolvedValueOnce({ accessToken: 'expired-secret', refreshToken: 'expired-refresh', expiresAt: '2020-01-01' })
    const f = await fixture(), start = await f.start()
    await f.callback(start.body); const id = await f.approve(start.body.id)
    const before = (await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials
    provider.graphql.mockResolvedValueOnce({ shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'fixture.myshopify.com' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }] } })
    await expect(f.instances.refreshShopifyCredentialsSystem!(id)).rejects.toThrow('connector_rotation_identity_changed')
    expect((await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials).toEqual(before)
    expect(provider.refresh).toHaveBeenCalledTimes(1)
  })

  it('revalidates full review authority before decrypting account evidence and returns server lifetime', async () => {
    for (const mutation of ['role', 'session', 'version', 'policy']) {
      const f = await fixture(), initial = await f.start()
      await f.callback(initial.body)
      let setupId = initial.body.id
      let instanceId: string | undefined
      if (mutation === 'version') {
        instanceId = await f.approve(initial.body.id)
        const reconnect = await f.start({ operation: 'reconnect', instanceId })
        await f.callback(reconnect.body); setupId = reconnect.body.id
      }
      await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '10 seconds' WHERE id=$1", [f.session])
      const review = await request(f.app).post(`/api/connectors/setups/${setupId}/review`).send({})
      expect(review.body).toMatchObject({ viewerUserId: f.actor, workspaceId: f.workspaceId })
      expect(review.body.validForMs).toBeGreaterThan(0); expect(review.body.validForMs).toBeLessThanOrEqual(10000)
      if (mutation === 'role') await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actor])
      if (mutation === 'session') await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [f.session])
      if (mutation === 'version') await pool.query("UPDATE connector_instance SET label='Changed' WHERE id=$1", [instanceId])
      if (mutation === 'policy') await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.workspaceId])
      const denied = await request(f.app).post(`/api/connectors/setups/${setupId}/review`).send({})
      expect(denied.body.review).toBeNull(); expect(denied.body.validForMs).toBe(0)
      expect(JSON.stringify(denied.body)).not.toContain('fixture.myshopify.com')
      expect(JSON.stringify(denied.body)).not.toContain('gid://shopify')
    }
  })
  it('projects exact saved department/Project binding to current workspace admins, never an ordinary member', async () => {
    const f = await fixture(), project = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)", [project, f.workspaceId, f.actor])
    const revision = String((await pool.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [f.workspaceId])).rows[0].revision)
    const start = await f.start({ expectedPolicyRevision: revision, destination: { kind: 'department', departmentId: f.team.id, projectId: project } })
    expect(start.status).toBe(200)
    await f.callback(start.body)
    const id = await f.approve(start.body.id)
    const admin = await projectionActor(f.workspaceId, 'admin'), member = await projectionActor(f.workspaceId, 'member')
    const get = (who = { actor: f.actor, session: f.session }, instance = id) => request(f.app)
      .get(`/api/connectors/setups/reconnect/${instance}`).query({ workspaceId: f.workspaceId })
      .set('x-actor', who.actor).set('x-session', who.session)
    const projection = await get(admin)
    expect(projection.status).toBe(200)
    expect(projection.headers['cache-control']).toContain('no-store')
    expect(projection.body).toMatchObject({ viewerUserId: admin.actor, workspaceId: f.workspaceId, instanceId: id,
      ownership: 'workspace', sensitivity: 'internal', provider: 'shopify',
      binding: { compartments: [f.team.compartmentKey], projectIds: [project] }, eligibility: { eligible: true, reason: null } })
    expect(projection.body.instanceVersion).toMatch(/^\d+$/)
    expect(projection.body.validForMs).toBeGreaterThan(0); expect(projection.body.validForMs).toBeLessThanOrEqual(30000)
    const text = JSON.stringify(projection.body)
    for (const secret of ['credentials', 'merchant-secret', 'fixture.myshopify.com', 'gid://shopify', 'account_digest', 'connectedEmail']) expect(text).not.toContain(secret)
    const denied = await get(member), missing = await get(admin, randomUUID())
    expect(denied.status).toBe(404); expect(denied.body).toEqual(missing.body)
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, admin.actor])
    expect((await get(admin)).body).toEqual(missing.body)
    const own = await get()
    // A displayed projection is not authority to silently accept a later row.
    await pool.query("UPDATE connector_instance SET label='Cosmetic update' WHERE id=$1", [id])
    const stale = await f.start({ operation: 'reconnect', instanceId: id, expectedInstanceVersion: own.body.instanceVersion, expectedPolicyRevision: own.body.policyRevision })
    expect(stale.body.error).toBe('connector_setup_target_changed')
  })

  it('hides foreign personal connectors even from admins; expiry and current session/membership revocation end projection access', async () => {
    const f = await fixture(), start = await f.start({ ownership: 'personal' })
    await f.callback(start.body); const id = await f.approve(start.body.id)
    const admin = await projectionActor(f.workspaceId, 'admin')
    const get = (actor = f.actor, session = f.session, workspace = f.workspaceId) => request(f.app)
      .get(`/api/connectors/setups/reconnect/${id}`).query({ workspaceId: workspace }).set('x-actor', actor).set('x-session', session)
    const denied = await get(admin.actor, admin.session)
    expect(denied.status).toBe(404); expect((await get(f.actor, 'none')).body).toEqual(denied.body)
    expect((await get(f.actor, f.session, randomUUID())).body).toEqual(denied.body)
    const own = await get()
    expect(own.body).toMatchObject({ ownership: 'personal', binding: { compartments: [], projectIds: [] }, eligibility: { eligible: true } })
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actor])
    expect((await get()).body).toMatchObject({ ownership: 'personal', eligibility: { eligible: true } })
    await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [f.session])
    expect((await get()).body.validForMs).toBeLessThanOrEqual(2000)
    await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [f.session])
    expect((await get()).body).toEqual(denied.body)
    await pool.query("UPDATE auth_sessions SET revoked_at=NULL,expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.session])
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor])
    expect((await get()).body).toEqual(denied.body)
  })
  it('starts OAuth without any instance, stages the callback privately, and activates only the reviewed exact account', async () => {
    const f = await fixture(), start = await f.start()
    expect(start.status).toBe(200)
    const url = new URL(start.body.authorizeUrl)
    expect(url.searchParams.get('state')).toBe(start.body.state)
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/api/auth/callback/shopify')
    expect(JSON.stringify(start.body)).not.toContain('merchant-secret')
    const auth = (await pool.query('SELECT encrypted_payload FROM connector_setup_auth_material WHERE setup_id=$1', [start.body.id])).rows[0].encrypted_payload as Buffer
    expect(auth.includes(Buffer.from('merchant-secret'))).toBe(false)
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.actor])
      expect((await client.query('SELECT * FROM connector_setup_auth_material WHERE setup_id=$1', [start.body.id])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
    expect(await f.instances.listByUserSystem(f.actor)).toEqual([])
    expect(await f.instances.listByWorkspaceSystem(f.workspaceId)).toEqual([])
    expect((await f.callback(start.body)).body.status).toBe('pending_review')
    expect(await f.instances.listByWorkspaceSystem(f.workspaceId)).toEqual([])
    expect((await pool.query('SELECT * FROM connector_setup_auth_material WHERE setup_id=$1', [start.body.id])).rowCount).toBe(0)
    const id = await f.approve(start.body.id)
    expect(await f.instances.getSystem(id)).toMatchObject({ connected: true, compartments: [f.team.compartmentKey], ingestionEnabled: false })
    expect((await f.callback(start.body)).status).toBe(409)
    expect(provider.exchange).toHaveBeenCalledTimes(1)
    const reconnect = await f.start({ operation: 'reconnect', instanceId: id })
    expect((await f.callback(reconnect.body)).body.status).toBe('pending_review')
    expect(await f.approve(reconnect.body.id)).toBe(id)
    expect((await f.instances.getSystem(id))!.compartments).toEqual([f.team.compartmentKey])
  })
  it('routes manual store-credentials through staging and retains the legacy no-setup contract', async () => {
    const f = await fixture()
    const body = { setup: { ...f.selection, ownership: 'personal' }, shopifyTokens: { shopDomain: 'fixture.myshopify.com', accessToken: 'pasted-secret' } }
    expect((await request(f.app).post('/api/connectors/shopify/store-credentials').set('x-session', 'none').send(body)).status).toBe(401)
    const staged = await request(f.app).post('/api/connectors/shopify/store-credentials').send(body)
    expect(staged.body.status).toBe('pending_review'); expect(await f.instances.listByUserSystem(f.actor)).toEqual([])
    const id = await f.approve(staged.body.id)
    expect(await f.instances.getSystem(id)).toMatchObject({ scope: 'user', workspaceId: null, compartments: [] })
    const legacy = await request(f.app).post('/api/connectors/shopify/store-credentials').send({ shopifyTokens: body.shopifyTokens, createNew: true })
    expect(legacy.status).toBe(200); expect(legacy.body.connectorInstanceId).toBeTruthy()
    const legacyProjection = await request(f.app).get(`/api/connectors/setups/reconnect/${legacy.body.connectorInstanceId}`).query({ workspaceId: f.workspaceId })
    expect(legacyProjection.body).toMatchObject({ ownership: 'personal', eligibility: { eligible: false, reason: 'account_review_required' } })
  })
  it('rejects foreign actor, session and workspace before consuming the callback nonce', async () => {
    const f = await fixture(), start = await f.start()
    const body = { setupId: start.body.id, workspaceId: f.workspaceId, params: { shop: 'fixture.myshopify.com', code: 'code', state: start.body.state } }
    for (const [header, value] of [['x-actor', randomUUID()], ['x-session', randomUUID()]]) {
      expect((await request(f.app).post('/api/connectors/shopify/oauth-callback').set(header, value).send(body)).status).toBe(409)
    }
    expect((await f.callback(start.body, { workspaceId: randomUUID() })).status).toBe(409)
    expect(provider.exchange).not.toHaveBeenCalled()
    expect((await f.callback(start.body)).body.status).toBe('pending_review')
  })
  it('keeps failed OAuth nondiscoverable and refuses a different verified account on reconnect', async () => {
    const f = await fixture(), bad = await f.start()
    provider.hmac.mockReturnValueOnce(false)
    expect((await f.callback(bad.body)).body.status).toBe('failed')
    expect(provider.exchange).not.toHaveBeenCalled()
    expect(await f.instances.listByWorkspaceSystem(f.workspaceId)).toEqual([])
    expect((await pool.query('SELECT * FROM connector_setup_auth_material WHERE setup_id=$1', [bad.body.id])).rowCount).toBe(0)
    const good = await f.start()
    expect((await f.callback(good.body)).body.status).toBe('pending_review')
    const id = await f.approve(good.body.id)
    const before = (await pool.query('SELECT credentials,compartments FROM connector_instance WHERE id=$1', [id])).rows[0]
    const reconnect = await f.start({ operation: 'reconnect', instanceId: id })
    provider.graphql.mockResolvedValueOnce({ shop: { id: 'gid://shopify/Shop/other', myshopifyDomain: 'fixture.myshopify.com' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } })
    expect((await f.callback(reconnect.body)).body.status).toBe('pending_review')
    const review = await request(f.app).post(`/api/connectors/setups/${reconnect.body.id}/review`).send({})
    await request(f.app).post(`/api/connectors/setups/${reconnect.body.id}/consent`).send({ digest: review.body.digest })
    const denied = await request(f.app).post(`/api/connectors/setups/${reconnect.body.id}/activate`).send({ digest: review.body.digest })
    expect(denied.body.error).toBe('connector_setup_account_review_required')
    expect((await pool.query('SELECT credentials,compartments FROM connector_instance WHERE id=$1', [id])).rows[0]).toEqual(before)
  })
  it('revalidates policy and session at late callback commit and never publishes failed pending material', async () => {
    for (const change of ['policy', 'session']) {
      const f = await fixture(), start = await f.start()
      let entered!: () => void, release!: () => void
      const inside = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
      provider.exchange.mockImplementationOnce(async () => { entered(); await gate; return { accessToken: 'provider-secret' } })
      const pending = f.callback(start.body).then(r => r)
      await inside
      try {
        if (change === 'policy') await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.workspaceId])
        else await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [f.session])
      } finally { release() }
      expect((await pending).body.status).toBe('stale')
      expect(await f.instances.listByWorkspaceSystem(f.workspaceId)).toEqual([])
      expect((await pool.query('SELECT * FROM connector_setup_staged_credentials WHERE setup_id=$1', [start.body.id])).rowCount).toBe(0)
      expect((await pool.query('SELECT * FROM connector_setup_auth_material WHERE setup_id=$1', [start.body.id])).rowCount).toBe(0)
    }
  })
})
