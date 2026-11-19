import {randomUUID} from 'node:crypto'
import {fork,type ChildProcess} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {afterAll,describe,expect,it} from 'vitest'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage,claimTurnLease} from '../../db/sessions.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {policyFor,sessionKindSql,type SessionKindRow} from '../../session-kind.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const secret='fictional-durable-publication-secret',worker=fileURLToPath(new URL('./fixtures/conversation-publication-worker.ts',import.meta.url))
const require=createRequire(import.meta.url)
type ResponseEvent={event:'response';pid:number;status:number;body:unknown;discoveries:number;modelCalls:number;toolCalls:number;providerSends:number;sawPriorReply:boolean;providerAborted:boolean;lifecycle:Array<{kind:string;sessionId:string;payload:Record<string,unknown>}>;statusBody?:Record<string,unknown>;submittedPublication?:unknown[]}
async function child(command:object,directory:string,kill=false,beforeLock?:()=>Promise<void>,beforeCommit?:()=>Promise<void>):Promise<ResponseEvent|{event:'publication_committed';pid:number}>{
 const path=join(directory,`${randomUUID()}.json`);await writeFile(path,JSON.stringify(command),{mode:0o600})
 return new Promise((resolve,reject)=>{
  const process:ChildProcess=fork(worker,[path],{execArgv:['--import',require.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']})
  let output='',event:ResponseEvent|{event:'publication_committed';pid:number}|undefined
  const timeout=setTimeout(()=>{process.kill('SIGKILL');reject(new Error(`Publication worker timed out: ${output.slice(-3000)}`))},60_000)
  process.stdout?.on('data',chunk=>{output+=chunk});process.stderr?.on('data',chunk=>{output+=chunk})
  process.on('message',(message:ResponseEvent|{event:string;pid:number;message?:string})=>{
   if(message.event==='before_publication_lock'){
    void(async()=>{if(!beforeLock)throw new Error('Unexpected publication pause');await beforeLock();process.send?.({kind:'continue'})})().catch(error=>{process.kill('SIGKILL');reject(error)});return
   }
   if(message.event==='before_publication_commit'){
    void(async()=>{if(!beforeCommit)throw new Error('Unexpected commit pause');await beforeCommit();process.send?.({kind:'continue'})})().catch(error=>{process.kill('SIGKILL');reject(error)});return
   }
   if(message.event==='publication_committed'&&kill){event=message as {event:'publication_committed';pid:number};process.kill('SIGKILL')}
   else if(message.event==='response')event=message as ResponseEvent
   else if(message.event==='error')output+=message.message
  })
  process.once('error',error=>{clearTimeout(timeout);reject(error)})
  process.once('exit',(code,signal)=>{clearTimeout(timeout);if(event&&(code===0||kill&&signal==='SIGKILL'))resolve(event);else reject(new Error(`Publication worker failed ${code??signal}: ${output.slice(-5000)}`))})
 })
}

describe.sequential('[COMP:api/native-turn-frame] authenticated durable buffered web publication',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('publishes normally, then reads an actual killed publisher through authenticated history without repeating its tool',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'brian-publication-recovery-'))
  try{
   const room:SessionKindRow={channelType:'web',anchorKind:'none',visibility:'workspace',appOrigin:'chat'}
   for(const row of [room,{...room,transient:true},{...room,mode:'draft'},
    {...room,visibility:'personal'},{...room,anchorKind:'doc_thread'},
    {...room,channelType:'programmatic'},{...room,appOrigin:'doc'}]){
    const actual=(await getPool().query<{allowed:boolean}>(`SELECT ${sessionKindSql.durableBufferedPublication('s')} AS allowed
     FROM(SELECT $1::text visibility,$2::text channel_type,$3::text anchor_kind,$4::text app_origin,$5::boolean transient) s`,
     [row.visibility,row.channelType,row.anchorKind,row.appOrigin,row.transient??false])).rows[0].allowed
    expect(actual).toBe(policyFor(row).durableBufferedPublication)
   }
   // Ordinary publication is qualified before fault injection on a fresh session.
   for(const killed of [false,true]){
    const f=await persistentContextFixture('confidential'),counter=`publication_counter_${randomUUID().replaceAll('-','')}`
    try{
     await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
     await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
     const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional recovery browser',userAgent:null,ipAddress:null}))!
     const token=createTokens(f.ownerId,secret,device).accessToken
     const command={mode:killed?'kill_after_commit':'publish',workspaceId:f.workspaceId,sessionId:f.session.id,assistantId:f.assistantId,token,secret,counter}
     const published=await child(command,directory,killed)
     if(killed)expect(published.event).toBe('publication_committed')
     else{expect(published.event).toBe('response');expect((published as ResponseEvent).status).toBe(200);expect((published as ResponseEvent).body).not.toContain('event: error')}
     expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
     const operations=(await f.pool.query('SELECT id,input_message_id,outputs FROM native_conversation_publications WHERE workspace_id=$1 AND session_id=$2',[f.workspaceId,f.session.id])).rows
     expect(operations).toHaveLength(1)
     const outputs=operations[0].outputs as Array<{kind:string;id:string;sequence?:number}>
     const messageIds=outputs.filter(output=>output.kind==='session_message').map(output=>output.id)
     expect(messageIds).toHaveLength(3)
     const unrelated=await addSessionMessage({sessionId:f.session.id,role:'user',content:'Fictional later unrelated post',senderUserId:f.ownerId,scope:f.envelope})
     const reopened=await child({...command,mode:'receive'},directory) as ResponseEvent
     expect(reopened.event).toBe('response');expect(reopened.pid).not.toBe(published.pid);expect(reopened.status).toBe(200)
     expect(reopened.discoveries).toBe(0)
     expect(reopened.modelCalls).toBe(0);expect(reopened.toolCalls).toBe(0)
     const visible=reopened.body as Array<{id:string;content:unknown}>
     expect(messageIds.every(id=>visible.some(row=>row.id===id))).toBe(true)
     expect(visible.some(row=>row.id===unrelated.id)).toBe(true)
     expect(messageIds).not.toContain(unrelated.id)
     expect(JSON.stringify(visible)).toContain('Fictional durable tool answer')
     const finalized = visible.filter(row => JSON.stringify(row.content).includes('Fictional durable tool answer'))
     expect(finalized).toHaveLength(1)
     expect(JSON.stringify(finalized[0].content).match(/Not verified against a source/g)).toHaveLength(1)
     expect(JSON.stringify(finalized[0].content)).toContain('$42')
     if (!killed) expect((published as ResponseEvent).body).toContain('Not verified against a source')
     expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
     await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT workspace_id,'session_message',id,scope_version::text,'held',1,'Fictional recovery source hold' FROM session_messages WHERE id=$1`,[operations[0].input_message_id])
     const denied=await child({...command,mode:'receive'},directory) as ResponseEvent
     expect(denied.status).toBe(200)
     expect((denied.body as Array<{id:string}>).some(row=>row.id===unrelated.id)).toBe(true)
     expect(messageIds.some(id=>(denied.body as Array<{id:string}>).some(row=>row.id===id))).toBe(false)
     await f.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[device.id])
     const revoked=await child({...command,mode:'receive'},directory) as ResponseEvent
     expect(revoked.status).toBe(401);expect(JSON.stringify(revoked.body)).not.toContain('Fictional durable tool answer')
     expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
    }finally{await f.pool.query(`DROP TABLE IF EXISTS ${counter}`);await f.cleanup()}
   }
  }finally{await rm(directory,{recursive:true,force:true})}
 },180_000)
 it.each(['sweep','claim'] as const)('recovers an actual committed terminal publication after process death through %s and authorized follow-up',async recovery=>{
  const directory=await mkdtemp(join(tmpdir(),'brian-terminal-recovery-')),f=await persistentContextFixture('confidential'),counter=`publication_counter_${randomUUID().replaceAll('-','')}`
  try{
   await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
   await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional terminal recovery browser',userAgent:null,ipAddress:null}))!
   const token=createTokens(f.ownerId,secret,device).accessToken
   const base={workspaceId:f.workspaceId,sessionId:f.session.id,assistantId:f.assistantId,token,secret,counter}
   const killed=await child({...base,mode:'kill_after_commit'},directory,true)
   expect(killed.event).toBe('publication_committed')
   const receipt=(await f.pool.query('SELECT * FROM native_conversation_publications WHERE session_id=$1',[f.session.id])).rows[0]
   expect(receipt.command_format).toBe(2);expect(receipt.stopped).toBe(false);expect(receipt.requested_stopped).toBe(false)
   expect(receipt.completed_at).not.toBeNull();expect(receipt.terminal_descriptor.members).toHaveLength(1);expect(receipt.terminal_outputs).toHaveLength(1)
   expect(receipt.terminal_outputs[0].commandOrdinal).toBe(2)
   expect(receipt.outputs.some((m:{id:string})=>m.id===receipt.terminal_outputs[0].id)).toBe(true)
   const original=(await f.pool.query('SELECT turn_lease_token token,native_session_public_turn_id(workspace_id,id,last_turn_lease_token) id FROM sessions WHERE id=$1',[f.session.id])).rows[0]
   if(recovery==='sweep'){
    const fresh=await child({...base,mode:'recover_sweep'},directory) as ResponseEvent
    expect(fresh.statusBody).toMatchObject({status:'running',turnId:original.id,turnEndReason:null})
    expect(fresh.lifecycle).toEqual([]);expect(fresh.modelCalls).toBe(0);expect(fresh.toolCalls).toBe(0)
    expect((await f.pool.query('SELECT turn_lease_token FROM sessions WHERE id=$1',[f.session.id])).rows[0].turn_lease_token).toBe(original.token)
   }
   await f.pool.query("UPDATE sessions SET turn_heartbeat_at=clock_timestamp()-interval '3 minutes' WHERE id=$1 AND turn_lease_token=$2",[f.session.id,original.token])
   if(recovery==='sweep'){
    const recovered=await child({...base,mode:'recover_sweep'},directory) as ResponseEvent
    expect(recovered.status).toBe(200);expect(recovered.modelCalls).toBe(0);expect(recovered.toolCalls).toBe(0)
    expect(recovered.statusBody).toMatchObject({status:'idle',turnId:original.id,turnEndReason:'publication_recovered'})
    expect(recovered.lifecycle).toContainEqual({kind:'turn_completed',sessionId:f.session.id,payload:{senderUserId:null,turnId:original.id,reason:'publication_recovered'}})
    expect(JSON.stringify(recovered.statusBody)).not.toContain(original.token)
    expect(JSON.stringify(recovered.statusBody)).not.toMatch(/turn_lease_token|last_turn_lease_token|turnLeaseToken|lastTurnLeaseToken/)
   }
   const continued=await child({...base,mode:'follow_up'},directory) as ResponseEvent
   expect(continued.status).toBe(200);expect(continued.body).not.toContain('event: error')
   expect(continued.providerSends).toBe(1);expect(continued.toolCalls).toBe(0);expect(continued.sawPriorReply).toBe(true)
   if(recovery==='claim')expect(continued.lifecycle).toContainEqual({kind:'turn_completed',sessionId:f.session.id,payload:{senderUserId:null,turnId:original.id,reason:'publication_recovered'}})
   expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
   expect((await f.pool.query('SELECT count(*)::int n FROM session_messages WHERE id=$1',[receipt.terminal_outputs[0].id])).rows[0].n).toBe(1)
   const reopened=await child({...base,mode:'receive'},directory) as ResponseEvent
   expect(reopened.status).toBe(200);expect(JSON.stringify(reopened.body)).toContain('Fictional durable tool answer')
   expect(JSON.stringify(reopened.body)).toContain('We previously recorded the fictional effect')
   expect(reopened.modelCalls).toBe(0);expect(reopened.toolCalls).toBe(0)
  }finally{await f.pool.query(`DROP TABLE IF EXISTS ${counter}`);await f.cleanup();await rm(directory,{recursive:true,force:true})}
 },120000)
 it('freshly observes publication committed while recovery waits on its original-token row lock',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'brian-terminal-lock-wait-')),f=await persistentContextFixture('confidential'),counter=`publication_counter_${randomUUID().replaceAll('-','')}`
  let recovering:Promise<ResponseEvent|{event:'publication_committed';pid:number}>|undefined
  try{
   await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
   await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional lock-wait browser',userAgent:null,ipAddress:null}))!
   const token=createTokens(f.ownerId,secret,device).accessToken,base={workspaceId:f.workspaceId,sessionId:f.session.id,assistantId:f.assistantId,token,secret,counter}
   let originalId:string|undefined
   await child({...base,mode:'kill_wait_after_commit'},directory,true,async()=>{
    originalId=(await f.pool.query('SELECT native_session_public_turn_id(workspace_id,id,last_turn_lease_token) id FROM sessions WHERE id=$1',[f.session.id])).rows[0].id
    await f.pool.query("UPDATE sessions SET turn_heartbeat_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[f.session.id])
   },async()=>{
    recovering=child({...base,mode:'recover_sweep'},directory)
    let blocked=false
    for(let i=0;i<200;i++){
     blocked=(await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%native_session_turn_transition%') blocked")).rows[0].blocked
     if(blocked)break
     await new Promise(resolve=>setTimeout(resolve,25))
    }
    expect(blocked).toBe(true)
   })
   const recovered=await recovering! as ResponseEvent
   expect(recovered.statusBody).toMatchObject({status:'idle',turnId:originalId,turnEndReason:'publication_recovered'})
   expect(recovered.lifecycle).toContainEqual({kind:'turn_completed',sessionId:f.session.id,payload:{senderUserId:null,turnId:originalId,reason:'publication_recovered'}})
   expect(recovered.modelCalls).toBe(0);expect(recovered.toolCalls).toBe(0)
   expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
  }finally{if(recovering)await recovering.catch(()=>{});await f.pool.query(`DROP TABLE IF EXISTS ${counter}`);await f.cleanup();await rm(directory,{recursive:true,force:true})}
 },120000)
 it.each([false,true])('fences an explicit-null HTTP Stop against a legacy owner successor: %s',async successor=>{
  const directory=await mkdtemp(join(tmpdir(),'brian-terminal-null-stop-')),f=await persistentContextFixture('confidential'),counter=`publication_counter_${randomUUID().replaceAll('-','')}`
  try{
   await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
   await f.pool.query("UPDATE sessions SET status='running',turn_lease_token=NULL,turn_heartbeat_at=NULL,last_active_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[f.session.id])
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional legacy Stop browser',userAgent:null,ipAddress:null}))!
   const token=createTokens(f.ownerId,secret,device).accessToken,base={workspaceId:f.workspaceId,sessionId:f.session.id,assistantId:f.assistantId,token,secret,counter}
   const observed=await child({...base,mode:'receive'},directory) as ResponseEvent
   expect(observed.statusBody).toMatchObject({status:'running',turnId:null})
   const nextToken=successor?await claimTurnLease(f.session.id,f.assistantId):null
   const stopped=await child({...base,mode:'stop',turnId:null},directory) as ResponseEvent
   expect(stopped.status).toBe(200)
   if(successor){
    expect(stopped.body).toMatchObject({stopped:false,turnId:null,outcome:'superseded'})
    expect((await f.pool.query('SELECT turn_lease_token,cancel_requested_at,status FROM sessions WHERE id=$1',[f.session.id])).rows[0]).toEqual({turn_lease_token:nextToken,cancel_requested_at:null,status:'running'})
    const generic=await child({...base,mode:'stop'},directory) as ResponseEvent
    expect(generic.body).toMatchObject({stopped:true,via:'cancel_requested'})
    expect((await f.pool.query('SELECT cancel_requested_at FROM sessions WHERE id=$1',[f.session.id])).rows[0].cancel_requested_at).not.toBeNull()
   }else{
    expect(stopped.body).toMatchObject({stopped:true,via:'reclaimed',turnId:null,reason:'stopped_by_user'})
    expect((await f.pool.query('SELECT turn_lease_token,status FROM sessions WHERE id=$1',[f.session.id])).rows[0]).toEqual({turn_lease_token:null,status:'idle'})
   }
   expect(stopped.modelCalls).toBe(0);expect(stopped.toolCalls).toBe(0)
  }finally{await f.pool.query(`DROP TABLE IF EXISTS ${counter}`);await f.cleanup();await rm(directory,{recursive:true,force:true})}
 },120000)
 it('gives exact-token Stop priority over an already committed terminal receipt after publisher death',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'brian-terminal-publish-first-stop-')),f=await persistentContextFixture('confidential'),counter=`publication_counter_${randomUUID().replaceAll('-','')}`
  try{
   await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
   await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional publish-first Stop browser',userAgent:null,ipAddress:null}))!
   const token=createTokens(f.ownerId,secret,device).accessToken,base={workspaceId:f.workspaceId,sessionId:f.session.id,assistantId:f.assistantId,token,secret,counter}
   await child({...base,mode:'kill_after_commit'},directory,true)
   const owner=(await f.pool.query('SELECT turn_lease_token token,native_session_public_turn_id(workspace_id,id,last_turn_lease_token) id FROM sessions WHERE id=$1',[f.session.id])).rows[0]
   const receipt=(await f.pool.query('SELECT terminal_descriptor,terminal_outputs FROM native_conversation_publications WHERE session_id=$1',[f.session.id])).rows[0]
   expect(receipt.terminal_descriptor).not.toBeNull();expect(receipt.terminal_outputs).toHaveLength(1)
   const superseded=await child({...base,mode:'stop',turnId:'0'.repeat(64)},directory) as ResponseEvent
   expect(superseded.body).toMatchObject({stopped:false,outcome:'superseded',turnId:'0'.repeat(64)})
   expect((await f.pool.query('SELECT turn_lease_token,cancel_requested_at FROM sessions WHERE id=$1',[f.session.id])).rows[0]).toEqual({turn_lease_token:owner.token,cancel_requested_at:null})
   const stopped=await child({...base,mode:'stop',turnId:owner.id},directory) as ResponseEvent
   expect(stopped.body).toMatchObject({stopped:true,via:'cancel_requested',turnId:owner.id})
   await f.pool.query("UPDATE sessions SET turn_heartbeat_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[f.session.id])
   const recovered=await child({...base,mode:'recover_sweep'},directory) as ResponseEvent
   expect(recovered.statusBody).toMatchObject({status:'idle',turnId:owner.id,turnEndReason:'stopped_by_user'})
   expect(recovered.lifecycle).toContainEqual({kind:'turn_completed',sessionId:f.session.id,payload:{senderUserId:null,turnId:owner.id,reason:'stopped_by_user'}})
   expect(recovered.modelCalls).toBe(0);expect(recovered.toolCalls).toBe(0)
   expect(JSON.stringify(recovered.body)).toContain('Fictional durable tool answer')
   expect(JSON.stringify(recovered.statusBody)).not.toContain(owner.token)
   expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
  }finally{await f.pool.query(`DROP TABLE IF EXISTS ${counter}`);await f.cleanup();await rm(directory,{recursive:true,force:true})}
 },120000)
 it('commits a remote Stop downgrade after binding with a live host signal and never upgrades an exact retry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'brian-terminal-stop-')),f=await persistentContextFixture('confidential'),counter=`publication_counter_${randomUUID().replaceAll('-','')}`
  try{
   await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
   await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional remote Stop browser',userAgent:null,ipAddress:null}))!
   const token=createTokens(f.ownerId,secret,device).accessToken,base={workspaceId:f.workspaceId,sessionId:f.session.id,assistantId:f.assistantId,token,secret,counter}
   let originalToken:string|undefined,originalId:string|undefined
   const published=await child({...base,mode:'stop_before_publication'},directory,false,async()=>{
    const owner=(await f.pool.query('SELECT turn_lease_token token,native_session_public_turn_id(workspace_id,id,last_turn_lease_token) id FROM sessions WHERE id=$1',[f.session.id])).rows[0]
    originalToken=owner.token;originalId=owner.id
    const stopped=await child({...base,mode:'stop',turnId:owner.id},directory) as ResponseEvent
    expect(stopped.status).toBe(200);expect(stopped.body).toMatchObject({stopped:true,via:'cancel_requested',turnId:owner.id})
    expect(JSON.stringify(stopped.body)).not.toContain(owner.token)
   }) as ResponseEvent
   expect(published.status).toBe(200);expect(published.body).not.toContain('event: error')
   expect(published.providerAborted).toBe(false)
   expect((await f.pool.query("SELECT count(*)::int n,sum(input_tokens)::int input,sum(output_tokens)::int output FROM oss_usage_tracking WHERE session_id=$1 AND trigger_key='main_response'",[f.session.id])).rows[0]).toEqual({n:1,input:4,output:4})
   const receipt=(await f.pool.query('SELECT * FROM native_conversation_publications WHERE session_id=$1',[f.session.id])).rows[0]
   expect(receipt.command_format).toBe(2);expect(receipt.requested_stopped).toBe(false);expect(receipt.stopped).toBe(true)
   expect(receipt.terminal_descriptor).toBeNull();expect(receipt.terminal_outputs).toBeNull()
   expect(receipt.outputs.filter((m:{kind:string})=>m.kind==='session_message')).toHaveLength(3)
   expect((await f.pool.query('SELECT status,turn_end_reason FROM sessions WHERE id=$1',[f.session.id])).rows[0]).toEqual({status:'idle',turn_end_reason:'stopped_by_user'})
   const wire=published.submittedPublication!;expect(wire).toBeTruthy()
   const operation=wire[6] as {version:number;stopped:boolean;terminalCandidate:unknown}
   expect(operation.version).toBe(2);expect(operation.stopped).toBe(false);expect(operation.terminalCandidate).not.toBeNull()
   const authority=await f.modelContext(),sources=JSON.parse(wire[4] as string)
   const retry=()=>withSessionMessagePublication(authority,sources,async db=>(await db.query<{value:any}>(
    'SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6,$7) AS value',wire)).rows[0].value,{stoppedTurnToken:originalToken})
   const again=await retry();expect(again.publication).toMatchObject({requestedStopped:false,stopped:true,terminalDescriptor:null,terminalOutputs:null})
   expect((await f.pool.query('SELECT command_digest FROM native_conversation_publications WHERE id=$1',[receipt.id])).rows[0].command_digest).toBe(receipt.command_digest)
   wire[6]={...operation,terminalCandidate:null}
   await expect(retry()).rejects.toMatchObject({code:'scope_source_changed'})
   expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
   const status=await child({...base,mode:'receive'},directory) as ResponseEvent
   expect(status.statusBody).toMatchObject({turnId:originalId,status:'idle',turnEndReason:'stopped_by_user'})
   expect(JSON.stringify(status.body)).toContain('Fictional durable tool answer')
  }finally{await f.pool.query(`DROP TABLE IF EXISTS ${counter}`);await f.cleanup();await rm(directory,{recursive:true,force:true})}
 },120000)

})
