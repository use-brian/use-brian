import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool } from '../../db/client.js'
import { executeDepartmentAccessCommand, getWorkspaceAccess } from '../service.js'
import { prepareDepartmentCommand, applyDepartmentCommand } from '../command-review.js'
import { getWorkspaceAccessMode } from '../mode-policy.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID()
  for (const id of [owner, member]) await pool.query("INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)", [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Mode command fixture',$2)", [workspaceId, owner])
  for (const id of [owner, member]) await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId,id,id===owner?'owner':'member'])
  const result = await executeDepartmentAccessCommand(workspaceId,owner,{type:'department.create',name:'Shared',key:'shared'})
  return {workspaceId,owner,member,teamId:result.appliedCommand!.subjectId}
}
async function intent(f:Awaited<ReturnType<typeof fixture>>,teamId=f.teamId) {
  return {command:{type:'workspace.default_department.set' as const,teamId},expectedPolicyRevision:(await getWorkspaceAccess(f.workspaceId,f.owner)).policyRevision,idempotencyKey:randomUUID()}
}
const receipt=(review:{id:string;payloadHash:string})=>({type:'access.command.apply' as const,reviewId:review.id,payloadHash:review.payloadHash})
describe('[COMP:api/workspace-access] reviewed migration default destination',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('previews an exact named destination without changing access or workspace mode',async()=>{
    const f=await fixture(),before=await getWorkspaceAccess(f.workspaceId,f.owner)
    const review=await prepareDepartmentCommand(f.workspaceId,f.owner,await intent(f))
    expect(review.changes).toContainEqual({field:'default_department_id',before:[{kind:'code',value:'none'}],after:[{kind:'text',value:'Shared'}]})
    expect((await getWorkspaceAccessMode(f.workspaceId,f.owner)).defaultDepartmentId).toBeNull()
    await applyDepartmentCommand(f.workspaceId,f.owner,receipt(review))
    expect(await getWorkspaceAccessMode(f.workspaceId,f.owner)).toMatchObject({mode:'departments',setupState:'legacy',defaultDepartmentId:f.teamId})
    const after=await getWorkspaceAccess(f.workspaceId,f.owner)
    expect(after.people).toEqual(before.people)
    expect(after.classificationMode).toBe(before.classificationMode)
    expect(after.teams).toEqual(before.teams)
    expect((await applyDepartmentCommand(f.workspaceId,f.owner,receipt(review))).commandReceipt?.replayed).toBe(true)
  })
  it('rejects non-admin, foreign, expanded and archived destinations',async()=>{
    const f=await fixture(),foreign=await fixture(),request=await intent(f)
    await expect(prepareDepartmentCommand(f.workspaceId,f.member,request)).rejects.toMatchObject({code:'admin_required'})
    await expect(prepareDepartmentCommand(f.workspaceId,f.owner,await intent(f,foreign.teamId))).rejects.toMatchObject({code:'access_mode_default_invalid'})
    await pool.query('UPDATE workspace_groups SET read_all=true WHERE id=$1',[f.teamId])
    await expect(prepareDepartmentCommand(f.workspaceId,f.owner,await intent(f))).rejects.toMatchObject({code:'access_mode_default_invalid'})
    await pool.query("UPDATE workspace_groups SET read_all=false,status='archived' WHERE id=$1",[f.teamId])
    await expect(prepareDepartmentCommand(f.workspaceId,f.owner,await intent(f))).rejects.toMatchObject({code:'access_mode_default_invalid'})
  })
  it('requires a new review after the destination package changes',async()=>{
    const f=await fixture(),review=await prepareDepartmentCommand(f.workspaceId,f.owner,await intent(f))
    await pool.query('UPDATE workspace_groups SET read_all=true WHERE id=$1',[f.teamId])
    await expect(applyDepartmentCommand(f.workspaceId,f.owner,receipt(review))).rejects.toMatchObject({code:'access_policy_conflict'})
    expect((await getWorkspaceAccessMode(f.workspaceId,f.owner)).defaultDepartmentId).toBeNull()
  })
  it('cannot replace a live Simple default through this preparation-only command',async()=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2,setup_state='ready' WHERE workspace_id=$1",[f.workspaceId,f.teamId])
    const other=(await executeDepartmentAccessCommand(f.workspaceId,f.owner,{type:'department.create',name:'Other',key:'other'})).appliedCommand!.subjectId
    await expect(prepareDepartmentCommand(f.workspaceId,f.owner,await intent(f,other))).rejects.toMatchObject({code:'access_mode_migration_required'})
    expect((await getWorkspaceAccessMode(f.workspaceId,f.owner)).defaultDepartmentId).toBe(f.teamId)
  })
})
