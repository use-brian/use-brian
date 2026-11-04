/** One request owner for permission selection and response delivery receipts.
 * Only beforeAction may refresh permission facts. authorizeDelivery consumes the
 * selected execution; it never owns another permission loader or subscription.
 */
import type { ContextScopeAccumulator, ExecutionContext, ToolContext } from '@use-brian/core'
import type { Session } from '../db/sessions.js'
import type { ResolvedExecutionContext } from './execution-context.js'
import type { ActionPermissionSnapshots } from './action-permission-snapshots.js'
import { PermissionSnapshotUnavailableError } from './action-permission-snapshots.js'
import { DeliveryAudienceUnverifiedError } from './delivery-authority.js'
import { createResponseDeliveryAdmission, type ResponseDeliveryAdmission } from './response-delivery-admission.js'

const brand: unique symbol = Symbol('request-permission-context')
export type RequestPermissionContext = {
  readonly [brand]: true
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
const bindings = new WeakMap<RequestPermissionContext, Binding>()

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
  const permissions: RequestPermissionContext = Object.freeze({ [brand]: true as const,
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
  bindings.set(permissions, binding)
  if (original.lifecycle.abortSignal.aborted) dispose()
  else original.lifecycle.abortSignal.addEventListener('abort', dispose, { once: true })
  return permissions
}

/** The kernel accepts only exact executions selected by this host-owned context;
 * copying the public object cannot confer ownership of another response.
 */
export function ownsRequestPermissionContext(permissions: RequestPermissionContext, context: ToolContext): boolean {
  const binding = bindings.get(permissions)
  if (!binding || binding.closed || binding.invalid || !context.executionContext) return false
  return binding.selections.has(context.executionContext)
    && context.scopeAccumulator === binding.accumulator
    && context.authority === context.executionContext.security.authority
    && !context.abortSignal?.aborted && !context.executionContext.lifecycle.abortSignal.aborted
}
