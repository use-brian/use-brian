import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../client.js'
import {createAssociationStore} from '../association-store.js'
import {loadAssociationOrderScope} from '../../association/source-scope.js'
import type {AssociationActor} from '@use-brian/core'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),store=createAssociationStore()

async function fixture(seatLimit=1){
  const workspaceId=randomUUID(),userId=randomUUID(),sponsorId=randomUUID(),nomineeId=randomUUID(),otherId=randomUUID()
  const sponsorPlanId=randomUUID(),studentPlanId=randomUUID(),sponsorMembershipId=randomUUID(),now=Date.now()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Sponsorship fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  for(const [id,name] of [[sponsorId,'Sponsor'],[nomineeId,'Nominee'],[otherId,'Other member']])
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person',$3,$4,'manual')",[id,workspaceId,name,userId])
  await pool.query(`INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period)
    VALUES($1,$2,'sponsor','Sponsor plan','HKD',10000,'annual'),($3,$2,'student','Sponsored student','HKD',0,'annual')`,
    [sponsorPlanId,workspaceId,studentPlanId])
  await pool.query(`INSERT INTO association_memberships(id,workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at)
    VALUES($1,$2,$3,$4,$5,repeat('a',64),'active',$6,$7)`,[sponsorMembershipId,workspaceId,sponsorId,sponsorPlanId,randomUUID(),
      new Date(now-86_400_000),new Date(now+365*86_400_000)])
  const scope=await loadAssociationOrderScope(pool,workspaceId,[sponsorId])
  await pool.query('UPDATE association_memberships SET scope_snapshot=$2::jsonb,scope_sources=$3::jsonb WHERE id=$1',[sponsorMembershipId,JSON.stringify(scope.scope),JSON.stringify(scope.sources)])
  const actor:AssociationActor={credentialKind:'user',credentialId:userId,actingUserId:userId}
  const allocation=await store.createSponsorshipAllocation(workspaceId,{sponsorContactId:sponsorId,sponsorMembershipId,
    beneficiaryPlanId:studentPlanId,idempotencyKey:randomUUID(),seatLimit,startsAt:new Date(now-60_000).toISOString(),
    endsAt:new Date(now+180*86_400_000).toISOString(),invitationTtlHours:168},actor)
  return {workspaceId,userId,sponsorId,nomineeId,otherId,sponsorPlanId,studentPlanId,sponsorMembershipId,
    allocationId:String(allocation.record.id),actor,now}
}

