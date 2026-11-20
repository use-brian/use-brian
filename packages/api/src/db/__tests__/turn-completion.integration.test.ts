/** Durable completion header for every lane (migration 8277): a reply committed
 * before a simulated process death survives and is never duplicated on restart;
 * an uncommitted one restarts exactly once. Audience, refusal and registry
 * tamper controls run on the same ordinary-owner fixture.
 * Spec: docs/architecture/platform/database-schema.md "Durable turn completion header (8277)".
 * [COMP:api/native-turn-frame] */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import pg,{type PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import type {ResourceScope} from '@use-brian/agent-runtime/security/derived-scope.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease} from '../client.js'
import {publishNativeSessionMessageBatch,publishStoredTurnPublication,readAdmittedSessionQuery} from '../conversation-store.js'
import {bindTurnCompletion,committedTurnCompletion,reconcileTurnCompletion,recordTurnCompletion,type TurnCompletionInput,type TurnCompletionLane} from '../conversation-publication-recovery.js'
import {authSessionStore} from '../auth-session-store.js'
import {addSessionMessage,claimTurnLease,createPersonalWebSession,findOrCreateSession,readSessionById,reclaimStaleTurnOutcome,releaseTurnLease,type Session} from '../sessions.js'
import {findAssistantById} from '../users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {classifySession,policyFor} from '../../session-kind.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const {authenticateConversationInstallation,currentFunctionCount}=await import(new URL('../../../scripts/conversation-store/installation-authentication.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>
type Mode='committed'|'uncommitted'
type Lane={name:string;lane:TurnCompletionLane;writer:'native'|'stored';session:Session;execution?:ExecutionContext;target:ResourceScope;
 input:TurnCompletionInput;expectedLane:string}
const lanes:Lane[]=[]
const marker=(lane:Lane)=>`Fictional ${lane.name} completion reply`
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

async function execution(session:Session,personal:boolean):Promise<ExecutionContext>{
 const stored=(await readSessionById(session.id))!
 const device=personal?(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional completion browser',userAgent:null,ipAddress:null}))!:null
 return(await resolveExecutionContextSystem({userId:f.ownerId,workspaceId:f.workspaceId,assistant:(await findAssistantById(f.assistantId))!,memberMode:'member',
  sharedAudience:!policyFor(stored).context.personalMemory,session:stored,sessionAuthority:stored,
  identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.ownerId,authenticationKind:'native_session'}},
  ownership:{kind:'workspace',workspaceId:f.workspaceId},
  lifecycle:{sessionId:stored.id,sessionPersisted:true,channelType:stored.channelType,channelId:stored.channelId,
   transport:classifySession(stored).transport,abortSignal:new AbortController().signal},
  ...(device?{nativeSessionCredential:{userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}}:{})})).executionContext
}
async function input(session:Session,target:ResourceScope,text:string){
 return addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text}],senderUserId:f.ownerId,scope:{...target,assistantId:null}})
}
const binding=(lane:Lane,operationId=randomUUID())=>bindTurnCompletion({operationId,lane:lane.lane,assistantId:f.assistantId,input:lane.input})
const replies=async(lane:Lane)=>Number((await f.pool.query("SELECT count(*) n FROM session_messages WHERE session_id=$1 AND role='assistant' AND content::text LIKE $2",
 [lane.session.id,`%${marker(lane)}%`])).rows[0].n)

