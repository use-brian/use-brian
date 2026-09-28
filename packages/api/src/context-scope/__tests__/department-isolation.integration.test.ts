import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { applyDepartmentCommand, prepareDepartmentCommand } from '../../workspace-access/command-review.js'
import { getWorkspaceScopeInventory } from '../../workspace-access/scope-review.js'
import { getWorkspaceAccess } from '../../workspace-access/service.js'
import { getDepartmentalReadinessSystem } from '../../workspace-access/readiness.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,$2)',[id,'Fictional person'])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Isolation lifecycle fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[workspaceId,owner,member])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Lifecycle assistant',$2,$3,'standard')",[assistantId,owner,workspaceId])
  await pool.query("UPDATE workspace_access_policies SET classification_mode='review',reviewed_inventory_revision=2 WHERE workspace_id=$1",[workspaceId])
  return{workspaceId,owner,member,assistantId}
}

describe('[COMP:api/department-isolation-lifecycle] strict activation against the complete live schema',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})

  it('permits only a current fully reviewed fixture and keeps activation explicit and replay-safe',async()=>{
    const f=await fixture()
    const readiness=await getDepartmentalReadinessSystem(f.workspaceId)
    expect(readiness).toEqual({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]})
    const inventory=await getWorkspaceScopeInventory(f.workspaceId,f.owner)
    expect(inventory).toMatchObject({completeCoverage:true,canActivateStrict:true,classificationMode:'review',policyRevision:expect.any(String),registryRevision:'2',reviewedInventoryRevision:'2'})
    const command={type:'workspace.classification.set' as const,mode:'strict' as const,expectedPolicyRevision:inventory.policyRevision,expectedInventoryRevision:inventory.registryRevision}
    await expect(prepareDepartmentCommand(f.workspaceId,f.member,{command,expectedPolicyRevision:inventory.policyRevision,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'admin_required'})
    expect((await pool.query('SELECT classification_mode FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].classification_mode).toBe('review')
    const saved=await prepareDepartmentCommand(f.workspaceId,f.owner,{command,expectedPolicyRevision:inventory.policyRevision,idempotencyKey:randomUUID()})
    expect(saved.changes).toContainEqual({field:'classification_mode',before:[{kind:'code',value:'review'}],after:[{kind:'code',value:'strict'}]})
    const receipt={type:'access.command.apply' as const,reviewId:saved.id,payloadHash:saved.payloadHash}
    const applied=await applyDepartmentCommand(f.workspaceId,f.owner,receipt)
    expect(applied.classificationMode).toBe('strict');expect(applied.commandReceipt).toEqual({reviewId:saved.id,replayed:false})
    expect((await applyDepartmentCommand(f.workspaceId,f.owner,receipt)).commandReceipt).toEqual({reviewId:saved.id,replayed:true})
    expect((await pool.query("SELECT 1 FROM workspace_access_events WHERE workspace_id=$1 AND kind='workspace.classification.set'",[f.workspaceId])).rows).toHaveLength(1)
  })

  it('refuses stale inventory and incomplete live coverage without changing classification mode',async()=>{
    const stale=await fixture(),staleView=await getWorkspaceAccess(stale.workspaceId,stale.owner)
    await pool.query('UPDATE workspace_access_policies SET reviewed_inventory_revision=NULL WHERE workspace_id=$1',[stale.workspaceId])
    await expect(prepareDepartmentCommand(stale.workspaceId,stale.owner,{command:{type:'workspace.classification.set',mode:'strict',expectedPolicyRevision:staleView.policyRevision,expectedInventoryRevision:'2'},expectedPolicyRevision:staleView.policyRevision,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'scope_review_changed'})

    const unresolved=await fixture()
    await createMemory({workspaceId:unresolved.workspaceId,userId:unresolved.owner,assistantId:unresolved.assistantId,createdByUserId:unresolved.owner,summary:'Unreviewed fixture content',sensitivity:'confidential'})
    const overview=await getWorkspaceAccess(unresolved.workspaceId,unresolved.owner)
    expect(overview.readiness).toMatchObject({ready:false,enforcementVersion:2,requiredEnforcementVersion:2})
    const inventory=await getWorkspaceScopeInventory(unresolved.workspaceId,unresolved.owner)
    expect(inventory).toMatchObject({completeCoverage:false,canActivateStrict:false,classificationMode:'review'})
    expect(inventory.readiness.ready).toBe(false)
    await expect(prepareDepartmentCommand(unresolved.workspaceId,unresolved.owner,{command:{type:'workspace.classification.set',mode:'strict',expectedPolicyRevision:inventory.policyRevision,expectedInventoryRevision:'2'},expectedPolicyRevision:inventory.policyRevision,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'departmental_enforcement_incomplete'})
    for(const workspaceId of [stale.workspaceId,unresolved.workspaceId])expect((await pool.query('SELECT classification_mode FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0].classification_mode).toBe('review')
  })
})
