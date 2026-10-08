import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool, getAppPool, query } from '../client.js'
import { createBrowserProfileStore, withBrowserProfileOwnerMutation } from '../browser-profile-store.js'
import { createSandboxTaskStore } from '../sandbox-task-store.js'
import { createBrowserSessionVault } from '../browser-session-vault.js'
import { createCloudBrowserProvider, createSandboxOrchestrator, StubSandboxProvider } from '@use-brian/core'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:sandbox/session-vault] human session mutation authority', () => {
  it('preserves encrypted sessions after revocation or reclassification and rolls back expired writes', async () => {
    const owner = randomUUID(), custodian = randomUUID(), workspace = randomUUID(), department = randomUUID()
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [owner])
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [custodian])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional vault fixture','test',$2)", [workspace,owner])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace,owner])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspace,custodian])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)", [department,workspace,custodian,`team:${department}`])
    await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspace])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [workspace,department,owner])
    const profiles = createBrowserProfileStore()
    const profile = await profiles.create({ workspaceId:workspace,ownerUserId:owner,name:'Vault identity',departmentId:department,scope:'workspace' }, { userId:owner })
    const vault = createBrowserSessionVault({ encryptionKey: Buffer.alloc(32, 7) })
    const bundle = { site:'portal.example',cookies:[],capturedAt:'2026-10-06T00:00:00Z' }
    const target = { profileId:profile.id,site:bundle.site }
    await vault.put({ ...target,bundle },profile)
    const provider=new StubSandboxProvider(), taskStore=createSandboxTaskStore()
    const orchestrator=createSandboxOrchestrator({provider,taskStore,vault,profileStore:profiles})
    const browser=createCloudBrowserProvider({provider,binding:orchestrator.binding})
    const browsing={userId:owner,workspaceId:workspace,profileId:profile.id,sessionId:randomUUID()}
    await browser.navigate(browsing,'https://portal.example/account')
    expect((await orchestrator.getActiveTask(browsing.sessionId))?.injectedSite).toBe(bundle.site)
    const restoredTask = await createSandboxTaskStore().getActiveBySession(browsing.sessionId)
    expect(restoredTask?.profileAuthority).toEqual({id:profile.id,workspaceId:workspace,ownerUserId:owner,departmentId:department,scope:profile.scope,clearance:profile.clearance})
    const unbound = {...restoredTask!,taskId:randomUUID(),sessionId:randomUUID(),profileId:null,profileAuthority:null}
    await taskStore.create(unbound)
    const binding = {profileId:profile.id,profileAuthority:restoredTask!.profileAuthority}
    const binds = await Promise.allSettled([taskStore.update(unbound.taskId,binding),createSandboxTaskStore().update(unbound.taskId,binding)])
    expect(binds.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(binds.filter(result=>result.status==='rejected')).toHaveLength(1)
    expect((await createSandboxTaskStore().getActiveBySession(unbound.sessionId))?.profileAuthority).toEqual(restoredTask!.profileAuthority)
    await expect(taskStore.update(unbound.taskId,{profileAuthority:null})).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(taskStore.update(unbound.taskId,{profileId:randomUUID()})).rejects.toMatchObject({code:'profile_authority_denied'})
    await taskStore.update(unbound.taskId,{status:'failed'})


    await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [workspace,owner])
    await expect(vault.put({ ...target,bundle:{ ...bundle,capturedAt:'2026-10-07T00:00:00Z' } },profile)).rejects.toMatchObject({ code:'profile_authority_denied' })
    await expect(vault.put({ ...target,bundle:{ ...bundle,capturedAt:'2026-10-07T00:00:00Z' } })).rejects.toMatchObject({ code:'profile_authority_denied' })
    await expect(vault.revoke(target,profile)).rejects.toMatchObject({ code:'profile_authority_denied' })
    await expect(vault.revoke(target)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(vault.markDead(target)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(vault.touch(target)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(orchestrator.captureSession(browsing.sessionId,bundle.site,profile.id)).rejects.toMatchObject({code:'profile_authority_denied'})
    await orchestrator.completeTask(browsing.sessionId,'failed')
    expect([...provider.sandboxes.values()][0].status).toBe('killed')
    expect(await vault.get(target)).toBeNull()
    await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2', [workspace,owner])
    expect(await vault.get(target)).toEqual(bundle)
    await vault.put({...target,bundle})
    const secondDepartment = randomUUID()
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Operations',$3,'team',$1::text,$4)",[secondDepartment,workspace,custodian,`team:${secondDepartment}`])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,secondDepartment,owner])
    const nextBrowsing = {...browsing,sessionId:randomUUID()}
    await browser.navigate(nextBrowsing,'https://portal.example/account')
    const beforeCapture = (await query('SELECT encrypted_bundle,status,captured_at,last_used_at,updated_at FROM browser_sessions WHERE profile_id=$1',[profile.id])).rows
    const remote = provider.browser.bind(provider)
    const captureAccess = vi.spyOn(provider,'browser').mockImplementation(id => {
      const delegate = remote(id)
      return {...delegate,captureStorageState:async site => {
        await profiles.classifyDepartment!(profile.id,{userId:owner,expected:profile,departmentId:secondDepartment,reason:'Transfer fictional test identity',confirmed:true})
        return delegate.captureStorageState(site)
      }}
    })
    // New store/orchestrator instances read the original floor from PostgreSQL.
    const resumed = createSandboxOrchestrator({provider,taskStore:createSandboxTaskStore(),vault,profileStore:profiles})
    await expect(resumed.captureSession(nextBrowsing.sessionId,bundle.site)).rejects.toMatchObject({code:'profile_authority_denied'})
    captureAccess.mockRestore()
    expect((await query('SELECT encrypted_bundle,status,captured_at,last_used_at,updated_at FROM browser_sessions WHERE profile_id=$1',[profile.id])).rows).toEqual(beforeCapture)
    await expect(resumed.binding.resolve(nextBrowsing,{browser:true})).rejects.toMatchObject({code:'profile_authority_denied'})
    expect(await vault.get(target,profile)).toBeNull()
    await expect(vault.touch(target,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(vault.markDead(target,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
    await resumed.completeTask(nextBrowsing.sessionId,'failed')
    expect((await taskStore.getActiveBySession(nextBrowsing.sessionId))).toBeNull()
    const transferred = (await profiles.get(profile.id))!
    await profiles.classifyDepartment!(profile.id,{userId:owner,expected:transferred,departmentId:department,reason:'Restore fictional test identity',confirmed:true})
    const beforeLifecycle=(await query('SELECT encrypted_bundle,status,last_used_at,captured_at,updated_at FROM browser_sessions WHERE profile_id=$1',[profile.id])).rows
    for(const mode of ['save','read','markDead','touch','revoke'] as const) {
      await query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
      const blocker=await getPool().connect()
      let pending: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE browser_sessions IN ACCESS EXCLUSIVE MODE')
        const operation=mode==='save'?vault.put({...target,bundle:{...bundle,capturedAt:'2026-10-08T00:00:00Z'}})
          :mode==='read'?vault.get(target):mode==='markDead'?vault.markDead(target):mode==='touch'?vault.touch(target):vault.revoke(target)
        pending=operation.then(value=>({value}),error=>({error}))
        await vi.waitFor(async()=>{
          const waiting=await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%browser_sessions%' AND pid<>pg_backend_pid()")
          expect(waiting.rowCount).toBeGreaterThan(0)
        },{timeout:2000})
        await blocker.query('SELECT pg_sleep(1.1)')
        await blocker.query('COMMIT')
        expect(await pending).toMatchObject(mode==='read'?{value:null}:{error:{code:'profile_authority_denied'}})
      } finally {
        await blocker.query('ROLLBACK');blocker.release();await pending
        await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
      }
      expect(await vault.get(target)).toEqual(bundle)
      expect((await query('SELECT encrypted_bundle,status,last_used_at,captured_at,updated_at FROM browser_sessions WHERE profile_id=$1',[profile.id])).rows).toEqual(beforeLifecycle)
    }
    const changed = await profiles.update(profile.id,{ scope:'owner' })
    await expect(vault.revoke(target,profile)).rejects.toMatchObject({ code:'profile_authority_denied' })
    expect(await vault.get(target)).toEqual(bundle)
    await query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE workspace_id=$1 AND user_id=$2", [workspace,owner])
    await expect(withBrowserProfileOwnerMutation(profile.id,changed!,async client => {
      await client.query('DELETE FROM browser_sessions WHERE profile_id=$1',[profile.id])
      await new Promise(resolve => setTimeout(resolve,400))
    })).rejects.toMatchObject({ code:'profile_authority_denied' })
    expect(await vault.get(target)).toBeNull()
    await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2', [workspace,owner])
    const legacy = await profiles.create({workspaceId:workspace,ownerUserId:owner,name:'Unassigned shared fixture',scope:'workspace'})
    await expect(vault.put({profileId:legacy.id,site:bundle.site,bundle},legacy)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(vault.put({profileId:legacy.id,site:bundle.site,bundle})).rejects.toMatchObject({code:'profile_authority_denied'})
    expect(await vault.get({profileId:legacy.id,site:bundle.site})).toBeNull()
    expect(await profiles.update(legacy.id,{name:'Unclassified mutation'},legacy)).toBeNull()
    expect((await profiles.get(legacy.id))?.name).toBe('Unassigned shared fixture')
    expect(await profiles.delete(legacy.id,legacy)).toBe(true)
    await expect(vault.put({profileId:legacy.id,site:bundle.site,bundle})).rejects.toMatchObject({code:'profile_authority_denied'})
    await vault.revoke(target,changed!)
    expect(await vault.get(target)).toBeNull()
  },15000)
})
