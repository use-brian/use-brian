import {afterAll,afterEach,describe,expect,it} from 'vitest'
import type {ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {applyRLSGucs,getAppPool,getPool,runWithAgentAccess} from '../../db/client.js'
import {scopeEvidenceFailureOf,validateAudienceScopeEvidence,validateCallerScopeEvidence} from '../caller-evidence.js'
import {beginClosureAdmission,openTurnAdmissionClosure,type TurnAdmissionClosure} from '../admission-closure.js'
import {admitModelSourceEvidence} from '../../application-platform/model-source-authority.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

/** [COMP:api/turn-admission-closure]
 * Per-turn admission closure (Decision 10 step one) at its real boundary: the
 * closure a turn owner opens for its invocation lease, the real validators on
 * an app_user transaction shaped like the native admissions, and the real
 * model-source admission (discovery plus proof). Each admission through the
 * closure is compared with the same admission without it (no closure bound to
 * its lease). A source revoked between two admissions of one turn is caught by
 * the second.
 */
type Execution=Awaited<ReturnType<Awaited<ReturnType<typeof persistentContextFixture>>['execution']>>
type Outcome={outcome:'admit';floor:{sensitivity:string;compartments:string[];projectIds:string[]};sources:string[]}|{outcome:'deny';diagnostic:string}
let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
const closures:TurnAdmissionClosure[]=[]
async function setup(){
 const f=fixture=await persistentContextFixture('internal'),pool=f.pool,w=f.workspaceId
 // A Teamspace Page and a shared file derived from its receipt (the smallest
 // closure only the Page source-family adapter admits), as in the 8278 suite.
 const teamspace=(await pool.query<{id:string}>(`INSERT INTO teamspaces(workspace_id,name,sensitivity,created_by) VALUES($1,'Fictional teamspace','internal',$2) RETURNING id`,[w,f.ownerId])).rows[0].id
 await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2),($1,$3)',[teamspace,f.ownerId,f.secondId])
 const page=(await pool.query<{id:string;revision:string}>(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
  VALUES($1,$2,'Fictional source page','tasks','table','{"blocks":[]}','saved','internal',$3) RETURNING id,page_event_revision revision`,[w,f.ownerId,teamspace])).rows[0]
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
 const strip=(row:Record<string,unknown>)=>{const {held:_h,validTo:_v,retractedAt:_r,...source}=row;return source as unknown as ScopeSource}
 const root=strip((await pool.query<{s:Record<string,unknown>}>("SELECT read_scope_source($1,'workspace_file',$2) s",[w,file.id])).rows[0].s)
 const pageRoot=strip((await pool.query<{s:Record<string,unknown>}>("SELECT read_scope_source($1,'page_event_changed',$2) s",[w,page.revision])).rows[0].s)
 // A doc-thread turn reads its Page directly: the receipt is a root too.
 return {f,page,file,teamspace,evidence:{sources:[root,pageRoot]} satisfies ScopeEvidence}
}
type Fixture=Awaited<ReturnType<typeof setup>>
/** One turn: an execution whose lease has its own closure, as the owner opens it. */
function openTurn(execution:Execution){
 const closure=openTurnAdmissionClosure(execution)
 if(!closure)throw new Error('The turn closure did not open')
 closures.push(closure)
 return closure
}
/** The same admission with no closure bound: a copy of the execution never matches the turn's binding. */
const unbound=(execution:Execution)=>({...execution,security:{...execution.security}}) as Execution
async function validate(x:Fixture,execution:Execution,kind:'caller'|'audience',shared:boolean,evidence:ScopeEvidence=x.evidence):Promise<Outcome>{
 const client=await getAppPool().connect()
 try{
  return await runWithAgentAccess(execution.security.access,async()=>{
   await client.query('BEGIN')
   try{
    await applyRLSGucs(client,execution.security.access.userId,execution.assistant.id)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[x.f.workspaceId])
    const view=shared?beginClosureAdmission(execution):undefined
    if(shared)expect(view).toBeDefined()
    const checked=kind==='caller'?await validateCallerScopeEvidence(evidence,execution.security.ceiling,client,undefined,view)
     :await validateAudienceScopeEvidence(evidence,execution.security.ceiling,client,undefined,view)
    await client.query('COMMIT')
    return {outcome:'admit' as const,floor:{sensitivity:checked.sensitivity??'public',compartments:[...checked.compartments??[]].sort(),projectIds:[...checked.projectIds??[]].sort()},
     sources:(checked.sources??[]).map(source=>JSON.stringify([source.resourceKind,source.resourceId,source.version,source.sensitivity])).sort()}
   }catch(error){
    await client.query('ROLLBACK').catch(()=>{})
    return {outcome:'deny' as const,diagnostic:scopeEvidenceFailureOf(error)??String((error as Error).message)}
   }
  })
 }finally{client.release()}
}
async function modelInput(x:Fixture,execution:Execution):Promise<{outcome:string;floor?:unknown;code?:string}>{
 const accumulator=new ContextScopeAccumulator(structuredClone(x.evidence))
 try{
  await admitModelSourceEvidence({...executionToolContext(execution,{appId:'closure-regression'}),scopeAccumulator:accumulator},'context')
  const evidence=accumulator.evidence
  return {outcome:'admit',floor:{sensitivity:evidence.sensitivity,compartments:[...evidence.compartments??[]].sort(),projectIds:[...evidence.projectIds??[]].sort()}}
 }catch(error){return {outcome:'deny',code:(error as {code?:string}).code}}
}
/** Every admission through the closure equals the same admission without it. */
async function both(x:Fixture,execution:Execution,evidence:ScopeEvidence=x.evidence){
 const results:Outcome[]=[]
 for(const kind of ['caller','audience'] as const){
  const shared=await validate(x,execution,kind,true,evidence),fresh=await validate(x,unbound(execution),kind,false,evidence)
  expect(shared).toEqual(fresh)
  results.push(shared)
 }
 return results
}

describe.sequential('[COMP:api/turn-admission-closure] one closure proof per turn, every principal compared on its own',()=>{
 afterEach(async()=>{for(const closure of closures.splice(0))closure.dispose();await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})

 it('proves the closure once and shares it with later admissions of the turn, with identical outcomes',async()=>{
  const x=await setup(),execution=await x.f.execution(x.f.ownerId),closure=openTurn(execution)
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  const stats=closure.stats()
  expect(stats.sharedProofs).toBeGreaterThanOrEqual(2)
  expect(stats.discarded).toBe(0)
 })

 it('catches a source revoked between two admissions of one turn: the second refuses, as a fresh admission does',async()=>{
  const x=await setup(),execution=await x.f.execution(x.f.secondId),closure=openTurn(execution)
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  // The Page's principal boundary changes mid-turn: the reader leaves the Teamspace.
  await x.f.pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[x.teamspace,x.f.secondId])
  for(const result of await both(x,execution))expect(result.outcome).toBe('deny')
  expect(closure.stats().discarded).toBeGreaterThanOrEqual(1)
 })

 it('catches a held source and a deleted receipt between admissions',async()=>{
  const x=await setup(),execution=await x.f.execution(x.f.ownerId),closure=openTurn(execution)
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  await x.f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
   SELECT workspace_id,'workspace_file',id,scope_version::text,'held',1,'fictional review' FROM workspace_files WHERE id=$1`,[x.file.id])
  for(const result of await both(x,execution))expect(result.outcome).toBe('deny')
  await x.f.pool.query('DELETE FROM scope_resource_states WHERE resource_id=$1',[x.file.id])
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  await x.f.pool.query('DELETE FROM workflow_page_event_receipts WHERE revision=$1',[x.page.revision])
  for(const result of await both(x,execution))expect(result.outcome).toBe('deny')
  expect(closure.stats().discarded).toBeGreaterThanOrEqual(2)
 })

 it('decides a Page moved out of its Teamspace mid-turn exactly as a fresh admission does',async()=>{
  const x=await setup(),execution=await x.f.execution(x.f.ownerId),closure=openTurn(execution)
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  // The saved boundary no longer matches the current one: the receipt's
  // version is stale for this principal, so a fresh admission refuses too.
  await x.f.pool.query("UPDATE saved_views SET teamspace_id=NULL WHERE id=$1",[x.page.id])
  for(const result of await both(x,execution))expect(result.outcome).toBe('deny')
  expect(closure.stats().discarded).toBeGreaterThanOrEqual(1)
 })

 it('derives the proof of added roots it already reached, equal to a fresh proof, and refuses after a mid-turn revocation',async()=>{
  const x=await setup(),execution=await x.f.execution(x.f.secondId),closure=openTurn(execution)
  // The derived file alone reaches the Page receipt; a doc turn later adds the receipt as a root.
  const reached={sources:[x.evidence.sources[0]]}
  for(let round=0;round<2;round++)for(const result of await both(x,execution,reached))expect(result.outcome).toBe('admit')
  for(const result of await both(x,execution))expect(result.outcome).toBe('admit')
  expect(closure.stats().extendedProofs).toBeGreaterThanOrEqual(1)
  await x.f.pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[x.teamspace,x.f.secondId])
  for(const result of await both(x,execution))expect(result.outcome).toBe('deny')
  for(const result of await both(x,execution,reached))expect(result.outcome).toBe('deny')
 })

 it('never lets one principal reuse another principal\'s proof, and never outlives its turn or lease',async()=>{
  const x=await setup(),owner=await x.f.execution(x.f.ownerId),other=await x.f.execution(x.f.secondId)
  const closure=openTurn(owner)
  await both(x,owner)
  // Another member's execution has its own lease: no closure is bound for it.
  expect(beginClosureAdmission(other)).toBeUndefined()
  // A second owner cannot bind a second closure to a lease that already has one.
  expect(openTurnAdmissionClosure(owner)).toBeUndefined()
  closure.dispose()
  expect(beginClosureAdmission(owner)).toBeUndefined()
  // A later turn starts empty: it proves again before anything is shared.
  const next=openTurn(owner)
  await both(x,owner)
  expect(next.stats().proofs).toBeGreaterThanOrEqual(1)
 })

 it('keeps the model-input admission equal to a fresh one inside an open closure and refuses after a mid-turn revocation',async()=>{
  const x=await setup(),execution=await x.f.execution(x.f.secondId),closure=openTurn(execution)
  const first=await modelInput(x,execution),fresh=await modelInput(x,unbound(execution))
  expect(first).toEqual(fresh)
  expect(first.outcome).toBe('admit')
  // This closure has no field or turn-frame ancestry, so the model-input
  // admission takes its owner-pool validator and never reaches the shared
  // proof; it must still equal the fresh admission inside an open closure.
  for(let admission=0;admission<3;admission++)expect(await modelInput(x,execution)).toEqual(fresh)
  expect(closure.stats().discarded).toBe(0)
  await x.f.pool.query('DELETE FROM teamspace_members WHERE teamspace_id=$1 AND user_id=$2',[x.teamspace,x.f.secondId])
  const revoked=await modelInput(x,execution),revokedFresh=await modelInput(x,unbound(execution))
  expect(revoked).toEqual(revokedFresh)
  expect(revoked.outcome).toBe('deny')
 })
})
