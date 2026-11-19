/**
 * [COMP:api/derived-scope-store] Lock order of derived transcript writes against
 * conversation evidence capture (M5Q-14). Capture takes the workspace row FOR
 * SHARE and then the session row FOR SHARE. A stored-writer transcript INSERT
 * holds its session row FOR UPDATE (aaab_recording_privacy_message) until
 * COMMIT; `recordDerivedResource` must not then take the workspace row, which
 * the policy guard's FOR UPDATE did on every derived write (BEFORE INSERT fires
 * under ON CONFLICT DO NOTHING too). Before the fix the interleaving below ends
 * in 40P01 deadlock_detected; after it both complete. Disposable ordinary-owner
 * database only.
 */
import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess}=await import('../client.js')
const {addSessionMessage,readSessionMessageScopeSource}=await import('../sessions.js')
const {recordDerivedResource}=await import('../derived-scope-store.js')
const {readConversationEvidence}=await import('../../application-platform/conversation-evidence.js')
const {persistentContextFixture}=await import('../../application-platform/__tests__/fixtures/persistent-context.js')
afterAll(async()=>{await getAppPool().end();await getPool().end()})

async function frame<T>(execution:ExecutionContext,run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(execution.security.access,async()=>{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await applyRLSGucs(client,execution.security.access.userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
  return run(client)
 })}finally{await rollbackAndRelease(client)}
}
const sqlText=(args:unknown[])=>String(typeof args[0]==='string'?args[0]:(args[0] as {text?:string}).text??'')
describe('[COMP:api/derived-scope-store] derived transcript writes against conversation evidence capture (M5Q-14)',()=>{
 it('interleaved at the deadlock point, the derived write and the capture both complete',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const pool=getPool()
   const history=await f.history()
   const sources=(await Promise.all(history.map(row=>readSessionMessageScopeSource(f.workspaceId,row.id)))).filter(Boolean) as ScopeSource[]
   expect(sources).toHaveLength(3)
   expect((await pool.query('SELECT 1 FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(1)
   const execution=await f.execution()
   const a=await pool.connect()
   let capture:Promise<{kind?:string;code?:string}>|undefined
   try{
    await a.query('BEGIN')
    // The transcript INSERT's BEFORE trigger (aaab_recording_privacy_message)
    // holds the sessions row FOR UPDATE from here to COMMIT. At exactly this
    // point the capture starts and must be waiting on that row before the
    // derived write continues: the window the browser pass hit.
    const traced={query:async(...args:unknown[])=>{
     const result=await (a.query as (...x:unknown[])=>Promise<unknown>)(...args)
     if(!capture&&/^\s*INSERT INTO session_messages/.test(sqlText(args))){
      let pid=0
      capture=frame(execution,async client=>{
       pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
       return readConversationEvidence(client,f.workspaceId,sources.slice(0,1))
        .then(value=>({kind:value?.kind}),(error:{code?:string;message?:string})=>({code:error.code??error.message}))
      })
      await expect.poll(async()=>pid>0&&(await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted',[pid])).rowCount===1,{timeout:10_000,interval:20}).toBe(true)
     }
     return result
    }}
    let outcome:string
    try{
     await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'Fictional derived reply'}],
      derivation:{producer:'fixture:lock-order',sources},derivationTarget:f.envelope},traced as never)
     await a.query('COMMIT');outcome='committed'
    }catch(error){outcome=(error as {code?:string}).code??String(error);await a.query('ROLLBACK').catch(()=>{})}
    const captured=await capture!
    console.log('RESULT derived write:',outcome,'capture:',JSON.stringify(captured))
    expect(outcome).toBe('committed')
    expect(captured).toEqual({kind:'complete'})
   }finally{a.release()}
  }finally{await f.cleanup()}
 },120_000)
 it('holds its session row but no workspace row lock until commit, and still creates a missing policy row',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const pool=getPool()
   const history=await f.history()
   const sources=(await Promise.all(history.map(row=>readSessionMessageScopeSource(f.workspaceId,row.id)))).filter(Boolean) as ScopeSource[]
   const a=await pool.connect(),probe=await pool.connect()
   const locked=async(sql:string,id:string)=>{
    await probe.query('BEGIN')
    try{await probe.query(sql,[id]);return false}catch(error){if((error as {code?:string}).code!=='55P03')throw error;return true}
    finally{await probe.query('ROLLBACK')}
   }
   try{
    await a.query('BEGIN')
    await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'Fictional derived reply'}],
     derivation:{producer:'fixture:lock-order',sources},derivationTarget:f.envelope},a)
    expect(await locked('SELECT 1 FROM sessions WHERE id=$1 FOR SHARE NOWAIT',f.session.id)).toBe(true)
    expect(await locked('SELECT 1 FROM workspaces WHERE id=$1 FOR SHARE NOWAIT',f.workspaceId)).toBe(false)
    // An exclusive workspace writer still waits for the lineage foreign keys.
    expect(await locked('SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT',f.workspaceId)).toBe(true)
    await a.query('COMMIT')
    expect((await pool.query("SELECT count(*)::int AS n FROM scope_derivations WHERE workspace_id=$1 AND producer='fixture:lock-order'",[f.workspaceId])).rows[0].n).toBe(1)
   }finally{await a.query('ROLLBACK').catch(()=>{});a.release();probe.release()}
   // A workspace that never had a policy row (no access-revision trigger has
   // fired) still gets one from its first derived write.
   const bare=randomUUID()
   await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional bare workspace',$2)",[bare,f.ownerId])
   try{
    const file=async(name:string)=>{
     const id=randomUUID()
     await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,sensitivity)
      VALUES($1,$2,$3,$4,'fixture://lock-order',$5,'internal')`,[id,bare,`/${name}`,name,f.ownerId])
     const {held:_held,...source}=(await pool.query("SELECT read_scope_source($1,'workspace_file',$2) AS source",[bare,id])).rows[0].source as ScopeSource&{held?:boolean}
     return source as ScopeSource
    }
    const source=await file('fictional-lock-order-input.txt'),output=await file('fictional-lock-order-output.txt')
    expect((await pool.query('SELECT 1 FROM workspace_access_policies WHERE workspace_id=$1',[bare])).rowCount).toBe(0)
    const tx=await pool.connect()
    try{
     await tx.query('BEGIN')
     await recordDerivedResource(tx,{producer:'fixture:lock-order',sources:[source]},output)
     await tx.query('COMMIT')
    }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release()}
    expect((await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[bare])).rows).toEqual([{revision:'1'}])
   }finally{await pool.query('DELETE FROM workspaces WHERE id=$1',[bare])}
  }finally{await f.cleanup()}
 },120_000)
})
