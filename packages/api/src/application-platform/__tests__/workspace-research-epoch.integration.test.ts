import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual research counter policy epochs',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){fixture=await persistentContextFixture();const f=fixture;return{f,execution:await f.execution(f.firstId)}}
 it('keeps the original native invocation current across a counter and its automatic audit stamp',async()=>{
  const {f,execution}=await setup()
  const before=(await f.pool.query('SELECT revision FROM application_policy_workspace_epochs WHERE workspace_id=$1',[f.workspaceId])).rows
  await f.pool.query('UPDATE workspaces SET research_used_count=research_used_count+1 WHERE id=$1',[f.workspaceId])
  expect((await f.pool.query('SELECT revision FROM application_policy_workspace_epochs WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(before)
  await expect(execution.security.authority.assertCurrent()).resolves.toBeUndefined()
 })
 it('retains invalidation for a timestamp-only workspace update',async()=>{
  const {f,execution}=await setup()
  await f.pool.query('UPDATE workspaces SET updated_at=now() WHERE id=$1',[f.workspaceId])
  await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 })
 it('does not exempt a simultaneous Department policy change or revive it after restoration',async()=>{
  const {f,execution}=await setup()
  await f.pool.query('UPDATE workspaces SET research_used_count=research_used_count+1,department_read_v2=true WHERE id=$1',[f.workspaceId])
  await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  await f.pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
  await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 })
 it('keeps member contraction effective after counter bookkeeping and a second current reader usable',async()=>{
  const {f,execution}=await setup()
  const tx=await f.pool.connect()
  try{await tx.query('BEGIN');await tx.query('UPDATE workspaces SET research_used_count=research_used_count+1 WHERE id=$1',[f.workspaceId]);
   await tx.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId]);await tx.query('COMMIT')
  }finally{tx.release()}
  await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  const second=await f.execution(f.secondId);await expect(second.security.authority.assertCurrent()).resolves.toBeUndefined()
 })
})
