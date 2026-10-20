/** Actual canonical native commands and legacy lineage, using guarded local PostgreSQL. */
import { randomUUID } from 'node:crypto'
import { beforeAll,afterAll,describe,it,expect } from 'vitest'
import { applicationJsonSchema } from '@use-brian/shared'
import { getPool,getAppPool,applyRLSGucs } from '../../db/client.js'
import { createCompany,createContact,createDeal,updateContact,updateDeal } from '../../db/crm.js'
import { createTask,updateTask,resolveTaskById } from '../../db/tasks.js'
import { createCrmFieldDefinition,getCrmConfig } from '../../db/crm-r2.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] native operation completion',()=>{
 const owner=getPool(),workspaceId=randomUUID(),userId=randomUUID(),otherId=randomUUID(),assistantId=randomUUID()
 const fixtureUsers=[userId,otherId]
 const access={workspaceId,userId,assistantId,assistantKind:'primary' as const}
 const service=()=>new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
 beforeAll(async()=>{
  for(const id of [userId,otherId])await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional native completion',$2,false)",[workspaceId,userId])
  for(const id of [userId,otherId])await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,id])
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional operation helper',$2,$3,'primary','confidential')",[assistantId,userId,workspaceId])
 })
 afterAll(async()=>{await owner.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[fixtureUsers]);await getAppPool().end();await owner.end()})
 async function execution(){return(await resolveExecutionContextSystem({userId,workspaceId,assistant:(await findAssistantById(assistantId))!,memberMode:'member',
  identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
  lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelId:'native-completion-fixture',channelType:'test',abortSignal:new AbortController().signal}})).executionContext}
 async function source(id:string){return(await owner.query('SELECT id,attributes,display_name,scope_version::text AS version FROM entities WHERE id=$1',[id])).rows[0]}
 async function history(id:string){return(await owner.query("SELECT version_no,before_image,mutation_reason FROM brain_row_versions WHERE primitive='entity' AND row_id=$1 ORDER BY version_no",[id])).rows}
 async function application(type:'company'|'person'|'deal'|'task',command:string,fields:string[],id?:string){
  const appId=randomUUID(),actor=randomUUID(),grantId=randomUUID();fixtureUsers.push(actor)
  await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1,'channel',$2)",[actor,`app-service:${appId}:${randomUUID()}`])
  await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id)
   VALUES($1,$2,'native','Fictional native command client','api_client',$3,$4)`,[appId,workspaceId,assistantId,userId])
  const selector=id?{kind:'ids',ids:[id]}:{kind:'self'}
  await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
   resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
   VALUES($1,$2,$3,'service',$4,$5,'{"kind":"native","moduleKey":"native"}',$6,$7,'{}',$8,$9::jsonb,'{}','{}','confidential',now()-interval '1 hour')`,
   [grantId,appId,workspaceId,actor,userId,type,[id?'patch':'create',`command:${command}`],fields,selector])
  const grant=(await owner.query('SELECT * FROM application_access_grants WHERE id=$1',[grantId])).rows[0]
  const maximum={version:1,grants:[{id:grantId,appId,workspaceId,principal:{kind:'service',userId:actor},origin:{kind:'native',moduleKey:'native'},typeKey:type,
   actions:grant.actions,readFields:[],writeFields:fields,selector,version:1,status:'active',startsAt:grant.starts_at.toISOString(),expiresAt:null,parentGrantId:null,
   compartments:[],projectIds:[],clearance:'confidential'}]}
  const secret=await mintApplicationCredentialSecret()
  await owner.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
   VALUES($1,$2,$3,$4,$5,'Fictional native write-only credential','service',$6,$7,now()+interval '1 hour')`,[secret.id,appId,workspaceId,userId,actor,secret.secretHash,grantId])
  await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',[secret.id,appId,workspaceId,grantId,maximum])
  const credential=await authenticateApplicationCredential(secret.token,appId,loadApplicationCredentialStateSystem)
  expect(credential).not.toBeNull()
  return{grantId,context:()=>resolveApplicationExecutionContext({credential:credential!})}
 }
 it('Q04/Q05 creates full typed CRM fields in one canonical initial row',async()=>{
  const api=service()
  const field=await createCrmFieldDefinition({userId,workspaceId,entityKind:'person',fieldKey:'completion_note',label:'Fictional note',fieldType:'text'})
  try{
   const ctx=await execution()
   const company=(await api.command(ctx,'native','create_company',{idempotencyKey:randomUUID(),input:{name:'Fictional typed company',domain:'typed.example',aliases:[' Trading Alias '],tags:['initial'],externalRef:{provider:'fictional',id:'typed-1'}}})).resources[0]
   const contact=(await api.command(ctx,'native','create_contact',{idempotencyKey:randomUUID(),input:{name:'Fictional typed contact',email:'typed@example.com',phone:'+1 202 555 0123',companyId:company.id,tags:['initial'],customFields:{completion_note:'created together'}}})).resources[0]
   const deal=(await api.command(ctx,'native','create_deal',{idempotencyKey:randomUUID(),input:{name:'Fictional typed opportunity',companyId:company.id,contactId:contact.id,amount:'9007199254740993.123456789012345678',closeDate:'2026-11-30',currencyCode:'USD',source:'synthetic',probability:42,tags:['new']}})).resources[0]
   expect((await source(company.id)).attributes.tags).toEqual(['initial'])
   expect((await owner.query('SELECT aliases FROM entities WHERE id=$1',[company.id])).rows[0].aliases).toEqual(['trading alias'])
   expect((await source(contact.id)).attributes).toMatchObject({company_id:company.id,custom_fields:{completion_note:'created together'}})
   expect(await source(deal.id)).toMatchObject({display_name:'Fictional typed opportunity',version:'1',attributes:{amount:'9007199254740993.123456789012345678',currency_code:'USD',source:'synthetic'}})
   expect(await history(deal.id)).toEqual([])
  }finally{await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[field!.id])}
 })
 it.each(['person','deal'] as const)('Q05 preserves %s identity, appends one canonical history version and reauthorizes exactly-once replay',async type=>{
  const record=type==='person'?await createContact(userId,{workspaceId,access,name:'Fictional canonical contact'}):await createDeal(userId,{workspaceId,access})
  const before=await source(record.id),api=service(),ctx=await execution(),key=randomUUID()
  const input=applicationJsonSchema.parse(type==='person'?{id:record.id,patch:{phone:'+1 202 555 0199'}}:{id:record.id,patch:{name:'Fictional changed opportunity',amount:'21.000000000000000001',currencyCode:'EUR'}})
  const command=type==='person'?'patch_contact':'patch_deal'
  const result=await api.command(ctx,'native',command,{idempotencyKey:key,expectedVersion:before.version,input})
  expect(result.resources[0]).toMatchObject({id:record.id,typeKey:type,version:String(BigInt(before.version)+1n)})
  expect(await api.command(ctx,'native',command,{idempotencyKey:key,expectedVersion:before.version,input})).toEqual(result)
  expect(await history(record.id)).toHaveLength(1)
  expect((await history(record.id))[0].before_image.id).toBe(record.id)
  expect((await owner.query('SELECT id FROM application_command_audit WHERE receipt_id=$1',[result.id])).rows).toHaveLength(1)
  expect((await owner.query('SELECT resources FROM application_committed_events WHERE receipt_id=$1',[result.id])).rows).toEqual([{resources:result.resources}])
  await expect(api.command(ctx,'native',command,{idempotencyKey:randomUUID(),expectedVersion:before.version,input})).rejects.toMatchObject({code:'record_version_conflict'})
  expect(await history(record.id)).toHaveLength(1)
 })
 it('Q06 rolls back mixed canonical CRM patches, histories and receipts when any expected source version is stale',async()=>{
  const company=await createCompany(userId,{workspaceId,access,name:'Fictional mixed company'}),person=await createContact(userId,{workspaceId,access,name:'Fictional mixed person'})
  const first=await source(company.id),second=await source(person.id),key=randomUUID()
  await expect(service().command(await execution(),'native','patch_records',{idempotencyKey:key,input:{patches:[
   {type:'company',id:company.id,expectedVersion:first.version,patch:{domain:'rollback.example'}},
   {type:'person',id:person.id,expectedVersion:String(BigInt(second.version)+1n),patch:{phone:'+1 202 555 0110'}}]}})).rejects.toMatchObject({code:'record_version_conflict'})
  expect(await source(company.id)).toEqual(first);expect(await source(person.id)).toEqual(second)
  expect(await history(company.id)).toEqual([]);expect(await history(person.id)).toEqual([])
  expect((await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows).toEqual([])
 })
 it('Q05 applies relationship, custom, stage and archive semantic commands through the canonical version',async()=>{
  const api=service(),ctx=await execution(),company=await createCompany(userId,{workspaceId,access,name:'Fictional relationship company'}),person=await createContact(userId,{workspaceId,access,name:'Fictional relationship person'}),deal=await createDeal(userId,{workspaceId,access})
  const invoke=async(command:string,input:unknown,id=deal.id)=>api.command(await execution(),'native',command,{idempotencyKey:randomUUID(),expectedVersion:(await source(id)).version,input:applicationJsonSchema.parse(input)})
  await invoke('set_relationship',{type:'deal',id:deal.id,field:'companyId',targetId:company.id})
  await invoke('set_relationship',{type:'deal',id:deal.id,field:'contactId',targetId:person.id})
  await invoke('set_deal_stage',{id:deal.id,stage:'proposal'})
  const stage=(await getCrmConfig(userId,workspaceId)).pipelines[0].stages.find(row=>row.legacyKey==='won')!
  await invoke('move_deal',{id:deal.id,stageId:stage.id})
  await invoke('archive_record',{type:'deal',id:deal.id,archived:true})
  expect((await source(deal.id)).attributes).toMatchObject({company_id:company.id,contact_id:person.id,pipeline_stage_id:stage.id,stage:'won',crm_archived_at:expect.any(String)})
  await invoke('archive_record',{type:'deal',id:deal.id,archived:false})
  expect((await source(deal.id)).attributes.crm_archived_at).toBeUndefined()
  expect(await history(deal.id)).toHaveLength(6)
 })
 it('Q05 versions participant and primary contact commands once with one immutable relationship before-image',async()=>{
  const api=service(),deal=await createDeal(userId,{workspaceId,access}),first=await createContact(userId,{workspaceId,access,name:'Fictional first participant'}),second=await createContact(userId,{workspaceId,access,name:'Fictional second participant'})
  const invoke=async(command:string,input:unknown)=>{const before=await source(deal.id);const result=await api.command(await execution(),'native',command,{idempotencyKey:randomUUID(),expectedVersion:before.version,input:applicationJsonSchema.parse(input)})
   expect(result.resources[0].version).toBe(String(BigInt(before.version)+1n));return result}
  await invoke('add_deal_participant',{id:deal.id,contactId:first.id,role:'Fictional evaluator',isPrimary:false})
  await invoke('set_primary_contact',{id:deal.id,contactId:second.id})
  expect((await source(deal.id)).attributes.contact_id).toBe(second.id)
  expect((await owner.query('SELECT contact_id,is_primary FROM crm_deal_contacts WHERE deal_id=$1 ORDER BY contact_id',[deal.id])).rows).toEqual([
   {contact_id:first.id,is_primary:false},{contact_id:second.id,is_primary:true}].sort((a,b)=>a.contact_id.localeCompare(b.contact_id)))
  await invoke('remove_deal_participant',{id:deal.id,contactId:second.id})
  expect((await source(deal.id)).attributes.contact_id).toBeUndefined()
  const revisions=await history(deal.id);expect(revisions).toHaveLength(3)
  expect(revisions[0].before_image.native_participants).toEqual([])
  expect(revisions[2].before_image.native_participants).toEqual(expect.arrayContaining([{contactId:first.id,isPrimary:false,role:'Fictional evaluator'},{contactId:second.id,isPrimary:true,role:null}]))
  const before=await source(deal.id)
  await expect(api.command(await execution(),'native','add_deal_participant',{idempotencyKey:randomUUID(),expectedVersion:before.version,input:{id:deal.id,contactId:randomUUID()}})).rejects.toMatchObject({code:'access_unavailable'})
  expect(await source(deal.id)).toEqual(before);expect(await history(deal.id)).toHaveLength(3)
 })
 it('Q05 captures canonical history for legacy contact/deal writers and raw nonowner native SQL',async()=>{
  const contact=await createContact(userId,{workspaceId,access,name:'Fictional legacy completion contact'}),deal=await createDeal(userId,{workspaceId,access})
  await updateContact(userId,contact.id,{phone:'+1 202 555 0155'},undefined,access)
  await updateDeal(userId,deal.id,{amount:'13.25'},undefined,access)
  const connection=await getAppPool().connect()
  try{await connection.query('BEGIN');await applyRLSGucs(connection,userId);await connection.query("UPDATE entities SET display_name='Fictional raw changed contact' WHERE id=$1",[contact.id]);await connection.query('COMMIT')}
  finally{await connection.query('ROLLBACK');connection.release()}
  expect(await history(contact.id)).toHaveLength(2);expect(await history(deal.id)).toHaveLength(1)
 })
 it('Q05 keeps one logical task ID through canonical and legacy physical supersession and preserves child links',async()=>{
  const api=service(),ctx=await execution(),key=randomUUID()
  const created=await api.command(ctx,'native','create_task',{idempotencyKey:key,input:{title:'Fictional complete task',status:'in_progress',due:'2026-12-01T09:30:00.000Z',tags:['scheduled'],attributes:{estimate_points:3},externalRef:{provider:'fictional',id:'task-1'}}})
  const logical=created.resources[0].id
  const child=await createTask(userId,{workspaceId,access,title:'Fictional child task',parentId:logical})
  const first=(await owner.query('SELECT id,logical_id,scope_version::text AS version FROM tasks WHERE id=$1',[logical])).rows[0]
  const legacy=await updateTask(userId,logical,{title:'Fictional legacy task edit'},undefined,{access,expectedVersion:first.version})
  expect(legacy?.id).not.toBe(logical);expect(legacy?.logicalId).toBe(logical)
  expect((await resolveTaskById(access,logical))?.id).toBe(legacy!.id)
  expect((await owner.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(legacy!.id)
  const read=await api.query(ctx,'native','get',{type:'task',id:logical,fields:['title','status','due','tags','attributes','externalRef']}) as {ref:{id:string;version:string};values:unknown}
  expect(read.ref.id).toBe(logical);expect(read.values).toMatchObject({title:'Fictional legacy task edit',attributes:{estimate_points:3},tags:['scheduled']})
  const command={idempotencyKey:randomUUID(),expectedVersion:read.ref.version,input:{id:logical,patch:{status:'done',due:null}}}
  const updated=await api.command(ctx,'native','patch_task',command)
  expect(updated.resources[0]).toMatchObject({id:logical,version:String(BigInt(read.ref.version)+1n)})
  expect(await api.command(ctx,'native','patch_task',command)).toEqual(updated)
  expect((await owner.query('SELECT id,logical_id,status,due FROM tasks WHERE logical_id=$1 AND valid_to IS NULL',[logical])).rows).toEqual([{id:expect.any(String),logical_id:logical,status:'done',due:null}])
  await expect(api.command(ctx,'native','patch_task',{...command,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'record_version_conflict'})
 })
 it('Q03/Q05 keeps task source ancestry through physical supersession and rechecks raw writes at commit',async()=>{
  const input=await createCompany(userId,{workspaceId,access,name:'Fictional task source input'}),row=await createTask(userId,{workspaceId,access,title:'Fictional derived task'})
  const derivation=randomUUID()
  await owner.query(`INSERT INTO scope_derivations(id,workspace_id,resource_kind,resource_id,resource_version,producer,sensitivity,compartments,project_ids,source_policy_revision)
   VALUES($1,$2,'task',$3,'1','native-completion-fixture','internal','{}','{}',1)`,[derivation,workspaceId,row.id])
  await owner.query("INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version) VALUES($1,$2,'entity',$3,'1')",[workspaceId,derivation,input.id])
  const api=service(),changed=await api.command(await execution(),'native','patch_task',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:row.id,patch:{title:'Fictional derived task changed'}}})
  const live=(await owner.query('SELECT id,title,scope_version::text AS version FROM tasks WHERE logical_id=$1 AND valid_to IS NULL',[row.id])).rows[0]
  expect(changed.resources[0].id).toBe(row.id);expect(live.id).not.toBe(row.id)
  expect((await owner.query("SELECT s.source_id FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id WHERE d.resource_kind='task' AND d.resource_id=$1 AND d.resource_version=$2",[live.id,live.version])).rows).toEqual([{source_id:input.id}])
  const client=await getAppPool().connect()
  try{await client.query('BEGIN');await applyRLSGucs(client,userId)
   await client.query("UPDATE tasks SET title='Fictional pending task edit' WHERE id=$1",[live.id])
   await client.query('UPDATE entities SET user_id=$2 WHERE id=$1',[input.id,otherId])
   await expect(client.query('COMMIT')).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK');client.release()}
  expect((await owner.query('SELECT title,scope_version::text AS version FROM tasks WHERE id=$1',[live.id])).rows[0]).toEqual({title:live.title,version:live.version})
  expect((await owner.query('SELECT user_id FROM entities WHERE id=$1',[input.id])).rows[0].user_id).toBeNull()
  const reclassify=await getAppPool().connect();try{await reclassify.query('BEGIN');await applyRLSGucs(reclassify,userId);await reclassify.query('UPDATE entities SET user_id=$2 WHERE id=$1',[input.id,otherId]);await reclassify.query('COMMIT')}finally{await reclassify.query('ROLLBACK');reclassify.release()}
  await expect(api.command(await execution(),'native','patch_task',{idempotencyKey:randomUUID(),expectedVersion:live.version,input:{id:row.id,patch:{status:'done'}}})).rejects.toMatchObject({code:'access_unavailable'})
  const raw=await getAppPool().connect();try{await raw.query('BEGIN');await applyRLSGucs(raw,userId);await expect(raw.query("UPDATE tasks SET title='Fictional forbidden task edit' WHERE id=$1",[live.id])).rejects.toMatchObject({code:'42501'})}finally{await raw.query('ROLLBACK');raw.release()}
 })
 it('Q04/Q05 rejects invalid raw native task values and immutable provenance atomically',async()=>{
  const row=await createTask(userId,{workspaceId,access,title:'Fictional typed raw task'})
  for(const statement of ["UPDATE tasks SET title='   ' WHERE id=$1","UPDATE tasks SET attributes='[]'::jsonb WHERE id=$1","UPDATE tasks SET external_ref='null'::jsonb WHERE id=$1","UPDATE tasks SET tags=ARRAY[NULL]::text[] WHERE id=$1","UPDATE tasks SET source_session_id=gen_random_uuid() WHERE id=$1"]){
   const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,userId);await expect(client.query(statement,[row.id])).rejects.toMatchObject({code:'22023'})}finally{await client.query('ROLLBACK');client.release()}
  }
  expect((await owner.query('SELECT title,scope_version::text AS version FROM tasks WHERE id=$1',[row.id])).rows[0]).toEqual({title:row.title,version:'1'})
  expect((await owner.query("SELECT id FROM brain_row_versions WHERE primitive='task' AND row_id=$1",[row.id])).rows).toEqual([])
 })
 it('Q05 records one reference-only canonical receipt, audit and outbox for actual legacy CRM writes',async()=>{
  const contact=await createContact(userId,{workspaceId,access,name:'Fictional legacy audit contact'})
  await updateContact(userId,contact.id,{phone:'+1 202 555 0188'},undefined,access)
  const rows=(await owner.query(`SELECT r.resources,a.id AS audit_id,e.id AS event_id FROM application_operation_receipts r
   JOIN application_command_audit a ON a.receipt_id=r.id JOIN application_committed_events e ON e.receipt_id=r.id
   WHERE r.workspace_id=$1 AND r.operation_key='canonical.person.patched' AND r.resources @> $2::jsonb`,[workspaceId,JSON.stringify([{id:contact.id}])])).rows
  expect(rows).toHaveLength(1);expect(rows[0].resources).toEqual([{workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:'person',id:contact.id,version:(await source(contact.id)).version}])
 })

 it.each([
  {eventKey:'native.company.patched',moduleKey:'native'},
  {eventKey:'native.record.patched',moduleKey:'native'},
  {eventKey:'native.contact.patched',moduleKey:'fictional_unrelated_module'},
 ])('Q05 refuses a mismatched audit and does not suppress canonical effects with $moduleKey/$eventKey',async forged=>{
  const contact=await createContact(userId,{workspaceId,access,name:'Fictional native bundle contact'}),fakeReceipt=randomUUID(),client=await getAppPool().connect()
  let refs:unknown[]=[]
  try{
   await client.query('BEGIN');await applyRLSGucs(client,userId)
   expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
   const row=(await client.query("UPDATE entities SET display_name='Fictional canonical bundle update',updated_at=clock_timestamp() WHERE id=$1 RETURNING scope_version::text AS version",[contact.id])).rows[0]
   refs=[{workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:'person',id:contact.id,version:row.version}]
   await client.query(`INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources)
    VALUES($1,$2,'native','patch_contact','fictional-bundle',$3,$4,'fictional-request',$5)`,[fakeReceipt,workspaceId,userId,randomUUID(),JSON.stringify(refs)])
   await client.query('SAVEPOINT mismatched_audit')
   await expect(client.query(`INSERT INTO application_command_audit(receipt_id,workspace_id,module_key,actor_user_id,operation_key)
    VALUES($1,$2,'native',$3,'patch_company')`,[fakeReceipt,workspaceId,userId])).rejects.toMatchObject({code:'42501'})
   await client.query('ROLLBACK TO SAVEPOINT mismatched_audit');await client.query('RELEASE SAVEPOINT mismatched_audit')
   await client.query(`INSERT INTO application_command_audit(receipt_id,workspace_id,module_key,actor_user_id,operation_key)
    VALUES($1,$2,'native',$3,'patch_contact')`,[fakeReceipt,workspaceId,userId])
   await client.query(`INSERT INTO application_committed_events(receipt_id,workspace_id,module_key,event_key,resources)
    VALUES($1,$2,$3,$4,$5)`,[fakeReceipt,workspaceId,forged.moduleKey,forged.eventKey,JSON.stringify(refs)])
   await client.query('COMMIT')
  }finally{await client.query('ROLLBACK');client.release()}
  const events=(await owner.query(`SELECT r.operation_key,a.operation_key AS audit_operation,e.module_key,e.event_key,e.resources FROM application_operation_receipts r
   JOIN application_command_audit a ON a.receipt_id=r.id JOIN application_committed_events e ON e.receipt_id=r.id
   WHERE r.workspace_id=$1 AND r.resources=$2::jsonb ORDER BY r.operation_key`,[workspaceId,JSON.stringify(refs)])).rows
  expect(events).toHaveLength(2)
  expect(events).toContainEqual({operation_key:'canonical.person.patched',audit_operation:'canonical.person.patched',module_key:'native',event_key:'native.person.patched',resources:refs})
  expect(await history(contact.id)).toHaveLength(1)
 })
 it('Q05 keeps one complete semantic bundle for an actual mixed-record command',async()=>{
  const company=await createCompany(userId,{workspaceId,access,name:'Fictional canonical batch company'}),person=await createContact(userId,{workspaceId,access,name:'Fictional canonical batch contact'})
  const result=await service().command(await execution(),'native','patch_records',{idempotencyKey:randomUUID(),input:{patches:[
   {type:'company',id:company.id,expectedVersion:'1',patch:{domain:'batch.example'}},
   {type:'person',id:person.id,expectedVersion:'1',patch:{phone:'+1 202 555 0107'}}]}})
  expect(result.resources).toHaveLength(2)
  const rows=(await owner.query(`SELECT r.id,r.operation_key,a.operation_key AS audit_operation,e.event_key,e.resources FROM application_operation_receipts r
   JOIN application_command_audit a ON a.receipt_id=r.id JOIN application_committed_events e ON e.receipt_id=r.id
   WHERE r.workspace_id=$1 AND (r.resources @> $2::jsonb OR r.resources @> $3::jsonb)`,[workspaceId,JSON.stringify([result.resources[0]]),JSON.stringify([result.resources[1]])])).rows
  expect(rows).toEqual([{id:result.id,operation_key:'patch_records',audit_operation:'patch_records',event_key:'native.record.patched',resources:result.resources}])
  expect(await history(company.id)).toHaveLength(1);expect(await history(person.id)).toHaveLength(1)
 })

 it.each(['person','deal','task'] as const)('Q03/Q05/Q06 applies a write-only canonical %s command as a real nonmember service without owner substitution',async type=>{
  const record=type==='person'?await createContact(userId,{workspaceId,access,name:'Fictional service contact'}):type==='deal'?await createDeal(userId,{workspaceId,access}):await createTask(userId,{workspaceId,access,title:'Fictional service task'})
  const command=type==='person'?'patch_contact':type==='deal'?'patch_deal':'patch_task',fields=type==='person'?['phone']:type==='deal'?['amount']:['title']
  const fixture=await application(type,command,fields,record.id),api=service()
  const before=(await owner.query(`SELECT scope_version::text AS version FROM ${type==='task'?'tasks':'entities'} WHERE id=$1`,[record.id])).rows[0]
  const input=applicationJsonSchema.parse({id:record.id,patch:type==='person'?{phone:'+1 202 555 0167'}:type==='deal'?{amount:'123.000000000000000001'}:{title:'Fictional nonmember task change'}})
  const request={idempotencyKey:randomUUID(),expectedVersion:before.version,input}
  const result=await api.command(await fixture.context(),'native',command,request)
  expect(result.resources).toEqual([{workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:type,id:record.id,version:String(BigInt(before.version)+1n)}])
  expect(await api.command(await fixture.context(),'native',command,request)).toEqual(result)
  await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[fixture.grantId])
  await expect((async()=>api.command(await fixture.context(),'native',command,request))()).rejects.toMatchObject({code:'grant_revoked'})
 })
 it('Q04/Q05 repoints physical child links under a write-only logical parent grant without granting child business writes',async()=>{
  const parent=await createTask(userId,{workspaceId,access,title:'Fictional service parent task'}),child=await createTask(userId,{workspaceId,access,title:'Fictional service child task',parentId:parent.id})
  const fixture=await application('task','patch_task',['title'],parent.id),api=service()
  const result=await api.command(await fixture.context(),'native','patch_task',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:parent.id,patch:{title:'Fictional changed service parent task'}}})
  expect(result.resources[0]).toMatchObject({id:parent.id,version:'2'})
  const live=(await owner.query('SELECT id FROM tasks WHERE logical_id=$1 AND valid_to IS NULL',[parent.id])).rows[0]
  expect((await owner.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(live.id)
  const projection=await api.query(await execution(),'native','get',{type:'task',id:child.id,fields:['parentId']}) as {values:{parentId:string}}
  expect(projection.values.parentId).toBe(parent.id)
  expect((await resolveTaskById(access,child.id))?.parentId).toBe(live.id)
  await expect(api.command(await fixture.context(),'native','patch_task',{idempotencyKey:randomUUID(),expectedVersion:(await owner.query('SELECT scope_version::text AS version FROM tasks WHERE id=$1',[child.id])).rows[0].version,input:{id:child.id,patch:{title:'Fictional forbidden child title'}}})).rejects.toMatchObject({code:'access_unavailable'})
 })
 it('Q03/Q05 creates and replays a write-only logical task as a real nonmember service',async()=>{
  const fixture=await application('task','create_task',['title','status','due','tags','attributes','externalRef']),api=service()
  const request={idempotencyKey:randomUUID(),input:{title:'Fictional nonmember initial task',status:'blocked',due:'2026-12-15T10:00:00.000Z',tags:['intake'],attributes:{order:1},externalRef:{provider:'fictional',id:'task-external-1'}}}
  const result=await api.command(await fixture.context(),'native','create_task',request)
  expect(result.resources[0]).toMatchObject({workspaceId,typeKey:'task',version:'1'})
  expect(await api.command(await fixture.context(),'native','create_task',request)).toEqual(result)
  expect((await owner.query('SELECT id,logical_id,title,status FROM tasks WHERE id=$1',[result.resources[0].id])).rows[0]).toEqual({id:result.resources[0].id,logical_id:result.resources[0].id,title:request.input.title,status:'blocked'})
 })

 describe('legacy create-upsert canonical admission',()=>{
  const upsertWorkspace=randomUUID(),upsertAssistant=randomUUID()
  const identity={provider:'fixture',providerInstanceKey:'fictional-upsert',subjectId:randomUUID()},derivedIdentity={...identity,subjectId:randomUUID()}
  let companyId:string,contactId:string,derivedId:string
  const upsertAccess=(actor:string)=>({workspaceId:upsertWorkspace,userId:actor,assistantId:upsertAssistant,assistantKind:'primary' as const,clearance:'confidential' as const})
  beforeAll(async()=>{
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional canonical upsert',$2,false)",[upsertWorkspace,userId])
   for(const actor of [userId,otherId])await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[upsertWorkspace,actor])
   await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional upsert assistant',$2,$3,'primary','confidential')",[upsertAssistant,userId,upsertWorkspace])
   companyId=(await createCompany(userId,{workspaceId:upsertWorkspace,name:'Fictional protected upsert company',domain:'hidden-upsert.example',externalRef:{private:'fictional company value'},access:upsertAccess(userId),mergeByName:false})).id
   contactId=(await createContact(userId,{workspaceId:upsertWorkspace,name:'Fictional protected upsert contact',email:'hidden-upsert@example.com',phone:'+1 202 555 0141',stableIdentity:identity,access:upsertAccess(userId)})).id
   const source=await createCompany(userId,{workspaceId:upsertWorkspace,name:'Fictional upsert retained source',access:upsertAccess(userId),mergeByName:false})
   // Fixed policy metadata selects this synthetic source, never a business value.
   derivedId=(await createContact(userId,{workspaceId:upsertWorkspace,name:'Fictional derived upsert contact',phone:'+1 202 555 0142',stableIdentity:derivedIdentity,access:upsertAccess(userId)})).id
   const derivation=randomUUID()
   await owner.query(`INSERT INTO scope_derivations(id,workspace_id,resource_kind,resource_id,resource_version,producer,sensitivity,compartments,project_ids,source_policy_revision)
    VALUES($1,$2,'entity',$3,'1','native-upsert-fixture','internal','{}','{}',1)`,[derivation,upsertWorkspace,derivedId])
   await owner.query("INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version) VALUES($1,$2,'entity',$3,'1')",[upsertWorkspace,derivation,source.id])
   await owner.query(`CREATE FUNCTION native_upsert_completion_catalog(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    DECLARE keys text[];fields jsonb;BEGIN
     keys:=application_native_field_keys(t);
     SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key IN('name','createdAt') THEN '[["identity_reader"]]'::jsonb ELSE '[["body_reader"]]'::jsonb END,
      'write','[["writer"]]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) INTO fields FROM unnest(keys) key;
     RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','native-upsert-1','policyVersion','native-upsert-1','fieldKeys',keys,'fields',fields,
      'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));
    END $$;
    REVOKE ALL ON FUNCTION native_upsert_completion_catalog(uuid,jsonb,text) FROM PUBLIC;
    CREATE FUNCTION native_upsert_completion_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    DECLARE source jsonb;catalog jsonb;BEGIN
     source:=read_scope_source(w,'entity',i::uuid);IF source IS NULL THEN RETURN NULL;END IF;
     catalog:=native_upsert_completion_catalog(w,o,t);
     IF i='${source.id}' THEN catalog:=jsonb_set(catalog,'{fields}',(SELECT jsonb_agg(jsonb_set(value,'{read}','[["source_reader"]]'::jsonb)) FROM jsonb_array_elements(catalog->'fields')));END IF;
     RETURN (catalog-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);
    END $$;
    REVOKE ALL ON FUNCTION native_upsert_completion_metadata(uuid,jsonb,text,text) FROM PUBLIC;
    INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required)
     VALUES('native','native-upsert-1',ARRAY['identity_reader','body_reader','source_reader','writer'],'native_upsert_completion_metadata(uuid,jsonb,text,text)'::regprocedure,'native_upsert_completion_catalog(uuid,jsonb,text)'::regprocedure,false)`)
   for(const type of ['company','person'])await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}',$2,'native')`,[upsertWorkspace,type])
   for(const actor of [userId,otherId])for(const role of ['identity_reader','source_reader','writer',...(actor===otherId?['body_reader']:[])])await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,$3,$4)",[upsertWorkspace,actor,role,userId])
  })
  afterAll(async()=>{
   await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1',[upsertWorkspace])
   await owner.query('DELETE FROM application_native_role_assignments WHERE workspace_id=$1',[upsertWorkspace])
   await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
   await owner.query('DROP FUNCTION native_upsert_completion_metadata(uuid,jsonb,text,text);DROP FUNCTION native_upsert_completion_catalog(uuid,jsonb,text)')
   await owner.query('DELETE FROM workspaces WHERE id=$1',[upsertWorkspace])
  })
  async function snapshotUpserts(){return(await owner.query(`SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM entities e WHERE e.workspace_id=$1) AS entities,
   (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM brain_row_versions v WHERE v.workspace_id=$1) AS history,
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM application_operation_receipts r WHERE r.workspace_id=$1) AS receipts,
   (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM application_command_audit a WHERE a.workspace_id=$1) AS audits,
   (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM application_committed_events e WHERE e.workspace_id=$1) AS events`,[upsertWorkspace])).rows[0]}
  const upsertCompany=(actor:string,name='Fictional protected upsert company')=>createCompany(actor,{workspaceId:upsertWorkspace,name,access:upsertAccess(actor)})
  const upsertContact=(actor:string,derived=false)=>createContact(actor,{workspaceId:upsertWorkspace,name:derived?'Fictional derived upsert contact':'Fictional protected upsert contact',stableIdentity:derived?derivedIdentity:identity,access:upsertAccess(actor)})
  it('Q02/Q03 refuses hidden company dedup predicates before matching or creating while an independent reader retains the original no-op',async()=>{
   const role=(await owner.query("SELECT id FROM application_native_role_assignments WHERE workspace_id=$1 AND user_id=$2 AND role_key='identity_reader'",[upsertWorkspace,userId])).rows[0].id
   await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
   const before=await snapshotUpserts()
   try{
    for(const name of ['Fictional protected upsert company','Fictional unmatched upsert company'])await expect(upsertCompany(userId,name)).rejects.toMatchObject({code:'access_unavailable'})
    expect(await snapshotUpserts()).toEqual(before)
    expect(await upsertCompany(otherId)).toMatchObject({id:companyId,domain:'hidden-upsert.example'})
    expect(await snapshotUpserts()).toEqual(before)
   }finally{await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'identity_reader',$2)",[upsertWorkspace,userId])}
  })
  it('Q02/Q03/Q04 admits the complete legacy company/contact result before a no-op merge and retains an independent full reader',async()=>{
   const before=await snapshotUpserts()
   await expect(upsertCompany(userId)).rejects.toMatchObject({code:'access_unavailable'})
   await expect(upsertContact(userId)).rejects.toMatchObject({code:'access_unavailable'})
   expect(await snapshotUpserts()).toEqual(before)
   expect(await upsertCompany(otherId)).toMatchObject({id:companyId,domain:'hidden-upsert.example'})
   expect(await upsertContact(otherId)).toMatchObject({id:contactId,email:'hidden-upsert@example.com',phone:'+1 202 555 0141'})
   expect(await snapshotUpserts()).toEqual(before)
  })
  it('Q02/Q03 refuses a stable-identity no-op after original source-role contraction while an independent actor still reads the same record',async()=>{
   await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'body_reader',$2)",[upsertWorkspace,userId])
   expect(await upsertContact(userId,true)).toMatchObject({id:derivedId,phone:'+1 202 555 0142'})
   await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND role_key='source_reader'",[upsertWorkspace,userId])
   const before=await snapshotUpserts()
   await expect(upsertContact(userId,true)).rejects.toMatchObject({code:'scope_operation_denied'})
   expect(await snapshotUpserts()).toEqual(before)
   expect(await upsertContact(otherId,true)).toMatchObject({id:derivedId,phone:'+1 202 555 0142'})
   expect(await snapshotUpserts()).toEqual(before)
  })
 })

})
