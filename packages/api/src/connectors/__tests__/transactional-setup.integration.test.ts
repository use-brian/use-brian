import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { getPool, getAppPool } from '../../db/client.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createTransactionalConnectorSetup, type ConnectorSetupRequest } from '../transactional-setup.js'
import { connectorSetupRoutes } from '../setup-routes.js'
import { ConnectorSetupLockRetry, lockConnectorSetupWorkspaces } from '../setup-locks.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), key = randomBytes(32)
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function fixture(mode = 'simple', beforeQuery?: (sql: string) => Promise<void>) {
  const actor = randomUUID(), workspaceId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [actor])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Setup',$2)", [workspaceId, actor])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, actor])
  const team = await createDbWorkspaceGroupStore().createTeam(actor, workspaceId, { name: 'Default', key: 'default' })
  await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1", [workspaceId, mode, team.id])
  const revision = (await pool.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [workspaceId])).rows[0].revision
  const session = (await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'fixture') RETURNING id", [actor])).rows[0].id
  let subject = 'verified-account', fail = false, gate: Promise<void> | undefined
  const setupPool = new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await pool.connect()
      return new Proxy(client, { get(c, p) {
        if (p === 'query') return async (...args: unknown[]) => {
          await beforeQuery?.(String(args[0]))
          return Reflect.apply(c.query, c, args)
        }
        const value = Reflect.get(c, p)
        return typeof value === 'function' ? value.bind(c) : value
      } })
    }
    return Reflect.get(target, property)
  } })
  const service = createTransactionalConnectorSetup({ pool: setupPool, encryptionKey: key, adapters: new Map([['fixture', {
    async verify() {
      if (gate) await gate
      if (fail) throw new Error('secret-provider-error')
      return { credentials: { type: 'bearer' as const, token: 'secret-token' }, label: 'Verified', config: {},
        account: { subject, tenant: null, roots: ['verified-root'], permissions: ['read'], adapter: 'fixture', adapterVersion: '1' } }
    },
  }]]) })
  const input: ConnectorSetupRequest = { workspaceId, provider: 'fixture', operation: 'create', ownership: 'workspace', sensitivity: 'internal', expectedPolicyRevision: String(revision), authSessionId: session }
  const ready = async (patch: Partial<ConnectorSetupRequest> = {}) => {
    const s = await service.start(actor, { ...input, ...patch })
    await service.stageVerifiedCredentials(actor, s.id, s.nonce, {})
    const r = await service.prepareConsent(actor, s.id)
    await service.saveConsent(actor, s.id, r.digest!)
    return { ...s, digest: r.digest! }
  }
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.userId = actor; if (req.headers['x-human']) req.authSessionId = session; next() })
  app.use('/setups', connectorSetupRoutes(service))
  return { actor, workspaceId, session, input, service, ready, app, team, setSubject: (s: string) => { subject = s }, setFail: () => { fail = true }, setGate: (g: Promise<void>) => { gate = g } }
}
describe('transactional production connector publication', () => {
  it('serializes cross-workspace reconnect activation against setup start without a workspace/resource cycle', async () => {
    let pause = false, entered!: () => void, release!: () => void
    const atWrite = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = await fixture('simple', async sql => {
      if (pause && sql.startsWith('UPDATE connector_instance SET credentials=')) {
        pause = false; entered(); await gate
      }
    })
    const b = await fixture('departments')
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')", [b.workspaceId, f.actor])
    b.input.expectedPolicyRevision = String((await pool.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [b.workspaceId])).rows[0].revision)
    const personal = await f.ready({ ownership: 'personal' })
    const id = (await f.service.activate(f.actor, personal.id, personal.digest)).result!.instanceId
    const shared = await f.ready({ workspaceId: b.workspaceId, expectedPolicyRevision: b.input.expectedPolicyRevision,
      operation: 'share', ownership: 'personal', instanceId: id, destination: { kind: 'department', departmentId: b.team.id } })
    await f.service.activate(f.actor, shared.id, shared.digest)
    const reconnect = await f.ready({ operation: 'reconnect', ownership: 'personal', instanceId: id })
    pause = true
    const activation = f.service.activate(f.actor, reconnect.id, reconnect.digest)
    await atWrite
    let started = false
    const other = f.service.start(f.actor, { ...f.input, workspaceId: b.workspaceId,
      expectedPolicyRevision: b.input.expectedPolicyRevision, operation: 'reconnect', ownership: 'personal', instanceId: id })
      .then(result => { started = true; return result })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(started).toBe(false)
      // Both workspaces, not just initiating A, are already owned by activation.
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        await expect(probe.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT', [b.workspaceId])).rejects.toMatchObject({ code: '55P03' })
      } finally { await probe.query('ROLLBACK'); probe.release() }
    } finally { release() }
    expect((await activation).status).toBe('active')
    const next = await other
    expect((await f.service.stageVerifiedCredentials(f.actor, next.id, next.nonce, {})).status).toBe('pending_review')
  })

  it('restarts the whole admission transaction when discovery changes, without repeating provider verification', async () => {
    const b = await fixture('departments')
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [b.workspaceId])
    let instanceId: string | undefined, armed = false, workspaceLocks = 0
    const f = await fixture('simple', async sql => {
      if (!instanceId || !sql.startsWith('SELECT id FROM workspaces WHERE id=ANY')) return
      workspaceLocks++
      if (armed) {
        armed = false
        await pool.query(`INSERT INTO connector_grant(connector_instance_id,target_type,target_id,granted_by_user_id)
          VALUES($1,'workspace',$2,$3)`, [instanceId, b.workspaceId, f.actor])
      }
    })
    const p = await f.ready({ ownership: 'personal' })
    instanceId = (await f.service.activate(f.actor, p.id, p.digest)).result!.instanceId
    armed = true
    const s = await f.service.start(f.actor, { ...f.input, ownership: 'personal', operation: 'reconnect', instanceId })
    expect(workspaceLocks).toBe(2)
    expect(s.status).toBe('pending_auth')
    expect((await pool.query('SELECT id FROM connector_pending_setups WHERE actor_user_id=$1', [f.actor])).rowCount).toBe(2)
    expect((await f.service.stageVerifiedCredentials(f.actor, s.id, s.nonce, {})).status).toBe('pending_review')
    const review = await f.service.prepareConsent(f.actor, s.id)
    await f.service.saveConsent(f.actor, s.id, review.digest!)
    expect((await f.service.activate(f.actor, s.id, review.digest!)).status).toBe('active')
  })

  it('rediscovery rejects an expanded workspace set and old resource-first writers never wait backwards', async () => {
    const f = await fixture(), b = await fixture('departments')
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [b.workspaceId])
    const p = await f.ready({ ownership: 'personal' })
    const id = (await f.service.activate(f.actor, p.id, p.digest)).result!.instanceId
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('app.system_bypass','true',true)")
      let injected = false
      const wrapped = new Proxy(c, { get(target, property) {
        if (property === 'query') return async (...args: unknown[]) => {
          if (!injected && String(args[0]).startsWith('SELECT id FROM workspaces WHERE id=ANY')) {
            injected = true
            await pool.query(`INSERT INTO connector_grant(connector_instance_id,target_type,target_id,granted_by_user_id)
              VALUES($1,'workspace',$2,$3)`, [id, b.workspaceId, f.actor])
          }
          return Reflect.apply(target.query, target, args)
        }
        return Reflect.get(target, property)
      } })
      await expect(lockConnectorSetupWorkspaces(wrapped, f.workspaceId, id)).rejects.toBeInstanceOf(ConnectorSetupLockRetry)
    } finally { await c.query('ROLLBACK'); c.release() }
    // An old writer has already locked the resource before its row trigger.
    // It must abort immediately when the affected workspace is owned elsewhere.
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [b.workspaceId])
      await expect(pool.query("UPDATE connector_instance SET config='{\"changed\":true}' WHERE id=$1", [id])).rejects.toMatchObject({ code: '55P03' })
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    const retry = await f.ready({ operation: 'reconnect', ownership: 'personal', instanceId: id })
    expect((await f.service.activate(f.actor, retry.id, retry.digest)).status).toBe('active')
  })
  it('publishes the exact admitted instance only after consent; retries are receipts, not duplicate writes', async () => {
    const f = await fixture(), s = await f.ready()
    expect((await pool.query('SELECT id FROM connector_instance WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    const results = await Promise.all([1, 2].map(() => f.service.activate(f.actor, s.id, s.digest)))
    expect(results[0].result).toEqual(results[1].result)
    const rows = (await pool.query('SELECT * FROM connector_instance WHERE workspace_id=$1', [f.workspaceId])).rows
    expect(rows).toHaveLength(1); expect(rows[0].compartments).toEqual([f.team.compartmentKey])
    expect(rows[0].connected).toBe(true); expect(rows[0].ingestion_enabled).toBe(false)
    expect((await pool.query('SELECT * FROM connector_setup_staged_credentials WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
    expect(JSON.stringify(await f.service.get(f.actor, s.id))).not.toContain('secret-token')
    await expect(pool.query("UPDATE connector_instance SET credentials='replacement'::bytea WHERE id=$1", [rows[0].id])).rejects.toThrow('connector_setup_required')
  })
  it('preserves legacy writers but prevents an old ready-workspace instance escaping through ownership transfer', async () => {
    const f = await fixture('departments')
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
    const id = (await pool.query(`INSERT INTO connector_instance(scope,workspace_id,provider,label,connected,created_by)
      VALUES('workspace',$1,'fixture','Legacy',true,$2) RETURNING id`, [f.workspaceId, f.actor])).rows[0].id
    await pool.query("UPDATE connector_instance SET config='{}',label='Still legacy' WHERE id=$1", [id])
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.workspaceId])
    await expect(pool.query("UPDATE connector_instance SET scope='user',user_id=$2,workspace_id=NULL WHERE id=$1", [id, f.actor])).rejects.toThrow('connector_setup_required')
    await pool.query('UPDATE connector_instance SET connected=false,ingestion_enabled=false,ingest_workspace_id=NULL WHERE id=$1', [id])
    expect((await pool.query('SELECT connected FROM connector_instance WHERE id=$1', [id])).rows[0].connected).toBe(false)
  })
  it('requires actual session and explicit Departments destination through HTTP; rejects forged authority fields', async () => {
    const f = await fixture('departments')
    const { authSessionId: _, ...body } = f.input
    expect((await request(f.app).post('/setups').send(body)).status).toBe(401)
    expect((await request(f.app).post('/setups').set('x-human', 'yes').send({ ...body, authSessionId: f.session })).status).toBe(400)
    expect((await request(f.app).post('/setups').set('x-human', 'yes').send(body)).status).toBe(409)
    const start = await request(f.app).post('/setups').set('x-human', 'yes').send({ ...body, destination: { kind: 'department', departmentId: f.team.id } })
    expect(start.status).toBe(200)
    const call = (action: string, data = {}) => request(f.app).post(`/setups/${start.body.id}/${action}`).set('x-human', 'yes').send(data)
    expect((await call('stage', { nonce: start.body.nonce, proof: {} })).body.status).toBe('pending_review')
    const review = await call('review'); expect(JSON.stringify(review.body)).not.toContain('secret-token')
    expect((await call('consent', { digest: review.body.digest })).body.status).toBe('ready')
    expect((await call('activate', { digest: review.body.digest })).body.status).toBe('active')
  })
  it('preserves personal ownership, exact reconnect scope and credentials on failed account replacement', async () => {
    const f = await fixture(), s = await f.ready({ ownership: 'personal' })
    const active = await f.service.activate(f.actor, s.id, s.digest), id = active.result!.instanceId
    const before = (await pool.query('SELECT * FROM connector_instance WHERE id=$1', [id])).rows[0]
    expect(before.scope).toBe('user'); expect(before.workspace_id).toBeNull(); expect(before.compartments).toEqual([])
    const same = await f.ready({ ownership: 'personal', operation: 'reconnect', instanceId: id })
    expect((await f.service.activate(f.actor, same.id, same.digest)).status).toBe('active')
    const rotated = (await pool.query('SELECT credentials FROM connector_instance WHERE id=$1', [id])).rows[0].credentials
    f.setSubject('different-account')
    const changed = await f.ready({ ownership: 'personal', operation: 'reconnect', instanceId: id })
    await expect(f.service.activate(f.actor, changed.id, changed.digest)).rejects.toThrow('connector_setup_account_review_required')
    const after = (await pool.query('SELECT * FROM connector_instance WHERE id=$1', [id])).rows[0]
    expect(after.credentials).toEqual(rotated); expect(after.compartments).toEqual([])
  })
  it('reviews sharing and transfer and never starts ingest as a sharing side effect', async () => {
    const f = await fixture(), s = await f.ready({ ownership: 'personal' })
    const id = (await f.service.activate(f.actor, s.id, s.digest)).result!.instanceId
    const share = await f.ready({ ownership: 'personal', operation: 'share', instanceId: id, destination: { kind: 'department', departmentId: f.team.id } })
    expect((await pool.query('SELECT id FROM connector_grant WHERE connector_instance_id=$1', [id])).rowCount).toBe(0)
    const result = await f.service.activate(f.actor, share.id, share.digest)
    expect(result.result!.grantIds).toHaveLength(1)
    expect((await pool.query('SELECT compartments FROM connector_grant WHERE connector_instance_id=$1', [id])).rows[0].compartments).toEqual([f.team.compartmentKey])
    await expect(f.ready({ operation: 'transfer', instanceId: id })).rejects.toThrow('connector_setup_transfer_has_grants')
    const p = await f.ready({ ownership: 'personal' }), other = (await f.service.activate(f.actor, p.id, p.digest)).result!.instanceId
    const transfer = await f.ready({ operation: 'transfer', instanceId: other, destination: { kind: 'department', departmentId: f.team.id } })
    expect((await f.service.activate(f.actor, transfer.id, transfer.digest)).status).toBe('active')
    expect((await pool.query('SELECT scope,ingestion_enabled FROM connector_instance WHERE id=$1', [other])).rows[0]).toEqual({ scope: 'workspace', ingestion_enabled: false })
  })
  it('late in-flight verification cannot evade a committed policy change; revoked application callers see no staged credentials', async () => {
    const f = await fixture(), s = await f.service.start(f.actor, f.input)
    let release!: () => void
    f.setGate(new Promise<void>(resolve => { release = resolve }))
    const staging = f.service.stageVerifiedCredentials(f.actor, s.id, s.nonce, {})
    await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.workspaceId])
    release()
    expect((await staging).status).toBe('stale')
    await expect(f.service.prepareConsent(f.actor, s.id)).rejects.toThrow('connector_setup_not_reviewable')
    expect((await pool.query('SELECT id FROM connector_instance WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    const c = await getAppPool().connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('app.current_user_id',$1,true)", [f.actor])
      expect((await c.query('SELECT * FROM connector_setup_staged_credentials')).rowCount).toBe(0)
      await expect(c.query(`INSERT INTO connector_instance(scope,workspace_id,provider,label,connected,created_by)
        VALUES('workspace',$1,'fixture','Unreviewed',true,$2)`, [f.workspaceId, f.actor])).rejects.toThrow('connector_setup_required')
    } finally { await c.query('ROLLBACK'); c.release() }
  })
  it('failed verification and late policy callbacks cannot create any usable exposure', async () => {
    const f = await fixture(), s = await f.service.start(f.actor, f.input)
    f.setFail()
    expect((await f.service.stageVerifiedCredentials(f.actor, s.id, s.nonce, {})).status).toBe('failed')
    expect((await pool.query('SELECT id FROM connector_instance WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    const g = await fixture(), r = await g.ready()
    await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [g.workspaceId])
    expect((await g.service.activate(g.actor, r.id, r.digest)).status).toBe('stale')
    const h = await fixture(), t = await h.ready()
    await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [h.session])
    expect((await h.service.activate(h.actor, t.id, t.digest)).status).toBe('stale')
  })
})
