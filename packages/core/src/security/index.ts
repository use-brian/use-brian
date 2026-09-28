export { sanitizeUnicode, sanitizeDeep, redactSecrets, containsSecrets } from './sanitize.js'
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
} from './sensitivity.js'
export type { Sensitivity } from './sensitivity.js'
export {
  CompartmentAccumulator,
  unionCompartments,
  subsetCompartments,
  CLIENT_COMPARTMENT_PREFIX,
  clientCompartment,
  isClientCompartment,
} from './compartments.js'
export { EvidenceAccumulator, extractFigureClaims, extractFigureKeys } from './evidence.js'
export type {
  EvidenceAccumulatorOptions,
  IdentifierKind,
  UnverifiedIdentifier,
  ClaimKind,
  FigureClaim,
  FigureSource,
} from './evidence.js'
export type { AccessContext, AssistantKind } from './access-context.js'
export {
  ContextScopeAccumulator,
  ContextScopeViolation,
  canonicalScopeGrant,
  intersectScopeGrants,
  normalizeProjectName,
  resolveWriteScope,
  scopeEvidenceFromRows,
  scopeGrantContains,
  unionScopeRequirements,
} from './context-scope.js'
export type {
  ResolvedWriteScope,
  ScopeEvidence,
  ScopeGrant,
  TurnScope,
} from './context-scope.js'
export { deriveResourceScope, DerivedScopeError, resourceScopeKey } from './derived-scope.js'
export type { ResourceScope, ScopeSource, DerivedWriteEvidence } from './derived-scope.js'
export { bindScopeSource, boundScopeSource } from './source-evidence.js'

export { pinAccessCeiling, pinAuthoringAuthority, parseAuthoringAuthority, intersectAccessCeilings, accessCeilingContains } from './access-ceiling.js'
export type { AccessCeiling, AuthoringAuthority } from './access-ceiling.js'
export { pinToolAuthoringAuthority } from './tool-authority.js'
export { createExecutionContext, executionToolContext } from './execution-context.js'
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
} from './execution-context.js'
