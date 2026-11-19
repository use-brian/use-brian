/** [COMP:api/conversation-visibility] A retained write pins the original Office audience. */
import { setTimeout } from 'node:timers/promises'
import { afterAll, expect, it } from 'vitest'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { applyRLSGucs, getAppPool, getPool } from '../client.js'
import { ensureOfficeArtifactSessionSystem } from '../office-artifact-sessions.js'
import { createOfficeArtifactStore, officeArtifactStore } from '../office-artifacts.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

it('serializes Office grant revocation with the original audience used by a write', async () => {
  const f = await persistentContextFixture('internal')
  const read = await f.pool.connect()
  const grant = await getAppPool().connect()
  let pending: Promise<boolean> | undefined
  try {
    const artifact = await officeArtifactStore.createShell({userId:f.ownerId,workspaceId:f.workspaceId,
      family:'document',title:'Fictional native Office audience',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'})
    const link = await ensureOfficeArtifactSessionSystem({artifactId:artifact.id,assistantId:f.assistantId,userId:f.ownerId})
    await f.pool.query("UPDATE office_artifacts SET default_workspace_role='deny' WHERE id=$1",[artifact.id])
    await f.pool.query(`INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role,granted_by)
      VALUES($1,$2,$3,'view',$4)`,[artifact.id,f.workspaceId,f.firstId,f.ownerId])
    await read.query('BEGIN')
    const readPid=(await read.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid
    const coordinates = [f.workspaceId,link.sessionId,f.firstId]
    const pin = () => read.query<{allowed:boolean}>('SELECT public.lock_conversation_member_read($1,$2,$3) allowed',coordinates)
    expect((await pin()).rows).toEqual([{allowed:true}])
    await grant.query('BEGIN')
    await applyRLSGucs(grant,f.ownerId)
    const grantPid=(await grant.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid
    const grantStore=createOfficeArtifactStore(async <T>(actor:string,sql:string,params:unknown[])=>{
      expect(actor).toBe(f.ownerId)
      return {rows:(await grant.query(sql,params)).rows as T[]}
    })
    let resolved: {value?:boolean;error?:unknown}|undefined
    pending=grantStore.revokeGrant({userId:f.ownerId,artifactId:artifact.id,targetUserId:f.firstId})
    void pending.then(value=>{resolved={value}},error=>{resolved={error}})
    const waiter=async ()=>{
      for(let attempt=0;attempt<60;attempt++){
        const row=(await f.pool.query<{blocked:boolean}>(`SELECT $2::integer=ANY(pg_blocking_pids($1)) blocked`,[grantPid,readPid])).rows[0]
        if(row?.blocked)return true
        if(resolved?.error)throw resolved.error
        if(resolved)throw new Error(`Office grant finished before the pinned read released: ${String(resolved.value)}`)
        await setTimeout(15)
      }
      return false
    }
    expect(await waiter()).toBe(true)
    expect((await pin()).rows).toEqual([{allowed:true}])
    await read.query('COMMIT')
    expect(await pending).toBe(true)
    await grant.query('COMMIT')
    expect((await pin()).rows).toEqual([{allowed:false}])
  } finally {
    await read.query('ROLLBACK').catch(()=>{})
    await pending?.catch(()=>{})
    await grant.query('ROLLBACK').catch(()=>{})
    read.release()
    grant.release()
    await f.cleanup()
  }
},60_000)