/** The owner's reply publication through the lane's real store writer. */
async function publish(lane:Lane,token:string,crash?:Mode){
 const rows=[{role:'assistant' as const,content:[{type:'text',text:marker(lane)}],senderAssistantId:f.assistantId}]
 if(lane.writer==='native'){
  const authority={execution:lane.execution!,accumulator:new ContextScopeAccumulator()}
  const through=Number((await f.pool.query('SELECT max(sequence_num) n FROM session_messages WHERE session_id=$1',[lane.session.id])).rows[0].n)
  const query=boundScopeSources(await readAdmittedSessionQuery({sessionId:lane.session.id,throughSequence:through,authority}))
  return publishNativeSessionMessageBatch({sessionId:lane.session.id,messages:rows,derivation:{producer:'fixture:turn-completion',sources:query},
   derivationTarget:lane.target,authority,publication:{turnToken:token,completion:binding(lane)},
   measure:async(counter,run)=>{
    if(counter!=='publication_commit'||!crash)return run()
    if(crash==='uncommitted')throw new Error('Simulated process death before COMMIT')
    // The process dies once COMMIT is durable; nothing after it runs.
    return run()
   }})
 }
 if(!crash)return publishStoredTurnPublication({sessionId:lane.session.id,rows,write:{scope:{...lane.target,assistantId:null}},token,stopped:false,completion:binding(lane)})
 // Stored writer under real connection loss: the rows and the header are written,
 // then the socket is destroyed before (uncommitted) or after (committed) COMMIT
 // reaches the server, without the client ever reading the acknowledgement.
 const tx=await getPool().connect()
 const stored:Awaited<ReturnType<typeof addSessionMessage>>[]=[]
 await tx.query('BEGIN')
 for(const row of rows)stored.push(await addSessionMessage({sessionId:lane.session.id,...row,scope:{...lane.target,assistantId:null}},tx))
 await recordTurnCompletion(tx,{workspaceId:f.workspaceId,sessionId:lane.session.id,token,stopped:false,binding:binding(lane),rows:stored})
 const socket=(tx as unknown as {connection:{stream:{destroy:()=>void}}}).connection.stream
 if(crash==='committed'){
  void tx.query('COMMIT').catch(()=>{})
  for(let i=0;i<200&&!(await replies(lane));i++)await sleep(10)
 }
 socket.destroy();tx.release(true)
 return stored
}
/** A restarted process: it has only the session and the turn input. The stale
 * lease is reclaimed, a new lease claimed, and a committed completion reused. */
async function restart(lane:Lane):Promise<{action:'reused'|'published';recovered:string|null}>{
 await sleep(20)
 const recovered=(await reclaimStaleTurnOutcome(lane.session.id,1))?.reason??null
 const token=(await claimTurnLease(lane.session.id,f.assistantId))!
 expect(token).toBeTruthy()
 try{
  if(await committedTurnCompletion({workspaceId:f.workspaceId,sessionId:lane.session.id,input:lane.input}))return{action:'reused',recovered}
  await publish(lane,token)
  return{action:'published',recovered}
 }finally{await releaseTurnLease(lane.session.id,'completed',token)}
}
async function asMember<T>(userId:string,run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await getAppPool().connect()
 try{await client.query('BEGIN');await applyRLSGucs(client,userId);return await run(client)}finally{await rollbackAndRelease(client)}
}
async function observer(sql:string){
 const fixture=JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!,'utf8')) as {bootstrapRole?:string}
 const url=new URL(process.env.DATABASE_URL!);url.username=fixture.bootstrapRole!
 const admin=new pg.Client({connectionString:url.href});await admin.connect()
 try{return await admin.query(sql)}finally{await admin.end()}
}

