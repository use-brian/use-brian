import {takeTurnLease} from '../../turn/lease.js'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {addSessionMessage,createWorkspaceChatSession,startTurnLease,releaseTurnLease} from '../../db/sessions.js'
import {bindSessionContextRetainedAuthority,withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] actual field-aware native transcript publication',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('publishes the original native field/query observations with a derived assistant message',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext()
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  const sources=boundScopeSources(input);expect(sources.every(source=>source.resourceKind==='application_field')).toBe(true)
  const stored=await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'Fictional field-backed reply'}],
   derivation:{producer:'fixture:field-transcript',sources},derivationTarget:f.envelope,...{authority}})
  expect(stored).toMatchObject({sessionId:f.session.id,role:'assistant',sequenceNum:4})
  expect(boundScopeSources(stored)).toMatchObject([{resourceKind:'session_message',resourceId:stored.id}])
  const edges=(await f.pool.query<{source_id:string;source_version:string}>(`SELECT edge.source_id,edge.source_version FROM scope_derivations d
   JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 AND edge.source_kind='application_field'`,[f.workspaceId,stored.id])).rows
  expect(edges.map(row=>[row.source_id,row.source_version]).sort()).toEqual(sources.map(source=>[source.resourceId,source.version]).sort())
  const current=await f.modelContext(),readBack=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:stored.sequenceNum,authority:current})
  expect(readBack.history.at(-1)).toMatchObject({id:stored.id,content:[{type:'text',text:'Fictional field-backed reply'}]})
 })

 async function prepared(userId?:NonNullable<typeof fixture>['ownerId']){
  const f=fixture!,history=await f.history(),authority=await f.modelContext(userId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  const sources=boundScopeSources(input)
  return {authority,sources,params:{sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'Fictional current transcript reply'}],derivation:{producer:'fixture:field-transcript',sources},derivationTarget:f.envelope,authority}}
 }
 it('commits paired assistant and tool-result rows in one actual canonical publication frame',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared()
  const rows=await withSessionMessagePublication(authority,sources,async client=>[
   await addSessionMessage({...params,content:[{type:'tool_use',id:'fictional-tool',name:'getMemory',input:{}}]},client),
   await addSessionMessage({...params,role:'user',content:[{type:'tool_result',tool_use_id:'fictional-tool',content:'Fictional admitted result'}]},client),
  ])
  expect(rows.map(row=>[row.role,row.sequenceNum])).toEqual([['assistant',4],['user',5]])
  const persisted=(await f.pool.query('SELECT id FROM session_messages WHERE session_id=$1 AND id=ANY($2::uuid[])',[f.session.id,rows.map(row=>row.id)])).rows
  expect(persisted).toHaveLength(2)
  const closure=(await f.pool.query(`SELECT d.resource_id,count(*)::int AS sources FROM scope_derivations d JOIN scope_derivation_sources e
   ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_id=ANY($2::uuid[]) GROUP BY d.resource_id`,[f.workspaceId,rows.map(row=>row.id)])).rows
  expect(closure).toHaveLength(2);expect(closure.every(row=>row.sources===sources.length)).toBe(true)
 })
 it('rolls back an earlier paired row when a later row presents an unrecorded field version',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared()
  await expect(withSessionMessagePublication(authority,sources,async client=>{
   await addSessionMessage(params,client)
   await addSessionMessage({...params,role:'user',derivation:{...params.derivation,sources:sources.map((source,index)=>index?source:{...source,version:'fictional-unrecorded-version'})}},client)
  })).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
  expect((await f.pool.query("SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1 AND producer='fixture:field-transcript'",[f.workspaceId])).rows[0].count).toBe(0)
 })
 it('refuses a retained publication callback after its original transaction closes',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared()
  let retained:(()=>ReturnType<typeof addSessionMessage>)|undefined
  await withSessionMessagePublication(authority,sources,async client=>{retained=()=>addSessionMessage(params,client)})
  await expect(retained!()).rejects.toThrow('scope_evidence_missing')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('refuses an unbound actual non-owner connection even with correct native actor GUCs',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,params}=await prepared(),client=await getAppPool().connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   await expect(addSessionMessage(params,client)).rejects.toThrow('scope_evidence_missing')
  })}finally{await rollbackAndRelease(client)}
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('refuses the owner role at the SQL publication port despite its actual actor context',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared(),client=await f.pool.connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   await expect(client.query('SELECT publish_native_session_message($1,$2,$3,$4,$5,$6)',[f.workspaceId,f.session.id,
    {role:'assistant',content:params.content,channelMessageId:null,senderUserId:null,senderAssistantId:null,attachments:[]},params.derivation.producer,JSON.stringify(sources),f.envelope])).rejects.toMatchObject({code:'42501'})
  })}finally{await rollbackAndRelease(client)}
 })
 it('refuses another actual session invocation and unproved generated annotation scalars',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{params}=await prepared()
  const other=await createWorkspaceChatSession({assistantId:f.assistantId,starterUserId:f.ownerId,workspaceId:f.workspaceId,effectiveClearance:'internal',authenticatedHuman:true})
  const authority={execution:await f.execution(f.ownerId,other),accumulator:params.authority.accumulator}
  await expect(addSessionMessage({...params,authority})).rejects.toThrow('scope_evidence_missing')
  await expect(addSessionMessage({...params,topicLabel:'Fictional unproved label'})).rejects.toThrow('scope_evidence_missing')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('refuses a revoked original member and keeps an independently authorized current writer usable',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{params}=await prepared(f.firstId)
  const original=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(addSessionMessage(params)).rejects.toMatchObject({reason:'authority_changed'})
  const second=await prepared(f.secondId),stored=await addSessionMessage(second.params)
  expect(stored.sequenceNum).toBe(4)
  const after=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
  expect(after.filter(row=>original.some(before=>before.resource_id===row.resource_id&&before.version===row.version))).toEqual(original)
 })
 it('requires fresh retain rights independently of valid context/query rights',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture;await f.history();independent=await persistentSourceFixture(f)
  const carrier=await independent.writeTranscript(),authority=await f.modelContext()
  bindSessionContextRetainedAuthority(authority.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority})
  expect(boundScopeSources(input).some(source=>source.resourceKind==='external_source')).toBe(true)
  await independent.pool.query("UPDATE grants SET actions=array_remove(actions,'retain') WHERE account_id=$1",[f.ownerId])
  await expect(addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional retention refusal',derivation:{producer:'fixture:field-transcript',sources:boundScopeSources(input)},derivationTarget:f.envelope,authority})).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(4)
  expect(await independent.independentlyAuthorized()).toBe(true)
 })

 it('recovers immutable field/query obligations before D1 drops a deleted native carrier',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{params,sources}=await prepared(),carrier=await addSessionMessage(params),root=boundScopeSources(carrier)[0]
  await f.pool.query('DELETE FROM session_messages WHERE id=$1',[carrier.id])
  const authority=await f.modelContext(),input={...params,authority,derivation:{producer:'fixture:gone-transcript-carrier',sources:[root]}}
  const stored=await addSessionMessage(input)
  const edges=(await f.pool.query(`SELECT edge.source_kind,edge.source_id FROM scope_derivations d JOIN scope_derivation_sources edge
   ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`,[f.workspaceId,stored.id])).rows
  expect(edges.some(edge=>edge.source_kind==='session_message'&&edge.source_id===carrier.id)).toBe(false)
  expect(edges.filter(edge=>edge.source_kind==='application_field').map(edge=>edge.source_id).sort()).toEqual(sources.map(source=>source.resourceId).sort())
  const original=(await f.history())[0]
  await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[original.id,JSON.stringify([{type:'text',text:'Fictional changed original query input'}])])
  const current=await f.modelContext()
  await expect(addSessionMessage({...input,authority:current})).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query("SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1 AND producer='fixture:gone-transcript-carrier'",[f.workspaceId])).rows[0].count).toBe(1)
 })
 it('preserves independent ancestry on a successful field-backed transcript and holds it after withdrawal',async()=>{
  fixture=await persistentContextFixture('confidential');const f=fixture;await f.history();independent=await persistentSourceFixture(f)
  const carrier=await independent.writeTranscript(),authority=await f.modelContext()
  const bind=(current:typeof authority)=>bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  bind(authority)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:carrier.sequenceNum,authority})
  const stored=await addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional retained field-backed independent reply',derivation:{producer:'fixture:field-transcript',sources:boundScopeSources(input)},derivationTarget:f.envelope,authority})
  const edges=(await f.pool.query(`SELECT edge.source_kind FROM scope_derivations d JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`,[f.workspaceId,stored.id])).rows
  expect(edges.some(edge=>edge.source_kind==='application_field')).toBe(true);expect(edges.some(edge=>edge.source_kind==='external_source')).toBe(true)
  const observations=(await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
  await independent.pool.query('DELETE FROM grants WHERE account_id=$1',[f.ownerId])
  const first=await f.modelContext();bind(first)
  const held=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:stored.sequenceNum,authority:first})
  expect(held.history.some(row=>row.id===stored.id||row.id===carrier.id)).toBe(false)
  const second=await f.modelContext(f.secondId);bind(second)
  const admitted=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:stored.sequenceNum,authority:second})
  expect(admitted.history.at(-1)).toMatchObject({id:stored.id,content:'Fictional retained field-backed independent reply'})
  expect((await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual(observations)
 })
 it('refuses outbound file references without their admitted file observation',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{params}=await prepared()
  await expect(addSessionMessage({...params,attachments:[{fileId:crypto.randomUUID(),workspaceId:f.workspaceId,path:'fictional/retained.txt',name:'Fictional retained file',mime:'text/plain',sizeBytes:10}]})).rejects.toThrow('scope_evidence_missing')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })

 it.each(['unknown-kind','empty-version','missing-id'])('refuses malformed evidence at the actual SQL port (%s)',async variant=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared(),client=await getAppPool().connect()
  const source={...sources[0],...(variant==='unknown-kind'?{resourceKind:'fictional-unregistered-kind'}:variant==='empty-version'?{version:''}:{resourceId:null})}
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   await expect(client.query('SELECT publish_native_session_message($1,$2,$3,$4,$5,$6)',[f.workspaceId,f.session.id,
    {role:'assistant',content:params.content,channelMessageId:null,senderUserId:null,senderAssistantId:null,attachments:[]},params.derivation.producer,JSON.stringify([source]),f.envelope])).rejects.toMatchObject({code:'22023',message:'scope_evidence_missing'})
  })}finally{await rollbackAndRelease(client)}
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('refuses the owner database role at the native turn-token gate',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority}=await prepared(),client=await getPool().connect()
  const slot=await takeTurnLease({sessionId:f.session.id,admission:'room',assistantId:f.assistantId})
  if(!slot.taken)throw new Error('Expected the actual native turn slot')
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   await expect(client.query('SELECT native_session_turn_publication_allowed($1,$2,$3,false)',[f.workspaceId,f.session.id,slot.token]))
    .rejects.toMatchObject({code:'42501',message:'scope_operation_denied'})
  })}finally{await rollbackAndRelease(client)}
 })
 it('publishes buffered rows only under their actual active normal turn token',async()=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared()
  const slot=await takeTurnLease({sessionId:f.session.id,admission:'room',assistantId:f.assistantId})
  if(!slot.taken)throw new Error('Expected the actual native turn slot')
  const token=slot.token
  const actual=(await f.pool.query('SELECT status,turn_lease_token,last_turn_lease_token FROM sessions WHERE id=$1',[f.session.id])).rows[0]
  expect(actual).toMatchObject({status:'running',turn_lease_token:token,last_turn_lease_token:token})
  const row=await withSessionMessagePublication(authority,sources,async client=>{
   // Ordinary RLS still denies an UPDATE-lock read of the shared parent.
   expect((await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[f.session.id])).rows).toEqual([])
   return addSessionMessage(params,client)
  },{turnToken:token})
  expect(row.sequenceNum).toBe(4)
 })
 it.each(['wrong-token','released','successor','finished-successor'] as const)('rejects normal buffered publication after an actual %s lease state',async state=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared()
  const slot=await takeTurnLease({sessionId:f.session.id,admission:'room',assistantId:f.assistantId})
  if(!slot.taken)throw new Error('Expected the actual native turn slot')
  const token=slot.token
  if(state==='released')await releaseTurnLease(f.session.id,'completed',token)
  if(state==='successor'||state==='finished-successor'){
   const successor=await startTurnLease(f.session.id,f.assistantId)
   if(state==='finished-successor')await releaseTurnLease(f.session.id,'completed',successor)
  }
  await expect(withSessionMessagePublication(authority,sources,client=>addSessionMessage(params,client),
   {turnToken:state==='wrong-token'?crypto.randomUUID():token})).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it.each(['wrong-token','released','successor','finished-successor'] as const)('rejects stopped publication after an actual %s lease state',async state=>{
  fixture=await persistentContextFixture();const f=fixture,{authority,sources,params}=await prepared()
  const token=await startTurnLease(f.session.id,f.assistantId)
  if(state==='released')await releaseTurnLease(f.session.id,'completed',token)
  if(state==='successor'||state==='finished-successor'){
   const successor=await startTurnLease(f.session.id,f.assistantId)
   if(state==='finished-successor')await releaseTurnLease(f.session.id,'stopped_by_user',successor)
  }
  await expect(withSessionMessagePublication(authority,sources,client=>addSessionMessage(params,client),
   {stoppedTurnToken:state==='wrong-token'?crypto.randomUUID():token})).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
})
