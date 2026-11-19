import {afterAll,afterEach,describe,expect,it} from 'vitest'
import type {ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {PoolClient} from 'pg'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {scopeEvidenceFailureOf,validateAudienceScopeEvidence,validateCallerScopeEvidence} from '../caller-evidence.js'
import {persistentSourceFixture} from '../../application-platform/__tests__/fixtures/persistent-source.js'
import {pinPreparedExternalSourceAuthority} from '../../application-platform/retained-source-authority.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {createDbCommentThreadStore} from '../../db/comment-thread-store.js'
import {readSessionById} from '../../db/sessions.js'
import {publishSessionTitle} from '../../db/session-title-store.js'
import {readRetainedContextFrame} from '../../db/session-context-revisions.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

/**
 * Page source-family adapter of the native capture (migration 8278) at its real
 * boundary: an app_user transaction shaped like the session-context frame
 * (workspace row FOR SHARE, RLS GUCs), the real validator, and the same
 * validator with the adapter forced to decline (a client that answers its one
 * statement with NULL), so the complete generic validator decides. Equivalence
 * is the same admit/deny and the same label floor on every case.
 */
type Fixture=Awaited<ReturnType<typeof setup>>
type Outcome={outcome:'admit';floor:{sensitivity:string;compartments:string[];projectIds:string[]};adapter:string}|{outcome:'deny';diagnostic:string;adapter:string}
let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
async function setup(clearance:'internal'|'confidential'='internal'){
 const f=fixture=await persistentContextFixture(clearance),pool=f.pool,w=f.workspaceId
 // A Teamspace Page: its receipt carries a principal boundary (Teamspace
 // membership) that no scalar label represents. The owner is its only member.
 const teamspace=(await pool.query<{id:string}>(`INSERT INTO teamspaces(workspace_id,name,sensitivity,created_by) VALUES($1,'Fictional teamspace','internal',$2) RETURNING id`,[w,f.ownerId])).rows[0].id
 await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[teamspace,f.ownerId])
 const page=(await pool.query<{id:string;revision:string}>(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
  VALUES($1,$2,'Fictional source page','tasks','table','{"blocks":[]}','saved','internal',$3) RETURNING id,page_event_revision revision`,[w,f.ownerId,teamspace])).rows[0]
 // A shared file derived from the Page receipt: the smallest closure the
 // ordinary capture declines (workspace_file -> page_event_changed and its live
 // observation), as dock and Page titles do. The derivation writer admits the
 // Page for its member and requires every Page obligation as a source.
 const writer=await pool.connect()
 let file:{id:string}
 try{
  await writer.query('BEGIN')
  await writer.query("SELECT set_config('app.current_user_id',$1,true)",[f.ownerId])
  file=(await writer.query<{id:string}>(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   VALUES($1,'/fictional-page-export.txt','Fictional Page export','fixture://page-export',$2,'user','internal') RETURNING id`,[w,f.ownerId])).rows[0]
  const derivation=(await writer.query<{id:string}>(`INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT workspace_id,'workspace_file',id,scope_version::text,'fixture:page-closure',user_id,assistant_id,sensitivity,compartments,project_ids,
    (SELECT revision FROM workspace_access_policies WHERE workspace_id=$1) FROM workspace_files WHERE id=$2 RETURNING id`,[w,file.id])).rows[0]
  const admitted=(await writer.query<{s:{requiredSources:ScopeSource[]}&ScopeSource|null}>("SELECT read_page_derivation_source($1,'page_event_changed',$2) s",[w,page.revision])).rows[0].s
  if(!admitted)throw new Error('Fixture Page is not admitted for its member')
  for(const source of [admitted,...admitted.requiredSources])await writer.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[w,derivation.id,source.resourceKind,source.resourceId,source.version])
  await writer.query('COMMIT')
 }catch(error){await writer.query('ROLLBACK').catch(()=>{});throw error}finally{writer.release()}
 const root=(await pool.query<{s:Record<string,unknown>}>("SELECT read_scope_source($1,'workspace_file',$2) s",[w,file.id])).rows[0].s
 const {held:_held,validTo:_validTo,retractedAt:_retractedAt,...source}=root
 return {f,page,evidence:{sources:[source as unknown as ScopeSource]} satisfies ScopeEvidence,teamspace}
}
async function validate(x:Fixture,userId:string,kind:'caller'|'audience',generic:boolean,evidence:ScopeEvidence=x.evidence):Promise<Outcome>{
 const execution=await x.f.execution(userId as typeof x.f.ownerId),client=await getAppPool().connect()
 let adapter='none'
 const proxy={query:async(text:string,values?:unknown[])=>{
  if(generic && text.includes('conversation_mixed_evidence_route')) return {rows:[{route:null}]}
  if(text.startsWith('SELECT capture_page_closure_evidence')){
   if(generic){adapter='declined';return {rows:[{value:null}]}}
   const result=await client.query(text,values);adapter=result.rows[0]?.value?'admitted':'declined';return result
  }
  return client.query(text,values)
 }} as unknown as PoolClient
 try{
  return await runWithAgentAccess(execution.security.access,async()=>{
   await client.query('BEGIN')
   try{
    await applyRLSGucs(client,userId,execution.assistant.id)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[x.f.workspaceId])
    const checked=await (kind==='caller'?validateCallerScopeEvidence:validateAudienceScopeEvidence)(evidence,execution.security.ceiling,proxy)
    await client.query('COMMIT')
    return {outcome:'admit' as const,adapter,floor:{sensitivity:checked.sensitivity??'public',compartments:[...checked.compartments??[]].sort(),projectIds:[...checked.projectIds??[]].sort()}}
   }catch(error){
    await client.query('ROLLBACK').catch(()=>{})
    return {outcome:'deny' as const,adapter,diagnostic:scopeEvidenceFailureOf(error)??String((error as Error).message)}
   }
  })
 }finally{client.release()}
}
async function equivalent(x:Fixture,userId:string,evidence:ScopeEvidence=x.evidence){
 const results=[]
 for(const kind of ['caller','audience'] as const){
  const adapter=await validate(x,userId,kind,false,evidence),generic=await validate(x,userId,kind,true,evidence)
  expect(adapter.outcome).toBe(generic.outcome)
  if(adapter.outcome==='admit'&&generic.outcome==='admit')expect(adapter.floor).toEqual(generic.floor)
  results.push(adapter)
 }
 return results
}

