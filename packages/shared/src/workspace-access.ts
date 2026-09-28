/** Organization commands shared by the web UI, API and Brian. */
export type OrganizationVisibility = 'members' | 'workspace'
export type OrganizationUnit = {
  id: string; parentId: string | null; name: string; position: number
  teamId: string | null; teamName: string | null
  directoryVisibility: OrganizationVisibility; version: string
}
export type OrganizationSubject = { id: string; kind: 'member' | 'assistant'; name: string }
export type OrganizationPlacement = {
  id: string; unitId: string; userId: string | null; assistantId: string | null
  isPrimary: boolean; reportsToUserId: string | null; accountableUserId: string | null; version: string
}
export type OrganizationChart = {
  appliedCommand?:{type:OrganizationCommand['type'];subjectId:string;auditEventId:string}
  commandReceipt?:{reviewId:string;replayed:boolean}
  validForMs:number
  workspaceId: string; revision: string; canManage: boolean
  units: OrganizationUnit[]; placements: OrganizationPlacement[]; subjects: OrganizationSubject[]
  teams: Array<{ id: string; name: string }>
  /** Admin-only direct assignments. Absent from member directory projections. */
  initialization?: { policyRevision: string; candidates: Array<{ subjectId: string; kind: 'member' | 'assistant'; teamIds: string[] }> }
}
export type OrganizationCommand =
  | { type: 'org.initialize.subject'; subjectId: string; kind: 'member' | 'assistant'; teamId: string; expectedRevision: string; expectedPolicyRevision: string }
  | { type: 'org.unit.save'; id?: string; expectedVersion?: string; name: string; parentId: string | null; teamId: string | null; directoryVisibility: OrganizationVisibility; position: number }
  | { type: 'org.unit.archive'; id: string; expectedVersion: string; destinationId: string | null }
  | { type: 'org.placement.save'; id?: string; expectedVersion?: string; unitId: string; userId: string | null; assistantId: string | null; isPrimary: boolean; reportsToUserId: string | null; accountableUserId: string | null }
  | { type: 'org.placement.remove'; id: string; expectedVersion: string }

export type DepartmentAccessCommand =
  | {type:'workspace.classification.set';mode:'strict';expectedPolicyRevision:string;expectedInventoryRevision:string}
  | {type:'assistant.clearance.set';assistantId:string;clearance:'public'|'internal'|'confidential'}
  | {type:'member.access.set';userId:string;clearance:'public'|'internal'|'confidential';teamScopeMode:'legacy'|'assigned';expectedPolicyRevision:string}
  | {type:'assistant.audience.set';assistantId:string;teamMode:'all'|'assigned';teamIds:string[];defaultGroupId:string|null;projectMode:'all'|'assigned';projectIds:string[];defaultProjectId:string|null}
  | {type:'department.create';name:string;key:string;description?:string|null;color?:string|null;readAll?:boolean}
  | {type:'department.update';teamId:string;name?:string;description?:string|null;color?:string|null;status?:'active'}
  | {type:'department.archive';teamId:string}
  | {type:'department.read_bundle.set';teamId:string;readAll:boolean;groupIds:string[]}
  | {type:'department.assistant.set';teamId:string;assistantId:string;enabled:boolean}
  | {type:'department.configure';teamId:string;directoryVisibility:OrganizationVisibility;requestable:boolean}
  | {type:'department.manager.set';teamId:string;userId:string;capabilities:Array<'manage_members'|'approve_read_requests'>}
  | {type:'department.member.set';teamId:string;userId:string;enabled:boolean;activateAssigned?:boolean}
  | {type:'access.request.create';targetTeamId:string;beneficiaryKind:'member'|'team';beneficiaryId:string;reason:string;days:number;ongoing:boolean;startsAt?:string}
  | {type:'access.request.decide';requestId:string;expectedVersion:string;payloadHash:string;policyRevision:string;decision:'approved'|'rejected';reason?:string}
  | {type:'access.request.cancel';requestId:string;expectedVersion:string}
  | {type:'access.request.assign';requestId:string}
  | {type:'access.grant.revoke';grantId:string;reason:string}

