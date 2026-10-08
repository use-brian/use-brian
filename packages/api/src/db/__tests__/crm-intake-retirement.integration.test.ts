import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { WORKSPACE_FLUSH_TABLES, WORKSPACE_FLUSH_PRESERVED_TABLES } from '../workspace-flush.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { readCrmPrivacyPolicy, retireCrmIntakeReceipts } from '../../crm-operations/privacy-policy.js'
import { acquireCrmPrivacyAdmission } from '../../crm-operations/privacy-admission.js'
import { exportCrmOperationsPrivacy, pruneCrmOperationsRetention, redactCrmOperationsForContact } from '../../crm-operations/privacy.js'
import { crmIntakeRoutes } from '../../routes/crm-intake.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const servers: Server[] = []
const retired = { duplicate: true, outcome: 'submission_retired' }
async function fixture(seconds: number | null = 86400) {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Replay fixture',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId,userId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user',userId }, authority: { role: 'owner',canWrite: true,canConfigure: true,trustedIdentitySources: [] } }
  const savePolicy = (expectedVersion: number, retentionSeconds: number | null) => service.execute(context,
    { kind: 'save_privacy_policy',expectedVersion,confirmed: true,intakeReplay: retentionSeconds === null ? null : { retentionSeconds } })
  if (seconds !== null) await savePolicy(0,seconds)
  await service.execute(context,CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose',purposeKey: 'updates',label: 'Updates',wordingVersion: '1',wording: 'Fixture consent' }))
  const definition = await service.execute(context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionKey: 'fixture',label: 'Fixture',definition: {
    identityPolicy: 'new_or_review',fields: [
      { key: 'name',label: 'Name',type: 'text',required: true,mapping: { kind: 'base_field',field: 'name' } },
      { key: 'agree',label: 'Agree',type: 'boolean',required: true,mapping: { kind: 'submission_only' } },
    ],consentMappings: [{ fieldKey: 'agree',grantedValue: true,purposeKey: 'updates' }],
    followUpTaskTemplate: { title: 'Review fixture',priority: 'medium' },
  } }))
  const key = (rotateFromCredentialId?: string) => service.execute(context,{ kind: 'create_intake_credential',label: 'Fixture backend',definitionIds: [String(definition.record.id)],rotateFromCredentialId })
  const credential = await key()
  const readStore = createDbCrmIntakeReadStore(), app = express()
  app.use('/api',crmIntakeRoutes({ service,readStore }))
  app.use(express.json()); app.use((req,_res,next) => { req.userId = userId; next() })
  const workspaceStore = { getRole: async (id: string, workspace: string) => (await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,id])).rows[0]?.role ?? null }
  app.use('/api/crm',crmOperationsRoutes({ service,readStore,workspaceStore } as never))
  const server = app.listen(0,'127.0.0.1'); servers.push(server); await once(server,'listening')
  const submit = (source='fixture_submission', name='Fixture person', secret=credential.oneTimeSecret!) => request(server)
    .post('/api/crm/intake/fixture/submissions').set('Authorization',`Bearer ${secret}`).set('Idempotency-Key',source)
    .send({ fields: { name,agree: true } })
  const erase = async (contactId: string) => {
    const store = createSoftDeleteStore(), snapshot = await store.readForSoftDelete('contact',workspaceId,contactId)
    await store.applyHardPurge({ primitive: 'contact',workspaceId,rowId: contactId,actorUserId: userId,
      reason: 'Synthetic privacy exercise',ticketReference: null,snapshot: snapshot!,now: new Date() })
  }
  return { workspaceId,userId,context,savePolicy,key,credential,submit,erase,server }
}
async function counts(workspaceId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM entities WHERE workspace_id=$1) AS people,
    (SELECT count(*)::int FROM association_enquiries WHERE workspace_id=$1) AS submissions,
    (SELECT count(*)::int FROM association_consent_events WHERE workspace_id=$1) AS consent,
    (SELECT count(*)::int FROM tasks WHERE workspace_id=$1) AS tasks,
    (SELECT count(*)::int FROM crm_intake_idempotency WHERE workspace_id=$1) AS receipts,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1) AS audit,
    (SELECT count(*)::int FROM correction_audit WHERE workspace_id=$1) AS corrections,
    (SELECT count(*)::int FROM crm_domain_event_outbox WHERE workspace_id=$1) AS outbox`,[workspaceId])).rows[0]
}

describe('[COMP:crm/operations-privacy] Actual retired intake replay and policy', () => {
  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()))))
    await Promise.all([pool.end(),appPool.end()])
  })

  it('requires explicit member approval, rechecks current role and serializes policy versions', async () => {
    const f = await fixture(null)
    expect(await readCrmPrivacyPolicy(f.workspaceId)).toMatchObject({ version: 0,policy: { intakeReplay: null } })
    const path = `/api/crm/${f.workspaceId}/operations/privacy-policy`
    expect((await request(f.server).post(path).send({ expectedVersion: 0,intakeReplay: { retentionSeconds: 3600 } })).status).toBe(400)
    const policy = { kind: 'save_privacy_policy' as const,confirmed: true as const,expectedVersion: 0,intakeReplay: { retentionSeconds: 3600 } }
    await expect(service.execute({ ...f.context,actor: { kind: 'assistant',assistantId: randomUUID(),sessionId: randomUUID(),userId: f.userId } },policy)).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1`,[f.workspaceId])
    await expect(service.execute(f.context,policy)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await request(f.server).get(path)).status).toBe(403)
    await pool.query(`UPDATE workspace_members SET role='owner' WHERE workspace_id=$1`,[f.workspaceId])
    const results = await Promise.allSettled([f.savePolicy(0,3600),f.savePolicy(0,7200)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict',details: { reason: 'stale_privacy_policy_version' } } })
    const current = await readCrmPrivacyPolicy(f.workspaceId)
    expect((await f.savePolicy(1,current.policy.intakeReplay!.retentionSeconds)).created).toBe(false)
    expect((await pool.query(`SELECT count(*)::int AS n FROM association_audit_log WHERE workspace_id=$1 AND action='crm.privacy_policy.approved'`,[f.workspaceId])).rows[0].n).toBe(1)
    expect((await request(f.server).get(path)).body.version).toBe(1)
  })

  it('retires in the canonical hard-purge transaction and replays without old ids or effects after rotation', async () => {
    const f = await fixture(), accepted = await f.submit()
    expect(accepted.status).toBe(201)
    await f.erase(accepted.body.contactId)
    const replacement = await f.key(String(f.credential.record.id))
    await service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(f.credential.record.id) })
    const before = await counts(f.workspaceId)
    expect((await f.submit()).status).toBe(401)
    const replies = await Promise.all(Array.from({ length: 6 },() => f.submit('fixture_submission','Fixture person',replacement.oneTimeSecret!)))
    replies.forEach((reply) => { expect(reply.status).toBe(200); expect(reply.body).toEqual(retired) })
    expect((await f.submit('fixture_submission','Changed person',replacement.oneTimeSecret!)).status).toBe(409)
    expect(await counts(f.workspaceId)).toEqual(before)
    const receipt = (await pool.query('SELECT * FROM crm_intake_idempotency WHERE workspace_id=$1',[f.workspaceId])).rows[0]
    expect(receipt).toMatchObject({ status: 'retired',contact_id: null,submission_id: null,follow_up_task_id: null,replay_policy_version: 1 })
    expect(JSON.stringify(receipt)).not.toContain(accepted.body.contactId)
    expect(await counts(f.workspaceId)).toMatchObject({ people: 0,submissions: 0,consent: 0,receipts: 1 })
  })

  it('rolls back erasure and retention completely when legacy receipts have no approved period', async () => {
    const f = await fixture(null), accepted = await f.submit()
    await pool.query(`UPDATE association_enquiries SET status='resolved' WHERE id=$1`,[accepted.body.submissionId])
    const before = await counts(f.workspaceId)
    await expect(f.erase(accepted.body.contactId)).rejects.toMatchObject({ details: { reason: 'intake_replay_policy_unconfigured' } })
    await expect(pruneCrmOperationsRetention(f.context,new Date('2099-01-01T00:00:00Z'))).rejects.toMatchObject({ details: { reason: 'intake_replay_policy_unconfigured' } })
    expect(await counts(f.workspaceId)).toEqual(before)
    await pool.query(`UPDATE crm_intake_idempotency SET created_at=clock_timestamp()-interval '10 minutes' WHERE workspace_id=$1`,[f.workspaceId])
    await f.savePolicy(0,3600); await f.erase(accepted.body.contactId)
    expect((await pool.query(`SELECT extract(epoch FROM replay_expires_at-created_at)::int AS seconds FROM crm_intake_idempotency WHERE workspace_id=$1`,[f.workspaceId])).rows[0].seconds).toBe(3600)
    expect((await f.submit()).body).toEqual(retired)
  })

  it('never rewrites captured horizons when an owner changes or removes policy', async () => {
    const f = await fixture(), accepted = await f.submit()
    const before = (await pool.query('SELECT replay_expires_at FROM crm_intake_idempotency WHERE workspace_id=$1',[f.workspaceId])).rows[0].replay_expires_at
    await f.savePolicy(1,60); await f.savePolicy(2,null)
    await f.erase(accepted.body.contactId)
    expect((await pool.query('SELECT replay_expires_at FROM crm_intake_idempotency WHERE workspace_id=$1',[f.workspaceId])).rows[0].replay_expires_at).toEqual(before)
    expect((await f.submit()).body).toEqual(retired)
    const fresh = await f.submit('unconfigured_submission')
    await expect(f.erase(fresh.body.contactId)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('retention preserves live receipts and failed events and retires only its locked resolved submissions', async () => {
    const f = await fixture(), resolved = await f.submit(), open = await f.submit('open_submission')
    await pool.query(`UPDATE association_enquiries SET status='resolved' WHERE id=$1`,[resolved.body.submissionId])
    await pool.query(`UPDATE crm_domain_event_outbox SET status='failed' WHERE workspace_id=$1`,[f.workspaceId])
    const before = await counts(f.workspaceId)
    const result = await pruneCrmOperationsRetention(f.context,new Date('2099-01-01T00:00:00Z'))
    expect(result.deleted.association_enquiries).toBe(1)
    expect(result.deleted.crm_domain_event_outbox).toBe(0)
    expect((await f.submit()).body).toEqual(retired)
    expect((await f.submit('open_submission')).body).toEqual({ ...open.body,duplicate: true })
    expect(await counts(f.workspaceId)).toMatchObject({ people: 2,submissions: 1,receipts: 2,consent: before.consent,outbox: before.outbox })
  })

  it('permits new acceptance only after the approved retired horizon and serializes concurrent reuse', async () => {
    const f = await fixture(), first = await f.submit()
    await f.erase(first.body.contactId)
    // Move fixture time, not production policy, past an already captured horizon.
    await pool.query(`UPDATE crm_intake_idempotency SET created_at=clock_timestamp()-interval '2 hours',replay_expires_at=clock_timestamp()-interval '1 hour' WHERE workspace_id=$1`,[f.workspaceId])
    const results = await Promise.all(Array.from({ length: 4 },() => f.submit('fixture_submission','New fixture person')))
    expect(results.map((r) => r.status).sort()).toEqual([200,200,200,201])
    expect(new Set(results.map((r) => r.body.contactId)).size).toBe(1)
    expect(results[0].body.contactId).not.toBe(first.body.contactId)
    expect(await counts(f.workspaceId)).toMatchObject({ people: 1,submissions: 1,consent: 1,receipts: 1 })
  })

  it('counts receipts removed during retirement and needs no replay policy for unrelated people', async () => {
    const f = await fixture(), accepted = await f.submit()
    await pool.query(`UPDATE crm_intake_idempotency SET created_at=clock_timestamp()-interval '2 hours',replay_expires_at=clock_timestamp()-interval '1 hour' WHERE workspace_id=$1`,[f.workspaceId])
    // Expiry does not discard live result replay.
    expect((await f.submit()).body).toEqual({ ...accepted.body,duplicate: true })
    await pool.query(`UPDATE association_enquiries SET status='resolved' WHERE id=$1`,[accepted.body.submissionId])
    const result = await pruneCrmOperationsRetention(f.context,new Date('2099-01-01T00:00:00Z'))
    expect(result.deleted.crm_intake_idempotency).toBe(1)
    expect(result.deleted.association_enquiries).toBe(1)
    expect(result.total).toBe(Object.values(result.deleted).reduce((sum,n) => sum+n,0))
    const other = await fixture(null)
    const person = await pool.query(`INSERT INTO entities(workspace_id,kind,display_name,created_by_user_id,source)
      VALUES($1,'person','Unrelated fixture',$2,'manual') RETURNING id`,[other.workspaceId,other.userId])
    await other.erase(person.rows[0].id)
    expect(await counts(other.workspaceId)).toMatchObject({ people: 0,receipts: 0 })
  })

  it('refuses accidental parent deletion and invalid retired states, and keeps policy versions immutable', async () => {
    const f = await fixture(), accepted = await f.submit()
    await expect(pool.query('DELETE FROM association_enquiries WHERE id=$1',[accepted.body.submissionId])).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query('DELETE FROM entities WHERE id=$1',[accepted.body.contactId])).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(`UPDATE crm_intake_idempotency SET status='retired' WHERE workspace_id=$1`,[f.workspaceId])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`UPDATE crm_privacy_policies SET policy='{"intakeReplay":null}' WHERE workspace_id=$1`,[f.workspaceId])).rejects.toThrow('immutable')
    for (const policy of [{}, { intakeReplay: {} }, { intakeReplay: { retentionSeconds: -1 } }, { intakeReplay: { retentionSeconds: 1.5 } }]) {
      await expect(pool.query('INSERT INTO crm_privacy_policies(workspace_id,version,policy) VALUES($1,2,$2)',[f.workspaceId,policy])).rejects.toMatchObject({ code: '23514' })
    }
    expect((await f.submit()).body).toEqual({ ...accepted.body,duplicate: true })
  })

  it('observes committed retirement during an in-flight replay while another workspace keeps accepting', async () => {
    const f = await fixture(), other = await fixture(), accepted = await f.submit(), client = await pool.connect()
    let replay: Promise<request.Response> | undefined
    try {
      await client.query('BEGIN')
      await redactCrmOperationsForContact(client,f.workspaceId,accepted.body.contactId)
      await client.query('DELETE FROM entities WHERE id=$1',[accepted.body.contactId])
      replay = f.submit().then((response) => response)
      // Prove the replay actually waits for the retirement transaction.
      let blocked = false
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        blocked = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
          AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'
          AND (query LIKE '%FROM crm_intake_idempotency%' OR query LIKE '%FROM workspaces%')`)).rowCount! > 0
        if (!blocked) await setTimeout(10)
      }
      expect(blocked).toBe(true)
      expect((await other.submit()).status).toBe(201)
      await client.query('COMMIT')
      expect((await replay).body).toEqual(retired)
    } finally { await client.query('ROLLBACK'); client.release(); await replay }
  })

  it('exports safe policy/receipt state, enforces app-role isolation and preserves flush policy classification', async () => {
    const f = await fixture(), other = await fixture(), accepted = await f.submit()
    await f.erase(accepted.body.contactId)
    const exported = await exportCrmOperationsPrivacy(f.context)
    expect(exported.tables.crm_privacy_policies).toHaveLength(1)
    expect(exported.tables.crm_intake_idempotency[0]).toMatchObject({ status: 'retired',contact_id: null,submission_id: null })
    const client = await appPool.connect()
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('app.current_user_id',$1,true)`,[other.userId])
      expect((await client.query('SELECT id FROM crm_privacy_policies WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
      expect((await client.query('SELECT id FROM crm_privacy_policies WHERE workspace_id=$1',[other.workspaceId])).rowCount).toBe(1)
    } finally { await client.query('ROLLBACK'); client.release() }
    expect(WORKSPACE_FLUSH_PRESERVED_TABLES).toContain('crm_privacy_policies')
    expect(WORKSPACE_FLUSH_TABLES.indexOf('crm_intake_idempotency')).toBeLessThan(WORKSPACE_FLUSH_TABLES.indexOf('entities'))
    await pool.query('DELETE FROM workspaces WHERE id=$1',[f.workspaceId])
    expect((await pool.query('SELECT id FROM crm_privacy_policies WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })

  it('refuses contact erasure during admitted retention and safely retries after retention commits', async () => {
    const f = await fixture(), accepted = await f.submit(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      await acquireCrmPrivacyAdmission(client,f.workspaceId)
      await client.query('SELECT id FROM association_enquiries WHERE id=$1 FOR UPDATE',[accepted.body.submissionId])
      await expect(f.erase(accepted.body.contactId)).rejects.toMatchObject({
        code: 'conflict', details: { reason: 'privacy_operation_busy' },
      })
      await retireCrmIntakeReceipts(client,f.workspaceId,{ submissionIds: [accepted.body.submissionId] })
      await client.query('DELETE FROM association_enquiries WHERE id=$1',[accepted.body.submissionId])
      await client.query('COMMIT'); await f.erase(accepted.body.contactId)
      expect((await f.submit()).body).toEqual(retired)
      expect(await counts(f.workspaceId)).toMatchObject({ people: 0,submissions: 0,tasks: 0,receipts: 1 })
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
