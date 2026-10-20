import { createHmac, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsCommand, type CrmOperationsContext, type FilesApi, type EntityLinksStore, type CrmIntegrationGrant } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmProductionImportService, type CrmImportEntityKind } from '../../crm-operations/import-service.js'
import { applyRLSGucs, getAppPool, getPool } from '../client.js'
import { createAssociationService } from '../../association/service.js'
import { createAssociationStore } from '../association-store.js'
import { EventInputSchema, PlanInputSchema, TicketInputSchema } from '../../association/domain.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createCrmImportSources } from '../crm-import-sources.js'
import { crmIntegrationContext } from '../../routes/crm-integration.js'
import { acquireCrmPrivacyAdmission } from '../../crm-operations/privacy-admission.js'
import { getCrmConfig } from '../crm-r2.js'
import { lockAssociationInventory, refreshAssociationInventory } from '../../association/inventory.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: 'crm_atomic_import_fixture' })
const files = new Map<string, Buffer>()
const promotionHmacKey = 'fictional-promotion-key-for-tests-only'
const filesApi = { readBytes: async (_ctx: unknown, id: string) => ({ ok: true, value: { file: { id }, bytes: files.get(id)! } }) } as unknown as FilesApi
const operations = createCrmOperationsService(createDbCrmOperationsStore(pool))
type Hook = (client: pg.PoolClient, command: CrmOperationsCommand) => Promise<void>
function importer(hook?: Hook, entityLinks?: EntityLinksStore) {
  return createCrmProductionImportService({ pool, filesApi, entityLinks, associationForTransaction: (client) => {
    const crmService = createCrmOperationsService(createDbCrmOperationsStore(pool, client))
    return createAssociationService({ store: createAssociationStore(pool, client, { promotionHmacKey }), crmService })
  }, operationsForTransaction: (client) => {
    const service = createCrmOperationsService(createDbCrmOperationsStore(pool, client))
    return {
      importHistoricalSubmission: service.importHistoricalSubmission,
      execute: async (context, command) => {
        const result = await service.execute(context, command)
        await hook?.(client, command)
        return result
      },
    }
  } })
}
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Atomic import fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`UPDATE workspace_modules SET state='enabled',enabled_at=clock_timestamp(),disabled_at=NULL
    WHERE workspace_id=$1 AND module_key='association'`, [workspaceId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  await operations.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Fixture updates', wording: 'Fixture wording', wordingVersion: '1' }))
  async function entity(kind: string, name: string, attributes = {}) {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES ($1,$2,$3,$4,$5,$6,'manual')`, [id, workspaceId, kind, name, attributes, userId])
    return id
  }
  async function job(columns: string[], rows: string[][], kind: CrmImportEntityKind = 'contact', trustedIdentitySource?: string) {
    const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
    const id = randomUUID(), bytes = Buffer.from([columns.join(','), ...rows.map((row) => row.map(csvCell).join(',')), ''].join('\n'))
    files.set(id, bytes)
    await pool.query(`INSERT INTO workspace_files (id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES ($1,$2,$3,'fixture.csv','fixture://local',$4)`, [id, workspaceId, `/fixture/${id}.csv`, userId])
    const input = { stagedFileId: id, entityKind: kind,
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])), ...(trustedIdentitySource ? { trustedIdentitySource } : {}) } }
    const service = importer(), checked = await service.dryRun(context, input)
    expect(checked.failedRows).toBe(0)
    return service.confirm(context, { ...input, confirmed: true, dryRunHash: checked.dryRunHash })
  }
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*) FROM entities WHERE workspace_id=$1)::int AS entities,
      (SELECT count(*) FROM crm_identity_bindings WHERE workspace_id=$1)::int AS bindings,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
      (SELECT count(*) FROM crm_import_rows WHERE workspace_id=$1)::int AS receipts,
      (SELECT count(*) FROM crm_import_chunks WHERE workspace_id=$1)::int AS chunks,
      (SELECT count(*) FROM crm_import_errors WHERE workspace_id=$1)::int AS errors,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`, [workspaceId])).rows[0]
  }
  return { workspaceId, userId, context, entity, job, counts }
}
const consentColumns = ['name', 'email', 'consentPurposeKey', 'consentAction', 'consentSource']
const row = (index: number) => [`Fixture ${index}`, `fixture${index}@example.com`, 'updates', 'granted', 'fixture_import']

async function importMember(f: Awaited<ReturnType<typeof fixture>>, role: 'member' | 'admin' = 'member') {
  const userId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[f.workspaceId,userId,role])
  const context:CrmOperationsContext={workspaceId:f.workspaceId,actor:{kind:'user',userId},
    authority:{role,canWrite:true,canConfigure:role==='admin',trustedIdentitySources:[]}}
  return {userId,context}
}
async function assertImportTransactionActor(client:pg.PoolClient,userId:string) {
  const row=(await client.query<{actor:string;bypass:boolean}>(`SELECT current_setting('app.current_user_id',true) AS actor,
    r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='entities'::regclass WHERE r.rolname=session_user`)).rows[0]
  expect(row).toEqual({actor:userId,bypass:false})
}
async function importBusinessRows(workspaceId:string) {
  return (await pool.query('SELECT id,kind,display_name,attributes,created_by_user_id,scope_version FROM entities WHERE workspace_id=$1 ORDER BY id',[workspaceId])).rows
}
async function withImportPredicatePolicy(workspaceId:string,type:'company'|'person',field:'externalRef'|'email',run:()=>Promise<void>) {
  await pool.query(`CREATE FUNCTION atomic_import_rules(t text) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='${field}' THEN '[["finance"]]'::jsonb ELSE '[]'::jsonb END,
      'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(public.application_native_field_keys(t)) key $$;
    REVOKE ALL ON FUNCTION atomic_import_rules(text) FROM PUBLIC;
    CREATE FUNCTION atomic_import_record(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    DECLARE source jsonb;BEGIN IF t NOT IN('company','person') OR NOT EXISTS(SELECT 1 FROM public.entities WHERE workspace_id=w AND id=i::uuid AND kind=t) THEN RETURN NULL;END IF;
     source:=public.read_scope_source(w,'entity',i::uuid);RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
      'recordVersion',source->>'version','fieldKeys',public.application_native_field_keys(t),'fields',public.atomic_import_rules(t),'source',source);END $$;
    REVOKE ALL ON FUNCTION atomic_import_record(uuid,jsonb,text,text) FROM PUBLIC;
    CREATE FUNCTION atomic_import_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
     SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1','fieldKeys',public.application_native_field_keys(t),
      'fields',public.atomic_import_rules(t),'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
    REVOKE ALL ON FUNCTION atomic_import_catalog(uuid,jsonb,text) FROM PUBLIC`)
  try {
    await pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader) VALUES('native','1',ARRAY['finance'],
      'atomic_import_record(uuid,jsonb,text,text)'::regprocedure,'atomic_import_catalog(uuid,jsonb,text)'::regprocedure)`)
    await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}',$2,'native')`,[workspaceId,type])
    await run()
  } finally {
    await pool.query('DELETE FROM application_native_role_assignments WHERE workspace_id=$1',[workspaceId])
    await pool.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1',[workspaceId])
    await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
    await pool.query('DROP FUNCTION atomic_import_record(uuid,jsonb,text,text);DROP FUNCTION atomic_import_catalog(uuid,jsonb,text);DROP FUNCTION atomic_import_rules(text)')
  }
}
const atomicImportGrants:CrmIntegrationGrant[]=[
  {operation:'crm.imports.write',selectors:{purposeKeys:['updates']}},
  {operation:'crm.records.write',selectors:{}},
  {operation:'crm.consent.write',selectors:{purposeKeys:['updates']}},
  {operation:'crm.imports.read',selectors:{purposeKeys:['updates']}},
  {operation:'crm.records.read',selectors:{}},
  {operation:'crm.consent.read',selectors:{purposeKeys:['updates']}},
]
async function importKey(f:Awaited<ReturnType<typeof fixture>>,issuerId:string,departmentBinding?:{departmentIds:string[];cap:'internal';assistantId:string}) {
  const keys=createCrmIntegrationStore(pool,getAppPool())
  const key=await keys.create(f.workspaceId,issuerId,{label:'Fictional atomic importer',expiresAt:'2099-01-01T00:00:00Z',grants:atomicImportGrants,...(departmentBinding?{departmentBinding}:{})})
  const principal=(await keys.authenticate(key.oneTimeSecret))!
  expect(principal).toBeDefined()
  return {credentialId:principal.credentialId,context:crmIntegrationContext(principal),principal}
}
async function machineImportJob(context:CrmOperationsContext) {
  const source=await createCrmImportSources(pool).stage(context,randomUUID(),Buffer.from([consentColumns.join(','),row(0).join(','),''].join('\n')))
  const input={sourceId:source.sourceId,entityKind:'contact' as const,mapping:{columns:Object.fromEntries(consentColumns.map((name,index)=>[index,name]))}}
  const service=importer(),checked=await service.dryRun(context,input)
  expect(checked.failedRows).toBe(0)
  return service.confirm(context,{...input,confirmed:true,dryRunHash:checked.dryRunHash})
}

