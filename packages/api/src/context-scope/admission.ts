/** Canonical request admission owner. Delivery and action selection share one lifecycle.
 * Source-family predicates are unchanged during S1; native assembly retires in S2. */
import type { Session } from '../db/sessions.js'
import type { ResolvedExecutionContext } from './execution-context.js'
import type { ActionPermissionSnapshots } from './action-permission-snapshots.js'
import { PermissionSnapshotUnavailableError } from './action-permission-snapshots.js'
import { DeliveryAudienceUnverifiedError } from './delivery-authority.js'
import { accessCeilingContains, ContextScopeAccumulator, type AccessCeiling, type ExecutionContext, type ScopeEvidence, type ToolContext } from '@use-brian/core'
import { getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import { classifySession, policyFor } from '../session-kind.js'
import { roomAudienceCeiling } from '../routes/_room-binding.js'
import { createAttendedDeliveryAudienceAuthorizer, validateAttendedAudienceEvidence } from './attended-audience.js'

/** One request owner for permission selection and response delivery receipts.
 * Only beforeAction may refresh permission facts. authorizeDelivery consumes the
 * selected execution; it never owns another permission loader or subscription.
 */

const requestBrand: unique symbol = Symbol('request-permission-context')
export type RequestPermissionContext = {
  readonly [requestBrand]: true
  /** Select once at action admission. This does not execute or retry an action. */
  beforeAction(): Promise<ResolvedExecutionContext>
  /** Destination/source admission, not permission to read or mutate. */
  readonly authorizeDelivery: (context: ToolContext) => Promise<void>
  dispose(): void
}

type Selection = { value: ResolvedExecutionContext; receipt?: ResponseDeliveryAdmission }
type Binding = {
  accumulator: ContextScopeAccumulator
  selections: Map<ExecutionContext, Selection>
  closed: boolean
  invalid: boolean
}
const requestBindings = new WeakMap<RequestPermissionContext, Binding>()

type Options = {
  /** Called only for eligible native web requests. The context owns disposal.
   * Hosts without action-refresh wiring can retain the initial selection while
   * using the same request API for delivery. Existing live guards still apply.
   */
  createActionSnapshots?: () => ActionPermissionSnapshots<ResolvedExecutionContext>
}

function freezeFacts<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeFacts(child)
    Object.freeze(value)
  }
  return value
}
function capture(value: ResolvedExecutionContext): ResolvedExecutionContext {
  return Object.freeze({ executionContext: value.executionContext,
    turnScope: freezeFacts(structuredClone(value.turnScope)) })
}

/** An execution selected by the host may change grants, never request identity,
 * transport, anchor audience, or the real cancellation signal.
 */
function sameRequest(original: ExecutionContext, selected: ExecutionContext): boolean {
  return JSON.stringify(original.identity) === JSON.stringify(selected.identity)
    && JSON.stringify(original.ownership) === JSON.stringify(selected.ownership)
    && JSON.stringify(original.assistant) === JSON.stringify(selected.assistant)
    && JSON.stringify(original.surface) === JSON.stringify(selected.surface)
    && original.security.access.userId === selected.security.access.userId
    && original.security.access.workspaceId === selected.security.access.workspaceId
    && !!original.security.access.sharedAudience === !!selected.security.access.sharedAudience
    && original.lifecycle.abortSignal === selected.lifecycle.abortSignal
    && original.lifecycle.sessionId === selected.lifecycle.sessionId
    && original.lifecycle.sessionPersisted === selected.lifecycle.sessionPersisted
    && original.lifecycle.channelId === selected.lifecycle.channelId
    && original.lifecycle.channelType === selected.lifecycle.channelType
    && original.lifecycle.transport === selected.lifecycle.transport
}

/** One permission state and one invalidation lifecycle. Delivery receipts are
 * internal derived caches, keyed by the selected snapshot, destination, and
 * source evidence. Refresh discards their cached admissions, not completed work.
 */
