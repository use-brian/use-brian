import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,type ScopeSource} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {bindSessionContextRetainedAuthority} from '../../db/session-context-revisions.js'
import {createAttendedDeliveryAudienceAuthorizer,validateAttendedAudienceEvidence} from '../../context-scope/attended-audience.js'
import {roomAudienceCeiling} from '../../routes/_room-binding.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] [COMP:api/delivery-authority] actual attended field audience',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('admits the actual common session audience with original field/query observations',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext()
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  expect(boundScopeSources(input).length).toBeGreaterThan(0)
  const authorize=createAttendedDeliveryAudienceAuthorizer(authority.execution)
  const result=await authorize({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,channelType:'web',channelId:f.session.channelId,sessionId:f.session.id,recipientType:'group',scopeEvidence:{sources:boundScopeSources(input)}})
  expect(result.allowed).toBe(true)
 })

 async function prepared(userId?:NonNullable<typeof fixture>['ownerId']){
  const f=fixture!,history=await f.history(),authority=await f.modelContext(userId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  return {authority,evidence:{sources:boundScopeSources(input)}}
 }
 it('admits the original empty query domain without replacing the invocation identity',async()=>{
  fixture=await persistentContextFixture();const f=fixture,authority=await f.modelContext(),identity=structuredClone(authority.execution.identity)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority})
  const result=await validateAttendedAudienceEvidence(authority.execution,{sources:boundScopeSources(input)},roomAudienceCeiling(f.workspaceId,f.session))
  expect(result.sources?.length).toBeGreaterThan(0);expect(authority.execution.identity).toEqual(identity)
 })
 it('refuses another named recipient without inventing a replacement native invocation',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,evidence}=await prepared(),other=await f.execution(f.secondId)
  await expect(validateAttendedAudienceEvidence(authority.execution,evidence,other.security.ceiling)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect(authority.execution.security.access.userId).toBe(f.ownerId)
  expect(await validateAttendedAudienceEvidence(authority.execution,evidence,authority.execution.security.ceiling)).toMatchObject({sources:expect.any(Array)})
 })
 it('holds a narrower current destination before computation while preserving another admitted destination',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,evidence}=await prepared(),room=roomAudienceCeiling(f.workspaceId,f.session)
  await expect(validateAttendedAudienceEvidence(authority.execution,evidence,{...room,clearance:'public'})).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect(await validateAttendedAudienceEvidence(authority.execution,evidence,room)).toMatchObject({sources:expect.any(Array)})
 })
 it('refuses original query-domain contraction without changing its immutable observations',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,evidence}=await prepared()
  const before=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  const message=(await f.history())[0]
  await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[message.id,JSON.stringify([{type:'text',text:'Fictional changed bounded query input'}])])
  await expect(validateAttendedAudienceEvidence(authority.execution,evidence,roomAudienceCeiling(f.workspaceId,f.session))).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect((await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows).toEqual(before)
 })
 it('holds a revoked actor while a separate current member remains usable',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,evidence}=await prepared(f.firstId)
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(validateAttendedAudienceEvidence(authority.execution,evidence,roomAudienceCeiling(f.workspaceId,f.session))).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  const second=await prepared(f.secondId)
  expect(await validateAttendedAudienceEvidence(second.authority.execution,second.evidence,roomAudienceCeiling(f.workspaceId,f.session))).toMatchObject({sources:expect.any(Array)})
 })

 it('keeps a wider original empty domain held instead of rewriting its bounds for a narrower audience',async()=>{
  fixture=await persistentContextFixture();const f=fixture,authority=await f.modelContext(),client=await getAppPool().connect()
  let wide:ReturnType<typeof boundScopeSources>=[]
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   const result=(await client.query<{value:{sources:ReturnType<typeof boundScopeSources>}}>('SELECT value FROM read_native_application_session_history($1,$2,0)',[f.workspaceId,f.session.id])).rows
   wide=result[0].value.sources;await client.query('COMMIT')
  })}finally{await rollbackAndRelease(client)}
  const frozen=(await f.pool.query('SELECT domain FROM application_query_domains WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
  await expect(validateAttendedAudienceEvidence(authority.execution,{sources:wide},roomAudienceCeiling(f.workspaceId,f.session))).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect((await f.pool.query('SELECT domain FROM application_query_domains WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual(frozen)
  const current=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority})
  expect(boundScopeSources(current).map(source=>source.resourceId)).not.toEqual(wide.map(source=>source.resourceId))
  expect(await validateAttendedAudienceEvidence(authority.execution,{sources:boundScopeSources(current)},roomAudienceCeiling(f.workspaceId,f.session))).toMatchObject({sources:expect.any(Array)})
 })

 it('requires actual deliver permission independently of context rights for the original named human',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture;independent=await persistentSourceFixture(f)
  const execution=await f.execution(),evidence={sources:[independent.root]},prepareSource=(current:typeof execution,sources:readonly ScopeSource[],action:'context'|'deliver')=>independent!.coordinator.prepare(current,sources,action)
  const options={prepareSource,directHumanSource:true}
  expect(await validateAttendedAudienceEvidence(execution,evidence,execution.security.ceiling,options)).toMatchObject({sources:expect.any(Array)})
  await independent.pool.query("UPDATE grants SET actions=array_remove(actions,'deliver') WHERE account_id=$1",[f.ownerId])
  expect(await independent.coordinator.prepare(execution,evidence.sources,'context')).toMatchObject({operationId:expect.any(String)})
  await expect(validateAttendedAudienceEvidence(execution,evidence,execution.security.ceiling,options)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  const other=await f.execution(f.secondId)
  expect(await validateAttendedAudienceEvidence(other,evidence,other.security.ceiling,options)).toMatchObject({sources:expect.any(Array)})
 })
 it('holds an anonymous independent-source destination before it can borrow a human delivery decision',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture;independent=await persistentSourceFixture(f)
  const execution=await f.execution();let requests=0
  await expect(validateAttendedAudienceEvidence(execution,{sources:[independent.root]},roomAudienceCeiling(f.workspaceId,f.session),{
   directHumanSource:true,prepareSource:(current,sources,action)=>{requests++;return independent!.coordinator.prepare(current,sources,action)},
  })).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect(requests).toBe(0)
 })
 it('does not accept a cloned source operation token as a native recipient admission',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture;independent=await persistentSourceFixture(f)
  const execution=await f.execution(),evidence={sources:[independent.root]}
  await expect(validateAttendedAudienceEvidence(execution,evidence,execution.security.ceiling,{
   directHumanSource:true,prepareSource:async(current,sources,action)=>structuredClone(await independent!.coordinator.prepare(current,sources,action)),
  })).rejects.toMatchObject({reason:'delivery_audience_unverified'})
 })
 it('holds non-session field families for an anonymous destination while retaining a real member field reader',async()=>{
  fixture=await persistentContextFixture();const f=fixture,store=createDbDocEntityStore({actorUserId:f.ownerId})
  const schema=await store.createEntityType({workspaceId:f.workspaceId,name:'Fictional audience records',createdBy:f.ownerId,properties:[{name:'title',config:{kind:'text'}}]})
  const row=await store.createEntity({workspaceId:f.workspaceId,entityTypeId:schema.id,createdBy:f.ownerId,lastEditedBy:f.ownerId,sourceApp:'api',data:{title:{kind:'text',value:'Fictional member-only field'}}})
  const execution=await f.execution(),client=await getAppPool().connect();let sources:ReturnType<typeof boundScopeSources>=[]
  try{await runWithAgentAccess(execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   const projected=(await client.query<{value:{sources:ReturnType<typeof boundScopeSources>}}>('SELECT read_generic_application_record($1,$2,$3,$4) AS value',[f.workspaceId,schema.id,'record.'+schema.id,row.id])).rows[0].value
   expect(projected).toBeTruthy();sources=projected.sources;expect(sources.length).toBeGreaterThan(0);await client.query('COMMIT')
  })}finally{await rollbackAndRelease(client)}
  await expect(validateAttendedAudienceEvidence(execution,{sources},roomAudienceCeiling(f.workspaceId,f.session))).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect(await validateAttendedAudienceEvidence(execution,{sources},execution.security.ceiling)).toMatchObject({sources:expect.any(Array)})
 })

 it('invalidates a cached original query when a previously source-denied candidate becomes readable',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture,plain=await f.history();independent=await persistentSourceFixture(f)
  const carrier=await independent.writeTranscript()
  const grant=(await independent.pool.query('DELETE FROM grants WHERE account_id=$1 RETURNING kind,account_id,record_id,fields,actions',[f.ownerId])).rows[0]
  const authority=await f.modelContext();bindSessionContextRetainedAuthority(authority.execution,(current,sources,action)=>independent!.coordinator.prepare(current,sources,action))
  const captured=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority})
  expect(captured.history.map(row=>row.id)).toEqual(plain.map(row=>row.id))
  expect(boundScopeSources(captured).some(source=>source.resourceKind==='external_source')).toBe(false)
  const original=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  await independent.pool.query('INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES($1,$2,$3,$4,$5)',[grant.kind,grant.account_id,grant.record_id,grant.fields,grant.actions])
  const options={directHumanSource:true,prepareSource:(current:typeof authority.execution,sources:readonly ScopeSource[],action:'context'|'deliver')=>independent!.coordinator.prepare(current,sources,action)}
  await expect(validateAttendedAudienceEvidence(authority.execution,{sources:boundScopeSources(captured)},authority.execution.security.ceiling,options)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  const current=await f.modelContext();bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  const fresh=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority:current})
  expect(fresh.history.at(-1)?.id).toBe(carrier.id)
  expect(await validateAttendedAudienceEvidence(current.execution,{sources:boundScopeSources(fresh)},current.execution.security.ceiling,options)).toMatchObject({sources:expect.any(Array)})
  const after=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  expect(after.filter(row=>original.some(before=>before.resource_id===row.resource_id&&before.version===row.version))).toEqual(original)
 })
})
