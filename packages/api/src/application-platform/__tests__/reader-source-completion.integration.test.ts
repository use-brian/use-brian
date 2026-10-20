/** Real selected snapshot queries and native-source admission. */
import { randomBytes,createHash,randomUUID } from 'node:crypto'
import { z } from 'zod'
import { canonicalNativeResourceDefinitions } from '../native-resources.js'
import { runWithCanonicalPublicShare } from '../public-share-context.js'
import { beforeAll,afterAll,describe,expect,it } from 'vitest'
import { buildPublicAccessContext,boundScopeSources,type AccessContext,type ScopeSource } from '@use-brian/core'
import { getPool,getAppPool,applyRLSGucs } from '../../db/client.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { hashSecret } from '../../db/api-key-store.js'
import type { ApplicationAccessGrant,ApplicationRecordProjection } from '@use-brian/shared'
import { readLegacyCanonicalCrmPoint } from '../../db/crm-reader.js'
import { createEntity } from '../../db/entities-store.js'
import { createTask,updateTask } from '../../db/tasks.js'
import { createCompany,createContact,createDeal,listCompanies,listContacts,listDeals } from '../../db/crm.js'
import { listCrmR2Records,listCrmRecordPage,lookupCrmRecords,getCrmSummary,getCrmReport,getCrmConfig,getCrmR2Record,appendCrmActivity,listCrmTimeline,buildCrmReport } from '../../db/crm-r2.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe('[COMP:api/application-records] canonical legacy reader and source completion',()=>{
 const owner=getPool(),workspaceId=randomUUID(),userId=randomUUID(),memberId=randomUUID(),assistantId=randomUUID()
 const oauthClients:string[]=[],extraUsers:string[]=[]
 const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
 const access:AccessContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential'},member={...access,userId:memberId}
 beforeAll(async()=>{
  for(const id of [userId,memberId])await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional reader completion',$2,false)",[workspaceId,userId])
  for(const id of [userId,memberId])await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspaceId,id,id===userId?'owner':'member'])
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional reader',$2,$3,'primary','confidential')",[assistantId,userId,workspaceId])
 })
 afterAll(async()=>{await owner.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);if(oauthClients.length)await owner.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])',[oauthClients]);await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[userId,memberId,...extraUsers]]);await getAppPool().end();await owner.end()})
 async function current(source:ScopeSource){const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,memberId);return (await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value}finally{await client.query('ROLLBACK');client.release()}}
 async function application(actor:string,kind:'member'|'external_user',entries:Array<{type:'company'|'person'|'deal'|'task';ids?:string[];selector?:ApplicationAccessGrant['selector'];fields:string[]}>) {
  const appId=randomUUID(),origin={kind:'native' as const,moduleKey:'native'},grants:ApplicationAccessGrant[]=entries.map(entry=>({id:randomUUID(),appId,workspaceId,principal:{kind,userId:actor},origin,typeKey:entry.type,actions:['read','query','history'],readFields:entry.fields,writeFields:[],selector:entry.selector??{kind:'ids',ids:entry.ids!},version:1,status:'active',startsAt:'2020-01-01T00:00:00.000Z',expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'confidential'}))
  const client=await createDbOAuthClientStore().register({clientName:'Fictional native source client',clientUri:'https://portal.example',redirectUris:['https://portal.example/callback'],tokenEndpointAuthMethod:'none'});oauthClients.push(client.clientId)
  await owner.query("INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id,oauth_client_id) VALUES($1,$2,'native','Fictional source client','external_frontend',$3,$4,$5)",[appId,workspaceId,assistantId,userId,client.clientId])
  for(const grant of grants)await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,selector,clearance,compartments,project_ids,starts_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,'confidential','{}','{}',$12)`,[grant.id,appId,workspaceId,kind,actor,userId,origin,grant.typeKey,grant.actions,grant.readFields,grant.selector,grant.startsAt])
  const authorizationId=randomUUID(),secret=randomBytes(32).toString('base64url')
  await owner.query("INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at) VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '1 hour')",[authorizationId,client.clientId,actor,workspaceId,appId,await hashSecret(secret)])
  await owner.query('INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants) VALUES($1,$2,$3,$4,$5,$6)',[authorizationId,appId,workspaceId,actor,grants[0].id,JSON.stringify(grants.map(grant=>({version:1,grants:[grant]})))])
  const auth=await authenticateApplicationOAuth(`oat_${authorizationId}_${secret}`,appId);expect(auth).not.toBeNull()
  return {grants,authentication:{user:auth!}}
 }
 async function applicationGet(app:Awaited<ReturnType<typeof application>>,type:string,id:string,fields=['name']) {
  return dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'native','get',{type,id,fields}) as Promise<ApplicationRecordProjection>
 }
 it('Q02 preserves metadata-only native leaves across array bounds without granting current row access',async()=>{
  const company=await createCompany(userId,{workspaceId,name:'Fictional lineage leaf',access})
  const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE workspace_id=$1 AND id=$2',[workspaceId,company.id])).rows[0].version as string
  const lineage=async(kinds:unknown,ids:unknown,versions:unknown)=>(await owner.query(
   'SELECT * FROM application_scope_lineage($1,$2::text[],$3::uuid[],$4::text[])',[workspaceId,kinds,ids,versions])).rows
  const expected=[{kind:'entity',id:company.id,version}]
  expect(await lineage(['entity'],[company.id],[version])).toEqual(expected)
  expect(await lineage('[0:0]={entity}',[company.id],[version])).toEqual(expected)
  expect(await lineage(['entity'],'[0:0]={'+company.id+'}',[version])).toEqual(expected)
  expect(await lineage(['entity'],[company.id],'[0:0]={'+version+'}')).toEqual(expected)
  await expect(lineage(['entity'],[company.id],[null])).rejects.toMatchObject({code:'22023'})
  expect((await readLegacyCanonicalCrmPoint(member,'company',company.id,['name']))!.projection.values).toEqual({name:'Fictional lineage leaf'})
  await owner.query('UPDATE entities SET scope_held=true WHERE workspace_id=$1 AND id=$2',[workspaceId,company.id])
  expect(await lineage(['entity'],[company.id],[version])).toEqual(expected)
  expect(await readLegacyCanonicalCrmPoint(member,'company',company.id,['name'])).toBeNull()
 })
 it('Q02 falls back to the complete lineage after a kernel extension and rechecks its held native source',async()=>{
  const company=await createCompany(userId,{workspaceId,name:'Fictional extended lineage',access})
  const dependency=await createCompany(userId,{workspaceId,name:'Fictional retained source',access})
  await owner.query('UPDATE entities SET scope_held=true WHERE workspace_id=$1 AND id=$2',[workspaceId,dependency.id])
  const versions=(await owner.query('SELECT id,scope_version::text AS version FROM entities WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,[company.id,dependency.id]])).rows as Array<{id:string;version:string}>
  const version=versions.find(row=>row.id===company.id)!.version,dependencyVersion=versions.find(row=>row.id===dependency.id)!.version
  const original=(await owner.query("SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_catalog.pg_proc p WHERE p.oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure")).rows[0] as {definition:string;body:string}
  const lineage=async()=>(await owner.query("SELECT * FROM application_scope_lineage($1,ARRAY['entity'],ARRAY[$2::uuid],ARRAY[$3::text])",[workspaceId,company.id,version])).rows
  expect(await lineage()).toEqual([{kind:'entity',id:company.id,version}])
  expect((await readLegacyCanonicalCrmPoint(member,'company',company.id,['name']))!.projection.values.name).toBe('Fictional extended lineage')
  try{
   // Only this guarded disposable fixture changes a server-owned kernel.
   // A new edge must disable the shortcut before actual nonowner admission.
   await owner.query(`CREATE OR REPLACE FUNCTION public.application_scope_source_edges(w uuid,k text,i uuid,v text)
    RETURNS TABLE(kind text,id uuid,version text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture_edges$
    ${original.body}
    UNION SELECT 'entity', '${dependency.id}'::uuid, '${dependencyVersion}'::text
     WHERE w='${workspaceId}'::uuid AND k='entity' AND i='${company.id}'::uuid
    $fixture_edges$`)
   expect(await lineage()).toEqual(expect.arrayContaining([{kind:'entity',id:company.id,version},{kind:'entity',id:dependency.id,version:dependencyVersion}]))
   expect(await lineage()).toHaveLength(2)
   expect(await readLegacyCanonicalCrmPoint(member,'company',company.id,['name'])).toBeNull()
  }finally{await owner.query(original.definition)}
  expect(await lineage()).toEqual([{kind:'entity',id:company.id,version}])
  expect((await readLegacyCanonicalCrmPoint(member,'company',company.id,['name']))!.projection.values.name).toBe('Fictional extended lineage')
 })
 it('Q02/Q08 preserves legacy search/filter/DTO shapes with complete canonical evidence',async()=>{
  const company=await createCompany(userId,{workspaceId,name:'Fictional collection company',domain:'collection.example',tags:['reader'],access})
  const contact=await createContact(userId,{workspaceId,name:'Fictional collection person',email:'reader@example.com',phone:'+1 555 010 1234',companyId:company.id,access})
  const deal=await createDeal(userId,{workspaceId,companyId:company.id,contactId:contact.id,amount:'9007199254740993.000000000000000001',access})
  for(const rows of [await listCompanies(member,{query:'collection.example',tag:'reader'}),await listContacts(member,{query:'5550101234',companyId:company.id}),await listDeals(member,{companyId:company.id})]){
   expect(rows).toHaveLength(1);expect(boundScopeSources(rows).length).toBeGreaterThan(1);expect(boundScopeSources(rows[0]).length).toBeGreaterThan(1)
  }
  expect((await listDeals(member,{companyId:company.id}))[0]).toMatchObject({id:deal.id,amount:'9007199254740993.000000000000000001'})
  const numeric=await createDeal(userId,{workspaceId,amount:18.25,access})
  expect((await listDeals(member,{})).find(row=>row.id===numeric.id)?.amount).toBe(18.25)
 })
 it('Q02/Q08 evaluates page search/lookup/flat collections only on admitted snapshots',async()=>{
  const company=await createCompany(userId,{workspaceId,name:'Fictional paged company',domain:'paged.example',access})
  const page=await listCrmRecordPage(member,{kind:'company',limit:1,sort:'name',direction:'asc',search:'paged'})
  expect(page.items.map(row=>row.id)).toEqual([company.id]);expect(boundScopeSources(page).length).toBeGreaterThan(1)
  expect(await lookupCrmRecords({ctx:member,kind:'company',query:'paged',limit:10})).toEqual([{id:company.id,name:company.name,hint:'paged.example'}])
  expect((await listCrmR2Records(member)).some(row=>row.id===company.id)).toBe(true)
 })
 it('Q02 captures absence/excluded candidates and invalidates retained query after a source write',async()=>{
  const rows=await listCompanies(member,{query:'no fictional match'});expect(rows).toEqual([])
  const sources=boundScopeSources(rows);expect(sources.length).toBeGreaterThan(1)
  const domainIds=(await owner.query("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection='query_domain'",[sources.map(source=>source.resourceId)])).rows.map(row=>row.id)
  const source=sources.find(source=>domainIds.includes(source.resourceId))!;expect(await current(source)).toMatchObject({held:false})
  await createCompany(userId,{workspaceId,name:'Fictional additional candidate',access})
  const changed=await current(source);expect(changed===null||changed.held===true).toBe(true)
 })
 it('Q02/Q05 preserves exact aggregate and weighted report values',async()=>{
  const config=await getCrmConfig(userId,workspaceId),stage=config.pipelines[0].stages.find(stage=>stage.category==='open')!
  const amount='9007199254740993.000000000000000001'
  const result=buildCrmReport([{id:randomUUID(),kind:'deal',name:'Fictional exact forecast',attributes:{amount,pipeline_stage_id:stage.id,stage:stage.legacyKey,currency_code:'USD'},archivedAt:null,updatedAt:new Date().toISOString()}],config)
  expect(result.openValue.USD).toBe(amount)
  if(stage.probability===10)expect(result.weightedForecast.USD).toBe('900719925474099.3000000000000000001')
  expect(boundScopeSources(await getCrmSummary(member)).length).toBeGreaterThan(1)
  expect(boundScopeSources(await getCrmReport(member)).length).toBeGreaterThan(1)
 })
 it.each(['null','malformed'] as const)('Q02 preserves selected historical %s fields at the actual nonowner SQL reader',async variant=>{
  const entity=await createEntity({workspaceId,kind:'company',displayName:'Fictional historical selected value',attributes:{},createdByUserId:userId,source:'user'})
  const fixture=await owner.connect();try{await fixture.query('BEGIN');await fixture.query('ALTER TABLE entities DISABLE TRIGGER application_native_entity_values');
   await fixture.query('UPDATE entities SET attributes=$2 WHERE id=$1',[entity.id,variant==='null'?{tags:null,external_ref:null}:{crm_archived_at:'invalid historical timestamp'}]);
   await fixture.query('SET CONSTRAINTS ALL IMMEDIATE');await fixture.query('ALTER TABLE entities ENABLE TRIGGER application_native_entity_values');await fixture.query('COMMIT')
  }finally{await fixture.query('ROLLBACK');fixture.release()}
  const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,userId)
   const result=await client.query('SELECT read_native_application_record($1,$2,$3,$4) AS value',[workspaceId,'company',entity.id,variant==='null'?['name','tags','externalRef']:['name']])
   expect(result.rows[0].value.values).toMatchObject({name:entity.displayName})
  }finally{await client.query('ROLLBACK');client.release();await owner.query('UPDATE entities SET scope_held=true WHERE id=$1',[entity.id])}
 })
 it('Q02 refuses a full attributes DTO with an undeclared historical key while admitted selected fields remain readable',async()=>{
  const row=await createEntity({workspaceId,kind:'company',displayName:'Fictional undeclared legacy attribute',attributes:{fictional_undeclared_note:'not a declared field'},createdByUserId:userId,source:'user'})
  try{
   await expect(getCrmR2Record(member,row.id)).rejects.toMatchObject({code:'access_unavailable'})
   expect((await readLegacyCanonicalCrmPoint(member,'company',row.id,['name']))!.projection.values).toEqual({name:row.displayName})
  }finally{await owner.query('UPDATE entities SET scope_held=true WHERE id=$1',[row.id])}
 })
 it('Q08 admits current public link profile without member fallback and revokes it immediately',async()=>{
  const pageId=randomUUID(),grantId=randomUUID(),token=randomUUID()+randomUUID()
  await owner.query("INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,clearance) VALUES($1,$2,$3,'Fictional public view','companies','table','public')",[pageId,workspaceId,userId])
  await owner.query("INSERT INTO page_grants(id,page_id,principal_type,principal_ref,role,created_by) VALUES($1,$2,'link',$3,'view',$4)",[grantId,pageId,createHash('sha256').update(token).digest('hex'),userId])
  const visible=await createCompany(userId,{workspaceId,name:'Fictional public company',sensitivity:'public',access})
  await createCompany(userId,{workspaceId,name:'Fictional internal company',sensitivity:'internal',access})
  const publicAccess=buildPublicAccessContext(workspaceId),read=()=>runWithCanonicalPublicShare(workspaceId,pageId,{kind:'link',token},()=>listCompanies(publicAccess,{}))
  await expect(listCompanies(publicAccess,{})).rejects.toMatchObject({code:'access_unavailable'})
  const result=await read();expect(result.map(row=>row.id)).toEqual([visible.id]);expect(boundScopeSources(result).length).toBeGreaterThan(0)
  await owner.query('UPDATE page_grants SET revoked_at=clock_timestamp() WHERE id=$1',[grantId])
  await expect(read()).rejects.toMatchObject({code:'access_unavailable'})
  expect((await listCompanies(member,{query:'Fictional public company'})).map(row=>row.id)).toEqual([visible.id])
 })
 it.each(['member','external_user'] as const)('Q03 admits exact field-derived native sources as actual %s and stops a revoked source release',async principal=>{
  let actor=memberId
  if(principal==='external_user'){actor=randomUUID();extraUsers.push(actor);await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[actor])}
  const parent=await createCompany(userId,{workspaceId,name:'Fictional application source parent',access})
  const source=(await readLegacyCanonicalCrmPoint(access,'company',parent.id,['name']))!.sources[0]
  const derived=await createEntity({workspaceId,kind:'company',displayName:'Fictional application source derivative',attributes:{},createdByUserId:userId,source:'user',
    sensitivity:source.sensitivity,compartments:[...source.compartments],projectIds:[...source.projectIds],userId:source.userId,assistantId:source.assistantId,derivation:{producer:'fictional-reader-source',sources:[source]}})
  const entries=[{type:'company' as const,ids:[derived.id],fields:['name']},{type:'company' as const,ids:[parent.id],fields:['name']}]
  const app=await application(actor,principal,entries),independent=await application(memberId,'member',entries)
  expect((await applicationGet(app,'company',derived.id)).values).toEqual({name:derived.displayName})
  await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[app.grants[1].id])
  await expect(applicationGet(app,'company',derived.id)).rejects.toBeDefined()
  expect((await applicationGet(independent,'company',derived.id)).values).toEqual({name:derived.displayName})
  // A later test registers a different native field contract. Retire this
  // immutable old-contract derivative instead of treating it as a new reader.
  await owner.query('UPDATE entities SET scope_held=true WHERE id=$1',[derived.id])
 })
 it('Q01/Q02 admits registered native relationships only with current relation-field and anchor authority',async()=>{
  const company=await createCompany(userId,{workspaceId,name:'Fictional native relationship anchor',access}),contact=await createContact(userId,{workspaceId,name:'Fictional relationship person',companyId:company.id,access})
  const selector={kind:'relationship' as const,resolverKey:'relation.'+createHash('sha256').update('companyId').digest('hex'),anchorId:company.id}
  const entries=[{type:'person' as const,selector,fields:['name','companyId']},{type:'company' as const,ids:[company.id],fields:['name']}]
  const app=await application(memberId,'member',entries)
  const query=async(target:typeof app)=>dispatcher.query(await resolveApplicationExecutionContext(target.authentication),'native','query',{type:'person',query:{fields:['name']}}) as Promise<{records:ApplicationRecordProjection[]}>
  expect((await query(app)).records.map(row=>row.ref.id)).toEqual([contact.id])
  const hidden=await application(memberId,'member',[{...entries[0],fields:['name']},entries[1]])
  await expect(query(hidden)).rejects.toMatchObject({code:'access_unavailable'})
  await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[app.grants[1].id])
  await expect(query(app)).rejects.toBeDefined()
 })
 it('Q01/Q02 preserves stable logical task identities in current parent relationship queries',async()=>{
  const parent=await createTask(userId,{workspaceId,title:'Fictional task relation parent',access})
  const child=await createTask(userId,{workspaceId,title:'Fictional task relation child',parentId:parent.id,access})
  const live=await updateTask(userId,parent.id,{status:'in_progress'},undefined,{access});expect(live!.id).not.toBe(parent.id)
  const selector={kind:'relationship' as const,resolverKey:'relation.'+createHash('sha256').update('parentId').digest('hex'),anchorId:parent.id}
  const entries=[{type:'task' as const,selector,fields:['title','parentId']},{type:'task' as const,ids:[parent.id],fields:['title']}]
  const app=await application(memberId,'member',entries)
  const query=async(target:typeof app)=>dispatcher.query(await resolveApplicationExecutionContext(target.authentication),'native','query',{type:'task',query:{fields:['title','parentId'],filters:[{field:'title',op:'eq',value:'Fictional task relation child'}]}}) as Promise<{records:ApplicationRecordProjection[]}>
  const result=await query(app);expect(result.records.map(row=>row.ref.id)).toEqual([child.logicalId??child.id]);expect(result.records[0].values.parentId).toBe(parent.id)
  const hidden=await application(memberId,'member',[{...entries[0],fields:['title']},entries[1]])
  await expect(query(hidden)).rejects.toMatchObject({code:'access_unavailable'})
  await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[app.grants[1].id])
  await expect(query(app)).rejects.toBeDefined()
 })
 function timelineApplication(){const base=createCanonicalNativeApplicationModule();return new ApplicationPlatformService([{...base,
  application:{...base.application!,queries:[...base.application!.queries,'legacy_timeline']},queries:{...base.queries,
   legacy_timeline:{input:z.object({id:z.string().uuid()}).strict(),authorize:async()=>{},execute:({execution},raw)=>listCrmTimeline({ctx:execution.security.access,entityId:(raw as {id:string}).id})}}}])}
 it('Q02/Q03 captures actual history absence and insertion while preserving current native and application audiences',async()=>{
  const company=await createCompany(userId,{workspaceId,name:'Fictional canonical activity parent',access})
  const fields=canonicalNativeResourceDefinitions().find(def=>def.typeKey==='company')!.fields.map(field=>field.key)
  const selector={kind:'relationship' as const,resolverKey:'relation.'+createHash('sha256').update('companyId').digest('hex'),anchorId:company.id}
  const app=await application(memberId,'member',[{type:'company',ids:[company.id],fields},{type:'person',selector,fields:['companyId','email']}]),host=timelineApplication()
  const read=async()=>host.query(await resolveApplicationExecutionContext(app.authentication),'native','legacy_timeline',{id:company.id}) as Promise<Array<{id:string;summary:string}>>
  const empty=await read();expect(empty).toEqual([])
  const domainIds=(await owner.query("SELECT r.id FROM application_field_resources r WHERE r.id=ANY($1::uuid[]) AND r.type_key='crm_history_domain'",[boundScopeSources(empty).map(source=>source.resourceId)])).rows.map(row=>row.id)
  const source=boundScopeSources(empty).find(source=>domainIds.includes(source.resourceId))!;expect(source).toBeDefined();expect(await current(source)).toMatchObject({held:false})
  const activity=await appendCrmActivity({userId,workspaceId,entityId:company.id,access,activityType:'note',summary:'Fictional admitted activity'})
  const changed=await current(source);expect(changed===null||changed.held===true).toBe(true)
  expect((await read()).map(row=>row.summary)).toEqual(['Fictional admitted activity'])
  expect((await listCrmTimeline({ctx:member,entityId:company.id}))?.map(row=>row.id)).toEqual([activity!.id])
  await owner.query('UPDATE crm_activities SET scope_held=true WHERE id=$1',[activity!.id])
  expect(await read()).toEqual([]);expect(await listCrmTimeline({ctx:member,entityId:company.id})).toEqual([])
 })
 it('Q08 refuses an application mailbox timeline branch before borrowing native mailbox authority',async()=>{
  const person=await createContact(userId,{workspaceId,name:'Fictional mailbox audience',email:'mailbox-reader@example.com',access})
  const fields=canonicalNativeResourceDefinitions().find(def=>def.typeKey==='person')!.fields.map(field=>field.key)
  const app=await application(memberId,'member',[{type:'person',ids:[person.id],fields}])
  await expect(timelineApplication().query(await resolveApplicationExecutionContext(app.authentication),'native','legacy_timeline',{id:person.id})).rejects.toMatchObject({code:'access_unavailable'})
 })
 describe('current protected field policies',()=>{
  beforeAll(async()=>{
   await owner.query(`CREATE FUNCTION reader_completion_rules() RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_agg(jsonb_build_object('key',field,'read',CASE WHEN field='domain' THEN '[["finance"]]'::jsonb ELSE '[]'::jsonb END,
      'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(public.application_native_field_keys('company')) field $$;
    REVOKE ALL ON FUNCTION reader_completion_rules() FROM PUBLIC;
    CREATE FUNCTION reader_completion_record(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    DECLARE source jsonb;BEGIN IF t<>'company' OR NOT EXISTS(SELECT 1 FROM public.entities WHERE workspace_id=w AND id=i::uuid AND kind=t) THEN RETURN NULL;END IF;
     source:=public.read_scope_source(w,'entity',i::uuid);RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
      'recordVersion',source->>'version','fieldKeys',public.application_native_field_keys(t),'fields',public.reader_completion_rules(),'source',source);END $$;
    REVOKE ALL ON FUNCTION reader_completion_record(uuid,jsonb,text,text) FROM PUBLIC;
    CREATE FUNCTION reader_completion_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
     SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1','fieldKeys',public.application_native_field_keys(t),
      'fields',public.reader_completion_rules(),'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
    REVOKE ALL ON FUNCTION reader_completion_catalog(uuid,jsonb,text) FROM PUBLIC`)
   await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader) VALUES('native','1',ARRAY['finance'],
    'reader_completion_record(uuid,jsonb,text,text)'::regprocedure,'reader_completion_catalog(uuid,jsonb,text)'::regprocedure)`)
   await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','company','native')`,[workspaceId])
  })
  afterAll(async()=>{await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1',[workspaceId]);await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'");await owner.query('DROP FUNCTION reader_completion_record(uuid,jsonb,text,text);DROP FUNCTION reader_completion_catalog(uuid,jsonb,text);DROP FUNCTION reader_completion_rules()')})
  it.each(['list','page','lookup','report'] as const)('Q02 refuses hidden domain before legacy %s evaluates or exposes it',async kind=>{
   const load=()=>kind==='list'?listCompanies(member,{query:'collection'}):kind==='page'?listCrmRecordPage(member,{kind:'company',limit:10,sort:'name',direction:'asc',search:'collection'}):kind==='lookup'?lookupCrmRecords({ctx:member,kind:'company',query:'collection',limit:10}):getCrmReport(member)
   await expect(load()).rejects.toMatchObject({code:'access_unavailable'})
   const role=(await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$3) RETURNING id",[workspaceId,memberId,userId])).rows[0].id
   try{expect(await load()).toBeDefined()}finally{await owner.query('DELETE FROM application_native_role_assignments WHERE id=$1',[role])}
  })
  it('Q02 retains immutable list evidence under an independent reader after the first reader loses a field',async()=>{
   const roles=[];for(const actor of [userId,memberId])roles.push((await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$3) RETURNING id",[workspaceId,actor,userId])).rows[0].id)
   try{
    const result=await listCompanies(member,{query:'collection'}),source=boundScopeSources(result).find(source=>source.resourceKind==='application_field')!
    expect(await current(source)).toMatchObject({held:false})
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[roles[1]])
    const held=await current(source);expect(held===null||held.held===true).toBe(true)
    expect((await listCompanies(access,{query:'collection'})).length).toBeGreaterThan(0)
   }finally{await owner.query('DELETE FROM application_native_role_assignments WHERE id=ANY($1::uuid[])',[roles])}
  })
 })

})
