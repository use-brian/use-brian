import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmIntegrationGrant, type CrmOperationsContext, type AssociationServicePort } from '@use-brian/core'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createCrmImportSources } from '../crm-import-sources.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmProductionImportService } from '../../crm-operations/import-service.js'
import { crmIntegrationContext, crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const keys = createCrmIntegrationStore(pool, appPool), sources = createCrmImportSources(pool)
const operations = createCrmOperationsService(createDbCrmOperationsStore(pool))
const imports = createCrmProductionImportService({ sources, pool,
  operationsForTransaction: (client) => createCrmOperationsService(createDbCrmOperationsStore(pool, client)) })
const grants: CrmIntegrationGrant[] = [
  { operation: 'crm.imports.write', selectors: { purposeKeys: ['updates'] } },
  { operation: 'crm.records.write', selectors: {} },
  { operation: 'crm.consent.write', selectors: { purposeKeys: ['updates'] } },
]
const reading: CrmIntegrationGrant[] = [
  { operation: 'crm.imports.read', selectors: { purposeKeys: ['updates'] } },
  { operation: 'crm.records.read', selectors: {} },
  { operation: 'crm.consent.read', selectors: { purposeKeys: ['updates'] } },
]
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Import fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  const member: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  await operations.execute(member, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Fixture updates', applicableChannels: ['email'], requiresConsent: true, wording: 'Fixture wording.', wordingVersion: '1' }))
  const issue = async (selected: CrmIntegrationGrant[] = [...grants, ...reading], revokeCredentialId?: string) => {
    const key = await keys.create(workspaceId, userId, { label: 'Fixture importer', expiresAt: '2099-01-01T00:00:00Z', grants: selected, ...(revokeCredentialId ? { revokeCredentialId } : {}) })
    const principal = (await keys.authenticate(key.oneTimeSecret))!
    return { key, principal, context: crmIntegrationContext(principal) }
  }
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service: operations, association: {} as AssociationServicePort, importSources: sources, imports }))
  const post = (path: string, token: string) => request(app).post(`/api/crm/integration/operations/${path}`).set('Authorization', `Bearer ${token}`)
  return { workspaceId, userId, member, issue, app, post }
}
const mapping = { columns: { 0: 'name', 1: 'email', 2: 'consentPurposeKey', 3: 'consentAction', 4: 'consentSource' } }
const csv = 'Name,Email,Purpose,Choice,Source\nFixture Person,fixture@example.com,updates,granted,fixture_import\n'

