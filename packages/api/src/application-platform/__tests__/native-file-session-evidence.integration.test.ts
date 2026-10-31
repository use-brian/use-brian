import {afterAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import {boundScopeSources,ContextScopeAccumulator,type ScopeEvidence} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {readRetainedContextFrame} from '../../db/session-context-revisions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import {tryNativeInvocationEvidence} from '../../context-scope/native-invocation-evidence.js'
import {validateCallerScopeEvidence} from '../../context-scope/caller-evidence.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {publishSessionTitle} from '../../db/session-title-store.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const fixtures:Awaited<ReturnType<typeof persistentContextFixture>>[]=[]
afterAll(async()=>{try{for(const f of fixtures)await f.cleanup()}finally{await getAppPool().end();await getPool().end()}})
const canonical=(value:ScopeEvidence)=>({...value,sources:[...value.sources??[]].sort((a,b)=>`${a.resourceKind}:${a.resourceId}:${a.version}`.localeCompare(`${b.resourceKind}:${b.resourceId}:${b.version}`))})

async function setup(){
 const f=await persistentContextFixture();fixtures.push(f)
 await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
  SELECT $1,'/fictional/file-'||n||'.txt','Fictional file '||n,'fixture://file-'||n,$2,'user','internal'
  FROM generate_series(1,50) n`,[f.workspaceId,f.ownerId])
 await f.memory('Fictional retained workspace fact')
 // Derived-memory shape deliberately cannot use the leaf-only Memory memo.
 await f.pool.query('UPDATE memories SET source_session_id=$2 WHERE workspace_id=$1',[f.workspaceId,f.session.id])
 await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional greeting'}],scope:f.envelope})
 const authority={execution:await f.execution(f.firstId),accumulator:new ContextScopeAccumulator()}
 const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:1,authority})
 const memories=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
 const files=await listWorkspaceFilesIndexRanked(authority.execution.security.access,50)
 expect(files).toHaveLength(50)
 const evidence=new ContextScopeAccumulator({sources:[...boundScopeSources(query),...boundScopeSources(memories),...files.flatMap(file=>boundScopeSources(file))]}).evidence
 return {f,authority,evidence}
}

/** Bypass only the new optimization to compare against the real original SQL. */
function observed(client:PoolClient,baseline:boolean,queries:string[]){
 return {query:async(sql:string,args?:unknown[])=>{
  queries.push(sql)
  if(baseline&&(sql.includes('read_native_file_session_evidence')||sql.includes('read_native_empty_query_evidence')))return {rows:[{value:null}]}
  return client.query(sql,args)
 }} as Pick<PoolClient,'query'>
}

describe.sequential('[COMP:api/application-persistence] file-backed native evidence',()=>{
 it('matches the canonical title reader before and after a file hold, without exposing private helpers',async()=>{
  const c=await setup()
  const title=await publishSessionTitle({sessionId:c.f.session.id,title:'Fictional file discussion',manual:false,
   expectedRevision:null,authority:c.authority,derivation:{producer:'fixture:title',sources:c.evidence.sources!}})
  expect(title).not.toBeNull()
  const compare=async(held:boolean)=>{
   const authority={execution:await c.f.execution(c.f.firstId),accumulator:new ContextScopeAccumulator()}
   await readRetainedContextFrame(authority,[],async client=>{
    const args=[c.f.workspaceId,c.f.session.id,title!.revisionId]
    const baseline=(await client.query('SELECT read_session_title_revision($1,$2,$3) AS value',args)).rows[0].value
    const current=(await client.query('SELECT read_native_file_session_title_revision($1,$2,$3) AS value',args)).rows[0].value
    expect(current).toEqual(baseline)
    expect(current).toEqual(held?null:{title:'Fictional file discussion',manual:false})
    expect((await client.query("SELECT has_function_privilege(current_user,'session_context_file_revision_allowed(uuid,uuid)','execute') AS allowed")).rows[0].allowed).toBe(false)
    expect((await client.query('SELECT read_native_file_session_title_revision($1,$2,$3) AS value',
     [c.f.workspaceId,c.f.session.id,crypto.randomUUID()])).rows[0].value).toBeNull()
   })
  }
  await compare(false)
  await c.f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
   SELECT workspace_id,'workspace_file',id,scope_version::text,'held',1,'Fictional review hold' FROM workspace_files WHERE workspace_id=$1`,[c.f.workspaceId])
  await compare(true)
  expect((await c.f.pool.query('SELECT read_native_file_session_title_revision($1,$2,$3) AS value',
   [c.f.workspaceId,c.f.session.id,title!.revisionId])).rows[0].value).toBeNull()
 })
 it('matches complete original validation for fifty file leaves and derived Memory without repeated field reads',async()=>{
  const c=await setup(),original:string[]=[],batched:string[]=[]
  let expected:ScopeEvidence|undefined
  await readRetainedContextFrame(c.authority,[],async client=>{
   const before=await validateCallerScopeEvidence(c.evidence,c.authority.execution.security.ceiling,observed(client,true,original))
   const after=await validateCallerScopeEvidence(c.evidence,c.authority.execution.security.ceiling,observed(client,false,batched))
   expect(canonical(after)).toEqual(canonical(before));expected=before
  })
  expect(original.some(sql=>sql.includes('read_native_session_field_dependencies'))).toBe(true)
  expect(batched.some(sql=>sql.includes('read_native_session_field_dependencies'))).toBe(false)
  expect(batched.some(sql=>sql.includes('read_native_file_session_evidence'))).toBe(true)
  expect(batched.some(sql=>sql.includes('read_native_empty_query_evidence'))).toBe(false)
  const invocation=await tryNativeInvocationEvidence(c.authority.execution,c.evidence,c.authority.execution.security.ceiling,'caller')
  expect(invocation).not.toBeNull();expect(canonical(invocation!)).toEqual(canonical(expected!))
 })

 it.each(['clearance','hold'])('preserves a fresh file %s denial in both validators',async(change)=>{
  const c=await setup()
  if(change==='clearance')await c.f.pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=$1",[c.f.workspaceId])
  else await c.f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
   SELECT workspace_id,'workspace_file',id,scope_version::text,'held',1,'Fictional review hold' FROM workspace_files WHERE workspace_id=$1`,[c.f.workspaceId])
  for(const baseline of [true,false]){
   // Resolve a fresh invocation rather than accepting a stale policy epoch.
   const authority={execution:await c.f.execution(c.f.firstId),accumulator:new ContextScopeAccumulator()}
   await expect(readRetainedContextFrame(authority,[],client=>validateCallerScopeEvidence(c.evidence,authority.execution.security.ceiling,observed(client,baseline,[]))))
    .rejects.toBeDefined()
  }
 })

 it('does not expose evidence to the privileged owner connection',async()=>{
  const c=await setup(),roots=c.evidence.sources!
  const client=await getPool().connect()
  try{
   await client.query('BEGIN')
   await client.query("SELECT set_config('app.current_user_id',$1,true)",[c.f.firstId])
   expect((await client.query('SELECT read_native_file_session_evidence($1,$2,$3,$4,true) value',
    [c.f.workspaceId,roots.map(s=>s.resourceKind),roots.map(s=>s.resourceId),roots.map(s=>s.version)])).rows[0].value).toBeNull()
  }finally{await client.query('ROLLBACK');client.release()}
 })
})