describe.sequential('[COMP:api/native-turn-frame] durable turn completion header',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture('confidential')
  await f.history()
  const shared=f.envelope,personal={...f.envelope,userId:f.ownerId}
  const sharedInput=(await f.pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='user' ORDER BY sequence_num DESC LIMIT 1",[f.session.id])).rows[0].id
  lanes.push({name:'shared web',lane:'web',writer:'native',session:f.session,execution:await execution(f.session,false),target:shared,
   input:{kind:'session_message',ref:sharedInput},expectedLane:'web_shared'})
  const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional private browser',userAgent:null,ipAddress:null}))!
  const privateSession=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
  const privateInput=await input(privateSession,personal,'Fictional private request')
  lanes.push({name:'private web',lane:'web',writer:'native',session:privateSession,execution:await execution(privateSession,true),target:personal,
   input:{kind:'session_message',ref:privateInput.id},expectedLane:'web_private'})
  const channel=await findOrCreateSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'telegram',channelId:randomUUID(),
   visibility:'workspace',effectiveClearance:'confidential'})
  const channelInput=await input(channel,shared,'Fictional channel request')
  lanes.push({name:'channel',lane:'channel',writer:'native',session:channel,execution:await execution(channel,false),target:shared,
   input:{kind:'session_message',ref:channelInput.id},expectedLane:'channel'})
  const api=await findOrCreateSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'api',channelId:randomUUID(),visibility:'personal',effectiveClearance:'confidential'})
  const apiInput=await input(api,personal,'Fictional public API request')
  lanes.push({name:'public',lane:'public',writer:'stored',session:api,target:personal,input:{kind:'session_message',ref:apiInput.id},expectedLane:'public'})
  const callee=await findOrCreateSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'assistant-call',channelId:randomUUID(),visibility:'personal',effectiveClearance:'confidential'})
  await input(callee,personal,'Fictional delegated request')
  lanes.push({name:'callee',lane:'callee',writer:'stored',session:callee,target:personal,input:{kind:'delegation',ref:`fixture-delegation-${randomUUID()}`},expectedLane:'callee'})
  const resumed=await findOrCreateSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),visibility:'personal',effectiveClearance:'confidential'})
  await input(resumed,personal,'Fictional request that suspended')
  const approval=randomUUID()
  await f.pool.query("INSERT INTO pending_approvals(id,workspace_id,approver_user_id,kind,status,blocking_session_id,tool_name) VALUES($1,$2,$3,'tool_call','approved',$4,'fixtureTool')",[approval,f.workspaceId,f.ownerId,resumed.id])
  await f.pool.query("INSERT INTO session_resume_points(session_id,approval_id,suspended_tool_name,suspended_tool_input,loop_step_index) VALUES($1,$2,'fixtureTool','{}',0)",[resumed.id,approval])
  lanes.push({name:'resume',lane:'resume',writer:'stored',session:resumed,target:personal,input:{kind:'approval',ref:approval},expectedLane:'resume'})
 },240_000)
 afterAll(async()=>{try{await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}})

 for(const mode of ['committed','uncommitted'] as const)for(const index of [0,1,2,3,4,5]){
  it(`lane ${index} (${['shared web','private web','channel','public','callee','resume'][index]}): ${mode} before a simulated crash`,async()=>{
   const lane=lanes[index]!
   await f.pool.query("DELETE FROM session_messages WHERE session_id=$1 AND role='assistant' AND content::text LIKE $2",[lane.session.id,`%${marker(lane)}%`])
   await f.pool.query('DELETE FROM native_turn_completions WHERE session_id=$1',[lane.session.id])
   const token=(await claimTurnLease(lane.session.id,f.assistantId))!
   const crashed=await publish(lane,token,mode).then(()=>'returned',error=>(error as Error).message)
   if(mode==='uncommitted'&&lane.writer==='native')expect(crashed).toMatch(/Simulated process death|terminat|Connection|ECONNRESET|closed/i)
   // The old owner is gone: its lease stays running until the restart reclaims it.
   expect(await replies(lane)).toBe(mode==='committed'?1:0)
   const first=await restart(lane)
   expect(first).toEqual(mode==='committed'?{action:'reused',recovered:'publication_recovered'}:{action:'published',recovered:'stalled_reclaimed'})
   // The superseded token is definite: committed, or never committed.
   const old=await reconcileTurnCompletion({workspaceId:f.workspaceId,sessionId:lane.session.id,token})
   expect(old.state).toBe(mode==='committed'?'committed':'not_committed')
   const second=await restart(lane)
   expect(second.action).toBe('reused')
   expect(await replies(lane)).toBe(1)
   const committed=(await committedTurnCompletion({workspaceId:f.workspaceId,sessionId:lane.session.id,input:lane.input}))!
   expect(committed).toMatchObject({lane:lane.expectedLane,assistantId:f.assistantId,input:lane.input,stopped:false,publishedReply:true})
   expect(committed.outputs).toHaveLength(1)
   expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_completions WHERE session_id=$1',[lane.session.id])).rows[0].n).toBe(1)
  },120_000)
 }

 it('an in-flight token is in progress, never not-committed',async()=>{
  const lane=lanes[3]!
  const token=(await claimTurnLease(lane.session.id,f.assistantId))!
  try{expect((await reconcileTurnCompletion({workspaceId:f.workspaceId,sessionId:lane.session.id,token})).state).toBe('in_progress')}
  finally{await releaseTurnLease(lane.session.id,'completed',token)}
 })

 it('refuses superseded tokens, foreign rows, lane mismatch, conflicts and a direct write',async()=>{
  const lane=lanes[3]!,web=lanes[0]!
  const old=(await claimTurnLease(lane.session.id,f.assistantId))!
  await releaseTurnLease(lane.session.id,'completed',old)
  const attempt=async(token:string,run:(tx:PoolClient)=>Promise<unknown>)=>{
   const tx=await getPool().connect()
   try{await tx.query('BEGIN');return await run(tx).then(()=>'ok',(error:{code?:string;message:string})=>`${error.code}:${error.message}`)}finally{await rollbackAndRelease(tx)}
  }
  const row=(tx:PoolClient)=>addSessionMessage({sessionId:lane.session.id,role:'assistant',content:[{type:'text',text:'Fictional refused reply'}],senderAssistantId:f.assistantId,scope:{...lane.target,assistantId:null}},tx)
  const record=(tx:PoolClient,token:string,rows:{id:string;sequenceNum:number}[],b=binding(lane),session=lane.session.id)=>
   recordTurnCompletion(tx,{workspaceId:f.workspaceId,sessionId:session,token,stopped:false,binding:b,rows})
  expect(await attempt(old,async tx=>record(tx,old,[await row(tx)]))).toBe('42501:scope_source_changed')
  const token=(await claimTurnLease(lane.session.id,f.assistantId))!
  try{
   const earlier=(await f.pool.query("SELECT id,sequence_num \"sequenceNum\" FROM session_messages WHERE session_id=$1 AND role='assistant' LIMIT 1",[lane.session.id])).rows
   expect(await attempt(token,tx=>record(tx,token,earlier))).toBe('42501:scope_source_changed')
   expect(await attempt(token,async tx=>record(tx,token,[await row(tx)],bindTurnCompletion({operationId:randomUUID(),lane:'channel',assistantId:f.assistantId,input:null})))).toBe('ok')
   expect(await attempt(token,async tx=>record(tx,token,[await row(tx)],bindTurnCompletion({operationId:randomUUID(),lane:'web',assistantId:f.assistantId,input:null})))).toBe('42501:scope_source_changed')
   expect(await attempt(token,async tx=>{const rows=[await row(tx)];await record(tx,token,rows);return record(tx,token,rows,binding(lane))})).toBe('42501:turn_completion_conflict')
   expect(await attempt(token,async tx=>{const rows=[await row(tx)],b=binding(lane);await record(tx,token,rows,b);return record(tx,token,rows,b)})).toBe('ok')
  }finally{await releaseTurnLease(lane.session.id,'completed',token)}
  const webToken=(await claimTurnLease(web.session.id,f.assistantId))!
  try{
   expect(await attempt(webToken,async tx=>record(tx,webToken,[await addSessionMessage({sessionId:web.session.id,role:'assistant',content:[{type:'text',text:'Fictional channel lane on web'}],senderAssistantId:f.assistantId,scope:web.target},tx)],
    bindTurnCompletion({operationId:randomUUID(),lane:'channel',assistantId:f.assistantId,input:null}),web.session.id))).toBe('42501:scope_source_changed')
  }finally{await releaseTurnLease(web.session.id,'completed',webToken)}
  const direct=await asMember(f.ownerId,client=>client.query('INSERT INTO native_turn_completions(id) VALUES($1)',[randomUUID()]).then(()=>'ok',(e:{code:string})=>e.code))
  expect(direct).toBe('42501')
  expect(await f.pool.query("UPDATE native_turn_completions SET stopped=stopped WHERE session_id=$1",[lanes[0]!.session.id]).then(()=>'ok',(e:{code:string;message:string})=>`${e.code}:${e.message}`)).toBe('42501:scope_source_changed')
 })

 it('shows each completion only to its session audience',async()=>{
  const read=(userId:string,lane:Lane)=>asMember(userId,client=>reconcileTurnCompletion({workspaceId:f.workspaceId,sessionId:lane.session.id,input:lane.input},client)
   .then(outcome=>outcome.state,(error:{code?:string;message:string})=>`${error.code}:${error.message}`))
  // Shared room and channel room: confidential members only (the session SELECT audience).
  for(const lane of [lanes[0]!,lanes[2]!]){
   expect(await read(f.ownerId,lane)).toBe('committed')
   expect(await read(f.secondId,lane)).toBe('committed')
   expect(await read(f.firstId,lane)).toBe('42501:scope_operation_denied')
  }
  // Private web, public, callee and resume sessions: their owner only.
  for(const lane of [lanes[1]!,lanes[3]!,lanes[4]!,lanes[5]!]){
   expect(await read(f.ownerId,lane)).toBe('committed')
   expect(await read(f.secondId,lane)).toBe('42501:scope_operation_denied')
  }
  expect(await asMember(f.secondId,client=>client.query('SELECT count(*)::int n FROM native_turn_completions').then(r=>r.rows[0].n,(e:{code:string})=>e.code))).toBe('42501')
 })

 it('adds exactly one foreground statement to a native reply publication',async()=>{
  const lane=lanes[2]!
  const count=async()=>(await observer(`SELECT coalesce(sum(calls) FILTER(WHERE toplevel),0)::int foreground,coalesce(sum(calls) FILTER(WHERE NOT toplevel),0)::int nested
   FROM pg_stat_statements WHERE userid IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','assurance_owner'))`)).rows[0] as {foreground:number;nested:number}
  const once=async(withCompletion:boolean)=>{
   const token=(await claimTurnLease(lane.session.id,f.assistantId))!
   const authority={execution:lane.execution!,accumulator:new ContextScopeAccumulator()}
   const through=Number((await f.pool.query('SELECT max(sequence_num) n FROM session_messages WHERE session_id=$1',[lane.session.id])).rows[0].n)
   const query=boundScopeSources(await readAdmittedSessionQuery({sessionId:lane.session.id,throughSequence:through,authority}))
   // Claim and release notify listeners asynchronously; keep them outside the window.
   await sleep(400)
   const before=await count()
   await publishNativeSessionMessageBatch({sessionId:lane.session.id,messages:[{role:'assistant',content:[{type:'text',text:'Fictional measured reply'}],senderAssistantId:f.assistantId}],
    derivation:{producer:'fixture:turn-completion',sources:query},derivationTarget:lane.target,authority,
    publication:{turnToken:token,...(withCompletion?{completion:bindTurnCompletion({operationId:randomUUID(),lane:'channel',assistantId:f.assistantId,input:null})}:{})}})
   await sleep(200)
   const after=await count()
   await releaseTurnLease(lane.session.id,'completed',token)
   return{foreground:after.foreground-before.foreground,nested:after.nested-before.nested}
  }
  if(!(await observer("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements') present")).rows[0].present)return
  await once(false);await once(true)
  const samples:{withCompletion:boolean;foreground:number;nested:number}[]=[]
  for(const withCompletion of [false,true,true,false,false,true])samples.push({withCompletion,...await once(withCompletion)})
  const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]!
  const foreground=(flag:boolean)=>median(samples.filter(s=>s.withCompletion===flag).map(s=>s.foreground))
  // The record statement's own nested work, isolated inside one stored transaction.
  const stored=lanes[3]!,token=(await claimTurnLease(stored.session.id,f.assistantId))!
  const tx=await getPool().connect()
  let recordNested=-1
  try{
   await tx.query('BEGIN')
   const row=await addSessionMessage({sessionId:stored.session.id,role:'assistant',content:[{type:'text',text:'Fictional isolated reply'}],senderAssistantId:f.assistantId,scope:{...stored.target,assistantId:null}},tx)
   const before=await count()
   await recordTurnCompletion(tx,{workspaceId:f.workspaceId,sessionId:stored.session.id,token,stopped:false,binding:binding(stored),rows:[row]})
   const after=await count()
   recordNested=after.nested-before.nested
  }finally{await rollbackAndRelease(tx);await releaseTurnLease(stored.session.id,'completed',token)}
  console.log('[turn-completion statements]',JSON.stringify({samples,recordNested}))
  expect(foreground(true)-foreground(false)).toBe(1)
  expect(recordNested).toBeGreaterThan(0)
  expect(recordNested).toBeLessThan(40)
 })

 it('authenticates the four members from source and refuses each tampered member',async()=>{
  const authenticate=async()=>{const client=await getPool().connect();try{return await authenticateConversationInstallation(client)}finally{client.release()}}
  const refresh=()=>f.pool.query('SELECT native_turn_contract_witness_refresh() value')
  // A fresh 8277 install records the witness itself; an earlier interrupted run may not have.
  if(!(await authenticate()).witnessCurrent)await refresh()
  const first=await authenticate(),second=await authenticate()
  expect(first).toEqual(second);expect(first.functions).toBe(currentFunctionCount);expect(currentFunctionCount).toBe(392);expect(first.witnessCurrent).toBe(true)
  const guard=async()=>(await f.pool.query('SELECT native_turn_helpers_current() value')).rows[0].value as boolean
  // Claim and release are guarded too, so the lease is held across each tamper.
  const lane=lanes[3]!
  const recordRefused=async(token:string)=>{
   const tx=await getPool().connect()
   try{
    await tx.query('BEGIN')
    const row=await addSessionMessage({sessionId:lane.session.id,role:'assistant',content:[{type:'text',text:'Fictional tamper reply'}],senderAssistantId:f.assistantId,scope:{...lane.target,assistantId:null}},tx)
    return await recordTurnCompletion(tx,{workspaceId:f.workspaceId,sessionId:lane.session.id,token,stopped:false,binding:binding(lane),rows:[row]}).then(()=>'ok',(e:{code:string;message:string})=>`${e.code}:${e.message}`)
   }finally{await rollbackAndRelease(tx)}
  }
  const definition=async(signature:string)=>(await f.pool.query('SELECT pg_get_functiondef($1::regprocedure) d,prosrc FROM pg_proc WHERE oid=$1::regprocedure',['public.'+signature])).rows[0] as {d:string;prosrc:string}
  const read=await definition('read_native_turn_completion(uuid,uuid,uuid,jsonb)')
  const tampers:[string,string,string][]=[
   ['cost','ALTER FUNCTION record_native_turn_completion(uuid,uuid,uuid,jsonb) COST 101','ALTER FUNCTION record_native_turn_completion(uuid,uuid,uuid,jsonb) COST 100'],
   ['body',read.d.replace(read.prosrc,read.prosrc+' '),read.d],
   ['acl','GRANT EXECUTE ON FUNCTION native_turn_completion_scope(uuid,uuid) TO app_user','REVOKE EXECUTE ON FUNCTION native_turn_completion_scope(uuid,uuid) FROM app_user'],
   ['registry',"UPDATE native_turn_contract_helpers SET contract.procost=(contract).procost+1 WHERE signature='native_turn_completion_immutable()'",
    "UPDATE native_turn_contract_helpers SET contract.procost=(contract).procost-1 WHERE signature='native_turn_completion_immutable()'"],
  ]
  for(const [label,tamper,restore] of tampers){
   const token=(await claimTurnLease(lane.session.id,f.assistantId))!
   await f.pool.query(tamper)
   try{
    expect(await guard(),label).toBe(false)
    expect(await recordRefused(token),label).toBe('42501:scope_source_changed')
    await expect(authenticate(),label).rejects.toThrow()
    await expect(refresh(),label).rejects.toMatchObject({code:'42501'})
   }finally{await f.pool.query(restore)}
   expect(await guard(),label).toBe(true)
   expect(await recordRefused(token),label).toBe('ok')
   await releaseTurnLease(lane.session.id,'completed',token)
   await refresh()
  }
  // The relation contract is the authenticator's: an added policy refuses installation.
  await f.pool.query('CREATE POLICY fixture_completion_read ON native_turn_completions FOR SELECT USING (true)')
  try{await expect(authenticate()).rejects.toThrow('installation_completion_relation_changed')}
  finally{await f.pool.query('DROP POLICY fixture_completion_read ON native_turn_completions')}
  const after=await authenticate()
  expect(after).toMatchObject({functions:currentFunctionCount,witnessCurrent:true,localContractDigest:first.localContractDigest})
 },300_000)
})
