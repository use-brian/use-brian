import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {getPool,getAppPool,query} from '../client.js'
import * as decisionEvents from '../decision-event-store.js'
import {createPendingApprovalsStore} from '../pending-approvals-store.js'
import {createBrowserProfileStore} from '../browser-profile-store.js'
import {createBrowserSkillGrantStore} from '../browser-skill-grant-store.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
afterAll(async()=>{await getAppPool().end();await getPool().end()})

describe('[COMP:sandbox/approval-grants] human grant mutation authority',()=>{
 it('preserves grants after revocation or stale classification and confines admitted revocation to its profile',async()=>{
  const owner=randomUUID(),custodian=randomUUID(),workspace=randomUUID(),department=randomUUID(),skill=randomUUID()
  for(const user of [owner,custodian])await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional grant fixture','test',$2)",[workspace,custodian])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential')",[workspace,custodian,owner])
  await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
  await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspace])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,department,owner])
  await query("INSERT INTO browser_skills(id,workspace_id,name,site,code,contract,origin,created_by) VALUES($1,$2,'Fictional block','portal.example','pass','{}','assistant',$3)",[skill,workspace,owner])
  const profiles=createBrowserProfileStore(),grants=createBrowserSkillGrantStore()
  const profile=await profiles.create({workspaceId:workspace,ownerUserId:owner,name:'Grant identity',departmentId:department,scope:'workspace'},{userId:owner})
  const other=await profiles.create({workspaceId:workspace,ownerUserId:owner,name:'Other identity'},{userId:owner})
  const grant=await grants.create({workspaceId:workspace,profileId:profile.id,skillId:skill,grantedBy:owner})
  const foreign=await grants.create({workspaceId:workspace,profileId:other.id,skillId:skill,grantedBy:owner})
  const status=async(id:string)=>(await query('SELECT status FROM browser_skill_grants WHERE id=$1',[id])).rows[0].status
  const replacement={workspaceId:workspace,profileId:profile.id,skillId:skill,grantedBy:owner}
  await expect(grants.create({...replacement,grantedBy:custodian})).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await status(grant.id)).toBe('active')
  // The revoke preceding INSERT must roll back when the new row cannot be stored.
  await expect(grants.create({...replacement,budgetUsd:1e20})).rejects.toMatchObject({code:'22003'})
  expect(await status(grant.id)).toBe('active')
  await query("UPDATE browser_skills SET status='archived' WHERE id=$1",[skill])
  await expect(grants.create(replacement)).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await status(grant.id)).toBe('active')
  await query("UPDATE browser_skills SET status='active' WHERE id=$1",[skill])
  await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
  await expect(grants.revoke(grant.id,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
  await expect(grants.create(replacement)).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await status(grant.id)).toBe('active')
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
  const changed=await profiles.update(profile.id,{scope:'owner'})
  await expect(grants.revoke(grant.id,profile)).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await status(grant.id)).toBe('active')
  await grants.revoke(foreign.id,changed!)
  expect(await status(foreign.id)).toBe('active')
  await grants.revoke(grant.id,changed!)
  expect(await status(grant.id)).toBe('revoked')
  const expiresAt=new Date(Date.now()+3600000).toISOString()
  const renewed=await grants.create({...replacement,budgetUsd:4.25,ratePerHour:3,expiresAt})
  expect(renewed).toMatchObject({...replacement,budgetUsd:4.25,ratePerHour:3,expiresAt,spentUsd:0,status:'active'})
  const replaced=await grants.create(replacement)
  expect(await status(renewed.id)).toBe('revoked')
  expect(await status(replaced.id)).toBe('active')
  expect((await grants.list({workspaceId:workspace,profileId:profile.id})).filter(row=>row.status==='active').map(row=>row.id)).toEqual([replaced.id])
  const approvals=createPendingApprovalsStore()
  const sourceDepartment=randomUUID(),sourceAssistant=randomUUID(),sourceSession=randomUUID()
  await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Review source',$3,'team',$1::text,$4)",[sourceDepartment,workspace,custodian,`team:${sourceDepartment}`])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,sourceDepartment,owner])
  await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Review fixture assistant',$2,'primary','confidential',$3)",[sourceAssistant,workspace,custodian])
  await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,visibility,effective_clearance,context_compartments,context_group_id,status,title) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'owner','confidential',$5,$6,'running','Review fixture')",[sourceSession,workspace,sourceAssistant,owner,[`team:${sourceDepartment}`],sourceDepartment])
  const request={workspaceId:workspace,approverUserId:owner,sessionId:sourceSession,payload:{profileId:profile.id,skillId:skill,skillVersion:1}}
  const expired=await approvals.createBrowserSkillSend({...request,expiresAt:new Date(Date.now()-1000)})
  await expect(approvals.respondBrowserSkill!(expired.id,owner,'approved',{grantAlways:true})).rejects.toMatchObject({code:'profile_authority_denied'})
  expect((await approvals.getByIdSystem(expired.id))?.status).toBe('pending')
  expect(await status(replaced.id)).toBe('active')
  const legacy=await approvals.createBrowserSkillSend({...request,payload:{profileId:profile.id,skillId:skill}})
  await expect(approvals.respondBrowserSkill!(legacy.id,owner,'approved',{grantAlways:true})).rejects.toMatchObject({code:'profile_authority_denied'})
  const stale=await approvals.createBrowserSkillSend(request)
  await query('UPDATE browser_skills SET version=version+1 WHERE id=$1',[skill])
  await expect(approvals.respondBrowserSkill!(stale.id,owner,'approved',{grantAlways:true})).rejects.toMatchObject({code:'profile_authority_denied'})
  expect((await approvals.getByIdSystem(stale.id))?.status).toBe('pending')
  expect(await status(replaced.id)).toBe('active')
  request.payload.skillVersion=2
  const pending=await approvals.createBrowserSkillSend(request)
  await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
  await expect(approvals.respondBrowserSkill!(pending.id,owner,'approved',{grantAlways:true})).rejects.toMatchObject({code:'profile_authority_denied'})
  await expect(approvals.respondBrowserSkill!(pending.id,owner,'approved')).rejects.toMatchObject({code:'profile_authority_denied'})
  await expect(approvals.respondBrowserSkill!(pending.id,owner,'rejected')).rejects.toMatchObject({code:'profile_authority_denied'})
  expect((await approvals.getByIdSystem(pending.id))?.status).toBe('pending')
  expect(await status(replaced.id)).toBe('active')
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
  const auditFailure=vi.spyOn(decisionEvents,'appendDecisionEvent').mockRejectedValueOnce(new Error('Fictional audit failure'))
  try {
   await expect(approvals.respondBrowserSkill!(pending.id,owner,'approved',{grantAlways:true})).rejects.toThrow('Fictional audit failure')
  } finally { auditFailure.mockRestore() }
  expect((await approvals.getByIdSystem(pending.id))?.status).toBe('pending')
  expect(await status(replaced.id)).toBe('active')
  const once=await approvals.createBrowserSkillSend({...request,payload:{...request.payload,ceiling:'manual review required'}})
  const onceResult=await approvals.respondBrowserSkill!(once.id,owner,'approved')
  expect(onceResult?.approval.status).toBe('approved')
  expect(onceResult?.grantId).toBeNull()
  expect(await status(replaced.id)).toBe('active')
  const rejected=await approvals.respondBrowserSkill!(legacy.id,owner,'rejected',{reason:'Stale review'})
  expect(rejected?.approval.status).toBe('rejected')
  expect(rejected?.approval.rejectReason).toBe('Stale review')
  expect(rejected?.grantId).toBeNull()
  await expect(approvals.respondBrowserSkill!(stale.id,owner,'approved')).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await approvals.respond(stale.id,'approved',owner)).toBeNull()
  expect((await approvals.getByIdSystem(stale.id))?.status).toBe('pending')
  const appendDecision=decisionEvents.appendDecisionEvent
  const lockProbe=vi.spyOn(decisionEvents,'appendDecisionEvent').mockImplementationOnce(async (...args)=>{
   const contender=await getPool().connect()
   try {
    await contender.query('BEGIN')
    await contender.query("SET LOCAL lock_timeout='100ms'")
    await expect(contender.query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3',[workspace,sourceDepartment,owner])).rejects.toMatchObject({code:'55P03'})
   } finally { await contender.query('ROLLBACK'); contender.release() }
   return appendDecision(...args)
  })
  const lockedApproval=await approvals.createBrowserSkillSend(request)
  try { expect((await approvals.respondBrowserSkill!(lockedApproval.id,owner,'approved'))?.approval.status).toBe('approved') }
  finally { lockProbe.mockRestore() }
  await query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '2 seconds' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3",[workspace,sourceDepartment,owner])
  const expiryProbe=vi.spyOn(decisionEvents,'appendDecisionEvent').mockImplementationOnce(async (...args)=>{
   await new Promise(resolve=>setTimeout(resolve,2200))
   return appendDecision(...args)
  })
  try { await expect(approvals.respondBrowserSkill!(pending.id,owner,'approved',{grantAlways:true})).rejects.toMatchObject({code:'profile_authority_denied'}) }
  finally { expiryProbe.mockRestore() }
  expect((await approvals.getByIdSystem(pending.id))?.status).toBe('pending')
  expect(await status(replaced.id)).toBe('active')
  expect((await query("SELECT id FROM decision_events WHERE source_id=$1",[pending.id])).rows).toHaveLength(0)
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3',[workspace,sourceDepartment,owner])
  const results=await Promise.all([approvals.respondBrowserSkill!(pending.id,owner,'approved',{grantAlways:true}),approvals.respondBrowserSkill!(pending.id,owner,'approved',{grantAlways:true})])
  expect(results.filter(Boolean)).toHaveLength(1)
  const settled=results.find(Boolean)!
  expect(settled.approval.status).toBe('approved')
  expect(await status(replaced.id)).toBe('revoked')
  expect(await status(settled.grantId!)).toBe('active')
  expect((await grants.findActive(replacement))?.skillVersion).toBe(2)
  expect((await query("SELECT id FROM decision_events WHERE source_id=$1 AND event_kind='approval.decided'",[pending.id])).rows).toHaveLength(1)

  expect(await grants.recordUse(replaced.id)).toEqual({withinBudget:false,withinRate:false})
  expect(await grants.recordUse(settled.grantId!)).toEqual({withinBudget:true,withinRate:true})
  const uses=async()=>(await query('SELECT window_use_count FROM browser_skill_grants WHERE id=$1',[settled.grantId])).rows[0].window_use_count
  expect(await uses()).toBe(1)
  await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
  expect(await grants.findActive(replacement)).toBeNull()
  expect(await grants.recordUse(settled.grantId!)).toEqual({withinBudget:false,withinRate:false})
  expect(await uses()).toBe(1)
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
  await query("UPDATE pending_approvals SET approval_payload=jsonb_set(approval_payload,'{skillVersion}','1') WHERE id=$1",[pending.id])
  expect(await grants.findActive(replacement)).toBeNull()
  expect(await grants.recordUse(settled.grantId!)).toEqual({withinBudget:false,withinRate:false})
  expect(await uses()).toBe(1)
  await query("UPDATE pending_approvals SET approval_payload=jsonb_set(approval_payload,'{skillVersion}','2') WHERE id=$1",[pending.id])
  await query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3',[workspace,sourceDepartment,owner])
  expect((await profiles.get(profile.id))?.departmentId).toBe(department)
  expect(await grants.findActive(replacement)).toBeNull()
  expect(await grants.recordUse(settled.grantId!)).toEqual({withinBudget:false,withinRate:false})
  expect(await uses()).toBe(1)
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,sourceDepartment,owner])
  expect((await grants.findActive(replacement))?.id).toBe(settled.grantId)
  await query('DELETE FROM pending_approvals WHERE id=$1',[pending.id])
  expect(await grants.findActive(replacement)).toBeNull()
  expect(await grants.recordUse(settled.grantId!)).toEqual({withinBudget:false,withinRate:false})
  expect(await uses()).toBe(1)

  const unassigned=await profiles.create({workspaceId:workspace,ownerUserId:owner,name:'Classification fixture',scope:'workspace'})
  const classification={userId:owner,departmentId:department,reason:'Assign fictional operations',confirmed:true,expected:unassigned}
  await expect(profiles.classifyDepartment!(unassigned.id,{...classification,confirmed:false})).rejects.toMatchObject({code:'confirmation_required'})
  await expect(profiles.classifyDepartment!(unassigned.id,{...classification,userId:custodian})).rejects.toMatchObject({code:'profile_authority_denied'})
  await expect(profiles.classifyDepartment!(unassigned.id,{...classification,departmentId:randomUUID()})).rejects.toMatchObject({code:'profile_authority_denied'})
  const classified=await profiles.classifyDepartment!(unassigned.id,classification)
  expect(classified.departmentId).toBe(department)
  expect(classified.clearance).toBe(unassigned.clearance)
  const classificationGrant=await grants.create({workspaceId:workspace,profileId:classified.id,skillId:skill,grantedBy:owner})
  const transfer={...classification,departmentId:sourceDepartment,expected:classified}
  await expect(profiles.classifyDepartment!(classified.id,transfer)).rejects.toMatchObject({code:'admin_confirmation_required'})
  expect(await status(classificationGrant.id)).toBe('active')
  await query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
  await expect(profiles.classifyDepartment!(classified.id,{...transfer,departmentId:null})).rejects.toMatchObject({code:'department_required'})
  // A database rejection after the profile/grant writes must roll back both.
  // This constraint exists only inside the isolated local fixture database.
  await query("ALTER TABLE context_scope_reclassification_events ADD CONSTRAINT classification_audit_failure_fixture CHECK (reason <> 'Fictional rejected classification audit') NOT VALID")
  try {
   await expect(profiles.classifyDepartment!(classified.id,{...transfer,reason:'Fictional rejected classification audit'})).rejects.toMatchObject({code:'23514'})
  } finally {
   await query('ALTER TABLE context_scope_reclassification_events DROP CONSTRAINT classification_audit_failure_fixture')
  }
  expect((await profiles.get(classified.id))?.departmentId).toBe(department)
  expect(await status(classificationGrant.id)).toBe('active')
  expect((await query("SELECT id FROM context_scope_reclassification_events WHERE primitive='browser_profile' AND row_id=$1",[classified.id])).rows).toHaveLength(1)
  // Administrator status does not replace current authority on either side.
  for (const deniedDepartment of [department,sourceDepartment]) {
   await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3",[workspace,deniedDepartment,owner])
   try {
    await expect(profiles.classifyDepartment!(classified.id,transfer)).rejects.toMatchObject({code:'profile_authority_denied'})
    expect((await profiles.get(classified.id))?.departmentId).toBe(department)
    expect(await status(classificationGrant.id)).toBe('active')
   } finally {
    await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3',[workspace,deniedDepartment,owner])
   }
  }
  const transferred=await profiles.classifyDepartment!(classified.id,transfer)
  expect(transferred.departmentId).toBe(sourceDepartment)
  expect(await status(classificationGrant.id)).toBe('revoked')
  await expect(profiles.classifyDepartment!(classified.id,transfer)).rejects.toMatchObject({code:'profile_changed'})
  const auditRows=(await query("SELECT previous_compartments,next_compartments,widening FROM context_scope_reclassification_events WHERE primitive='browser_profile' AND row_id=$1 ORDER BY created_at",[classified.id])).rows
  expect(auditRows).toEqual([
   {previous_compartments:[],next_compartments:[`team:${department}`],widening:false},
   {previous_compartments:[`team:${department}`],next_compartments:[`team:${sourceDepartment}`],widening:true},
  ])

  const agentProfile=await profiles.create({workspaceId:workspace,ownerUserId:owner,name:'Fictional agent classification',scope:'owner',clearance:'internal',enabledAssistantIds:[sourceAssistant]},{userId:owner})
  const agentRead={workspaceId:workspace,userId:owner,assistantId:sourceAssistant,base:'confidential' as const,
   departments:{[department]:'confidential' as const,[sourceDepartment]:'confidential' as const},contextDepartment:null,binding:null,cap:null}
  const agentCommand={...classification,expected:agentProfile,agentRead}
  await query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2',[workspace,sourceAssistant])
  // The human is an administrator, but the assistant has no destination edge.
  await expect(profiles.classifyDepartment!(agentProfile.id,agentCommand)).rejects.toMatchObject({code:'profile_authority_denied'})
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'public','store')",[workspace,department,sourceAssistant])
  await expect(profiles.classifyDepartment!(agentProfile.id,agentCommand)).rejects.toMatchObject({code:'profile_authority_denied'})
  await query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND department_id=$2 AND assistant_id=$3",[workspace,department,sourceAssistant])
  await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3",[workspace,department,owner])
  await expect(profiles.classifyDepartment!(agentProfile.id,agentCommand)).rejects.toMatchObject({code:'profile_authority_denied'})
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3',[workspace,department,owner])
  for (const ceiling of [
   {...agentRead,userId:custodian},
   {...agentRead,assistantId:null},
   {...agentRead,departments:{[department]:'public' as const}},
   {...agentRead,base:'public' as const},
   {...agentRead,cap:'public' as const},
   {...agentRead,binding:[sourceDepartment]},
   {...agentRead,contextDepartment:sourceDepartment},
  ]) await expect(profiles.classifyDepartment!(agentProfile.id,{...agentCommand,agentRead:ceiling})).rejects.toMatchObject({code:'profile_authority_denied'})
  await query('UPDATE browser_profiles SET enabled_assistant_ids=\'{}\' WHERE id=$1',[agentProfile.id])
  await expect(profiles.classifyDepartment!(agentProfile.id,agentCommand)).rejects.toMatchObject({code:'profile_authority_denied'})
  await query('UPDATE browser_profiles SET enabled_assistant_ids=$2::uuid[] WHERE id=$1',[agentProfile.id,[sourceAssistant]])
  await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND assistant_id=$2",[workspace,sourceAssistant])
  await expect(profiles.classifyDepartment!(agentProfile.id,agentCommand)).rejects.toMatchObject({code:'profile_authority_denied'})
  expect((await profiles.get(agentProfile.id))?.departmentId).toBeNull()
  expect((await query("SELECT id FROM context_scope_reclassification_events WHERE primitive='browser_profile' AND row_id=$1",[agentProfile.id])).rows).toHaveLength(0)
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND assistant_id=$2',[workspace,sourceAssistant])
  expect((await profiles.classifyDepartment!(agentProfile.id,{...agentCommand,agentRead:{...agentRead,contextDepartment:department}})).departmentId).toBe(department)

 },15000)
})
