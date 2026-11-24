import {randomBytes} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools} from '@use-brian/core/tools/base/knowledge.js'
import type {LLMProvider} from '@use-brian/agent-runtime/providers/types.js'
import type {AccessContext} from '@use-brian/agent-runtime/security/access-context.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import type {Tool} from '@use-brian/agent-runtime/tools/types.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbConnectorStore} from '../../db/connector-store.js'
import {createDbKnowledgeStore,type KnowledgeEntry} from '../../db/knowledge-store.js'
import {createDbMcpSettingsStore} from '../../db/mcp-settings-store.js'
import {admitModelInput} from '../../context-scope/admission.js'
import {composeSurfaceCapabilities} from '../../mcp/surface.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {configuredKnowledgeEntryFixture} from './fixtures/configured-knowledge.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {retainedKnowledgeFixture,signedKnowledgeAuthority} from './fixtures/retained-knowledge.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Reader={name:string;read:(ctx:AccessContext,row:KnowledgeEntry)=>Promise<boolean>}
const legacyReaders:Reader[]=[
 {name:'point path',read:async(ctx,row)=>!!await store.getByPath(ctx,row.path)},
 {name:'top-level path',read:async(ctx,row)=>(await store.listByPath(ctx,'')).some(value=>value.id===row.id)},
 {name:'path index',read:async(ctx,row)=>(await store.listByPath(ctx,row.path)).some(value=>value.id===row.id)},
 {name:'full-text rank and limit',read:async(ctx,row)=>(await store.search(ctx,'fictional',1)).some(value=>value.id===row.id)},
 {name:'summary catalog',read:async(ctx,row)=>(await store.listSummaries(ctx)).some(value=>value.id===row.id)},
 {name:'Brain recent list',read:async(ctx,row)=>(await store.listForBrain(ctx,'',1)).some(value=>value.id===row.id)},
 {name:'Brain ranked list',read:async(ctx,row)=>(await store.listForBrain(ctx,'fictional',1)).some(value=>value.id===row.id)},
 {name:'graph and limit',read:async(ctx,row)=>(await store.listForGraph(ctx,1)).some(value=>value.id===row.id)},
 {name:'related refs',read:async(ctx,row)=>(await store.listByIds(ctx,[row.id])).some(value=>value.id===row.id)},
 {name:'path catalog',read:async(ctx,row)=>(await store.listPaths(ctx)).includes(row.path)},
 {name:'existence',read:ctx=>store.hasEntries(ctx)},
]
describe.sequential('[COMP:api/application-persistence] actual retained-source Knowledge queries',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('searches a 917-entry knowledge cohort through signed native authority',async()=>{
  const f=await persistentContextFixture('confidential')
  try{
   const role=(await getAppPool().query<{role:string;timeout:string}>(
    "SELECT current_user AS role,current_setting('statement_timeout') AS timeout")).rows[0]
   expect(role).toEqual({role:'app_user',timeout:'15s'})
   const entryCount=917
   const matchingPath='fictional-load/917'
   // 805 linked entries carry three or four references apiece (2,966 edges).
   await f.pool.query(`WITH entries AS MATERIALIZED (
     SELECT n,gen_random_uuid() AS id FROM generate_series(1,$3::integer-1) n
    ) INSERT INTO knowledge_entries(id,workspace_id,path,title,summary,content,tags,sensitivity,created_by,related_ids)
    SELECT entry.id,$1,'fictional-load/'||CASE WHEN entry.n=$3-1 THEN $3 ELSE entry.n END,
     'Fictional fixture entry '||entry.n,'Fictional fixture summary',
     repeat('Fictional synthetic notes for an invented workspace. ',75)||CASE WHEN entry.n>=$3-1 THEN 'amberneedle' ELSE '' END,
     ARRAY['fictional'],'internal',$2,ARRAY(
      SELECT target.id FROM generate_series(1,CASE WHEN entry.n<=551 THEN 4 WHEN entry.n<=805 THEN 3 ELSE 0 END) step
      JOIN entries target ON target.n=1+((entry.n-1+step)%($3::integer)) ORDER BY step
     ) FROM entries entry`,[f.workspaceId,f.ownerId,entryCount])
   const {source}=await configuredKnowledgeEntryFixture(f,{source:{repo:'fictional/knowledge-load'},
    entry:{path:matchingPath,title:'Fictional synced Knowledge entry',content:'Fictional amberneedle body',sensitivity:'internal'}})
   const sourceAuthority=await signedKnowledgeAuthority(f)
   expect(await store.getSourceForViewer(sourceAuthority.execution.security.access,source.id,sourceAuthority)).toMatchObject({repo:source.repo})
   const connectorStore=createDbConnectorStore(randomBytes(32)),settingsStore=createDbMcpSettingsStore()
   for(const [query,match] of [['amberneedle',true],['violetneedle',false]] as const){
    const {execution,accumulator}=await signedKnowledgeAuthority(f)
    const context={...executionToolContext(execution,{appId:'fictional-knowledge-load'}),scopeAccumulator:accumulator}
    const tools=new Map<string,Tool>()
    await composeSurfaceCapabilities('channel',{userId:f.ownerId,assistantId:f.assistantId,assistantTeamId:f.workspaceId,tools,
     connectorStore,settingsStore,knowledgeStore:store,executionContext:execution,scopeAccumulator:accumulator})
    const discover=tools.get('mcp_search'),invoke=tools.get('mcp_call')
    if(!discover||!invoke)throw new Error('The channel must register the MCP discovery and invocation tools')
    const discovery=await discover.execute({query:'search workspace knowledge base'},context)
    expect(discovery.isError).not.toBe(true)
    const route=String(discovery.data).match(/\[(knowledge)\]\s+(searchKnowledge):/)
    if(!route)throw new Error('The registered channel catalog must discover searchKnowledge')
    const start=performance.now()
    const result=await invoke.execute({server:route[1],tool:route[2],args:{query}},context)
    const elapsedMs=Math.round(performance.now()-start)
    console.info(JSON.stringify({scenario:match?'matching-search':'empty-search',entries:entryCount,elapsedMs,
     failure:result.isError===true?result.data:null}))
    expect(result.isError,result.isError?String(result.data):undefined).not.toBe(true)
    if(match){
     expect(result.data).toHaveLength(2)
     expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({path:matchingPath,sourceId:null,sourceLabel:'Manual entries'}),
      expect.objectContaining({path:matchingPath,sourceId:source.id,sourceLabel:source.repo}),
     ]))
    }else{
     expect(result.data).toMatch(/^No knowledge entries found for this query\./)
    }
    if(!result.scopeEvidence)throw new Error('Signed search must bind current query evidence')
    if(match)expect(result.scopeEvidence.sources).toContainEqual(expect.objectContaining({resourceKind:'knowledge_source',resourceId:source.id}))
    const sources=result.scopeEvidence.sources?.filter(source=>source.resourceKind==='application_field')??[]
    const domains=(await f.pool.query<{size:number;fields:string[]}>(`SELECT jsonb_array_length(d.domain->'candidates') AS size,d.domain->'fields' AS fields
     FROM application_field_resources r JOIN application_query_domains d ON d.workspace_id=r.workspace_id AND d.id=r.resource_id
     WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.selection='query_domain'`,[f.workspaceId,sources.map(source=>source.resourceId)])).rows
    expect(domains).toEqual([{size:entryCount,fields:['content','id','path','sourceId','summary','tags','title']}])
    accumulator.note(result.scopeEvidence)
    const admissionStart=performance.now()
    try{await admitModelInput(context)}finally{
     console.info(JSON.stringify({scenario:match?'matching-admission':'empty-admission',entries:entryCount,
      elapsedMs:Math.round(performance.now()-admissionStart)}))
    }
   }
  }finally{await f.cleanup()}
 },180_000)
 it('holds paged search when the second SQL slice reports a different query domain',async()=>{
  const f=await persistentContextFixture('confidential')
  const originalQueries=new Map<PoolClient,PoolClient['query']>()
  let slices=0,matchingStatements=0
  const trace=(client:PoolClient)=>{
   if(originalQueries.has(client))return
   const original=client.query
   originalQueries.set(client,original)
   client.query=function(...args:unknown[]){
    const sql=typeof args[0]==='string'?args[0]:''
    const result=Reflect.apply(original,client,args)
    if(!Array.isArray(args[1])||args[1][0]!==f.workspaceId)return result
    if(sql.includes('WITH knowledge_viewer_rows')&&sql.includes('plainto_tsquery'))matchingStatements++
    if(!sql.includes('read_native_knowledge_query_projection($1,$2,$3,$4,$5,$6)'))return result
    slices++
    if(slices!==2)return result
    return Promise.resolve(result).then(response=>{
     const [header,...points]=response.rows
     const sources=header.value.sources.map((source:{version:string},index:number)=>index===0?{...source,version:'fictional-different-query-domain'}:source)
     return {...response,rows:[{...header,value:{...header.value,sources}},...points]}
    })
   } as typeof client.query
  }
  try{
   await f.pool.query(`INSERT INTO knowledge_entries(workspace_id,path,title,content,sensitivity,created_by)
    SELECT $1,'fictional-stale-slice/'||n,'Fictional entry','Fictional body','internal',$2 FROM generate_series(1,385) n`,[f.workspaceId,f.ownerId])
   const authority=await signedKnowledgeAuthority(f)
   getAppPool().on('acquire',trace)
   await expect(store.searchForTool(authority.execution.security.access,'fictional',10,authority)).rejects.toThrow('scope_source_changed')
   expect(slices).toBe(2)
   expect(matchingStatements).toBe(0)
  }finally{
   getAppPool().off('acquire',trace)
   for(const [client,query] of originalQueries)client.query=query
   await f.cleanup()
  }
 },45_000)
 for(const reader of legacyReaders)it(`holds retained content before the actual legacy ${reader.name} computation while preserving an ordinary authorized control`,async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture,context=await c.context(c.f.ownerId,true),access=context.executionContext!.security.access
  const before=await c.snapshot()
  expect(await reader.read(access,c.row)).toBe(false)
  const ordinary=await store.create({workspaceId:c.f.workspaceId,path:'fictional-ordinary',title:'Fictional ordinary Knowledge',
   content:'Fictional ordinary readable Knowledge',sensitivity:c.source.root.sensitivity,compartments:[...c.source.root.compartments],
   projectIds:[...c.source.root.projectIds],createdBy:c.f.ownerId})
  expect(await reader.read(access,ordinary)).toBe(true)
  await store.delete(ordinary.id)
  expect(await reader.read(access,c.row)).toBe(false)
  expect(await c.snapshot()).toEqual(before)
 })
 for(const name of ['searchKnowledge','browseKnowledge'] as const)it(`rechecks the independent source before actual ${name} exposure and retains a separate original reader`,async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture,context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name===name)!
  const input=name==='searchKnowledge'?{query:'fictional'}:{}
  expect(JSON.stringify((await tool.execute(input,context)).data)).toContain(c.row.path)
  const before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const denied=await tool.execute(input,context)
  expect(JSON.stringify(denied)).not.toContain(c.row.path)
  expect(JSON.stringify(denied)).not.toContain(c.row.title)
  expect(JSON.stringify(denied)).not.toContain(c.row.id)
  const other=await c.context(c.f.secondId,true),current=await tool.execute(input,other)
  expect(JSON.stringify(current.data)).toContain(c.row.path)
  expect(current.scopeEvidence?.sources?.some(source=>source.resourceKind==='application_field')).toBe(true)
  expect(await c.snapshot()).toEqual(before)
 })
 it('retains an immutable current field/query-domain observation for an actually empty Knowledge query',async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture,context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name==='searchKnowledge')!
  const result=await tool.execute({query:'fictional-no-match-token'},context)
  expect(result.isError).not.toBe(true)
  const observations=result.scopeEvidence?.sources?.filter(source=>source.resourceKind==='application_field')??[]
  expect(observations.length).toBeGreaterThan(0)
  const domains=(await c.f.pool.query<{selection:string;fields:string[];type_key:string}>(`SELECT r.selection,r.fields,r.type_key
   FROM application_field_resources r JOIN application_query_domains d ON d.workspace_id=r.workspace_id AND d.id=r.resource_id
   WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.selection='query_domain'`,[c.f.workspaceId,observations.map(source=>source.resourceId)])).rows
  expect(domains).toHaveLength(1)
  expect(domains[0].type_key).toBe('knowledge_entry')
  expect(domains[0].fields).toEqual(expect.arrayContaining(['path','title','summary','content','tags']))
  expect(JSON.stringify(result.data)).not.toContain(c.row.path)
 })
 for(const name of ['searchKnowledge','browseKnowledge'] as const)it(`holds cached actual ${name} output before extraction or provider dispatch after withdrawal`,async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name===name)!
  const input=name==='searchKnowledge'?{query:'fictional'}:{},result=await tool.execute(input,context)
  expect(JSON.stringify(result.data)).toContain(c.row.path)
  if(!result.scopeEvidence)throw new Error('Actual query must retain canonical query evidence')
  context.scopeAccumulator.note(result.scopeEvidence)
  await expect(admitModelInput(context)).resolves.toBeUndefined()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const before=await c.snapshot();let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-knowledge-query',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
   yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional query title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(result.data)}}],'fixture',()=>admitModelInput(context)))
   .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  const other=await c.context(c.f.secondId,true),current=await tool.execute(input,other)
  expect(JSON.stringify(current.data)).toContain(c.row.path)
  if(!current.scopeEvidence)throw new Error('Independent current query must retain evidence')
  other.scopeAccumulator.note(current.scopeEvidence)
  await expect(generateTitle(provider,[{role:'user',content:JSON.stringify(current.data)}],'fixture',()=>admitModelInput(other)))
   .resolves.toEqual({title:'Fictional query title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
  expect(calls).toBe(1);expect(await c.snapshot()).toEqual(before)
 })
 for(const change of ['restored independent grant','new current candidate'] as const)it(`invalidates actual cached query absence before extraction after a ${change}`,async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  if(change==='restored independent grant')await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name==='searchKnowledge')!
  const result=await tool.execute({query:change==='restored independent grant'?'fictional':'fictional-never-present-value'},context)
  expect(result.isError).not.toBe(true);expect(JSON.stringify(result.data)).not.toContain(c.row.path)
  expect(result.scopeEvidence?.sources?.some(source=>source.resourceKind==='application_field')).toBe(true)
  context.scopeAccumulator.note(result.scopeEvidence)
  await expect(admitModelInput(context)).resolves.toBeUndefined()
  if(change==='restored independent grant')await c.source.pool.query(`INSERT INTO grants(kind,account_id,record_id,fields,actions)
   SELECT kind,$1,record_id,fields,actions FROM grants WHERE kind='human' AND account_id=$2`,[c.f.ownerId,c.f.secondId])
  else await store.create({workspaceId:c.f.workspaceId,path:'fictional-added-query',title:'Fictional added Knowledge',content:'Fictional new current candidate',
   sensitivity:c.source.root.sensitivity,compartments:[...c.source.root.compartments],projectIds:[...c.source.root.projectIds],createdBy:c.f.ownerId})
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-query-absence',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
   yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional absence title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(result.data)}}],'fixture',()=>admitModelInput(context)))
   .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
 })
 for(const consumer of ['searchKnowledge','readKnowledgeEntry'] as const)it(`applies real catalog and row field roles for ${consumer}, preserves a narrow summary read and a separate current reader`,async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  const pool=c.f.pool
  let registered=false
  try{
   await pool.query(`CREATE TABLE r3_knowledge_query_field_fixture(workspace_id uuid PRIMARY KEY,fields jsonb NOT NULL);
    CREATE FUNCTION r3_knowledge_query_catalog_fixture(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
     SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','knowledge-fixture-v1','policyVersion','1',
      'fieldKeys',to_jsonb(application_knowledge_field_keys()),'fields',p.fields,
      'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb))
     FROM r3_knowledge_query_field_fixture p WHERE p.workspace_id=w $$;
    CREATE FUNCTION r3_knowledge_query_record_fixture(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
     SELECT (r3_knowledge_query_catalog_fixture(w,o,t)-'scope')||jsonb_build_object('recordVersion',k.scope_version::text,'source',read_scope_source(w,'knowledge_entry',k.id))
     FROM knowledge_entries k WHERE k.workspace_id=w AND k.id=i::uuid $$;
    REVOKE ALL ON FUNCTION r3_knowledge_query_catalog_fixture(uuid,jsonb,text),r3_knowledge_query_record_fixture(uuid,jsonb,text,text) FROM PUBLIC;
    -- The disposable bootstrap creates fixtures, but the native contract requires
    -- the real ordinary schema owner. Do not weaken the installed port guard.
    DO $owner$ DECLARE owner_name name;BEGIN
     SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class WHERE oid='application_native_field_contracts'::regclass;
     EXECUTE format('ALTER TABLE r3_knowledge_query_field_fixture OWNER TO %I',owner_name);
     EXECUTE format('ALTER FUNCTION r3_knowledge_query_catalog_fixture(uuid,jsonb,text) OWNER TO %I',owner_name);
     EXECUTE format('ALTER FUNCTION r3_knowledge_query_record_fixture(uuid,jsonb,text,text) OWNER TO %I',owner_name);
    END $owner$`)
   await pool.query(`INSERT INTO r3_knowledge_query_field_fixture(workspace_id,fields)
    SELECT $1,jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='content' THEN '["body_reader"]'::jsonb ELSE '[]'::jsonb END,
     'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(application_knowledge_field_keys()) key`,[c.f.workspaceId])
   await pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
    VALUES('native','1',ARRAY['body_reader'],'r3_knowledge_query_record_fixture(uuid,jsonb,text,text)'::regprocedure,'r3_knowledge_query_catalog_fixture(uuid,jsonb,text)'::regprocedure)`)
   registered=true
   await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
    VALUES($1,'{"kind":"native","moduleKey":"native"}','knowledge_entry','native')`,[c.f.workspaceId])
   for(const user of [c.f.ownerId,c.f.secondId])await pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
    VALUES($1,'native',$2,'body_reader',$3)`,[c.f.workspaceId,user,c.f.ownerId])
   const tool=createKnowledgeTools(store).find(value=>value.name===consumer)!,input=consumer==='searchKnowledge'?{query:'fictional'}:{id:c.row.id}
   // The registered malformed role dictionary must hold, without native fallback.
   const malformed=await tool.execute(input,await c.context(c.f.ownerId,true))
   expect(malformed.isError).toBe(true);expect(JSON.stringify(malformed)).not.toContain(c.row.path)
   await pool.query(`UPDATE r3_knowledge_query_field_fixture SET fields=(SELECT jsonb_agg(
    CASE WHEN field->>'key'='content' THEN jsonb_set(field,'{read}','[["body_reader"]]'::jsonb) ELSE field END)
    FROM jsonb_array_elements(fields) field) WHERE workspace_id=$1`,[c.f.workspaceId])
   const first=await c.context(c.f.ownerId,true),result=await tool.execute(input,first)
   expect(JSON.stringify(result.data)).toContain(c.row.path)
   if(!result.scopeEvidence)throw new Error('Field-governed query must retain actual observations')
   first.scopeAccumulator.note(result.scopeEvidence)
   await expect(admitModelInput(first)).resolves.toBeUndefined()
   const before=await c.snapshot()
   let revoked=false,protectedComputations=0
   const originalQueries=new Map<PoolClient,PoolClient['query']>()
   const trace=(client:PoolClient)=>{
    if(originalQueries.has(client))return
    const original=client.query;originalQueries.set(client,original)
    client.query=function(...args:unknown[]){
     const sql=typeof args[0]==='string'?args[0]:''
     if(sql.includes('WITH knowledge_viewer_rows')&&sql.includes('jsonb_to_recordset')&&sql.includes('plainto_tsquery'))protectedComputations++
     const result=Reflect.apply(original,client,args)
     if(sql.includes('SELECT value FROM read_native_knowledge_query_projection'))return Promise.resolve(result).then(async rows=>{
      if(!revoked){revoked=true;await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND module_key='native'",[c.f.workspaceId,c.f.ownerId])}
      return rows
     })
     return result
    } as typeof client.query
   }
   if(consumer==='readKnowledgeEntry'){
    await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND module_key='native'",[c.f.workspaceId,c.f.ownerId])
    revoked=true
   }
   getAppPool().on('acquire',trace)
   try{
    const denied=await tool.execute(input,await c.context(c.f.ownerId,true))
    expect(denied.isError).toBe(true);expect(JSON.stringify(denied)).not.toContain(c.row.path)
    expect(revoked).toBe(true);expect(protectedComputations).toBe(0)
   }finally{getAppPool().off('acquire',trace);for(const [client,query] of originalQueries)client.query=query}
   const summary=await c.context(c.f.ownerId,true)
   expect((await store.listSummaries(summary.executionContext!.security.access,{execution:summary.executionContext!,accumulator:summary.scopeAccumulator})).map(row=>row.id)).toEqual([c.row.id])
   let extractions=0,calls=0
   const provider:LLMProvider={name:'fictional-knowledge-field-query',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
    yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional field query title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
   await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(result.data)}}],'fixture',()=>admitModelInput(first)))
    .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
   expect(extractions).toBe(0);expect(calls).toBe(0)
   const second=await c.context(c.f.secondId,true),current=await tool.execute(input,second)
   expect(JSON.stringify(current.data)).toContain(c.row.path)
   if(!current.scopeEvidence)throw new Error('Separate actual field-role reader must retain observations')
   second.scopeAccumulator.note(current.scopeEvidence)
   await expect(generateTitle(provider,[{role:'user',content:JSON.stringify(current.data)}],'fixture',()=>admitModelInput(second)))
    .resolves.toEqual({title:'Fictional field query title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
   expect(calls).toBe(1);expect(await c.snapshot()).toEqual(before)
  }finally{
   await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[c.f.workspaceId])
   await pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[c.f.workspaceId])
   if(registered)await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
   await pool.query(`DROP FUNCTION IF EXISTS r3_knowledge_query_record_fixture(uuid,jsonb,text,text);
    DROP FUNCTION IF EXISTS r3_knowledge_query_catalog_fixture(uuid,jsonb,text);DROP TABLE IF EXISTS r3_knowledge_query_field_fixture`)
  }
 })
 it('invalidates the actual cached query before extraction when its original assistant deny selector changes',async()=>{
  fixture=await retainedKnowledgeFixture();const c=fixture
  await c.f.pool.query("UPDATE assistants SET kind='standard' WHERE workspace_id=$1 AND id=$2",[c.f.workspaceId,c.f.assistantId])
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  const source=await store.createSource({workspaceId:c.f.workspaceId,sourceType:'local',repo:'fictional/knowledge-query'})
  const row=await store.create({workspaceId:c.f.workspaceId,path:'fictional-selector',title:'Fictional selector fixture',content:'Fictional selector token',
   sourceId:source.id,sensitivity:c.source.root.sensitivity,compartments:[...c.source.root.compartments],projectIds:[...c.source.root.projectIds],createdBy:c.f.ownerId})
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name==='searchKnowledge')!,result=await tool.execute({query:'selector'},context)
  expect(JSON.stringify(result.data)).toContain(row.id)
  if(!result.scopeEvidence)throw new Error('Selector query must retain actual observations')
  context.scopeAccumulator.note(result.scopeEvidence);await expect(admitModelInput(context)).resolves.toBeUndefined()
  await store.setSourceDisabled({assistantId:c.f.assistantId,sourceId:source.id,disabled:true,userId:c.f.ownerId})
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-knowledge-selector',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
   yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional selector title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(result.data)}}],'fixture',()=>admitModelInput(context)))
   .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  const current=await tool.execute({query:'selector'},await c.context(c.f.ownerId,true))
  expect(current.isError).not.toBe(true);expect(JSON.stringify(current.data)).not.toContain(row.id)
 })
})
