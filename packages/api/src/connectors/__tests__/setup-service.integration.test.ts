import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg, { type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createConnectorSetupService, type SetupIntent, type SetupContext } from '../setup-service.js'

// Fail closed: only the disposable PG18 fixture, never a local-dev fallback.
const markerPath = process.env.BRIAN_ASSURANCE_FIXTURE
if (!markerPath || !process.env.BRIAN_ASSURANCE_TOKEN) throw new Error('Run through scripts/crm/local-fixture.mjs --pg-bin /tmp/access-modes-pg-run')
const marker = JSON.parse(await readFile(markerPath, 'utf8'))
for (const name of ['DATABASE_URL', 'DATABASE_URL_APP']) {
  const url = new URL(process.env[name]!)
  if (marker.token !== process.env.BRIAN_ASSURANCE_TOKEN || url.hostname !== '127.0.0.1'
    || Number(url.port) !== marker.port || url.pathname !== '/brian_assurance') throw new Error('Not the owned disposable fixture')
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const users: string[] = [], workspaces: string[] = []
const key = randomBytes(32)
const token = 'fixture-credential-never-project'
const account = { subject: 'verified-subject', tenant: 'verified-tenant', roots: ['root-b', 'root-a'], permissions: ['read'], adapter: 'fixture-only', adapterVersion: '1' }
beforeAll(async () => {
  expect((await pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^18\./)
  await pool.query('CREATE TABLE connector_setup_test_effects(id uuid PRIMARY KEY, setup_id uuid NOT NULL UNIQUE)')
  await pool.query('CREATE TABLE connector_setup_test_versions(id uuid PRIMARY KEY, version bigint NOT NULL)')
})
afterAll(async () => {
  await pool.query('DROP TABLE connector_setup_test_effects, connector_setup_test_versions')
  for (const id of workspaces) await pool.query('DELETE FROM workspaces WHERE id=$1', [id])
  for (const id of users) await pool.query('DELETE FROM users WHERE id=$1', [id])
  await app.end(); await pool.end()
})
async function fixture() {
  const actorId = randomUUID(), adminId = randomUUID(), outsiderId = randomUUID(), workspaceId = randomUUID(), targetId = randomUUID()
  for (const id of [actorId, adminId, outsiderId]) {
    users.push(id)
    await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'Setup fixture')", [id])
  }
  workspaces.push(workspaceId)
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Setup fixture',$2)", [workspaceId, actorId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')", [workspaceId, actorId, adminId])
  await pool.query('INSERT INTO connector_setup_test_versions VALUES($1,1)', [targetId])
  const intent: SetupIntent = { operation: 'reconnect', surface: 'fixture', ownership: 'workspace', credentialOwnerId: actorId,
    target: { instanceId: targetId, version: '1', grants: [] }, binding: { departments: ['selected-department'], projects: [], origin: 'explicit', sensitivityFloor: 'internal' },
    importDestination: null, ingestionOptIn: false, authorityReferences: ['membership-generation-1'], boundaryProposal: 'no-catalog-exception', sessionBinding: 'session-1', redirectIdentity: 'callback-1' }
  const validate = vi.fn(async (c: PoolClient, setup: SetupContext) => {
    const r = await c.query('SELECT version FROM connector_setup_test_versions WHERE id=$1 FOR UPDATE', [setup.intent.target!.instanceId])
    return String(r.rows[0]?.version) === setup.intent.target!.version
  })
  const verify = vi.fn(async (_s: SetupContext, proof: { code: string }) => {
    if (proof.code !== 'provider-code') throw new Error(token)
    return { credentials: { accessToken: token }, account }
  })
  let failAfterWrite = false
  const activate = vi.fn(async (c: PoolClient, setup: SetupContext, payload: { credentials: { accessToken: string } }) => {
    if (payload.credentials.accessToken !== token) throw new Error('bad decrypt')
    const instanceId = setup.intent.target!.instanceId
    await c.query('INSERT INTO connector_setup_test_effects VALUES($1,$2)', [instanceId, setup.id])
    if (failAfterWrite) throw new Error(token)
    return { instanceId, grantIds: [], outboxIds: [] }
  })
  const service = createConnectorSetupService({ pool, encryptionKey: key,
    admit: async (_c, _actor, _request: undefined) => ({ workspaceId, provider: 'fixture-only', intent }),
    lockAndValidate: validate, verifyProvider: verify, activate })
  const start = () => service.start(actorId, undefined)
  const ready = async () => {
    const s = await start()
    await service.stageVerifiedCredentials(actorId, s.id, s.nonce, { code: 'provider-code' })
    const review = await service.prepareConsent(actorId, s.id)
    await service.saveConsent(actorId, s.id, review.digest!)
    return { ...s, digest: review.digest! }
  }
  return { actorId, adminId, outsiderId, workspaceId, targetId, intent, service, start, ready, verify, activate, setFail: (v: boolean) => { failAfterWrite = v } }
}
async function asUser<T>(id: string, fn: (c: PoolClient) => Promise<T>) {
  const c = await app.connect()
  try { await c.query('BEGIN'); await c.query("SELECT set_config('app.current_user_id',$1,true)", [id]); return await fn(c) }
  finally { await c.query('ROLLBACK'); c.release() }
}

