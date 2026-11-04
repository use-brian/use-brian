/** Internal action-selection adapter, owned by the request permission context.
 * Native chat constructs this provider, but automatic action-start switching is
 * not enabled yet. Strict authority leases, SQL and delivery checks remain in
 * force. Holding a snapshot does not relax in-flight SQL admission.
 */
import { z } from 'zod'
import { query } from '../db/client.js'
import {
  createActionPermissionSnapshots,
  PermissionSnapshotUnavailableError,
  type ActionPermissionSnapshots,
} from './action-permission-snapshots.js'
import {
  resolveExecutionContextSystem,
  type ResolveExecutionContextInput,
  type ResolveExecutionContextDeps,
  type ResolvedExecutionContext,
} from './execution-context.js'

export type ExecutionPermissionSnapshotDeps = ResolveExecutionContextDeps & {
  resolveExecutionContext?: typeof resolveExecutionContextSystem
  /** Epoch milliseconds, or null when no future transition exists. */
  readNextTransition?: (workspaceId: string) => Promise<unknown>
}
export type ExecutionPermissionSnapshotOptions = NonNullable<Parameters<typeof createActionPermissionSnapshots>[2]>

/** Owner connection, policy metadata only: no business rows or SQL authority.
 * Conservatively includes every principal in the workspace, not just this actor.
 * Read BEFORE scope resolution so a transition crossed during resolution is
 * still returned to the cache and rejected by its completion-time check.
 */
async function readNextTransitionSystem(workspaceId: string): Promise<unknown> {
  const result = await query<{ refresh_at: unknown }>(`
    SELECT extract(epoch FROM min(point))::double precision * 1000 AS refresh_at
    FROM (
      SELECT expires_at AS point FROM public.department_edges WHERE workspace_id=$1
      UNION ALL
      SELECT expires_at FROM public.project_shared_members WHERE workspace_id=$1
      UNION ALL
      SELECT point FROM public.application_native_role_assignments
        CROSS JOIN LATERAL unnest(ARRAY[starts_at,expires_at]) AS point
        WHERE workspace_id=$1 AND status='active'
      UNION ALL
      SELECT point FROM public.workspace_access_grants
        CROSS JOIN LATERAL unnest(ARRAY[starts_at,expires_at]) AS point
        WHERE workspace_id=$1 AND revoked_at IS NULL
    ) transitions WHERE point > statement_timestamp()
  `, [workspaceId])
  // A missing aggregate row is malformed, not evidence of no deadline.
  return result.rows[0]?.refresh_at
}

function freezeFacts<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeFacts(child)
    Object.freeze(value)
  }
  return value
}

/** Subscribe eagerly, resolve lazily, and retain one immutable value per action.
 * No TTL, revisions, timers, or replacement of resolver-created execution objects.
 * Dispose on request completion; abort defaults to the execution lifecycle.
 */
export function createExecutionPermissionSnapshots(
  input: ResolveExecutionContextInput,
  deps: ExecutionPermissionSnapshotDeps = {},
  options: ExecutionPermissionSnapshotOptions = {},
): ActionPermissionSnapshots<ResolvedExecutionContext> {
  const parsed = z.string().uuid().safeParse(input.workspaceId ?? input.assistant.workspaceId)
  if (!parsed.success || input.ownership.kind !== 'workspace'
    || input.ownership.workspaceId.toLowerCase() !== parsed.data.toLowerCase()
    || input.assistant.workspaceId?.toLowerCase() !== parsed.data.toLowerCase()) {
    throw new PermissionSnapshotUnavailableError()
  }
  const workspaceId = parsed.data.toLowerCase()
  // Retain the real signal and trusted callbacks, but detach all identity,
  // binding and surface facts from caller-owned objects before the first await.
  const { lifecycle, credentialCurrent, maximumAccessCurrent, ...facts } = input
  const pinnedInput: ResolveExecutionContextInput = {
    ...structuredClone(facts), lifecycle: { ...lifecycle }, credentialCurrent, maximumAccessCurrent,
  }
  const { resolveExecutionContext = resolveExecutionContextSystem,
    readNextTransition = readNextTransitionSystem, ...resolverDeps } = deps
  return createActionPermissionSnapshots(workspaceId, async () => {
    const deadline = await readNextTransition(workspaceId)
    if (deadline !== null && (typeof deadline !== 'number' || !Number.isFinite(deadline))) {
      throw new PermissionSnapshotUnavailableError()
    }
    const resolved = await resolveExecutionContext(pinnedInput, resolverDeps)
    return {
      value: Object.freeze({
        executionContext: resolved.executionContext,
        // Never freeze resolver/store-owned arrays: later reads may reuse them.
        turnScope: freezeFacts(structuredClone(resolved.turnScope)),
      }),
      ...(deadline === null ? {} : { refreshAt: deadline }),
    }
  }, { ...options, signal: options.signal ?? pinnedInput.lifecycle.abortSignal })
}
