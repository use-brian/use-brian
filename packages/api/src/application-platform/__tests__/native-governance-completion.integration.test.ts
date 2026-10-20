/** Real native owner/configuration governance over private deployed ports. */
import { randomUUID } from 'node:crypto'
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest'
import { z } from 'zod'
import { CrmOperationsCommandSchema,type CrmOperationsContext } from '@use-brian/core'
import {createWorkspaceModulesStore} from '../../db/workspace-modules-store.js'
import {createDbCrmOperationsStore} from '../../db/crm-operations-store.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import type { PoolClient } from 'pg'
import { applyRLSGucs,getAppPool,getPool } from '../../db/client.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { buildNativeApplicationGovernanceMcpTools } from '../mcp.js'
import { createCompany,createContact,createDeal,getCompanyById } from '../../db/crm.js'
import { createEntity } from '../../db/entities-store.js'
import { createTask } from '../../db/tasks.js'
import {createCrmPipeline,createCrmStage,updateCrmPipeline,updateCrmStage,setCrmStageArchived,reorderCrmPipelines,reorderCrmStages,createCrmFieldDefinition,updateCrmFieldDefinition,archiveCrmFieldDefinition,restoreCrmFieldDefinition,reorderCrmFields,updateCrmCustomFields} from '../../db/crm-r2.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe('[COMP:api/application-governance] complete native owner and compiled configuration reviews',()=>{
  const owner=getPool(),service=new ApplicationPlatformService([]),ownerId=randomUUID(),memberId=randomUUID(),independentId=randomUUID()
  let workspaceId:string,assistantId:string
  const inputFields=[{key:'mode',kind:'enum',required:true,values:['manual','automatic']},{key:'note',kind:'text',required:false,maxLength:32},
    {key:'enabled',kind:'boolean',required:false},{key:'threshold',kind:'integer',required:false}]
  beforeAll(async()=>{
    for(const id of [ownerId,memberId,independentId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
    await owner.query(`CREATE SEQUENCE native_governance_fixture_seq;
      CREATE TABLE native_governance_fixture_configuration(workspace_id uuid PRIMARY KEY,revision bigint NOT NULL DEFAULT nextval('native_governance_fixture_seq'),mode text NOT NULL DEFAULT 'manual',blocked_record uuid);
      CREATE FUNCTION native_governance_fixture_revision(w uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT revision::text FROM public.native_governance_fixture_configuration WHERE workspace_id=w $$;
      REVOKE ALL ON FUNCTION native_governance_fixture_revision(uuid) FROM PUBLIC;
      CREATE FUNCTION native_governance_fixture_keys(w uuid,t text) RETURNS text[] LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT ARRAY(SELECT DISTINCT key FROM (SELECT unnest(public.application_native_field_keys(t)) key UNION ALL SELECT 'custom.'||f.field_key FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=t AND f.archived_at IS NULL) k ORDER BY key) $$;
      REVOKE ALL ON FUNCTION native_governance_fixture_keys(uuid,text) FROM PUBLIC;
      CREATE FUNCTION native_governance_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE keys text[];fields jsonb;revision text;
      BEGIN
       keys:=public.native_governance_fixture_keys(w,t);revision:=public.native_governance_fixture_revision(w);
       SELECT jsonb_agg(jsonb_build_object('key',key,'read','[["controller"]]'::jsonb,'write','[["controller"]]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) INTO fields FROM unnest(keys) key;
       RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','native-governance-v1','policyVersion',revision,'fieldKeys',keys,'fields',fields,
        'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));
      END $$;
      REVOKE ALL ON FUNCTION native_governance_fixture_catalog(uuid,jsonb,text) FROM PUBLIC;
      CREATE FUNCTION native_governance_fixture_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE catalog jsonb;source jsonb;blocked uuid;
      BEGIN
       catalog:=public.native_governance_fixture_catalog(w,o,t);source:=public.read_scope_source(w,CASE t WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' WHEN 'workspace_member' THEN 'workspace_member' ELSE 'entity' END,i::uuid);
       IF source IS NULL THEN RETURN NULL;END IF;
       SELECT blocked_record INTO blocked FROM public.native_governance_fixture_configuration WHERE workspace_id=w;
       IF blocked=i::uuid THEN catalog:=jsonb_set(catalog,'{fields}',(SELECT jsonb_agg(jsonb_set(jsonb_set(f,'{read}','[["secondary"]]'),'{write}','[["secondary"]]')) FROM jsonb_array_elements(catalog->'fields') f));END IF;
       RETURN (catalog-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);
      END $$;
      REVOKE ALL ON FUNCTION native_governance_fixture_metadata(uuid,jsonb,text,text) FROM PUBLIC;
      CREATE FUNCTION native_governance_fixture_configure(w uuid,input jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE revision text;BEGIN
       UPDATE public.native_governance_fixture_configuration SET mode=input->>'mode',revision=nextval('public.native_governance_fixture_seq') WHERE workspace_id=w RETURNING native_governance_fixture_configuration.revision::text INTO revision;
       RETURN revision;END $$;
      REVOKE ALL ON FUNCTION native_governance_fixture_configure(uuid,jsonb) FROM PUBLIC;
      CREATE FUNCTION native_governance_fixture_incomplete(w uuid,input jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      BEGIN UPDATE public.native_governance_fixture_configuration SET mode=input->>'mode' WHERE workspace_id=w;RETURN public.native_governance_fixture_revision(w);END $$;
      REVOKE ALL ON FUNCTION native_governance_fixture_incomplete(uuid,jsonb) FROM PUBLIC;
      INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
       VALUES('native','governance-v1',ARRAY['controller','secondary'],'native_governance_fixture_metadata(uuid,jsonb,text,text)'::regprocedure,'native_governance_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'native_governance_fixture_revision(uuid)'::regprocedure)`)
    await owner.query(`INSERT INTO application_native_configuration_operations(module_key,operation_key,input_fields,required_role_keys,apply_handler) VALUES('native','set_mode',$1,ARRAY['controller'],'native_governance_fixture_configure(uuid,jsonb)'::regprocedure)`,[JSON.stringify(inputFields)])
  })
  beforeEach(async()=>{
    workspaceId=randomUUID();assistantId=randomUUID()
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional native governance',$2,false)",[workspaceId,ownerId])
    for(const [id,role] of [[ownerId,'owner'],[memberId,'member'],[independentId,'admin']]) await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspaceId,id,role])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional native governor',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
    await owner.query('INSERT INTO native_governance_fixture_configuration(workspace_id) VALUES($1)',[workspaceId])
    await assign(ownerId);await assign(independentId)
  })
  afterEach(async()=>{await owner.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await owner.query('DELETE FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])})
  afterAll(async()=>{
    await owner.query("DELETE FROM application_native_configuration_operations WHERE module_key='native';DELETE FROM application_native_field_contracts WHERE module_key='native'")
    for(const name of ['native_governance_fixture_metadata(uuid,jsonb,text,text)','native_governance_fixture_catalog(uuid,jsonb,text)','native_governance_fixture_configure(uuid,jsonb)','native_governance_fixture_incomplete(uuid,jsonb)','native_governance_fixture_revision(uuid)','native_governance_fixture_keys(uuid,text)']) await owner.query(`DROP FUNCTION ${name}`)
    await owner.query('DROP TABLE native_governance_fixture_configuration;DROP SEQUENCE native_governance_fixture_seq')
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,independentId]])
    await getAppPool().end();await owner.end()
  })
  async function assign(userId:string,role='controller') {return (await owner.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at) VALUES($1,'native',$2,$3,$4,'2020-01-01T00:00:00Z') RETURNING id`,[workspaceId,userId,role,ownerId])).rows[0].id as string}
  async function execution(userId=ownerId) {return (await resolveExecutionContextSystem({userId,workspaceId,assistant:(await findAssistantById(assistantId))!,memberMode:'member',
    identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
    lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelId:'native-governance-fixture',channelType:'test',abortSignal:new AbortController().signal}})).executionContext}
  const catalog=(user=ownerId)=>execution(user).then(context=>service.governanceCatalog(context,{moduleKey:'native'}))
  const preview=async(operation:unknown,user=ownerId)=>service.previewGovernance(await execution(user),{moduleKey:'native',expectedRevision:(await catalog(user)).revision,operation})
  const configure=(mode='automatic')=>({kind:'configure',operationKey:'set_mode',input:{mode}})
  const apply=(review:{id:string},user=ownerId)=>execution(user).then(context=>service.applyGovernance(context,{reviewId:review.id}))
  async function asMember<T>(operation:(client:PoolClient)=>Promise<T>,user=ownerId) {const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,user);await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[assistantId]);return await operation(client)}finally{await client.query('ROLLBACK');client.release()}}
  async function protect(type:string) {await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}',$2,'native')`,[workspaceId,type])}
  async function source(type:string) {const access={workspaceId,userId:ownerId,assistantId,assistantKind:'primary' as const}
    if(type==='company')return (await createCompany(ownerId,{workspaceId,name:'Fictional governed company',access,mergeByName:false})).id
    if(type==='person')return (await createContact(ownerId,{workspaceId,name:'Fictional governed contact',access})).id
    if(type==='deal')return (await createDeal(ownerId,{workspaceId,access})).id
    if(type==='task')return (await createTask(ownerId,{workspaceId,title:'Fictional governed task',access})).id
    if(type==='workspace_member')return memberId
    return (await owner.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source) VALUES($1,'/fictional.txt','fictional.txt','fixture://fictional',$2,'user') RETURNING id`,[workspaceId,ownerId])).rows[0].id as string
  }
  it.each(['company','person','deal','task','file','workspace_member'])('Q07 previews, binds and governs canonical native %s without changing its values or identity',async type=>{
    const id=await source(type),old=await execution(),review=await preview({kind:'bind_native_owner',typeKey:type})
    await expect(old.security.authority.assertCurrent()).resolves.toBeUndefined()
    expect((await owner.query('SELECT resource_type FROM application_native_resource_owners WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
    const result=await apply(review);expect(result).toMatchObject({kind:'bind_native_owner',typeKey:type,resourceId:workspaceId,applied:true})
    expect(await apply(review)).toEqual(result);expect(await catalog()).toMatchObject({moduleKey:'native'})
    expect((await owner.query('SELECT operation_kind FROM application_native_governance_events WHERE review_id=$1',[review.id])).rows).toEqual([{operation_kind:'bind_native_owner'}])
    expect(JSON.stringify(result)).not.toContain('Fictional governed');expect(id).toMatch(/^[0-9a-f-]{36}$/)
    await expect(preview({kind:'bind_native_owner',typeKey:type})).rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q03/Q07 keeps native owner/member and record-specific field ceilings before module governance',async()=>{
    const id=await source('company');await protect('company')
    const assignment=(await catalog()).roleAssignments.find(row=>row.userId===ownerId)!
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment.id])
    await expect(catalog()).rejects.toMatchObject({code:'access_unavailable'})
    await assign(memberId);await expect(catalog(memberId)).rejects.toMatchObject({code:'access_unavailable'})
    expect(await catalog(independentId)).toMatchObject({moduleKey:'native'})
    await owner.query("UPDATE native_governance_fixture_configuration SET blocked_record=$2,revision=nextval('native_governance_fixture_seq') WHERE workspace_id=$1",[workspaceId,id])
    await expect(catalog(independentId)).rejects.toMatchObject({code:'access_unavailable'})
    await assign(independentId,'secondary');expect(await catalog(independentId)).toMatchObject({moduleKey:'native'})
  })
  it('Q07 rejects a proposed native restriction when any current row is not governed and rolls preview epochs back',async()=>{
    const id=await source('company');await owner.query("UPDATE native_governance_fixture_configuration SET blocked_record=$2,revision=nextval('native_governance_fixture_seq') WHERE workspace_id=$1",[workspaceId,id])
    const current=await execution();await expect(preview({kind:'bind_native_owner',typeKey:'company'})).rejects.toMatchObject({code:'access_unavailable'})
    await expect(current.security.authority.assertCurrent()).resolves.toBeUndefined()
    expect((await owner.query('SELECT resource_type FROM application_native_resource_owners WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
  })
  it('Q07 enumerates private typed configuration inputs in the native catalog and Brian profile without registration authority',async()=>{
    await source('company');await protect('company')
    const value=await catalog();expect(value.configurationOperations).toEqual([{operationKey:'set_mode',inputFields,requiredRoleKeys:['controller']}]);expect(value.operations).toContain('configure')
    const tools=await buildNativeApplicationGovernanceMcpTools(service,await execution(),'native'),tool=tools.find(value=>value.name==='applicationGovernancePreview')!
    const schema=z.object(tool.inputSchema);expect(schema.safeParse({moduleKey:'native',expectedRevision:value.revision,operation:configure()}).success).toBe(true)
    expect(schema.safeParse({moduleKey:'native',expectedRevision:value.revision,operation:configure('invented')}).success).toBe(false)
    await expect(asMember(client=>client.query("INSERT INTO application_native_configuration_operations(module_key,operation_key,input_fields,required_role_keys,apply_handler) VALUES('native','injected','[]',ARRAY['controller'],'native_governance_fixture_configure(uuid,jsonb)'::regprocedure)"))).rejects.toMatchObject({code:'42501'})
    await expect(preview({...configure(),handler:'injected'})).rejects.toMatchObject({code:'invalid_value'})
  })
  it('Q06/Q07 previews without configuration effects and commits an exact configuration review once with fresh recovery',async()=>{
    await source('company');await protect('company')
    const before=(await owner.query('SELECT * FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0],old=await execution(),review=await preview(configure())
    expect((await owner.query('SELECT * FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual(before)
    await expect(old.security.authority.assertCurrent()).resolves.toBeUndefined()
    const result=await apply(review);expect(result).toMatchObject({kind:'configure',applied:true,resourceId:workspaceId})
    const after=(await owner.query('SELECT * FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0]
    expect(after.mode).toBe('automatic');expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));expect(result.configurationRevision).toBe(after.revision)
    await expect(old.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
    expect(await apply(review)).toEqual(result);expect((await owner.query('SELECT * FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual(after)
    expect((await owner.query('SELECT count(*)::int count FROM application_native_governance_events WHERE review_id=$1',[review.id])).rows[0].count).toBe(1)
  })
  it('Q07 keeps invalid/incomplete private configuration handlers held and rolls their writes back',async()=>{
    await source('company');await protect('company')
    await owner.query("UPDATE application_native_configuration_operations SET apply_handler='native_governance_fixture_incomplete(uuid,jsonb)'::regprocedure WHERE module_key='native'")
    try{await expect(preview(configure())).rejects.toMatchObject({code:'access_unavailable'});expect((await owner.query('SELECT mode FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0].mode).toBe('manual')}
    finally{await owner.query("UPDATE application_native_configuration_operations SET apply_handler='native_governance_fixture_configure(uuid,jsonb)'::regprocedure WHERE module_key='native'")}
    await owner.query('GRANT EXECUTE ON FUNCTION native_governance_fixture_configure(uuid,jsonb) TO app_user')
    try{await expect(catalog()).rejects.toMatchObject({code:'access_unavailable'})}finally{await owner.query('REVOKE ALL ON FUNCTION native_governance_fixture_configure(uuid,jsonb) FROM app_user')}
    await owner.query("UPDATE application_native_field_contracts SET configuration_reader=NULL WHERE module_key='native'")
    try{await expect(catalog()).rejects.toMatchObject({reason:'authority_changed'})}finally{await owner.query("UPDATE application_native_field_contracts SET configuration_reader='native_governance_fixture_revision(uuid)'::regprocedure WHERE module_key='native'")}
  })
  it.each([{mode:'invented'},{},{mode:'manual',unknown:true},{mode:'manual',enabled:'yes'},{mode:'manual',threshold:1.5},{mode:'manual',note:'x'.repeat(33)}])('Q07 refuses unenumerated or malformed compiled configuration input %j',async input=>{
    await expect(preview({kind:'configure',operationKey:'set_mode',input})).rejects.toMatchObject({code:typeof input.threshold==='number'?'invalid_value':'access_unavailable'})
    expect((await owner.query('SELECT mode FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0].mode).toBe('manual')
  })
  it('Q02/Q07 holds an old configuration review after change/restore or role contraction while independent current readers remain usable',async()=>{
    const id=await source('company');await protect('company');const review=await preview(configure()),old=await execution()
    await apply(await preview(configure()));await apply(await preview(configure('manual')))
    await expect(apply(review)).rejects.toMatchObject({code:'record_version_conflict'});await expect(old.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
    const next=await preview(configure());await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])
    await expect(apply(next)).rejects.toMatchObject({code:'access_unavailable'})
    const independent=await getCompanyById({workspaceId,userId:independentId,assistantId,assistantKind:'primary'},id);expect(independent?.name).toBe('Fictional governed company')
    expect(await catalog(independentId)).toMatchObject({moduleKey:'native'})
  })
  it('Q04/Q07 routes every existing protected CRM configuration family through canonical typed reviews',async()=>{
    await source('company');await protect('company')
    const base={userId:ownerId,workspaceId},first=await createCrmPipeline({...base,name:'Fictional primary pipeline'}),second=await createCrmPipeline({...base,name:'Fictional second pipeline'})
    expect(first).toMatchObject({name:'Fictional primary pipeline',stages:[]})
    expect(await updateCrmPipeline({...base,pipelineId:first.id,isDefault:true})).toBe(true)
    const stage=await createCrmStage({...base,pipelineId:first.id,name:'Fictional stage',category:'open',probability:20})
    expect(stage).not.toBeNull();expect(await updateCrmStage({...base,stageId:stage!.id,name:'Fictional updated stage',probability:30})).toMatchObject({id:stage!.id,probability:30})
    expect(await setCrmStageArchived({...base,stageId:stage!.id,archived:true})).toBe(true);expect(await setCrmStageArchived({...base,stageId:stage!.id,archived:false})).toBe(true)
    await reorderCrmPipelines({...base,orderedIds:[second.id,first.id]});await reorderCrmStages({...base,pipelineId:first.id,orderedIds:[stage!.id]})
    const field=await createCrmFieldDefinition({...base,entityKind:'company',fieldKey:'fictional_note',label:'Fictional note',fieldType:'text'})
    expect(field).not.toBeNull();expect(await updateCrmFieldDefinition({...base,fieldId:field!.id,label:'Fictional renamed note'})).toMatchObject({id:field!.id,label:'Fictional renamed note'})
    expect(await archiveCrmFieldDefinition(ownerId,workspaceId,field!.id)).toBe(true);expect(await restoreCrmFieldDefinition(ownerId,workspaceId,field!.id)).toBe(true)
    await reorderCrmFields({...base,entityKind:'company',orderedIds:[field!.id]})
    const events=(await owner.query("SELECT operation_kind FROM application_native_governance_events WHERE workspace_id=$1",[workspaceId])).rows
    expect(events.length).toBe(14);expect(events.every(row=>row.operation_kind==='configure_crm')).toBe(true)
    expect((await owner.query('SELECT * FROM application_native_configuration_execution WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
    expect((await owner.query('SELECT name FROM crm_pipelines WHERE workspace_id=$1 ORDER BY position',[workspaceId])).rows.map(row=>row.name)).toEqual(['Fictional second pipeline','Fictional primary pipeline'])
  })
  it('Q06/Q07 reviews protected CRM commands optimistically and replays only their content-free applied outcome',async()=>{
    await source('company');await protect('company')
    const command={kind:'create_pipeline',name:'Fictional reviewed pipeline',isDefault:false},review=await preview({kind:'configure_crm',command})
    expect((await owner.query('SELECT id FROM crm_pipelines WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
    const result=await apply(review);expect(result).toMatchObject({kind:'configure_crm',subjectKind:'pipeline',created:true,changed:true,applied:true})
    expect(await apply(review)).toEqual(result);expect(JSON.stringify(result)).not.toContain('Fictional reviewed pipeline')
    const stale=await preview({kind:'configure_crm',command:{kind:'update_pipeline',pipelineId:result.resourceId,name:'Fictional reviewed rename'}})
    await updateCrmPipeline({workspaceId,userId:ownerId,pipelineId:result.resourceId,name:'Fictional intervening rename'})
    await expect(apply(stale)).rejects.toMatchObject({code:'record_version_conflict'})
    expect((await owner.query('SELECT name FROM crm_pipelines WHERE id=$1',[result.resourceId])).rows[0].name).toBe('Fictional intervening rename')
  })
  it('Q03/Q07 refuses protected raw CRM config writes, owner connections and missing current field roles',async()=>{
    await source('company');await protect('company')
    const sql="INSERT INTO crm_pipelines(workspace_id,name,is_default,position) VALUES($1,'Fictional unreviewed',false,0)"
    await expect(asMember(client=>client.query(sql,[workspaceId]))).rejects.toMatchObject({code:'42501'})
    await expect(asMember(client=>client.query("SELECT set_config('app.native_configuration_reviewed','true',true)").then(()=>client.query(sql,[workspaceId])))).rejects.toMatchObject({code:'42501'})
    const privileged=await owner.connect();try{await privileged.query('BEGIN');await applyRLSGucs(privileged,ownerId);await expect(privileged.query('SELECT application_execute_native_crm_configuration($1,$2,$3)',[workspaceId,assistantId,{kind:'create_pipeline',name:'Fictional owner connection'}])).rejects.toMatchObject({code:'42501'})}finally{await privileged.query('ROLLBACK');privileged.release()}
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])
    await expect(createCrmPipeline({userId:ownerId,workspaceId,name:'Fictional lost role'})).rejects.toMatchObject({code:'42501'})
    expect((await owner.query('SELECT id FROM crm_pipelines WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
    expect(await createCrmPipeline({userId:independentId,workspaceId,name:'Fictional independently current'})).toMatchObject({name:'Fictional independently current'})
  })
  it('Q04/Q07 rolls back unknown protected field vocabulary, malformed CRM commands and incomplete exact reorder requests',async()=>{
    await source('company');await protect('company')
    await expect(preview({kind:'configure_crm',command:{kind:'create_record_field',entityKind:'company',fieldKey:'fictional',label:'Fictional field',fieldType:'single_select',options:[]}})).rejects.toMatchObject({code:'invalid_value'})
    const pipeline=await createCrmPipeline({userId:ownerId,workspaceId,name:'Fictional exact order'})
    await expect(reorderCrmPipelines({userId:ownerId,workspaceId,orderedIds:[]})).rejects.toMatchObject({code:'42501'})
    expect((await owner.query('SELECT id,position FROM crm_pipelines WHERE workspace_id=$1',[workspaceId])).rows).toEqual([{id:pipeline.id,position:0}])
    await expect(preview({kind:'configure_crm',command:{kind:'create_pipeline',name:'Fictional command',handler:'injected'}})).rejects.toMatchObject({code:'invalid_value'})
  })
  it('Q06/Q07 serializes competing configuration reviews to one current outcome and one event',async()=>{
    await source('company');await protect('company')
    const first=await preview(configure()),second=await preview(configure('manual')),contexts=await Promise.all([execution(),execution()])
    const result=await Promise.allSettled([first,second].map((review,index)=>service.applyGovernance(contexts[index],{reviewId:review.id})))
    expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(result.filter(item=>item.status==='rejected')).toHaveLength(1)
    expect((await owner.query('SELECT count(*)::int count FROM application_native_governance_events WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(1)
  })
  const crmContext=(userId=ownerId):CrmOperationsContext=>({workspaceId,actor:{kind:'user',userId},authority:{role:userId===ownerId?'owner':'admin',canWrite:true,canConfigure:true,trustedIdentitySources:[]}})
  it('Q04/Q07 uses the actual canonical CRM service default store with native audit, review and event in one nonowner transaction',async()=>{
    await source('company');await protect('company')
    const canonical=createCrmOperationsService(createDbCrmOperationsStore()),result=await canonical.execute(crmContext(),CrmOperationsCommandSchema.parse({kind:'create_pipeline',name:'Fictional canonical service pipeline'}))
    expect(result).toMatchObject({created:true,record:{name:'Fictional canonical service pipeline'}})
    expect((await owner.query("SELECT actor_kind,acting_user_id FROM association_audit_log WHERE workspace_id=$1",[workspaceId])).rows).toEqual([{actor_kind:'user',acting_user_id:ownerId}])
    const review=(await owner.query('SELECT actor_user_id,outcome FROM application_native_governance_reviews WHERE workspace_id=$1',[workspaceId])).rows
    expect(review).toHaveLength(1);expect(review[0].actor_user_id).toBe(ownerId);expect(review[0].outcome).toMatchObject({kind:'configure_crm',applied:true})
    expect((await owner.query('SELECT count(*)::int count FROM application_native_governance_events WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(1)
  })
  it('Q02/Q06/Q07 rolls canonical CRM service domain/review/events back with its audit and refuses role contraction while an independent actor still succeeds',async()=>{
    await source('company');await protect('company')
    const canonical=createCrmOperationsService(createDbCrmOperationsStore()),command=CrmOperationsCommandSchema.parse({kind:'create_pipeline',name:'Fictional atomic canonical pipeline'})
    await owner.query(`CREATE FUNCTION native_governance_fixture_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional governance audit refusal';END $$;CREATE TRIGGER native_governance_fixture_audit_refusal BEFORE INSERT ON association_audit_log FOR EACH ROW WHEN (NEW.workspace_id='${workspaceId}'::uuid) EXECUTE FUNCTION native_governance_fixture_audit_refusal()`)
    try{await expect(canonical.execute(crmContext(),command)).rejects.toThrow('fictional governance audit refusal')
      for(const table of ['crm_pipelines','application_native_governance_reviews','application_native_governance_events']) expect((await owner.query(`SELECT count(*)::int count FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows[0].count).toBe(0)
    }finally{await owner.query('DROP TRIGGER native_governance_fixture_audit_refusal ON association_audit_log;DROP FUNCTION native_governance_fixture_audit_refusal()')}
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])
    await expect(canonical.execute(crmContext(),command)).rejects.toMatchObject({code:'not_authorized'})
    expect(await canonical.execute(crmContext(independentId),command)).toMatchObject({created:true,record:{name:'Fictional atomic canonical pipeline'}})
    expect((await owner.query('SELECT acting_user_id FROM association_audit_log WHERE workspace_id=$1',[workspaceId])).rows).toEqual([{acting_user_id:independentId}])
  })
  it('Q07 preserves typed module lifecycle blockers, CAS and audit under complete current native governance',async()=>{
    await source('company');await protect('company')
    let pending=1
    const modules=createWorkspaceModulesStore(owner,getAppPool(),{registry:{native:{key:'native',defaultState:'enabled'}},lifecycles:{native:{readBlockingWork:async()=>[{key:'pending',count:pending}]}}})
    const draining=await modules.act(workspaceId,ownerId,'native',{action:'request_disable',expectedVersion:0})
    expect(draining).toMatchObject({changed:true,module:{state:'draining',version:2},blockingWork:[{key:'pending',count:1}]})
    await expect(modules.act(workspaceId,ownerId,'native',{action:'finish_disable',expectedVersion:2})).rejects.toMatchObject({code:'module_drain_pending'})
    pending=0;expect(await modules.act(workspaceId,independentId,'native',{action:'finish_disable',expectedVersion:2})).toMatchObject({changed:true,module:{state:'disabled',version:3}})
    await expect(asMember(client=>client.query("UPDATE workspace_modules SET state='enabled',version=version+1,updated_by_user_id=$2 WHERE workspace_id=$1 AND module_key='native'",[workspaceId,ownerId]))).rejects.toMatchObject({code:'42501'})
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])
    await expect(modules.act(workspaceId,ownerId,'native',{action:'enable',expectedVersion:3})).rejects.toMatchObject({code:'not_authorized'})
    expect(await modules.act(workspaceId,independentId,'native',{action:'enable',expectedVersion:3})).toMatchObject({module:{state:'enabled',version:4}})
    expect((await owner.query("SELECT count(*)::int count FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'",[workspaceId])).rows[0].count).toBe(3)
    expect((await owner.query('SELECT * FROM application_native_module_lifecycle_reviews WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
  })
  it('Q07 holds module lifecycle after configuration change and restore during its blocker await',async()=>{
    await source('company');await protect('company')
    let changed=false
    const modules=createWorkspaceModulesStore(owner,getAppPool(),{registry:{native:{key:'native',defaultState:'enabled'}},lifecycles:{native:{readBlockingWork:async()=>{
      if(!changed){changed=true;await owner.query("UPDATE native_governance_fixture_configuration SET mode='automatic',revision=nextval('native_governance_fixture_seq') WHERE workspace_id=$1",[workspaceId]);await owner.query("UPDATE native_governance_fixture_configuration SET mode='manual',revision=nextval('native_governance_fixture_seq') WHERE workspace_id=$1",[workspaceId])}
      return []
    }}}})
    await expect(modules.act(workspaceId,ownerId,'native',{action:'request_disable',expectedVersion:0})).rejects.toMatchObject({code:'stale_module_version'})
    expect((await owner.query('SELECT id FROM workspace_audit_log WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
    expect((await owner.query("SELECT module_key FROM workspace_modules WHERE workspace_id=$1 AND module_key='native'",[workspaceId])).rows).toEqual([])
    expect(await modules.act(workspaceId,independentId,'native',{action:'request_disable',expectedVersion:0})).toMatchObject({module:{state:'disabled',version:2}})
  })
  it('Q04/Q07 validates required and option constraints against admitted canonical field values before a configuration change commits',async()=>{
    const id=await source('company');await protect('company');const base={userId:ownerId,workspaceId}
    await expect(createCrmFieldDefinition({...base,entityKind:'company',fieldKey:'required_note',label:'Fictional required note',fieldType:'text',isRequired:true})).rejects.toMatchObject({code:'42501'})
    expect((await owner.query("SELECT id FROM crm_field_definitions WHERE workspace_id=$1 AND field_key='required_note'",[workspaceId])).rows).toEqual([])
    const field=await createCrmFieldDefinition({...base,entityKind:'company',fieldKey:'fictional_tier',label:'Fictional tier',fieldType:'single_select',options:['retained','other']})
    await updateCrmCustomFields({ctx:{workspaceId,userId:ownerId,assistantId,assistantKind:'primary'},entityId:id,values:{fictional_tier:'retained'}})
    await expect(updateCrmFieldDefinition({...base,fieldId:field!.id,options:['other']})).rejects.toMatchObject({code:'42501'})
    expect((await owner.query('SELECT options,is_required FROM crm_field_definitions WHERE id=$1',[field!.id])).rows[0]).toEqual({options:['retained','other'],is_required:false})
    expect(await updateCrmFieldDefinition({...base,fieldId:field!.id,isRequired:true})).toMatchObject({isRequired:true,options:['retained','other']})
  })
  it('Q02/Q07 keeps configuration-only source revisions independent of role changes and monotonic through restore',async()=>{
    await source('company');await protect('company')
    const revision=async()=>String((await owner.query('SELECT application_native_crm_configuration_revision($1) AS revision',[workspaceId])).rows[0].revision)
    const before=await revision();await assign(memberId,'secondary');expect(await revision()).toBe(before)
    const pipeline=await createCrmPipeline({userId:ownerId,workspaceId,name:'Fictional stable config source'}),created=await revision()
    await updateCrmPipeline({userId:ownerId,workspaceId,pipelineId:pipeline.id,name:'Fictional changed config source'})
    await updateCrmPipeline({userId:ownerId,workspaceId,pipelineId:pipeline.id,name:'Fictional stable config source'})
    expect(BigInt(await revision())).toBeGreaterThan(BigInt(created));expect(BigInt(created)).toBeGreaterThan(BigInt(before))
    await expect(asMember(client=>client.query('SELECT application_native_crm_configuration_revision($1)',[workspaceId]))).rejects.toMatchObject({code:'42501'})
  })
  it('Q03/Q07 keeps configuration validation within its affected native family and holds inaccessible affected sources',async()=>{
    await source('company');await createEntity({workspaceId,kind:'person',displayName:'Fictional unrelated private contact',createdByUserId:independentId,userId:independentId,source:'user'})
    await protect('company')
    expect(await createCrmFieldDefinition({userId:ownerId,workspaceId,entityKind:'company',fieldKey:'local_note',label:'Fictional local note',fieldType:'text'})).toMatchObject({fieldKey:'local_note'})
    await createEntity({workspaceId,kind:'deal',displayName:'Fictional affected private deal',createdByUserId:independentId,userId:independentId,source:'user'})
    await expect(createCrmPipeline({userId:ownerId,workspaceId,name:'Fictional held affected config'})).rejects.toMatchObject({code:'42501'})
    expect(await createCrmPipeline({userId:independentId,workspaceId,name:'Fictional independently current config'})).toMatchObject({name:'Fictional independently current config'})
  })
  it('Q06/Q07 atomically rolls back configuration, review and event on a committed-event refusal',async()=>{
    await source('company');await protect('company');const review=await preview(configure())
    await owner.query(`ALTER TABLE application_native_governance_events ADD CONSTRAINT native_governance_fixture_refusal CHECK(review_id<>'${review.id}')`)
    try{await expect(apply(review)).rejects.toMatchObject({code:'invalid_value'});expect((await owner.query('SELECT mode FROM native_governance_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0].mode).toBe('manual')
      expect((await owner.query('SELECT outcome FROM application_native_governance_reviews WHERE id=$1',[review.id])).rows[0].outcome).toBeNull()
    }finally{await owner.query('ALTER TABLE application_native_governance_events DROP CONSTRAINT native_governance_fixture_refusal')}
    expect(await apply(review)).toMatchObject({applied:true})
  })
})
