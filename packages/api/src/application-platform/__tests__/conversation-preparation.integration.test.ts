/** Joint native preparation acquisition: exact equivalence with independent
 * captures, fresh refusal and counted work. [COMP:api/native-turn-frame] */
import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import pg,{type PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery,publishNativeSessionMessage} from '../../db/conversation-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession,readSessionById,type Session} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {classifySession,policyFor} from '../../session-kind.js'
import {readConversationEvidence,readConversationPreparation} from '../conversation-evidence.js'
import {sessionAuthorityFactsParameters,type SessionAuthorityFactsInput} from '../../context-scope/session-authority-facts.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
type Root={kind:string;id:string;version:string}
type Scenario={label:string;session:Session;execution:ExecutionContext;plain:Root[];query:ScopeSource[];empty:ScopeSource[];authority:SessionAuthorityFactsInput}
const port=`preparation_fixture_${randomUUID().replaceAll('-','')}`
let f:Awaited<ReturnType<typeof persistentContextFixture>>
const scenarios:Record<'shared'|'private',Scenario>={} as never
const measurements:unknown[]=[]
const identity=(source:ScopeSource):Root=>({kind:source.resourceKind,id:source.resourceId,version:source.version})
const sorted=(values:Json[])=>values.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
// Membership order is the recursive closure's emission order in both owners; the
// accepted cohort contract (publication cohorts) is set equality.
const normalize=(value:unknown):unknown=>value&&typeof value==='object'&&!Array.isArray(value)&&'admitted'in value&&(value as Json).admitted===true
 ?{...(value as Json),immutable:sorted((value as Json).immutable),current:sorted((value as Json).current)}:value