describe('pending setup foundation (no provider certification)', () => {
  it('encrypts staging, redacts reads, and enforces current-owner RLS and system-only writes', async () => {
    const f = await fixture(), s = await f.start()
    await f.service.stageVerifiedCredentials(f.actorId, s.id, s.nonce, { code: 'provider-code' })
    const row = (await pool.query('SELECT * FROM connector_pending_setups WHERE id=$1', [s.id])).rows[0]
    expect(row.nonce_hash).toBeNull()
    const blob = (await pool.query('SELECT encrypted_payload FROM connector_setup_staged_credentials WHERE setup_id=$1', [s.id])).rows[0].encrypted_payload as Buffer
    expect(blob.includes(Buffer.from(token))).toBe(false)
    for (const actor of [f.actorId, f.adminId]) {
      const safe = JSON.stringify(await f.service.get(actor, s.id))
      expect(safe).not.toContain(token); expect(safe).not.toContain(account.subject); expect(safe).not.toContain('nonce')
    }
    await expect(f.service.get(f.outsiderId, s.id)).rejects.toThrow('connector_setup_not_found')
    await asUser(f.actorId, async c => {
      expect((await c.query('SELECT id FROM connector_pending_setups WHERE id=$1', [s.id])).rowCount).toBe(1)
      expect((await c.query('SELECT * FROM connector_setup_staged_credentials')).rowCount).toBe(0)
      expect((await c.query("UPDATE connector_pending_setups SET status='cancelled' WHERE id=$1", [s.id])).rowCount).toBe(0)
    })
    await asUser(f.adminId, async c => { expect((await c.query('SELECT id FROM connector_pending_setups WHERE id=$1', [s.id])).rowCount).toBe(0) })
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actorId])
    await asUser(f.actorId, async c => { expect((await c.query('SELECT id FROM connector_pending_setups WHERE id=$1', [s.id])).rowCount).toBe(0) })
  })
  it('has independent hashed one-use nonces, rejects wrong actors and forged evidence, and hides provider errors', async () => {
    const f = await fixture(), a = await f.start(), b = await f.start()
    expect(a.nonce).not.toBe(b.nonce)
    const stored = (await pool.query('SELECT nonce_hash FROM connector_pending_setups WHERE id=$1', [a.id])).rows[0].nonce_hash
    expect(stored).toMatch(/^[a-f0-9]{64}$/); expect(stored).not.toBe(a.nonce)
    await expect(f.service.stageVerifiedCredentials(f.adminId, a.id, a.nonce, { code: 'provider-code' })).rejects.toThrow('connector_setup_not_found')
    await expect(f.service.stageVerifiedCredentials(f.actorId, a.id, b.nonce, { code: 'provider-code' })).rejects.toThrow('connector_setup_nonce_invalid')
    const results = await Promise.allSettled([1, 2].map(() => f.service.stageVerifiedCredentials(f.actorId, a.id, a.nonce, { code: 'provider-code' })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.verify).toHaveBeenCalledTimes(1)
    expect((await f.service.stageVerifiedCredentials(f.actorId, b.id, b.nonce, { code: 'forged-evidence' })).status).toBe('failed')
    await expect(f.service.stageVerifiedCredentials(f.actorId, b.id, b.nonce, { code: 'provider-code' })).rejects.toThrow('connector_setup_nonce_invalid')
  })
  it('requires saved consent, rolls callback writes back, and returns one result under concurrent activation', async () => {
    const f = await fixture(), s = await f.start()
    await expect(f.service.activate(f.actorId, s.id, 'fake')).rejects.toThrow('connector_setup_consent_mismatch')
    await f.service.stageVerifiedCredentials(f.actorId, s.id, s.nonce, { code: 'provider-code' })
    const review = await f.service.prepareConsent(f.actorId, s.id)
    expect(review.review?.account.roots).toEqual(['root-a', 'root-b'])
    expect(JSON.stringify(review)).not.toContain(token)
    await expect(f.service.activate(f.actorId, s.id, review.digest!)).rejects.toThrow('connector_setup_consent_mismatch')
    await expect(f.service.saveConsent(f.actorId, s.id, 'wrong')).rejects.toThrow('connector_setup_consent_mismatch')
    await f.service.saveConsent(f.actorId, s.id, review.digest!)
    f.setFail(true)
    await expect(f.service.activate(f.actorId, s.id, review.digest!)).rejects.toThrow('connector_setup_failed')
    expect((await pool.query('SELECT * FROM connector_setup_test_effects WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
    expect((await f.service.get(f.actorId, s.id)).status).toBe('ready')
    f.setFail(false)
    const results = await Promise.all([1, 2].map(() => f.service.activate(f.actorId, s.id, review.digest!)))
    expect(results[0].result).toEqual(results[1].result)
    expect(f.activate).toHaveBeenCalledTimes(2)
    expect((await pool.query('SELECT * FROM connector_setup_staged_credentials WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
  })
  it('locks exact versions against racing changes and stales rather than recomputing consent', async () => {
    const f = await fixture(), s = await f.ready(), c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('UPDATE connector_setup_test_versions SET version=version+1 WHERE id=$1', [f.targetId])
      const activation = f.service.activate(f.actorId, s.id, s.digest)
      await new Promise(resolve => setTimeout(resolve, 50))
      await c.query('COMMIT')
      expect((await activation).status).toBe('stale')
      expect(f.activate).not.toHaveBeenCalled()
    } finally { await c.query('ROLLBACK'); c.release() }
  })
  it('policy change and membership removal block activation and clean only staged material', async () => {
    for (const mutation of ['policy', 'membership']) {
      const f = await fixture(), s = await f.ready()
      if (mutation === 'policy') await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.workspaceId])
      else await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actorId])
      expect((await f.service.activate(f.actorId, s.id, s.digest)).status).toBe('stale')
      expect(f.activate).not.toHaveBeenCalled()
      expect((await pool.query('SELECT * FROM connector_setup_staged_credentials WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
      expect((await pool.query('SELECT version FROM connector_setup_test_versions WHERE id=$1', [f.targetId])).rows[0].version).toBe('1')
    }
  })
  it('keeps intent immutable and never resurrects cancelled or expired setups', async () => {
    const f = await fixture(), s = await f.ready()
    await expect(pool.query("UPDATE connector_pending_setups SET provider='other' WHERE id=$1", [s.id])).rejects.toThrow('connector_setup_intent_immutable')
    await expect(pool.query("UPDATE connector_pending_setups SET intent=intent || '{\"operation\":\"create\"}' WHERE id=$1", [s.id])).rejects.toThrow('connector_setup_intent_immutable')
    expect((await f.service.cancel(f.actorId, s.id)).status).toBe('cancelled')
    await expect(f.service.activate(f.actorId, s.id, s.digest)).rejects.toThrow()
    const short = await f.service.start(f.actorId, undefined, 1)
    await f.service.stageVerifiedCredentials(f.actorId, short.id, short.nonce, { code: 'provider-code' })
    await new Promise(resolve => setTimeout(resolve, 1100))
    await f.service.expire()
    expect((await f.service.get(f.actorId, short.id)).status).toBe('expired')
    expect((await pool.query('SELECT * FROM connector_setup_staged_credentials WHERE setup_id=ANY($1::uuid[])', [[s.id, short.id]])).rowCount).toBe(0)
    expect((await pool.query('SELECT version FROM connector_setup_test_versions WHERE id=$1', [f.targetId])).rows[0].version).toBe('1')
  })
  it('durably consumes the nonce before probing and cancellation wins over an in-flight provider result', async () => {
    const f = await fixture(), s = await f.start()
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    f.verify.mockImplementationOnce(async () => {
      entered(); await gate
      return { credentials: { accessToken: token }, account }
    })
    const staging = f.service.stageVerifiedCredentials(f.actorId, s.id, s.nonce, { code: 'provider-code' })
    await enteredPromise
    try {
      expect((await pool.query('SELECT nonce_hash FROM connector_pending_setups WHERE id=$1', [s.id])).rows[0].nonce_hash).toBeNull()
      await expect(f.service.stageVerifiedCredentials(f.actorId, s.id, s.nonce, { code: 'provider-code' })).rejects.toThrow('connector_setup_nonce_invalid')
      await f.service.cancel(f.actorId, s.id)
    } finally { release() }
    expect((await staging).status).toBe('cancelled')
    expect((await pool.query('SELECT * FROM connector_setup_staged_credentials WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
  })
  it('serializes policy revocation with activation and denies the newly stale command', async () => {
    const f = await fixture(), s = await f.ready(), c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      await c.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.workspaceId])
      const activation = f.service.activate(f.actorId, s.id, s.digest)
      await new Promise(resolve => setTimeout(resolve, 50))
      await c.query('COMMIT')
      expect((await activation).status).toBe('stale')
      expect(f.activate).not.toHaveBeenCalled()
    } finally { await c.query('ROLLBACK'); c.release() }
  })
  it('never commits a callback that crosses expiry and projects the persisted version', async () => {
    const f = await fixture(), s = await f.service.start(f.actorId, undefined, 1)
    await f.service.stageVerifiedCredentials(f.actorId, s.id, s.nonce, { code: 'provider-code' })
    const review = await f.service.prepareConsent(f.actorId, s.id)
    const saved = await f.service.saveConsent(f.actorId, s.id, review.digest!)
    expect(saved.version).toBe((await f.service.get(f.actorId, s.id)).version)
    f.activate.mockImplementationOnce(async (c, setup) => {
      const instanceId = setup.intent.target!.instanceId
      await c.query('INSERT INTO connector_setup_test_effects VALUES($1,$2)', [instanceId, setup.id])
      await c.query('SELECT pg_sleep(1.1)')
      return { instanceId, grantIds: [], outboxIds: [] }
    })
    await expect(f.service.activate(f.actorId, s.id, review.digest!)).rejects.toThrow('connector_setup_expired')
    expect((await pool.query('SELECT * FROM connector_setup_test_effects WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
    await f.service.expire()
    expect((await f.service.get(f.actorId, s.id)).status).toBe('expired')
  })

  it('rejects an activation receipt for a sibling instance and rolls back its writes', async () => {
    const f = await fixture(), s = await f.ready()
    f.activate.mockImplementationOnce(async (c, setup) => {
      const sibling = randomUUID()
      await c.query('INSERT INTO connector_setup_test_effects VALUES($1,$2)', [sibling, setup.id])
      return { instanceId: sibling, grantIds: [], outboxIds: [] }
    })
    await expect(f.service.activate(f.actorId, s.id, s.digest)).rejects.toThrow('connector_setup_result_invalid')
    expect((await pool.query('SELECT * FROM connector_setup_test_effects WHERE setup_id=$1', [s.id])).rowCount).toBe(0)
    expect((await f.service.get(f.actorId, s.id)).status).toBe('ready')
  })

})
