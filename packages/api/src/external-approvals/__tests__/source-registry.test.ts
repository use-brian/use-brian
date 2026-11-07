import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
vi.mock('../../db/client.js',()=>({getPool:()=>{throw new Error('No live database')}}))
vi.mock('../../brain-stream/notify.js',()=>({notifyWorkspaceChange:vi.fn()}))
vi.mock('../../workflow/recent-approval-channel.js',()=>({resolveRecentApprovalChannel:vi.fn(async()=>null)}))
import { createExternalApprovalSourceRegistry, lockExternalApprovalSource } from '../source-registry.js'
import { sourceBinding } from '../contracts.js'
const db = new PGlite()
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const workspaceId=id(1),assistantId=id(2),userId=id(3),sessionId=id(4),approverUserId=id(5)
const actor={userId,sessionId}
const input={name:'Test source',assistantId,approverUserId,notification:'web' as const}
const notify=vi.fn()
const resolveRecentChannel=vi.fn(async():Promise<any>=>null)
const client={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}}
const pool={query:client.query,connect:async()=>client} as unknown as Pick<Pool,'query'|'connect'>
const registry=createExternalApprovalSourceRegistry({pool,notify,resolveRecentChannel})
beforeAll(async()=>{
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,auth_version integer DEFAULT 0);
    CREATE TABLE workspaces(id uuid PRIMARY KEY);
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid);
    CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text);
    CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid,auth_version integer DEFAULT 0,revoked_at timestamptz,expires_at timestamptz);
    CREATE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';`)
  await db.query('INSERT INTO users(id) VALUES($1),($2)',[userId,approverUserId])
  await db.query('INSERT INTO workspaces VALUES($1),($2)',[workspaceId,id(10)])
  await db.query('INSERT INTO assistants VALUES($1,$2)',[assistantId,workspaceId])
  await db.query("INSERT INTO workspace_members VALUES($1,$2,'admin'),($1,$3,'member')",[workspaceId,userId,approverUserId])
  await db.query("INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')",[sessionId,userId])
  await db.exec(readFileSync(new URL('../../../migrations/8242_workspace_external_approval_sources.sql',import.meta.url),'utf8'))
},30000)
afterAll(()=>db.close())
describe('[COMP:api/external-approvals] workspace source registry',()=>{
  it('issues credentials once, persists only digest, scopes public list, rotates without rebinding and revokes immediately',async()=>{
    const a=await registry.create(actor,workspaceId,input)
    expect(a.source.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(a.source).not.toHaveProperty('tokenSha256');expect(a.source).not.toHaveProperty('token')
    expect(a.source).not.toHaveProperty('channelIntegrationId')
    expect(await registry.list(id(10))).toEqual([])
    expect(JSON.stringify(await registry.list(workspaceId))).not.toContain(a.token)
    const original=(await registry.authenticate(`Bearer ${a.token}`))!
    expect(original).toEqual(await registry.get(a.source.id))
    await lockExternalApprovalSource(client as unknown as PoolClient,original)
    for (const changed of [{channelId:'other'}, {workspaceId:id(90)}, {assistantId:id(90)}, {approverUserId:id(90)},
      {channelType:'telegram' as const}, {channelIntegrationId:id(90)}, {id:id(90)}, {tokenSha256:'0'.repeat(64)}]) {
      await expect(lockExternalApprovalSource(client as unknown as PoolClient,{...original,...changed})).rejects.toMatchObject({status:404})
    }
    await db.query("INSERT INTO workspace_members VALUES($1,$2,'admin')",[id(10),userId])
    await expect(registry.rotate(actor,id(10),a.source.id)).rejects.toMatchObject({status:404})
    await expect(registry.revoke(actor,id(10),a.source.id)).rejects.toMatchObject({status:404})
    await db.query('DELETE FROM workspace_members WHERE workspace_id=$1',[id(10)])
    const b=await registry.rotate(actor,workspaceId,a.source.id)
    expect(b.token).not.toBe(a.token)
    expect(await registry.authenticate(`Bearer ${a.token}`)).toBeNull()
    const rotated=(await registry.authenticate(`Bearer ${b.token}`))!
    expect(sourceBinding(rotated)).toBe(sourceBinding(original))
    expect(b.source).toEqual({...a.source,prefix:b.source.prefix})
    await expect(lockExternalApprovalSource(client as unknown as PoolClient,original)).rejects.toMatchObject({status:404})
    await registry.revoke(actor,workspaceId,a.source.id)
    expect(await registry.get(a.source.id)).toBeNull();expect(await registry.authenticate(`Bearer ${b.token}`)).toBeNull()
    await expect(lockExternalApprovalSource(client as unknown as PoolClient,rotated)).rejects.toMatchObject({status:404})
    await expect(registry.rotate(actor,workspaceId,a.source.id)).rejects.toMatchObject({status:404})
    expect((await registry.list(workspaceId)).find(s=>s.id===a.source.id)?.revokedAt).toEqual(expect.any(String))
    const stored=(await db.query<{token_sha256:string}>('SELECT * FROM workspace_external_approval_sources WHERE id=$1',[a.source.id])).rows[0]
    expect(JSON.stringify(stored)).not.toContain(a.token);expect(stored.token_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(notify).toHaveBeenCalledWith(workspaceId)
  })
  it('rechecks human ledger and administrator membership in the transaction',async()=>{
    await expect(registry.create({...actor,sessionId:id(99)},workspaceId,input)).rejects.toMatchObject({status:403})
    await expect(registry.create(actor,id(10),input)).rejects.toMatchObject({status:403})
    await db.query("UPDATE workspace_members SET role='member' WHERE user_id=$1",[userId])
    await expect(registry.create(actor,workspaceId,input)).rejects.toMatchObject({status:403})
    await db.query("UPDATE workspace_members SET role='admin' WHERE user_id=$1",[userId])
    await db.query('UPDATE users SET auth_version=1 WHERE id=$1',[userId])
    await expect(registry.create(actor,workspaceId,input)).rejects.toMatchObject({status:403})
    await db.query('UPDATE users SET auth_version=0 WHERE id=$1',[userId])
    await db.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[sessionId])
    await expect(registry.create(actor,workspaceId,input)).rejects.toMatchObject({status:403})
    await db.query("UPDATE auth_sessions SET revoked_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[sessionId])
    await expect(registry.create(actor,workspaceId,input)).rejects.toMatchObject({status:403})
    await db.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",[sessionId])
  })
  it('requires workspace assistant, current approver membership and visibility for actor AND approver',async()=>{
    await expect(registry.create(actor,workspaceId,{...input,assistantId:id(90)})).rejects.toMatchObject({status:404})
    await expect(registry.create(actor,workspaceId,{...input,approverUserId:id(90)})).rejects.toMatchObject({status:404})
    await db.exec("CREATE OR REPLACE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'")
    await expect(registry.create(actor,workspaceId,input)).rejects.toMatchObject({status:404})
    await db.exec("CREATE OR REPLACE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true'")
  })
  it('fails closed without verified pinned destination, never accepts caller channels',async()=>{
    await expect(registry.create(actor,workspaceId,{...input,channelId:'arbitrary'} as any)).rejects.toThrow()
    await expect(registry.create(actor,workspaceId,{...input,notification:'verified_channel'})).rejects.toMatchObject({status:409})
    resolveRecentChannel.mockResolvedValueOnce({channelType:'telegram',channelId:'room'})
    await expect(registry.create(actor,workspaceId,{...input,notification:'verified_channel'})).rejects.toMatchObject({status:409})
    resolveRecentChannel.mockResolvedValueOnce({channelType:'telegram',channelId:'verified',channelIntegrationId:id(22)})
    const a=await registry.create(actor,workspaceId,{...input,notification:'verified_channel'})
    expect(a.source).toMatchObject({channelType:'telegram',channelId:'verified',channelIntegrationId:id(22)})
    expect(resolveRecentChannel).toHaveBeenLastCalledWith({workspaceId,assistantId,approverUserId})
  })
  it('rolls back issuance when the human session expires before commit',async()=>{
    const before=(await registry.list(workspaceId)).length
    resolveRecentChannel.mockImplementationOnce(async()=>{
      await db.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[sessionId])
      return {channelType:'telegram',channelId:'verified',channelIntegrationId:id(22)}
    })
    await expect(registry.create(actor,workspaceId,{...input,notification:'verified_channel'})).rejects.toMatchObject({status:403})
    expect(await registry.list(workspaceId)).toHaveLength(before)
    // Session mutation happened inside the same failed transaction and is rolled back too.
    await expect(registry.create(actor,workspaceId,input)).resolves.toHaveProperty('source.id')
  })
  it('allows assistant/member cleanup and workspace erasure without reviving or orphaning credentials',async()=>{
    const assistant=id(40),approver=id(41)
    await db.query('INSERT INTO users(id) VALUES($1)',[approver])
    await db.query('INSERT INTO assistants VALUES($1,$2)',[assistant,id(10)])
    await db.query("INSERT INTO workspace_members VALUES($1,$2,'admin'),($1,$3,'member')",[id(10),userId,approver])
    const issued=await registry.create(actor,id(10),{...input,assistantId:assistant,approverUserId:approver})
    await db.query('DELETE FROM assistants WHERE id=$1',[assistant])
    await db.query('DELETE FROM workspace_members WHERE user_id=$1',[approver])
    await db.query('DELETE FROM users WHERE id=$1',[approver])
    expect(await registry.get(issued.source.id)).not.toBeNull()
    await db.query('DELETE FROM workspaces WHERE id=$1',[id(10)])
    expect(await registry.get(issued.source.id)).toBeNull()
    expect(await registry.authenticate(`Bearer ${issued.token}`)).toBeNull()
    expect(await registry.list(id(10))).toEqual([])
  })
  it('enforces permanent namespace and immutable authority at database boundary',async()=>{
    const a=await registry.create(actor,workspaceId,input)
    await expect(db.query('UPDATE workspace_external_approval_sources SET channel_id=$2 WHERE id=$1',[a.source.id,'other'])).rejects.toThrow()
    await expect(db.query('DELETE FROM workspace_external_approval_sources WHERE id=$1',[a.source.id])).rejects.toThrow()
    await registry.revoke(actor,workspaceId,a.source.id)
    await expect(db.query('UPDATE workspace_external_approval_sources SET revoked_at=NULL,revoked_by=NULL WHERE id=$1',[a.source.id])).rejects.toThrow()
    expect(await registry.authenticate('Bearer invalid')).toBeNull()
  })
})