async function operation(client:Pick<PoolClient,'query'>,action:string,payload:unknown={}):Promise<Json>{
 return(await client.query(`SELECT ${port}($1,$2,$3) value`,[f.workspaceId,action,JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(execution:ExecutionContext,run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(execution.security.access,async()=>{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await applyRLSGucs(client,execution.security.access.userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
  return run(client)
 })}finally{await rollbackAndRelease(client)}
}
/** Statement result or its error class, without aborting the frame. */
async function attempt(client:PoolClient,sql:string,values:unknown[]):Promise<{value?:unknown;error?:{code:string;message:string}}>{
 await client.query('SAVEPOINT preparation_attempt')
 try{const value=(await client.query(sql,values)).rows[0]?.value;await client.query('RELEASE SAVEPOINT preparation_attempt');return{value}}
 catch(error){await client.query('ROLLBACK TO SAVEPOINT preparation_attempt');const e=error as {code:string;message:string};return{error:{code:e.code,message:e.message}}}
}
/** The old readers, one statement per cohort, versus one joint statement. */
async function equivalent(client:PoolClient,cohorts:Root[][]){
 const separate=[]
 for(const roots of cohorts)separate.push(await attempt(client,'SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify(roots)]))
 const joint=await attempt(client,'SELECT capture_conversation_preparation($1,$2) value',[f.workspaceId,JSON.stringify(cohorts)])
 const raised=separate.find(entry=>entry.error)
 if(raised){expect(joint.error?.code).toBe(raised.error!.code);return{separate,joint}}
 expect(joint.error).toBeUndefined()
 expect(((joint.value as Json).cohorts as unknown[]).map(normalize)).toEqual(separate.map(entry=>normalize(entry.value)))
 return{separate,joint}
}
const fields=(sources:ScopeSource[])=>sources.filter(source=>source.resourceKind==='application_field')

/** The disposable bootstrap observer has no product authority. */
async function observer(sql:string):Promise<pg.QueryResult|undefined>{
 const marker=JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!,'utf8')) as {bootstrapRole?:string}
 if(!marker.bootstrapRole)return undefined
 const url=new URL(process.env.DATABASE_URL!);url.username=marker.bootstrapRole
 const admin=new pg.Client({connectionString:url.href});await admin.connect()
 try{return await admin.query(sql)}finally{await admin.end()}
}
// Observer-only nested statement counts; the measured statements run as app_user.
async function statementCalls():Promise<{top:number;nested:number}|undefined>{
 if(process.env.BRIAN_ASSURANCE_STATEMENT_STATS!=='true')return undefined
 const marker=JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!,'utf8')) as {bootstrapRole?:string}
 if(!marker.bootstrapRole)return undefined
 const url=new URL(process.env.DATABASE_URL!);url.username=marker.bootstrapRole
 const admin=new pg.Client({connectionString:url.href});await admin.connect()
 try{const row=(await admin.query<{top:string;nested:string}>(`/* preparation-observer */ SELECT
   coalesce(sum(calls) FILTER(WHERE toplevel),0)::text AS top,coalesce(sum(calls) FILTER(WHERE NOT toplevel),0)::text AS nested
   FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '/* preparation-observer */%' AND query NOT LIKE '%FROM pg_stat_statements WHERE dbid=%'`)).rows[0]
  return{top:Number(row.top),nested:Number(row.nested)}}finally{await admin.end()}
}
async function functionCalls(client:PoolClient){return operation(client,'stats')}
const delta=(after:Json,before:Json)=>Object.fromEntries(Object.keys(after).filter(key=>key!==port).map(key=>[key,(after[key]??0)-(before[key]??0)]).filter(([,n])=>n!==0))

describe.sequential('[COMP:api/native-turn-frame] joint native preparation acquisition',()=>{
 beforeAll(async()=>{
  await observer(`ALTER ROLE app_user SET track_functions='all'`)
  f=await persistentContextFixture('confidential')
  await f.pool.query(`CREATE FUNCTION ${port}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN
    IF action='trace' THEN
     -- The ordinary-owner profile enables tracking on the role through the observer.
     BEGIN PERFORM set_config('track_functions','all',true);EXCEPTION WHEN insufficient_privilege THEN NULL;END;
     RETURN jsonb_build_object('tracking',current_setting('track_functions'));
    ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}');
    ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='revoke' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id=(payload->>'id')::uuid;
    ELSIF action='v2' THEN UPDATE workspaces SET department_read_v2=(payload->>'enabled')::boolean WHERE id=w;
    ELSIF action='helper' THEN ALTER FUNCTION conversation_dag(uuid,jsonb,jsonb) COST 101;
    ELSIF action='self' THEN ALTER FUNCTION capture_conversation_preparation(uuid,jsonb,jsonb,jsonb) COST 101;
    ELSE RAISE EXCEPTION 'Unknown preparation fixture action';END IF;
    RETURN '{}'::jsonb;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${port}(uuid,text,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${port}(uuid,text,jsonb) TO app_user`)
  // Shared room: the fixture's workspace chat, populated with a derived reply.
  await f.history()
  const sharedExecution=await f.execution(f.ownerId)
  const sharedAuthority={execution:sharedExecution,accumulator:new ContextScopeAccumulator()}
  const sharedQuery=boundScopeSources(await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority:sharedAuthority}))
  await publishNativeSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional joint reply',senderAssistantId:f.assistantId,
   authority:sharedAuthority,derivationTarget:f.envelope,derivation:{producer:'fixture:joint-preparation',sources:sharedQuery}})
  const sharedEmpty=boundScopeSources(await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,
   authority:{execution:sharedExecution,accumulator:new ContextScopeAccumulator()}}))
  const plainOf=async(session:Session)=>(await f.pool.query<Root>("SELECT 'session_message' kind,id::text,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num",[session.id])).rows
  scenarios.shared={label:'shared',session:f.session,execution:sharedExecution,plain:await plainOf(f.session),query:sharedQuery,empty:sharedEmpty,
   authority:{workspaceId:f.workspaceId,userId:f.ownerId,assistantId:f.assistantId,sessionId:f.session.id}}
  // Private personal chat for the owner.
  const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional joint browser',userAgent:null,ipAddress:null}))!
  const personal=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
  for(const [role,text] of [['user','Fictional private request'],['assistant','Fictional private answer'],['user','Fictional private follow-up']] as const)
   await addSessionMessage({sessionId:personal.id,role,content:[{type:'text',text}],senderUserId:role==='user'?f.ownerId:undefined,scope:{...f.envelope,userId:f.ownerId}})
  // The same construction as the canonical title/session authority owner.
  const stored=(await readSessionById(personal.id))!
  const privateExecution=(await resolveExecutionContextSystem({userId:f.ownerId,workspaceId:f.workspaceId,assistant:(await findAssistantById(f.assistantId))!,memberMode:'member',
   sharedAudience:!policyFor(stored).context.personalMemory,session:stored,sessionAuthority:stored,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.ownerId,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},
   lifecycle:{sessionId:stored.id,sessionPersisted:true,channelType:stored.channelType,channelId:stored.channelId,
    transport:classifySession(stored).transport,abortSignal:new AbortController().signal},
   nativeSessionCredential:{userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}})).executionContext
  const privateQuery=boundScopeSources(await readAdmittedSessionQuery({sessionId:personal.id,throughSequence:3,authority:{execution:privateExecution,accumulator:new ContextScopeAccumulator()}}))
  const privateEmpty=boundScopeSources(await readAdmittedSessionQuery({sessionId:personal.id,throughSequence:0,authority:{execution:privateExecution,accumulator:new ContextScopeAccumulator()}}))
  scenarios.private={label:'private',session:stored,execution:privateExecution,plain:await plainOf(personal),query:privateQuery,empty:privateEmpty,
   authority:{workspaceId:f.workspaceId,userId:f.ownerId,assistantId:f.assistantId,sessionId:personal.id}}
 },240_000)
 afterAll(async()=>{
  try{
   if(process.env.BRIAN_PREPARATION_COST_OUTPUT)await writeFile(process.env.BRIAN_PREPARATION_COST_OUTPUT,JSON.stringify({measurements},null,2))
   await getPool().query(`DROP FUNCTION IF EXISTS ${port}(uuid,text,jsonb)`);await f?.cleanup()
   await observer('ALTER ROLE app_user RESET track_functions')
  }finally{await getAppPool().end();await getPool().end()}
 })

 for(const model of ['legacy','department-v2'] as const)for(const label of ['shared','private'] as const){
  it(`${label} / ${model}: populated and empty cohorts project exactly as independent captures`,async()=>{
   await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[f.workspaceId,model==='department-v2'])
   const s=scenarios[label]
   expect(s.query.length).toBeGreaterThan(0);expect(s.empty.length).toBeGreaterThan(0)
   await frame(s.execution,async client=>{
    const {joint}=await equivalent(client,[s.query.map(identity),s.empty.map(identity),[s.plain[0]],s.plain,[s.plain.at(-1)!,s.plain[0],s.plain.at(-1)!]])
    const cohorts=(joint.value as Json).cohorts as Json[]
    expect(cohorts[0].admitted).toBe(true);expect(cohorts[1].admitted).toBe(true);expect(cohorts[2].admitted).toBe(true)
    // The reader projects the same complete evidence as the old reader.
    const old=await Promise.all([s.query,s.empty,[s.query[0]]].map(roots=>readConversationEvidence(client,f.workspaceId,roots)))
    const fresh=await readConversationPreparation(client,f.workspaceId,{cohorts:[s.query,s.empty,[s.query[0]]]})
    expect(fresh.cohorts.map(entry=>entry&&'evidence'in entry?{...entry,current:sorted(entry.current as Json[])}:entry))
     .toEqual(old.map(entry=>entry&&'evidence'in entry?{...entry,current:sorted(entry.current as Json[])}:entry))
   })
  },120_000)
 }

 it.each(['shared','private'] as const)('%s: field snapshots and authority facts equal their standalone readers',async label=>{
  await f.pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
  // Private dialogue is a private_transcript source; recorded fields come from the room.
  const s=scenarios[label],recorded=fields(scenarios.shared.query)
  expect(recorded.length).toBeGreaterThan(0)
  await frame(s.execution,async client=>{
   const ids=[...recorded.map(field=>field.resourceId),randomUUID()],versions=[...recorded.map(field=>field.version),'1']
   const old=(await client.query('SELECT ord,snapshot FROM read_native_session_field_snapshots($1,$2,$3)',[f.workspaceId,ids,versions])).rows
   // The standalone owner reads facts on the system pool (readSessionAuthorityFacts).
   const facts=(await getPool().query('SELECT read_session_authority_facts($1,$2,$3,$4,$5,$6,$7,$8,$9) AS facts',sessionAuthorityFactsParameters(s.authority))).rows[0].facts
   const joint=await readConversationPreparation(client,f.workspaceId,{cohorts:[s.query],fields:ids.map((resourceId,i)=>({resourceId,version:versions[i]})),authority:s.authority})
   expect(joint.fields).toEqual(old)
   expect(joint.authority).toEqual(facts)
   // Field and authority work alone still pass through the same admitted frame.
   const alone=await readConversationPreparation(client,f.workspaceId,{cohorts:[],fields:ids.map((resourceId,i)=>({resourceId,version:versions[i]})),authority:s.authority})
   expect(alone.cohorts).toEqual([]);expect(alone.fields).toEqual(old);expect(alone.authority).toEqual(facts)
  })
 },120_000)

 it.each(['shared','private'] as const)('%s: a revoked source refuses only its own cohort, as independent captures do',async label=>{
  const s=scenarios[label]
  await frame(s.execution,async client=>{
   await operation(client,'hold',{id:s.plain[1].id})
   const {separate,joint}=await equivalent(client,[[s.plain[0]],[s.plain[1]],s.plain,s.query.map(identity)])
   expect(separate.map(entry=>(entry.value as Json|undefined)?.admitted)).toEqual([true,false,false,false])
   const source=(root:Root):ScopeSource=>({...f.envelope,resourceKind:'session_message',resourceId:root.id,version:root.version})
   const reader=await readConversationPreparation(client,f.workspaceId,{cohorts:[[source(s.plain[0])],[source(s.plain[1])]]})
   expect(reader.cohorts[0]?.kind).toBe('complete');expect(reader.cohorts[1]).toEqual({kind:'refused'})
   await expect(readConversationEvidence(client,f.workspaceId,[source(s.plain[1])])).rejects.toThrow('Native session evidence unavailable')
   expect(((joint.value as Json).cohorts as Json[])[1]).toEqual({admitted:false})
  })
 },120_000)

 it.each(['legacy','department-v2'] as const)('a denied member is refused identically (%s)',async model=>{
  await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[f.workspaceId,model==='department-v2'])
  const s=scenarios.shared,denied=await f.execution(f.firstId)
  await frame(denied,async client=>{
   const {separate}=await equivalent(client,[s.plain,[s.plain[0]],s.query.map(identity)])
   expect(separate.some(entry=>entry.error||(entry.value as Json)?.admitted!==true)).toBe(true)
  })
  await frame(s.execution,async client=>{
   await operation(client,'revoke',{id:f.ownerId})
   await equivalent(client,[s.plain,[s.plain[0]]])
  })
 },120_000)

 it('validates the executable registry once for all cohorts and builds one graph',async()=>{
  await f.pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
  for(const s of Object.values(scenarios))await frame(s.execution,async client=>{
   await operation(client,'trace')
   const cohorts=[s.query.map(identity),[s.plain[0]],[s.plain[1]],s.plain]
   const recorded=fields(scenarios.shared.query),fieldInput={ids:recorded.map(x=>x.resourceId),versions:recorded.map(x=>x.version)}
   const authorityParameters=sessionAuthorityFactsParameters(s.authority)
   // Old boundary: one capture per cohort, plus the field snapshot and authority readers.
   const functionsBefore=await functionCalls(client),statementsBefore=await statementCalls()
   let oldForeground=0
   for(const roots of cohorts){oldForeground++;await client.query('SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify(roots)])}
   oldForeground++;await client.query('SELECT ord,snapshot FROM read_native_session_field_snapshots($1,$2,$3)',[f.workspaceId,fieldInput.ids,fieldInput.versions])
   oldForeground++;await getPool().query('SELECT read_session_authority_facts($1,$2,$3,$4,$5,$6,$7,$8,$9) AS facts',authorityParameters)
   const statementsMiddle=await statementCalls(),functionsMiddle=await functionCalls(client),statementsJoint=await statementCalls()
   await client.query('SELECT capture_conversation_preparation($1,$2,$3,$4) value',[f.workspaceId,JSON.stringify(cohorts),JSON.stringify(fieldInput),JSON.stringify(authorityParameters)])
   const statementsAfter=await statementCalls(),functionsAfter=await functionCalls(client)
   const old=delta(functionsMiddle,functionsBefore),fresh=delta(functionsAfter,functionsMiddle)
   // Since 8289 an independent capture is the fused owner: one registry fence and no
   // conversation_dag call when it compiles the shape; the generic owner keeps two fences
   // and one dag evaluation. The joint owner is unchanged.
   expect(old.native_turn_helpers_current).toBeGreaterThanOrEqual(cohorts.length+2)
   expect(old.native_turn_helpers_current).toBeLessThanOrEqual(2*cohorts.length+2)
   expect(fresh.native_turn_helpers_current).toBe(2)
   expect(old.conversation_dag??0).toBeLessThanOrEqual(cohorts.length+1)
   expect(fresh.conversation_dag).toBe(1)
   expect(fresh.capture_conversation_evidence??0).toBe(0)
   measurements.push({scenario:s.label,cohorts:cohorts.length,fieldSnapshots:recorded.length,authority:true,
    old:{foreground:oldForeground,functionCalls:Object.values(old).reduce<number>((n,v)=>n+Number(v),0),functions:old,
     statements:statementsBefore&&statementsMiddle?{top:statementsMiddle.top-statementsBefore.top,nested:statementsMiddle.nested-statementsBefore.nested}:undefined},
    joint:{foreground:1,functionCalls:Object.values(fresh).reduce<number>((n,v)=>n+Number(v),0),functions:fresh,
     statements:statementsJoint&&statementsAfter?{top:statementsAfter.top-statementsJoint.top,nested:statementsAfter.nested-statementsJoint.nested}:undefined}})
  })
 },120_000)

 it.each(['helper','self'] as const)('refuses a changed %s executable before acquiring',async action=>{
  const s=scenarios.shared
  await frame(s.execution,async client=>{
   await operation(client,action)
   await expect(client.query('SELECT capture_conversation_preparation($1,$2) value',[f.workspaceId,JSON.stringify([s.plain])]))
    .rejects.toMatchObject({code:'42501',message:'scope_source_changed'})
  })
 },60_000)

 it.each([null,[],[[]],[[{kind:'session_message',id:'invalid',version:'1'}]],Array.from({length:9},()=>[{kind:'session_message',id:randomUUID(),version:'1'}]),
  [[{kind:'session_message',id:randomUUID(),version:'1',payload:'forbidden'}]]])('never admits malformed preparation input %j',async input=>{
  await frame(scenarios.shared.execution,async client=>{
   const result=await attempt(client,'SELECT capture_conversation_preparation($1,$2) value',[f.workspaceId,JSON.stringify(input)])
   expect(result.error?.code).toMatch(/^(22023|22004|22P02)$/)
  })
 })

 it('refuses an owner login rather than reading without row security',async()=>{
  await expect(getPool().query('SELECT capture_conversation_preparation($1,$2) value',[f.workspaceId,JSON.stringify([scenarios.shared.plain])]))
   .rejects.toMatchObject({code:'42501'})
 })
})
