/** Real Memory collections: source decisions precede protected computation. */
import {afterAll,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {memoryRoutes} from '../../routes/memories.js'
import type {EntityLinksStore} from '@use-brian/core/entities/types.js'
import type {MemoryRecallBuffer} from '@use-brian/core/memory/recall-buffer.js'
import {createMemoryTools} from '@use-brian/core/memory/tools.js'
import {createRetrievalTools} from '@use-brian/core/retrieval/tools.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool,runWithAgentAccess} from '../../db/client.js'
import {initializeConversationVisibility} from '../../db/conversation-visibility.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createMemory,readMemorySearchHits} from '../../db/memories.js'
import {createDbRetrievalStore} from '../../db/retrieval-store.js'
import {publishNativeSessionMessageBatch,readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {readRetainedContextFrame} from '../../db/session-context-revisions.js'
import {admitModelInput} from '../../context-scope/admission.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {sourceModeFixture} from './fixtures/source-modes.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {originalMemoryAuthority,saveOriginalMemory} from './fixtures/retained-memory.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbMemoryStore()
describe.sequential('[COMP:api/application-persistence] actual retained Memory collections',()=>{
 afterAll(async()=>{configureConnectorSourceRuntimeFactory(undefined);await getAppPool().end();await getPool().end()})
 it('delivers bounded topical Memory hits with exact field evidence and keeps that evidence in the saved reply',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const {f}=x
   const first=await f.memory('Fictional lavender quasar first visible',f.ownerId)
   const second=await f.memory('Fictional lavender quasar second visible',f.ownerId)
   const hidden=await f.memory('Fictional lavender quasar private peer',f.firstId)
   const held=await f.memory('Fictional lavender quasar held',f.ownerId)
   await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[held.id])
   await f.pool.query(`INSERT INTO public.memories(workspace_id,user_id,assistant_id,created_by_user_id,summary,sensitivity)
    SELECT $1,$2,$3,$2,'Fictional unrelated Memory '||n,'internal' FROM generate_series(1,4100) n`,[f.workspaceId,f.ownerId,f.assistantId])
   const current=await originalMemoryAuthority(x),access=current.execution.security.access
   const unused=async():Promise<never>=>{throw new Error('Unexpected retrieval method')}
   const embedding=[1,...Array<number>(767).fill(0)]
   await f.pool.query('UPDATE memories SET embedding=$2::vector WHERE id=$1',[second.id,`[${embedding.join(',')}]`])
   const retrieval=createRetrievalTools({...createDbRetrievalStore({embedder:{embed:async()=>[embedding]}}),
    getEntity:unused,provenance:unused,aggregate:unused,
    markUseful:unused,getRowHistory:unused})
   const execute=(cursor?:string)=>runWithAgentAccess(access,()=>retrieval.search.execute({query:'lavender quasar',scope:'memory',limit:1,
    ...(cursor?{cursor}:{}),semantic:false},current.context))
   const result=await execute()
   expect(result.isError,JSON.stringify(result.data)).not.toBe(true)
   const page=result.data as {data:{row_id:string;summary:string}[];meta:{cursor:string|null;truncated:boolean}}
   expect(page.data).toHaveLength(1)
   expect(page.meta.truncated).toBe(true)
   expect(page.meta.cursor).toBeTruthy()
   const next=await execute(page.meta.cursor!)
   expect(next.isError,JSON.stringify(next.data)).not.toBe(true)
   const nextPage=next.data as typeof page
   expect(nextPage.data).toHaveLength(1)
   expect(nextPage.meta).toMatchObject({cursor:null,truncated:false})
   expect(new Set([page.data[0].row_id,nextPage.data[0].row_id])).toEqual(new Set([first.id,second.id]))
   expect(JSON.stringify([result.data,next.data])).not.toContain(hidden.summary)
   expect(JSON.stringify([result.data,next.data])).not.toContain(held.summary)
   const vector=await runWithAgentAccess(access,()=>retrieval.search.execute({query:'fictional vector-only topic',scope:'memory',limit:1},current.context))
   expect(vector.isError,JSON.stringify(vector.data)).not.toBe(true)
   expect((vector.data as typeof page).data).toMatchObject([{row_id:second.id,summary:second.summary}])
   expect(vector.scopeEvidence?.sources).toContainEqual(expect.objectContaining({resourceKind:'memory',resourceId:second.id,version:'1'}))
   const sources=result.scopeEvidence?.sources ?? []
   const selected=sources.find(source=>source.resourceKind==='memory')
   expect(selected).toMatchObject({resourceId:page.data[0].row_id,version:'1'})
   const fields=sources.filter(source=>source.resourceKind==='application_field')
   expect(fields).toHaveLength(1)
   expect((await f.pool.query(`SELECT fields FROM application_field_resources WHERE workspace_id=$1
    AND id=$2 AND type_key='memory' AND selection='read'`,[f.workspaceId,fields[0].resourceId])).rows).toEqual([
    {fields:['compartments','id','project_ids','retracted_at','sensitivity','summary','tags','valid_from','valid_to']},
   ])
   current.accumulator.note(result.scopeEvidence!)
   await expect(admitModelInput(current.context)).resolves.toBeUndefined()
   const [reply]=await publishNativeSessionMessageBatch({sessionId:current.session.id,authority:current,
    derivationTarget:{...f.envelope,userId:f.ownerId},derivation:{producer:'fixture:topical-memory-search-reply',sources},
    messages:[{role:'assistant',senderAssistantId:f.assistantId,content:'Fictional published topical match'}]})
   const stored=await readAdmittedSessionQuery({sessionId:current.session.id,throughSequence:reply.sequenceNum,authority:current})
   expect(stored.history.at(-1)?.content).toBe('Fictional published topical match')
   const declarations=await f.pool.query(`SELECT e.source_id,e.source_version FROM scope_derivation_sources e
    JOIN scope_derivations d ON d.workspace_id=e.workspace_id AND d.id=e.derivation_id
    WHERE e.workspace_id=$1 AND d.producer='fixture:topical-memory-search-reply'`,[f.workspaceId])
   expect(declarations.rows).toContainEqual({source_id:fields[0].resourceId,source_version:fields[0].version})
   await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[page.data[0].row_id])
   await expect(admitModelInput(current.context)).rejects.toMatchObject({reason:'authority_changed'})
   const fresh=await originalMemoryAuthority(x)
   await expect(readMemorySearchHits(fresh.execution.security.access,fresh,[{id:page.data[0].row_id,version:'1'}]))
    .rejects.toMatchObject({code:'scope_source_changed'})
  }finally{await x.cleanup()}
 },120000)
 it('admits actual text/prefix/index/ranked collections under the original private actor and excludes withdrawn sources before count and rank',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await saveOriginalMemory(x,'governed',false),current=await originalMemoryAuthority(x),access=current.execution.security.access
   const search=await store.search(access,{query:'source-backed',limit:1},current)
   expect(search.map(row=>row.id)).toEqual([saved.id])
   expect((await store.search(access,{query:'',idPrefix:saved.id.slice(0,8)},current)).map(row=>row.id)).toEqual([saved.id])
   expect((await store.getIndex(access,false,current)).map(row=>row.id)).toContain(saved.id)
   const ranked=await store.getIndexRanked(access,1,current)
   expect(ranked.rows).toHaveLength(1);expect(ranked.totalCount).toBe(2)
   expect(boundScopeSources(ranked).some(source=>source.resourceKind==='application_field')).toBe(true)
   const emptyWorkspace=await store.getWorkspaceIndex(access,false,current)
   expect(emptyWorkspace).toEqual([]);expect(boundScopeSources(emptyWorkspace).some(source=>source.resourceKind==='application_field')).toBe(true)
   const before=(await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,saved.id])).rows[0].source
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const after=await originalMemoryAuthority(x),result=await store.search(after.execution.security.access,{query:'source-backed',limit:1},after)
   expect(result).toEqual([]);expect(boundScopeSources(result).some(source=>source.resourceKind==='application_field')).toBe(true)
   const contracted=await store.getIndexRanked(after.execution.security.access,10,after)
   expect(contracted.totalCount).toBe(1);expect(contracted.rows.map(row=>row.id)).not.toContain(saved.id)
   expect((await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,saved.id])).rows[0].source).toEqual(before)
  }finally{await x.cleanup()}
 })
 it.each([false,true])('keeps each private prompt index and its own evidence under the paired frame, department v2 %s',async(departmentV2)=>{
  const x=await sourceModeFixture('internal')
  try{
   const {workspaceId,assistantId,ownerId}=x.f
   await x.f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[workspaceId,departmentV2])
   const params={workspaceId,assistantId,createdByUserId:ownerId,sensitivity:'internal' as const}
   const personal=await createMemory({...params,userId:ownerId,summary:'Fictional ranked private index memory'})
   const current=await originalMemoryAuthority(x),access=current.execution.security.access
   const readPair=()=>store.getPairedPromptIndexes!(access,1,current)
   const emptyWorkspace=await readPair()
   expect(emptyWorkspace.workspace).toEqual({status:'fulfilled',value:[]})
   expect(emptyWorkspace.ranked).toMatchObject({status:'fulfilled',value:{rows:[{id:personal.id}],totalCount:1}})
   const team=await createMemory({...params,userId:null,scope:'workspace',summary:'Fictional team index memory'})
   await x.f.pool.query('UPDATE memories SET last_recalled_at=now() WHERE id=$1',[personal.id])
   const paired=await readPair()
   const scalarRanked=await store.getIndexRanked(access,1,current),scalarWorkspace=await store.getWorkspaceIndex(access,false,current)
   expect(paired).toEqual({ranked:{status:'fulfilled',value:scalarRanked},workspace:{status:'fulfilled',value:scalarWorkspace}})
   if(paired.ranked.status!=='fulfilled'||paired.workspace.status!=='fulfilled')throw new Error('Missing paired proof')
   expect(paired.ranked.value).toMatchObject({rows:[{id:personal.id}],totalCount:2})
   expect(paired.workspace.value.map(row=>row.id)).toEqual([team.id])
   expect(boundScopeSources(paired.ranked.value)).toEqual(boundScopeSources(scalarRanked))
   expect(boundScopeSources(paired.workspace.value)).toEqual(boundScopeSources(scalarWorkspace))
   expect(boundScopeSources(paired.ranked.value)).not.toEqual(boundScopeSources(paired.workspace.value))
   await expect(store.getPairedPromptIndexes!({...access,userId:x.f.secondId},1,current)).rejects.toMatchObject({code:'scope_evidence_missing'})
  }finally{await x.cleanup()}
 })
 it('delegates a complete native Memory query cohort with a source-denied independent candidate to the full source validator',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await saveOriginalMemory(x,'governed',false)
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const current=await originalMemoryAuthority(x),rows=await store.search(current.execution.security.access,{query:'fictional-never-matches'},current)
   expect(rows).toEqual([])
   const roots=boundScopeSources(rows),domainIds=(await x.f.pool.query<{id:string}>(
    "SELECT id FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND type_key='memory' AND selection='query_domain'",[x.f.workspaceId,roots.map(source=>source.resourceId)])).rows.map(row=>row.id)
   const domains=roots.filter(source=>source.resourceKind==='application_field'&&domainIds.includes(source.resourceId))
   expect(domains).toHaveLength(1)
   const value=await readRetainedContextFrame(current,domains,async db=>(await db.query<{value:unknown}>(
    'SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',[x.f.workspaceId,domains.map(s=>s.resourceKind),domains.map(s=>s.resourceId),domains.map(s=>s.version)])).rows[0].value)
   expect(value).toBeNull()
   expect((await store.search(current.execution.security.access,{query:'source-backed'},current)).map(row=>row.id)).not.toContain(saved.id)
   // A denied independent candidate is absent from stored result ancestry.
   // Reopening its source grant must still invalidate the original query floor
   // at the actual model boundary, through the canonical capture's coordinator.
   current.accumulator.note({sources:roots})
   await expect(admitModelInput(current.context)).resolves.toBeUndefined()
   await x.sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'record-1',ARRAY['description','cost'],ARRAY['read','context','derive','retain','deliver','export','mutate'])",[x.f.ownerId])
   await expect(admitModelInput(current.context)).rejects.toMatchObject({reason:'authority_changed'})
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('retains empty-query domain evidence and invalidates cached absence when the complete current cohort changes',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   await saveOriginalMemory(x,'governed',false)
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const current=await originalMemoryAuthority(x),access=current.execution.security.access
   const empty=await store.search(access,{query:'fictional-never-match-token'},current)
   expect(empty).toEqual([])
   const sources=boundScopeSources(empty);expect(sources.some(source=>source.resourceKind==='application_field')).toBe(true)
   const domains=(await x.f.pool.query(`SELECT q.domain,r.fields FROM application_field_resources r JOIN application_query_domains q
    ON q.workspace_id=r.workspace_id AND q.id=r.resource_id WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.selection='query_domain'`,
    [x.f.workspaceId,sources.map(source=>source.resourceId)])).rows
   expect(domains).toHaveLength(1);expect(domains[0].domain.kind).toBe('memory_query_domain_v1')
   expect(domains[0].fields).toEqual(expect.arrayContaining(['summary','detail','tags','recall_count','last_recalled_at']))
   current.accumulator.note({sources});await expect(admitModelInput(current.context)).resolves.toBeUndefined()
   await x.f.memory('Fictional new current native candidate')
   await expect(admitModelInput(current.context)).rejects.toMatchObject({reason:'authority_changed'})
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('keeps retired Memory source ancestry only for the exact original query candidate',async()=>{
  const x=await sourceModeFixture('internal')
  const proofHelper=`memory_candidate_fixture_${crypto.randomUUID().replaceAll('-','')}`
  const {workspaceId,pool}=x.f
  try{
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const saved=await saveOriginalMemory(x,'governed',false)
   // The public dispatcher can decline either input in its compiled precheck.
   // Observe the generic owner's own verdict with the original app_user login.
   await pool.query(`CREATE FUNCTION public.${proofHelper}(uuid,jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
     SELECT public.capture_conversation_evidence_generic($1,$2,NULL,NULL)
    $fixture$;
    REVOKE ALL ON FUNCTION public.${proofHelper}(uuid,jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.${proofHelper}(uuid,jsonb) TO app_user`)
   const domainRoots=async(sources:ScopeSource[])=>{
    const ids=(await pool.query<{id:string}>(
     "SELECT id FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND type_key='memory' AND selection='query_domain'",
     [workspaceId,sources.map(source=>source.resourceId)])).rows.map(row=>row.id)
    const selected=sources.filter(source=>source.resourceKind==='application_field'&&ids.includes(source.resourceId))
    expect(selected).toHaveLength(1)
    return selected.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version}))
   }
   const before=await originalMemoryAuthority(x)
   const found=await store.search(before.execution.security.access,{query:'source-backed'},before)
   expect(found.map(row=>row.id)).toContain(saved.id)
   const historical=await domainRoots(boundScopeSources(found))
   await pool.query('UPDATE memories SET valid_to=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,saved.id])
   const after=await originalMemoryAuthority(x)
   const current=await store.search(after.execution.security.access,{query:'source-backed'},after)
   expect(current.map(row=>row.id)).not.toContain(saved.id)
   const fresh=await domainRoots(boundScopeSources(current))
   expect(fresh).not.toEqual(historical)
   const prove=(roots:typeof fresh)=>readRetainedContextFrame(after,[],async client=>(await client.query(
    `SELECT public.${proofHelper}($1,$2) AS value`,[workspaceId,JSON.stringify(roots)])).rows[0].value)
   expect(await prove(historical)).toBeNull()
   expect(await prove(fresh)).toMatchObject({admitted:true})

   // The retired row is still locked before selection. If it becomes live
   // while the reader waits, the exact old query must reconsider its ancestry.
   const writer=await pool.connect()
   let reader:Promise<unknown>|undefined
   try{
    await writer.query('BEGIN')
    const {pid}=(await writer.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]
    await writer.query('UPDATE memories SET valid_to=NULL WHERE workspace_id=$1 AND id=$2',[workspaceId,saved.id])
    reader=prove(fresh)
    void reader.catch(()=>{})
    let waiting=false
    for(let attempt=0;attempt<100&&!waiting;attempt++){
     waiting=(await pool.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND usename='app_user' AND $1=ANY(pg_blocking_pids(pid))) waiting`,[pid])).rows[0].waiting
     if(!waiting)await new Promise(resolve=>setTimeout(resolve,10))
    }
    expect(waiting).toBe(true)
    await writer.query('COMMIT')
    expect(await reader).toBeNull()
   }finally{
    await writer.query('ROLLBACK')
    writer.release()
    await reader?.catch(()=>{})
   }
  }finally{
   configureConnectorSourceRuntimeFactory(undefined)
   try{await pool.query(`DROP FUNCTION IF EXISTS public.${proofHelper}(uuid,jsonb)`)}
   finally{await x.cleanup()}
  }
 },60_000)
 it('holds a cached actual query on source contraction and preserves native audience denial for another source-authorized reader',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await saveOriginalMemory(x,'governed',false)
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const current=await originalMemoryAuthority(x),result=await store.search(current.execution.security.access,{query:'source-backed'},current)
   expect(result.map(row=>row.id)).toContain(saved.id)
   current.accumulator.note({sources:boundScopeSources(result)});await expect(admitModelInput(current.context)).resolves.toBeUndefined()
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   await expect(admitModelInput(current.context)).rejects.toMatchObject({reason:'authority_changed'})
   const other=await originalMemoryAuthority(x,x.f.secondId),otherRows=await store.search(other.execution.security.access,{query:'source-backed'},other)
   expect(otherRows).toEqual([])
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('enforces real Memory own-field roles at point reads and preserves a narrower summary index',async()=>{
  const x=await sourceModeFixture('internal')
  let registered=false
  try{
   const saved=await saveOriginalMemory(x,'governed',false),pool=x.f.pool
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   await pool.query(`CREATE TABLE r3_memory_field_fixture(workspace_id uuid PRIMARY KEY,fields jsonb NOT NULL);
    CREATE FUNCTION r3_memory_field_catalog(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
     SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','memory-fixture-v1','policyVersion','1',
      'fieldKeys',to_jsonb(application_memory_field_keys()),'fields',p.fields,
      'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb))
     FROM r3_memory_field_fixture p WHERE p.workspace_id=w $$;
    CREATE FUNCTION r3_memory_field_record(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
     SELECT (r3_memory_field_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id))
     FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
    REVOKE ALL ON FUNCTION r3_memory_field_catalog(uuid,jsonb,text),r3_memory_field_record(uuid,jsonb,text,text) FROM PUBLIC;
    DO $owner$ DECLARE migration_owner text:=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='application_native_field_contracts'::regclass);BEGIN
     EXECUTE format('ALTER TABLE r3_memory_field_fixture OWNER TO %I',migration_owner);
     EXECUTE format('ALTER FUNCTION r3_memory_field_catalog(uuid,jsonb,text) OWNER TO %I',migration_owner);
     EXECUTE format('ALTER FUNCTION r3_memory_field_record(uuid,jsonb,text,text) OWNER TO %I',migration_owner);
    END $owner$`)
   await pool.query(`INSERT INTO r3_memory_field_fixture(workspace_id,fields)
    SELECT $1,jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='detail' THEN '[["detail_reader"]]'::jsonb ELSE '[]'::jsonb END,
     'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(application_memory_field_keys()) key`,[x.f.workspaceId])
   await pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
    VALUES('native','1',ARRAY['detail_reader'],'r3_memory_field_record(uuid,jsonb,text,text)'::regprocedure,'r3_memory_field_catalog(uuid,jsonb,text)'::regprocedure)`)
   registered=true
   await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
    VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`,[x.f.workspaceId])
   await pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
    VALUES($1,'native',$2,'detail_reader',$2)`,[x.f.workspaceId,x.f.ownerId])
   const current=await originalMemoryAuthority(x),row=await store.getById(current.execution.security.access,saved.id,current)
   expect(row).toMatchObject({id:saved.id,summary:'Fictional source-backed memory tool result',detail:'Fictional preserved mixed ancestry'})
   expect(boundScopeSources(row!).some(source=>source.resourceKind==='application_field')).toBe(true)
   current.accumulator.note({sources:boundScopeSources(row!)})
   await expect(admitModelInput(current.context)).resolves.toBeUndefined()
   const native=await createMemory({workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:x.f.assistantId,createdByUserId:x.f.ownerId,
    summary:'Fictional native private cohort control',detail:'Fictional role protected native detail',sensitivity:'internal'})
   const nativeCurrent=await originalMemoryAuthority(x),nativeRow=await store.getById(nativeCurrent.execution.security.access,native.id,nativeCurrent)
   expect(nativeRow?.detail).toBe('Fictional role protected native detail')
   const nativeSources=boundScopeSources(nativeRow!);nativeCurrent.accumulator.note({sources:nativeSources})
   const nativeCohort=await readRetainedContextFrame(nativeCurrent,nativeSources,async db=>(await db.query<{value:unknown}>(
    'SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',[x.f.workspaceId,nativeSources.map(s=>s.resourceKind),nativeSources.map(s=>s.resourceId),nativeSources.map(s=>s.version)])).rows[0].value)
   expect(nativeCohort).toMatchObject({admitted:true})
   await expect(admitModelInput(nativeCurrent.context)).resolves.toBeUndefined()
   const auth=await authSessionStore.create(x.f.ownerId,{deviceLabel:'Fictional field browser',userAgent:'Fixture',ipAddress:'127.0.0.1'})
   if(!auth)throw new Error('Missing actual Memory field browser session')
   const secret='fictional-native-memory-field-http-secret',token=createTokens(x.f.ownerId,secret,auth).accessToken
   const http=express();http.use('/api/assistants/:assistantId/memories',requireAuth(secret),memoryRoutes())
   const point=()=>request(http).get(`/api/assistants/${x.f.assistantId}/memories/${saved.id}`).set('Authorization',`Bearer ${token}`)
   expect((await point()).status).toBe(200)
   await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND module_key='native'",[x.f.workspaceId,x.f.ownerId])
   const after=await originalMemoryAuthority(x)
   expect(await store.getById(after.execution.security.access,native.id,after)).toBeNull()
   await expect(admitModelInput(nativeCurrent.context)).rejects.toMatchObject({reason:'authority_changed'})
   expect(await store.getById(after.execution.security.access,saved.id,after)).toBeNull()
   const unavailable=await point();expect(unavailable.status).toBe(404)
   expect(JSON.stringify(unavailable.body)).not.toContain('Fictional preserved mixed ancestry')
   const index=await store.getIndexRanked(after.execution.security.access,10,after)
   expect(index.rows.map(row=>row.id)).toContain(saved.id)
   await expect(admitModelInput(current.context)).rejects.toMatchObject({reason:'authority_changed'})
   // The ranked read additionally asks for created_at. Refusing that field
   // must preserve the fresh scalar workspace result and its own evidence.
   await pool.query(`UPDATE r3_memory_field_fixture p SET fields=(SELECT jsonb_agg(CASE WHEN value->>'key'='created_at'
    THEN jsonb_set(value,'{read}','[["detail_reader"]]'::jsonb) ELSE value END) FROM jsonb_array_elements(p.fields)) WHERE p.workspace_id=$1`,[x.f.workspaceId])
   const limited=await originalMemoryAuthority(x),ctx=limited.execution.security.access
   const paired=await store.getPairedPromptIndexes!(ctx,10,limited)
   expect(paired.ranked).toMatchObject({status:'rejected',reason:{code:'42501',message:'query_domain_unavailable'}})
   const workspace=await store.getWorkspaceIndex(ctx,false,limited)
   expect(paired.workspace).toEqual({status:'fulfilled',value:workspace})
   if(paired.workspace.status!=='fulfilled')throw new Error('Missing authorized workspace result')
   expect(boundScopeSources(paired.workspace.value)).toEqual(boundScopeSources(workspace))
   await initializeConversationVisibility()
   const roomFixture = await persistentContextFixture('internal')
   try {
    await roomFixture.pool.query('INSERT INTO r3_memory_field_fixture SELECT $1,fields FROM r3_memory_field_fixture WHERE workspace_id=$2',
     [roomFixture.workspaceId,x.f.workspaceId])
    await roomFixture.pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
      VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`,[roomFixture.workspaceId])
    const shared = await roomFixture.modelContext()
    const sharedAccess = shared.execution.security.access
    const team = await createMemory({workspaceId:roomFixture.workspaceId,assistantId:roomFixture.assistantId,userId:null,
     createdByUserId:roomFixture.ownerId,summary:'Fictional independent Room field floor',scope:'workspace',sensitivity:'internal'})
    const room = await store.getPairedPromptIndexes!(sharedAccess,10,shared)
    expect(room.ranked).toMatchObject({status:'rejected',reason:{code:'42501',message:'query_domain_unavailable'}})
    const roomScalar = await store.getWorkspaceIndex(sharedAccess,false,shared)
    expect(room.workspace).toEqual({status:'fulfilled',value:roomScalar})
    if (room.workspace.status!=='fulfilled') throw new Error('Missing authorized Room workspace result')
    expect(room.workspace.value.map(row=>row.id)).toContain(team.id)
    expect(boundScopeSources(room.workspace.value)).toEqual(boundScopeSources(roomScalar))
   } finally {await roomFixture.cleanup()}
  }finally{
   configureConnectorSourceRuntimeFactory(undefined)
   await x.f.pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   await x.f.pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[x.f.workspaceId])
   if(registered)await x.f.pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
   await x.f.pool.query(`DROP FUNCTION IF EXISTS r3_memory_field_record(uuid,jsonb,text,text);
    DROP FUNCTION IF EXISTS r3_memory_field_catalog(uuid,jsonb,text);DROP TABLE IF EXISTS r3_memory_field_fixture`)
   await x.cleanup()
  }
 })
 it('uses actual authenticated native HTTP point/search/list authority and refuses source or device contraction',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   const saved=await saveOriginalMemory(x,'governed',false)
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const auth=await authSessionStore.create(x.f.ownerId,{deviceLabel:'Fictional Memory browser',userAgent:'Fixture',ipAddress:'127.0.0.1'})
   if(!auth)throw new Error('Missing actual Memory browser session')
   const secret='fictional-native-memory-http-secret',token=createTokens(x.f.ownerId,secret,auth).accessToken
   const app=express();app.use('/api/assistants/:assistantId/memories',requireAuth(secret),memoryRoutes())
   const base=`/api/assistants/${x.f.assistantId}/memories`,read=(path:string)=>request(app).get(base+path).set('Authorization',`Bearer ${token}`)
   const point=await read('/'+saved.id)
   expect(point.status,JSON.stringify(point.body)).toBe(200)
   expect(point.headers['cache-control']).toBe('no-store');expect(point.body.memory.id).toBe(saved.id)
   const search=await read('/search?q=source-backed');expect(search.status,JSON.stringify(search.body)).toBe(200)
   expect(search.body.memories.map((row:{id:string})=>row.id)).toContain(saved.id)
   const list=await read('');expect(list.status,JSON.stringify(list.body)).toBe(200)
   expect(list.body.memories.map((row:{id:string})=>row.id)).toContain(saved.id)
   await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const denied=await read('/'+saved.id);expect(denied.status).toBe(404);expect(JSON.stringify(denied.body)).not.toContain('Fictional source-backed')
   const filtered=await read('/search?q=source-backed');expect(filtered.status,JSON.stringify(filtered.body)).toBe(200)
   expect(filtered.body.memories).toEqual([])
   await authSessionStore.revokeForUser(x.f.ownerId,auth.id)
   expect((await read('')).status).toBe(401)
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('preserves canonical source-backed saves while holding unscoped graph, analytics and recall callbacks',async()=>{
  const x=await sourceModeFixture('internal')
  let edgeCalls=0,eventCalls=0,recallCalls=0
  const entityLinks={create:async()=>{edgeCalls++;return{id:crypto.randomUUID()}}} as unknown as EntityLinksStore
  const recallBuffer={push:()=>{recallCalls++},pushMany:()=>{recallCalls++}} as unknown as MemoryRecallBuffer
  try{
   const current=await originalMemoryAuthority(x)
   await current.runtime.read!('readRecord',{id:'record-1',fields:['description']})
   const retainedStore=createDbMemoryStore({entityLinks}),tools=createMemoryTools(retainedStore,{entityLinksStore:entityLinks,recallBuffer,onEvent:()=>{eventCalls++}})
   const saved=await tools.saveMemory.execute({summary:'Fictional protected callback memory',links:[{targetEntityId:crypto.randomUUID(),edgeType:'mentioned'}]},current.context)
   expect(saved.isError,JSON.stringify(saved)).not.toBe(true)
   expect(String(saved.data)).toContain('relationship links were not created')
   const id=String(saved.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(id).toBeTruthy()
   expect((await tools.getMemory.execute({id},current.context)).isError).not.toBe(true)
   const refused=await tools.saveMemory.execute({summary:'Fictional refused linked note',entityId:crypto.randomUUID()},current.context)
   expect(refused.isError).toBe(true)
   expect(edgeCalls).toBe(0);expect(eventCalls).toBe(0);expect(recallCalls).toBe(0)
   expect((await x.f.pool.query('SELECT recall_count FROM memories WHERE workspace_id=$1 AND id=$2',[x.f.workspaceId,id])).rows).toEqual([{recall_count:0}])
   const direct=await retainedStore.create({authority:current,assistantId:x.f.assistantId,userId:x.f.ownerId,createdByUserId:x.f.ownerId,
    summary:'Fictional protected implicit hook',sensitivity:'confidential',linkedEntityIds:[crypto.randomUUID()],
    derivation:{producer:'fixture:retained-memory-hook',sources:current.accumulator.evidence.sources??[]},derivationTarget:{userId:x.f.ownerId,assistantId:null}})
   expect(direct.id).toBeTruthy();expect(edgeCalls).toBe(0)
   // This observes the legacy callback contract only; it does not qualify graph SQL.
   await createMemory({workspaceId:x.f.workspaceId,assistantId:x.f.assistantId,userId:x.f.ownerId,createdByUserId:x.f.ownerId,
    summary:'Fictional ordinary native callback control',sensitivity:'internal',linkedEntityIds:[crypto.randomUUID()]},entityLinks)
   expect(edgeCalls).toBe(1)
  }finally{await x.cleanup()}
 })
 it('refuses a complete metadata cohort above the explicit bound without returning a truncated domain',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   // Synthetic ordinary native inputs; real nonowner runtime discovery still enforces the bound.
   const client=await x.f.pool.connect()
   try{
    await client.query('BEGIN')
    for(let n=1;n<=4097;n++)await createMemory({workspaceId:x.f.workspaceId,userId:x.f.ownerId,assistantId:x.f.assistantId,
     summary:'Fictional bounded candidate '+n,sensitivity:'internal',createdByUserId:x.f.ownerId},undefined,client)
    await client.query('COMMIT')
   }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
   const current=await originalMemoryAuthority(x)
   await expect(store.getIndexRanked(current.execution.security.access,1,current)).rejects.toMatchObject({code:'42501',message:'query_domain_complexity_unavailable'})
   await expect(store.getPairedPromptIndexes!(current.execution.security.access,1,current)).rejects.toMatchObject({code:'42501',message:'query_domain_complexity_unavailable'})
  }finally{await x.cleanup()}
 })
})