describe('[COMP:crm/production-import] Actual machine source, job and row authority', () => {
  afterAll(async () => { await Promise.all([pool.end(), appPool.end(), getPool().end()]) })
  it('renews a bound assistant before direct contact-only import effects and permits authorized recovery', async () => {
    const f = await fixture(), assistantId = randomUUID()
    const restore = () => pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional import assistant','primary','internal')", [assistantId, f.workspaceId])
    await restore()
    const selected: CrmIntegrationGrant[] = [
      { operation: 'crm.imports.write', selectors: {} }, { operation: 'crm.records.write', selectors: {} },
    ]
    const key = await keys.create(f.workspaceId, f.userId, { label: 'Fictional bound importer', expiresAt: '2099-01-01T00:00:00Z', grants: selected,
      departmentBinding: { departmentIds: [], cap: 'internal', assistantId } })
    const context = crmIntegrationContext((await keys.authenticate(key.oneTimeSecret))!)
    const staged = await sources.stage(context, randomUUID(), Buffer.from('Name,Email\nFictional imported person,imported@example.com\n'))
    const input = { sourceId: staged.sourceId, entityKind: 'contact' as const, mapping: { columns: { 0: 'name', 1: 'email' } } }
    const preflight = await imports.dryRun(context, input)
    const job = await imports.confirm(context, { ...input, confirmed: true, dryRunHash: preflight.dryRunHash })
    await pool.query('DELETE FROM assistants WHERE id=$1', [assistantId])
    await expect(imports.resume(context, job.id)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    expect((await pool.query('SELECT id FROM crm_import_rows WHERE job_id=$1', [job.id])).rows).toEqual([])
    expect((await pool.query('SELECT id FROM crm_import_chunks WHERE job_id=$1', [job.id])).rows).toEqual([])
    await restore()
    expect(await imports.resume(context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(1)
  })

  it('stages, preflights and resumes after rotation with real commands, preserving machine audit identity and exact receipts', async () => {
    const f = await fixture(), first = await f.issue(), sourceKey = randomUUID()
    const upload = () => f.post('import-sources', first.key.oneTimeSecret).set('Content-Type', 'text/csv').set('Idempotency-Key', sourceKey).send(csv)
    const staged = await upload()
    expect(staged.status).toBe(201)
    expect((await upload()).body).toEqual({ ...staged.body, created: false })
    const input = { sourceId: staged.body.sourceId, entityKind: 'contact' as const, mapping }
    const preflight = await f.post('imports/dry-run', first.key.oneTimeSecret).send(input)
    expect(preflight.status).toBe(200)
    expect(preflight.body).toMatchObject({ validRows: 1, failedRows: 0 })
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    const confirmed = await f.post('imports', first.key.oneTimeSecret).send({ ...input, confirmed: true, dryRunHash: preflight.body.dryRunHash })
    expect(confirmed.status).toBe(201)
    const id = confirmed.body.id
    expect((await pool.query('SELECT created_by_user_id,confirmed_by_user_id FROM crm_import_jobs WHERE id=$1', [id])).rows[0])
      .toEqual({ created_by_user_id: null, confirmed_by_user_id: null })
    const rotated = await f.issue(undefined, first.principal.credentialId)
    expect(await keys.authenticate(first.key.oneTimeSecret)).toBeNull()
    // A rotated key's stored authority is gone: credential_revoked (crm-operations.md).
    await expect(imports.resume(first.context, id)).rejects.toMatchObject({ code: 'credential_revoked' })
    const completed = await f.post(`imports/${id}/resume`, rotated.key.oneTimeSecret).send({})
    expect(completed.status).toBe(200)
    expect(completed.body).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect((await f.post(`imports/${id}/resume`, rotated.key.oneTimeSecret).send({})).body).toEqual(completed.body)
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1 AND valid_to IS NULL', [f.workspaceId])).rowCount).toBe(1)
    expect((await pool.query('SELECT id FROM crm_import_rows WHERE job_id=$1', [id])).rowCount).toBe(1)
    const receipt = (await pool.query('SELECT input_hash,result_refs FROM crm_import_rows WHERE job_id=$1', [id])).rows[0]
    expect(receipt.input_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.result_refs).toEqual([
      { kind: 'contact', id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      { kind: 'consent', id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ])
    const audit = await pool.query(`SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND actor_kind='integration_key'`, [f.workspaceId])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({ actor_credential_id: rotated.principal.credentialId })
    const inspection = await f.issue(reading)
    expect(await imports.get(inspection.context, id)).toMatchObject({ id, status: 'completed' })
    expect((await imports.list(inspection.context)).jobs.map((job) => job.id)).toEqual([id])
    expect(await imports.resultsCsv(inspection.context, id)).toContain(`2,completed,${receipt.input_hash},`)
    const downloaded = await request(f.app).get(`/api/crm/integration/operations/imports/${id}/results.csv`)
      .set('Authorization', `Bearer ${inspection.key.oneTimeSecret}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers['content-disposition']).toContain('crm-import-results.csv')
    expect(downloaded.text).toBe(await imports.resultsCsv(inspection.context, id))
    await expect(imports.resume(inspection.context, id)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(pool.query(`UPDATE crm_import_jobs SET mapping='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow('immutable')
  })
  it('deduplicates an exact confirmation key and rejects reuse for another immutable source', async () => {
    const f = await fixture(), writer = await f.issue(), confirmationKey = randomUUID()
    const firstSource = await sources.stage(writer.context, randomUUID(), Buffer.from(csv))
    const firstInput = { sourceId: firstSource.sourceId, entityKind: 'contact' as const, mapping }
    const checked = await imports.dryRun(writer.context, firstInput)
    const [first, replay] = await Promise.all([
      imports.confirm(writer.context, {
        ...firstInput, confirmed: true, dryRunHash: checked.dryRunHash, confirmationKey,
      }),
      imports.confirm(writer.context, {
        ...firstInput, confirmed: true, dryRunHash: checked.dryRunHash, confirmationKey,
      }),
    ])
    expect(replay).toEqual(first)
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE workspace_id=$1 AND confirmation_key=$2',
      [f.workspaceId, confirmationKey])).rows).toEqual([{ id: first.id }])

    const changedSource = await sources.stage(writer.context, randomUUID(), Buffer.from(csv.replace('Fixture Person', 'Changed Person')))
    const changedInput = { ...firstInput, sourceId: changedSource.sourceId }
    const changed = await imports.dryRun(writer.context, changedInput)
    await expect(imports.confirm(writer.context, {
      ...changedInput, confirmed: true, dryRunHash: changed.dryRunHash, confirmationKey,
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE workspace_id=$1 AND confirmation_key=$2',
      [f.workspaceId, confirmationKey])).rowCount).toBe(1)
  })
  it('denies files, changed authority, unknown trust and out-of-scope rows before any entity side effect', async () => {
    const f = await fixture(), writer = await f.issue()
    await expect(imports.dryRun(writer.context, { stagedFileId: randomUUID(), entityKind: 'contact', mapping })).rejects.toMatchObject({ code: 'not_authorized' })
    const staged = await sources.stage(writer.context, randomUUID(), Buffer.from(csv.replace(',updates,', ',restricted,')))
    const input = { sourceId: staged.sourceId, entityKind: 'contact' as const, mapping }
    await expect(imports.dryRun(writer.context, input)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    // A wider key still cannot widen the authority captured at upload.
    const wide = await f.issue(grants.map((grant) => ({ ...grant, selectors: grant.operation === 'crm.records.write' ? {} : { purposeKeys: 'all' } })))
    await expect(imports.dryRun(wide.context, input)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(imports.dryRun(f.member, input)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(imports.dryRun(writer.context, { ...input, mapping: { ...mapping, trustedIdentitySource: 'fixture' } })).rejects.toThrow('owner or admin')
    const narrow = await f.issue([{ operation: 'crm.imports.write', selectors: { purposeKeys: ['updates'] } }])
    await expect(sources.read(narrow.context, staged.sourceId)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    expect((await f.post('import-sources', writer.key.oneTimeSecret).set('Content-Type', 'application/json').send({})).status).toBe(415)
    expect((await f.post('import-sources', writer.key.oneTimeSecret).set('Content-Type', 'text/csv').send(csv)).status).toBe(400)
  })
  it('filters source ceilings before LIMIT and checks completed jobs and error downloads before revealing contents', async () => {
    const f = await fixture(), writer = await f.issue()
    const staged = await sources.stage(writer.context, randomUUID(), Buffer.from(csv))
    const input = { sourceId: staged.sourceId, entityKind: 'contact' as const, mapping }
    const preflight = await imports.dryRun(writer.context, input)
    const job = await imports.confirm(writer.context, { ...input, confirmed: true, dryRunHash: preflight.dryRunHash })
    // More than one default page of newer jobs belongs to another resource ceiling.
    await pool.query(`INSERT INTO crm_import_jobs (workspace_id,source_id,integration_credential_id,integration_grants,
      entity_kind,status,mapping,mapping_hash,source_hash,total_rows)
      SELECT workspace_id,source_id,integration_credential_id,$2::jsonb,entity_kind,'completed',mapping,mapping_hash,source_hash,total_rows
      FROM crm_import_jobs CROSS JOIN generate_series(1,52) WHERE id=$1`, [job.id, JSON.stringify(grants.map((grant) => ({ ...grant, selectors: grant.operation === 'crm.records.write' ? {} : { purposeKeys: ['restricted'] } })))])
    expect((await imports.list(writer.context)).jobs.map((row) => row.id)).toEqual([job.id])
    const otherJob = (await pool.query(`SELECT id FROM crm_import_jobs WHERE workspace_id=$1 AND id<>$2 LIMIT 1`, [f.workspaceId, job.id])).rows[0].id
    await expect(imports.get(writer.context, otherJob)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(imports.resume(writer.context, otherJob)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(imports.cancel(writer.context, otherJob)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(imports.errorsCsv(writer.context, otherJob)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(imports.resultsCsv(writer.context, otherJob)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const foreign = await fixture(), foreignKey = await foreign.issue()
    expect(await imports.get(foreignKey.context, job.id)).toBeNull()
  })

  it('preserves microsecond historical evidence and cannot replace a later withdrawal or suppression on import or replay', async () => {
    const f = await fixture(), contactId = randomUUID()
    const writer = await f.issue([
      { operation: 'crm.imports.write', selectors: { purposeKeys: 'all' } },
      { operation: 'crm.consent.write', selectors: { purposeKeys: 'all' } },
    ])
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES ($1,$2,'person','Historical fixture','{"email":"history@example.com"}',$3,'manual')`, [contactId, f.workspaceId, f.userId])
    const later = '2026-01-01T00:00:00.123457Z', earlier = '2026-01-01T03:00:00.123456+03:00'
    const withdrawal = await operations.execute(f.member, CrmOperationsCommandSchema.parse({ kind: 'record_consent', contactId,
      purposeKey: 'updates', action: 'withdrawn', source: 'fixture', occurredAt: later }))
    const suppressed = await operations.execute(f.member, CrmOperationsCommandSchema.parse({ kind: 'record_suppression', contactId,
      channel: 'email', action: 'suppressed', reasonCode: 'manual_do_not_contact', source: 'fixture', occurredAt: later }))
    const columns = ['contactId', 'consentPurposeKey', 'consentAction', 'consentSource', 'consentOccurredAt',
      'suppressionChannel', 'suppressionAction', 'suppressionReasonCode', 'suppressionSource', 'suppressionOccurredAt']
    const bytes = Buffer.from([columns.join(','), [contactId, 'updates', 'granted', 'historical_import', earlier,
      'email', 'released', 'manual_do_not_contact', 'historical_import', earlier].join(','), ''].join('\n'))
    const source = await sources.stage(writer.context, randomUUID(), bytes)
    const input = { sourceId: source.sourceId, entityKind: 'operations' as const,
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])) } }
    const checked = await imports.dryRun(writer.context, input)
    expect(checked).toMatchObject({ validRows: 1, failedRows: 0 })
    const job = await imports.confirm(writer.context, { ...input, confirmed: true, dryRunHash: checked.dryRunHash })
    expect(await imports.resume(writer.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    const read = createDbCrmIntakeReadStore()
    expect(await read.checkSendability(f.workspaceId, contactId, 'email', 'updates',f.member.actor)).toMatchObject({
      verdict: 'blocked', reasons: ['channel_suppression', 'consent_withdrawn'],
      effectiveConsentEventId: withdrawal.record.id, effectiveSuppressionEventIds: [suppressed.record.id],
    })
    for (const table of ['association_consent_events', 'crm_suppression_events']) {
      const evidence = await pool.query(`SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        provider_event_id FROM ${table} WHERE workspace_id=$1 AND provider='import'`, [f.workspaceId])
      expect(evidence.rows).toEqual([{ at: '2026-01-01T00:00:00.123456Z', provider_event_id: `${job.id}:2:${table === 'association_consent_events' ? 'consent:updates' : 'suppression:email'}` }])
    }
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
      (SELECT count(*) FROM crm_suppression_events WHERE workspace_id=$1)::int AS suppression,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`, [f.workspaceId])).rows[0]
    const before = await counts()
    expect(await imports.resume(writer.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
    expect(await counts()).toEqual(before)
  })

  it('requires an all-definitions submission grant and source selector for machine historical forms', async () => {
    const f = await fixture(), contactId = randomUUID()
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES ($1,$2,'person','Machine history fixture','{}',$3,'manual')`, [contactId, f.workspaceId, f.userId])
    const columns = ['contactId', 'historicalSubmissionSource', 'historicalSubmissionSite',
      'historicalSubmissionForm', 'historicalSubmissionId', 'historicalSubmissionOccurredAt',
      'historicalSubmissionStatus', 'historicalSubmissionFieldsJson']
    const bytes = Buffer.from([columns.join(','), [contactId, 'wix', 'oasahk_org', 'contact_form',
      'machine-row', '2020-01-01T00:00:00Z', 'resolved', '{}'].join(','), ''].join('\n'))
    const mapping = { columns: Object.fromEntries(columns.map((column, index) => [index, column])) }

    const missingSubmission = await f.issue([{
      operation: 'crm.imports.write', selectors: { providerKeys: ['wix'], definitionIds: 'all' },
    }])
    const missingSource = await sources.stage(missingSubmission.context, randomUUID(), bytes)
    await expect(imports.dryRun(missingSubmission.context, {
      sourceId: missingSource.sourceId, entityKind: 'operations', mapping,
    })).rejects.toMatchObject({ code: 'integration_scope_denied', operation: 'crm.submissions.write' })

    const scoped = await f.issue([
      { operation: 'crm.imports.write', selectors: { providerKeys: ['wix'], definitionIds: 'all' } },
      { operation: 'crm.submissions.write', selectors: {} },
    ])
    const scopedSource = await sources.stage(scoped.context, randomUUID(), bytes)
    await expect(imports.dryRun(scoped.context, {
      sourceId: scopedSource.sourceId, entityKind: 'operations', mapping,
    })).rejects.toMatchObject({ code: 'integration_scope_denied', operation: 'crm.submissions.write', dimension: 'definitionIds' })

    const writer = await f.issue([
      { operation: 'crm.imports.write', selectors: { providerKeys: ['wix'], definitionIds: 'all' } },
      { operation: 'crm.submissions.write', selectors: { definitionIds: 'all' } },
    ])
    const source = await sources.stage(writer.context, randomUUID(), bytes)
    const input = { sourceId: source.sourceId, entityKind: 'operations' as const, mapping }
    const checked = await imports.dryRun(writer.context, input)
    expect(checked).toMatchObject({ validRows: 1, failedRows: 0 })
    const job = await imports.confirm(writer.context, { ...input, confirmed: true, dryRunHash: checked.dryRunHash })
    expect(await imports.resume(writer.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT actor_kind,actor_credential_id FROM association_audit_log
      WHERE workspace_id=$1 AND action='crm.submission.historical_imported'`, [f.workspaceId])).rows)
      .toEqual([{ actor_kind: 'integration_key', actor_credential_id: writer.principal.credentialId }])
    expect((await pool.query(`SELECT count(*)::int AS count FROM crm_domain_event_outbox WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(0)
  })
})
