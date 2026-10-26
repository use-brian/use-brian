import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,executionToolContext,createCorrectionTools,createRetrievalTools,type RetrievalStore,type LLMProvider,type ScopeSource,type AccessCeiling} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createDbRowHistoryStore} from '../../db/row-history-store.js'
import {createMemory} from '../../db/memories.js'
import {readRetainedQueryFrame,writeRetainedContextFrame} from '../../db/session-context-revisions.js'
import {createMemoryRetractionStore} from '../../db/retraction-store.js'
import {createSoftDeleteStore} from '../../db/soft-delete-store.js'
import {createSensitivityReclassificationStore} from '../../db/sensitivity-reclassification-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishSessionTitle,readSessionTitle,sessionTitleHead} from '../../db/session-title-store.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {validateCallerScopeEvidence} from '../../context-scope/caller-evidence.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const{assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
describe.sequential('[COMP:api/application-persistence] stored native context at actual model boundaries',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture
  async function authority(actor=f.ownerId,readOnly=true){
   const device=(await authSessionStore.create(actor,{deviceLabel:'Fictional stored context device',userAgent:null,ipAddress:null}))!
   return resolveSessionTitleAuthority({claims:{userId:actor,sessionId:device.id,authVersion:device.authVersion},sessionId:f.session.id,readOnly})
  }
  async function publish(summary:string,title:string){
   const writer=await authority(f.ownerId,false),memory=await f.memory(summary)
   await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,topicThroughSequence:0,authority:writer})
   const admitted=await createDbMemoryStore().getById(writer.execution.security.access,memory.id);expect(admitted).not.toBeNull()
   writer.accumulator.note({sources:boundScopeSources(admitted!)})
   const stored=await publishSessionTitle({sessionId:f.session.id,title,manual:false,expectedRevision:await sessionTitleHead(f.session.id,writer),authority:writer,
    derivation:{producer:'fixture:stored-root-model',sources:writer.accumulator.evidence.sources??[]}});expect(stored).not.toBeNull()
   return{memory,stored:stored!}
  }
  async function reader(actor=f.firstId){
   const value=await authority(actor),title=await readSessionTitle(f.session.id,value);expect(title).not.toBeNull()
   expect([...new Set(value.accumulator.evidence.sources?.map(source=>source.resourceKind))]).toEqual(['session_context_revision'])
   return{authority:value,title:title!,context:{...executionToolContext(value.execution,{appId:'native-stored-context-model'}),scopeAccumulator:value.accumulator}}
  }
  const source=async(id:string)=>(await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,id])).rows[0].source
  return{f,authority,publish,reader,source}
 }
 for(const action of ['context','deliver'] as const)it(`rechecks hidden native Memory ancestry at the actual ${action} model guard and keeps another current reader usable`,async()=>{
  const c=await setup(),first=await c.publish('Fictional model ancestor','Fictional retained model title'),before=await c.source(first.stored.revisionId)
  const guard=action==='context'?assertSourceModelInputAuthority:assertSourceModelOutputAuthority
  await expect(guard((await c.reader()).context)).resolves.toBeUndefined()
  const cached=await c.reader()
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[first.memory.id])
  await expect(guard(cached.context)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(await c.source(first.stored.revisionId)).toEqual(before)
  const independent=await c.publish('Fictional independent model ancestor','Fictional independent model title')
  const other=await c.reader(c.f.secondId)
  expect(other.title.revisionId).toBe(independent.stored.revisionId)
  await expect(guard(other.context)).resolves.toBeUndefined()
 })
 it('refuses a cached stored ancestor before actual title text extraction or provider dispatch',async()=>{
  const c=await setup(),first=await c.publish('Fictional cached model ancestor','Fictional protected cached title'),cached=await c.reader()
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-stored-model',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},
   stream:async function*(){calls++;yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional generated safe title'};
    yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  const messages=[{role:'user' as const,get content(){extractions++;return cached.title.title}}]
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[first.memory.id])
  await expect(generateTitle(provider,messages,'fixture',()=>assertSourceModelInputAuthority(cached.context))).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
 })

 it('retains genuine retracted Memory history in a title and validates fresh revision-only model inputs',async()=>{
  const c=await setup(),store=createDbMemoryStore(),workspace=c.f.workspaceId
  const report:Record<string,unknown>={stage:'create',publicationAttempted:false,publicationCommitted:false}
  const context=(host:Awaited<ReturnType<typeof c.authority>>)=>({...executionToolContext(host.execution,{appId:'fictional-history-stored-title'}),scopeAccumulator:host.accumulator})
  const errorInfo=(error:unknown):Record<string,unknown>=>{
   if(!(error instanceof Error))return{message:String(error)}
   const e=error as Error&{code?:unknown;reason?:unknown;detail?:unknown;where?:unknown;cause?:unknown}
   return{name:e.name,message:e.message,code:e.code,reason:e.reason,detail:e.detail,where:e.where,stack:e.stack,...(e.cause?{cause:errorInfo(e.cause)}:{})}
  }
  async function sharedMemory(summary:string){
   const host=await c.authority(c.f.ownerId,false)
   return writeRetainedContextFrame(host,[],client=>createMemory({workspaceId:workspace,assistantId:c.f.assistantId,userId:null,summary,sensitivity:'internal',createdByUserId:c.f.ownerId},undefined,client))
  }
  async function titleState(){return{
   revisions:(await c.f.pool.query("SELECT to_jsonb(r) AS value FROM session_context_scope_revisions r WHERE workspace_id=$1 AND session_id=$2 AND parent_kind='session_title' ORDER BY id",[workspace,c.f.session.id])).rows,
   payloads:(await c.f.pool.query("SELECT to_jsonb(p) AS value FROM session_context_revision_contents p JOIN session_context_scope_revisions r ON r.workspace_id=p.workspace_id AND r.id=p.revision_id WHERE r.workspace_id=$1 AND r.session_id=$2 AND r.parent_kind='session_title' ORDER BY r.id",[workspace,c.f.session.id])).rows,
   heads:(await c.f.pool.query('SELECT to_jsonb(h) AS value FROM session_title_heads h WHERE workspace_id=$1 AND session_id=$2',[workspace,c.f.session.id])).rows,
   lineage:(await c.f.pool.query("SELECT to_jsonb(d) AS derivation,to_jsonb(s) AS source FROM scope_derivations d LEFT JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id JOIN session_context_scope_revisions r ON r.workspace_id=d.workspace_id AND r.id=d.resource_id WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND r.session_id=$2 ORDER BY d.id,s.source_kind,s.source_id,s.source_version",[workspace,c.f.session.id])).rows,
  }}
  const queries=new Map<PoolClient,PoolClient['query']>(),trace:Array<Record<string,unknown>>=[]
  const watch=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){
    const sql=typeof args[0]==='string'?args[0]:typeof args[0]==='object'&&args[0]!==null?(args[0] as {text?:string}).text??'':''
    const interesting=/publish_native_session_context_revision|read_native_attended_memory_evidence|read_native_session_field_dependencies|read_admitted_application_field_snapshot|application_field_ancestors|COMMIT|ROLLBACK/.test(sql)
    const entry:Record<string,unknown>={event:'query',sql}
    if(sql==='SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value')entry.roots=structuredClone(args[1])
    if(interesting)trace.push(entry)
    const value=Reflect.apply(original,client,args)
    return Promise.resolve(value).then(result=>{
     if(entry.roots){const raw=result.rows[0]?.value;entry.returned=raw===null?null:{admitted:raw?.admitted,purpose:raw?.purpose,available:raw?.available}}
     return result
    }).catch(error=>{trace.push({event:'error',sql,...errorInfo(error)});throw error})
   } as typeof client.query
  }
  let knownFields:string[]=[],beforeTitle:Awaited<ReturnType<typeof titleState>>|undefined
  async function historyMetadata(){return{
   resources:(await c.f.pool.query('SELECT to_jsonb(f) AS value FROM application_field_resources f WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[workspace,knownFields])).rows,
   observations:(await c.f.pool.query('SELECT to_jsonb(o) AS value FROM application_field_observations o WHERE workspace_id=$1 AND resource_id=ANY($2::uuid[]) ORDER BY resource_id,version',[workspace,knownFields])).rows,
  }}
  try{
   const root=await sharedMemory('Fictional original stored-history value'),reason=await sharedMemory('Fictional independent stored-history reason')
   const updating=await c.authority(c.f.ownerId,false),old=await store.getById(updating.execution.security.access,root.id,updating);expect(old).not.toBeNull()
   const oldSources=structuredClone(boundScopeSources(old!));expect(oldSources.length).toBeGreaterThan(0)
   const parentWriter=await c.authority(c.f.ownerId,false)
   const parent=await writeRetainedContextFrame(parentWriter,oldSources,client=>createMemory({workspaceId:workspace,assistantId:c.f.assistantId,userId:null,summary:'Fictional independent ordinary parent',sensitivity:'internal',createdByUserId:c.f.ownerId,derivation:{producer:'fixture:ordinary-independent-parent',sources:oldSources}},undefined,client))
   const parentReader=await c.authority(),parentValue=await store.getById(parentReader.execution.security.access,parent.id,parentReader);expect(parentValue).not.toBeNull()
   const parentSources=structuredClone(boundScopeSources(parentValue!))
   const next=await store.update(root.id,{summary:'Fictional corrected stored-history value'},updating.execution.security.access,
    {authority:updating,expectedVersion:old!.scopeVersion!,writeFields:['summary']});expect(next).not.toBeNull()
   report.stage='retract';const correcting=await c.authority(c.f.ownerId,false)
   const admittedReason=await store.getById(correcting.execution.security.access,reason.id,correcting);expect(admittedReason).not.toBeNull()
   correcting.accumulator.note({sources:boundScopeSources(admittedReason!)})
   const correction=createCorrectionTools({retraction:createMemoryRetractionStore(),softDelete:createSoftDeleteStore(),reclassify:createSensitivityReclassificationStore(),
    resolveWorkspaceRole:async(actor,w)=>(await c.f.pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[w,actor])).rows[0]?.role??null})
   const retracted=await correction.find(tool=>tool.name==='retractMemory')!.execute({memory_id:next!.id,reason:'Fictional independent history correction'},context(correcting))
   expect(retracted.isError,JSON.stringify(retracted)).not.toBe(true)
   report.lifecycle={rows:(await c.f.pool.query('SELECT id,scope_version::text,valid_to,superseded_by,retracted_at,scope_held FROM memories WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[workspace,[root.id,next!.id,reason.id]])).rows,
    transitions:(await c.f.pool.query('SELECT to_jsonb(t) AS value FROM native_memory_successor_transitions t WHERE workspace_id=$1',[workspace])).rows,
    receipts:(await c.f.pool.query('SELECT native_memory_transition FROM correction_audit WHERE workspace_id=$1 AND native_memory_transition IS NOT NULL',[workspace])).rows}
   report.stage='getRowHistory';const writer=await c.authority(c.f.ownerId,false)
   await readAdmittedSessionQuery({sessionId:c.f.session.id,throughSequence:0,topicThroughSequence:0,authority:writer})
   report.originalBeforeHistory=structuredClone(writer.accumulator.evidence)
   const tools=createRetrievalTools(createDbRowHistoryStore() as RetrievalStore)
   const history=await tools.getRowHistory.execute({primitive:'memories',row_id:next!.id,include_retracted:true},context(writer))
   expect(history.isError,JSON.stringify(history)).not.toBe(true)
   expect(history.scopeEvidence?.sources?.length).toBeGreaterThan(0)
   // This is the same successful-tool evidence handoff used by the executor.
   writer.accumulator.note(history.scopeEvidence!)
   const roots=writer.accumulator.evidence.sources??[]
   knownFields=roots.filter(s=>s.resourceKind==='application_field').map(s=>s.resourceId)
   report.history={result:history.data,evidence:history.scopeEvidence,completeOriginal:structuredClone(writer.accumulator.evidence)}
   const resources=(await c.f.pool.query("SELECT id,selection FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[workspace,knownFields])).rows
   expect(resources.some(row=>row.selection==='history')).toBe(true)
   expect(roots.some(s=>s.resourceKind==='memory')).toBe(false)
   report.beforeHistoryMetadata=await historyMetadata();beforeTitle=await titleState();report.beforeTitle=beforeTitle
   const floorWriter=await c.authority(c.f.ownerId,false)
   floorWriter.accumulator.note({sensitivity:'confidential'})
   await expect(publishSessionTitle({sessionId:c.f.session.id,title:'Fictional narrower scalar title',manual:false,expectedRevision:null,authority:floorWriter,
    derivation:{producer:'fixture:scalar-title-floor',sources:roots}})).rejects.toMatchObject({code:'scope_source_changed'})
   expect(await titleState()).toEqual(beforeTitle)
   report.scalarFloorRefused={sensitivity:'confidential',titleUnchanged:true}
   const expectedRevision=await sessionTitleHead(c.f.session.id,writer)
   report.stage='publishSessionTitle';report.publicationAttempted=true
   getAppPool().on('acquire',watch)
   const stored=await publishSessionTitle({sessionId:c.f.session.id,title:'Fictional retained historical title',manual:false,expectedRevision,authority:writer,
    derivation:{producer:'fixture:history-stored-title',sources:roots}})
   report.publicationCommitted=true;expect(stored).not.toBeNull();report.stored=stored
   report.afterTitle=await titleState()
   report.stage='readSessionTitle';const reader=await c.authority(c.f.ownerId,true),title=await readSessionTitle(c.f.session.id,reader)
   expect(title?.revisionId).toBe(stored!.revisionId)
   expect([...new Set(reader.accumulator.evidence.sources?.map(s=>s.resourceKind))]).toEqual(['session_context_revision'])
   report.freshEvidence=structuredClone(reader.accumulator.evidence)
   report.stage='modelInput';await assertSourceModelInputAuthority(context(reader))
   report.stage='modelOutput';await assertSourceModelOutputAuthority(context(reader))
   report.stage='finite C-only controls'
   const savedState=await titleState(),cRoot=boundScopeSources(title!)[0]!
   expect(savedState.revisions).toHaveLength(1);expect(savedState.payloads).toHaveLength(1);expect(savedState.heads).toHaveLength(1)
   expect(savedState.lineage).toHaveLength(5);expect(savedState.lineage.every(row=>row.source.source_kind==='application_field')).toBe(true)
   const probe=async<T>(run:(client:PoolClient)=>Promise<T>)=>readRetainedQueryFrame(await c.authority(),[],async client=>({value:await run(client),sources:[]}))
   report.directShape=await probe(async client=>({
    lineage:(await c.f.pool.query("SELECT * FROM application_scope_lineage($1,$2,$3,$4)",[workspace,['session_context_revision'],[stored!.revisionId],['1']])).rows,
    projected:(await client.query('SELECT * FROM read_native_session_field_dependencies($1,$2,$3,$4)',[workspace,['session_context_revision'],[stored!.revisionId],['1']])).rows,
   }))
   const shape=report.directShape as {lineage:Array<{kind:string;id:string}>;projected:Array<{source:ScopeSource}>}
   expect(shape.lineage.filter(node=>node.kind==='session_context_revision').map(node=>node.id)).toEqual([stored!.revisionId])
   expect(new Set(shape.projected.map(row=>JSON.stringify([row.source.resourceId,row.source.version]))).size).toBe(5)
   for(const source of roots)expect(shape.projected.some(row=>row.source.resourceId===source.resourceId&&row.source.version===source.version)).toBe(true)
   expect(shape.projected.some(row=>oldSources.some(old=>old.resourceId===row.source.resourceId&&old.version===row.source.version))).toBe(false)
   const denied:Array<string>=[]
   for(const[name,independent]of [['independent old field',oldSources],['independent parent to old field',parentSources]] as const){
    await expect(probe(client=>validateCallerScopeEvidence({sources:[cRoot,...independent]},reader.execution.security.ceiling,client))).rejects.toBeDefined()
    await expect(probe(client=>client.query('SELECT * FROM read_native_session_field_dependencies($1,$2,$3,$4)',[workspace,
     ['session_context_revision',...independent.map(source=>source.resourceKind)],[stored!.revisionId,...independent.map(source=>source.resourceId)],['1',...independent.map(source=>source.version)]]))).rejects.toMatchObject({code:'42501'})
    denied.push(name);expect(await titleState()).toEqual(savedState)
   }
   for(const[name,kinds,ids,versions]of [
    ['wrong C version',['session_context_revision'],[stored!.revisionId],['2']],
    ['wrong H observation version',['application_field'],[roots.find(source=>resources.some(row=>row.id===source.resourceId&&row.selection==='history'))!.resourceId],['fictional-wrong-version']],
   ] as const){
    await expect(probe(client=>client.query('SELECT * FROM read_native_session_field_dependencies($1,$2,$3,$4)',[workspace,kinds,ids,versions]))).rejects.toMatchObject({code:'42501'})
    denied.push(name);expect(await titleState()).toEqual(savedState)
   }
   report.nativeProfile=await probe(async client=>{
    const native=(await client.query('SELECT session_context_revision_allowed($1,$2) AS allowed',[workspace,stored!.revisionId])).rows[0]
    await client.query("SELECT set_config('app.application_id',$1,true)",[randomUUID()])
    const application=(await client.query('SELECT session_context_revision_allowed($1,$2) AS allowed,read_session_context_revision($1,$2) AS payload',[workspace,stored!.revisionId])).rows[0]
    await client.query("SELECT set_config('app.application_id','',true),set_config('app.current_user_id','',true)")
    const absentActor=(await client.query('SELECT session_context_revision_allowed($1,$2) AS allowed,read_session_context_revision($1,$2) AS payload',[workspace,stored!.revisionId])).rows[0]
    return{native,application,absentActor}
   })
   expect(report.nativeProfile).toEqual({native:{allowed:true},application:{allowed:false,payload:null},absentActor:{allowed:false,payload:null}})
   for(const[diagnostic,narrow]of [
    ['assistant_visibility',{...reader.execution.security.ceiling,visibilityAssistantIds:[]}],
    ['clearance',{...reader.execution.security.ceiling,clearance:'public' as const}],
   ] as Array<[string,AccessCeiling]>){
    await expect(probe(client=>validateCallerScopeEvidence({sources:[cRoot]},narrow,client))).rejects.toMatchObject({code:'scope_source_changed',cause:{reason:'caller_evidence_unavailable',diagnostic}})
    denied.push(diagnostic);expect(await titleState()).toEqual(savedState)
   }
   await expect(probe(client=>client.query('SELECT session_context_revision_allowed($1,$2) AS allowed,read_session_context_revision($1,$2) AS payload',[randomUUID(),stored!.revisionId]))).rejects.toMatchObject({code:'42501'})
   denied.push('wrong workspace')
   // A real source contraction must deny the saved title while leaving its
   // immutable publication intact. Inspect the actual source row/version.
   const sourceBefore=(await c.f.pool.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[root.id])).rows
   await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[root.id])
   const sourceAfter=(await c.f.pool.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[root.id])).rows
   expect(sourceBefore[0].value.scope_held).toBe(false);expect(sourceAfter[0].value.scope_held).toBe(true)
   const contracted=await titleState();expect(contracted).toEqual(savedState)
   for(let attempt=0;attempt<2;attempt++){
    expect(await readSessionTitle(c.f.session.id,await c.authority())).toBeNull()
    expect(await titleState()).toEqual(contracted)
   }
   denied.push('explicit later H ancestor hold');report.contraction={sourceBefore,sourceAfter,before:savedState,after:contracted}
   report.refusals=denied;report.afterFiniteTitle=await titleState()
   report.stage='complete'
  }catch(error){
   report.failure=errorInfo(error)
   if(beforeTitle){const after=await titleState();report.afterTitle=after;if(!report.publicationCommitted)expect(after).toEqual(beforeTitle)}
   throw error
  }finally{
   getAppPool().off('acquire',watch);for(const[client,query]of queries)client.query=query
   report.trace=trace
   if(report.lifecycle){
    const lifecycle=report.lifecycle as {transitions:unknown;receipts:unknown}
    const after={transitions:(await c.f.pool.query('SELECT to_jsonb(t) AS value FROM native_memory_successor_transitions t WHERE workspace_id=$1',[workspace])).rows,
     receipts:(await c.f.pool.query('SELECT native_memory_transition FROM correction_audit WHERE workspace_id=$1 AND native_memory_transition IS NOT NULL',[workspace])).rows}
    report.afterImmutableLifecycle=after
    expect(after).toEqual({transitions:lifecycle.transitions,receipts:lifecycle.receipts})
   }
   const capturedFields=[...new Set(trace.flatMap(entry=>{const r=entry.roots as [string,string[],string[],string[]]|undefined;return r?r[1].flatMap((kind,index)=>kind==='application_field'?[r[2][index]]:[]):[]}))]
   report.facadeFieldMetadata={resources:(await c.f.pool.query('SELECT to_jsonb(f) AS value FROM application_field_resources f WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[workspace,capturedFields])).rows,
    observations:(await c.f.pool.query('SELECT to_jsonb(o) AS value FROM application_field_observations o WHERE workspace_id=$1 AND resource_id=ANY($2::uuid[]) ORDER BY resource_id,version',[workspace,capturedFields])).rows}
   if(knownFields.length){report.afterHistoryMetadata=await historyMetadata();expect(report.afterHistoryMetadata).toEqual(report.beforeHistoryMetadata)}
   if(process.env.C082_ARTIFACT)await writeFile(process.env.C082_ARTIFACT,JSON.stringify(report,null,2)+'\n')
  }
 },120_000)
})
