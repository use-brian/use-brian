/** Lazy, action-start permission selection. Events only mark dirty; they never
 * refresh, cancel an admitted action, or inspect completed results.
 * This cache does not replace credential, source, SQL or delivery admission.
 */
import {
  subscribePermissionInvalidation,
  type PermissionInvalidation,
  type PermissionInvalidationSubscription,
} from './permission-events.js'

export type LoadedPermissionSnapshot<T> = Readonly<{
  /** The loader owns construction of an immutable, consistent snapshot. */
  value: T
  /** Earliest timed grant transition, not a periodic cache TTL. */
  refreshAt?: number
}>

export type ActionPermissionSnapshots<T> = {
  /** False where notification delivery is unsupported; use the existing live path. */
  readonly eligible: boolean
  /** Select once immediately before an action. Retain that value until it finishes. */
  beforeAction(): Promise<T>
  /** Does not cancel actions that already received a snapshot. */
  dispose(): void
}

export class PermissionSnapshotUnavailableError extends Error {
  readonly reason = 'permission_snapshot_unavailable'
  readonly operationMayHaveExecuted = false
  constructor() {
    super('Current permissions cannot be verified. No new action was started.')
    this.name = 'PermissionSnapshotUnavailableError'
  }
}

type Options = {
  subscribe?: typeof subscribePermissionInvalidation
  now?: () => number
  /** Request lifetime. Dispose explicitly as well when the request completes normally. */
  signal?: AbortSignal
}

/** Subscribe before the first load, avoiding a request-start registration gap.
 * Parallel action admissions share an in-progress load. A new invalidation during
 * that load remains pending for the following action, without retrying this load.
 * No database revisions or refresh timers are required.
 */
export function createActionPermissionSnapshots<T>(
  workspaceId: string,
  load: () => Promise<LoadedPermissionSnapshot<T>>,
  options: Options = {},
): ActionPermissionSnapshots<T> {
  const now = options.now ?? Date.now
  let dirty = true
  let available = false
  let eligible = false
  let disposed = false
  let selected: LoadedPermissionSnapshot<T> | undefined
  let refreshing: Promise<T> | undefined
  let subscription: PermissionInvalidationSubscription | undefined

  const onInvalidation = (event: PermissionInvalidation) => {
    dirty = true
    available = event.available
    eligible = event.eligible
  }
  const assertAvailable = () => {
    if (disposed || !eligible || !available) throw new PermissionSnapshotUnavailableError()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    subscription?.unsubscribe()
    options.signal?.removeEventListener('abort', dispose)
    selected = undefined
  }

  subscription = (options.subscribe ?? subscribePermissionInvalidation)(workspaceId, onInvalidation)
  eligible = subscription.eligible
  available = subscription.available
  if (options.signal?.aborted) dispose()
  else options.signal?.addEventListener('abort', dispose, { once: true })

  return {
    get eligible() { return eligible },
    beforeAction() {
      try { assertAvailable() } catch (error) { return Promise.reject(error) }
      if (refreshing) return refreshing
      if (selected?.refreshAt !== undefined && now() >= selected.refreshAt) dirty = true
      if (!dirty && selected) return Promise.resolve(selected.value)

      // Consume only invalidations already received. Never clear this flag
      // after an await: a later event belongs to the following action.
      dirty = false
      refreshing = Promise.resolve().then(load).then(snapshot => {
        assertAvailable()
        if (snapshot.refreshAt !== undefined && (!Number.isFinite(snapshot.refreshAt)
          || snapshot.refreshAt <= now())) throw new PermissionSnapshotUnavailableError()
        selected = Object.freeze({ ...snapshot })
        return snapshot.value
      }).catch(error => {
        // Failed refreshes cannot fall back to the previously selected grant.
        dirty = true
        throw error
      }).finally(() => { refreshing = undefined })
      return refreshing
    },
    dispose,
  }
}
