import { accessCeilingContains, ContextScopeAccumulator, type AccessCeiling, type ExecutionContext, type ScopeEvidence, type ToolContext } from '@use-brian/core'
import { getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import { classifySession, policyFor } from '../session-kind.js'
import type { Session } from '../db/sessions.js'
import { roomAudienceCeiling } from '../routes/_room-binding.js'
import { createAttendedDeliveryAudienceAuthorizer, validateAttendedAudienceEvidence } from './attended-audience.js'
import { DeliveryAudienceUnverifiedError } from './delivery-authority.js'

const brand: unique symbol = Symbol('web-response-permission-snapshot')
export type WebResponsePermissionSnapshot = {
  readonly [brand]: true
  readonly assertOutputAuthority: (context: ToolContext) => Promise<void>
}
const bindings = new WeakMap<WebResponsePermissionSnapshot, { execution: ExecutionContext; accumulator: ContextScopeAccumulator }>()
const nativeKinds = new Set(['application_field', 'session_context_revision', 'session_message', 'memory', 'workspace_file'])
const nativeEvidence = (evidence: ScopeEvidence) => (evidence.sources ?? []).every(source => nativeKinds.has(source.resourceKind))

/** A delivery snapshot is not read, retention, mutation, or publication authority.
 * Only native web chats qualify. Their resolver already bounds every read to the
 * stored room audience (or the private owner). Source admission remains mandatory
 * on model input; writers retain their current source/lineage checks.
 */
export function createWebResponsePermissionSnapshot(
  execution: ExecutionContext,
  accumulator: ContextScopeAccumulator,
  session: Session,
): WebResponsePermissionSnapshot | undefined {
  const actor = execution.security.access.userId
  if (execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
    || execution.identity.principal.authenticationKind !== 'native_session' || execution.identity.principal.userId !== actor
    || execution.ownership.kind !== 'workspace' || execution.surface.systemRead || execution.surface.clientSelfMemory
    || execution.security.access.systemRead || getApplicationExecutionBinding(execution)
    || execution.lifecycle.channelType !== 'web' || session.channelType !== 'web'
    || execution.lifecycle.sessionId !== session.id || execution.lifecycle.channelId !== session.channelId
    || classifySession(session).surface !== 'chat' || execution.security.provenance.sources?.length) return undefined
  const shared = policyFor(session).deliveryCeiling.ceiling === 'audience'
  if ((!shared && session.userId !== actor) || shared !== !!execution.security.access.sharedAudience) return undefined
  const ceiling = execution.security.ceiling
  if (shared && !accessCeilingContains({ ...roomAudienceCeiling(ceiling.workspaceId, session),
    userId: actor, visibilityAssistantIds: ceiling.visibilityAssistantIds,
    mutationCompartments: ceiling.mutationCompartments }, ceiling)) return undefined
  const ceilingFootprint = JSON.stringify(ceiling)

  // The original actor is retained in execution. Only the recipient is anonymous
  // for a shared room, so user-private evidence can never enter that room.
  const recipient: AccessCeiling = structuredClone({ ...execution.security.ceiling,
    userId: shared ? '' : actor, visibilityAssistantIds: null })
  const authority = execution.security.authority
  const destination = { workspaceId: execution.security.access.workspaceId, assistantId: execution.assistant.id,
    userId: actor, channelType: session.channelType, channelId: session.channelId, sessionId: session.id,
    recipientType: policyFor(session).deliveryCeiling.recipientType }
  const fallback = createAttendedDeliveryAudienceAuthorizer(execution)
  const admittedSources = new Set<string>()
  let admittedFootprint: string | undefined
  let independentDelivery = false
  let invalid = false
  const refuse = (): never => { throw new DeliveryAudienceUnverifiedError(undefined, 'source_unverifiable') }
  const assertIdentity = (context: ToolContext) => {
    if (invalid || context.executionContext !== execution || context.authority !== authority
      || execution.security.authority !== authority || context.scopeAccumulator !== accumulator
      || execution.security.ceiling !== ceiling || JSON.stringify(ceiling) !== ceilingFootprint
      || execution.lifecycle.sessionId !== destination.sessionId || execution.lifecycle.channelId !== destination.channelId
      || execution.lifecycle.channelType !== destination.channelType
      || context.abortSignal?.aborted || execution.lifecycle.abortSignal.aborted) refuse()
  }
  const snapshot: WebResponsePermissionSnapshot = Object.freeze({ [brand]: true as const,
    async assertOutputAuthority(context: ToolContext) {
      try {
        assertIdentity(context)
        const evidence = accumulator.evidence
        const footprint = JSON.stringify(evidence)
        // Text/reasoning chunks do not change source evidence. They need no new
        // destination lookup or accumulated-source admission. This receipt belongs
        // to this response, destination, execution and exact evidence footprint.
        if (!independentDelivery && footprint === admittedFootprint) return
        if (independentDelivery || !nativeEvidence(evidence)) {
          independentDelivery = true
          const decision = await fallback({ ...destination, scopeEvidence: evidence })
          if (!decision.allowed) throw new DeliveryAudienceUnverifiedError(decision.detail, decision.diagnostic)
          assertIdentity(context)
          if (JSON.stringify(accumulator.evidence) !== footprint) refuse()
          accumulator.note(decision.evidence)
          return
        }
        // Admit new observations only. Keep the complete label floor, but do not
        // repeatedly submit every previously admitted source with each tool result.
        const sources = (evidence.sources ?? []).filter(source => !admittedSources.has(JSON.stringify(source)))
        const admitted = await validateAttendedAudienceEvidence(execution, { ...evidence, sources }, recipient,
          { directHumanSource: !shared })
        assertIdentity(context)
        if (JSON.stringify(accumulator.evidence) !== footprint) refuse()
        if (!nativeEvidence(admitted)) {
          // Native fields can carry independent connector ancestry. Such sources
          // retain their separate live delivery protocol, never a cached allow.
          independentDelivery = true
          const decision = await fallback({ ...destination, scopeEvidence: evidence })
          if (!decision.allowed) throw new DeliveryAudienceUnverifiedError(decision.detail, decision.diagnostic)
          assertIdentity(context)
          if (JSON.stringify(accumulator.evidence) !== footprint) refuse()
          accumulator.note(decision.evidence)
          return
        }
        accumulator.note(admitted)
        for (const source of accumulator.evidence.sources ?? []) admittedSources.add(JSON.stringify(source))
        admittedFootprint = JSON.stringify(accumulator.evidence)
      } catch (error) {
        invalid = true
        throw error
      }
    },
  })
  bindings.set(snapshot, { execution, accumulator })
  return snapshot
}

/** Runtime ownership is checked as well as the TypeScript brand. A snapshot can
 * never be installed on another response, accumulator, or invocation. */
export function ownsWebResponsePermissionSnapshot(snapshot: WebResponsePermissionSnapshot, context: ToolContext): boolean {
  const binding = bindings.get(snapshot)
  return !!binding && context.executionContext === binding.execution && context.scopeAccumulator === binding.accumulator
    && context.authority === binding.execution.security.authority
}
