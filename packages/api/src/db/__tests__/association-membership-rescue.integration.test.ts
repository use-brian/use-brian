import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AssociationMembershipRescueCreateSchema,
  AssociationMembershipRescueReversalSchema,
  AssociationMembershipRescueSettlementSchema,
  type AssociationActor,
} from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createAssociationStore } from '../association-store.js'
import { createCrmPrivacyService } from '../../crm-operations/privacy-previews.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),store=createAssociationStore()

async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),planId=randomUUID(),providerPlanId=randomUUID(),freePlanId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Offline rescue fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional offline payer',$3,'manual')",[contactId,workspaceId,userId])
  await pool.query(`INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period)
    VALUES($1,$2,'offline','Offline plan','HKD',10000,'annual'),
      ($3,$2,'provider','Provider plan','HKD',10000,'annual'),($4,$2,'free','Free plan','HKD',0,'annual')`,[planId,workspaceId,providerPlanId,freePlanId])
  await pool.query("UPDATE association_membership_plans SET provider='stripe',provider_plan_id='price_fixture' WHERE id=$1",[providerPlanId])
  const actor:AssociationActor={credentialKind:'user',credentialId:userId,actingUserId:userId}
  const now=Date.now(),request=AssociationMembershipRescueCreateSchema.parse({contactId,planId,idempotencyKey:randomUUID(),
    startsAt:new Date(now-60_000).toISOString(),endsAt:new Date(now+365*86400_000).toISOString(),
    dueAt:new Date(now+7*86400_000).toISOString(),reason:'Reviewed bank transfer exception'})
  const privacy=createCrmPrivacyService(),context={workspaceId,actor:{kind:'user' as const,userId},
    authority:{role:'owner' as const,canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
  return {workspaceId,userId,contactId,planId,providerPlanId,freePlanId,actor,request,now,privacy,context}
}

describe('[COMP:crm/association-membership-rescue] Reviewed offline settlement',()=>{
  afterAll(async()=>{await pool.end();await appPool.end()})
  it('creates no access while outstanding, then settles and reverses exactly once',async()=>{
    const f=await fixture(),first=await store.createMembershipRescue(f.workspaceId,f.request,f.actor),id=String(first.record.id)
    expect(first).toMatchObject({created:true,record:{status:'outstanding',amountMinor:'10000',currency:'HKD',membershipId:null}})
    expect((await pool.query('SELECT id FROM association_memberships WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    expect((await store.createMembershipRescue(f.workspaceId,f.request,f.actor)).created).toBe(false)
    await expect(store.createMembershipRescue(f.workspaceId,{...f.request,reason:'Changed reuse'},f.actor)).rejects.toMatchObject({code:'conflict'})
    const settlement=AssociationMembershipRescueSettlementSchema.parse({requestId:randomUUID(),method:'bank_transfer',
      evidenceReference:'bank-fixture-1',amountMinor:10000,currency:'HKD',occurredAt:new Date(f.now-30_000).toISOString(),note:'Treasurer reviewed statement'})
    const settled=await store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)
    expect(settled).toMatchObject({created:true,record:{status:'settled',settlementReference:'bank-fixture-1',membershipStatus:'active'}})
    expect((await store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)).created).toBe(false)
    await expect(store.settleMembershipRescue(f.workspaceId,id,{...settlement,evidenceReference:'changed'},f.actor)).rejects.toMatchObject({code:'conflict'})
    await expect(store.settleMembershipRescue(f.workspaceId,id,{...settlement,requestId:randomUUID()},f.actor)).rejects.toMatchObject({code:'invalid_transition'})
    expect((await pool.query('SELECT status,provider,ends_at IS NOT NULL finite FROM association_memberships WHERE workspace_id=$1',[f.workspaceId])).rows)
      .toEqual([{status:'active',provider:null,finite:true}])
    const reversal=AssociationMembershipRescueReversalSchema.parse({requestId:randomUUID(),evidenceReference:'bank-reversal-fixture-1',
      amountMinor:10000,currency:'HKD',occurredAt:new Date(f.now+1_000).toISOString(),reason:'Bank recalled the transfer'})
    expect(await store.reverseMembershipRescue(f.workspaceId,id,reversal,f.actor)).toMatchObject({created:true,record:{status:'reversed',membershipStatus:'cancelled'}})
    expect((await store.reverseMembershipRescue(f.workspaceId,id,reversal,f.actor)).created).toBe(false)
    await expect(pool.query("UPDATE association_membership_offline_rescues SET settlement_reference='changed' WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'})
  })

  it('preserves the rescue department through settlement and refuses revoked finance operations',async()=>{
    const f=await fixture(),departmentId=randomUUID(),departmentOwnerId=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwnerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwnerId])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional finance department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwnerId,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional finance department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    await pool.query("UPDATE entities SET compartments=$2,sensitivity='confidential' WHERE id=$1",[f.contactId,[`team:${departmentId}`]])
    await expect(store.createMembershipRescue(f.workspaceId,f.request,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    const created=await store.createMembershipRescue(f.workspaceId,f.request,f.actor),id=String(created.record.id)
    const other=await store.createMembershipRescue(f.workspaceId,{...f.request,idempotencyKey:randomUUID()},f.actor)
    const list=()=>store.listMembershipRescues(f.workspaceId,{limit:10,cursor:null},f.actor)
    expect((await list()).items).toHaveLength(2)
    const settlement={requestId:randomUUID(),method:'bank_transfer' as const,evidenceReference:'fictional-bank-evidence',amountMinor:10000,currency:'HKD',occurredAt:new Date(f.now-30_000).toISOString()}
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
    expect(await list()).toMatchObject({items:[],nextCursor:null})
    await expect(store.createMembershipRescue(f.workspaceId,f.request,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.cancelMembershipRescue(f.workspaceId,String(other.record.id),{requestId:randomUUID(),reason:'Fictional cancellation'},f.actor)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT id FROM association_memberships WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
    // A later source declassification cannot widen the membership generated from the rescue.
    await pool.query("UPDATE entities SET compartments='{}',sensitivity='internal' WHERE id=$1",[f.contactId])
    const settled=await store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)
    const membershipId=String(settled.record.membershipId)
    expect((await pool.query('SELECT scope_snapshot FROM association_memberships WHERE id=$1',[membershipId])).rows[0].scope_snapshot)
      .toMatchObject({compartments:[`team:${departmentId}`],sensitivity:'confidential'})
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
    expect(await list()).toMatchObject({items:[]})
    await expect(store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.reverseMembershipRescue(f.workspaceId,id,{requestId:randomUUID(),evidenceReference:'fictional-reversal',amountMinor:10000,currency:'HKD',occurredAt:new Date().toISOString(),reason:'Fictional reversal'},f.actor)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT status FROM association_memberships WHERE id=$1',[membershipId])).rows[0].status).toBe('active')
  })

  it('refuses free/provider plans, stale finance roles and cancellation that would create access',async()=>{
    const f=await fixture()
    for(const planId of [f.providerPlanId,f.freePlanId])await expect(store.createMembershipRescue(f.workspaceId,{...f.request,planId,idempotencyKey:randomUUID()},f.actor)).rejects.toMatchObject({code:'conflict'})
    const created=await store.createMembershipRescue(f.workspaceId,f.request,f.actor),id=String(created.record.id)
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(store.cancelMembershipRescue(f.workspaceId,id,{requestId:randomUUID(),reason:'No longer required'},f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    const cancellation={requestId:randomUUID(),reason:'Payer chose the verified provider path'}
    expect(await store.cancelMembershipRescue(f.workspaceId,id,cancellation,f.actor)).toMatchObject({created:true,record:{status:'cancelled',membershipId:null}})
    expect((await store.cancelMembershipRescue(f.workspaceId,id,cancellation,f.actor)).created).toBe(false)
    expect((await pool.query('SELECT id FROM association_memberships WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })

  it('rolls back access and evidence together when audit cannot commit',async()=>{
    const f=await fixture(),created=await store.createMembershipRescue(f.workspaceId,f.request,f.actor),id=String(created.record.id)
    const settlement=AssociationMembershipRescueSettlementSchema.parse({requestId:randomUUID(),method:'cheque',evidenceReference:'cheque-fixture-1',
      amountMinor:10000,currency:'HKD',occurredAt:new Date(f.now-30_000).toISOString()})
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_rescue_settlement CHECK(action<>'membership_rescue.settled') NOT VALID")
    try {await expect(store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)).rejects.toThrow()}
    finally {await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_rescue_settlement')}
    expect((await pool.query('SELECT status,membership_id FROM association_membership_offline_rescues WHERE id=$1',[id])).rows[0]).toEqual({status:'outstanding',membership_id:null})
    expect((await pool.query('SELECT id FROM association_memberships WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    expect((await store.settleMembershipRescue(f.workspaceId,id,settlement,f.actor)).record).toMatchObject({status:'settled'})
  })

  it('deletes an unpaid case with its contact but blocks erasure once finance evidence exists',async()=>{
    const unpaid=await fixture()
    await store.createMembershipRescue(unpaid.workspaceId,unpaid.request,unpaid.actor)
    const clear=await unpaid.privacy.preview(unpaid.context,{kind:'preview_contact_erasure',contactId:unpaid.contactId})
    expect(clear.status).toBe('ready')
    await unpaid.privacy.erase(unpaid.context,{kind:'erase_contact_with_preview',contactId:unpaid.contactId,
      previewId:clear.id,previewHash:clear.previewHash,confirmed:true})
    expect((await pool.query('SELECT id FROM association_membership_offline_rescues WHERE workspace_id=$1',[unpaid.workspaceId])).rowCount).toBe(0)

    const paid=await fixture(),created=await store.createMembershipRescue(paid.workspaceId,paid.request,paid.actor)
    await store.settleMembershipRescue(paid.workspaceId,String(created.record.id),{
      requestId:randomUUID(),method:'cash',evidenceReference:'cash-fixture-privacy',amountMinor:10000,currency:'HKD',
      occurredAt:new Date(paid.now-30_000).toISOString(),
    },paid.actor)
    const blocked=await paid.privacy.preview(paid.context,{kind:'preview_contact_erasure',contactId:paid.contactId})
    expect(blocked).toMatchObject({status:'blocked',blockers:expect.arrayContaining([
      {domain:'association_membership_offline_rescues',reason:'financial_retention_dependency',count:1},
    ])})
  })
})
