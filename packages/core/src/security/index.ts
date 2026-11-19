export { sanitizeUnicode, sanitizeDeep, redactSecrets, containsSecrets } from '@use-brian/agent-runtime/security/sanitize.js'
export { createRateLimiter } from './rate-limiter.js'
export type { RateLimiterOptions } from './rate-limiter.js'
export {
  RANK,
  SENSITIVITY_VALUES,
  SensitivityAccumulator,
  canRead,
  isSensitivity,
  maxSensitivity,
  minSensitivity,
  researchWriteFloor,
} from '@use-brian/agent-runtime/security/sensitivity.js'
export type { Sensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
export {
  CompartmentAccumulator,
  unionCompartments,
  subsetCompartments,
  CLIENT_COMPARTMENT_PREFIX,
  clientCompartment,
  isClientCompartment,
} from '@use-brian/agent-runtime/security/compartments.js'
export { EvidenceAccumulator, extractFigureClaims, extractFigureKeys } from '@use-brian/agent-runtime/security/evidence.js'
export type {
  EvidenceAccumulatorOptions,
  IdentifierKind,
  UnverifiedIdentifier,
  ClaimKind,
  FigureClaim,
  FigureSource,
} from '@use-brian/agent-runtime/security/evidence.js'
export type { AccessContext, AssistantKind } from '@use-brian/agent-runtime/security/access-context.js'
export {
  ContextScopeAccumulator,
  ContextScopeViolation,
  canonicalScopeGrant,
  intersectScopeGrants,
  normalizeProjectName,
  resolveWriteScope,
  scopeEvidenceFromRows,
  createdRowEvidence,
  scopeGrantContains,
  unionScopeRequirements,
} from '@use-brian/agent-runtime/security/context-scope.js'
export type {
  ResolvedWriteScope,
  ScopeEvidence,
  ScopeGrant,
  TurnScope,
} from '@use-brian/agent-runtime/security/context-scope.js'
export { deriveContextFloor, deriveResourceScope, deriveWriteScope, DerivedScopeError, describeScopeRefusal, resourceScopeKey, sourcesShareVisibility } from '@use-brian/agent-runtime/security/derived-scope.js'
export type { ResourceScope, ScopeSource, DerivedWriteEvidence } from '@use-brian/agent-runtime/security/derived-scope.js'
export { bindScopeSource, boundScopeSource, bindScopeSources, boundScopeSources, inheritScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'

export { pinAccessCeiling, pinAuthoringAuthority, parseAuthoringAuthority, intersectAccessCeilings, accessCeilingContains } from '@use-brian/agent-runtime/security/access-ceiling.js'
export type { AccessCeiling, AuthoringAuthority } from '@use-brian/agent-runtime/security/access-ceiling.js'
export { intersectDepartmentReadGrants, departmentReadGrantJson, intersectProjectAdmissions, mutationProjectAdmissions } from '@use-brian/agent-runtime/security/department-read.js'
export type { DepartmentReadGrant, ProjectAdmission } from '@use-brian/agent-runtime/security/department-read.js'
export { pinToolAuthoringAuthority } from './tool-authority.js'
export { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
export type {
  AttendedExecutionIdentity,
  CreateExecutionContextInput,
  DelegatedExecutionIdentity,
  ExecutionAttribution,
  ExecutionContext,
  ExecutionIdentity,
  ExecutionLifecycle,
  ExecutionOwnership,
  ExecutionSecurityContext,
  ExecutionSurfaceCapabilities,
  ProgrammaticExecutionIdentity,
  ResolvedExecutionAccess,
  SystemExecutionIdentity,
  SystemExecutionPurpose,
} from '@use-brian/agent-runtime/security/execution-context.js'

export { AuthoritySourceSchema, type AuthoritySource } from '@use-brian/agent-runtime/security/authority-source.js'

export { WorkspaceCredentialDelegationSchema, intersectWorkspaceCredentialDelegations, bindWorkspaceCredentialDelegation, workspaceCredentialDelegation } from '@use-brian/agent-runtime/security/workspace-delegation.js'
