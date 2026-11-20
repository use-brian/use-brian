/** Registry guard successor (8276): exact capture equivalence between the
 * tuple-version fast path and the full comparator, tamper refusal and fresh
 * installation authentication. [COMP:api/native-turn-frame] */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
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
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const {authenticateConversationInstallation}=await import(new URL('../../../scripts/conversation-store/installation-authentication.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
type Root={kind:string;id:string;version:string}
type Scenario={session:Session;execution:ExecutionContext;plain:Root[];query:ScopeSource[];empty:ScopeSource[]}
const port=`guard_successor_fixture_${randomUUID().replaceAll('-','')}`
let f:Awaited<ReturnType<typeof persistentContextFixture>>
const scenarios:Record<'shared'|'private',Scenario>={} as never
const identity=(source:ScopeSource):Root=>({kind:source.resourceKind,id:source.resourceId,version:source.version})

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
async function attempt(client:PoolClient,sql:string,values:unknown[]):Promise<{value?:unknown;error?:{code:string;message:string}}>{
 await client.query('SAVEPOINT guard_attempt')
 try{const value=(await client.query(sql,values)).rows[0]?.value;await client.query('RELEASE SAVEPOINT guard_attempt');return{value}}
 catch(error){await client.query('ROLLBACK TO SAVEPOINT guard_attempt');const e=error as {code:string;message:string};return{error:{code:e.code,message:e.message}}}
}
/** The disposable bootstrap observer has no product authority. */
async function observer(sql:string):Promise<pg.QueryResult>{
 const marker=JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!,'utf8')) as {bootstrapRole?:string}
 if(!marker.bootstrapRole)throw new Error('Committed catalog controls require the disposable bootstrap observer')
 const url=new URL(process.env.DATABASE_URL!);url.username=marker.bootstrapRole
 const admin=new pg.Client({connectionString:url.href});await admin.connect()
 try{return await admin.query(sql)}finally{await admin.end()}
}
/** Every capture-family output for one cohort set, and which guard path each fence took. */
async function captureAll(client:PoolClient,cohorts:Root[][]){
 const before=await operation(client,'stats')
 const captures=[]
 for(const roots of cohorts)captures.push(await attempt(client,'SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify(roots)]))
 const joint=await attempt(client,'SELECT capture_conversation_preparation($1,$2) value',[f.workspaceId,JSON.stringify(cohorts)])
 const after=await operation(client,'stats')
 const calls=(name:string)=>Number(after[name]??0)-Number(before[name]??0)
 return{captures,joint,guard:calls('native_turn_helpers_current'),fullComparisons:calls('native_turn_publication_contract')}
}
const ownerCurrent=async()=>(await getPool().query('SELECT native_turn_helpers_current() value')).rows[0].value as boolean
const fastPathCurrent=async()=>(await getPool().query(`SELECT EXISTS(SELECT 1 FROM native_turn_contract_witness) present,
 native_turn_helpers_current() guard`)).rows[0] as {present:boolean;guard:boolean}

describe.sequential('[COMP:api/native-turn-frame] registry guard successor',()=>{
 beforeAll(async()=>{
  await observer(`ALTER ROLE app_user SET track_functions='all'`)
  f=await persistentContextFixture('confidential')
  await f.pool.query(`CREATE FUNCTION ${port}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   DECLARE p pg_proc;definition text;
   BEGIN
    IF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(x.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc x ON x.oid=s.funcid),'{}');
    ELSIF action='unwitness' THEN DELETE FROM native_turn_contract_witness;
    ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='revoke' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id=(payload->>'id')::uuid;
    ELSIF action='helper' THEN ALTER FUNCTION conversation_dag(uuid,jsonb,jsonb) COST 101;
    ELSIF action='body' THEN
     SELECT * INTO STRICT p FROM pg_proc WHERE oid='sensitivity_rank(text)'::regprocedure;definition:=pg_get_functiondef(p.oid);
     EXECUTE replace(definition,p.prosrc,p.prosrc||' ');
    ELSIF action='acl' THEN GRANT EXECUTE ON FUNCTION conversation_source_edges(uuid,text,uuid,text) TO app_user WITH GRANT OPTION;
    ELSIF action='registry' THEN UPDATE native_turn_contract_helpers SET contract.procost=(contract).procost+1 WHERE signature='sensitivity_rank(text)';
    ELSIF action='roster' THEN DELETE FROM native_turn_contract_helpers WHERE signature='sensitivity_rank(text)';
    ELSIF action='refresh' THEN RETURN to_jsonb(native_turn_contract_witness_refresh());
    ELSE RAISE EXCEPTION 'Unknown guard fixture action';END IF;
    RETURN '{}'::jsonb;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${port}(uuid,text,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${port}(uuid,text,jsonb) TO app_user`)
  await f.history()
  const sharedExecution=await f.execution(f.ownerId)
  const sharedAuthority={execution:sharedExecution,accumulator:new ContextScopeAccumulator()}
  const sharedQuery=boundScopeSources(await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority:sharedAuthority}))
  await publishNativeSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional guarded reply',senderAssistantId:f.assistantId,
   authority:sharedAuthority,derivationTarget:f.envelope,derivation:{producer:'fixture:guard-successor',sources:sharedQuery}})
  const sharedEmpty=boundScopeSources(await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority:{execution:sharedExecution,accumulator:new ContextScopeAccumulator()}}))
  const plainOf=async(session:Session)=>(await f.pool.query<Root>("SELECT 'session_message' kind,id::text,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num",[session.id])).rows
  scenarios.shared={session:f.session,execution:sharedExecution,plain:await plainOf(f.session),query:sharedQuery,empty:sharedEmpty}
  const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional guard browser',userAgent:null,ipAddress:null}))!
  const personal=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
  for(const [role,text] of [['user','Fictional private request'],['assistant','Fictional private answer'],['user','Fictional private follow-up']] as const)
   await addSessionMessage({sessionId:personal.id,role,content:[{type:'text',text}],senderUserId:role==='user'?f.ownerId:undefined,scope:{...f.envelope,userId:f.ownerId}})
  const stored=(await readSessionById(personal.id))!
  const privateExecution=(await resolveExecutionContextSystem({userId:f.ownerId,workspaceId:f.workspaceId,assistant:(await findAssistantById(f.assistantId))!,memberMode:'member',
   sharedAudience:!policyFor(stored).context.personalMemory,session:stored,sessionAuthority:stored,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.ownerId,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},
   lifecycle:{sessionId:stored.id,sessionPersisted:true,channelType:stored.channelType,channelId:stored.channelId,
    transport:classifySession(stored).transport,abortSignal:new AbortController().signal},
   nativeSessionCredential:{userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}})).executionContext
  scenarios.private={session:stored,execution:privateExecution,plain:await plainOf(personal),
   query:boundScopeSources(await readAdmittedSessionQuery({sessionId:personal.id,throughSequence:3,authority:{execution:privateExecution,accumulator:new ContextScopeAccumulator()}})),
   empty:boundScopeSources(await readAdmittedSessionQuery({sessionId:personal.id,throughSequence:0,authority:{execution:privateExecution,accumulator:new ContextScopeAccumulator()}}))}
 },240_000)
 afterAll(async()=>{
  try{
   await getPool().query(`DROP FUNCTION IF EXISTS ${port}(uuid,text,jsonb)`);await f?.cleanup()
   await observer('ALTER ROLE app_user RESET track_functions')
  }finally{await getAppPool().end();await getPool().end()}
 })

 it('installs a current witness and authenticates the head closure (316 since 8278) twice',async()=>{
  const client=await getPool().connect()
  try{
   const first=await authenticateConversationInstallation(client),second=await authenticateConversationInstallation(client)
   expect(first).toEqual(second);expect(first.functions).toBe(392);expect(first.witnessCurrent).toBe(true)
  }finally{client.release()}
  expect(await fastPathCurrent()).toEqual({present:true,guard:true})
 },120_000)

 for(const model of ['legacy','department-v2'] as const)for(const label of ['shared','private'] as const){
  it(`${label} / ${model}: every capture output is identical on the fast path and the full comparator`,async()=>{
   await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[f.workspaceId,model==='department-v2'])
   const s=scenarios[label],cohorts=[s.query.map(identity),s.empty.map(identity),[s.plain[0]],s.plain,[s.plain.at(-1)!,s.plain[0]]]
   await frame(s.execution,async client=>{
    const fast=await captureAll(client,cohorts)
    await operation(client,'unwitness')
    const full=await captureAll(client,cohorts)
    // Same statements, same data: exact JSON, not set equality.
    expect(full.captures).toEqual(fast.captures);expect(full.joint).toEqual(fast.joint)
    expect(fast.captures.every(entry=>!entry.error&&(entry.value as Json).admitted!==false)).toBe(true)
    // Since 8289 a compiled capture fences once (its single registry fence) and a
    // capture answered by the generic owner fences twice, as the predecessor did.
    expect(fast.guard).toBeGreaterThanOrEqual(cohorts.length);expect(fast.guard).toBeLessThanOrEqual(2*cohorts.length+2);expect(full.guard).toBe(fast.guard)
    expect(fast.fullComparisons).toBe(0);expect(full.fullComparisons).toBe(full.guard)
   })
  },120_000)
 }

 it.each(['shared','private'] as const)('%s: a held source and a denied member refuse identically on both paths',async label=>{
  const s=scenarios[label]
  for(const witnessed of [true,false])await frame(s.execution,async client=>{
   if(!witnessed)await operation(client,'unwitness')
   await operation(client,'hold',{id:s.plain[1].id})
   const result=await captureAll(client,[[s.plain[0]],[s.plain[1]],s.plain])
   expect(result.captures.map(entry=>(entry.value as Json|undefined)?.admitted)).toEqual([true,false,false])
   expect(result.fullComparisons>0).toBe(!witnessed)
  })
  const denied=await f.execution(f.firstId),outcomes:unknown[]=[]
  for(const witnessed of [true,false])await frame(denied,async client=>{
   if(!witnessed)await operation(client,'unwitness')
   outcomes.push((await captureAll(client,[scenarios.shared.plain])).captures)
  })
  expect(outcomes[1]).toEqual(outcomes[0])
 },120_000)

 it.each(['helper','body','acl','registry','roster'] as const)('refuses a changed %s at the next fence',async action=>{
  const s=scenarios.shared
  await frame(s.execution,async client=>{
   expect((await attempt(client,'SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify([s.plain[0]])])).error).toBeUndefined()
   await operation(client,action)
   for(const sql of ['SELECT capture_conversation_evidence($1,$2) value','SELECT capture_conversation_preparation($1,$2) value']){
    const roots=sql.includes('preparation')?[[s.plain[0]]]:[s.plain[0]]
    expect((await attempt(client,sql,[f.workspaceId,JSON.stringify(roots)])).error).toMatchObject({code:'42501'})
   }
   // A tampered installation cannot be recorded as a new witness.
   expect((await attempt(client,`SELECT ${port}($1,'refresh','{}') value`,[f.workspaceId])).error).toMatchObject({code:'42501'})
  })
  expect(await fastPathCurrent()).toEqual({present:true,guard:true})
 },60_000)

 it('refuses a committed owner change, then needs a fresh full comparison to return to the fast path',async()=>{
  const s=scenarios.shared,role=`guard_tamper_${randomUUID().replaceAll('-','').slice(0,12)}`
  await observer(`CREATE ROLE ${role} NOLOGIN;ALTER FUNCTION public.conversation_dag(uuid,jsonb,jsonb) OWNER TO ${role}`)
  try{
   expect(await ownerCurrent()).toBe(false)
   await frame(s.execution,async client=>{
    expect((await attempt(client,'SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify([s.plain[0]])])).error).toMatchObject({code:'42501'})
   })
  }finally{await observer(`ALTER FUNCTION public.conversation_dag(uuid,jsonb,jsonb) OWNER TO assurance_owner;DROP ROLE ${role}`)}
  // Restored content, new tuple version: correct but on the full comparator.
  await frame(s.execution,async client=>{
   const result=await captureAll(client,[[s.plain[0]]])
   expect(result.captures[0].error).toBeUndefined();expect(result.fullComparisons).toBe(result.guard)
  })
  expect((await getPool().query('SELECT native_turn_contract_witness_refresh() value')).rows[0].value).toBe(true)
  await frame(s.execution,async client=>{expect((await captureAll(client,[[s.plain[0]]])).fullComparisons).toBe(0)})
 },120_000)

 it('treats a physical catalog rewrite as a slower full comparison, never as admission or refusal drift',async()=>{
  const s=scenarios.shared
  await observer('VACUUM FULL pg_catalog.pg_proc')
  await frame(s.execution,async client=>{
   const result=await captureAll(client,[[s.plain[0]]])
   expect(result.captures[0].error).toBeUndefined();expect(result.fullComparisons).toBe(result.guard)
  })
  expect((await getPool().query('SELECT native_turn_contract_witness_refresh() value')).rows[0].value).toBe(true)
 },180_000)

 it('keeps the witness and its refresh owner-only, and authentication refuses a forged witness subset',async()=>{
  const s=scenarios.shared
  await frame(s.execution,async client=>{
   expect((await attempt(client,'SELECT native_turn_contract_witness_refresh() value',[])).error).toMatchObject({code:'42501'})
   expect((await attempt(client,'SELECT count(*) value FROM native_turn_contract_witness',[])).error).toMatchObject({code:'42501'})
  })
  await getPool().query('UPDATE native_turn_contract_witness SET procs=procs[2:]')
  const client=await getPool().connect()
  try{
   await expect(authenticateConversationInstallation(client)).rejects.toThrow('installation_contract_witness_changed')
   expect((await client.query('SELECT native_turn_contract_witness_refresh() value')).rows[0].value).toBe(true)
   expect((await authenticateConversationInstallation(client)).witnessCurrent).toBe(true)
  }finally{client.release()}
 },180_000)

 it('refuses an owner login rather than reading without row security',async()=>{
  await expect(getPool().query('SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify([scenarios.shared.plain[0]])]))
   .rejects.toMatchObject({code:'42501'})
 })
})
