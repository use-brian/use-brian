import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { flushWorkspaceData } from '../workspace-flush.js'
import { getPool, getAppPool } from '../client.js'
import { createCrmImportSources, type CrmImportSources } from '../crm-import-sources.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { crmIntegrationContext } from '../../routes/crm-integration.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmProductionImportService } from '../../crm-operations/import-service.js'
import { createCrmPrivacyService } from '../../crm-operations/privacy-previews.js'
import { readCrmPrivacyPolicy } from '../../crm-operations/privacy-policy.js'
import { pruneCrmOperationsRetention } from '../../crm-operations/privacy.js'
import { acquireCrmPrivacyAdmission } from '../../crm-operations/privacy-admission.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), app = getAppPool(), sources = createCrmImportSources(pool), privacy = createCrmPrivacyService()
const keys = createCrmIntegrationStore(pool, app), operations = createCrmOperationsService(createDbCrmOperationsStore(pool))
const workspaces: string[] = [], users: string[] = []
const importer = (sourcePort: CrmImportSources = sources) => createCrmProductionImportService({ pool, sources: sourcePort,
  operationsForTransaction: client => createCrmOperationsService(createDbCrmOperationsStore(pool, client)) })
async function fixture(count = 1, mixed = false) {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID(), sourceKey = randomUUID()
  workspaces.push(workspaceId); users.push(userId)
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Import erasure fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$2,'person','Source fixture','subject@example.com',$3,'manual')`, [contactId, workspaceId, userId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  await operations.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Fixture updates', wording: 'Fixture wording', wordingVersion: '1' }))
  const otherContact = randomUUID()
  if (mixed) await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Other fixture',$3,'manual')", [otherContact, workspaceId, userId])
  const key = await keys.create(workspaceId, userId, { label: 'Import fixture', expiresAt: '2099-01-01T00:00:00Z', grants: [
    { operation: 'crm.imports.write', selectors: { purposeKeys: ['updates'] } }, { operation: 'crm.imports.read', selectors: { purposeKeys: ['updates'] } },
    { operation: 'crm.consent.write', selectors: { purposeKeys: ['updates'] } }, { operation: 'crm.consent.read', selectors: { purposeKeys: ['updates'] } },
    { operation: 'crm.records.write', selectors: {} }, { operation: 'crm.records.read', selectors: {} },
  ] })
  const machine = crmIntegrationContext((await keys.authenticate(key.oneTimeSecret))!)
  const bytes = Buffer.from('Contact,Purpose,Action,Source,Notes\n' + Array.from({ length: count }, (_, i) => `${mixed && i ? otherContact : contactId},updates,granted,fixture_import,subject@example.com\n`).join(''))
  const source = await sources.stage(machine, sourceKey, bytes)
  const input = { sourceId: source.sourceId, entityKind: 'operations' as const, mapping: { columns: { '0': 'contactId', '1': 'consentPurposeKey', '2': 'consentAction', '3': 'consentSource' } } }
  const checked = await importer().dryRun(machine, input)
  expect(checked.failedRows).toBe(0)
  const job = await importer().confirm(machine, { ...input, confirmed: true, dryRunHash: checked.dryRunHash })
  const approve = async (heldSourceIds: string[] = [], receiptRetentionSeconds = 3600) => operations.execute(context, CrmOperationsCommandSchema.parse({
    kind: 'save_privacy_policy', expectedVersion: (await readCrmPrivacyPolicy(workspaceId)).version,
    confirmed: true, intakeReplay: null, importSourceErasure: { receiptRetentionSeconds, heldSourceIds },
  }))
  const preview = () => privacy.preview(context, { kind: 'preview_contact_erasure', contactId })
  const erase = async () => { const p = await preview(); expect(p.blockers).toEqual([])
    return privacy.erase(context, { kind: 'erase_contact_with_preview', contactId, previewId: p.id, previewHash: p.previewHash, confirmed: true }) }
  const finish = async () => { let current = await importer().resume(machine, job.id); while (current.status === 'paused') current = await importer().resume(machine, job.id); expect(current).toMatchObject({ status: 'completed', succeededRows: count, failedRows: 0 }); expect((await pool.query('SELECT entity_id FROM crm_import_rows WHERE job_id=$1 ORDER BY row_number LIMIT 1', [job.id])).rows[0]?.entity_id).toBe(contactId) }
  return { workspaceId, userId, contactId, sourceKey, sourceId: source.sourceId, context, machine, bytes, job, input, checked, approve, preview, erase, finish }
}
const cloneJob = `INSERT INTO crm_import_jobs(workspace_id,source_id,integration_credential_id,integration_grants,entity_kind,status,mapping,mapping_hash,source_hash,total_rows)
  SELECT workspace_id,source_id,integration_credential_id,integration_grants,entity_kind,'ready',mapping,mapping_hash,source_hash,total_rows FROM crm_import_jobs WHERE id=$1 RETURNING id`

describe('[COMP:crm/privacy-copies] Real CRM source erasure and consumer admission', () => {
  afterEach(async () => { _resetCoalescerForTests(); await pool.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaces.splice(0)]); await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users.splice(0)]) })
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await app.end() })
  it('requires explicit policy and retires sole-subject bytes, mappings and child copies atomically', async () => {
    const f = await fixture(); await f.finish()
    expect((await f.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_erasure_policy_unconfigured', count: 1 })
    await f.approve(); await f.erase()
    const row = (await pool.query('SELECT content_bytes,source_hash,integration_grants,privacy_erased,retired_at,replay_expires_at,replay_policy_version FROM crm_import_sources WHERE id=$1', [f.sourceId])).rows[0]
    expect(row).toMatchObject({ content_bytes: Buffer.alloc(0), source_hash: '0'.repeat(64), integration_grants: [], privacy_erased: true, replay_policy_version: 1 })
    expect(row.retired_at).toBeInstanceOf(Date); expect(row.replay_expires_at.getTime() - row.retired_at.getTime()).toBe(3600000)
    expect(await importer().resume(f.machine, f.job.id)).toMatchObject({ status: 'completed', privacyErased: true, mapping: { columns: {} } })
    expect((await importer().list(f.machine)).jobs).toEqual([expect.objectContaining({ id: f.job.id, privacyErased: true })])
    expect(await importer().get(f.context, f.job.id)).toMatchObject({ privacyErased: true })
    for (const table of ['crm_import_rows', 'crm_import_chunks', 'crm_import_errors']) expect((await pool.query(`SELECT id FROM ${table} WHERE job_id=$1`, [f.job.id])).rowCount).toBe(0)
    for (const operation of [() => sources.read(f.machine, f.sourceId), () => sources.stage(f.machine, f.sourceKey, f.bytes), () => sources.stage(f.machine, f.sourceKey, Buffer.from('Name\nOther\n'))]) {
      await expect(operation()).rejects.toMatchObject({ code: 'conflict', details: { reason: 'import_source_retired' } })
    }
    expect((await pool.query('SELECT id FROM entities WHERE id=$1', [f.contactId])).rowCount).toBe(0)
  })
  it('uses current holds, preserves omitted policy fields and rejects foreign holds and machine approval', async () => {
    const f = await fixture(), other = await fixture(); await f.finish(); await f.approve([f.sourceId])
    expect((await f.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_retention_hold', count: 1 })
    await operations.execute(f.context, { kind: 'save_privacy_policy', expectedVersion: 1, confirmed: true, intakeReplay: null })
    expect((await readCrmPrivacyPolicy(f.workspaceId)).version).toBe(1)
    await expect(f.approve([other.sourceId])).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(operations.execute(f.machine, { kind: 'save_privacy_policy', expectedVersion: 1, confirmed: true, intakeReplay: null })).rejects.toMatchObject({ code: 'not_authorized' })
    await f.approve(); const preview = await f.preview(); await f.approve([f.sourceId])
    await expect(privacy.erase(f.context, { kind: 'erase_contact_with_preview', contactId: f.contactId, previewId: preview.id, previewHash: preview.previewHash, confirmed: true })).rejects.toMatchObject({ details: { reason: 'privacy_preview_stale' } })
    expect((await sources.read(f.machine, f.sourceId)).bytes).toEqual(f.bytes)
  })
  it('refuses mixed subjects, incomplete receipts, unknown legacy lineage and extra source consumers', async () => {
    const mixed = await fixture(2, true); await mixed.finish(); await mixed.approve()
    expect((await mixed.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'shared_or_unattributed_import_source', count: 1 })
    const f = await fixture(); await f.finish(); await f.approve()
    await pool.query(cloneJob, [f.job.id])
    expect((await f.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_execution_dependency', count: 1 })
    const member = await app.connect()
    try { await member.query('BEGIN'); await member.query("SELECT set_config('app.current_user_id',$1,true)", [f.userId])
      expect((await member.query("DELETE FROM crm_import_jobs WHERE workspace_id=$1 AND status='ready'", [f.workspaceId])).rowCount).toBe(1)
      await member.query('COMMIT')
    } finally { await member.query('ROLLBACK'); member.release() }
    expect((await f.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_legacy_lineage_dependency', count: 1 })
    await pool.query('DELETE FROM crm_import_chunks WHERE job_id=$1', [f.job.id])
    expect((await f.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_receipt_dependency', count: 1 })
    await expect(pool.query('UPDATE crm_import_sources SET privacy_lineage_version=1 WHERE id=$1', [f.sourceId])).rejects.toMatchObject({ code: '55000' })
  })
  it('invalidates a reviewed source when a new unattributed consumer appears', async () => {
    const f = await fixture(); await f.finish(); await f.approve(); const p = await f.preview()
    await pool.query(cloneJob, [f.job.id])
    await expect(privacy.erase(f.context, { kind: 'erase_contact_with_preview', contactId: f.contactId, previewId: p.id, previewHash: p.previewHash, confirmed: true })).rejects.toMatchObject({ details: { reason: 'privacy_preview_stale' } })
  })
  it('discards a held parsed CSV after another worker completes and erasure retires the job', async () => {
    const f = await fixture(51); await f.approve()
    expect(await importer().resume(f.machine, f.job.id)).toMatchObject({ status: 'paused', succeededRows: 50 })
    expect((await f.preview()).blockers.some(b => b.reason === 'import_source_execution_dependency')).toBe(true)
    let enter!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const held = importer({ ...sources, read: async (...args) => { const result = await sources.read(...args); enter(); await gate; return result } }).resume(f.machine, f.job.id)
    try { await Promise.race([ready, held.then(() => { throw new Error('Reader ended before barrier') })]); await f.finish(); await f.erase() }
    finally { release(); await Promise.allSettled([held]) }
    expect(await held).toMatchObject({ privacyErased: true, status: 'completed', succeededRows: 51 })
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM crm_import_rows WHERE job_id=$1', [f.job.id])).rowCount).toBe(0)
  })
  it('finds byte-identical staged copies even before they have a row receipt', async () => {
    const f = await fixture(); await f.finish(); await f.approve(); const p = await f.preview()
    const duplicate = await sources.stage(f.machine, randomUUID(), f.bytes)
    const next = await f.preview()
    expect(next.domains.find(d => d.domain === 'crm_import_sources')).toMatchObject({ count: 2 })
    expect(next.blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_unprocessed_copy_dependency', count: 1 })
    await expect(privacy.erase(f.context, { kind: 'erase_contact_with_preview', contactId: f.contactId, previewId: p.id, previewHash: p.previewHash, confirmed: true })).rejects.toMatchObject({ details: { reason: 'privacy_preview_stale' } })
    expect((await sources.read(f.machine, duplicate.sourceId)).bytes).toEqual(f.bytes)
  })
  it('returns a typed retired-source conflict when confirmation held bytes before erasure', async () => {
    const f = await fixture(); await f.finish(); await f.approve()
    let reads = 0, enter!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const held = importer({ ...sources, read: async (...args) => { const result = await sources.read(...args); if (++reads === 2) { enter(); await gate }; return result } })
      .confirm(f.machine, { ...f.input, confirmed: true, dryRunHash: f.checked.dryRunHash })
    try { await Promise.race([ready, held.then(() => { throw new Error('Confirmation ended before barrier') })]); await f.erase() }
    finally { release(); await Promise.allSettled([held]) }
    await expect(held).rejects.toMatchObject({ code: 'conflict', details: { reason: 'import_source_retired' } })
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ id: f.job.id }])
  })
  it('rejects late source consumers and child writers, including repeatable-read snapshots', async () => {
    const f = await fixture(); await f.finish(); await f.approve(); const client = await pool.connect(), childClient = await pool.connect()
    try { await childClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await childClient.query('SELECT id FROM crm_import_jobs WHERE id=$1', [f.job.id]); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await client.query('SELECT id FROM crm_import_sources WHERE id=$1', [f.sourceId]); await f.erase()
      await expect(client.query(cloneJob, [f.job.id])).rejects.toMatchObject({ code: '40001' })
      await expect(childClient.query("INSERT INTO crm_import_rows(workspace_id,job_id,row_number,input_hash,status) VALUES($1,$2,2,repeat('a',64),'completed')", [f.workspaceId, f.job.id])).rejects.toMatchObject({ code: '40001' })
    } finally { await client.query('ROLLBACK'); client.release(); await childClient.query('ROLLBACK'); childClient.release() }
    await expect(pool.query(cloneJob, [f.job.id])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query("INSERT INTO crm_import_rows(workspace_id,job_id,row_number,input_hash,status) VALUES($1,$2,2,repeat('a',64),'completed')", [f.workspaceId, f.job.id])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query("INSERT INTO crm_import_chunks(workspace_id,job_id,chunk_index,input_hash) VALUES($1,$2,0,repeat('a',64))", [f.workspaceId, f.job.id])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query("INSERT INTO crm_import_errors(workspace_id,job_id,row_number,error_code,message) VALUES($1,$2,2,'late','Late source content')", [f.workspaceId, f.job.id])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query("UPDATE crm_import_jobs SET status='running' WHERE id=$1", [f.job.id])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query("UPDATE crm_import_sources SET content_bytes='x'::bytea WHERE id=$1", [f.sourceId])).rejects.toMatchObject({ code: '55000' })
  })
  it('takes privacy admission and enforces actual app-role workspace isolation', async () => {
    const f = await fixture(), other = await fixture(), client = await pool.connect(), member = await app.connect()
    try { await client.query('BEGIN'); await acquireCrmPrivacyAdmission(client, f.workspaceId)
      await expect(pool.query(cloneJob, [f.job.id])).rejects.toMatchObject({ code: '55P03' })
      await member.query('BEGIN'); await member.query("SELECT set_config('app.current_user_id',$1,true)", [other.userId])
      expect((await member.query('SELECT id FROM crm_import_sources WHERE id=$1', [f.sourceId])).rowCount).toBe(0)
      await expect(member.query(`INSERT INTO crm_import_jobs(workspace_id,source_id,integration_credential_id,integration_grants,entity_kind,status,mapping,mapping_hash,source_hash,total_rows)
        SELECT workspace_id,$2,integration_credential_id,integration_grants,entity_kind,'ready',mapping,mapping_hash,source_hash,total_rows FROM crm_import_jobs WHERE id=$1`, [other.job.id, f.sourceId])).rejects.toMatchObject({ code: '55000' })
    } finally { await member.query('ROLLBACK'); member.release(); await client.query('ROLLBACK'); client.release() }
  })
  it('rolls source and receipt changes back if the canonical parent delete fails', async () => {
    const f = await fixture(); await f.finish(); await f.approve(); const p = await f.preview()
    const name = `crm_source_fixture_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${f.contactId}'::uuid THEN RAISE EXCEPTION 'fixture refusal'; END IF; RETURN OLD; END; $$;
      CREATE TRIGGER ${name} BEFORE DELETE ON entities FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try { await expect(privacy.erase(f.context, { kind: 'erase_contact_with_preview', contactId: f.contactId, previewId: p.id, previewHash: p.previewHash, confirmed: true })).rejects.toMatchObject({ details: { reason: 'privacy_review_failed' } }) }
    finally { await pool.query(`DROP TRIGGER ${name} ON entities; DROP FUNCTION ${name}()`) }
    expect((await sources.read(f.machine, f.sourceId)).bytes).toEqual(f.bytes)
    expect((await pool.query('SELECT id FROM crm_import_rows WHERE job_id=$1', [f.job.id])).rowCount).toBe(1)
    expect(await importer().get(f.context, f.job.id)).toMatchObject({ privacyErased: false, mapping: f.input.mapping })
  })
  it('retires every completed consumer of one source', async () => {
    const f = await fixture(); await f.finish(); await f.approve()
    const another = await importer().confirm(f.machine, { ...f.input, confirmed: true, dryRunHash: f.checked.dryRunHash })
    expect(await importer().resume(f.machine, another.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
    expect((await f.preview()).domains.find(d => d.domain === 'crm_import_jobs')).toMatchObject({ count: 2, action: 'retire' })
    await f.erase()
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE workspace_id=$1 AND privacy_erased', [f.workspaceId])).rowCount).toBe(2)
  })
  it('preserves live source history during housekeeping and blocks erasure after attribution is lost', async () => {
    const f = await fixture(); await f.finish(); await f.approve()
    await pruneCrmOperationsRetention(f.context, new Date('2099-01-01'))
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE id=$1', [f.job.id])).rowCount).toBe(1)
    const member = await app.connect()
    try { await member.query('BEGIN'); await member.query("SELECT set_config('app.current_user_id',$1,true)", [f.userId])
      await member.query('DELETE FROM crm_import_rows WHERE job_id=$1', [f.job.id]); await member.query('COMMIT')
    } finally { await member.query('ROLLBACK'); member.release() }
    expect((await f.preview()).blockers).toContainEqual({ domain: 'crm_import_sources', reason: 'import_source_legacy_lineage_dependency', count: 1 })
    expect((await sources.read(f.machine, f.sourceId)).bytes).toEqual(f.bytes)
  })
  it('holds jobs during retention and deletes expired source receipts only after hold release', async () => {
    const f = await fixture(); await f.finish(); await f.approve([f.sourceId])
    await pruneCrmOperationsRetention(f.context, new Date('2099-01-01'))
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE id=$1', [f.job.id])).rowCount).toBe(1)
    await f.approve(); await f.erase()
    const expired = randomUUID(), replayKey = randomUUID()
    await pool.query(`INSERT INTO crm_import_sources(id,workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants,privacy_erased,retired_at,replay_expires_at,replay_policy_version)
      SELECT $2,workspace_id,$3,content_bytes,source_hash,credential_id,integration_grants,true,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second',replay_policy_version
      FROM crm_import_sources WHERE id=$1`, [f.sourceId, expired, replayKey])
    await f.approve([expired]); await pruneCrmOperationsRetention(f.context, new Date('2099-01-01'))
    expect((await pool.query('SELECT id FROM crm_import_sources WHERE id=$1', [expired])).rowCount).toBe(1)
    await f.approve(); await pruneCrmOperationsRetention(f.context, new Date('2099-01-01'))
    expect((await pool.query('SELECT id FROM crm_import_sources WHERE id=$1', [expired])).rowCount).toBe(0)
    expect(await sources.stage(f.machine, replayKey, f.bytes)).toMatchObject({ created: true })
  })
  it('backfills historical sources as unknown lineage and defaults only new sources to complete lineage', async () => {
    const f = await fixture(), client = await pool.connect(), fresh = randomUUID()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE TEMP TABLE crm_privacy_policies(workspace_id uuid,version integer,UNIQUE(workspace_id,version));
        CREATE TEMP TABLE crm_import_sources AS SELECT id,workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants,created_at FROM public.crm_import_sources WITH NO DATA;
        ALTER TABLE crm_import_sources ADD CONSTRAINT crm_import_sources_content_bytes_check CHECK(octet_length(content_bytes) BETWEEN 1 AND 31457280)`)
      await client.query('INSERT INTO pg_temp.crm_import_sources SELECT id,workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants,created_at FROM public.crm_import_sources WHERE id=$1', [f.sourceId])
      const migration = await readFile(new URL('../../../migrations/514_crm_import_copy_retirement.sql', import.meta.url), 'utf8')
      await client.query(migration.slice(migration.indexOf('ALTER TABLE crm_import_sources'), migration.indexOf('ALTER TABLE crm_import_jobs')))
      await client.query('INSERT INTO crm_import_sources(id,workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants,created_at) SELECT $2,workspace_id,$2,content_bytes,source_hash,credential_id,integration_grants,created_at FROM crm_import_sources WHERE id=$1', [f.sourceId, fresh])
      expect((await client.query('SELECT privacy_lineage_version FROM crm_import_sources WHERE id=$1', [f.sourceId])).rows[0].privacy_lineage_version).toBe(0)
      expect((await client.query('SELECT privacy_lineage_version FROM crm_import_sources WHERE id=$1', [fresh])).rows[0].privacy_lineage_version).toBe(1)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('flushes retired source receipts while preserving approved workspace policy', async () => {
    const f = await fixture(); await f.finish(); await f.approve(); await f.erase()
    await flushWorkspaceData(f.userId, f.workspaceId)
    for (const table of ['crm_import_sources', 'crm_import_jobs']) {
      expect((await pool.query(`SELECT id FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rowCount).toBe(0)
    }
    expect((await readCrmPrivacyPolicy(f.workspaceId)).policy.importSourceErasure).toEqual({ receiptRetentionSeconds: 3600, heldSourceIds: [] })
  })
  it('refuses invoking the privileged lineage marker through a shadow relation', async () => {
    const client = await app.connect()
    try { await client.query('BEGIN')
      await client.query(`CREATE TEMP TABLE crm_import_jobs(workspace_id uuid,source_id uuid);
        CREATE TRIGGER copied_hook BEFORE DELETE ON crm_import_jobs FOR EACH ROW EXECUTE FUNCTION public.crm_import_record_consumer_loss()`)
      await client.query('INSERT INTO crm_import_jobs VALUES($1,$2)', [randomUUID(), randomUUID()])
      await expect(client.query('DELETE FROM crm_import_jobs')).rejects.toMatchObject({ code: '55000', message: 'CRM import lineage hook requires canonical relation' })
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('validates bounded source policy shape in the real database and command schema', async () => {
    const invalid = [{ receiptRetentionSeconds: 0, heldSourceIds: [] }, { receiptRetentionSeconds: 1.5, heldSourceIds: [] },
      { receiptRetentionSeconds: 60, heldSourceIds: ['bad'] }, { receiptRetentionSeconds: 60, heldSourceIds: Array.from({ length: 251 }, () => randomUUID()) },
      { receiptRetentionSeconds: 60, heldSourceIds: [], unexpected: true }]
    for (const policy of invalid) {
      expect((await pool.query('SELECT public.crm_import_source_policy_valid($1::jsonb) valid', [JSON.stringify(policy)])).rows[0].valid).toBe(false)
      expect(CrmOperationsCommandSchema.safeParse({ kind: 'save_privacy_policy', expectedVersion: 0, confirmed: true, intakeReplay: null, importSourceErasure: policy }).success).toBe(false)
    }
  })
  it('keeps the source replay receipt beyond job housekeeping until its explicit expiry', async () => {
    const f = await fixture(); await f.finish(); await f.approve(); await f.erase()
    await pruneCrmOperationsRetention(f.context, new Date('2099-01-01'))
    expect((await pool.query('SELECT id FROM crm_import_jobs WHERE id=$1', [f.job.id])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM crm_import_sources WHERE id=$1', [f.sourceId])).rowCount).toBe(1)
    await expect(sources.stage(f.machine, f.sourceKey, f.bytes)).rejects.toMatchObject({ details: { reason: 'import_source_retired' } })
  })
})
