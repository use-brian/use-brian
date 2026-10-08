import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool, getAppPool, query } from '../client.js'
import { createBrowserProfileStore } from '../browser-profile-store.js'
import { createBrowserCredentialStore } from '../browser-credential-store.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:sandbox/browser-credentials] human credential mutation authority', () => {
  it('preserves saved secrets after revocation and stale-profile replacement attempts', async () => {
    const owner=randomUUID(),custodian=randomUUID(),workspace=randomUUID(),department=randomUUID()
    for(const user of [owner,custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional credential fixture','test',$2)",[workspace,owner])
    for(const user of [owner,custodian]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[workspace,user])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
    await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspace])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,department,owner])
    const profiles=createBrowserProfileStore()
    const profile=await profiles.create({workspaceId:workspace,ownerUserId:owner,name:'Credential identity',departmentId:department,scope:'workspace'},{userId:owner})
    const credentials=createBrowserCredentialStore({encryptionKey:Buffer.alloc(32,7)})
    const input={workspaceId:workspace,profileId:profile.id,ownerUserId:owner,site:'portal.example',loginUrl:'https://portal.example/login',secret:{username:'fictional@example.com',password:'fictional-fixture-secret'}}
    const saved=await credentials.upsert(input,profile)
    const target={profileId:profile.id,credentialId:saved.id}
    const resolve=()=>credentials.resolve({userId:owner,workspaceId:workspace,profileId:profile.id,site:input.site})
    const admitted=await resolve()
    const receipt={userId:owner,workspaceId:workspace,profileId:profile.id,credentialId:saved.id,version:admitted!.version}
    await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
    await expect(credentials.upsert({...input,secret:{...input.secret,password:'rejected-replacement'}},profile)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(credentials.revoke(target,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(credentials.recordResult({...receipt,result:'success'})).rejects.toMatchObject({code:'profile_authority_denied'})
    expect((await credentials.list({profileId:profile.id}))[0].lastUsedAt).toBeNull()
    expect(await resolve()).toBeNull()
    await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
    expect((await resolve())?.secret).toEqual(input.secret)
    await credentials.recordResult({...receipt,result:'success'})
    expect((await credentials.list({profileId:profile.id}))[0].lastUsedAt).not.toBeNull()
    // Saving even identical plaintext creates a new encrypted envelope. A late
    // result from the previous attempt must not mark that replacement invalid.
    await credentials.upsert(input,profile)
    expect((await resolve())?.version).not.toBe(receipt.version)
    await expect(credentials.recordResult({...receipt,result:'failure',failureCode:'login_rejected'})).rejects.toMatchObject({code:'profile_authority_denied'})
    const replacement=(await credentials.list({profileId:profile.id}))[0]
    expect(replacement.status).toBe('active')
    expect(replacement.lastFailureCode).toBeNull()
    await query("UPDATE department_edges SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
    expect(await resolve()).toBeNull()
    await query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
    expect(await credentials.resolve({userId:custodian,workspaceId:workspace,profileId:profile.id,site:input.site})).toBeNull()
    expect(await credentials.resolve({userId:owner,workspaceId:randomUUID(),profileId:profile.id,site:input.site})).toBeNull()
    await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
    expect(await resolve()).toBeNull()
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[workspace,owner])
    expect((await resolve())?.secret).toEqual(input.secret)
    // Admission happens before the credential SELECT. Hold that SELECT until
    // the supporting edge expires: no decrypted value may leave the transaction.
    await query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
    const blocker=await getPool().connect()
    let pending: ReturnType<typeof resolve> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE browser_credentials IN ACCESS EXCLUSIVE MODE')
      pending=resolve()
      await vi.waitFor(async()=>{
        const waiting=await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id, workspace_id, profile_id, site,%' AND query LIKE '%FROM browser_credentials%'")
        expect(waiting.rowCount).toBeGreaterThan(0)
      },{timeout:2000})
      await blocker.query('SELECT pg_sleep(1.1)')
      await blocker.query('COMMIT')
      expect(await pending).toBeNull()
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
      await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
    }
    expect((await resolve())?.secret).toEqual(input.secret)
    const changed=await profiles.update(profile.id,{scope:'owner'})
    await expect(credentials.upsert(input,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(credentials.revoke(target,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
    expect((await resolve())?.secret).toEqual(input.secret)
    expect(await credentials.revoke(target,changed!)).toBe(true)
    expect(await resolve()).toBeNull()
  })
})
