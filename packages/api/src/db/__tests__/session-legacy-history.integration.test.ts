import {randomUUID} from 'node:crypto'
import type {LLMProvider,Message,StreamChunk} from '@use-brian/core'
import {chatRoutes} from '../../routes/chat.js'
import {createDbMemoryStore} from '../memory-store.js'
import {createDbCapabilityStore} from '../capability-store.js'
import {createPendingApprovalsStore} from '../pending-approvals-store.js'
import {readFile,writeFile} from 'node:fs/promises'
import {afterAll,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {getAppPool,getPool,applyRLSGucs} from '../client.js'
import {authSessionStore} from '../auth-session-store.js'
import {createPersonalWebSession} from '../sessions.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {sessionRoutes} from '../../routes/sessions.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const secret='fictional-private-history-test-secret'
type Seed={workspaceId:string;ownerId:string;firstId:string;assistantId:string;deviceId:string;version:number;sessions:Record<string,string>}
const prepare=process.env.BRIAN_PRIVATE_HISTORY_PREPARE==='1'
const seedFile=process.env.BRIAN_PRIVATE_HISTORY_SEED!
if(seedFile)await assertLocalFixture()
describe.skipIf(!seedFile).sequential('[COMP:api/session-legacy-history] real frozen migration and native owner reads',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 if(prepare){
  it('seeds pre-migration private conversations and excluded shapes',async()=>{
   const f=await persistentContextFixture()
   const auth=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional history device',userAgent:null,ipAddress:null}))!
   const sessions:Record<string,string>={}
   for(const kind of ['normal','held','changed','provider','shared','anchor','late','binding','scoped','derivation','dock']){
    const s=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
     channelType:'web',channelId:randomUUID(),appOrigin:'chat',contextGroupId:null,contextProjectId:null},
    {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
    sessions[kind]=s.id
    for(const [sequence,role,content] of [[1,'user',[{type:'text',text:'Fictional saved question'}]],
     [2,'assistant',[{type:'text',text:'Fictional saved answer'}]],
     [3,'assistant',[{type:'text',text:'Hidden planning'},{type:'tool_use',name:'fictionalTool',input:{}}]],
     [4,'user',[{type:'text',text:'Fictional next question'}]]] as const){
     if((kind==='scoped'&&sequence===4)||(kind==='derivation'&&sequence===2)||(kind==='held'&&sequence===1)){
      await f.pool.query(`INSERT INTO session_messages(session_id,sequence_num,role,content,workspace_id,user_id,sensitivity,compartments,project_ids,scope_version,scope_held)
       VALUES($1,$2,$3,$4,$5,$6,'confidential','{}','{}',1,false)`,[s.id,sequence,role,JSON.stringify(content),f.workspaceId,f.ownerId])
     }else await f.pool.query('INSERT INTO session_messages(session_id,sequence_num,role,content) VALUES($1,$2,$3,$4)',[s.id,sequence,role,JSON.stringify(content)])
    }
    await f.pool.query("UPDATE sessions SET workspace_id=NULL,context_binding_origin='legacy' WHERE id=$1",[s.id])
   }
   await f.pool.query("UPDATE sessions SET channel_type='slack' WHERE id=$1",[sessions.provider])
   await f.pool.query("UPDATE sessions SET visibility='workspace' WHERE id=$1",[sessions.shared])
   await f.pool.query("UPDATE sessions SET anchor_kind='office_file' WHERE id=$1",[sessions.anchor])
   await f.pool.query("UPDATE sessions SET app_origin='doc' WHERE id=$1",[sessions.dock])
   const seed:Seed={workspaceId:f.workspaceId,ownerId:f.ownerId,firstId:f.firstId,assistantId:f.assistantId,deviceId:auth.id,version:auth.authVersion,sessions}
   await writeFile(seedFile,JSON.stringify(seed),{mode:0o600})
  })
 }else{
  let seed:Seed,token:string,app:express.Express
  const url=(id:string,extra='')=>`/sessions/${id}/legacy-history?workspaceId=${seed.workspaceId}${extra}`
  it('opens unchanged private text as ordinary same-session history',async()=>{
   seed=JSON.parse(await readFile(seedFile,'utf8'))
   token=createTokens(seed.ownerId,secret,{id:seed.deviceId,authVersion:seed.version}).accessToken
   app=express();app.use('/sessions',requireAuth(secret),sessionRoutes())
   const before=(await getPool().query('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1 ORDER BY sequence_num',[seed.sessions.normal])).rows
   const response=await request(app).get(url(seed.sessions.normal,'&limit=2')).set('Authorization','Bearer '+token).expect(200)
   expect(response.body.rows.map((r:{text:string})=>r.text)).toEqual(['Fictional saved question','Fictional saved answer'])
   expect(response.body.nextSequence).toBe(2)
   const next=await request(app).get(url(seed.sessions.normal,'&afterSequence=2&limit=2')).set('Authorization','Bearer '+token).expect(200)
   expect(next.body.rows.map((r:{text:string})=>r.text)).toEqual(['Fictional next question'])
   expect(next.body.nextSequence).toBeNull()
   expect(JSON.stringify(next.body)).not.toContain('Hidden planning')
   const ordinary=await request(app).get(`/sessions/${seed.sessions.normal}/messages`).set('Authorization','Bearer '+token).expect(200)
   expect(JSON.stringify(ordinary.body)).toContain('Fictional saved answer')
   expect(JSON.stringify(ordinary.body)).not.toContain('Hidden planning')
   expect((await getPool().query('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1 ORDER BY sequence_num',[seed.sessions.normal])).rows).toEqual(before)
   await request(app).get(url(seed.sessions.dock)).set('Authorization','Bearer '+token).expect(200)
  })
  it('continues a migrated conversation through the ordinary provider and preserves the same session',async()=>{
   await getPool().query("UPDATE workspaces SET plan='pro' WHERE id=$1",[seed.workspaceId])
   const original=(await getPool().query('SELECT id,content,scope_version,workspace_id FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[seed.sessions.normal])).rows
   const calls:Message[][]=[]
   const chunks=(text:string):StreamChunk[]=>[{type:'message_start',model:'fixture'},{type:'text_delta',text},
    {type:'message_end',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5}}]
   const provider:LLMProvider={name:'fictional-legacy-continuation',models:['fixture'],
    stream:async function*(){yield* chunks('Fictional discussion')},
    createSession(){return{send(messages){calls.push(structuredClone(messages));return(async function*(){yield* chunks('Continuing our earlier discussion.')})()}}}}
   const continuation=express();continuation.use(express.json())
   continuation.use('/chat',requireAuth(secret),chatRoutes({provider,systemPrompt:'Continue the fictional conversation.',tools:new Map(),
    memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
   const response=await request(continuation).post('/chat').set('Authorization','Bearer '+token).send({sessionId:seed.sessions.normal,
    assistantId:seed.assistantId,workspaceId:seed.workspaceId,message:'What did we discuss earlier?',mode:'default',model:'pro'})
   expect(response.status,response.text).toBe(200)
   expect(response.text).not.toContain('event: error')
   expect(calls.length,response.text).toBeGreaterThan(0)
   expect(JSON.stringify(calls[0])).toContain('Fictional saved answer')
   expect(JSON.stringify(calls[0])).not.toContain('Hidden planning')
   const reopened=await request(app).get(`/sessions/${seed.sessions.normal}/messages`).set('Authorization','Bearer '+token).expect(200)
   expect(JSON.stringify(reopened.body)).toContain('Fictional saved answer')
   expect(JSON.stringify(reopened.body)).toContain('Continuing our earlier discussion.')
   expect((await getPool().query('SELECT id,content,scope_version,workspace_id FROM session_messages WHERE id=ANY($1::uuid[]) ORDER BY sequence_num',[original.map(row=>row.id)])).rows).toEqual(original)
   expect((await getPool().query('SELECT workspace_id FROM sessions WHERE id=$1',[seed.sessions.normal])).rows[0].workspace_id).toBe(seed.workspaceId)
   await expect(getPool().query("UPDATE session_legacy_history SET binding='[]' WHERE session_id=$1",[seed.sessions.normal])).rejects.toMatchObject({code:'42501'})
   await expect(getPool().query('UPDATE session_legacy_history_messages SET sequence_num=sequence_num WHERE session_id=$1',[seed.sessions.normal])).rejects.toMatchObject({code:'42501'})
  },120_000)
  it('denies other members, foreign workspaces, non-native devices and owner-pool calls',async()=>{
   await getPool().query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.workspaceId,seed.firstId])
   const auth=(await authSessionStore.create(seed.firstId,{deviceLabel:'Fictional other device',userAgent:null,ipAddress:null}))!
   const other=createTokens(seed.firstId,secret,auth).accessToken
   await request(app).get(url(seed.sessions.normal)).set('Authorization','Bearer '+other).expect(404)
   await request(app).get(`/sessions/${seed.sessions.normal}/legacy-history?workspaceId=${randomUUID()}`).set('Authorization','Bearer '+token).expect(404)
   await request(app).get(url(seed.sessions.normal)).expect(401)
   await expect(getPool().query('SELECT read_private_legacy_history($1,$2,$3,$4,0,50)',[seed.workspaceId,seed.sessions.normal,seed.deviceId,seed.version])).rejects.toMatchObject({code:'42501'})
   await expect(getPool().query('SELECT resume_private_legacy_session($1,$2,$3,$4)',[seed.workspaceId,seed.sessions.normal,seed.deviceId,seed.version])).rejects.toMatchObject({code:'42501'})
   const client=await getAppPool().connect()
   try{await client.query('BEGIN');await applyRLSGucs(client,seed.ownerId)
    await client.query("SELECT set_config('app.application_id',$1,true)",[randomUUID()])
    await expect(client.query('SELECT read_private_legacy_history($1,$2,$3,$4,0,50)',[seed.workspaceId,seed.sessions.normal,seed.deviceId,seed.version])).rejects.toMatchObject({code:'42501'})
   }finally{await client.query('ROLLBACK');client.release()}
   await expect(getAppPool().query('SELECT * FROM session_legacy_history')).rejects.toMatchObject({code:'42501'})
  })
  it('excludes shared/provider/anchored sessions and changed bindings',async()=>{
   await getPool().query("UPDATE sessions SET channel_id='fictional-changed' WHERE id=$1",[seed.sessions.binding])
   for(const kind of ['provider','shared','anchor','binding'])await request(app).get(url(seed.sessions[kind])).set('Authorization','Bearer '+token).expect(404)
  })
  it('withholds edited and explicitly held rows, and never includes later writes',async()=>{
   await getPool().query("UPDATE session_messages SET content='\"Changed private bytes\"'::jsonb WHERE session_id=$1 AND sequence_num=1",[seed.sessions.changed])
   await getPool().query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    SELECT $2,'session_message',id,'1','held',1,'Fictional current restriction' FROM session_messages WHERE session_id=$1 AND sequence_num=1`,[seed.sessions.held,seed.workspaceId])
   for(const kind of ['changed','held']){
    const response=await request(app).get(url(seed.sessions[kind])).set('Authorization','Bearer '+token).expect(200)
    expect(response.body.rows[0]).toMatchObject({available:false,text:null})
   }
   await getPool().query("INSERT INTO session_messages(session_id,sequence_num,role,content) VALUES($1,5,'assistant','\"Later private bytes\"')",[seed.sessions.late])
   const response=await request(app).get(url(seed.sessions.late)).set('Authorization','Bearer '+token).expect(200)
   expect(response.body.rows).toHaveLength(3)
   expect(JSON.stringify(response.body)).not.toContain('Later private bytes')
  })
  it('keeps the frozen pagination order when a current sequence changes',async()=>{
   await getPool().query('UPDATE session_messages SET sequence_num=100 WHERE session_id=$1 AND sequence_num=2',[seed.sessions.changed])
   const first=await request(app).get(url(seed.sessions.changed,'&limit=2')).set('Authorization','Bearer '+token).expect(200)
   expect(first.body.nextSequence).toBe(2)
   expect(first.body.rows[1]).toMatchObject({sequence:2,available:false,text:null})
   const second=await request(app).get(url(seed.sessions.changed,'&afterSequence=2&limit=2')).set('Authorization','Bearer '+token).expect(200)
   expect(second.body.rows.map((row:{sequence:number})=>row.sequence)).toEqual([4])
  })
  it('checks a modern row envelope without rewriting it as legacy',async()=>{
   const response=await request(app).get(url(seed.sessions.scoped)).set('Authorization','Bearer '+token).expect(200)
   expect(response.body.rows[2]).toMatchObject({available:true,text:'Fictional next question'})
  })
  it('retains owner-readable historical text without promoting its recorded derivation to current evidence',async()=>{
   await getPool().query(`INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,
    assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
    SELECT $2,'session_message',id,'1','fixture:recorded-source',$3,NULL,'confidential','{}','{}',1
    FROM session_messages WHERE session_id=$1 AND sequence_num=2`,[seed.sessions.derivation,seed.workspaceId,seed.ownerId])
   const response=await request(app).get(url(seed.sessions.derivation)).set('Authorization','Bearer '+token).expect(200)
   expect(response.body.rows[1]).toMatchObject({available:true,text:'Fictional saved answer'})
   expect(response.body.rows[0]).toMatchObject({available:true,text:'Fictional saved question'})
  })
  it('rechecks live membership for a previously readable private transcript',async()=>{
   await getPool().query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[seed.workspaceId,seed.ownerId])
   try{await request(app).get(url(seed.sessions.normal)).set('Authorization','Bearer '+token).expect(404)}
   finally{await getPool().query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[seed.workspaceId,seed.ownerId])}
  })
  it('rejects current privacy holds, revoked devices and changed ownership',async()=>{
   await getPool().query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[seed.sessions.held])
   await request(app).get(url(seed.sessions.held)).set('Authorization','Bearer '+token).expect(404)
   await getPool().query('UPDATE sessions SET user_id=$2 WHERE id=$1',[seed.sessions.binding,seed.firstId])
   await request(app).get(url(seed.sessions.binding)).set('Authorization','Bearer '+token).expect(404)
   await authSessionStore.revokeForUser(seed.ownerId,seed.deviceId)
   await request(app).get(url(seed.sessions.normal)).set('Authorization','Bearer '+token).expect(401)
  })
 }
})
