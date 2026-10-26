import {writeFile} from 'node:fs/promises'
import type {PoolClient} from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,executionToolContext,createCorrectionTools,createRetrievalTools,type RetrievalStore} from '@use-brian/core'
import {getAppPool,getPool,applyRLSGucs,runWithAgentAccess,rollbackAndRelease} from '../../db/client.js'
import {createWorkspaceChatSession,releaseTurnLease} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {withSessionMessagePublication,writeRetainedContextFrame,readRetainedQueryFrame} from '../../db/session-context-revisions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {createMemory} from '../../db/memories.js'
import {createDbRowHistoryStore} from '../../db/row-history-store.js'
import {createMemoryRetractionStore} from '../../db/retraction-store.js'
import {createSoftDeleteStore} from '../../db/soft-delete-store.js'
import {createSensitivityReclassificationStore} from '../../db/sensitivity-reclassification-store.js'
import {turnOutputWrite} from '../../context-scope/resolve-turn-scope.js'
import {takeTurnLease} from '../../turn/lease.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual canonical native transcript batches',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(f.firstId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  const memory=await f.memory('Fictional batch source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  if(!row)throw new Error('Missing actual batch memory')
  const sources=[...boundScopeSources(input),...boundScopeSources(row)]
  return{f,authority,memory,sources,batch:{sessionId:f.session.id,authority,derivationTarget:f.envelope,
   derivation:{producer:'fixture:canonical-batch',sources},messages:[{role:'assistant',content:'Fictional paired tool request'},{role:'user',content:'Fictional paired tool response'}]}}
 }
 it('publishes seventeen actual pairs with complete immutable ancestry and ordered sequence numbers',async()=>{
  const {f,batch,sources}=await setup(),messages=Array.from({length:17},()=>batch.messages).flat(),rows=await publishNativeSessionMessageBatch({...batch,messages})
  expect(rows).toHaveLength(34)
  expect(rows.map(row=>row.sequenceNum)).toEqual(Array.from({length:34},(_,n)=>n+4))
  for(const row of rows){
   expect(boundScopeSources(row)).toMatchObject([{resourceKind:'session_message',resourceId:row.id}])
   const edges=(await f.pool.query(`SELECT source_kind,source_id,source_version FROM scope_derivations d JOIN scope_derivation_sources edge
    ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`,[f.workspaceId,row.id])).rows
   expect(edges.map(edge=>[edge.source_kind,edge.source_id,edge.source_version]).sort()).toEqual(sources.map(source=>[source.resourceKind,source.resourceId,source.version]).sort())
  }
 })
 it('rejects a malformed later SQL payload before writing any member of the batch',async()=>{
  const {f,authority,sources,batch}=await setup()
  await expect(withSessionMessagePublication(authority,sources,db=>db.query('SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6)',
   [f.workspaceId,f.session.id,JSON.stringify(batch.messages.map((row,n)=>({role:n?'invalid':row.role,content:row.content,channelMessageId:null,senderUserId:null,senderAssistantId:null,attachments:[]}))),
    batch.derivation.producer,JSON.stringify(sources),f.envelope]))).rejects.toMatchObject({code:'22023',message:'scope_evidence_missing'})
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('refuses a revoked original writer while preserving current independent access and observations',async()=>{
  const {f,authority,sources,batch}=await setup(),before=structuredClone(sources)
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(publishNativeSessionMessageBatch(batch)).rejects.toMatchObject({reason:'authority_changed'})
  const other=await f.modelContext(f.secondId)
  expect(await publishNativeSessionMessageBatch({...batch,authority:other})).toHaveLength(2)
  expect(sources).toEqual(before)
  await expect(authority.execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 })
 it.each(['single','batch'] as const)('rolls the entire %s effect back when a real source contracts during its inserts',async mode=>{
  const {f,memory,batch}=await setup(),name='r3_batch_'+randomUUID().replaceAll('-','')
  // Guarded synthetic DB only: the trigger performs a real source mutation,
  // without replacing a canonical policy, evaluator or lineage guard.
  await f.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN UPDATE memories SET sensitivity='confidential' WHERE id='${memory.id}'::uuid AND sensitivity='internal';RETURN NEW;END $fixture$`)
  try{
   await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON session_messages FOR EACH ROW WHEN (NEW.session_id='${f.session.id}'::uuid) EXECUTE FUNCTION public.${name}()`)
   const write=mode==='batch'?publishNativeSessionMessageBatch(batch):publishNativeSessionMessage({sessionId:batch.sessionId,authority:batch.authority,derivation:batch.derivation,derivationTarget:batch.derivationTarget,...batch.messages[0]})
   await expect(write).rejects.toMatchObject({code:'scope_source_changed'})
   expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
   expect((await f.pool.query('SELECT sensitivity FROM memories WHERE id=$1',[memory.id])).rows[0].sensitivity).toBe('internal')
  }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON session_messages`);await f.pool.query(`DROP FUNCTION public.${name}()`)}
 })
 it('does not turn a raw non-owner connection or owner context into a batch frame',async()=>{
  const {f,authority,batch}=await setup(),db=await getAppPool().connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,f.firstId)
   await expect(publishNativeSessionMessageBatch(batch,db)).rejects.toMatchObject({code:'scope_evidence_missing'})
   await expect(db.query('SELECT prepare_native_session_message_batch($1,$2,$3,$4,$5)',[f.workspaceId,f.session.id,batch.derivation.producer,JSON.stringify(batch.derivation.sources),f.envelope])).rejects.toMatchObject({code:'42501'})
  })}finally{await rollbackAndRelease(db)}
 })
 it.each(['single','batch'] as const)('keeps the original target pinned when the caller mutates a %s command during admission',async mode=>{
  fixture=await persistentContextFixture();const f=fixture;await f.history()
  const other=await createWorkspaceChatSession({assistantId:f.assistantId,starterUserId:f.ownerId,workspaceId:f.workspaceId,effectiveClearance:'internal',authenticatedHuman:true})
  const authority=await f.modelContext(f.firstId),input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const common={sessionId:f.session.id,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:original-publication-target',sources:boundScopeSources(input)}}
  const message={role:'assistant',content:'Fictional original-target response'}
  let rows
  if(mode==='single'){
   const command={...common,...message},pending=publishNativeSessionMessage(command)
   command.sessionId=other.id;rows=[await pending]
  }else{
   const command={...common,messages:[message,{role:'user',content:'Fictional original-target result'}]},pending=publishNativeSessionMessageBatch(command)
   command.sessionId=other.id;rows=await pending
  }
  expect(rows.map(row=>row.sessionId)).toEqual(rows.map(()=>f.session.id))
  expect((await f.pool.query('SELECT id FROM session_messages WHERE session_id=$1',[other.id])).rows).toEqual([])
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(mode==='single'?4:5)
 })
 it.each(['bindings','current-authority'] as const)('commits an ordinary buffered transcript batch from genuine retracted Memory history (%s controls)',async controls=>{
  fixture=await persistentContextFixture();const f=fixture,initial=await f.history(),store=createDbMemoryStore()
  const report:Record<string,unknown>={controls,stage:'create',batchSqlBegan:false,batchCommitAttempted:false,batchCommitCompleted:false,committed:false}
  const trace:Array<Record<string,unknown>>=[],queries=new Map<PoolClient,PoolClient['query']>()
  let heldReasonId:string|undefined
  let token:string|undefined,before:Awaited<ReturnType<typeof state>>|undefined,afterCommit:Awaited<ReturnType<typeof state>>|undefined
  const errorInfo=(error:unknown):Record<string,unknown>=>{
   if(!(error instanceof Error))return{message:String(error)}
   const e=error as Error&{code?:unknown;reason?:unknown;detail?:unknown;where?:unknown;constraint?:unknown;routine?:unknown;cause?:unknown}
   return{name:e.name,message:e.message,code:e.code,reason:e.reason,detail:e.detail,where:e.where,constraint:e.constraint,routine:e.routine,stack:e.stack,...(e.cause?{cause:errorInfo(e.cause)}:{})}
  }
  const watch=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){
    const sql=typeof args[0]==='string'?args[0]:typeof args[0]==='object'&&args[0]!==null?(args[0] as {text?:string}).text??'':''
    const entry:Record<string,unknown>={event:'query',stage:report.stage,sql}
    const interesting=/native_(?:application_)?session|application_field|native_attended_memory|COMMIT|ROLLBACK/.test(sql)
    if(interesting)trace.push(entry)
    if(sql.startsWith('SELECT publish_native_session_message_batch(')){report.batchSqlBegan=true;entry.originalSources=structuredClone((args[1] as unknown[])?.[4])}
    if(sql==='COMMIT'&&report.stage==='publishBatch')report.batchCommitAttempted=true
    return Promise.resolve(Reflect.apply(original,client,args)).then(result=>{
     if(sql==='COMMIT'&&entry.stage==='publishBatch')report.batchCommitCompleted=true
     if(sql==='SELECT node_version AS "nodeVersion",source FROM read_native_session_field_dependencies($1,$2,$3,$4)'
      &&(entry.stage==='modelInput'||entry.stage==='modelOutput'))entry.resultRows=structuredClone(result.rows)
     return result
    }).catch(error=>{trace.push({event:'error',stage:report.stage,sql,...errorInfo(error)});throw error})
   } as typeof client.query
  }
  async function state(){return{
   messages:(await f.pool.query('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1 ORDER BY sequence_num,id',[f.session.id])).rows,
   parent:(await f.pool.query('SELECT to_jsonb(s) AS value FROM sessions s WHERE id=$1',[f.session.id])).rows,
   derivations:(await f.pool.query('SELECT to_jsonb(d) AS value FROM scope_derivations d WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows,
   edges:(await f.pool.query('SELECT to_jsonb(s) AS value FROM scope_derivation_sources s WHERE workspace_id=$1 ORDER BY derivation_id,source_kind,source_id,source_version',[f.workspaceId])).rows,
   resources:(await f.pool.query('SELECT to_jsonb(r) AS value FROM application_field_resources r WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows,
   observations:(await f.pool.query('SELECT to_jsonb(o) AS value FROM application_field_observations o WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows,
   memories:(await f.pool.query('SELECT to_jsonb(m) AS value FROM memories m WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows,
   transitions:(await f.pool.query('SELECT to_jsonb(t) AS value FROM native_memory_successor_transitions t WHERE workspace_id=$1 ORDER BY predecessor_id',[f.workspaceId])).rows,
   receipts:(await f.pool.query('SELECT to_jsonb(a) AS value FROM correction_audit a WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows,
   revisions:(await f.pool.query('SELECT to_jsonb(r) AS value FROM session_context_scope_revisions r WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows,
   fieldSources:(await f.pool.query('SELECT to_jsonb(s) AS value FROM application_field_observation_sources s WHERE workspace_id=$1 ORDER BY resource_id,version,source_kind,source_id,source_version',[f.workspaceId])).rows,
   resourceStates:(await f.pool.query('SELECT to_jsonb(s) AS value FROM scope_resource_states s WHERE workspace_id=$1 ORDER BY resource_kind,resource_id,resource_version',[f.workspaceId])).rows,
  }}
  const context=(host:Awaited<ReturnType<typeof f.modelContext>>)=>({...executionToolContext(host.execution,{appId:'fictional-history-transcript'}),scopeAccumulator:host.accumulator})
  async function sharedMemory(summary:string){
   const host=await f.modelContext(f.ownerId)
   return writeRetainedContextFrame(host,[],client=>createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,summary,sensitivity:'internal',createdByUserId:f.ownerId},undefined,client))
  }
  getAppPool().on('acquire',watch)
  try{
   const root=await sharedMemory('Fictional original transcript-history value'),reason=await sharedMemory('Fictional independent transcript-history reason')
   const updating=await f.modelContext(f.ownerId),old=await store.getById(updating.execution.security.access,root.id,updating)
   expect(old).not.toBeNull();const oldSources=structuredClone(boundScopeSources(old!))
   const successor=await store.update(root.id,{summary:'Fictional corrected transcript-history value'},updating.execution.security.access,
    {authority:updating,expectedVersion:old!.scopeVersion!,writeFields:['summary']});expect(successor).not.toBeNull()
   report.stage='retract';const correcting=await f.modelContext(f.ownerId),admittedReason=await store.getById(correcting.execution.security.access,reason.id,correcting)
   expect(admittedReason).not.toBeNull();correcting.accumulator.note({sources:boundScopeSources(admittedReason!)})
   const tools=createCorrectionTools({retraction:createMemoryRetractionStore(),softDelete:createSoftDeleteStore(),reclassify:createSensitivityReclassificationStore(),
    resolveWorkspaceRole:async(actor,w)=>(await f.pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[w,actor])).rows[0]?.role??null})
   const retracted=await tools.find(tool=>tool.name==='retractMemory')!.execute({memory_id:successor!.id,reason:'Fictional independent transcript correction'},context(correcting))
   expect(retracted.isError,JSON.stringify(retracted)).not.toBe(true)
   const slot=await takeTurnLease({sessionId:f.session.id,admission:'room',assistantId:f.assistantId})
   if(!slot.taken)throw new Error('Expected the normal native transcript turn lease')
   token=slot.token
   report.turn=(await f.pool.query('SELECT status,turn_lease_token,last_turn_lease_token FROM sessions WHERE id=$1',[f.session.id])).rows[0]
   expect(report.turn).toMatchObject({status:'running',turn_lease_token:token,last_turn_lease_token:token})
   report.stage='getRowHistory';const writer=await f.modelContext(f.ownerId)
   const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:initial.at(-1)!.sequenceNum,authority:writer})
   const queryRoots=structuredClone(writer.accumulator.evidence.sources??[])
   expect(boundScopeSources(query).length).toBeGreaterThan(0);expect(queryRoots.length).toBeGreaterThan(0)
   const historyInput={primitive:'memories',row_id:successor!.id,include_retracted:true}
   const retrieval=createRetrievalTools(createDbRowHistoryStore() as RetrievalStore)
   const history=await retrieval.getRowHistory.execute(historyInput,context(writer))
   expect(history.isError,JSON.stringify(history)).not.toBe(true);expect(history.scopeEvidence?.sources?.length).toBeGreaterThan(0)
   // Normal successful-tool executor handoff on the original live accumulator.
   writer.accumulator.note(history.scopeEvidence!)
   const original=structuredClone(writer.accumulator.evidence),roots=original.sources??[]
   const resources=(await f.pool.query("SELECT id,origin,type_key,selection FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[f.workspaceId,roots.filter(s=>s.resourceKind==='application_field').map(s=>s.resourceId)])).rows
   const historyRoots=roots.filter(source=>resources.some(row=>row.id===source.resourceId&&row.type_key==='memory'&&row.selection==='history'&&row.origin.kind==='native'))
   expect(historyRoots.length).toBeGreaterThan(0);expect(roots.some(source=>source.resourceKind==='memory')).toBe(false)
   for(const source of queryRoots)expect(roots).toContainEqual(source)
   for(const source of oldSources)expect(roots.some(row=>row.resourceKind===source.resourceKind&&row.resourceId===source.resourceId&&row.version===source.version)).toBe(false)
   report.history={input:historyInput,data:history.data,evidence:history.scopeEvidence,queryRoots,original,historyRoots,counts:{query:queryRoots.length,history:historyRoots.length,original:roots.length}}
   const write=turnOutputWrite({producer:'turn:web',accumulator:writer.accumulator,envelope:f.envelope})
   if(!('derivation'in write))throw new Error('Expected actual history evidence derivation')
   expect(write.derivation.sources).toEqual(roots);report.write=structuredClone(write)
   const toolId='fictional-history-transcript-call',messages=[
    {role:'assistant',content:[{type:'tool_use',id:toolId,name:'getRowHistory',input:historyInput}],senderAssistantId:f.assistantId},
    {role:'user',content:[{type:'tool_result',tool_use_id:toolId,content:JSON.stringify(history.data)}]},
    {role:'assistant',content:[{type:'text',text:'Fictional corrected and retracted history reviewed.'}],senderAssistantId:f.assistantId},
   ]
   report.messages=messages;before=await state();report.before=before
   expect(before.messages).toHaveLength(initial.length);expect(before.transitions.length).toBeGreaterThan(0)
   expect(before.receipts.some(row=>row.value.native_memory_transition!==null)).toBe(true)
   expect(before.memories.find(row=>row.value.id===root.id)!.value.superseded_by).toBe(successor!.id)
   expect(before.memories.find(row=>row.value.id===successor!.id)!.value.retracted_at).not.toBeNull()
   const reasonFieldTuples:Array<{resourceKind:string;resourceId:string;version:string}>=[]
   report.stage='publishBatch'
   const rows=await writer.execution.security.authority.execute(()=>withSessionMessagePublication(writer,write.derivation.sources,async client=>{
    report.runtime=(await client.query("SELECT session_user,current_user,pg_backend_pid() AS pid,r.rolsuper,r.rolbypassrls,r.rolinherit,(SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,c.relowner=r.oid AS owns_memories FROM pg_roles r JOIN pg_class c ON c.oid='memories'::regclass WHERE r.rolname=session_user")).rows[0]
    expect(report.runtime).toMatchObject({session_user:'app_user',current_user:'app_user',rolsuper:false,rolbypassrls:false,rolinherit:false,memberships:0,owns_memories:false})
    const projected:Array<{node_version:string;source:{resourceKind:string;resourceId:string;version:string}}>=[]
    for(const historyRoot of historyRoots)projected.push(...(await client.query('SELECT node_version,source FROM read_native_session_field_dependencies($1,$2,$3,$4)',
     [f.workspaceId,[historyRoot.resourceKind],[historyRoot.resourceId],[historyRoot.version]])).rows)
    report.projectedHistoryFields=projected
    const reasonFields=before!.resources.filter(resource=>resource.value.origin.kind==='native'&&resource.value.type_key==='memory'
     &&resource.value.selection==='read'&&resource.value.resource_id===reason.id)
    for(const dependency of projected)if(reasonFields.some(field=>field.value.id===dependency.source.resourceId)){
     expect(dependency.source.resourceKind).toBe('application_field');expect(dependency.source.version).toBe(dependency.node_version)
     reasonFieldTuples.push(dependency.source)
    }
    expect(reasonFieldTuples.length).toBeGreaterThan(0);report.reasonFieldTuples=reasonFieldTuples
    return publishNativeSessionMessageBatch({sessionId:f.session.id,messages,derivation:write.derivation,derivationTarget:write.derivationTarget,authority:writer},client)
   },{turnToken:token}))
   report.committed=true;report.rows=rows;expect(rows).toHaveLength(3)
   expect(rows.map(row=>row.role)).toEqual(['assistant','user','assistant'])
   expect(rows.map(row=>row.sequenceNum)).toEqual([1,2,3].map(n=>initial.at(-1)!.sequenceNum+n))
   for(let n=0;n<rows.length;n++){
    const row=rows[n];expect(row.content).toEqual(messages[n].content)
    expect(boundScopeSources(row)).toMatchObject([{workspaceId:f.workspaceId,userId:null,assistantId:null,sensitivity:write.derivationTarget!.sensitivity,
     compartments:write.derivationTarget!.compartments,projectIds:write.derivationTarget!.projectIds,resourceKind:'session_message',resourceId:row.id,version:'1'}])
   }
   const after=await state();afterCommit=after;report.afterCommit=after;report.after=after
   expect(after.messages.filter(row=>before!.messages.some(old=>old.value.id===row.value.id))).toEqual(before.messages)
   expect(after.messages).toHaveLength(before.messages.length+3)
   const newDerivations=after.derivations.filter(row=>!before!.derivations.some(old=>old.value.id===row.value.id))
   expect(newDerivations).toHaveLength(3)
   for(const row of newDerivations){
    const message=after.messages.find(message=>message.value.id===row.value.resource_id)!.value
    expect(row.value).toMatchObject({resource_kind:'session_message',resource_version:'1',producer:'turn:web',user_id:null,assistant_id:null,
     sensitivity:message.sensitivity,compartments:message.compartments,project_ids:message.project_ids})
    expect(message).toMatchObject({workspace_id:f.workspaceId,session_id:f.session.id,scope_version:1,scope_held:false,user_id:null,assistant_id:null,
     sensitivity:write.derivationTarget!.sensitivity,compartments:write.derivationTarget!.compartments,project_ids:write.derivationTarget!.projectIds})
    const edges=after.edges.filter(edge=>edge.value.derivation_id===row.value.id)
    for(const source of roots)expect(edges.map(edge=>[edge.value.source_kind,edge.value.source_id,edge.value.source_version])).toContainEqual([source.resourceKind,source.resourceId,source.version])
    for(const source of oldSources)expect(edges.some(edge=>edge.value.source_kind===source.resourceKind&&edge.value.source_id===source.resourceId&&edge.value.source_version===source.version)).toBe(false)
    const oldOwnFields=before.resources.filter(resource=>resource.value.type_key==='memory'&&resource.value.selection==='read'
     &&[root.id,successor!.id].includes(resource.value.resource_id))
    for(const field of oldOwnFields)expect(edges.some(edge=>edge.value.source_kind==='application_field'&&edge.value.source_id===field.value.id)).toBe(false)
    for(const source of reasonFieldTuples)expect(edges.map(edge=>[edge.value.source_kind,edge.value.source_id,edge.value.source_version])).toContainEqual([source.resourceKind,source.resourceId,source.version])
   }
   expect(after.parent).toEqual(before.parent)
   expect(after.parent[0].value).toMatchObject({status:'running',turn_lease_token:token,last_turn_lease_token:token})
   expect(after.derivations.filter(row=>before!.derivations.some(old=>old.value.id===row.value.id))).toEqual(before.derivations)
   expect(after.edges.filter(row=>before!.edges.some(old=>JSON.stringify(old)===JSON.stringify(row)))).toEqual(before.edges)
   const edgeSets=newDerivations.map(row=>after.edges.filter(edge=>edge.value.derivation_id===row.value.id)
    .map(edge=>[edge.value.source_kind,edge.value.source_id,edge.value.source_version]).sort())
   for(const edges of edgeSets)expect(edges).toEqual(edgeSets[0])
   for(const key of ['resources','observations','memories','transitions','receipts','revisions','fieldSources','resourceStates'] as const)expect(after[key]).toEqual(before[key])
   expect(report.batchCommitAttempted).toBe(true);expect(report.batchCommitCompleted).toBe(true)
   expect(trace.filter(entry=>typeof entry.sql==='string'&&entry.sql.startsWith('SELECT publish_native_session_message_batch('))
    .map(entry=>{expect(typeof entry.originalSources).toBe('string');return JSON.parse(entry.originalSources as string)})).toEqual([roots])
   // A successful publication does not certify the next ordinary transcript read.
   report.stage='freshTranscriptRead';report.beforeRead=after
   const reader=await f.modelContext(f.ownerId),throughSequence=rows.at(-1)!.sequenceNum
   const fresh=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence,authority:reader})
   report.freshRead={throughSequence,history:fresh.history,annotations:fresh.annotations,sources:boundScopeSources(fresh),accumulator:reader.accumulator.evidence}
   expect(fresh.history.map(row=>[row.id,row.sequenceNum,row.role,row.content])).toEqual([...initial,...rows].map(row=>[row.id,row.sequenceNum,row.role,row.content]))
   expect(fresh.history).toHaveLength(initial.length+rows.length)
   const freshRoots=boundScopeSources(fresh),freshBindings=(await f.pool.query(`SELECT to_jsonb(r) AS resource,to_jsonb(o) AS observation
    FROM application_field_resources r JOIN application_field_observations o ON o.workspace_id=r.workspace_id AND o.resource_id=r.id
    WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id,o.version`,[f.workspaceId,freshRoots.map(source=>source.resourceId)])).rows
   report.freshBindings=freshBindings
   for(const source of freshRoots){
    const bound=freshBindings.find(row=>row.resource.id===source.resourceId&&row.observation.version===source.version)
    expect(bound).toBeDefined();expect(bound!.resource.origin).toEqual({kind:'native',moduleKey:'native'})
    expect(bound!.resource.type_key).toMatch(/^session_message(?:_annotation)?$/)
    if(bound!.resource.selection==='query_domain')expect(bound!.observation.source_kind).toBe('application_query_domain')
    else{expect(bound!.resource.type_key).toBe('session_message');expect(bound!.observation.source_kind).toBe('session_message')
     expect(bound!.observation.source_id).toBe(bound!.resource.resource_id);expect(bound!.observation.source_version).toBe('1')}
   }
   expect(freshBindings.filter(row=>row.resource.type_key==='session_message'&&row.resource.selection==='query').map(row=>row.observation.source_id).sort())
    .toEqual([...initial,...rows].map(row=>row.id).sort())
   expect(freshBindings.some(row=>row.resource.type_key==='session_message'&&row.resource.selection==='query_domain')).toBe(true)
   if(controls==='bindings'){
   const modelRoots=structuredClone(reader.accumulator.evidence.sources)
   report.stage='modelInput';await assertSourceModelInputAuthority(context(reader));report.modelInputPassed=true
   report.stage='modelOutput';await assertSourceModelOutputAuthority(context(reader));report.modelOutputPassed=true
   report.modelEvidence=structuredClone(reader.accumulator.evidence)
   const modelSources=reader.accumulator.evidence.sources??[]
   for(const source of modelRoots??[])expect(modelSources).toContainEqual(source)
   const admittedModelFields=trace.filter(entry=>(entry.stage==='modelInput'||entry.stage==='modelOutput')&&Array.isArray(entry.resultRows))
    .flatMap(entry=>(entry.resultRows as Array<{source:(typeof modelSources)[number]}>).map(row=>row.source))
   const addedModelFields=modelSources.filter(source=>!(modelRoots??[]).some(original=>JSON.stringify(original)===JSON.stringify(source)))
   expect(addedModelFields.length).toBeGreaterThan(0)
   for(const source of addedModelFields){expect(source.resourceKind).toBe('application_field');expect(admittedModelFields).toContainEqual(source)}
   report.modelFieldProvenance={added:addedModelFields,admitted:admittedModelFields}
   const oldOwnFields=before.resources.filter(resource=>resource.value.type_key==='memory'&&resource.value.selection==='read'
    &&[root.id,successor!.id].includes(resource.value.resource_id))
   for(const field of oldOwnFields)expect(modelSources.some(source=>source.resourceKind==='application_field'&&source.resourceId===field.value.id)).toBe(false)
   expect(modelSources.some(source=>source.resourceKind==='memory'&&[root.id,successor!.id].includes(source.resourceId))).toBe(false)
   report.stage='ownFactualObservationUnavailable'
   expect(await store.getById(reader.execution.security.access,root.id,reader)).toBeNull()
   await expect(store.getById(reader.execution.security.access,successor!.id,reader)).rejects.toMatchObject({code:'scope_source_changed',
    cause:{reason:'caller_evidence_unavailable',cause:{code:'42501',message:'scope_operation_denied'}}})
   report.ownFactualObservationUnavailable=true
   const stable=await state(),refusals:Array<Record<string,unknown>>=[]
   const probe=async(sources:typeof modelSources)=>readRetainedQueryFrame(await f.modelContext(f.ownerId),[],async client=>({
    value:(await client.query('SELECT node_version,source FROM read_native_session_field_dependencies($1,$2,$3,$4)',
     [f.workspaceId,sources.map(source=>source.resourceKind),sources.map(source=>source.resourceId),sources.map(source=>source.version)])).rows,sources:[],
   }))
   const pointRoot=freshRoots.find(source=>freshBindings.some(binding=>binding.resource.id===source.resourceId
    &&binding.resource.selection==='query'&&binding.observation.source_id===rows[0].id))!
   const domainRoot=freshRoots.find(source=>freshBindings.some(binding=>binding.resource.id===source.resourceId
    &&binding.resource.type_key==='session_message'&&binding.resource.selection==='query_domain'))!
   expect(pointRoot).toBeDefined();expect(domainRoot).toBeDefined()
   report.stage='independentOriginalAndBindingControls'
   for(const[name,sources,expected]of [
    ['history plus independent old factual field',[historyRoots[0],...oldSources],{code:'42501',message:'scope_operation_denied'}],
    ['message wrapper plus independent old factual field',[pointRoot,...oldSources],{code:'42501',message:'scope_operation_denied'}],
    ['wrong point version',[{...pointRoot,version:'fictional-wrong-version'}],{code:'22023',message:'scope_ancestry_unavailable'}],
    ['wrong domain version',[{...domainRoot,version:'fictional-wrong-version'}],{code:'22023',message:'scope_ancestry_unavailable'}],
   ] as const){
    try{await probe([...sources]);throw new Error('Expected exact ordinary authority refusal: '+name)}
    catch(error){
     refusals.push({name,error:errorInfo(error)});report.refusals=structuredClone(refusals)
     expect(error).toMatchObject(expected)
    }
    expect(await state()).toEqual(stable)
   }
   report.refusals=refusals
   }else{
   // Existing cached evidence is rechecked through two independent model executions.
   const cachedInput=await f.modelContext(f.ownerId),cachedOutput=await f.modelContext(f.ownerId)
   cachedInput.accumulator.note(reader.accumulator.evidence);cachedOutput.accumulator.note(reader.accumulator.evidence)
   const reasonBefore=(await f.pool.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[reason.id])).rows[0].value
   expect(reasonBefore.scope_held).toBe(false);heldReasonId=reason.id
   report.reasonHold={fixtureOnly:true,before:reasonBefore}
   await f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[reason.id])
   try{
    const held=(await f.pool.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[reason.id])).rows[0].value
    expect(held.scope_held).toBe(true);expect(held.scope_version).toBe(reasonBefore.scope_version)
    report.reasonHold={fixtureOnly:true,before:reasonBefore,held}
    report.stage='cachedModelInputAfterReasonHold'
    await expect(assertSourceModelInputAuthority(context(cachedInput))).rejects.toMatchObject({code:'source_unavailable',reason:'authority_changed',retrySafe:false})
    report.stage='cachedModelOutputAfterReasonHold'
    await expect(assertSourceModelOutputAuthority(context(cachedOutput))).rejects.toMatchObject({code:'source_unavailable',reason:'authority_changed',retrySafe:false})
    report.stage='freshQueryAfterReasonHold'
    const heldReader=await f.modelContext(f.ownerId),heldRead=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence,authority:heldReader})
    expect(heldRead.history.map(row=>[row.id,row.sequenceNum,row.role,row.content])).toEqual(initial.map(row=>[row.id,row.sequenceNum,row.role,row.content]))
    report.heldRead={history:heldRead.history,evidence:heldReader.accumulator.evidence}
   }finally{
    await f.pool.query('UPDATE memories SET scope_held=false WHERE id=$1',[reason.id])
    const restored=(await f.pool.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[reason.id])).rows[0].value
    report.reasonRestored=restored;expect(restored.scope_held).toBe(false);expect(restored.scope_version).toBe(reasonBefore.scope_version)
    const{updated_at:beforeTime,...beforeBusiness}=reasonBefore,{updated_at:afterTime,...afterBusiness}=restored
    expect(afterBusiness).toEqual(beforeBusiness);report.reasonFixtureTimestamp={before:beforeTime,after:afterTime}
   }
   report.stage='freshQueryAfterReasonRestore'
   const restoredReader=await f.modelContext(f.ownerId),restoredRead=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence,authority:restoredReader})
   expect(restoredRead.history.map(row=>[row.id,row.sequenceNum,row.role,row.content])).toEqual([...initial,...rows].map(row=>[row.id,row.sequenceNum,row.role,row.content]))
   report.restoredRead={history:restoredRead.history,evidence:restoredReader.accumulator.evidence}
   report.stage='restoredModelInput';await assertSourceModelInputAuthority(context(restoredReader));report.restoredModelInputPassed=true
   report.stage='restoredModelOutput';await assertSourceModelOutputAuthority(context(restoredReader));report.restoredModelOutputPassed=true
   }
   report.stage='complete'
  }catch(error){report.failure=errorInfo(error);throw error}
  finally{
   getAppPool().off('acquire',watch);for(const[client,query]of queries)client.query=query
   report.trace=trace
   try{
    if(before){const after=await state();report.after=after
     const stableMemory=(row:{value:Record<string,unknown>})=>{
      if(row.value.id!==heldReasonId)return row
      const{updated_at:fixtureTimestamp,...value}=row.value;return{value}
     }
     expect(after.memories.map(stableMemory)).toEqual(before.memories.map(stableMemory))
     for(const key of ['transitions','receipts','revisions','resourceStates'] as const)expect(after[key]).toEqual(before[key])
     if(!report.batchCommitCompleted)expect(after).toEqual(before)
     else if(afterCommit){
      for(const key of ['messages','parent','derivations','edges'] as const)expect(after[key]).toEqual(afterCommit[key])
      const key=(value:Record<string,unknown>,kind:'resources'|'observations')=>kind==='resources'?value.id:JSON.stringify([value.resource_id,value.version])
      const newRows:Record<string,unknown>={}
      for(const kind of ['resources','observations'] as const){
       const oldKeys=new Set(afterCommit[kind].map(row=>key(row.value,kind)))
       expect(after[kind].filter(row=>oldKeys.has(key(row.value,kind)))).toEqual(afterCommit[kind])
       newRows[kind]=after[kind].filter(row=>!oldKeys.has(key(row.value,kind)))
      }
      const originalFieldSources=new Set(afterCommit.fieldSources.map(row=>JSON.stringify(row)))
      expect(after.fieldSources.filter(row=>originalFieldSources.has(JSON.stringify(row)))).toEqual(afterCommit.fieldSources)
      const freshObservationKeys=new Set((newRows.observations as Array<{value:Record<string,unknown>}>).map(row=>JSON.stringify([row.value.resource_id,row.value.version])))
      const addedFieldSources=after.fieldSources.filter(row=>!originalFieldSources.has(JSON.stringify(row)))
      for(const row of addedFieldSources)expect(freshObservationKeys.has(JSON.stringify([row.value.resource_id,row.value.version]))).toBe(true)
      report.readArtifacts={...newRows,fieldSources:addedFieldSources}
      const allowed=(resource:Record<string,unknown>)=>resource.type_key==='session_message'||resource.type_key==='session_message_annotation'
      for(const row of newRows.resources as Array<{value:Record<string,unknown>}>){expect(allowed(row.value)).toBe(true);expect(['query','query_domain']).toContain(row.value.selection)}
      for(const row of newRows.observations as Array<{value:Record<string,unknown>}>){
       const resource=after.resources.find(resource=>resource.value.id===row.value.resource_id)!.value
       expect(allowed(resource)).toBe(true);expect(['query','query_domain']).toContain(resource.selection)
      }
     }
    }
   }catch(error){report.conservationFailure=errorInfo(error);throw error}
   finally{
    if(process.env.F_E09_ARTIFACT)await writeFile(process.env.F_E09_ARTIFACT+'.'+controls+'.json',JSON.stringify(report,null,2)+'\n')
    if(token)await releaseTurnLease(f.session.id,'completed',token)
   }
  }
 },120_000)
})