describe('[COMP:crm/association-sponsorship] Atomic recipient-bound sponsorship',()=>{
  afterAll(async()=>{await pool.end();await appPool.end()})
  it('binds a one-time token to the nominee, replays exactly, and stops access when the sponsor lapses',async()=>{
    const f=await fixture(),issued=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,
      nomineeContactId:f.nomineeId,idempotencyKey:randomUUID()},f.actor)
    const token=String(issued.record.redemptionToken)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(store.redeemSponsorshipInvitation(f.workspaceId,{token,contactId:f.otherId},f.actor)).rejects.toMatchObject({code:'not_available'})
    const accepted=await store.redeemSponsorshipInvitation(f.workspaceId,{token,contactId:f.nomineeId},f.actor)
    expect(accepted).toMatchObject({created:true,record:{contactId:f.nomineeId,planId:f.studentPlanId,status:'active',sponsorshipAllocationId:f.allocationId}})
    expect(await store.redeemSponsorshipInvitation(f.workspaceId,{token,contactId:f.nomineeId},f.actor)).toMatchObject({created:false,record:{id:accepted.record.id}})
    expect((await store.listMemberships(f.workspaceId,f.nomineeId,{activeOnly:true}))).toHaveLength(1)
    await pool.query("UPDATE association_memberships SET status='cancelled' WHERE workspace_id=$1 AND id=$2",[f.workspaceId,f.sponsorMembershipId])
    expect((await store.listMemberships(f.workspaceId,f.nomineeId))[0]).toMatchObject({status:'active',isEffective:false})
    expect(await store.listMemberships(f.workspaceId,f.nomineeId,{activeOnly:true})).toHaveLength(0)
  })

  it('serializes the last seat and permits a reasoned revocation to release it',async()=>{
    const f=await fixture(),requests=[f.nomineeId,f.otherId].map(nomineeContactId=>store.issueSponsorshipInvitation(f.workspaceId,
      {allocationId:f.allocationId,nomineeContactId,idempotencyKey:randomUUID()},f.actor))
    const outcomes=await Promise.allSettled(requests)
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1)
    const invitation=String((outcomes.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<{record:Record<string,unknown>}>).value.record.id)
    await store.revokeSponsorshipInvitation(f.workspaceId,invitation,{requestId:randomUUID(),reason:'Nominee declined the place'},f.actor)
    const replacement=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,
      nomineeContactId:f.otherId,idempotencyKey:randomUUID()},f.actor)
    expect(replacement.created).toBe(true)
  })

  it('refuses duplicate active plan access and cancellation revokes every dependent grant',async()=>{
    const f=await fixture(2)
    await pool.query(`INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at)
      VALUES($1,$2,$3,$4,repeat('b',64),'active',$5,$6)`,[f.workspaceId,f.nomineeId,f.studentPlanId,randomUUID(),new Date(f.now-60_000),new Date(f.now+30*86_400_000)])
    const duplicate=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,nomineeContactId:f.nomineeId,idempotencyKey:randomUUID()},f.actor)
    await expect(store.redeemSponsorshipInvitation(f.workspaceId,{token:String(duplicate.record.redemptionToken),contactId:f.nomineeId},f.actor)).rejects.toMatchObject({code:'conflict'})
    const issued=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,nomineeContactId:f.otherId,idempotencyKey:randomUUID()},f.actor)
    const accepted=await store.redeemSponsorshipInvitation(f.workspaceId,{token:String(issued.record.redemptionToken),contactId:f.otherId},f.actor)
    await store.cancelSponsorshipAllocation(f.workspaceId,f.allocationId,{requestId:randomUUID(),reason:'Sponsor membership ended'},f.actor)
    expect((await pool.query('SELECT status FROM association_memberships WHERE id=$1',[accepted.record.id])).rows[0].status).toBe('cancelled')
    expect((await pool.query("SELECT count(*)::int count FROM association_sponsorship_invitations WHERE allocation_id=$1 AND status='pending'",[f.allocationId])).rows[0].count).toBe(0)
  })

  it('expires a stale invitation under the allocation lock and permits a replacement for the same nominee',async()=>{
    const f=await fixture(),first=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,
      nomineeContactId:f.nomineeId,idempotencyKey:randomUUID()},f.actor)
    await pool.query("UPDATE association_sponsorship_invitations SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1",[first.record.id])
    const replacement=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,
      nomineeContactId:f.nomineeId,idempotencyKey:randomUUID()},f.actor)
    expect(replacement).toMatchObject({created:true,record:{nomineeContactId:f.nomineeId,status:'pending'}})
    expect((await pool.query('SELECT status,revocation_reason FROM association_sponsorship_invitations WHERE id=$1',[first.record.id])).rows[0])
      .toEqual({status:'revoked',revocation_reason:'Invitation expired before replacement.'})
  })

  it('removes beneficiary access when the allocation period ends',async()=>{
    const f=await fixture(),issued=await store.issueSponsorshipInvitation(f.workspaceId,{allocationId:f.allocationId,
      nomineeContactId:f.nomineeId,idempotencyKey:randomUUID()},f.actor)
    await store.redeemSponsorshipInvitation(f.workspaceId,{token:String(issued.record.redemptionToken),contactId:f.nomineeId},f.actor)
    await pool.query("UPDATE association_sponsorship_allocations SET ends_at=statement_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2",[f.workspaceId,f.allocationId])
    expect((await store.listMemberships(f.workspaceId,f.nomineeId))[0]).toMatchObject({status:'active',isEffective:false})
    expect(await store.listMemberships(f.workspaceId,f.nomineeId,{activeOnly:true})).toHaveLength(0)
  })
  it('inherits both departments, masks hidden seat counts and rejects revoked sponsorship mutations',async()=>{
    const f=await fixture(3),departmentOwnerId=randomUUID(),sponsorDepartment=randomUUID(),nomineeDepartment=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwnerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwnerId])
    for(const departmentId of [sponsorDepartment,nomineeDepartment]) {
      await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional sponsorship department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwnerId,`team:${departmentId}`])
      await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional sponsorship department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    }
    await pool.query("UPDATE entities SET compartments=$2,sensitivity='confidential' WHERE id=$1",[f.sponsorId,[`team:${sponsorDepartment}`]])
    await pool.query("UPDATE entities SET compartments=$2,sensitivity='confidential' WHERE id=$1",[f.nomineeId,[`team:${nomineeDepartment}`]])
    const input={sponsorContactId:f.sponsorId,sponsorMembershipId:f.sponsorMembershipId,beneficiaryPlanId:f.studentPlanId,idempotencyKey:randomUUID(),seatLimit:3,startsAt:new Date(f.now-60_000).toISOString(),endsAt:new Date(f.now+180*86400_000).toISOString(),invitationTtlHours:168}
    const allocation=await store.createSponsorshipAllocation(f.workspaceId,input,f.actor),id=String(allocation.record.id)
    const invitationInput={allocationId:id,nomineeContactId:f.nomineeId,idempotencyKey:randomUUID()}
    const issued=await store.issueSponsorshipInvitation(f.workspaceId,invitationInput,f.actor),invitationId=String(issued.record.id),token=String(issued.record.redemptionToken)
    const expected=[`team:${sponsorDepartment}`,`team:${nomineeDepartment}`].sort()
    expect((await pool.query('SELECT scope_snapshot FROM association_sponsorship_invitations WHERE id=$1',[invitationId])).rows[0].scope_snapshot.compartments.sort()).toEqual(expected)
    const list=()=>store.listSponsorshipAllocations(f.workspaceId,{limit:20,cursor:null},f.actor)
    expect((await list()).items.find(row=>row.id===id)?.allocatedSeats).toBe(1)
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[nomineeDepartment,f.userId])
    expect((await list()).items.find(row=>row.id===id)?.allocatedSeats).toBeNull()
    expect((await store.createSponsorshipAllocation(f.workspaceId,input,f.actor)).record.allocatedSeats).toBeNull()
    expect((await store.listSponsorshipInvitations(f.workspaceId,{limit:20,cursor:null},f.actor)).items).toEqual([])
    const reason={requestId:randomUUID(),reason:'Fictional reviewed cancellation'}
    await expect(store.cancelSponsorshipAllocation(f.workspaceId,id,reason,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.revokeSponsorshipInvitation(f.workspaceId,invitationId,reason,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.issueSponsorshipInvitation(f.workspaceId,invitationInput,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(store.redeemSponsorshipInvitation(f.workspaceId,{token,contactId:f.nomineeId},f.actor)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT status FROM association_sponsorship_allocations WHERE id=$1',[id])).rows[0].status).toBe('active')
    expect((await pool.query('SELECT status FROM association_sponsorship_invitations WHERE id=$1',[invitationId])).rows[0].status).toBe('pending')
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[nomineeDepartment,f.userId])
    await pool.query("UPDATE entities SET compartments='{}',sensitivity='internal' WHERE id=$1",[f.nomineeId])
    const redeemed=await store.redeemSponsorshipInvitation(f.workspaceId,{token,contactId:f.nomineeId},f.actor)
    expect((await pool.query('SELECT scope_snapshot FROM association_memberships WHERE id=$1',[redeemed.record.id])).rows[0].scope_snapshot.compartments.sort()).toEqual(expected)
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[nomineeDepartment,f.userId])
    await expect(store.redeemSponsorshipInvitation(f.workspaceId,{token,contactId:f.nomineeId},f.actor)).rejects.toMatchObject({code:'not_authorized'})
    expect(await store.listMemberships(f.workspaceId,f.nomineeId,{},f.actor)).toEqual([])
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[sponsorDepartment,f.userId])
    expect((await list()).items).toEqual([])
    await expect(store.createSponsorshipAllocation(f.workspaceId,input,f.actor)).rejects.toMatchObject({code:'not_authorized'})
  })

})
