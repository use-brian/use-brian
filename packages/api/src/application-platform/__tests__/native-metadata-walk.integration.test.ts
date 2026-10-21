import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,executionToolContext,type ScopeSource} from '@use-brian/core'
import type {PoolClient} from 'pg'
import {getAppPool,getPool,rollbackAndRelease,runWithAgentAccess,applyRLSGucs} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {addSessionMessage} from '../../db/sessions.js'
import {writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
// Original 618/8011 metadata queries are independent equivalence references,
// created only on the guarded disposable owner's transaction. They never decide
// admission or replace a policy/current-source evaluator.
const referenceAncestor=String.raw`CREATE FUNCTION pg_temp.r3_reference_ancestors(p_workspace uuid,p_kind text,p_id uuid)
RETURNS TABLE(resource_id uuid) LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $reference$
DECLARE tab text; versioned boolean;
BEGIN
  IF p_kind IN('crm_event','memory_verification','brain_verification','correction_audit') THEN RETURN QUERY SELECT p_id; RETURN; END IF;
  tab=scope_source_table(p_kind);
  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  SELECT EXISTS(
    SELECT 1 FROM pg_attribute
     WHERE attrelid=format('%I',tab)::regclass AND attname='superseded_by' AND NOT attisdropped
  ) INTO versioned;
  IF NOT versioned THEN
    RETURN QUERY EXECUTE format('SELECT id FROM %I WHERE workspace_id=$2 AND id=$1',tab) USING p_id,p_workspace;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format('WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM %I WHERE workspace_id=$2 AND id=$1
    UNION SELECT r.id FROM %I r JOIN ancestry a ON r.superseded_by=a.id WHERE r.workspace_id=$2)
    SELECT id FROM ancestry',tab,tab) USING p_id,p_workspace;
END;
$reference$`
const referenceEdges=String.raw`CREATE FUNCTION pg_temp.r3_reference_edges(w uuid,k text,i uuid,v text)
RETURNS TABLE(kind text,id uuid,version text) LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $reference$
 SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
 UNION
 SELECT k,prior_id,v FROM unnest(CASE WHEN scope_source_table(k) IS NOT NULL
  THEN ARRAY(SELECT resource_id FROM scope_source_ancestors(w,k,i)) ELSE '{}'::uuid[] END) prior_id WHERE prior_id<>i
 UNION
 SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o
  WHERE k='application_field' AND o.workspace_id=w AND o.resource_id=i AND o.version=v
 UNION
 SELECT s.source_kind,s.source_id,s.source_version FROM application_field_observation_sources s
  WHERE k='application_field' AND s.workspace_id=w AND s.resource_id=i AND s.version=v
 UNION
 SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
  JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
  WHERE k='file_segment' AND fs.workspace_id=w AND fs.id=i
 UNION
 SELECT observed.value->>'resourceKind',(observed.value->>'resourceId')::uuid,observed.value->>'version'
  FROM jsonb_array_elements(CASE WHEN k='workflow_run' THEN read_workflow_derivation_inputs(w,i) ELSE '[]'::jsonb END) input
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(input#>'{evidence,sources}','[]'::jsonb)
   ||CASE WHEN jsonb_typeof(input->'blueprintSource')='object' THEN jsonb_build_array(input->'blueprintSource') ELSE '[]'::jsonb END) observed(value)
$reference$`

describe.sequential('[COMP:api/application-persistence] native metadata equivalence',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function reference<T>(read:(db:PoolClient)=>Promise<T>){
  const db=await getPool().connect()
  try{await db.query('BEGIN');await db.query(referenceAncestor);await db.query(referenceEdges);return await read(db)}
  finally{await rollbackAndRelease(db)}
 }
 async function compareEdges(db:PoolClient,sources:readonly {resourceKind:string;resourceId:string;version:string}[]){
  const f=fixture!
  expect(sources.length).toBeGreaterThan(0)
  for(const source of sources){
   const args=[f.workspaceId,source.resourceKind,source.resourceId,source.version]
   expect((await db.query('SELECT * FROM application_scope_source_edges($1,$2,$3,$4) ORDER BY kind,id,version',args)).rows)
    .toEqual((await db.query('SELECT * FROM pg_temp.r3_reference_edges($1,$2,$3,$4) ORDER BY kind,id,version',args)).rows)
  }
 }
 it('retains every memory predecessor and cycle-safe workspace and missing-root semantics',async()=>{
  fixture=await persistentContextFixture();const f=fixture,memories:Awaited<ReturnType<typeof f.memory>>[]=[]
  for(let n=0;n<4;n++)memories.push(await f.memory('Fictional ancestry '+n))
  for(let n=0;n<3;n++)await f.pool.query('UPDATE memories SET valid_to=now(),superseded_by=$2 WHERE id=$1',[memories[n].id,memories[n+1].id])
  await reference(async db=>{
   const args=[f.workspaceId,'memory',memories[3].id]
   const actual=(await db.query('SELECT * FROM scope_source_ancestors($1,$2,$3) ORDER BY resource_id',args)).rows
   expect(actual).toEqual((await db.query('SELECT * FROM pg_temp.r3_reference_ancestors($1,$2,$3) ORDER BY resource_id',args)).rows)
   expect(actual.map(row=>row.resource_id).sort()).toEqual(memories.map(memory=>memory.id).sort())
   for(const absent of [[randomUUID(),'memory',memories[3].id],[f.workspaceId,'memory',randomUUID()]]){
    expect((await db.query('SELECT * FROM scope_source_ancestors($1,$2,$3)',absent)).rows).toEqual([])
    expect((await db.query('SELECT * FROM pg_temp.r3_reference_ancestors($1,$2,$3)',absent)).rows).toEqual([])
   }
   // A cycle must terminate with the exact original UNION set.
   await db.query('UPDATE memories SET superseded_by=$2 WHERE id=$1',[memories[3].id,memories[0].id])
   expect((await db.query('SELECT * FROM scope_source_ancestors($1,$2,$3) ORDER BY resource_id',args)).rows)
    .toEqual((await db.query('SELECT * FROM pg_temp.r3_reference_ancestors($1,$2,$3) ORDER BY resource_id',args)).rows)
  })
 })
 it('retains actual session field query and immutable context edges across the full closure',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(f.firstId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority}),sources=boundScopeSources(input)
  const revision=await writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',content:{summary:'Fictional admitted context',boundarySequence:3},authority,derivation:{producer:'fixture:metadata-equivalence',sources}})
  if(!revision)throw new Error('Missing actual context revision')
  const stored=await addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional derived response',authority,derivationTarget:f.envelope,
   derivation:{producer:'fixture:metadata-equivalence',sources:[...sources,...boundScopeSources(revision)]}})
  await reference(async db=>{
   const roots=boundScopeSources(stored),args=[f.workspaceId,roots.map(root=>root.resourceKind),roots.map(root=>root.resourceId),roots.map(root=>root.version)]
   const nodes=(await db.query<{kind:string;id:string;version:string}>('SELECT * FROM application_scope_lineage($1,$2,$3,$4)',args)).rows
   for(const kind of ['session_message','application_field','application_query_domain','session_context_revision'])expect(nodes.some(node=>node.kind===kind)).toBe(true)
   await compareEdges(db,nodes.map(node=>({...f.envelope,resourceKind:node.kind,resourceId:node.id,version:node.version})))
   for(const [kind,id] of [['session_message',stored.id],['session_context_revision',revision.id]]){
    const check=[f.workspaceId,kind,id]
    expect((await db.query('SELECT * FROM scope_source_ancestors($1,$2,$3)',check)).rows)
     .toEqual((await db.query('SELECT * FROM pg_temp.r3_reference_ancestors($1,$2,$3)',check)).rows)
   }
  })
 })
 it('preserves actual generic-field fallback edges without native narrowing',async()=>{
  fixture=await persistentContextFixture();const f=fixture,store=createDbDocEntityStore({actorUserId:f.ownerId})
  const schema=await store.createEntityType({workspaceId:f.workspaceId,name:'Fictional metadata records',createdBy:f.ownerId,properties:[{name:'title',config:{kind:'text'}}]})
  const row=await store.createEntity({workspaceId:f.workspaceId,entityTypeId:schema.id,createdBy:f.ownerId,lastEditedBy:f.ownerId,sourceApp:'api',data:{title:{kind:'text',value:'Fictional metadata record'}}})
  const execution=await f.execution(f.firstId),db=await getAppPool().connect();let sources:ScopeSource[]=[]
  try{await runWithAgentAccess(execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,f.firstId)
   sources=(await db.query<{value:{sources:ScopeSource[]}}>('SELECT read_generic_application_record($1,$2,$3,$4) AS value',[f.workspaceId,schema.id,'record.'+schema.id,row.id])).rows[0].value.sources
  })}finally{await rollbackAndRelease(db)}
  await reference(db=>compareEdges(db,sources))
 })
 it('does not expose metadata helpers as an application allow token',async()=>{
  fixture=await persistentContextFixture();const f=fixture,memory=await f.memory('Fictional private metadata helper'),db=await getAppPool().connect()
  try{await expect(db.query('SELECT * FROM application_scope_source_edges($1,$2,$3,$4)',[f.workspaceId,'memory',memory.id,'1'])).rejects.toMatchObject({code:'42501'})
   await expect(db.query('SELECT * FROM scope_source_ancestors_before_browser_profile($1,$2,$3)',[f.workspaceId,'memory',memory.id])).rejects.toMatchObject({code:'42501'})
   await expect(db.query("SELECT application_session_eval_scope_current($1,$2,$3,$4,'{}'::jsonb)",[f.workspaceId,'memory',memory.id,'1'])).rejects.toMatchObject({code:'42501'})
  }finally{db.release()}
 })
 it('falls back from a simple Memory leaf after a real SQL kernel extension adds a held source',async()=>{
  fixture=await persistentContextFixture();const f=fixture;await f.history()
  const memory=await f.memory('Fictional leaf memory'),dependency=await f.memory('Fictional held extension source')
  await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[dependency.id])
  const authority=await f.modelContext(f.firstId),query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  if(!row)throw new Error('Missing actual leaf memory')
  const roots=boundScopeSources(row),root=roots[0],sources=[...boundScopeSources(query),...roots],before=structuredClone(sources)
  authority.accumulator.note({sources})
  const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  const lineage=async()=>(await f.pool.query('SELECT * FROM application_scope_lineage($1,ARRAY[$2::text],ARRAY[$3::uuid],ARRAY[$4::text])',[f.workspaceId,'memory',memory.id,root.version])).rows
  expect(await lineage()).toEqual([{kind:'memory',id:memory.id,version:root.version}])
  await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  const original=(await f.pool.query("SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_proc p WHERE p.oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure")).rows[0]
  const version=(await f.pool.query('SELECT scope_version::text AS version FROM memories WHERE id=$1',[dependency.id])).rows[0].version
  try{
   // Same SQL extension mechanism as R2; current native admission remains real.
   await f.pool.query(`CREATE OR REPLACE FUNCTION public.application_scope_source_edges(w uuid,k text,i uuid,v text)
    RETURNS TABLE(kind text,id uuid,version text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture_edges$
    ${original.body}
    UNION SELECT 'memory','${dependency.id}'::uuid,'${version}'::text
     WHERE w='${f.workspaceId}'::uuid AND k='memory' AND i='${memory.id}'::uuid
    $fixture_edges$`)
   expect(await lineage()).toEqual(expect.arrayContaining([{kind:'memory',id:memory.id,version:root.version},{kind:'memory',id:dependency.id,version}]))
   await expect(assertSourceModelInputAuthority(context)).rejects.toMatchObject({reason:'authority_changed'})
   expect(sources).toEqual(before)
  }finally{await f.pool.query(original.definition)}
  const fresh=await f.modelContext(f.firstId);fresh.accumulator.note({sources})
  await expect(assertSourceModelInputAuthority({...executionToolContext(fresh.execution,{appId:'fixture'}),scopeAccumulator:fresh.accumulator})).resolves.toBeUndefined()
 })
})
