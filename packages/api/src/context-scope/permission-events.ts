/** Best-effort dirty hints, never permission authority or a revision receipt.
 * Callers must revalidate after initial/ready notifications; a clean snapshot
 * cannot be inferred from transport availability. No NOTIFY replay exists.
 * PGLite has no notification coverage: retain legacy live checks there.
 */
import { z } from 'zod'
import { registerNotifyChannel, startNotifyListener, subscribeNotifyLifecycle } from '../db/notify-listener.js'

const CHANNEL = 'permission_invalidation'
const workspaceIdSchema = z.string().uuid()
const payloadSchema = z.union([
  z.object({ workspaceId: workspaceIdSchema }).strict(),
  z.object({ global: z.literal(true) }).strict(),
])

export type PermissionInvalidation = Readonly<{
  dirty: true
  /** False in SINGLE_PROCESS/PGLite; callers must retain legacy checks. */
  eligible: boolean
  /** True only after this channel's LISTEN, false immediately on disconnect. */
  available: boolean
  reason: 'initial' | 'ready' | 'unavailable' | 'workspace' | 'global' | 'malformed'
}>
export type PermissionInvalidationSubscription = {
  readonly eligible: boolean
  readonly available: boolean
  unsubscribe: () => void
}
type Subscriber = { workspaceId: string; callback: (event: PermissionInvalidation) => void }
const subscribers = new Set<Subscriber>()
let started = false
let available = false
const eligible = process.env.USEBRIAN_SINGLE_PROCESS !== '1'

function deliver(subscriber: Subscriber, reason: PermissionInvalidation['reason']): void {
  try { subscriber.callback({ dirty: true, eligible, available, reason }) } catch (error) {
    // A broken snapshot must not prevent other snapshots from becoming dirty.
    console.warn('[permission-events] subscriber threw:', error)
  }
}

function invalidate(reason: PermissionInvalidation['reason'], workspaceId?: string): void {
  for (const subscriber of [...subscribers]) {
    if (workspaceId === undefined || subscriber.workspaceId === workspaceId) deliver(subscriber, reason)
  }
}

function handleNotification(payload: string): void {
  let event: z.infer<typeof payloadSchema>
  try { event = payloadSchema.parse(JSON.parse(payload)) } catch {
    invalidate('malformed')
    return
  }
  if ('global' in event) invalidate('global')
  else invalidate('workspace', event.workspaceId.toLowerCase())
}

function start(): void {
  if (started || !eligible) return
  started = true
  registerNotifyChannel(CHANNEL, handleNotification)
  subscribeNotifyLifecycle(CHANNEL, (state) => {
    available = state.ready
    // Invalidate on both edges, regardless of revision: notifications committed
    // during a disconnect are lost, even if no new NOTIFY follows reconnect.
    invalidate(state.ready ? 'ready' : 'unavailable')
  })
  startNotifyListener()
}

/** Synchronous initial dirty notification, then workspace/global dirty hints and
 * availability transitions. Unsubscribe when the running snapshot is disposed.
 * Uses the process's existing shared listener, never another DB connection.
 */
export function subscribePermissionInvalidation(
  workspaceId: string,
  callback: (event: PermissionInvalidation) => void,
): PermissionInvalidationSubscription {
  const canonicalWorkspaceId = workspaceIdSchema.parse(workspaceId).toLowerCase()
  start()
  const subscriber = { workspaceId: canonicalWorkspaceId, callback }
  subscribers.add(subscriber)
  deliver(subscriber, 'initial')
  return {
    eligible,
    get available() { return available },
    unsubscribe: () => { subscribers.delete(subscriber) },
  }
}
