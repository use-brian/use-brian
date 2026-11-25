/** Fixed internal diagnostics and coarse copy classification. [COMP:api/delivery-authority] */
const phases = ['native_proof', 'ancestry', 'anonymous_field_proof', 'current_source', 'ancestry_recheck',
  'retained_context', 'prompt_memory_metadata', 'prompt_memory_capture', 'prompt_memory_projection', 'pool_checkout'] as const
export type DeliveryVerificationPhase = typeof phases[number]
export type DeliveryFailureMetadata = {
  verificationPhase?: DeliveryVerificationPhase
  verificationSqlstateClass?: string
}

// Only recognized PostgreSQL codes contribute their class. Never retain SQL,
// vendor prose, relation names, source identities or arbitrary error properties.
const sqlstates = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '22023', '22P02', '40001', '40P01', '42501',
  '53000', '53100', '53200', '53300', '53400', '54000', '54001', '54011',
  '55000', '55006', '55P03', '57014', '57P01', '57P02', '57P03',
  '58000', '58030', 'XX000', 'XX001', 'XX002',
])
const sqlstateClasses = new Set([...sqlstates].map(code => code.slice(0, 2)))

/** Bounded, cycle-safe extraction; unknown metadata is absent, never guessed. */
export function deliveryFailureMetadata(error: unknown, phase?: DeliveryVerificationPhase): DeliveryFailureMetadata {
  const metadata: DeliveryFailureMetadata = phase && phases.includes(phase) ? { verificationPhase: phase } : {}
  const seen = new Set<object>()
  for (let depth = 0; depth < 8 && typeof error === 'object' && error !== null && !seen.has(error); depth++) {
    seen.add(error)
    try {
      const candidate = error as Record<string, unknown>
      const candidatePhase = candidate.verificationPhase
      const candidateClass = candidate.verificationSqlstateClass
      const candidateCode = candidate.code
      if (phases.includes(candidatePhase as DeliveryVerificationPhase)) {
        metadata.verificationPhase = candidatePhase as DeliveryVerificationPhase
      }
      if (typeof candidateClass === 'string' && sqlstateClasses.has(candidateClass)) {
        metadata.verificationSqlstateClass = candidateClass
      }
      if (typeof candidateCode === 'string' && sqlstates.has(candidateCode)) {
        metadata.verificationSqlstateClass = candidateCode.slice(0, 2)
      }
      error = candidate.cause
    } catch { break }
  }
  return metadata
}

export function deliveryFailureAnalytics(error: unknown): Record<string, string> {
  const metadata = deliveryFailureMetadata(error)
  return {
    ...(metadata.verificationPhase ? { verification_phase: metadata.verificationPhase } : {}),
    ...(metadata.verificationSqlstateClass ? { verification_sqlstate_class: metadata.verificationSqlstateClass } : {}),
  }
}

type ContextVerificationFailure = 'statement_timeout' | 'statement_canceled' | 'lock_timeout' | 'lock_unavailable' | 'pool_timeout'

/** An interrupted required read has no authority to continue or replay. */
export class ContextVerificationUnavailableError extends Error {
  readonly code = 'context_verification_unavailable'
  readonly retrySafe = false
  constructor(readonly verificationFailure: ContextVerificationFailure, cause: unknown, phase: DeliveryVerificationPhase) {
    super('We couldn’t finish checking the context for this reply.', { cause })
    this.name = 'ContextVerificationUnavailableError'
    Object.assign(this, deliveryFailureMetadata(cause, phase))
  }
}

function hasPublicationOutcome(error: Error): boolean {
  return 'publicationOutcome' in error || 'operationMayHaveExecuted' in error && error.operationMayHaveExecuted === true
}

export function isContextVerificationReadFailure(error: unknown): error is ContextVerificationUnavailableError {
  return error instanceof ContextVerificationUnavailableError && !hasPublicationOutcome(error)
}

/** Call only at the failed read boundary. An authoritative refusal stays a refusal. */
export function contextVerificationUnavailable(error: unknown, phase: DeliveryVerificationPhase): ContextVerificationUnavailableError | undefined {
  const seen = new Set<Error>()
  let cause = error
  while (cause instanceof Error && seen.size < 8 && !seen.has(cause)) {
    seen.add(cause)
    try {
      // COMMIT uncertainty and a verified authorization decision take priority
      // over any availability error nested inside them.
      if (hasPublicationOutcome(cause)
        || 'reason' in cause && cause.reason === 'authority_changed'
        || 'diagnostic' in cause && typeof cause.diagnostic === 'string'
          && !['source_unverifiable', 'verification_error'].includes(cause.diagnostic)) return undefined
      if (cause instanceof ContextVerificationUnavailableError) return cause
      const code = (cause as Error & { code?: unknown }).code
      let failure: ContextVerificationFailure | undefined
      if (code === '57014') {
        failure = cause.message === 'canceling statement due to statement timeout' ? 'statement_timeout' : 'statement_canceled'
      } else if (code === '55P03') {
        failure = cause.message === 'canceling statement due to lock timeout' ? 'lock_timeout' : 'lock_unavailable'
      } else if (code === undefined && (cause.message === 'timeout exceeded when trying to connect'
        || cause.message === 'Connection terminated due to connection timeout')) {
        failure = 'pool_timeout'
      }
      if (failure) return new ContextVerificationUnavailableError(failure, error, failure === 'pool_timeout' ? 'pool_checkout' : phase)
      cause = cause.cause
    } catch { return undefined }
  }
  return undefined
}

const restrictions = new Set(['workspace', 'user_visibility', 'assistant_visibility', 'clearance', 'teams', 'projects', 'source_reclassified'])
export function isAudienceScopeRestriction(diagnostic: string | undefined): boolean {
  return diagnostic !== undefined && restrictions.has(diagnostic)
}

const approvalFailures = new Set(['binding_audience_mismatch', 'binding_expired', 'binding_approver_not_admin', 'no_binding_ceiling'])
/** Explicit coarse legacy outcomes remain usable; an uncertain diagnostic wins. */
export function deliveryAudienceFailureKind(error: { detail?: string; diagnostic?: string }): 'unbound' | 'restriction' | 'unverified' {
  if (error.diagnostic !== undefined) {
    if (approvalFailures.has(error.diagnostic)) return 'unbound'
    if (!isAudienceScopeRestriction(error.diagnostic)) return 'unverified'
    return error.detail === 'unbound' ? 'unbound' : 'restriction'
  }
  return error.detail === 'unbound' ? 'unbound' : error.detail === 'evidence_exceeds_audience' ? 'restriction' : 'unverified'
}