describe.sequential('[COMP:api/page-closure-adapter] Page-derived closures are admitted by the native capture with the generic authority result',()=>{
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})

 it('admits the creator through the adapter and matches the generic validator (caller and audience)',async()=>{
  const x=await setup()
  for(const result of await equivalent(x,x.f.ownerId)){expect(result).toMatchObject({outcome:'admit',adapter:'admitted'})}
 })

 it('refuses a workspace member outside the Teamspace exactly as the generic validator does',async()=>{
  const x=await setup()
  for(const result of await equivalent(x,x.f.secondId))expect(result.outcome).toBe('deny')
 })

 it('follows Teamspace membership: admitted once a member, refused after removal',async()=>{
  const x=await setup()
  await x.f.pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[x.teamspace,x.f.secondId])
  for(const result of await equivalent(x,x.f.secondId))expect(result).toMatchObject({outcome:'admit',adapter:'admitted'})
  await x.f.pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[x.teamspace,x.f.secondId])
  for(const result of await equivalent(x,x.f.secondId))expect(result.outcome).toBe('deny')
 })

 it('decides a Page made private to its creator exactly as the generic validator does',async()=>{
  const x=await setup()
  await x.f.pool.query('UPDATE saved_views SET teamspace_id=NULL WHERE id=$1',[x.page.id])
  expect((await equivalent(x,x.f.ownerId))).toHaveLength(2)
 })

 it('never treats a missing Page receipt as a deletion',async()=>{
  const x=await setup()
  await x.f.pool.query('DELETE FROM workflow_page_event_receipts WHERE revision=$1',[x.page.revision])
  for(const result of await equivalent(x,x.f.ownerId))expect(result.outcome).toBe('deny')
 })

 it('reads a Page-derived title payload through the adapter (8286), refusing exactly where the full evaluation refuses',async()=>{
  const x=await setup()
  const thread = await createDbCommentThreadStore().createThread({ userId: x.f.ownerId, workspaceId: x.f.workspaceId,
   assistantId: x.f.assistantId, pageId: x.page.id, anchorKind: 'human_range' })
  const session = await readSessionById(thread.sessionId)
  if (!session) throw new Error('Missing authoritative Page thread session')
  const authority={execution:await x.f.execution(x.f.ownerId,session),accumulator:new ContextScopeAccumulator()}
  const title=await publishSessionTitle({sessionId:session.id,title:'Fictional Page discussion',manual:false,
   expectedRevision:null,authority,derivation:{producer:'fixture:page-title',sources:x.evidence.sources}})
  expect(title).not.toBeNull()
  const read=async(userId:string)=>{
   const reader={execution:await x.f.execution(userId as typeof x.f.ownerId,session),accumulator:new ContextScopeAccumulator()}
   return readRetainedContextFrame(reader,[],async client=>{
    const value=(await client.query('SELECT read_session_title_revision($1,$2,$3) AS value',[x.f.workspaceId,session.id,title!.revisionId])).rows[0].value
    // The same revision admitted by the Page adapter and by nothing else in this statement.
    const proof=(await client.query('SELECT capture_page_closure_evidence($1,$2,$3) AS value',[x.f.workspaceId,
     JSON.stringify([{kind:'session_context_revision',id:title!.revisionId,version:'1'}]),userId])).rows[0].value
    return {value,admittedByAdapter:proof?.admitted===true}
   })
  }
  expect(await read(x.f.ownerId)).toEqual({value:{title:'Fictional Page discussion',manual:false},admittedByAdapter:true})
  // Outside the Teamspace: the adapter declines and the original evaluation refuses.
  expect(await read(x.f.secondId)).toEqual({value:null,admittedByAdapter:false})
  // A missing receipt is never a deletion: the adapter declines and the original
  // evaluation fails closed (its Page ancestry reader raises), as before 8286.
  await x.f.pool.query('DELETE FROM workflow_page_event_receipts WHERE revision=$1',[x.page.revision])
  await expect(read(x.f.ownerId)).rejects.toThrow()
 })

 it('admits a Page receipt that is itself a root (a doc-thread turn reads its Page) with the generic result (8288)',async()=>{
  const x=await setup()
  const page=(await x.f.pool.query<{s:Record<string,unknown>}>("SELECT read_scope_source($1,'page_event_changed',$2) s",[x.f.workspaceId,x.page.revision])).rows[0].s
  const {held:_h,validTo:_v,retractedAt:_r,...pageSource}=page
  const evidence={sources:[pageSource as unknown as ScopeSource,...x.evidence.sources]}
  for(const result of await equivalent(x,x.f.ownerId,evidence))expect(result).toMatchObject({outcome:'admit',adapter:'admitted'})
  for(const result of await equivalent(x,x.f.secondId,evidence))expect(result.outcome).toBe('deny')
 })

 it('proves a native Page closure and independent source on the same transaction, then refuses either revocation', async () => {
  const x = await setup('confidential')
  const independent = await persistentSourceFixture(x.f)
  const native = x.evidence.sources[0]
  const sources = [native, ...independent.observations]
  try {
   const read = async (kind: 'caller' | 'audience', appendIndependentEdge?: () => Promise<void>) => {
    const execution = await x.f.execution()
    const prepared = await independent.coordinator.prepare(execution, independent.observations, kind === 'caller' ? 'context' : 'deliver')
    const client = await getAppPool().connect()
    let captured = 0, checkedIndependently = 0
    const measured = {
     query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT capture_page_closure_evidence')) {
       const roots = JSON.parse(String(values?.[1]))
       expect(roots.map((r: { id: string }) => r.id)).toEqual([native.resourceId])
       captured++
      }
      if (sql.includes('external_source_snapshot')) {
       checkedIndependently++
       await appendIndependentEdge?.()
      }
      if (sql.includes('read_admitted_session_context_dependencies')) {
       expect(values?.[2]).not.toContain(native.resourceId)
      }
      return client.query(sql, values)
     },
    } as unknown as PoolClient
    try {
     return await runWithAgentAccess(execution.security.access, async () => {
      await client.query('BEGIN')
      await applyRLSGucs(client, x.f.ownerId, execution.assistant.id)
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [x.f.workspaceId])
      await pinPreparedExternalSourceAuthority(client, execution, prepared)
      const check = kind === 'caller' ? validateCallerScopeEvidence : validateAudienceScopeEvidence
      const admitted = await check({ sources }, execution.security.ceiling, measured)
      expect(admitted.sensitivity).toBe(independent.observations[0].sensitivity)
      expect(admitted.sources).toEqual(expect.arrayContaining(sources))
      expect(captured).toBe(1)
      expect(checkedIndependently).toBe(1)
      await client.query('COMMIT')
     })
    } finally {
     await rollbackAndRelease(client)
    }
   }
   await read('caller')
   await read('audience')
   await independent.pool.query("UPDATE grants SET actions=array_remove(actions,'deliver') WHERE account_id=$1", [x.f.ownerId])
   await expect(read('audience')).rejects.toThrow()
   await read('caller')
   const extra=(await x.f.pool.query<{ id: string; version: string }>(`
    INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
    VALUES($1,'/fictional-mixed-lineage.txt','Fictional lineage append','fixture://lineage-append',$2,'user','internal')
    RETURNING id,scope_version::text AS version`,[x.f.workspaceId,x.f.ownerId])).rows[0]
   const appendEdge = async () => {
    const writer = await x.f.pool.connect()
    try {
     await writer.query('BEGIN')
     await writer.query("SELECT set_config('app.current_user_id',$1,true),set_config('statement_timeout','2000ms',true)",[x.f.ownerId])
     const edge = await writer.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
      SELECT workspace_id,id,'workspace_file',$3,$4 FROM scope_derivations
      WHERE workspace_id=$1 AND resource_id=$2 AND resource_kind='workspace_file'`,
     [x.f.workspaceId,native.resourceId,extra.id,extra.version])
     expect(edge.rowCount).toBe(1)
     await writer.query('COMMIT')
    } finally {
     await rollbackAndRelease(writer)
    }
   }
   await expect(read('caller', appendEdge)).rejects.toMatchObject({ diagnostic: 'source_unverifiable' })
   await read('caller')
   await x.f.pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2', [x.teamspace, x.f.ownerId])
   await expect(read('caller')).rejects.toMatchObject({ diagnostic: 'source_unverifiable' })
  } finally {
   await independent.cleanup()
  }
 })

 it('admits more than 100 roots instead of refusing at the lineage reader (8288)',async()=>{
  const x=await setup()
  const files=(await x.f.pool.query<{s:Record<string,unknown>}>(`WITH f AS (INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   SELECT $1,'/fictional/root-'||n||'.txt','Fictional root '||n,'fixture://root-'||n,$2,'user','internal' FROM generate_series(1,110) n RETURNING id)
   SELECT read_scope_source($1,'workspace_file',f.id) s FROM f`,[x.f.workspaceId,x.f.ownerId])).rows.map(row=>{const {held:_h,validTo:_v,retractedAt:_r,...rest}=row.s;return rest as unknown as ScopeSource})
  const evidence={sources:[...x.evidence.sources,...files]}
  expect(evidence.sources.length).toBeGreaterThan(100)
  for(const result of await equivalent(x,x.f.ownerId,evidence))expect(result).toMatchObject({outcome:'admit',adapter:'admitted'})
 })

 it('keeps the two-role model: owner logins and a foreign actor obtain nothing, internal helpers stay owner-only',async()=>{
  const x=await setup(),roots=JSON.stringify([{kind:x.evidence.sources[0].resourceKind,id:x.evidence.sources[0].resourceId,version:x.evidence.sources[0].version}])
  // An owner login never obtains an admission: since 8287 the member declines (NULL) instead of raising.
  expect((await x.f.pool.query('SELECT capture_page_closure_evidence($1,$2,$3) value',[x.f.workspaceId,roots,x.f.ownerId])).rows[0].value).toBeNull()
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN');await applyRLSGucs(client,x.f.ownerId)
   expect((await client.query('SELECT capture_page_closure_evidence($1,$2,$3) value',[x.f.workspaceId,roots,x.f.secondId])).rows[0].value).toBeNull()
   await client.query('SAVEPOINT helper')
   await expect(client.query("SELECT conversation_dag($1,'[]','[]')",[x.f.workspaceId])).rejects.toMatchObject({code:'42501'})
   await client.query('ROLLBACK TO SAVEPOINT helper')
   await expect(client.query('SELECT read_page_event_authority($1,$2,$3)',[x.f.workspaceId,x.page.revision,x.f.ownerId])).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release()}
 })

 it('holds the Page principal edge with a row lock: the default-Teamspace heal proceeds, removal of the edge waits',async()=>{
  const x=await setup()
  const execution=await x.f.execution(x.f.ownerId),reader=await getAppPool().connect(),writer=await x.f.pool.connect()
  try{
   await runWithAgentAccess(execution.security.access,async()=>{
    await reader.query('BEGIN');await applyRLSGucs(reader,x.f.ownerId,execution.assistant.id)
    await reader.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[x.f.workspaceId])
    await validateCallerScopeEvidence(x.evidence,execution.security.ceiling,reader)
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='1500ms'")
    // Another user's membership (the heal's shape) no longer queues behind a table lock.
    await writer.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)',[x.teamspace,x.f.firstId])
    await writer.query('SAVEPOINT edge')
    await expect(writer.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[x.teamspace,x.f.ownerId])).rejects.toMatchObject({code:'55P03'})
    await writer.query('ROLLBACK');await reader.query('COMMIT')
   })
  }finally{await writer.query('ROLLBACK').catch(()=>{});await reader.query('ROLLBACK').catch(()=>{});writer.release();reader.release()}
 })

 it('refuses when the registry member changed, and admits again once restored',async()=>{
  const x=await setup()
  try{
   await x.f.pool.query('ALTER FUNCTION capture_page_closure_evidence(uuid,jsonb,uuid) COST 101')
   expect((await validate(x,x.f.ownerId,'caller',false)).outcome).toBe('deny')
  }finally{await x.f.pool.query('ALTER FUNCTION capture_page_closure_evidence(uuid,jsonb,uuid) COST 100')}
  expect(await validate(x,x.f.ownerId,'caller',false)).toMatchObject({outcome:'admit',adapter:'admitted'})
 })
})
