import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {getPool,getAppPool} from '../client.js'
import {ensureOfficeArtifactSessionSystem,findOfficeArtifactForSessionSystem} from '../office-artifact-sessions.js'
import {createMemory,getMemoryById} from '../memories.js'
import {gateSessionRead} from '../../session-read-authority.js'
import {samplePlaybookEvidence} from '../playbook-store.js'
import {selectCandidateSessions} from '../../workers/skill-review-worker.js'
import {liveWorkRoutes} from '../../routes/live-work.js'
import {sessionRoutes} from '../../routes/sessions.js'
import {officeLaneExecutionBounds,type OfficeLane} from '../../routes/office-chat-lane.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import type {ResolvedTurnScope} from '../../context-scope/resolve-turn-scope.js'
import type {ResolvedOfficeAccess} from '../../office/access.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})

async function fixture() {
  const owner=randomUUID(),member=randomUUID(),denied=randomUUID(),workspace=randomUUID(),assistant=randomUUID(),artifact=randomUUID()
  for(const id of [owner,member,denied])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Office chat fixture',$2,false)",[workspace,owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential'),($1,$4,'member','confidential')`,[workspace,owner,member,denied])
  await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1",[workspace])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Workspace assistant','primary','confidential')",[assistant,workspace])
  await pool.query(`INSERT INTO office_artifacts(id,workspace_id,family,mode,title,creator_user_id,owner_user_id,capability_version,sensitivity,default_workspace_role)
    VALUES($1,$2,'document','artifact','Board memo',$3,$3,1,'internal','comment')`,[artifact,workspace,owner])
  // A deny grant removes one member from the file's audience.
  await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'deny')",[artifact,workspace,denied])
  return {owner,member,denied,workspace,assistant,artifact}
}

async function say(sessionId:string,userId:string,text:string) {
  await pool.query(`INSERT INTO session_messages(session_id,role,content,sequence_num,sender_user_id)
    VALUES($1,'user',$2::jsonb,(SELECT COALESCE(max(sequence_num),0)+1 FROM session_messages WHERE session_id=$1),$3)`,[sessionId,JSON.stringify(text),userId])
  await pool.query('UPDATE sessions SET last_active_at=now() WHERE id=$1',[sessionId])
}

function app(userId:string,router:express.Router,mount='/api') {
  const server=express()
  server.use((req,_res,next)=>{(req as {userId?:string}).userId=userId;next()})
  server.use(mount,router)
  return server
}

describe('[COMP:api/office-chat-session] one shared conversation per file',()=>{
  it('converges concurrent first sends on one office_thread session and links it to the file',async()=>{
    const f=await fixture()
    const [a,b]=await Promise.all([
      ensureOfficeArtifactSessionSystem({artifactId:f.artifact,assistantId:f.assistant,userId:f.owner}),
      ensureOfficeArtifactSessionSystem({artifactId:f.artifact,assistantId:f.assistant,userId:f.member}),
    ])
    expect(a.sessionId).toBe(b.sessionId)
    expect((await pool.query('SELECT channel_type,visibility,effective_clearance,workspace_id FROM sessions WHERE id=$1',[a.sessionId])).rows[0])
      .toEqual({channel_type:'office_thread',visibility:'workspace',effective_clearance:'internal',workspace_id:f.workspace})
    expect((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE workspace_id=$1 AND channel_type='office_thread'",[f.workspace])).rows[0].n).toBe(1)
    expect(await findOfficeArtifactForSessionSystem(a.sessionId)).toEqual({artifactId:f.artifact,workspaceId:f.workspace,sessionId:a.sessionId})
  })

  it('its trigger refuses to link anything but an office_thread session',async()=>{
    const f=await fixture()
    const web=(await pool.query("INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,workspace_id) VALUES($1,$2,'web',gen_random_uuid()::text,$3) RETURNING id",[f.assistant,f.owner,f.workspace])).rows[0].id
    await expect(pool.query('INSERT INTO office_artifact_sessions(artifact_id,session_id,workspace_id) VALUES($1,$2,$3)',[f.artifact,web,f.workspace])).rejects.toMatchObject({code:'23514'})
  })

  it('is read by exactly the file audience: the Office predicate decides, not workspace membership',async()=>{
    const f=await fixture()
    const link=await ensureOfficeArtifactSessionSystem({artifactId:f.artifact,assistantId:f.assistant,userId:f.owner})
    const session=(await pool.query(`SELECT id,channel_type AS "channelType",user_id AS "userId",assistant_id AS "assistantId",visibility,mode,effective_clearance AS "effectiveClearance" FROM sessions WHERE id=$1`,[link.sessionId])).rows[0]
    expect(await gateSessionRead(f.owner,session)).toBeNull()
    expect(await gateSessionRead(f.member,session)).toBeNull()
    expect(await gateSessionRead(f.denied,session)).toEqual({status:404,error:'Session not found'})
  })

  it('removes the conversation with the link, and with the file on purge',async()=>{
    const f=await fixture()
    const link=await ensureOfficeArtifactSessionSystem({artifactId:f.artifact,assistantId:f.assistant,userId:f.owner})
    await say(link.sessionId,f.owner,'Shorten the summary')
    await pool.query("UPDATE office_artifacts SET lifecycle_state='purged' WHERE id=$1",[f.artifact])
    expect((await pool.query('SELECT 1 FROM office_artifact_sessions WHERE artifact_id=$1',[f.artifact])).rows).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM sessions WHERE id=$1',[link.sessionId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM session_messages WHERE session_id=$1',[link.sessionId])).rows).toHaveLength(0)
  })
})

function wideScope(f:{owner:string;workspace:string;assistant:string}):ResolvedTurnScope {
  return {
    access:{workspaceId:f.workspace,userId:f.owner,assistantId:f.assistant,assistantKind:'primary',clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null},
    activeGroupId:null,activeProjectId:null,effectiveCompartments:[],effectiveProjectIds:[],writeCompartments:[],writeProjectIds:[],activeTeam:null,activeProject:null,
  }
}

describe('[COMP:api/office-chat-lane] a lane read never exceeds the file',()=>{
  it('cannot return a brain row above the file sensitivity or outside its compartments that the sender could read',async()=>{
    const f=await fixture()
    const make=(summary:string,sensitivity:'internal'|'confidential',compartments:string[]=[])=>createMemory({assistantId:f.assistant,userId:f.owner,workspaceId:f.workspace,summary,sensitivity,compartments,createdByUserId:f.owner})
    const plain=await make('Plain internal fact','internal')
    const secret=await make('Confidential fact','confidential')
    const finance=await make('Finance-only fact','internal',['finance'])
    const lane:OfficeLane={artifact:{id:f.artifact,workspaceId:f.workspace,family:'document',title:'Board memo',headVersion:0,lifecycleState:'active',sensitivity:'internal',compartments:[],projectIds:[]},
      access:{canComment:true,canEdit:true} as ResolvedOfficeAccess,job:null,selection:[]}
    const resolve=(bounded:boolean)=>resolveExecutionContextSystem({
      userId:f.owner,
      assistant:{id:f.assistant,workspaceId:f.workspace,kind:'primary',clearance:'confidential',compartments:[]},
      identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.owner}},
      ownership:{kind:'workspace',workspaceId:f.workspace},
      lifecycle:{abortSignal:new AbortController().signal,sessionId:randomUUID(),channelType:'office_thread',channelId:'c'},
      ...(bounded?officeLaneExecutionBounds(lane,f.owner,{resolveAccess:async()=>lane.access}):{}),
    },{resolveScope:async()=>wideScope(f),createLease:()=>({markOperationMayHaveExecuted(){},async assertCurrent(){},async execute<T>(op:()=>Promise<T>){return op()}})})
    const sender=(await resolve(false)).executionContext.security.access
    const inLane=(await resolve(true)).executionContext.security.access
    for(const memory of [plain,secret,finance])expect(await getMemoryById(sender,memory.id)).not.toBeNull()
    expect(await getMemoryById(inLane,plain.id)).not.toBeNull()
    expect(await getMemoryById(inLane,secret.id)).toBeNull()
    expect(await getMemoryById(inLane,finance.id)).toBeNull()
  })
})

describe('[COMP:api/office-chat-session] the thread is never listed outside the file (D4)',()=>{
  it('is absent from the Chat list, the Live roster, playbook evidence and skill review, where a web chat is present',async()=>{
    const f=await fixture()
    const link=await ensureOfficeArtifactSessionSystem({artifactId:f.artifact,assistantId:f.assistant,userId:f.owner})
    const web=(await pool.query("INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,workspace_id,app_origin) VALUES($1,$2,'web',gen_random_uuid()::text,$3,'chat') RETURNING id",[f.assistant,f.owner,f.workspace])).rows[0].id
    for(const session of [link.sessionId,web]){
      await say(session,f.owner,'Please tighten the opening')
      await pool.query("INSERT INTO session_messages(session_id,role,content,sequence_num) VALUES($1,'assistant','\"Done\"'::jsonb,99)",[session])
    }
    const ids=(rows:Array<{id?:string;sessionId?:string}>)=>rows.map(row=>row.id??row.sessionId)

    const list=await request(app(f.owner,sessionRoutes(),'/api/sessions')).get(`/api/sessions?workspaceId=${f.workspace}&scope=workspace&channels=all`)
    expect(list.status).toBe(200)
    const listed=ids((list.body.sessions??list.body) as Array<{id:string}>)
    expect(listed).toContain(web)
    expect(listed).not.toContain(link.sessionId)

    const live=await request(app(f.owner,liveWorkRoutes())).get(`/api/workspaces/${f.workspace}/live`)
    expect(live.status).toBe(200)
    const roster=(live.body.items as Array<{id:string;sessionId?:string}>).map(item=>item.sessionId??item.id)
    expect(roster).toContain(web)
    expect(roster).not.toContain(link.sessionId)

    const evidence=(await samplePlaybookEvidence(f.assistant,7,100)).map(row=>row.sessionId)
    expect(evidence).toContain(web)
    expect(evidence).not.toContain(link.sessionId)

    const candidates=(await selectCandidateSessions(1,24)).map(row=>row.sessionId)
    expect(candidates).toContain(web)
    expect(candidates).not.toContain(link.sessionId)
  })
})