export type DepartmentAccessTeam = {
  id:string;name:string;directoryVisibility:OrganizationVisibility;requestable:boolean
  canManageMembers:boolean;canApprove:boolean;expandedPackage:boolean
  memberIds:string[];assistantIds:string[];managerIds:string[]
  managers:Array<{userId:string;capabilities:Array<'manage_members'|'approve_read_requests'>}>
}
export type DepartmentAccessRequest = {
  id:string;targetTeamId:string;targetTeamName:string;requesterUserId:string
  beneficiaryKind:'member'|'team';beneficiaryId:string;beneficiaryName:string|null
  reason:string;startsAt:string;expiresAt:string|null;requestExpiresAt:string
  status:'pending'|'approved'|'rejected'|'cancelled'|'expired'|'superseded'
  version:string;payloadHash:string;approvalId:string|null;canDecide:boolean;canCancel:boolean
}
export type DepartmentReadGrant = {
  status:'scheduled'|'active'|'expired'|'revoked'
  id:string;requestId:string;targetTeamId:string;targetTeamName:string
  beneficiaryKind:'member'|'team';beneficiaryId:string;beneficiaryName:string|null
  startsAt:string;expiresAt:string|null;revokedAt:string|null;approvedBy:string;canRevoke:boolean
}
export type WorkspaceAccessOverview = {
  appliedCommand?:{type:DepartmentAccessCommand['type'];subjectId:string;auditEventId?:string}
  commandReceipt?:{reviewId:string;replayed:boolean}
  nextRequestCursor?:string|null;nextGrantCursor?:string|null
  validForMs:number
  readiness: DepartmentalReadiness
  workspaceId:string;policyRevision:string;classificationMode:'legacy'|'review'|'strict';canAdminister:boolean
  teams:DepartmentAccessTeam[];requests:DepartmentAccessRequest[];grants:DepartmentReadGrant[]
  people:Array<{id:string;name:string;role:'owner'|'admin'|'member';access?:{clearance:'public'|'internal'|'confidential';effectiveClearance:'public'|'internal'|'confidential';teamScopeMode:'legacy'|'assigned';readTeamIds:string[]|null;membershipTeamIds:string[]|null;hasUnlistedReadScope:boolean;hasUnlistedMembershipScope:boolean}}>
}

/** Server evidence, never an activation value accepted from a client. */
export type DepartmentalReadiness = {
  ready: boolean
  enforcementVersion: number
  requiredEnforcementVersion: number
  missingCapabilities: string[]
}

export type ScopeReviewKind =
  | 'memory'|'entity'|'entity_link'|'task'|'workspace_file'|'episode'|'knowledge_entry'|'kb_chunk'
  | 'crm_event'|'memory_verification'|'brain_verification'|'correction_audit'
  | 'session_message'|'feedback_event'|'workspace_skill_revision'
  | 'file_cache'|'file_segment'|'recording'|'transcript_segment'
  | 'entity_instance'|'blueprint_record'|'office_artifact'
export type ScopeReviewAction = 'confirm_general'|'assign_team'|'hold'
export type ScopeReviewCommand =
  | {type:'scope.review.preview';resourceKind:ScopeReviewKind;resourceIds:string[];action:ScopeReviewAction;targetTeamId:string|null;reason:string}
  | {type:'scope.review.apply'|'scope.review.cancel';reviewId:string;expectedVersion:string;payloadHash:string}
export type ScopeReviewSource = {
  workspaceId:string;resourceKind:ScopeReviewKind;resourceId:string;version:string
  userId:string|null;assistantId:string|null;sensitivity:string|null;compartments:string[]|null;projectIds:string[]|null
  held:boolean;validTo:string|null;retractedAt:string|null
}
export type ScopeReviewContent = {title:string;text:string}
export type ScopeReviewSummary = {
  id:string;workspaceId:string;resourceKind:ScopeReviewKind;action:ScopeReviewAction;targetTeamId:string|null
  targetCompartment:string|null;reason:string;payloadHash:string;selectionRevision:string;policyRevision:string;version:string
  status:'preview'|'running'|'complete'|'stale'|'cancelled'
}
export type ScopeReview = ScopeReviewSummary & {
  completeCoverage:boolean;validForMs:number
  items:Array<{resourceId:string;resourceVersion:string;source:ScopeReviewSource;content:ScopeReviewContent|null;impact:ScopeReviewImpact|null;status:'pending'|'applied'|'stale'|'cancelled';resultVersion:string|null;errorCode:string|null}>
}
export type ScopeReviewImpact =
  | {version:1;descendants:Array<{resourceId:string;version:string;held:boolean}>}
  | {version:2;descendants:Array<{resourceKind:ScopeReviewKind;resourceId:string;version:string;held:boolean}>;dependents:Record<string,string>}
