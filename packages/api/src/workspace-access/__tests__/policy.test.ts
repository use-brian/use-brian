import { describe, expect, it } from 'vitest'
import { assertApproveReadRequest, assertManageTeamMembers, grantInterval, resolveGrantedReadCompartments, type ReadGrant } from '../policy.js'

const now=new Date('2026-01-01T00:00:00Z'),end=new Date('2026-01-31T00:00:00Z')
const approval={actorUserId:'approver',role:'member' as const,capabilities:['approve_read_requests' as const],requesterUserId:'requester',beneficiaryKind:'member' as const,beneficiaryId:'beneficiary',beneficiaryMemberIds:[],startsAt:now,expiresAt:end,requestExpiresAt:new Date('2026-01-15T00:00:00Z'),now,targetActive:true}
describe('[COMP:api/workspace-access] independent management and read-grant policy',()=>{
  it('defaults to 30 days and rejects expired or inverted intervals',()=>{
    expect(grantInterval({now})).toEqual({startsAt:now,expiresAt:end})
    expect(()=>grantInterval({now,days:91})).toThrow('invalid_grant_interval')
    expect(()=>grantInterval({now,expiresAt:now})).toThrow('invalid_grant_interval')
    expect(grantInterval({now,expiresAt:null}).expiresAt).toBeNull()
  })
  it('requires the exact delegated capability and blocks distribution of an expanded Team package',()=>{
    const input={role:'member' as const,capabilities:['manage_members' as const],ownCompartment:'team:research',readBundle:['team:research'],hasActiveBeneficiaryGrant:false}
    expect(()=>assertManageTeamMembers(input)).not.toThrow()
    for(const extra of [{readBundle:null},{readBundle:['team:research','team:finance']},{hasActiveBeneficiaryGrant:true}])expect(()=>assertManageTeamMembers({...input,...extra})).toThrow('expanded_team_requires_admin')
    expect(()=>assertManageTeamMembers({...input,capabilities:[]})).toThrow('department_manager_required')
    expect(()=>assertManageTeamMembers({...input,role:'admin',readBundle:null})).not.toThrow()
  })
  it('forbids self approval even for an owner or a member of a Team beneficiary',()=>{
    for(const role of ['owner','admin','member'] as const){
      expect(()=>assertApproveReadRequest({...approval,role,actorUserId:'requester'})).toThrow('independent_approver_required')
      expect(()=>assertApproveReadRequest({...approval,role,actorUserId:'beneficiary'})).toThrow('independent_approver_required')
      expect(()=>assertApproveReadRequest({...approval,role,beneficiaryKind:'team',beneficiaryMemberIds:['approver']})).toThrow('independent_approver_required')
    }
  })
  it('limits delegated approvals to individual finite grants of at most 90 days',()=>{
    expect(()=>assertApproveReadRequest(approval)).not.toThrow()
    for(const extra of [{expiresAt:null},{beneficiaryKind:'team' as const},{expiresAt:new Date('2026-04-02T00:00:00Z')}]){
      expect(()=>assertApproveReadRequest({...approval,...extra})).toThrow('admin_approval_required')
      expect(()=>assertApproveReadRequest({...approval,...extra,role:'admin'})).not.toThrow()
    }
    expect(()=>assertApproveReadRequest({...approval,expiresAt:new Date('2026-04-01T00:00:00Z')})).not.toThrow()
    expect(()=>assertApproveReadRequest({...approval,requestExpiresAt:now})).toThrow('request_expired_or_unavailable')
    expect(()=>assertApproveReadRequest({...approval,targetActive:false})).toThrow('request_expired_or_unavailable')
  })
  it('adds only exact target compartments for live direct human beneficiaries and exposes the expiry boundary',()=>{
    const base=['team:own'];const grant:ReadGrant={beneficiaryKind:'member',beneficiaryId:'reader',targetCompartment:'team:finance',startsAt:now,expiresAt:end,revokedAt:null,targetActive:true}
    const input={base,userId:'reader',directTeamIds:new Set(['team-beneficiary']),grants:[grant,{...grant,beneficiaryKind:'team' as const,beneficiaryId:'team-beneficiary',targetCompartment:'team:product'}],now}
    expect(resolveGrantedReadCompartments(input)).toEqual({compartments:['team:finance','team:own','team:product'],earliestExpiry:end})
    expect(base).toEqual(['team:own'])
    expect(resolveGrantedReadCompartments({...input,now:end})).toEqual({compartments:base,earliestExpiry:null})
    expect(resolveGrantedReadCompartments({...input,userId:'stranger',directTeamIds:new Set()})).toEqual({compartments:base,earliestExpiry:null})
    for(const extra of [{revokedAt:now},{targetActive:false},{startsAt:new Date('2026-01-02T00:00:00Z')}])expect(resolveGrantedReadCompartments({...input,grants:[{...grant,...extra}]}).compartments).toEqual(base)
  })
})
