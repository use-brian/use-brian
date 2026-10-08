import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext, type RecordCrmSubmissionCommand } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { exportCrmOperationsPrivacy } from '../../crm-operations/privacy.js'
import { crmIntakeRoutes } from '../../routes/crm-intake.js'
import { intakeProofFixture } from '../../crm-operations/__tests__/intake-proof-fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const reads = createDbCrmIntakeReadStore(), store = createDbCrmOperationsStore(pool)
const now = new Date('2026-09-08T12:00:00Z')
const service = createCrmOperationsService(store, { now: () => now })
const servers: Server[] = []
async function fixture(identityPolicy: 'trusted_verified_email' | 'external_subject' | 'new_or_review' = 'trusted_verified_email') {
  const workspaceId = randomUUID(), userId = randomUUID(), signer = intakeProofFixture()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Verification fixture',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId,userId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user',userId }, authority: { role: 'owner',canWrite: true,canConfigure: true,trustedIdentitySources: [] } }
  await service.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose',purposeKey: 'updates',label: 'Updates',wordingVersion: '1',wording: 'Fixture wording' }))
  const definition = { identityPolicy, ...(identityPolicy !== 'new_or_review' ? { identityVerification: signer.config } : {}),
    ...(identityPolicy === 'external_subject' ? { allowedIdentityProvider: 'fixture_provider' } : {}), fields: [
      { key: 'name',label: 'Name',type: 'text',required: true,mapping: { kind: 'base_field',field: 'name' } },
      { key: 'email',label: 'Email',type: 'email',required: true,mapping: { kind: 'base_field',field: 'email' } },
      { key: 'agree',label: 'Agree',type: 'boolean',required: true,mapping: { kind: 'submission_only' } },
    ], consentMappings: [{ fieldKey: 'agree',grantedValue: true,purposeKey: 'updates' }], followUpTaskTemplate: { title: 'Review verified submission',priority: 'medium' } }
  const saved = await service.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionKey: 'fixture',label: 'Fixture',definition }))
  const credential = await service.execute(context, { kind: 'create_intake_credential',label: 'Fixture backend',definitionIds: [String(saved.record.id)] })
  const app = express(); app.use('/api',crmIntakeRoutes({ service,readStore: reads }))
  const server = app.listen(0,'127.0.0.1'); servers.push(server); await once(server,'listening')
  const command: RecordCrmSubmissionCommand = { kind: 'record_submission',definitionKey: 'fixture',idempotencyKey: 'stable_fixture_submission',
    fields: { name: 'Verified fixture',email: 'verified@example.com',agree: true },
    ...(identityPolicy === 'external_subject' ? { externalIdentity: { provider: 'fixture_provider',subject: 'verified_subject' } } : {}) }
  const post = (input = command, secret = credential.oneTimeSecret!) => {
    const { kind: _kind,definitionKey,idempotencyKey,...body } = input
    return request(server).post(`/api/crm/intake/${definitionKey}/submissions`).set('Authorization',`Bearer ${secret}`).set('Idempotency-Key',idempotencyKey).send(body)
  }
  const signed = (input = command,at = now.toISOString(),version = 1) => ({ ...input, identityProof: signer.proof(workspaceId,input,at,version) })
  return { workspaceId,userId,context,definition,definitionId: String(saved.record.id),credential,signer,command,post,signed }
}
async function effects(workspaceId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM entities WHERE workspace_id=$1) AS people,
    (SELECT count(*)::int FROM association_enquiries WHERE workspace_id=$1) AS submissions,
    (SELECT count(*)::int FROM crm_intake_idempotency WHERE workspace_id=$1) AS receipts,
    (SELECT count(*)::int FROM association_consent_events WHERE workspace_id=$1) AS consent,
    (SELECT count(*)::int FROM tasks WHERE workspace_id=$1) AS tasks,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1) AS audit,
    (SELECT count(*)::int FROM crm_domain_event_outbox WHERE workspace_id=$1) AS events`,[workspaceId])).rows[0]
}
describe('[COMP:crm/intake-verification] Actual backend identity admission', () => {
  afterAll(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve())))); await pool.end() })

  it('stores explicit owner acknowledgement and refuses missing/forged proof without CRM effects', async () => {
    const f = await fixture(), before = await effects(f.workspaceId)
    const catalog = await reads.listDefinitions(f.workspaceId)
    expect(catalog.definitions[0]).toMatchObject({ identityVerification: f.signer.config, verificationAcknowledgedByUserId: f.userId })
    expect(catalog.definitions[0]?.verificationAcknowledgedAt).toBeTruthy()
    expect((await f.post()).body).toMatchObject({ error: 'not_authorized',reason: 'identity_verification_required' })
    expect((await f.post({ ...f.signed(),identityProof: { ...f.signed().identityProof,signature: 'A'.repeat(86) } })).status).toBe(401)
    expect(await effects(f.workspaceId)).toEqual(before)
    const accepted = await f.post(f.signed())
    expect(accepted.status).toBe(201)
    const committedEffects = await effects(f.workspaceId)
    expect((await f.post(f.signed(f.command,'2000-01-01T00:00:00Z'))).body).toMatchObject({ ...accepted.body,duplicate: true })
    expect(await effects(f.workspaceId)).toEqual(committedEffects)
    const proof = (await pool.query('SELECT identity_verification_evidence FROM association_enquiries WHERE id=$1',[accepted.body.submissionId])).rows[0].identity_verification_evidence
    expect(proof).toMatchObject(f.signed().identityProof)
    expect(proof.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(proof)).not.toContain('verified@example.com')
    const exported = await exportCrmOperationsPrivacy(f.context)
    expect(exported.tables.association_enquiries[0]).toMatchObject({ identity_verification_evidence: proof })
    expect(await reads.getSubmission(f.workspaceId,accepted.body.submissionId,f.context.actor)).toMatchObject({ identityVerificationEvidence: proof })
  })

  it('rechecks the acknowledging member role inside the version transaction', async () => {
    const f = await fixture(),before = await effects(f.workspaceId)
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`,[f.workspaceId,f.userId])
    await expect(service.execute(f.context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionKey: 'fixture',definitionId: f.definitionId,label: 'Changed fixture',expectedVersion: 1,definition: f.definition })))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT current_version FROM crm_intake_definitions WHERE id=$1',[f.definitionId])).rows[0].current_version).toBe(1)
    expect(await effects(f.workspaceId)).toEqual(before)
  })

  it('rejects transplanted, expired and future assertions without modifying an existing contact', async () => {
    const f = await fixture(), other = await fixture()
    await pool.query(`INSERT INTO entities(workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES($1,'person','Original fixture','{"email":"verified@example.com"}',$2,'manual')`,[f.workspaceId,f.userId])
    const before = await effects(f.workspaceId), signed = f.signed()
    const attempts: RecordCrmSubmissionCommand[] = [
      { ...signed,fields: { ...signed.fields,name: 'Tampered fixture' } },
      { ...signed,idempotencyKey: 'different_submission' },
      { ...signed,submittedAt: '2026-09-08T11:30:00Z' },
      f.signed(f.command,'2026-09-08T10:59:59Z'), f.signed(f.command,'2026-09-08T12:00:01Z'),
      f.signed(f.command,now.toISOString(),2),
      { ...f.command,identityProof: f.signer.proof(other.workspaceId,f.command,now.toISOString()) },
    ]
    for (const attempt of attempts) expect((await f.post(attempt)).status).toBe(401)
    expect(await effects(f.workspaceId)).toEqual(before)
    expect((await pool.query('SELECT display_name FROM entities WHERE workspace_id=$1',[f.workspaceId])).rows[0].display_name).toBe('Original fixture')
    const [left,right] = await Promise.all([f.post(signed),f.post(f.signed({ ...f.command,idempotencyKey: 'second_verified_submission' }))])
    expect(left.status).toBe(201); expect(right.status).toBe(201)
    expect(left.body.contactId).toBe(right.body.contactId)
    expect(await effects(f.workspaceId)).toMatchObject({ people: 1,submissions: 2,receipts: 2 })
  })

  it('requires verified external subjects and rejects changing a signed subject', async () => {
    const f = await fixture('external_subject'), before = await effects(f.workspaceId)
    const signed = f.signed()
    expect((await f.post({ ...signed,externalIdentity: { provider: 'fixture_provider',subject: 'unverified_subject' } })).status).toBe(401)
    expect(await effects(f.workspaceId)).toEqual(before)
    const first = await f.post(signed)
    expect(first.status).toBe(201)
    const second = await f.post(f.signed({ ...f.command,idempotencyKey: 'next_verified_submission' }))
    expect(second.body.contactId).toBe(first.body.contactId)
    expect((await pool.query('SELECT provider_subject FROM association_external_identities WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{ provider_subject: 'verified_subject' }])
  })

  it('keeps public claimed-email submissions separate and refuses caller-owned occurrence time', async () => {
    const f = await fixture('new_or_review'), before = await effects(f.workspaceId)
    expect((await f.post({ ...f.command,submittedAt: now.toISOString() })).body).toMatchObject({ error: 'invalid_input',reason: 'occurrence_time_requires_verification' })
    expect(await effects(f.workspaceId)).toEqual(before)
    const first = await f.post(), second = await f.post({ ...f.command,idempotencyKey: 'another_public_submission' })
    expect(first.status).toBe(201); expect(second.status).toBe(201)
    expect(first.body.contactId).not.toBe(second.body.contactId)
    expect((await pool.query('SELECT occurred_at FROM association_consent_events WHERE workspace_id=$1',[f.workspaceId])).rows.map((row) => row.occurred_at.toISOString())).toEqual([now.toISOString(),now.toISOString()])
  })

  it('keeps signed historical consent ordering and refuses future/over-age submitted times', async () => {
    const f = await fixture(), before = await effects(f.workspaceId)
    for (const submittedAt of ['2026-09-08T10:59:59Z','2026-09-08T12:00:01Z']) {
      expect((await f.post(f.signed({ ...f.command,submittedAt }))).body).toMatchObject({ reason: 'occurrence_time_out_of_window' })
    }
    expect(await effects(f.workspaceId)).toEqual(before)
    const submittedAt = '2026-09-08T11:30:00Z'
    expect((await f.post(f.signed({ ...f.command,submittedAt }))).status).toBe(201)
    expect((await pool.query('SELECT occurred_at FROM association_consent_events WHERE workspace_id=$1',[f.workspaceId])).rows[0].occurred_at.toISOString()).toBe('2026-09-08T11:30:00.000Z')
  })

  it('replays committed results after verification-key changes and legacy configuration loss while new writes fail closed', async () => {
    const f = await fixture(), accepted = await f.post(f.signed())
    expect(accepted.status).toBe(201)
    const nextSigner = intakeProofFixture()
    await service.execute(f.context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionId: f.definitionId,definitionKey: 'fixture',label: 'Reconfigured fixture',expectedVersion: 1,
      definition: { ...f.definition,identityVerification: nextSigner.config } }))
    expect((await f.post()).body).toMatchObject({ ...accepted.body,duplicate: true })
    const newInput = { ...f.command,idempotencyKey: 'after_key_rotation' }
    expect((await f.post(f.signed(newInput))).status).toBe(401)
    expect((await f.post({ ...newInput,identityProof: nextSigner.proof(f.workspaceId,newInput,now.toISOString(),2) })).status).toBe(201)
    // Model a persisted pre-verification version, without rewriting its data or receipts.
    await pool.query(`UPDATE crm_intake_definition_versions SET schema_snapshot=schema_snapshot-'identityVerification' WHERE workspace_id=$1`,[f.workspaceId])
    const before = await effects(f.workspaceId)
    expect((await f.post(f.signed({ ...f.command,idempotencyKey: 'legacy_new_submission' }))).body).toMatchObject({ error: 'conflict',reason: 'identity_verification_unconfigured' })
    expect((await f.post()).body).toMatchObject({ ...accepted.body,duplicate: true })
    expect(await effects(f.workspaceId)).toEqual(before)
  })
})
