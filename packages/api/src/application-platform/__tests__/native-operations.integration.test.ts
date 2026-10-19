/** Native canonical transaction composition, not a substitute CRM/task store. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { boundScopeSources, type ApplicationModuleDefinition, type TaskRecord, type TaskUpdateFields,type CompanyUpdateFields,type ContactUpdateFields,type DealUpdateFields } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { bindTaskClosedHook, createTask, getTaskById, resolveTaskById, updateTask } from '../../db/tasks.js'
import { createCompany,createContact,createDeal,getDealById,listDeals,updateCompany,updateContact,updateDeal,setDealStage } from '../../db/crm.js'
import { createCrmFieldDefinition,updateCrmCustomFields } from '../../db/crm-r2.js'
import { updateEntity } from '../../db/entities-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] canonical native operation composition', () => {
  const owner = getPool(), workspaceId = randomUUID(), userId = randomUUID(), readerId = randomUUID(), assistantId = randomUUID()
  const access = { workspaceId, userId, assistantId, assistantKind: 'primary' as const }
  beforeAll(async () => {
    for (const id of [userId,readerId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional native operations',$2,false)", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspaceId,readerId])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional native operator',$2,$3,'primary','confidential')", [assistantId,userId,workspaceId])
  })
  afterAll(async () => {
    bindTaskClosedHook(null)
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,readerId]])
    await getAppPool().end(); await owner.end()
  })
  const version = (task: TaskRecord) => boundScopeSources(task)[0].version!
  const task = (title = `Fictional operation ${randomUUID()}`, parentId?: string) => createTask(userId, { workspaceId, title, parentId, access })
  async function client() {
    const connection = await getAppPool().connect()
    await connection.query('BEGIN'); await applyRLSGucs(connection,userId)
    expect((await connection.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
      FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=current_user`)).rows[0].bypass).toBe(false)
    return connection
  }
  async function execution() {
    return (await resolveExecutionContextSystem({ userId, workspaceId, assistant: (await findAssistantById(assistantId))!, memberMode: 'member',
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId }, lifecycle: { sessionId: randomUUID(), sessionPersisted: false,
        channelId: 'native-operation-fixture', channelType: 'test', abortSignal: new AbortController().signal } })).executionContext
  }
  it('Q05 rolls back task supersession, child and Goal links without early lifecycle effects', async () => {
    const parent = await task(), child = await task('Fictional linked child',parent.id)
    const goal = (await owner.query(`INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,means,status,created_by_user_id,confirmed_at)
      VALUES($1,'task',$2,'Fictional linked outcome','{"kind":"subtasks"}','{}','active',$3,now()) RETURNING id`, [workspaceId,parent.id,userId])).rows[0].id
    const connection = await client(), effects: Array<() => void> = [], closed: string[] = []
    bindTaskClosedHook(value => closed.push(value.id))
    try {
      const updated = await updateTask(userId,parent.id,{ title: 'Fictional uncommitted successor',status: 'done' },undefined,{ access,expectedVersion: version(parent) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(updated).not.toBeNull(); expect(updated!.id).not.toBe(parent.id)
      expect(version(updated!)).toBe(String(BigInt(version(parent))+1n))
      expect((await connection.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(updated!.id)
      expect((await connection.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(updated!.id)
      expect(closed).toEqual([]); expect(effects).toHaveLength(1)
      await connection.query('ROLLBACK')
      expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[parent.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
      expect((await owner.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(parent.id)
      expect((await owner.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(parent.id)
      expect((await owner.query('SELECT id FROM tasks WHERE id=$1',[updated!.id])).rows).toEqual([])
      expect(closed).toEqual([])
    } finally { await connection.query('ROLLBACK'); connection.release(); bindTaskClosedHook(null) }
  })
  it('Q05 composes the canonical entity-backed company and task writers in one commit', async () => {
    const company = await createCompany(userId,{ workspaceId,name: `Fictional company ${randomUUID()}`,access,mergeByName: false }), before = await task()
    const connection = await client(), effects: Array<() => void> = []
    try {
      const changedCompany = await updateCompany(userId,company.id,{ name: 'Fictional revised company' },access,connection)
      const changedTask = await updateTask(userId,before.id,{ title: 'Fictional revised work' },undefined,{ access,expectedVersion: version(before) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(changedCompany?.id).toBe(company.id)
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe(company.name)
      expect((await owner.query('SELECT valid_to FROM tasks WHERE id=$1',[before.id])).rows[0].valid_to).toBeNull()
      await connection.query('COMMIT'); for (const effect of effects) effect()
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe('Fictional revised company')
      expect((await getTaskById(access,changedTask!.id))?.title).toBe('Fictional revised work')
      expect(version(changedTask!)).toBe(String(BigInt(version(before))+1n))
    } finally { await connection.query('ROLLBACK'); connection.release() }
  })
  it('Q05 lets exactly one canonical CAS writer win and refuses a stale predecessor precondition', async () => {
    const before = await task()
    const results = await Promise.allSettled(['Fictional first edit','Fictional second edit'].map(title =>
      updateTask(userId,before.id,{ title },undefined,{ access,expectedVersion: version(before) })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.code).toBe('record_version_conflict')
    expect((await owner.query('SELECT id FROM tasks WHERE workspace_id=$1 AND valid_to IS NULL AND title=ANY($2::text[])',[workspaceId,['Fictional first edit','Fictional second edit']])).rows).toHaveLength(1)
  })
  it.each([{ unknown: 'not a field' },{ title: '' },{ status: 'invented' },{ due: 'not a Date' }])('Q04 refuses invalid native patch %j at the canonical writer', async fields => {
    const before = await task()
    await expect(updateTask(userId,before.id,fields as TaskUpdateFields,undefined,{ access })).rejects.toMatchObject({ code: 'invalid_value' })
    expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[before.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
  })
  it('Q05 serializes canonical CRM attribute merges and keeps business changes outside metadata epochs',async () => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional merge ${randomUUID()}`,access,mergeByName:false})
    const invocation=await execution()
    const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0].version
    const results=await Promise.all([
      updateCompany(userId,company.id,{domain:'fictional.example'},access),
      updateCompany(userId,company.id,{tags:['fictional-category']},access),
    ])
    expect(results.every(value => value?.id===company.id)).toBe(true)
    const current=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0]
    expect(current.attributes).toMatchObject({domain:'fictional.example',tags:['fictional-category']})
    expect(current.version).toBe(String(BigInt(before)+2n))
    await expect(invocation.security.authority.assertCurrent()).resolves.toBeUndefined()
  })
  it('Q05 admits one canonical CRM CAS edit and preserves its ID and references on stale refusal',async () => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional CAS ${randomUUID()}`,access,mergeByName:false})
    const contact=await createContact(userId,{workspaceId,name:'Fictional linked contact',companyId:company.id,access})
    const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0].version
    const outcomes=await Promise.allSettled(['Fictional CAS first','Fictional CAS second'].map(name =>
      updateCompany(userId,company.id,{name},access,undefined,undefined,{expectedVersion:before})))
    expect(outcomes.filter(outcome => outcome.status==='fulfilled')).toHaveLength(1)
    const denied=outcomes.find(outcome => outcome.status==='rejected')
    expect(denied?.status==='rejected' && denied.reason.code).toBe('record_version_conflict')
    const current=(await owner.query('SELECT id,scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0]
    expect(current).toEqual({id:company.id,version:String(BigInt(before)+1n)})
    expect((await owner.query("SELECT attributes->>'company_id' AS company FROM entities WHERE id=$1",[contact.id])).rows[0].company).toBe(company.id)
    await expect(updateCompany(userId,company.id,{domain:'stale.example'},access,undefined,undefined,{expectedVersion:before})).rejects.toMatchObject({code:'record_version_conflict'})
    expect((await owner.query("SELECT attributes ? 'domain' AS present FROM entities WHERE id=$1",[company.id])).rows[0].present).toBe(false)
  })
  it('Q04 refuses immutable and invalid create keys through every typed canonical CRM writer',async () => {
    const invalid=await Promise.allSettled([
      createCompany(userId,{workspaceId,name:'Fictional creation',access,immutableId:randomUUID()} as Parameters<typeof createCompany>[1]),
      createContact(userId,{workspaceId,name:'Fictional creation',access,phone:17} as unknown as Parameters<typeof createContact>[1]),
      createDeal(userId,{workspaceId,access,stage:'invented'} as unknown as Parameters<typeof createDeal>[1]),
    ])
    expect(invalid.every(outcome => outcome.status==='rejected' && outcome.reason.code==='invalid_value')).toBe(true)
    expect((await owner.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name='Fictional creation'",[workspaceId])).rows).toEqual([])
  })
  it('Q05 serializes the legacy stage writer with canonical field patches',async () => {
    const deal=await createDeal(userId,{workspaceId,access})
    const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0].version
    await Promise.all([setDealStage(userId,deal.id,'won',access),updateDeal(userId,deal.id,{amount:42},undefined,access)])
    expect((await owner.query("SELECT attributes->>'stage' AS stage,attributes->>'amount' AS amount FROM entities WHERE id=$1",[deal.id])).rows[0]).toEqual({stage:'won',amount:'42'})
    await expect(setDealStage(userId,deal.id,'lost',access,undefined,undefined,{expectedVersion:version})).rejects.toMatchObject({code:'record_version_conflict'})
  })
  it.each([
    { kind: 'company',fields: { invented: 'unregistered field' } },
    { kind: 'company',fields: { name: '' } },
    { kind: 'company',fields: { domain: 17 } },
    { kind: 'company',fields: { tags: ['valid',17] } },
    { kind: 'person',fields: { phone: { invalid: 'object' } } },
    { kind: 'person',fields: { companyId: 'not-a-uuid' } },
    { kind: 'deal',fields: { amount: Number.POSITIVE_INFINITY } },
    { kind: 'deal',fields: { closeDate: new Date('not-a-date') } },
    { kind: 'deal',fields: { stage: 'won' } },
  ])('Q04 refuses invalid canonical CRM $kind patch before changing storage: $fields',async ({kind,fields}) => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional validation ${randomUUID()}`,access,mergeByName:false})
    const record=kind==='company' ? company : kind==='person' ? await createContact(userId,{workspaceId,name:'Fictional contact',access})
      : await createDeal(userId,{workspaceId,companyId:company.id,access})
    const before=(await owner.query('SELECT display_name,attributes,scope_version::text FROM entities WHERE id=$1',[record.id])).rows[0]
    const write=kind==='company' ? () => updateCompany(userId,record.id,fields as CompanyUpdateFields,access)
      : kind==='person' ? () => updateContact(userId,record.id,fields as ContactUpdateFields,undefined,access)
      : () => updateDeal(userId,record.id,fields as DealUpdateFields,undefined,access)
    await expect(write()).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,scope_version::text FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
  })
  it('Q06 commits a registered multi-task command and its receipt/audit/outbox exactly once, with complete rollback on refusal', async () => {
    const first = await task(), second = await task(), input = z.object({ ids: z.array(z.string().uuid()).length(2),versions: z.array(z.string()).length(2),title: z.string().min(1) }).strict()
    const module: ApplicationModuleDefinition<PoolClient> = { key: 'native_operation_fixture',defaultState: 'enabled',application: {
      version: '1',dependencies: [],resources: [],queries: [],commands: ['rename_pair'],events: ['native_operation_fixture.changed'],policyCapabilities: [],backgroundHandlers: [],uiContributions: [] },queries: {},commands: {
      rename_pair: { input,eventKey: 'native_operation_fixture.changed',authorize: async (context,raw) => {
        for (const id of input.parse(raw).ids) if (!await resolveTaskById(context.execution.security.access,id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      },execute: async (context,raw) => {
        const value = input.parse(raw),refs = []
        for (const [index,id] of value.ids.entries()) {
          const updated = await updateTask(userId,id,{ title: value.title },undefined,{ access: context.execution.security.access,expectedVersion: value.versions[index] },
            { client: context.transaction,afterCommit: context.afterCommit })
          if (!updated) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
          refs.push({ workspaceId,origin: { kind: 'native' as const,moduleKey: 'native' },typeKey: 'task',id: updated.id,version: version(updated) })
        }
        return refs
      },authorizeResult: async (context,refs) => {
        for (const ref of refs) if (!await getTaskById(context.execution.security.access,ref.id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      } },
    } }
    const service = new ApplicationPlatformService([module]), identity = await execution(), key = randomUUID()
    const failed = { idempotencyKey: key,input: { ids: [first.id,second.id],versions: [version(first),'999'],title: 'Fictional rolled back pair' } }
    await expect(service.command(identity,module.key,'rename_pair',failed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    expect((await owner.query('SELECT id FROM tasks WHERE id=ANY($1::uuid[]) AND valid_to IS NULL',[[first.id,second.id]])).rows).toHaveLength(2)
    expect((await owner.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1',[key])).rows).toEqual([])
    const command = { idempotencyKey: randomUUID(),input: { ids: [first.id,second.id],versions: [version(first),version(second)],title: 'Fictional committed pair' } }
    const committed = await service.command(identity,module.key,'rename_pair',command), replay = await service.command(identity,module.key,'rename_pair',command)
    expect(replay.id).toBe(committed.id); expect(committed.resources).toHaveLength(2)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT resources::text FROM application_operation_receipts WHERE id=$1',[committed.id])).rows[0].resources).not.toContain('Fictional committed pair')
    // Replay is governed by current native visibility; another actual member
    // retains access to the same source after this caller loses its audience.
    await owner.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[committed.resources[0].id,readerId])
    await expect(service.command(identity,module.key,'rename_pair',command)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(await getTaskById({ ...access,userId: readerId },committed.resources[0].id)).not.toBeNull()
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
  })
  it('Q04/Q05 preserves an exact native decimal amount through canonical creation, get and list',async () => {
    const amount='9007199254740993.123456789012345678'
    const value=await createDeal(userId,{workspaceId,amount:amount as unknown as number,access})
    expect(value.amount).toBe(amount)
    const dispatcher=new ApplicationPlatformService([(await import('../native-adapters.js')).createCanonicalNativeApplicationModule()])
    expect((await dispatcher.query(await execution(),'native','get',{type:'deal',id:value.id}) as {values:Record<string,unknown>}).values.amount).toBe(amount)
    expect((await getDealById(access,value.id))?.amount).toBe(amount)
    expect((await listDeals(access,{})).find(row => row.id===value.id)?.amount).toBe(amount)
    expect((await owner.query("SELECT attributes->>'amount' AS amount FROM entities WHERE id=$1",[value.id])).rows[0].amount).toBe(amount)
  })
  it('Q04/Q05 preserves an exact decimal patch, source identity and version',async () => {
    const before=await createDeal(userId,{workspaceId,amount:12,access}),amount='9007199254740993.000000000000000001'
    const prior=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[before.id])).rows[0].version
    expect(await updateDeal(userId,before.id,{amount:amount as unknown as number},undefined,access)).toMatchObject({id:before.id,amount})
    expect((await getDealById(access,before.id))?.amount).toBe(amount)
    expect((await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[before.id])).rows[0].version).toBe(String(BigInt(prior)+1n))
  })
  it.each(['1e8','-1','NaN','01.2','1.1234567890123456789',9007199254740992])('Q04 refuses an invalid or already unsafe native amount: %s',async amount => {
    const before=await createDeal(userId,{workspaceId,amount:12,access})
    await expect(updateDeal(userId,before.id,{amount:amount as unknown as number},undefined,access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await getDealById(access,before.id))?.amount).toBe(12)
  })
  describe('[COMP:security/native-field-policy] canonical native CRM write admission',() => {
    const nativeOrigin={kind:'native',moduleKey:'native'}
    beforeAll(async () => {
      await owner.query(`CREATE SEQUENCE native_operation_field_fixture_seq;
        CREATE TABLE native_operation_field_fixture_epochs(workspace_id uuid PRIMARY KEY,revision bigint NOT NULL);
        CREATE FUNCTION native_operation_field_fixture_revision(w uuid) RETURNS text
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT coalesce((SELECT revision::text FROM public.native_operation_field_fixture_epochs WHERE workspace_id=w),'0') $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_revision(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_changed() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        DECLARE w uuid;BEGIN w:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
          INSERT INTO public.native_operation_field_fixture_epochs(workspace_id,revision) VALUES(w,nextval('public.native_operation_field_fixture_seq'))
            ON CONFLICT(workspace_id) DO UPDATE SET revision=nextval('public.native_operation_field_fixture_seq');RETURN NULL;END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_changed() FROM PUBLIC;
        CREATE TRIGGER native_operation_field_fixture_configuration AFTER INSERT OR UPDATE OR DELETE ON public.crm_field_definitions
          FOR EACH ROW EXECUTE FUNCTION native_operation_field_fixture_changed();
        CREATE FUNCTION native_operation_field_fixture_rules() RETURNS jsonb
        LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT '[{"key":"name","read":[],"write":[],"releaseReadTo":["external_user","service"],"releaseWriteTo":["service"]},
            {"key":"domain","read":[],"write":[],"releaseReadTo":["external_user","service"],"releaseWriteTo":["service"]},
            {"key":"tags","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"externalRef","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"custom.cost","read":[["finance"]],"write":[["finance"]],"releaseReadTo":[],"releaseWriteTo":[]}]'::jsonb $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_rules() FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_keys(w uuid) RETURNS jsonb
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT to_jsonb(ARRAY['name','domain','tags','externalRef']||ARRAY(SELECT 'custom.'||field_key FROM public.crm_field_definitions
            WHERE workspace_id=w AND entity_kind='company' AND archived_at IS NULL ORDER BY field_key)) $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_keys(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        DECLARE source jsonb;BEGIN
          IF o<>'{"kind":"native","moduleKey":"native"}'::jsonb OR t<>'company' THEN RETURN NULL;END IF;
          source:=public.read_scope_source(w,'entity',i::uuid);
          RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion',public.native_operation_field_fixture_revision(w),
            'policyVersion','1','recordVersion',source->>'version','fieldKeys',public.native_operation_field_fixture_keys(w),
            'fields',public.native_operation_field_fixture_rules(),'source',source);END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_reader(uuid,jsonb,text,text) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        BEGIN
          IF o<>'{"kind":"native","moduleKey":"native"}'::jsonb OR t<>'company' THEN RETURN NULL;END IF;
          RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion',public.native_operation_field_fixture_revision(w),
            'policyVersion','1','fieldKeys',public.native_operation_field_fixture_keys(w),'fields',public.native_operation_field_fixture_rules(),
            'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_catalog(uuid,jsonb,text) FROM PUBLIC`)
      await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'cost',label:'Fictional cost',fieldType:'number'})
      await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
        VALUES('native','1',ARRAY['finance'],'native_operation_field_fixture_reader(uuid,jsonb,text,text)'::regprocedure,
          'native_operation_field_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'native_operation_field_fixture_revision(uuid)'::regprocedure)`)
      await owner.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,'company','native')",[workspaceId,nativeOrigin])
      // The provisioning actor has an explicit current field role; tested
      // ordinary readers never inherit owner status or that assignment.
      await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$2)",[workspaceId,userId])
    })
    afterAll(async () => {
      await owner.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
      await owner.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
      await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await owner.query('DROP TRIGGER native_operation_field_fixture_configuration ON crm_field_definitions')
      await owner.query('DROP FUNCTION native_operation_field_fixture_reader(uuid,jsonb,text,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_catalog(uuid,jsonb,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_keys(uuid)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_rules()')
      await owner.query('DROP FUNCTION native_operation_field_fixture_revision(uuid)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_changed()')
      await owner.query('DROP TABLE native_operation_field_fixture_epochs')
      await owner.query('DROP SEQUENCE native_operation_field_fixture_seq')
    })
    async function company() {
      const value=await createCompany(userId,{workspaceId,name:`Fictional protected company ${randomUUID()}`,access,mergeByName:false})
      await updateCrmCustomFields({ctx:access,entityId:value.id,values:{cost:42}})
      return value
    }
    async function member<T>(actor:string,operation:(client:PoolClient)=>Promise<T>) {
      const connection=await getAppPool().connect()
      try {await connection.query('BEGIN');await applyRLSGucs(connection,actor);const value=await operation(connection);await connection.query('COMMIT');return value}
      finally {await connection.query('ROLLBACK');connection.release()}
    }
    const reader={...access,userId:readerId}
    async function snapshot(id:string) {return (await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[id])).rows[0]}
    it.each([43,42])('Q04 refuses a protected native custom write of %s, including an equal hidden value',async cost => {
      const value=await company(),before=await snapshot(value.id)
      const mask=await member(readerId,async connection => (await connection.query('SELECT read_native_application_field_mask($1,$2,$3,$4,$5) AS value',
        [workspaceId,nativeOrigin,'company',value.id,before.version])).rows[0].value)
      expect(mask.writeFields).not.toContain('custom.cost')
      await expect(updateCrmCustomFields({ctx:reader,entityId:value.id,values:{cost}})).rejects.toMatchObject({code:'access_unavailable'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 refuses protected native fields through the canonical raw entity writer',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(updateEntity(readerId,value.id,{attributes:{...before.attributes,custom_fields:{cost:43}}},reader)).rejects.toMatchObject({code:'access_unavailable'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 keeps actual nonowner raw SQL behind the same protected native field boundary',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}','43') WHERE id=$1",[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 refuses a raw equal attribute replacement without typed partial intent',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query('UPDATE entities SET attributes=attributes WHERE id=$1',[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it.each(['aliases=aliases',"aliases=ARRAY['Fictional alias']"])('Q04 refuses undeclared canonical alias fields through raw SQL: %s',async assignment => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query(`UPDATE entities SET ${assignment} WHERE id=$1`,[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 does not let a spoofed allowed partial intent hide an actual hidden-field change',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => {
        await connection.query("SELECT set_config('app.native_entity_write_intent',$1,true)",[JSON.stringify({workspaceId,typeKey:'company',id:value.id,fields:['domain']})])
        return (await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}','43') WHERE id=$1",[value.id])).rowCount
      })).rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 scopes partial intent to its exact native record, including equal assignments',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => {
        await connection.query("SELECT set_config('app.native_entity_write_intent',$1,true)",[JSON.stringify({workspaceId,typeKey:'company',id:randomUUID(),fields:['domain']})])
        return (await connection.query('UPDATE entities SET attributes=attributes WHERE id=$1',[value.id])).rowCount
      })).rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04/Q05 lets a typed allowed native domain edit preserve an unreadable custom field and source identity',async () => {
      const value=await company(),before=await snapshot(value.id)
      expect(await updateCompany(readerId,value.id,{domain:'native-fields.example'},reader)).toMatchObject({id:value.id,domain:'native-fields.example'})
      const after=await snapshot(value.id)
      expect(after.attributes.custom_fields).toEqual({cost:42})
      expect(after.version).toBe(String(BigInt(before.version)+1n))
    })
  })

})