export type ScopeReviewCoverageFamily = {
  family:string;category:'source'|'impact'|'binding'|'job';total:string;unresolved:string;held:string
}
export type ScopeReviewCoverage = {
  registryRevision:string;unresolved:string;families:ScopeReviewCoverageFamily[]
}
export type ScopeReviewInventory = {
  validForMs:number;resourceKind:ScopeReviewKind;total:string;nextCursor:string|null;supportedKinds:ScopeReviewKind[]
  items:Array<{id:string;version:string;held:boolean;sensitivity:string|null;compartments:string[]|null;projectIds:string[]|null;userId:string|null;assistantId:string|null;canClassify:boolean;allowedActions:ScopeReviewAction[];content:ScopeReviewContent}>
  registryRevision:string;reviewedInventoryRevision:string|null;coverage:ScopeReviewCoverage
  policyRevision:string;classificationMode:'legacy'|'review'|'strict';readiness:DepartmentalReadiness;canActivateStrict:boolean
  completeCoverage:boolean;uncovered:string[];recentReviews:ScopeReviewSummary[];nextReviewCursor:string|null;selectedReview:ScopeReview|null
}

/** A review is bound to the verified actor by the server, never by these fields. */
export type DepartmentCommandIntent = {command:DepartmentAccessCommand;expectedPolicyRevision:string;idempotencyKey:string}
export type DepartmentCommandApply = {type:'access.command.apply';reviewId:string;payloadHash:string}
export type DepartmentCommandReview = {
  id:string;payloadHash:string;policyRevision:string;expiresAt:string;validForMs:number;alreadyApplied?:boolean
  command:DepartmentAccessCommand
  changes:Array<{field:string;before:Array<{kind:'text'|'code';value:string}>;after:Array<{kind:'text'|'code';value:string}>}>
}


export type OrganizationCommandIntent = {command:OrganizationCommand;expectedRevision:string;expectedPolicyRevision:string;idempotencyKey:string}
export type OrganizationCommandApply = {type:'org.command.apply';reviewId:string;payloadHash:string}
export type OrganizationCommandReview = {
  id:string;payloadHash:string;policyRevision:string;revision:string;expiresAt:string;validForMs:number;alreadyApplied?:boolean
  command:OrganizationCommand
  effects:Array<{kind:'unit'|'placement';name:string;changes:DepartmentCommandReview['changes']}>
}

export type WorkspaceAccessHistoryQuery = {after?:string;expectedPolicyRevision?:string}
export type WorkspaceAccessHistory = {
  kind:'requests'|'grants';workspaceId:string;policyRevision:string;validForMs:number;nextCursor:string|null
  requests:DepartmentAccessRequest[];grants:DepartmentReadGrant[]
}


export type WorkspaceAccessExplanationQuery = {
  memberId?:string;assistantId?:string;contextTeamId?:string;contextProjectId?:string
  targetTeamId?:string;action?:'read'|'edit';sensitivity?:'public'|'internal'|'confidential'
  expectedPolicyRevision?:string
}
export type WorkspaceAccessExplanation = {
  workspaceId:string;policyRevision:string;validForMs:number
  memberId:string;assistantId:string|null;contextTeamId:string|null;contextProjectId:string|null
  clearance:'public'|'internal'|'confidential'
  choices:{assistants:Array<{id:string;name:string}>;projects:Array<{id:string;name:string}>}
  readTeamIds:string[]|null;mutationTeamIds:string[]|null
  projectIds:string[]|null
  paths:Array<{kind:'trusted_role'|'legacy'|'membership'|'read_grant'|'team_read_grant';sourceTeamId:string|null;targetTeamIds:string[]|null;grantId:string|null;expiresAt:string|null}>
  management:Array<{teamId:string;canManageMembers:boolean;canApprove:boolean}>
  example:{targetTeamId:string|null;action:'read'|'edit';sensitivity:'public'|'internal'|'confidential';matchesScope:boolean;resourceAuthorizationRequired:true}
}
export type WorkspaceAccessEvents = {
  workspaceId:string;policyRevision:string;validForMs:number;nextCursor:string|null
  events:Array<{id:string;kind:string;createdAt:string;policyRevision:string;actor:{id:string;name:string}|null;subjectId:string|null}>
}

/** One authorized, expiring snapshot for department configuration and native inspection. */
export type WorkspaceDepartmentRegistry = {
  workspaceId:string;policyRevision:string;directoryRevision:string;validForMs:number;canAdminister:boolean
  teams:Array<{id:string;name:string;key:string;description:string|null;color:string|null;status:'active';readAll:boolean;readGrantGroupIds:string[];memberIds:string[];assistantIds:string[];orgUnits:Array<{id:string;name:string}>}>
  people:Array<{id:string;name:string}>
  assistants:Array<{id:string;name:string}>
  requestPolicy:{defaultDays:number;maxDays:number;ongoingAdminOnly:true}
}
