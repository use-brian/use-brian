import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease} from '../../db/client.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] navigation and authorization lock contention',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})

 it('updates picker state without waiting for a history reader workspace lock or advancing either policy revision',async()=>{
  fixture=await persistentContextFixture();const f=fixture
  const revisions=()=>f.pool.query(`SELECT p.revision::text AS access,e.revision::text AS application
   FROM workspace_access_policies p JOIN application_policy_workspace_epochs e ON e.workspace_id=p.workspace_id WHERE p.workspace_id=$1`,[f.workspaceId])
  const before=(await revisions()).rows
  const reader=await f.pool.connect(),writer=await getAppPool().connect()
  try{
   await reader.query('BEGIN')
   await reader.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[f.workspaceId])
   await writer.query('BEGIN');await applyRLSGucs(writer,f.ownerId)
   await writer.query("SET LOCAL lock_timeout='250ms'")
   const updated=await writer.query(`UPDATE workspace_members SET picker_last_opened_at=clock_timestamp(),
    picker_pinned_at=clock_timestamp(),picker_hidden_at=NULL WHERE workspace_id=$1 AND user_id=$2 RETURNING id`,[f.workspaceId,f.ownerId])
   expect(updated.rowCount).toBe(1)
   await writer.query('COMMIT')
   expect((await revisions()).rows).toEqual(before)
  }finally{await rollbackAndRelease(writer);await rollbackAndRelease(reader)}
 })

 it('still serializes real membership changes, including a combined picker and clearance update',async()=>{
  fixture=await persistentContextFixture();const f=fixture,reader=await f.pool.connect(),writer=await f.pool.connect()
  try{
   await reader.query('BEGIN');await reader.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[f.workspaceId])
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='250ms'")
   await expect(writer.query(`UPDATE workspace_members SET clearance='public',picker_last_opened_at=clock_timestamp()
    WHERE workspace_id=$1 AND user_id=$2`,[f.workspaceId,f.firstId])).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await reader.query('ROLLBACK')
   const before=(await f.pool.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].revision
   await writer.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
   const after=(await f.pool.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].revision
   expect(BigInt(after)).toBeGreaterThan(BigInt(before))
  }finally{await rollbackAndRelease(writer);await rollbackAndRelease(reader)}
 })

})
