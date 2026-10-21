import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,executionToolContext} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {bindSessionContextRetainedAuthority,readSessionContextRevisions,writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] complete original session cohort consumers',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture('confidential');const f=fixture,plain=await f.history();independent=await persistentSourceFixture(f);const source=independent
  configureConnectorSourceRuntimeFactory(source.factory,{instances:source.instances})
  const carrier=await source.writeTranscript(),grant=(await source.pool.query('DELETE FROM grants WHERE account_id=$1 RETURNING kind,account_id,record_id,fields,actions',[f.ownerId])).rows[0]
  const authority=await f.modelContext();bindSessionContextRetainedAuthority(authority.execution,(execution,sources,action)=>source.coordinator.prepare(execution,sources,action))
  const captured=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority}),sources=boundScopeSources(captured)
  expect(captured.history.map(row=>row.id)).toEqual(plain.map(row=>row.id));expect(sources.some(root=>root.resourceKind==='external_source')).toBe(false)
  const before=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  const grantAccess=()=>source.pool.query('INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES($1,$2,$3,$4,$5)',[grant.kind,grant.account_id,grant.record_id,grant.fields,grant.actions])
  const unchanged=async()=>expect((await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows.filter(row=>before.some(original=>original.resource_id===row.resource_id&&original.version===row.version))).toEqual(before)
  return{f,source,carrier,authority,captured,sources,grantAccess,unchanged}
 }
 it('keeps source-denied physical query candidates on the full current cohort validator path',async()=>{
  const {authority,sources}=await setup(),db=await getAppPool().connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,authority.execution.security.access.userId)
   const result=(await db.query<{value:unknown}>('SELECT read_native_session_evidence($1,$2,$3,$4) AS value',[
    authority.execution.security.access.workspaceId,sources.map(root=>root.resourceKind),sources.map(root=>root.resourceId),sources.map(root=>root.version)])).rows[0].value
   expect(result).toBeNull()
  })}finally{await rollbackAndRelease(db)}
 })
 for(const boundary of ['model input','model output'] as const)it('holds stale absence before '+boundary+' after an actual independent source grant gain',async()=>{
  const {f,source,carrier,authority,sources,grantAccess,unchanged}=await setup()
  authority.accumulator.note({sources});const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  const check=boundary==='model input'?assertSourceModelInputAuthority:assertSourceModelOutputAuthority
  // Source-denied candidates leave the native-only original query usable.
  await expect(check(context)).resolves.toBeUndefined()
  await grantAccess();let exposures=0
  await expect((async()=>{await check(context);exposures++})()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(exposures).toBe(0);expect(authority.accumulator.evidence.sources).toEqual(sources)
  const other=await f.modelContext(f.secondId),prefix=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum-1,authority:other})
  other.accumulator.note({sources:boundScopeSources(prefix)});await expect(check({...executionToolContext(other.execution,{appId:'fixture'}),scopeAccumulator:other.accumulator})).resolves.toBeUndefined()
  expect(await source.independentlyAuthorized()).toBe(true);await unchanged()
 })
 for(const boundary of ['transcript publication','context publication'] as const)it('refuses stale query derivation at '+boundary+' and preserves an independent current writer',async()=>{
  const {f,source,carrier,authority,sources,grantAccess,unchanged}=await setup()
  const producer='fixture:cohort-publication',derivation={producer,sources}
  await grantAccess()
  const attempt=boundary==='transcript publication'?addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional stale absence reply',authority,derivation,derivationTarget:f.envelope})
   :writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',content:{summary:'Fictional stale absence summary',boundarySequence:3},authority,derivation})
  await expect(attempt).rejects.toMatchObject({code:'scope_source_changed'})
  expect((await f.pool.query('SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1 AND producer=$2',[f.workspaceId,producer])).rows[0].count).toBe(0)
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(4)
  const current=await f.modelContext(f.secondId);bindSessionContextRetainedAuthority(current.execution,(execution,roots,action)=>source.coordinator.prepare(execution,roots,action))
  const fresh=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority:current})
  expect(fresh.history.at(-1)?.id).toBe(carrier.id)
  const written=await addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional current query reply',authority:current,derivation:{producer,sources:boundScopeSources(fresh)},derivationTarget:f.envelope})
  expect(written.sequenceNum).toBe(5);await unchanged()
 })
 it('holds a persisted context revision on replay after its original source-denied cohort grows',async()=>{
  const {f,source,carrier,authority,sources,grantAccess,unchanged}=await setup()
  const revision=await writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',content:{summary:'Fictional bounded summary',boundarySequence:3},authority,derivation:{producer:'fixture:cohort-replay',sources}})
  expect(revision?.id).toEqual(expect.any(String))
  expect((await readSessionContextRevisions(f.session.id,'compact_summary',authority)).map(row=>row.id)).toEqual([revision!.id])
  await grantAccess();expect(await readSessionContextRevisions(f.session.id,'compact_summary',authority)).toEqual([])
  const current=await f.modelContext(f.secondId);bindSessionContextRetainedAuthority(current.execution,(execution,roots,action)=>source.coordinator.prepare(execution,roots,action))
  const fresh=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority:current})
  const replacement=await writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',content:{summary:'Fictional refreshed bounded summary',boundarySequence:4},expectedCursor:3,authority:current,derivation:{producer:'fixture:cohort-refresh',sources:boundScopeSources(fresh)}})
  expect((await readSessionContextRevisions(f.session.id,'compact_summary',current)).map(row=>row.id)).toEqual([replacement!.id]);await unchanged()
 })
 it('fails closed on an unavailable current cohort instead of treating an unknown source as denied',async()=>{
  const {f,source,authority,sources,unchanged}=await setup();authority.accumulator.note({sources})
  await source.pool.query('ALTER TABLE grants RENAME TO temporarily_unavailable_grants')
  await expect(assertSourceModelInputAuthority({...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator})).rejects.toMatchObject({code:'source_unavailable',reason:'authority_changed',retrySafe:false})
  await expect(addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional unavailable cohort reply',authority,derivation:{producer:'fixture:cohort-unavailable',sources},derivationTarget:f.envelope})).rejects.toMatchObject({code:'source_unavailable'})
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(4)
  await source.pool.query('ALTER TABLE temporarily_unavailable_grants RENAME TO grants')
  const current=await f.modelContext(),prefix=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority:current})
  current.accumulator.note({sources:boundScopeSources(prefix)});await expect(assertSourceModelInputAuthority({...executionToolContext(current.execution,{appId:'fixture'}),scopeAccumulator:current.accumulator})).resolves.toBeUndefined();await unchanged()
 })
})
