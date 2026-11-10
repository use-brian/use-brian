/** Trusted external-service receipt ownership, separate from credentials. [COMP:api/external-services] */
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'

type ReceiptIdentity = Readonly<{ kind: 'external_service'; serviceId: string; workspaceId: string; userId: string }>
const identities = new WeakMap<ExecutionContext, ReceiptIdentity>()

/** Only the authenticated canonical resolver installs this object-bound proof.
 * It changes receipt ownership, never the execution's real OAuth credential or
 * its live authority lease. JSON and narrowed/copied executions lose the proof.
 */
export function bindExternalServiceReceiptIdentity(execution: ExecutionContext,
  identity: { serviceId: string; workspaceId: string; userId: string }): ExecutionContext {
  const principal = execution.identity.kind === 'programmatic' ? execution.identity.principal : null
  if (!principal || principal.kind !== 'oauth_token' || !principal.credentialId
    || principal.actorUserId !== identity.userId || execution.security.access.userId !== identity.userId
    || execution.security.access.workspaceId !== identity.workspaceId || !identity.serviceId
    || execution.identity.kind !== 'programmatic' || execution.identity.credentialOwnerUserId !== identity.userId
    || identities.has(execution)) {
    throw new ApplicationPlatformError('access_unavailable', 'The canonical receipt identity is unavailable.')
  }
  identities.set(execution, Object.freeze({ kind: 'external_service', serviceId: identity.serviceId,
    workspaceId: identity.workspaceId, userId: identity.userId }))
  return execution
}

/** The special namespace cannot replace non-native application receipt rules. */
export function externalServiceReceiptIdentity(execution: ExecutionContext, moduleKey: string): ReceiptIdentity | undefined {
  return moduleKey === 'native' ? identities.get(execution) : undefined
}
