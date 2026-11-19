import {randomUUID} from 'node:crypto'
import {afterAll,beforeEach,describe,expect,it} from 'vitest'
import type {AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import type {ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {getPool,getAppPool,runWithAgentAccess,applyRLSGucs} from '../../db/client.js'
import {validateCallerScopeEvidence} from '../caller-evidence.js'
import {OptionalEvidenceDeferred,optionalEvidenceState,resetOptionalEvidenceStateForTests,runOptionalEvidence} from '../optional-evidence.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

/**
 * M5Q-10 at its real boundary. Optional session-list title admission runs one
 * non-owner transaction per row: workspace row FOR SHARE, then the generic
 * caller-evidence validator (seconds for a closure the native capture does not
 * cover). Several list requests overlap those transactions, so a foreground
 * `FOR NO KEY UPDATE` on the workspace row (native_session_turn_transition and
 * session-create admission take exactly this lock) never finds a gap and fails
 * with 57014. The optional lane must make that work yield instead.
 */
async function fixture(){
  const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),entryId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Optional lane fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Fixture assistant','primary','confidential')",[assistantId,workspaceId,userId])
  // A source family the native capture does not own, so validation takes the generic path.
  await pool.query("INSERT INTO knowledge_entries(id,workspace_id,path,title,content,created_by) VALUES($1,$2,'lane.md','Lane reference','Lane content',$3)",[entryId,workspaceId,userId])
  const source=(await pool.query<{source:ScopeSource}>('SELECT read_scope_source($1,$2,$3) source',[workspaceId,'knowledge_entry',entryId])).rows[0].source
  const evidence:ScopeEvidence={sources:[source]}
  const ceiling:AccessCeiling={workspaceId,userId,clearance:'confidential',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[assistantId]}
  return {workspaceId,userId,evidence,ceiling}
}
type Fixture=Awaited<ReturnType<typeof fixture>>
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

/** One "title row": the same lock and validator sequence as the session-context transaction. */
async function optionalRow(f:Fixture,phases:number):Promise<'completed'|'deferred'>{
  const client=await getAppPool().connect()
  try{
    return await runWithAgentAccess(f.ceiling,async()=>{
      await client.query('BEGIN')
      await applyRLSGucs(client,f.userId)
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[f.workspaceId])
      try{
        for(let phase=0;phase<phases;phase++){
          await validateCallerScopeEvidence(f.evidence,f.ceiling,client).catch(error=>{if(deferral(error))throw error})
          await client.query('SELECT pg_sleep(0.15)')
        }
        await client.query('COMMIT');return 'completed' as const
      }catch(error){
        await client.query('ROLLBACK')
        if(deferral(error))return 'deferred' as const
        throw error
      }
    })
  }finally{client.release()}
}
function deferral(error:unknown):boolean{
  for(let value=error,depth=0;value&&depth<8;depth++){
    if(value instanceof OptionalEvidenceDeferred)return true
    value=(value as {cause?:unknown}).cause
  }
  return false
}
/** Several list requests, each walking rows until stopped; a deferral ends that list. */
function optionalLists(f:Fixture,lists:number,optional:boolean,stop:{done:boolean}){
  const outcomes={completed:0,deferred:0}
  const list=async(index:number)=>{
    await sleep(index*300)
    while(!stop.done){
      const run=async()=>{for(let row=0;row<4&&!stop.done;row++){const outcome=await optionalRow(f,8);outcomes[outcome]++;if(outcome==='deferred')return}}
      if(optional)await runOptionalEvidence({},run);else await run()
      // The next list request arrives later (a refetch), not in a hot loop.
      await sleep(250)
    }
  }
  return {outcomes,done:Promise.all(Array.from({length:lists},(_,index)=>list(index)))}
}
/** The foreground lock of turn transition and session-create admission, with a short statement timeout. */
async function foreground(f:Fixture,attempts:number){
  const waits:number[]=[],timeouts:number[]=[]
  for(let attempt=0;attempt<attempts;attempt++){
    const client=await pool.connect(),started=Date.now()
    try{
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout='3000'")
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[f.workspaceId])
      await client.query('COMMIT');waits.push(Date.now()-started)
    }catch(error){
      await client.query('ROLLBACK').catch(()=>{})
      if((error as {code?:string}).code!=='57014')throw error
      timeouts.push(Date.now()-started)
    }finally{client.release()}
    await sleep(700)
  }
  return {waits,timeouts}
}

describe('[COMP:api/optional-evidence-lane] optional title admission never starves foreground workspace admission',()=>{
  beforeEach(()=>resetOptionalEvidenceStateForTests())
  afterAll(async()=>{await getAppPool().end();await pool.end()})

  it('without the lane, overlapping optional transactions starve FOR NO KEY UPDATE into 57014 (the M5Q-10 defect)',async()=>{
    const f=await fixture(),stop={done:false},lists=optionalLists(f,3,false,stop)
    await sleep(1_200)
    const result=await foreground(f,4)
    stop.done=true;await lists.done
    expect(result.timeouts.length).toBeGreaterThan(0)
  },60_000)

  it('with the lane, optional work yields: no statement timeout, bounded foreground wait, and optional work resumes after',async()=>{
    const f=await fixture(),stop={done:false},lists=optionalLists(f,3,true,stop)
    await sleep(1_200)
    const result=await foreground(f,6)
    // Foreground is done: after the backoff window the optional lane drains its work again.
    const before=lists.outcomes.completed
    await sleep(4_000)
    stop.done=true;await lists.done
    expect(result.timeouts).toEqual([])
    expect(Math.max(...result.waits)).toBeLessThan(2_000)
    expect(lists.outcomes.deferred).toBeGreaterThan(0)
    expect(lists.outcomes.completed).toBeGreaterThan(before)
    expect(optionalEvidenceState()).toMatchObject({active:0})
  },60_000)
})
