/** Memory fields use the canonical capture/publication boundary. [COMP:api/application-persistence] */
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator, type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {publishNativeSessionMessageBatch,readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {readRetainedContextFrame} from '../../db/session-context-revisions.js'
import {tryNativeInvocationEvidence} from '../../context-scope/native-invocation-evidence.js'
import {validateCallerScopeEvidence} from '../../context-scope/caller-evidence.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
const normalize=(value:ScopeEvidence)=>({...value,sources:[...value.sources??[]].sort((a,b)=>
 `${a.resourceKind}:${a.resourceId}:${a.version}`.localeCompare(`${b.resourceKind}:${b.resourceId}:${b.version}`))})
async function setup(kind:'empty'|'index'|'point'){
 f=await persistentContextFixture()
 const memory=kind==='empty'?undefined:await f.memory('Fictional canonical Memory projection')
 const authority=await f.modelContext(f.firstId),store=createDbMemoryStore(),access=authority.execution.security.access
 const value=kind==='point'?await store.getById(access,memory!.id,authority):await store.getIndex(access,false,authority)
 const sources=boundScopeSources(value!)
 expect(sources.some(source=>source.resourceKind==='application_field')).toBe(true)
 return{fixture:f,memory,authority,sources}
}
describe.sequential('[COMP:api/application-persistence] canonical Memory field capture',()=>{
 afterEach(async()=>{await f?.cleanup();f=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it.each(['empty','index','point'] as const)('matches complete general evidence and publishes/reopens %s Memory input',async kind=>{
  const {fixture,authority,sources}=await setup(kind),execution=authority.execution
  const actual=await tryNativeInvocationEvidence(execution,{sources:[...sources]},execution.security.ceiling,'caller')
  expect(actual).not.toBeNull()
  await readRetainedContextFrame(authority,[],async client=>{
   const general={query:async(sql:string,params?:unknown[])=>sql.includes('capture_conversation_evidence')
    ?{rows:[{value:null}]}:client.query(sql,params)} as Pick<PoolClient,'query'>
   expect(normalize(actual!)).toEqual(normalize(await validateCallerScopeEvidence({sources:[...sources]},execution.security.ceiling,general)))
  })
  const content=`Fictional canonical ${kind} Memory answer`
  const [saved]=await publishNativeSessionMessageBatch({sessionId:fixture.session.id,authority,
   derivationTarget:fixture.envelope,derivation:{producer:'fixture:canonical-memory',sources:[...sources]},messages:[{role:'assistant',content}]})
  const reopened=await readAdmittedSessionQuery({sessionId:fixture.session.id,throughSequence:saved.sequenceNum,
   authority:{execution,accumulator:new ContextScopeAccumulator()}})
  expect(reopened.history.find(row=>row.id===saved.id)?.content).toBe(content)
 })
 it('admits a Memory cohort beside more than one hundred conversation roots and preserves its fresh candidate obligation',async()=>{
  const {fixture,authority,sources}=await setup('empty'),execution=authority.execution
  for(let i=0;i<101;i++)await addSessionMessage({sessionId:fixture.session.id,role:'user',content:`Fictional cohort request ${i}`,scope:fixture.envelope})
  const history=await readAdmittedSessionQuery({sessionId:fixture.session.id,throughSequence:101,authority})
  const complete=new ContextScopeAccumulator({sources:[...sources,...boundScopeSources(history)]}).evidence
  expect(complete.sources!.length).toBeGreaterThan(100)
  const admitted=await tryNativeInvocationEvidence(execution,complete,execution.security.ceiling,'caller')
  expect(admitted).not.toBeNull()
  for(const source of complete.sources!)expect(admitted!.sources).toContainEqual(source)
  await fixture.memory('Fictional newly visible complete-cohort candidate')
  await expect(tryNativeInvocationEvidence(execution,complete,execution.security.ceiling,'caller')).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
 })
 it.each(['empty','index','point'] as const)('refuses changed %s Memory evidence at capture and the actual publication',async kind=>{
  const {fixture,authority,sources,memory}=await setup(kind),execution=authority.execution,original=structuredClone(sources)
  if(memory)await fixture.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[memory.id])
  else await fixture.memory('Fictional newly visible query candidate')
  await expect(tryNativeInvocationEvidence(execution,{sources:[...sources]},execution.security.ceiling,'caller'))
   .rejects.toMatchObject({reason:'caller_evidence_unavailable'})
  const content=`Fictional withheld ${kind} Memory answer`
  await expect(publishNativeSessionMessageBatch({sessionId:fixture.session.id,authority,
   derivationTarget:fixture.envelope,derivation:{producer:'fixture:changed-memory',sources:[...sources]},messages:[{role:'assistant',content}]})).rejects.toThrow()
  expect((await fixture.pool.query('SELECT id FROM session_messages WHERE session_id=$1 AND content @> $2::jsonb',
   [fixture.session.id,JSON.stringify([{type:'text',text:content}])])).rows).toEqual([])
  expect(sources).toEqual(original)
 })
})
