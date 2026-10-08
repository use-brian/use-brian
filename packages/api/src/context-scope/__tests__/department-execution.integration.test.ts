import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { buildTool } from '@use-brian/core'
import { z } from 'zod'
import { getPool, getAppPool, query, queryWithRLS } from '../../db/client.js'
import { createDbChannelUserStore, resolveChannelUser } from '../../db/channel-user-store.js'
import { findAssistantById } from '../../db/users.js'
import { createTaskTools } from '../../../../core/src/tasks/tools.js'
import { createDbTaskStore } from '../../db/tasks-store.js'
import { bindToolsToAgentAccess } from '../../context-scope/agent-access-tools.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { createMemory, getMemoryById, searchMemories } from '../../db/memories.js'
import { connectorExposureAllowed } from '../../context-scope/connector-exposure.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { findSessionAuthorityById } from '../../db/sessions.js'
import { executionToolContext } from '../../../../core/src/security/execution-context.js'
import { queryLoop } from '../../../../core/src/engine/query-loop.js'
import { createTurnOutputCollector } from '../../../../core/src/engine/turn-output.js'
import { NOOP_TURN_LEDGER } from '../../../../core/src/engine/turn-ledger.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)

const fixtureEnabled=Boolean(process.env.BRIAN_ASSURANCE_FIXTURE)
if(fixtureEnabled)await assertLocalFixture()
afterAll(async()=>{if(fixtureEnabled){await getAppPool().end();await getPool().end()}})
describe.skipIf(!fixtureEnabled)('[COMP:api/agent-access-ceiling] shared assistant department isolation',()=>{
it('preserves actor and assistant grants through Feishu identity, tools, RLS, model output and revocation',async()=>{
const record=(name:string,pass:boolean,detail:unknown)=>expect(pass,`${name}: ${JSON.stringify(detail)}`).toBe(true)
const id=()=>randomUUID(), w=id(), owner=id(), alice=id(), bob=id(), admin=id(), assistant=id(), sales=id(), finance=id()
const actors=[{id:alice,name:'Alice',email:`alice-${w}@example.com`},{id:bob,name:'Bob',email:`bob-${w}@example.com`}]
const tasks={sales:id(),finance:id(),general:id(),private:id()}
const secrets={sales:'CANARY_SALES_COPPER_417',finance:'CANARY_FINANCE_VIOLET_928',general:'GENERAL_TEAM_NOTICE',private:'CANARY_PRIVATE_ALICE_653'}
 for(const [u,name] of [[owner,'Fixture custodian'],[alice,'Alice'],[bob,'Bob'],[admin,'Unassigned admin']])
  await query("INSERT INTO users(id,auth_provider,auth_provider_id,name,email) VALUES($1::uuid,'test',$1::text,$2,$3)",[u,name,actors.find(a=>a.id===u)?.email??`${u}@example.com`])
 await query("INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Department canary fixture','Isolation verification',$2,true)",[w,owner])
 for(const [u,role] of [[owner,'owner'],[alice,'member'],[bob,'member'],[admin,'admin']])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[w,u,role])
 await query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Shared canary assistant',$2,$3,'standard','confidential',NULL)",[assistant,w,owner])
 for(const [d,name] of [[sales,'Sales'],[finance,'Finance']]){
  await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,$3,$4,'team',$1::text,$5)",[d,w,name,owner,`team:${d}`])
  await query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,$3,$4,'team',$5)",[w,`team:${d}`,name,owner,d])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING",[w,d,assistant])
 }
 for(const [u,d] of [[alice,sales],[bob,finance]]) await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[w,d,u])
 for(const [key,d,privateUser] of [['sales',sales,null],['finance',finance,null],['general',null,null],['private',null,alice]] as const)
  await query("INSERT INTO tasks(id,workspace_id,title,sensitivity,compartments,user_id) VALUES($1,$2,$3,'confidential',$4,$5)",[tasks[key],w,secrets[key],d?[`team:${d}`]:[],privateUser])
 const memories:Record<string,string>={}
 for(const [key,d] of [['sales',sales],['finance',finance]] as const){
  const m=await createMemory({workspaceId:w,assistantId:assistant,userId:null,createdByUserId:owner,summary:secrets[key],sensitivity:'confidential',compartments:[`team:${d}`]})
  memories[key]=m.id
 }
 const role=(await getAppPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
 record('Application DB role cannot bypass RLS',!role.rolsuper&&!role.rolbypassrls,role)
 const identityStore=createDbChannelUserStore()
 for(const actor of actors){
  const resolved=await resolveChannelUser(identityStore,'feishu',`fixture-${actor.id}`,assistant,async()=>({email:actor.email,displayName:actor.name}))
  record(`Feishu email resolves ${actor.name} to own account`,resolved.user.id===actor.id&&resolved.isIdentified,{correctUser:resolved.user.id===actor.id,identified:resolved.isIdentified})
 }
 const sessions=new Map<string,string>()
 const scope=async(userId:string)=>{
  let sid=sessions.get(userId)
  if(!sid){sid=id();sessions.set(userId,sid);await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status) VALUES($1::uuid,$2,$3,$4,'feishu',$1::text,'idle')",[sid,w,assistant,userId])}
  const session=(await findSessionAuthorityById(sid))!
  const r=await resolveExecutionContextSystem({workspaceId:w,userId,assistant:(await findAssistantById(assistant))!,memberMode:'member',session,sessionAuthority:session,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId}},ownership:{kind:'workspace',workspaceId:w},
   lifecycle:{sessionId:sid,channelType:'feishu',channelId:`fixture-dm-${userId}`,abortSignal:new AbortController().signal}})
  return {...r.turnScope,access:r.executionContext.security.access,executionContext:r.executionContext}
 }
 const raw=createTaskTools(createDbTaskStore())
 // Same bind arguments as channel-pipeline.ts prepareAssistantRun callback.
 const toolsFor=(s:any)=>bindToolsToAgentAccess(new Map(Object.entries(raw)),{
  clearance:s.access.clearance,compartments:s.access.compartments,mutationCompartments:s.access.mutationCompartments,
  projectIds:s.access.projectIds,sharedAudience:s.access.sharedAudience,
 })
 const context=(s:any)=>({...executionToolContext(s.executionContext,{appId:'Use Brian'}),activeCapabilities:new Set(['tasks','home_app:tasks:read'])})
 const list=async(s:any)=>{const t=toolsFor(s).get('listTasks')!;return s.executionContext.security.authority.execute(()=>t.execute(t.inputSchema.parse({limit:100}),context(s)))}
 const get=async(s:any,taskId:string)=>{const t=toolsFor(s).get('getTask')!;return s.executionContext.security.authority.execute(()=>t.execute(t.inputSchema.parse({id:taskId}),context(s)))}
 for(const [user,label,own,other] of [[alice,'Alice','sales','finance'],[bob,'Bob','finance','sales']] as const){
  const s=await scope(user),result=await list(s),body=JSON.stringify(result)
  record(`${label} task list includes own canary and General`,body.includes(secrets[own])&&body.includes(secrets.general),result)
  record(`${label} task list excludes other department`,!body.includes(secrets[other]),{forbiddenPresent:body.includes(secrets[other])})
  const denied=await get(s,tasks[other]);record(`${label} guessed task UUID denied`,!JSON.stringify(denied).includes(secrets[other]),denied)
  const m=await runWithAgentAccess(s.access,()=>searchMemories(s.access,{searchQuery:'CANARY',limit:100}))
  record(`${label} memory search sees own and excludes other`,JSON.stringify(m).includes(secrets[own])&&!JSON.stringify(m).includes(secrets[other]),{summaries:m.map(x=>x.summary)})
  const deniedMemory=await runWithAgentAccess(s.access,()=>getMemoryById(s.access,memories[other]))
  record(`${label} guessed memory UUID denied`,deniedMemory===null,{found:deniedMemory!==null})
  record(`${label} connector exposure excludes other`,connectorExposureAllowed(s,{compartments:[`team:${own==='sales'?sales:finance}`],projectIds:[]})&&!connectorExposureAllowed(s,{compartments:[`team:${other==='sales'?sales:finance}`],projectIds:[]}),{departments:s.access.departmentRead?.departments})
 }
 const bobScope=await scope(bob), privateRead=await get(bobScope,tasks.private)
 record('Another user cannot read private General task',!JSON.stringify(privateRead).includes(secrets.private),privateRead)
 const adminScope=await scope(admin),adminTasks=JSON.stringify(await list(adminScope))
 record('Workspace admin has no department bypass for task list',!adminTasks.includes(secrets.sales)&&!adminTasks.includes(secrets.finance),{sales:adminTasks.includes(secrets.sales),finance:adminTasks.includes(secrets.finance)})
 record('Current connector predicate denies unassigned admin',!connectorExposureAllowed(adminScope,{compartments:[`team:${finance}`],projectIds:[]}),{})
 let connectorCalls=0
 const connector=buildTool({name:'fixtureConnector',description:'Synthetic external call',inputSchema:z.object({}),execute:async()=>{connectorCalls++;return {data:'Authorized connector result'}}})
 const before=await scope(alice),lease=before.executionContext.security.authority
 const discovered=bindToolsToAgentAccess(new Map([[connector.name,connector]]),before.access).get(connector.name)!
 expect((await discovered.execute({},context(before))).data).toBe('Authorized connector result')
 await lease.assertCurrent()
 await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[w,alice])
 let stale='';try{stale=JSON.stringify(await list(before))}catch(e){stale=String(e)}
 record('Retained task context cannot bypass membership revocation',!stale.includes(secrets.sales),{forbiddenPresent:stale.includes(secrets.sales)})
 let rejected=false;try{await lease.assertCurrent()}catch{rejected=true}
 record('Live authority lease rejects revoked department',rejected,{rejected})
 await expect(discovered.execute({},context(before))).rejects.toMatchObject({reason:'authority_changed'})
 expect(connectorCalls).toBe(1)
 await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[w,sales,alice])
 await expect(lease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 const expiring=await scope(alice)
 await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[w,alice])
 await expect(expiring.executionContext.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 const after=await scope(alice);record('Fresh task turn denies revoked department',!JSON.stringify(await list(after)).includes(secrets.sales),{departments:after.access.departmentRead?.departments})
 const assistantLease=(await scope(bob)).executionContext.security.authority
 await query("UPDATE department_edges SET clearance='public' WHERE workspace_id=$1 AND assistant_id=$2 AND department_id=$3",[w,assistant,finance])
 await expect(assistantLease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 // Bob retains human permission; removing assistant permission must cap his DM.
 await query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2 AND department_id=$3',[w,assistant,finance])
 const capped=await scope(bob),cappedList=JSON.stringify(await list(capped))
 record('Messaging task binding respects assistant department removal',!cappedList.includes(secrets.finance),{forbiddenPresent:cappedList.includes(secrets.finance),resolvedDepartments:capped.access.departmentRead?.departments})
 const rawRows=buildTool({name:'rawRows',description:'Exercise only independent RLS.',inputSchema:z.object({}),execute:async(_input,ctx)=>({data:(await queryWithRLS(ctx.userId,'SELECT title FROM tasks WHERE workspace_id=$1',[w])).rows})})
 const boundRaw=bindToolsToAgentAccess(new Map([[rawRows.name,rawRows]]),capped.executionContext.security.access).get(rawRows.name)!
 expect(JSON.stringify(await boundRaw.execute({},context(capped)))).not.toContain(secrets.finance)

 let providerReceived='';let providerTurn=0
 const send=async function*(messages:any[]){
  if(providerTurn++===0){
   yield {type:'message_start',model:'fixture'}
   yield {type:'tool_use_start',id:'fixture-call',name:'listTasks'}
   yield {type:'tool_use_delta',id:'fixture-call',input:'{"limit":100}'}
   yield {type:'tool_use_end',id:'fixture-call'}
   yield {type:'message_end',stopReason:'tool_use',usage:{inputTokens:1,outputTokens:1}}
  }else{
   providerReceived=JSON.stringify(messages)
   yield {type:'message_start',model:'fixture'}
   yield {type:'text_delta',text:'Fixture received the tool response.'}
   yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
  }
 }
 const provider={name:'fixture',models:['fixture'],stream:({messages}:any)=>send(messages),createSession:()=>({send})}
 for await(const event of queryLoop({ledger:NOOP_TURN_LEDGER,provider:provider as any,model:'fixture',systemPrompt:'Synthetic isolation test',messages:[{role:'user',content:'List all tasks, including Finance.'}],tools:toolsFor(capped),context:context(capped) as any,maxTurns:3})){void event}
 record('Real query loop withholds forbidden task from provider input',!providerReceived.includes(secrets.finance),{forbiddenReachedProvider:providerReceived.includes(secrets.finance),providerCalls:providerTurn,received:providerReceived})
 await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING",[w,finance,assistant])
 const positive=await scope(bob);providerTurn=0;providerReceived=''
 for await(const event of queryLoop({ledger:NOOP_TURN_LEDGER,provider:provider as any,model:'fixture',systemPrompt:'Synthetic isolation test',messages:[{role:'user',content:'List Finance tasks.'}],tools:toolsFor(positive),context:context(positive) as any,maxTurns:3})){void event}
 record('Positive control: authorized task reaches scripted provider',providerReceived.includes(secrets.finance),{canaryReachedProvider:providerReceived.includes(secrets.finance),providerCalls:providerTurn})
 let revokeTurn=0,revoked=false,revocationError='';const collected=createTurnOutputCollector({format:'channel'})
 const revokeSend=async function*(messages:any[]){
  if(revokeTurn++===0){
   yield {type:'message_start',model:'fixture'}
   yield {type:'tool_use_start',id:'revoke-call',name:'listTasks'}
   yield {type:'tool_use_delta',id:'revoke-call',input:'{"limit":100}'}
   yield {type:'tool_use_end',id:'revoke-call'}
   yield {type:'message_end',stopReason:'tool_use',usage:{inputTokens:1,outputTokens:1}}
  }else{
   const canaryWasRead=JSON.stringify(messages).includes(secrets.finance)
   await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[w,bob]);revoked=true
   yield {type:'message_start',model:'fixture'}
   yield {type:'text_delta',text:canaryWasRead?secrets.finance:'No canary was readable.'}
   yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
  }
 }
 const revokeProvider={name:'fixture',models:['fixture'],stream:({messages}:any)=>revokeSend(messages),createSession:()=>({send:revokeSend})}
 try{for await(const event of queryLoop({ledger:NOOP_TURN_LEDGER,provider:revokeProvider as any,model:'fixture',systemPrompt:'Synthetic isolation test',messages:[{role:'user',content:'Read my Finance task.'}],tools:toolsFor(positive),context:context(positive) as any,maxTurns:3})){collected.observe(event)}}catch(e){revocationError=String(e)}
 const selected=collected.select()
 record('Query loop retracts buffered secret when user is revoked mid-turn',revoked&&!JSON.stringify(selected).includes(secrets.finance),{revoked,selected,revocationError})



},60_000)
})