describe('[COMP:crm/production-import] [COMP:crm/association-inventory] Atomic rows and serialized chunk recovery', () => {
  beforeAll(async () => {
    // Install table DDL before any concurrent import. Per-test arming changes
    // only fixture metadata, so it cannot queue a global chunk-table lock.
    await pool.query(`CREATE TABLE atomic_import_checkpoint_fixture_armed (
        workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE);
      ALTER TABLE atomic_import_checkpoint_fixture_armed ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON atomic_import_checkpoint_fixture_armed FROM PUBLIC,app_user;
      CREATE FUNCTION atomic_import_checkpoint_fixture_fail() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
        IF NEW.status='completed' AND EXISTS(SELECT 1 FROM atomic_import_checkpoint_fixture_armed
          WHERE workspace_id=NEW.workspace_id) THEN
          RAISE EXCEPTION 'Fixture checkpoint serialization failure' USING ERRCODE='40001';
        END IF; RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION atomic_import_checkpoint_fixture_fail() FROM PUBLIC,app_user;
      CREATE TRIGGER atomic_import_checkpoint_fixture_failure BEFORE UPDATE ON crm_import_chunks
        FOR EACH ROW EXECUTE FUNCTION atomic_import_checkpoint_fixture_fail()`)
  })
  afterAll(async () => {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS atomic_import_checkpoint_fixture_failure ON crm_import_chunks;
        DROP FUNCTION IF EXISTS atomic_import_checkpoint_fixture_fail();
        DROP TABLE IF EXISTS atomic_import_checkpoint_fixture_armed`)
    } finally { await Promise.all([pool.end(), getPool().end(), getAppPool().end()]) }
  })
  it.each(['company','contact','deal'] as const)('Q04 imports required %s custom values before its first entity insert and replays once',async kind => {
    const f=await fixture(),entityKind=kind==='contact'?'person':kind
    await pool.query("INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,is_required) VALUES($1,$2,'required_initial','Fictional import requirement','text',true)",[f.workspaceId,entityKind])
    const job=await f.job(['name','custom:required_initial'],[['Fictional required import','accepted']],kind),service=importer()
    expect(await service.resume(f.context,job.id)).toMatchObject({status:'completed',succeededRows:1,failedRows:0})
    const rows=(await pool.query("SELECT attributes->'custom_fields' AS custom FROM entities WHERE workspace_id=$1 AND kind=$2",[f.workspaceId,entityKind])).rows
    expect(rows).toEqual([{custom:{required_initial:'accepted'}}])
    const before=await f.counts()
    expect(await service.resume(f.context,job.id)).toMatchObject({status:'completed',succeededRows:1,failedRows:0})
    expect(await f.counts()).toEqual(before)
  })
  it('Q04 imports an exact deal amount without a floating-point intermediate or duplicate retry',async () => {
    const f=await fixture(),amount='9007199254740993.123456789012345678'
    const job=await f.job(['name','amount'],[['Fictional precise import',amount]],'deal')
    const service=importer()
    expect(await service.resume(f.context,job.id)).toMatchObject({status:'completed',succeededRows:1,failedRows:0})
    const rows=(await pool.query("SELECT attributes->>'amount' AS amount FROM entities WHERE workspace_id=$1 AND kind='deal'",[f.workspaceId])).rows
    expect(rows).toEqual([{amount}])
    const before=await f.counts()
    expect(await service.resume(f.context,job.id)).toMatchObject({status:'completed',succeededRows:1})
    expect(await f.counts()).toEqual(before)
  })
  it('rolls back a failed row including custom fields, stable bindings and evidence, and emits only committed graph projections', async () => {
    const f = await fixture(), companyId = await f.entity('company', 'Fixture company')
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      VALUES ($1,'person','score','Score','number')`, [f.workspaceId])
    const columns = [...consentColumns, 'custom:score', 'companyId', 'identityProvider', 'identityProviderInstance', 'identitySubject']
    const job = await f.job(columns, [0, 1].map((i) => [...row(i), '7', companyId, 'fixture', 'fixture_instance', `subject_${i}`]), 'contact', 'fixture')
    const create = vi.fn(async () => ({ id: randomUUID() }))
    const links = { create } as unknown as EntityLinksStore
    const service = importer(async (_client, command) => {
      expect(create).not.toHaveBeenCalled()
      if (command.kind === 'record_consent' && command.metadata.importRow === 2) throw new Error('Fixture rejection after evidence write')
    }, links)
    expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 1, failedRows: 1 })
    expect(await f.counts()).toMatchObject({ entities: 2, bindings: 1, consent: 1, receipts: 2, errors: 1, audit: 2, outbox: 1 })
    const person = (await pool.query(`SELECT id,attributes FROM entities WHERE workspace_id=$1 AND kind='person'`, [f.workspaceId])).rows[0]
    expect(person.attributes).toMatchObject({ email: 'fixture1@example.com', custom_fields: { score: 7 }, company_id: companyId })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: person.id, targetId: companyId }))
    const before = await f.counts()
    await service.resume(f.context, job.id)
    expect(await f.counts()).toEqual(before)
    // Emulate the legacy committed chunk whose separate job checkpoint never ran.
    await pool.query(`UPDATE crm_import_jobs SET status='running',processed_rows=0,succeeded_rows=0,failed_rows=0,next_chunk_index=0,completed_at=NULL WHERE id=$1`, [job.id])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 1, failedRows: 1, nextChunkIndex: 1 })
    expect(await f.counts()).toEqual(before)
    const boundAgain = await f.job(columns, [[...row(1), '8', companyId, 'fixture', 'fixture_instance', 'subject_1']], 'contact', 'fixture')
    expect(await importer().resume(f.context, boundAgain.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await f.counts()).toMatchObject({ entities: 2, bindings: 1, consent: 2 })
    expect((await pool.query('SELECT attributes FROM entities WHERE id=$1', [person.id])).rows[0].attributes.custom_fields).toEqual({ score: 8 })
  })

  it('survives connection termination after the canonical command and before the row receipt with immediate clean resume', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0)])
    const before = await f.counts()
    await expect(importer(async (client) => {
      client.once('error', () => undefined)
      await client.query('SELECT pg_terminate_backend(pg_backend_pid())')
    }).resume(f.context, job.id)).rejects.toBeDefined()
    expect(await f.counts()).toEqual(before)
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await f.counts()).toMatchObject({ entities: 1, consent: 1, receipts: 1, chunks: 1, errors: 0, outbox: 1 })
  })

  it('imports historical forms silently with original evidence and protects their identity across jobs', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Historical form person', { email: 'history@example.com' })
    const columns = [
      'contactId', 'historicalSubmissionSource', 'historicalSubmissionSite',
      'historicalSubmissionForm', 'historicalSubmissionId', 'historicalSubmissionOccurredAt',
      'historicalSubmissionStatus', 'historicalSubmissionFieldsJson',
      'historicalSubmissionSubject', 'historicalSubmissionQueueKey',
    ]
    const original = [contactId, 'wix', 'oasahk_org', 'contact_form', 'wix-submission-42',
      '2021-03-04T05:06:07.123456Z', 'resolved', '{"answer":"yes"}', 'Archived contact request', 'general']
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM association_enquiries WHERE workspace_id=$1)::int AS submissions,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1 AND action='crm.submission.historical_imported')::int AS audit,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS domain_outbox,
      (SELECT count(*) FROM association_notification_outbox WHERE workspace_id=$1)::int AS notification_outbox,
      (SELECT count(*) FROM crm_delivery_receipts WHERE workspace_id=$1)::int AS deliveries,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
      (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int AS tasks`, [f.workspaceId])).rows[0]

    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0].result_refs).toEqual([
      { kind: 'contact', id: contactId },
      { kind: 'submission', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-submission-42' },
    ])
    const saved = (await pool.query(`SELECT contact_id,source,source_site,source_form,source_submission_id,
      status,queue_key,subject,submitted_data,historical_import,
      to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS submitted_at
      FROM association_enquiries WHERE workspace_id=$1`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({
      contact_id: contactId, source: 'wix', source_site: 'oasahk_org', source_form: 'contact_form',
      source_submission_id: 'wix-submission-42', status: 'resolved', queue_key: 'general',
      subject: 'Archived contact request', historical_import: true,
      submitted_at: '2021-03-04T05:06:07.123456Z',
      submitted_data: {
        historicalSource: { source: 'wix', site: 'oasahk_org', form: 'contact_form', submissionId: 'wix-submission-42' },
        originalData: { answer: 'yes' },
      },
    })
    expect(await counts()).toMatchObject({ submissions: 1, audit: 1, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })

    const exactReplay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, exactReplay.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await counts()).toMatchObject({ submissions: 1, audit: 1, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })

    const changed = [...original]
    changed[7] = '{"answer":"no"}'
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT error_code,message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ error_code: 'command_failed', message: 'Historical submission identity was already used with different evidence.' }])
    expect(await counts()).toMatchObject({ submissions: 1, audit: 1, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })

    const anotherForm = [...original]
    anotherForm[3] = 'application_form'
    const distinct = await f.job(columns, [anotherForm], 'operations')
    expect(await importer().resume(f.context, distinct.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await counts()).toMatchObject({ submissions: 2, audit: 2, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })
  })

  it('requires current owner or admin authority for member-file historical submissions', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Authority fixture')
    const columns = ['contactId', 'historicalSubmissionSource', 'historicalSubmissionSite',
      'historicalSubmissionForm', 'historicalSubmissionId', 'historicalSubmissionOccurredAt',
      'historicalSubmissionStatus', 'historicalSubmissionFieldsJson']
    const values = [contactId, 'wix', 'oasahk_org', 'contact_form', 'authority-row',
      '2020-01-01T00:00:00Z', 'resolved', '{}']
    const job = await f.job(columns, [values], 'operations')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT count(*)::int AS count FROM association_enquiries WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(0)
    const member = { ...f.context, authority: { ...f.context.authority, role: 'member' as const, canConfigure: false } }
    const nextId = randomUUID(), bytes = Buffer.from([columns.join(','), values.join(','), ''].join('\n'))
    files.set(nextId, bytes)
    await pool.query(`INSERT INTO workspace_files (id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES ($1,$2,$3,'fixture.csv','fixture://local',$4)`, [nextId, f.workspaceId, `/fixture/${nextId}.csv`, f.userId])
    await expect(importer().dryRun(member, { stagedFileId: nextId, entityKind: 'operations',
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])) } }))
      .rejects.toMatchObject({ code: 'not_authorized' })
  })

  it('imports Wix membership access with immutable source lineage and no provider authority or side effects', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Source membership person')
    const association = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const plan = await association.upsertPlan(f.workspaceId, PlanInputSchema.parse({
      key: `source-plan-${f.workspaceId.slice(0, 8)}`, name: 'Source membership plan',
      currency: 'HKD', feeMinor: 120000, billingPeriod: 'annual', published: true,
    }), actor)
    const columns = [
      'contactId', 'entitlementPlanId', 'entitlementIdempotencyKey', 'entitlementStatus',
      'entitlementStartsAt', 'entitlementEndsAt', 'entitlementRenewalMode',
      'sourceMembershipSource', 'sourceMembershipSite', 'sourceMembershipId',
      'sourceMembershipPlanId', 'sourceMembershipMemberId', 'sourceMembershipOrderId',
      'sourceMembershipSubscriptionId', 'sourceMembershipPaymentProvider',
      'sourceMembershipPaymentReference', 'sourceMembershipStatus',
      'sourceMembershipRenewalStatus', 'sourceMembershipPaymentStatus',
      'sourceMembershipRefundStatus', 'sourceMembershipPurchasedAt',
      'sourceMembershipRelationshipsJson', 'sourceMembershipMetadataJson',
    ]
    const original = [
      contactId, String(plan.record.id), 'wix-membership:wix-membership-42', 'active',
      '2026-08-01T00:00:00Z', '2027-08-01T00:00:00Z', 'none',
      'wix', 'oasahk_org', 'wix-membership-42', 'wix-plan-annual', 'wix-member-42',
      'wix-order-42', 'wix-subscription-42', 'stripe', 'sub_wix_42', 'ACTIVE',
      'AUTO_RENEWING', 'PAID', 'NOT_REFUNDED', '2026-08-01T00:00:00Z',
      JSON.stringify({ companySourceId: 'wix-company-42', namedMemberSourceId: 'wix-member-42' }),
      JSON.stringify({ sourceRevision: 'rev-1' }),
    ]
    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    const refs = (await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0].result_refs
    expect(refs).toEqual(expect.arrayContaining([
      { kind: 'contact', id: contactId },
      { kind: 'entitlement', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-membership-42' },
    ]))
    const saved = (await pool.query(`SELECT m.id,m.status,m.renewal_mode,m.provider,m.provider_membership_id,
      m.provider_period_id,m.predecessor_id,s.source_system,s.source_site,s.source_membership_id,
      s.source_plan_id,s.source_member_id,s.source_order_id,s.source_subscription_id,
      s.source_payment_provider,s.source_payment_reference,s.source_status,s.source_renewal_status,
      s.source_payment_status,s.source_refund_status,s.relationships,s.metadata
      FROM association_memberships m JOIN association_membership_source_imports s
        ON s.workspace_id=m.workspace_id AND s.membership_id=m.id
      WHERE m.workspace_id=$1 AND s.source_membership_id='wix-membership-42'`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({ status: 'active', renewal_mode: 'none', provider: null,
      provider_membership_id: null, provider_period_id: null, predecessor_id: null,
      source_system: 'wix', source_site: 'oasahk_org', source_membership_id: 'wix-membership-42',
      source_plan_id: 'wix-plan-annual', source_member_id: 'wix-member-42', source_order_id: 'wix-order-42',
      source_subscription_id: 'wix-subscription-42', source_payment_provider: 'stripe',
      source_payment_reference: 'sub_wix_42', source_status: 'ACTIVE',
      source_renewal_status: 'AUTO_RENEWING', source_payment_status: 'PAID',
      source_refund_status: 'NOT_REFUNDED',
      relationships: { companySourceId: 'wix-company-42', namedMemberSourceId: 'wix-member-42' },
      metadata: { sourceRevision: 'rev-1' } })
    expect((await pool.query(`SELECT
      (SELECT count(*) FROM association_notification_outbox WHERE workspace_id=$1)::int notifications,
      (SELECT count(*) FROM association_integration_events WHERE workspace_id=$1)::int provider_events,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int domain_events`,
    [f.workspaceId])).rows[0]).toEqual({ notifications: 0, provider_events: 0, domain_events: 0 })
    await expect(pool.query(`UPDATE association_membership_source_imports SET source_status='CHANGED'
      WHERE workspace_id=$1 AND source_membership_id='wix-membership-42'`, [f.workspaceId]))
      .rejects.toMatchObject({ code: '23514' })

    const replay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, replay.id)).toMatchObject({ succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT count(*)::int count FROM association_membership_source_imports
      WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT count(*)::int count FROM association_audit_log
      WHERE workspace_id=$1 AND action='membership.source_imported'`, [f.workspaceId])).rows[0].count).toBe(1)

    const changed = [...original]
    changed[columns.indexOf('sourceMembershipStatus')] = 'CANCELLED'
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ message: 'Source membership identity was already used with different evidence.' }])
  })

  it('imports source orders silently, reconciles capacity once, and protects source evidence across jobs', async () => {
    const f = await fixture()
    const buyerId = await f.entity('person', 'Source order buyer', { email: 'buyer@example.com' })
    const attendeeId = await f.entity('person', 'Source order attendee', { email: 'attendee@example.com' })
    const association = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const event = await association.upsertEvent(f.workspaceId, EventInputSchema.parse({
      slug: `source-order-${f.workspaceId.slice(0, 8)}`, title: 'Future source booking',
      startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z',
      timezone: 'UTC', mode: 'venue', status: 'published', capacity: 2,
    }), actor)
    const ticket = await association.upsertTicket(f.workspaceId, String(event.record.id), TicketInputSchema.parse({
      key: 'standard', name: 'Standard', currency: 'HKD', priceMinor: 1_000,
      capacity: 2, status: 'closed',
    }), actor)
    const columns = [
      'contactId', 'sourceOrderSource', 'sourceOrderSite', 'sourceOrderId',
      'sourceOrderOccurredAt', 'sourceOrderStatus', 'sourceOrderCurrency',
      'sourceOrderSubtotalMinor', 'sourceOrderDiscountMinor', 'sourceOrderTotalMinor',
      'sourceOrderRefundedMinor', 'sourceOrderProvider', 'sourceOrderProviderReference',
      'sourceOrderLinesJson', 'sourceOrderMetadataJson',
    ]
    const lines = JSON.stringify([{ ticketId: ticket.record.id, quantity: 2,
      unitPriceMinor: 1_000, discountMinor: 400, lineTotalMinor: 1_600, attendees: [
        { sourceRegistrationId: 'booking-1', contactId: buyerId, name: 'Source order buyer', status: 'confirmed' },
        { sourceRegistrationId: 'booking-2', contactId: attendeeId, name: 'Source order attendee', email: 'attendee@example.com', status: 'confirmed' },
      ] }])
    const original = [buyerId, 'wix', 'oasahk_org', 'wix-order-42',
      '2026-08-01T10:00:00.123456Z', 'paid', 'HKD', '2000', '400', '1600', '200',
      'stripe', 'pi_wix_order_42', lines, '{"channel":"web"}']
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM association_orders WHERE workspace_id=$1 AND source_import)::int orders,
      (SELECT count(*) FROM association_registrations WHERE workspace_id=$1 AND source_kind='source_order')::int registrations,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1 AND action='order.source_imported')::int audit,
      (SELECT count(*) FROM association_notification_outbox WHERE workspace_id=$1)::int notifications,
      (SELECT count(*) FROM association_provider_events WHERE workspace_id=$1)::int provider_events,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int domain_events,
      (SELECT count(*) FROM crm_delivery_receipts WHERE workspace_id=$1)::int deliveries,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int consent,
      (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int tasks,
      COALESCE((SELECT used FROM association_inventory_boundaries WHERE workspace_id=$1 AND event_id=$2 AND ticket_id IS NULL),0)::int used`,
      [f.workspaceId, event.record.id])).rows[0]

    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    const sourceOrderRefs = (await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0].result_refs
    expect(sourceOrderRefs).toHaveLength(4)
    expect(sourceOrderRefs).toEqual(expect.arrayContaining([
      { kind: 'contact', id: buyerId },
      { kind: 'order', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-order-42' },
      { kind: 'registration', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'booking-1' },
      { kind: 'registration', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'booking-2' },
    ]))
    const saved = (await pool.query(`SELECT source_system,source_site,source_order_id,source_order_status,
      status,currency,subtotal_minor::text,discount_minor::text,total_minor::text,refunded_minor::text,
      refund_state,provider,provider_reference,source_import,
      to_char(source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') source_occurred_at
      FROM association_orders WHERE workspace_id=$1 AND source_import`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({ source_system: 'wix', source_site: 'oasahk_org', source_order_id: 'wix-order-42',
      source_order_status: 'paid', status: 'paid', currency: 'HKD', subtotal_minor: '2000',
      discount_minor: '400', total_minor: '1600', refunded_minor: '200', refund_state: 'partial',
      provider: 'stripe', provider_reference: 'pi_wix_order_42', source_import: true,
      source_occurred_at: '2026-08-01T10:00:00.123456Z' })
    expect((await pool.query(`SELECT pricing_basis,quantity,unit_price_minor::text,discount_minor::text,line_total_minor::text
      FROM association_order_lines WHERE workspace_id=$1`, [f.workspaceId])).rows)
      .toEqual([{ pricing_basis: 'source', quantity: 2, unit_price_minor: '1000', discount_minor: '400', line_total_minor: '1600' }])
    expect((await pool.query(`SELECT status,source_kind,historical_import FROM association_registrations
      WHERE workspace_id=$1 ORDER BY attendee_name`, [f.workspaceId])).rows)
      .toEqual([{ status: 'confirmed', source_kind: 'source_order', historical_import: false },
        { status: 'confirmed', source_kind: 'source_order', historical_import: false }])
    await expect(pool.query(`UPDATE association_orders SET source_order_id='changed'
      WHERE workspace_id=$1 AND source_order_id='wix-order-42'`, [f.workspaceId]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO association_registrations(
        workspace_id,order_id,order_line_id,event_id,ticket_id,attendee_name,status,
        source_kind,source_id,request_fingerprint,historical_import)
      SELECT o.workspace_id,o.id,l.id,t.event_id,l.ticket_id,'Spoofed source attendee','confirmed',
        'source_order','spoofed-source-registration',repeat('a',64),false
      FROM association_orders o JOIN association_order_lines l
        ON l.workspace_id=o.workspace_id AND l.order_id=o.id
      JOIN association_ticket_types t
        ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
      WHERE o.workspace_id=$1 AND o.source_order_id='wix-order-42'`, [f.workspaceId]))
      .rejects.toMatchObject({ code: '23514' })
    expect(await counts()).toMatchObject({ orders: 1, registrations: 2, audit: 1, notifications: 0,
      provider_events: 0, domain_events: 0, deliveries: 0, consent: 0, tasks: 0, used: 2 })

    const replay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, replay.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await counts()).toMatchObject({ orders: 1, registrations: 2, audit: 1, used: 2 })

    const changedLines = JSON.stringify([{ ...JSON.parse(lines)[0], discountMinor: 500, lineTotalMinor: 1_500 }])
    const changed = [...original]
    changed[8] = '500'; changed[9] = '1500'; changed[13] = changedLines
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ message: 'Source order identity was already used with different evidence.' }])

    const overflowLines = JSON.stringify([{ ticketId: ticket.record.id, quantity: 1,
      unitPriceMinor: 1_000, discountMinor: 0, lineTotalMinor: 1_000,
      attendees: [{ sourceRegistrationId: 'booking-3', name: 'Overflow attendee', status: 'confirmed' }] }])
    const overflow = [...original]
    overflow[3] = 'wix-order-43'; overflow[7] = '1000'; overflow[8] = '0'; overflow[9] = '1000';
    overflow[10] = '0'; overflow[12] = 'pi_wix_order_43'; overflow[13] = overflowLines
    const capacity = await f.job(columns, [overflow], 'operations')
    expect(await importer().resume(f.context, capacity.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [capacity.id])).rows[0].message)
      .toBe('Source order exceeds current ticket capacity.')
    expect(await counts()).toMatchObject({ orders: 1, registrations: 2, audit: 1, used: 2 })
  })

  it('imports digest-only Wix promotions with source usage and replay-safe receipts', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Promotion history contact')
    const association = createAssociationStore(pool, undefined, { promotionHmacKey })
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const event = await association.upsertEvent(f.workspaceId, EventInputSchema.parse({
      slug: `promotion-import-${f.workspaceId.slice(0, 8)}`, title: 'Promotion import target',
      startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z',
      timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10,
    }), actor)
    const code = 'WIX-HISTORY-10'
    const digest = createHmac('sha256', promotionHmacKey).update(code, 'utf8').digest('hex')
    const columns = [
      'promotionSource', 'promotionSite', 'promotionId', 'promotionKey', 'promotionName',
      'promotionCodeDigest', 'promotionDiscountType', 'promotionPercentageBasisPoints',
      'promotionTargetKind', 'promotionTargetIdsJson', 'promotionMaxUses', 'promotionMaxUsesPerContact',
      'promotionCombinesWithMemberPrice', 'promotionReleaseOnFullRefund', 'promotionStatus',
      'promotionSourceRedeemedUses', 'promotionSourceContactUsesJson',
    ]
    const original = [
      'wix', 'oasahk.org', 'wix-coupon-history-10', 'history-ten', 'Historical 10%', digest,
      'percentage', '1000', 'event', JSON.stringify([event.record.id]), '10', '1', 'false', 'false',
      'active', '1', JSON.stringify([{ contactId, uses: 1 }]),
    ]
    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({
      status: 'completed', succeededRows: 1, failedRows: 0,
    })
    const receipt = (await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0]
    expect(receipt.result_refs).toEqual([{
      kind: 'promotion', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-coupon-history-10',
    }])
    const saved = (await pool.query(`SELECT id,code_digest,source_system,source_site,source_promotion_id,
      source_redeemed_uses,source_import FROM association_promotions WHERE workspace_id=$1`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({ code_digest: digest, source_system: 'wix', source_site: 'oasahk.org',
      source_promotion_id: 'wix-coupon-history-10', source_redeemed_uses: 1,
      source_import: { jobId: first.id, row: 2, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } })
    expect(JSON.stringify(saved)).not.toContain(code)

    const replay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, replay.id)).toMatchObject({ succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT count(*)::int count FROM association_promotions
      WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT count(*)::int count FROM association_audit_log
      WHERE workspace_id=$1 AND action='promotion.source_imported'`, [f.workspaceId])).rows[0].count).toBe(1)

    const changed = [...original]
    changed[4] = 'Changed source evidence'
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ message: 'Source promotion identity was already used with different evidence.' }])
  })

  it('keeps ended source bookings historical and rechecks owner authority at commit', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Historical booking person')
    const association = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const event = await association.upsertEvent(f.workspaceId, EventInputSchema.parse({
      slug: `past-source-${f.workspaceId.slice(0, 8)}`, title: 'Past source booking',
      startsAt: '2020-01-01T12:00:00Z', endsAt: '2020-01-01T14:00:00Z',
      timezone: 'UTC', mode: 'venue', status: 'completed', capacity: 1,
    }), actor)
    const ticket = await association.upsertTicket(f.workspaceId, String(event.record.id), TicketInputSchema.parse({
      key: 'archive', name: 'Archive', currency: 'HKD', priceMinor: 500, capacity: 1, status: 'closed',
    }), actor)
    const columns = ['contactId', 'sourceOrderSource', 'sourceOrderSite', 'sourceOrderId',
      'sourceOrderOccurredAt', 'sourceOrderStatus', 'sourceOrderCurrency', 'sourceOrderSubtotalMinor',
      'sourceOrderTotalMinor', 'sourceOrderProvider', 'sourceOrderProviderReference', 'sourceOrderLinesJson']
    const row = [contactId, 'wix', 'oasahk_org', 'past-order-1', '2019-12-01T00:00:00Z',
      'paid', 'HKD', '500', '500', 'stripe', 'pi_past_order_1', JSON.stringify([{
        ticketId: ticket.record.id, quantity: 1, unitPriceMinor: 500, lineTotalMinor: 500,
        attendees: [{ sourceRegistrationId: 'past-booking-1', contactId, name: 'Historical booking person',
          status: 'checked_in', checkedInAt: '2020-01-01T12:15:00Z' }],
      }])]
    const historical = await f.job(columns, [row], 'operations')
    expect(await importer().resume(f.context, historical.id)).toMatchObject({ succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT historical_import,status,checked_in_at IS NOT NULL checked_in
      FROM association_registrations WHERE workspace_id=$1 AND event_id=$2`, [f.workspaceId, event.record.id])).rows)
      .toEqual([{ historical_import: true, status: 'checked_in', checked_in: true }])
    expect((await pool.query(`SELECT used FROM association_inventory_boundaries
      WHERE workspace_id=$1 AND event_id=$2 AND ticket_id IS NULL`, [f.workspaceId, event.record.id])).rows[0].used).toBe(0)

    const pending = [...row]
    pending[3] = 'past-order-2'; pending[10] = 'pi_past_order_2'
    const authority = await f.job(columns, [pending], 'operations')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, authority.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT count(*)::int count FROM association_orders WHERE workspace_id=$1 AND source_order_id='past-order-2'`, [f.workspaceId])).rows[0].count).toBe(0)
  })

  it('finishes file I/O before borrowing the only transaction connection', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0)])
    const single = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 1000 })
    const boundedFiles = { readBytes: async (ctx: unknown, id: string) => {
      await single.query('SELECT 1')
      return filesApi.readBytes(ctx as Parameters<FilesApi['readBytes']>[0], id)
    } } as unknown as FilesApi
    try {
      const service = createCrmProductionImportService({ pool: single, filesApi: boundedFiles,
        operationsForTransaction: (client) => createCrmOperationsService(createDbCrmOperationsStore(single, client)) })
      expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
    } finally { await single.end() }
  })

  it('serializes concurrent resume and cancellation across a 50-row boundary', async () => {
    console.info('[r2-import-pool-bounds]',{app:Number(getAppPool().options.max),fixture:Number(pool.options.max)})
    const f = await fixture(), job = await f.job(consentColumns, Array.from({ length: 51 }, (_, i) => row(i)))
    let enter!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    let held = false,holderPid=0,holderRole=''
    const first = importer(async client => { if (!held) {
      held=true
      const identity=(await client.query<{pid:number;role:string}>('SELECT pg_backend_pid() AS pid,session_user AS role')).rows[0]
      holderPid=identity.pid;holderRole=identity.role
      enter();await gate
    } }).resume(f.context, job.id)
    let cancellation: ReturnType<ReturnType<typeof importer>['cancel']> | undefined
    try {
      await Promise.race([ready, first.then(() => { throw new Error('Import ended before barrier') })])
      expect(await f.counts()).toMatchObject({ entities: 0, consent: 0, receipts: 0, chunks: 0 })
      await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'import_processing' } })
      const other = await fixture(), otherJob = await other.job(consentColumns, [row(0)])
      expect(await importer().resume(other.context, otherJob.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
      cancellation = importer().cancel(f.context, job.id)
      let locked = false
      const until = Date.now() + 5000
      while (Date.now() < until) {
        // Pin the waiter to this exact job/workspace transaction, now on the
        // genuine app role rather than the metadata fixture pool's name.
        const r = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE usename=$1
          AND wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(pid))
          AND (query LIKE '%UPDATE crm_import_jobs SET status=%'
            OR query='SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE')`,[holderRole,holderPid])
        if (r.rowCount) { locked = true; break }
        await setTimeout(10)
      }
      expect(locked).toBe(true)
    } finally { release(); await Promise.allSettled([first, ...(cancellation ? [cancellation] : [])]) }
    expect(await first).toMatchObject({ status: 'paused', processedRows: 50, succeededRows: 50 })
    expect(await cancellation).toMatchObject({ status: 'cancelled', processedRows: 50 })
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'cancelled', processedRows: 50 })
    expect(await f.counts()).toMatchObject({ entities: 50, consent: 50, receipts: 50, chunks: 1, outbox: 50 })
  })

  it('Q03/Q04 rechecks cancellation membership after a real admission timeout before cancellation effects',async()=>{
    const f=await fixture(),member=await importMember(f),job=await f.job(consentColumns,[row(0)]),before=await f.counts()
    expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0')
    let enter!:()=>void,release!:()=>void
    const ready=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
    let held=false,holderPid=0,holderRole=''
    const ownerService=createCrmProductionImportService({pool,filesApi,operationsForTransaction:client=>{
      const actual=createCrmOperationsService(createDbCrmOperationsStore(pool,client))
      return {importHistoricalSubmission:actual.importHistoricalSubmission,execute:async(context,command)=>{
        if(!held){held=true;await assertImportTransactionActor(client,f.userId)
          const backend=(await client.query<{pid:number;role:string}>('SELECT pg_backend_pid() AS pid,session_user AS role')).rows[0]
          holderPid=backend.pid;holderRole=backend.role;enter();await gate}
        return actual.execute(context,command)
      }}
    }})
    const owner=ownerService.resume(f.context,job.id)
    let cancellation:Promise<unknown>|undefined,deletion:Promise<{rowCount:number|null}>|undefined
    try {
      await Promise.race([ready,owner.then(()=>{throw new Error('Import ended before its business barrier')})])
      expect(await f.counts()).toEqual(before)
      // Attach both outcomes immediately: the genuine fifteen-second database
      // timeout must never become an unhandled rejection in this regression.
      cancellation=importer().cancel(member.context,job.id).then(value=>({ok:true,value}),error=>({ok:false,error}))
      let blocked:{pid:number;startedAt:string}|undefined
      const until=Date.now()+5000
      while(Date.now()<until){
        blocked=(await pool.query<{pid:number;startedAt:string}>(`SELECT pid,xact_start::text AS "startedAt" FROM pg_stat_activity
          WHERE usename=$1 AND wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(pid))
            AND query='SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE'`,[holderRole,holderPid])).rows[0]
        if(blocked)break
        await setTimeout(10)
      }
      expect(blocked).toMatchObject({pid:expect.any(Number),startedAt:expect.any(String)})
      expect(blocked?.pid).not.toBe(holderPid)
      // Canonical membership retirement also needs the workspace gate. Queue
      // it without awaiting under the owner's barrier, ahead of the retry.
      deletion=pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,member.userId])
      void deletion.catch(()=>undefined)
      let retiring:{pid:number}|undefined
      const retirementUntil=Date.now()+5000
      while(Date.now()<retirementUntil){
        retiring=(await pool.query<{pid:number}>(`SELECT pid FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND ($1::integer=ANY(pg_blocking_pids(pid)) OR $2::integer=ANY(pg_blocking_pids(pid)))
            AND query='DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2'`,[holderPid,blocked!.pid])).rows[0]
        if(retiring)break
        await setTimeout(10)
      }
      const retirementWaits=retiring?[]:(await pool.query(`SELECT pid,wait_event_type AS kind,wait_event AS event,
        pg_blocking_pids(pid) AS blockers,md5(query) AS query_hash FROM pg_stat_activity WHERE wait_event_type='Lock'`)).rows
      expect({retiring,retirementWaits}).toMatchObject({retiring:{pid:expect.any(Number)}})
      let retried=false
      const retryUntil=Date.now()+20000
      while(Date.now()<retryUntil){
        retried=Boolean((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'
          AND (pid<>$2::integer OR xact_start::text<>$3)
          AND ($4::integer=ANY(pg_blocking_pids(pid)) OR $5::integer=ANY(pg_blocking_pids(pid)))
          AND query='SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE'`,
          [holderRole,blocked!.pid,blocked!.startedAt,holderPid,retiring!.pid])).rowCount)
        if(retried)break
        await setTimeout(10)
      }
      expect(retried).toBe(true)
      expect(await f.counts()).toEqual(before)
      release()
      expect((await deletion).rowCount).toBe(1)
      expect(await cancellation).toMatchObject({ok:false,error:{code:'not_authorized'}})
    } finally {release();await Promise.allSettled([owner,...(cancellation?[cancellation]:[]),...(deletion?[deletion]:[])])}
    expect(await owner).toMatchObject({status:'completed',processedRows:1,succeededRows:1,failedRows:0})
    expect(await f.counts()).toMatchObject({entities:1,consent:1,receipts:1,chunks:1,outbox:1})
    const independent=importer()
    expect(await independent.get(f.context,job.id)).toMatchObject({status:'completed',succeededRows:1})
    expect(await independent.cancel(f.context,job.id)).toMatchObject({status:'completed',succeededRows:1})
  })

  it('rolls back committed row savepoints if the chunk checkpoint fails, then retries without double counters', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0), row(1)])
    const before = await f.counts()
    try {
      await pool.query('INSERT INTO atomic_import_checkpoint_fixture_armed(workspace_id) VALUES($1)', [f.workspaceId])
      await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: '40001' })
      expect(await f.counts()).toEqual(before)
    } finally {
      await pool.query('DELETE FROM atomic_import_checkpoint_fixture_armed WHERE workspace_id=$1', [f.workspaceId])
    }
    const service = importer()
    expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 2, failedRows: 0 })
    const committed = await f.counts()
    expect(committed).toMatchObject({ entities: 2, consent: 2, receipts: 2, chunks: 1, outbox: 2 })
    await service.resume(f.context, job.id)
    expect(await f.counts()).toEqual(committed)
  })

  it.each(['company', 'deal'] as const)('rolls back %s record changes when a later command rejects the row', async (kind) => {
    const f = await fixture(), company = await f.entity('company', 'Fixture company', { domain: 'original.example', tags: ['original'] })
    const person = await f.entity('person', 'Fixture person', { email: 'fixture@example.com' })
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      VALUES ($1,$2,'score','Score','number')`, [f.workspaceId, kind])
    const job = await f.job(['name', 'domain', 'contactId', 'companyId', 'custom:score', 'consentPurposeKey', 'consentAction', 'consentSource'],
      [['Fixture company', 'changed.example', person, company, '7', 'updates', 'granted', 'fixture']], kind)
    const before = (await pool.query('SELECT id,display_name,attributes FROM entities WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows
    expect(await importer(async () => { throw new Error('Fixture later command rejected') }).resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query('SELECT id,display_name,attributes FROM entities WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows).toEqual(before)
    expect(await f.counts()).toMatchObject({ entities: 2, consent: 0, receipts: 1, errors: 1, audit: 1, outbox: 0 })
  })

  it('refuses stale trusted-source authority and ambiguous normalized email without minting another person', async () => {
    const f = await fixture()
    await f.entity('person', 'First fixture', { email: ' fixture@example.com ' })
    await f.entity('person', 'Second fixture', { email: 'FIXTURE@example.com' })
    const job = await f.job(consentColumns, [['Updated fixture', 'fixture@example.com', 'updates', 'granted', 'fixture']], 'contact', 'fixture')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query(`UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect(await f.counts()).toMatchObject({ entities: 2, consent: 0, outbox: 0 })
    expect(await importer().errorsCsv(f.context, job.id)).toContain('Multiple live contacts match this email')
  })

  it('Q03/Q04 imports as the actual current member on a nonowner data transaction',async()=>{
    const f=await fixture(),member=await importMember(f),job=await f.job(consentColumns,[row(0)])
    let calls=0
    const service=importer(async client=>{
      calls++;await assertImportTransactionActor(client,member.userId)
      expect((await client.query("SELECT has_function_privilege(session_user,'public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
      await client.query('SAVEPOINT private_ancestry_privilege')
      await expect(client.query("SELECT application_canonical_ancestry_from_admitted_root($1,'application_field',$2,'forged',false,$3::jsonb)",
        [f.workspaceId,randomUUID(),JSON.stringify({kind:'application_field',id:randomUUID(),version:'forged',state:{held:false}})]))
        .rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK TO SAVEPOINT private_ancestry_privilege')
      await client.query('RELEASE SAVEPOINT private_ancestry_privilege')
      expect((await client.query("SELECT has_function_privilege(session_user,'public.application_recorded_field_root_capture(uuid,uuid,text,integer)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
      await client.query('SAVEPOINT private_root_capture_privilege')
      await expect(client.query('SELECT application_recorded_field_root_capture($1,$2,$3,0)',[f.workspaceId,randomUUID(),'forged']))
        .rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK TO SAVEPOINT private_root_capture_privilege')
      await client.query('RELEASE SAVEPOINT private_root_capture_privilege')
    })
    expect(await service.resume(member.context,job.id)).toMatchObject({status:'completed',succeededRows:1,failedRows:0})
    expect(calls).toBe(1)
    expect((await importBusinessRows(f.workspaceId)).map(value=>value.created_by_user_id)).toEqual([member.userId])
    expect((await pool.query("SELECT actor_kind,acting_user_id FROM association_audit_log WHERE workspace_id=$1 AND actor_kind='import'",[f.workspaceId])).rows)
      .toEqual([{actor_kind:'import',acting_user_id:member.userId}])
  })

  it.each([{kind:'company',type:'company',field:'externalRef'},{kind:'contact',type:'person',field:'email'}] as const)
  ('Q02/Q03/Q04 refuses hidden $field import predicates without business effects while an independent current reader succeeds',async({kind,type,field})=>{
    const f=await fixture(),blocked=await importMember(f,'admin'),independent=await importMember(f,'admin')
    const existing=await f.entity(type,'Fictional existing import row',type==='person'?{email:'fixture@example.com',tags:['retained']}:{domain:'existing.example'})
    const columns=type==='person'?consentColumns:['name','domain']
    const values=type==='person'?['Fictional current imported row','fixture@example.com','updates','granted','fixture_import']:['Fictional current imported row','imported.example']
    const job=await f.job(columns,[values],kind,type==='person'?'fixture':undefined)
    await withImportPredicatePolicy(f.workspaceId,type,field,async()=>{
      const before=await importBusinessRows(f.workspaceId),counts=await f.counts(),hook=vi.fn(async()=>{})
      expect(await importer(hook).resume(blocked.context,job.id)).toMatchObject({status:'completed',succeededRows:0,failedRows:1})
      expect(hook).not.toHaveBeenCalled()
      expect(await importBusinessRows(f.workspaceId)).toEqual(before)
      expect(await f.counts()).toMatchObject({entities:counts.entities,bindings:counts.bindings,consent:counts.consent,outbox:counts.outbox})
      expect((await pool.query('SELECT status,entity_id,result_refs FROM crm_import_rows WHERE job_id=$1',[job.id])).rows)
        .toEqual([{status:'failed',entity_id:null,result_refs:[]}])
      expect((await pool.query('SELECT message FROM crm_import_errors WHERE job_id=$1',[job.id])).rows[0]?.message).toMatch(/canonical fields|source.*unavailable|resource.*unavailable/i)
      await pool.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$3)",[f.workspaceId,independent.userId,f.userId])
      const next=await f.job(columns,[values],kind,type==='person'?'fixture':undefined)
      let calls=0
      expect(await importer(async client=>{calls++;await assertImportTransactionActor(client,independent.userId)}).resume(independent.context,next.id))
        .toMatchObject({status:'completed',succeededRows:1,failedRows:0})
      const saved=await importBusinessRows(f.workspaceId)
      if(type==='person') {
        expect(saved).toHaveLength(1)
        expect(saved[0]).toMatchObject({id:existing,display_name:'Fictional current imported row'})
        expect(saved[0].attributes.tags).toEqual(['retained'])
        expect(calls).toBe(1)
      } else {
        expect(saved).toHaveLength(2)
        expect(saved.find(value=>value.id!==existing)).toMatchObject({display_name:'Fictional current imported row',created_by_user_id:independent.userId})
      }
    })
  })

  it('Q03/Q04 refuses an issuerless import key without owner fallback and recovers with its actual current issuer',async()=>{
    const f=await fixture(),issuer=await importMember(f,'admin'),assistantId=randomUUID()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional bounded import assistant','primary','internal')",[assistantId,f.workspaceId])
    const key=await importKey(f,issuer.userId,{departmentIds:[],cap:'internal',assistantId}),job=await machineImportJob(key.context)
    const before=await f.counts()
    await pool.query('UPDATE crm_integration_credentials SET created_by_user_id=NULL WHERE id=$1',[key.credentialId])
    await expect(importer().resume(key.context,job.id)).rejects.toMatchObject({code:'not_authorized'})
    expect(await f.counts()).toEqual(before)
    expect((await pool.query('SELECT status FROM crm_import_jobs WHERE id=$1',[job.id])).rows[0]).toEqual({status:'ready'})
    await pool.query('UPDATE crm_integration_credentials SET created_by_user_id=$2 WHERE id=$1',[key.credentialId,issuer.userId])
    let calls=0
    expect(await importer(async client=>{
      calls++;await assertImportTransactionActor(client,issuer.userId)
      const settings=(await client.query(`SELECT current_setting('app.v2_active',true) AS active,current_setting('app.v2_assistant_id',true) AS assistant,
        current_setting('app.v2_binding',true) AS binding,current_setting('app.v2_cap',true) AS cap,current_setting('app.agent_clearance',true) AS clearance,
        current_setting('app.agent_compartments',true) AS compartments,current_setting('app.agent_mutation_compartments',true) AS mutation,
        current_setting('app.agent_project_ids',true) AS projects,current_setting('app.agent_visibility_assistants',true) AS assistants`)).rows[0]
      expect(key.principal.departmentRead).toBeDefined();expect(key.principal.executionLimits).toBeDefined()
      const limits=key.principal.executionLimits!
      expect(settings).toEqual({active:'true',assistant:assistantId,binding:JSON.stringify(key.principal.departmentRead!.binding),cap:'internal',
        clearance:limits.clearance,compartments:JSON.stringify(limits.compartments),mutation:JSON.stringify(limits.mutationCompartments),
        projects:JSON.stringify(limits.projectIds),assistants:JSON.stringify(limits.visibilityAssistantIds)})
    }).resume(key.context,job.id))
      .toMatchObject({status:'completed',succeededRows:1,failedRows:0})
    expect(calls).toBe(1)
    const fresh=await getAppPool().connect()
    try {
      await fresh.query('BEGIN')
      const settings=(await fresh.query("SELECT current_setting('app.v2_active',true) AS active,current_setting('app.v2_binding',true) AS binding,current_setting('app.agent_clearance',true) AS clearance")).rows[0]
      for(const value of Object.values(settings))expect(value===null||value==='').toBe(true)
    } finally {await fresh.query('ROLLBACK');fresh.release()}
    expect((await importBusinessRows(f.workspaceId)).map(value=>value.created_by_user_id)).toEqual([issuer.userId])
    expect((await pool.query("SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND actor_kind='integration_key'",[f.workspaceId])).rows)
      .toEqual([{actor_kind:'integration_key',actor_credential_id:key.credentialId}])
  })

  it('Q03/Q04 renews the actual import key ceiling before effects and permits an independent current key',async()=>{
    const f=await fixture(),issuer=await importMember(f,'admin'),independent=await importMember(f,'admin')
    const key=await importKey(f,issuer.userId),other=await importKey(f,independent.userId),job=await machineImportJob(key.context),before=await f.counts()
    await pool.query("DELETE FROM crm_integration_credential_grants WHERE credential_id=$1 AND operation='crm.records.write'",[key.credentialId])
    await expect(importer().resume(key.context,job.id)).rejects.toMatchObject({code:'integration_scope_denied'})
    expect(await f.counts()).toEqual(before)
    expect((await pool.query('SELECT status FROM crm_import_jobs WHERE id=$1',[job.id])).rows[0]).toEqual({status:'ready'})
    let calls=0
    expect(await importer(async client=>{calls++;await assertImportTransactionActor(client,independent.userId)}).resume(other.context,job.id))
      .toMatchObject({status:'completed',succeededRows:1,failedRows:0})
    expect(calls).toBe(1)
    expect((await importBusinessRows(f.workspaceId)).map(value=>value.created_by_user_id)).toEqual([independent.userId])
    expect((await pool.query("SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND actor_kind='integration_key'",[f.workspaceId])).rows)
      .toEqual([{actor_kind:'integration_key',actor_credential_id:other.credentialId}])
  })

 it('Q03/Q04 serializes actual nonowner imports with exclusive source-retirement admission',async()=>{
   const f=await fixture(),issuer=await importMember(f,'admin'),key=await importKey(f,issuer.userId),job=await machineImportJob(key.context)
   const before=await f.counts(),retirement=await pool.connect()
   try {
     await retirement.query('BEGIN')
     await acquireCrmPrivacyAdmission(retirement,f.workspaceId)
     await expect(importer().resume(key.context,job.id)).rejects.toMatchObject({code:'conflict'})
     expect(await f.counts()).toEqual(before)
     expect((await pool.query('SELECT status FROM crm_import_jobs WHERE id=$1',[job.id])).rows[0]).toEqual({status:'ready'})
   } finally {await retirement.query('ROLLBACK');retirement.release()}
   let checks=0
   const service=importer(async client=>{
     await assertImportTransactionActor(client,issuer.userId)
     const exclusive=await pool.connect()
     try {
       await exclusive.query('BEGIN')
       await expect(acquireCrmPrivacyAdmission(exclusive,f.workspaceId)).rejects.toMatchObject({code:'conflict'})
       checks++
     } finally {await exclusive.query('ROLLBACK');exclusive.release()}
   })
   expect(await service.resume(key.context,job.id)).toMatchObject({status:'completed',succeededRows:1,failedRows:0})
   expect(checks).toBe(1)
   expect(await f.counts()).toMatchObject({entities:1,consent:1,receipts:1,chunks:1,errors:0,outbox:1})
   const exclusive=await pool.connect()
   try {await exclusive.query('BEGIN');await acquireCrmPrivacyAdmission(exclusive,f.workspaceId)}
   finally {await exclusive.query('ROLLBACK');exclusive.release()}
 })

  it('Q02/Q03/Q04 holds custom import dry runs when the registered current configuration catalog is unavailable',async()=>{
    const f=await fixture(),blocked=await importMember(f,'admin'),independent=await importMember(f,'admin')
    await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,options)
      VALUES($1,'company','import_tier','Fictional import tier','single_select','["accepted"]')`,[f.workspaceId])
    const bytes=Buffer.from('Name,Tier\nFictional configuration import,accepted\n'),fileId=randomUUID()
    files.set(fileId,bytes)
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id) VALUES($1,$2,$3,'fictional.csv','fixture://local',$4)",[fileId,f.workspaceId,`/fixture/${fileId}.csv`,f.userId])
    const mapping={columns:{0:'name',1:'custom:import_tier'}},input={stagedFileId:fileId,entityKind:'company' as const,mapping}
    const key=await importKey(f,blocked.userId),other=await importKey(f,independent.userId)
    const source=await createCrmImportSources(pool).stage(key.context,randomUUID(),bytes)
    const machine={sourceId:source.sourceId,entityKind:'company' as const,mapping}
    await withImportPredicatePolicy(f.workspaceId,'company','externalRef',async()=>{
      for(const actor of [blocked.userId,independent.userId])await pool.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$3)",[f.workspaceId,actor,f.userId])
      const service=importer()
      expect(await service.dryRun(blocked.context,input)).toMatchObject({validRows:1,failedRows:0})
      expect(await service.dryRun(key.context,machine)).toMatchObject({validRows:1,failedRows:0})
      expect((await getCrmConfig(blocked.userId,f.workspaceId)).fields).toContainEqual(expect.objectContaining({fieldKey:'import_tier',options:['accepted']}))
      const definition=(await pool.query("SELECT pg_get_functiondef('atomic_import_catalog(uuid,jsonb,text)'::regprocedure) AS value")).rows[0].value as string
      await pool.query(`CREATE OR REPLACE FUNCTION atomic_import_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        SELECT CASE WHEN current_setting('app.current_user_id',true)='${blocked.userId}' THEN NULL::jsonb ELSE
         jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1','fieldKeys',public.application_native_field_keys(t),
          'fields',public.atomic_import_rules(t),'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) END $$`)
      try {
        await expect(getCrmConfig(blocked.userId,f.workspaceId)).rejects.toMatchObject({code:'access_unavailable'})
        await expect(service.dryRun(blocked.context,input)).rejects.toMatchObject({code:'access_unavailable'})
        await expect(service.dryRun(key.context,machine)).rejects.toMatchObject({code:'access_unavailable'})
        expect((await getCrmConfig(independent.userId,f.workspaceId)).fields).toContainEqual(expect.objectContaining({fieldKey:'import_tier',options:['accepted']}))
        expect(await service.dryRun(independent.context,input)).toMatchObject({validRows:1,failedRows:0})
        expect(await service.dryRun(other.context,machine)).toMatchObject({validRows:1,failedRows:0})
        expect(await importBusinessRows(f.workspaceId)).toEqual([])
        expect(await f.counts()).toMatchObject({entities:0,consent:0,receipts:0,chunks:0,errors:0,outbox:0})
      } finally {await pool.query(definition)}
    })
  })

  it('Q03/Q04 rejects arbitrary inventory counters and identity changes while exact nonowner canonical refresh succeeds',async()=>{
    const f=await fixture(),admin=await importMember(f,'admin'),member=await importMember(f),association=createAssociationStore(pool)
    const actor={credentialKind:'user' as const,credentialId:f.userId,actingUserId:f.userId}
    const events=[]
    for(const index of [0,1])events.push(await association.upsertEvent(f.workspaceId,EventInputSchema.parse({
      slug:`fictional-inventory-${index}-${f.workspaceId.slice(0,8)}`,title:'Fictional current inventory event',
      startsAt:'2099-01-01T12:00:00Z',endsAt:'2099-01-01T14:00:00Z',timezone:'UTC',mode:'venue',status:'published',capacity:2,
    }),actor))
    const eventId=String(events[0].record.id),otherEventId=String(events[1].record.id)
    const data=async()=>(await pool.query('SELECT id,workspace_id,event_id,ticket_id,sold_out,revision,capacity,used,created_at,updated_at FROM association_inventory_boundaries WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
    const write=async(userId:string,run:(client:pg.PoolClient)=>Promise<unknown>)=>{
      const client=await getAppPool().connect()
      try {
        await client.query('BEGIN');await applyRLSGucs(client,userId)
        await lockAssociationInventory(client,f.workspaceId,{eventIds:[eventId,otherEventId]})
        const result=await run(client);await client.query('COMMIT');return result
      } catch(error) {await client.query('ROLLBACK');throw error}
      finally {client.release()}
    }
    await write(admin.userId,async client=>{
      await assertImportTransactionActor(client,admin.userId)
      await refreshAssociationInventory(client,f.workspaceId,[eventId],'user',{emitEvents:false})
    })
    const before=await data(),boundary=before.find(value=>value.event_id===eventId&&value.ticket_id===null)
    expect(boundary).toMatchObject({sold_out:false,revision:0,capacity:2,used:0})
    const outbox=(await pool.query('SELECT count(*)::int AS count FROM crm_domain_event_outbox WHERE workspace_id=$1',[f.workspaceId])).rows[0]
    for(const [sql,args] of [
      ['UPDATE association_inventory_boundaries SET used=1 WHERE id=$1',[boundary.id]],
      ['UPDATE association_inventory_boundaries SET revision=revision+1 WHERE id=$1',[boundary.id]],
      ['UPDATE association_inventory_boundaries SET event_id=$2 WHERE id=$1',[boundary.id,otherEventId]],
    ] as Array<[string,unknown[]]>) {
      await expect(write(admin.userId,client=>client.query(sql,args))).rejects.toMatchObject({code:expect.stringMatching(/^(23514|42501)$/)})
      expect(await data()).toEqual(before)
      expect((await pool.query('SELECT count(*)::int AS count FROM crm_domain_event_outbox WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toEqual(outbox)
    }
    await expect(write(member.userId,client=>client.query(`INSERT INTO association_inventory_boundaries(workspace_id,event_id,ticket_id,sold_out,revision,capacity,used)
      VALUES($1,$2,NULL,false,0,2,0)`,[f.workspaceId,otherEventId]))).rejects.toMatchObject({code:'42501'})
    expect(await data()).toEqual(before)
    expect(await write(admin.userId,client=>client.query('DELETE FROM association_inventory_boundaries WHERE id=$1',[boundary.id]))).toMatchObject({rowCount:0})
    expect(await data()).toEqual(before)
    await write(admin.userId,client=>refreshAssociationInventory(client,f.workspaceId,[eventId],'user',{emitEvents:false}))
    expect((await data()).find(value=>value.id===boundary.id)).toMatchObject({sold_out:false,revision:0,capacity:2,used:0})
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_domain_event_outbox WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toEqual(outbox)
  })
})
