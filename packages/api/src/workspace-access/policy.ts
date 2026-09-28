/** Deterministic policy, with all membership/grant facts supplied by the trusted store. */
export type WorkspaceAccessRole = 'owner' | 'admin' | 'member'
export type ManagerCapability = 'manage_members' | 'approve_read_requests'
export const REQUEST_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000
export const DEFAULT_GRANT_DAYS = 30
export const MAX_DELEGATED_GRANT_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export class WorkspaceAccessError extends Error {
  constructor(readonly code: string, readonly status = 403) { super(code) }
}

export function isAccessAdmin(role: WorkspaceAccessRole): boolean { return role === 'owner' || role === 'admin' }

export function grantInterval(input: {now:Date;startsAt?:Date;expiresAt?:Date|null;days?:number}): {startsAt:Date;expiresAt:Date|null} {
  const startsAt = input.startsAt ?? input.now
  const days = input.days ?? DEFAULT_GRANT_DAYS
  if (!Number.isFinite(startsAt.getTime()) || !Number.isInteger(days) || days < 1 || days > MAX_DELEGATED_GRANT_DAYS) {
    throw new WorkspaceAccessError('invalid_grant_interval',400)
  }
  const expiresAt = input.expiresAt === undefined ? new Date(startsAt.getTime() + days * DAY_MS) : input.expiresAt
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= startsAt || expiresAt <= input.now)) {
    throw new WorkspaceAccessError('invalid_grant_interval',400)
  }
  return {startsAt,expiresAt}
}

/** Manager status alone supplies neither this package nor content-read reach. */
export function assertManageTeamMembers(input: {
  role:WorkspaceAccessRole; capabilities:readonly ManagerCapability[]
  ownCompartment:string; readBundle:readonly string[]|null; hasActiveBeneficiaryGrant:boolean
}):void {
  if (isAccessAdmin(input.role)) return
  if (!input.capabilities.includes('manage_members')) throw new WorkspaceAccessError('department_manager_required')
  if (input.readBundle === null || input.readBundle.some(key=>key!==input.ownCompartment) || input.hasActiveBeneficiaryGrant) {
    throw new WorkspaceAccessError('expanded_team_requires_admin')
  }
}

export function assertApproveReadRequest(input: {
  actorUserId:string;role:WorkspaceAccessRole;capabilities:readonly ManagerCapability[]
  requesterUserId:string;beneficiaryKind:'member'|'team';beneficiaryId:string;beneficiaryMemberIds:readonly string[]
  startsAt:Date;expiresAt:Date|null;requestExpiresAt:Date;now:Date;targetActive:boolean;settled?:boolean
}):void {
  if (!input.targetActive || (!input.settled && input.requestExpiresAt <= input.now)) throw new WorkspaceAccessError('request_expired_or_unavailable',409)
  if (input.actorUserId===input.requesterUserId || (input.beneficiaryKind==='member' && input.actorUserId===input.beneficiaryId)
    || (input.beneficiaryKind==='team' && input.beneficiaryMemberIds.includes(input.actorUserId))) {
    throw new WorkspaceAccessError('independent_approver_required')
  }
  if (!input.settled && input.expiresAt && input.expiresAt <= input.now) throw new WorkspaceAccessError('grant_interval_expired',409)
  if (isAccessAdmin(input.role)) return
  if (!input.capabilities.includes('approve_read_requests')) throw new WorkspaceAccessError('department_approver_required')
  if (input.beneficiaryKind==='team' || input.expiresAt===null) throw new WorkspaceAccessError('admin_approval_required')
  if (input.expiresAt.getTime()-input.startsAt.getTime()>MAX_DELEGATED_GRANT_DAYS*DAY_MS) throw new WorkspaceAccessError('admin_approval_required')
}

export type ReadGrant = {
  beneficiaryKind:'member'|'team';beneficiaryId:string;targetCompartment:string
  startsAt:Date;expiresAt:Date|null;revokedAt:Date|null;targetActive:boolean
}

/** Only a human's read projection consumes these grants. Never feed the result
 * into a mutation predicate or an assistant principal's own audience bundle. */
export function resolveGrantedReadCompartments(input: {
  base:readonly string[]|null;userId:string;directTeamIds:ReadonlySet<string>;grants:readonly ReadGrant[];now:Date
}): {compartments:string[]|null;earliestExpiry:Date|null} {
  const result = new Set(input.base ?? [])
  let earliestExpiry:Date|null=null
  for(const grant of input.grants) {
    if (grant.revokedAt || !grant.targetActive || grant.startsAt>input.now || (grant.expiresAt && grant.expiresAt<=input.now))continue
    const beneficiary=grant.beneficiaryKind==='member'?grant.beneficiaryId===input.userId:input.directTeamIds.has(grant.beneficiaryId)
    if(!beneficiary)continue
    result.add(grant.targetCompartment)
    if(grant.expiresAt && (!earliestExpiry || grant.expiresAt<earliestExpiry))earliestExpiry=grant.expiresAt
  }
  return {compartments:input.base===null?null:[...result].sort(),earliestExpiry}
}