export function createRequestPermissionContext(
  initial: ResolvedExecutionContext,
  accumulator: ContextScopeAccumulator,
  session: Session,
  options: Options = {},
): RequestPermissionContext | undefined {
  const original = initial.executionContext
  // Pin the stored audience/destination, not a caller-owned mutable row.
  const destination = structuredClone(session)
  const receipt = createResponseDeliveryAdmission(original, accumulator, destination)
  if (!receipt) return undefined
  const binding: Binding = { accumulator, selections: new Map(), closed: false, invalid: false }
  let selected = capture(initial)
  binding.selections.set(original, { value: selected, receipt })
  const snapshots = options.createActionSnapshots?.()
  const assertOpen = () => {
    if (binding.closed || binding.invalid || original.lifecycle.abortSignal.aborted) {
      throw new PermissionSnapshotUnavailableError()
    }
  }
  const refuseDelivery = (): never => { throw new DeliveryAudienceUnverifiedError(undefined, 'source_unverifiable') }
  const dispose = () => {
    if (binding.closed) return
    binding.closed = true
    snapshots?.dispose()
    binding.selections.clear()
    original.lifecycle.abortSignal.removeEventListener('abort', dispose)
  }
  const permissions: RequestPermissionContext = Object.freeze({ [requestBrand]: true as const,
    async beforeAction() {
      assertOpen()
      const next = snapshots ? await snapshots.beforeAction() : selected
      assertOpen()
      if (!sameRequest(original, next.executionContext)) throw new PermissionSnapshotUnavailableError()
      if (next.executionContext === selected.executionContext) return selected
      // Do not reuse a delivery allow from another permission selection. Keep
      // registered older executions so an admitted in-flight action can finish;
      // its next delivery must receive fresh admission as well.
      const nextReceipt = createResponseDeliveryAdmission(next.executionContext, accumulator, destination)
      if (!nextReceipt) throw new PermissionSnapshotUnavailableError()
      for (const record of binding.selections.values()) record.receipt = undefined
      // The trusted action provider already owns an immutable selection. Reuse
      // that exact value rather than maintaining a second permission snapshot.
      selected = next
      binding.selections.set(next.executionContext, { value: selected, receipt: nextReceipt })
      return selected
    },
    async authorizeDelivery(context: ToolContext) {
      try {
        if (!ownsRequestPermissionContext(permissions, context)) refuseDelivery()
        const record = binding.selections.get(context.executionContext!)!
        const admission = record.receipt
          ?? createResponseDeliveryAdmission(record.value.executionContext, accumulator, destination)
        if (!admission) return refuseDelivery()
        record.receipt = admission
        await admission.assertOutputAuthority(context)
        if (!ownsRequestPermissionContext(permissions, context)) refuseDelivery()
      } catch (error) {
        // A delivery failure cannot be cleared by refreshing action permissions.
        binding.invalid = true
        throw error
      }
    },
    dispose,
  })
  requestBindings.set(permissions, binding)
  if (original.lifecycle.abortSignal.aborted) dispose()
  else original.lifecycle.abortSignal.addEventListener('abort', dispose, { once: true })
  return permissions
}

/** The kernel accepts only exact executions selected by this host-owned context;
 * copying the public object cannot confer ownership of another response.
 */
export function ownsRequestPermissionContext(permissions: RequestPermissionContext, context: ToolContext): boolean {
  const binding = requestBindings.get(permissions)
  if (!binding || binding.closed || binding.invalid || !context.executionContext) return false
  return binding.selections.has(context.executionContext)
    && context.scopeAccumulator === binding.accumulator
    && context.authority === context.executionContext.security.authority
    && !context.abortSignal?.aborted && !context.executionContext.lifecycle.abortSignal.aborted
}


type ResponseDeliveryAdmission = {
  readonly assertOutputAuthority: (context: ToolContext) => Promise<void>
}
const nativeKinds = new Set(['application_field', 'session_context_revision', 'session_message', 'memory', 'workspace_file'])
const nativeEvidence = (evidence: ScopeEvidence) => (evidence.sources ?? []).every(source => nativeKinds.has(source.resourceKind))

/** Internal delivery receipt, owned by the request permission context.
 * It derives its recipient from the selected execution; it does not load or
 * invalidate another permission snapshot. It is not read, retention, mutation,
 * or publication authority.
 * Only native web chats qualify. Their resolver already bounds every read to the
 * stored room audience (or the private owner). Source admission remains mandatory
 * on model input; writers retain their current source/lineage checks.
 */
export function createResponseDeliveryAdmission(
  execution: ExecutionContext,
  accumulator: ContextScopeAccumulator,
  session: Session,
): ResponseDeliveryAdmission | undefined {
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
  const snapshot: ResponseDeliveryAdmission = Object.freeze({
    async assertOutputAuthority(context: ToolContext) {
      try {
        assertIdentity(context)
        let evidence = accumulator.evidence
        let footprint = JSON.stringify(evidence)
        const transcripts = (evidence.sources ?? []).filter(source => source.resourceKind === 'private_transcript')
        const native = { ...evidence, sources: (evidence.sources ?? []).filter(source => source.resourceKind !== 'private_transcript') }
        if (independentDelivery || !nativeEvidence(native)) {
          independentDelivery = true
          const decision = await fallback({ ...destination, scopeEvidence: evidence })
          if (!decision.allowed) throw new DeliveryAudienceUnverifiedError(decision.detail, decision.diagnostic)
          assertIdentity(context)
          if (JSON.stringify(accumulator.evidence) !== footprint) refuse()
          accumulator.note(decision.evidence)
          return
        }
        if (footprint !== admittedFootprint) {
          // Admit new observations only. Keep the complete label floor, but do not
          // repeatedly submit every previously admitted source with each tool result.
          const sources = (evidence.sources ?? []).filter(source => source.resourceKind !== 'private_transcript'
            && !admittedSources.has(JSON.stringify(source)))
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
          for (const source of accumulator.evidence.sources ?? []) {
            if (source.resourceKind !== 'private_transcript') admittedSources.add(JSON.stringify(source))
          }
        }
        if (transcripts.length) {
          // Finish native admission first, then freshly validate the dialogue.
          // An unchanged stream still observes transcript edits/holds, including
          // changes made while native admission awaited the database. Transcript
          // locks are confined to this short, independent canonical proof.
          evidence = accumulator.evidence
          footprint = JSON.stringify(evidence)
          const admitted = await validateAttendedAudienceEvidence(execution, { ...evidence, sources: transcripts }, recipient,
            { directHumanSource: !shared })
          assertIdentity(context)
          if (JSON.stringify(accumulator.evidence) !== footprint) refuse()
          if ((admitted.sources ?? []).some(source => source.resourceKind !== 'private_transcript')) refuse()
          accumulator.note(admitted)
        }
        admittedFootprint = JSON.stringify(accumulator.evidence)
      } catch (error) {
        invalid = true
        throw error
      }
    },
  })
  return snapshot
}
