/** Admit optional context before either its text or its evidence joins a turn.
 * [COMP:api/optional-context]
 */
import { ContextScopeAccumulator, type ExecutionContext, type ScopeEvidence, type SessionContextAuthority } from '@use-brian/core'
import type { DeliveryAudienceDecision } from './delivery-authority.js'

export async function readOptionalContext<T>(input: {
  execution: ExecutionContext
  accumulator: ContextScopeAccumulator
  read: (authority: SessionContextAuthority) => Promise<T>
  evidence: (value: T) => ScopeEvidence
  /** False only when no text, count or other fact from this read is surfaced. */
  contributes?: (value: T) => boolean
  authorize: (evidence: ScopeEvidence) => Promise<DeliveryAudienceDecision>
  fallback: T
}): Promise<T> {
  const { execution, accumulator } = input
  await execution.security.authority.assertCurrent()
  const candidate = new ContextScopeAccumulator()
  try {
    const value = await input.read({ execution, accumulator: candidate })
    await execution.security.authority.assertCurrent()
    if (input.contributes && !input.contributes(value)) return input.fallback
    candidate.note(input.evidence(value))
    if (!candidate.evidence.sources?.length) return input.fallback
    const decision = await input.authorize(candidate.evidence)
    await execution.security.authority.assertCurrent()
    if (!decision.allowed) return input.fallback
    accumulator.note(decision.evidence)
    return value
  } catch {
    // Optional source failure is recoverable. Lost invocation authority is not.
    await execution.security.authority.assertCurrent()
    return input.fallback
  }
}
