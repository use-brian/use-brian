import type { PoolClient } from 'pg'
import type { ResourceScope } from '@use-brian/core'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

/** Predecessor mutation authorization MUST already have succeeded. Only the
 * independently validated derivation floor may use read-source authority. */
export async function admitMemorySuccessor(
  client: PoolClient, actor: string, prior: ResourceScope, next: ResourceScope,
  floor?: Pick<ResourceScope, 'workspaceId' | 'sensitivity' | 'compartments' | 'projectIds'>,
): Promise<void> {
  const inherited = { ...prior, ...floor, visibility: prior.userId ? 'private' as const : 'workspace' as const }
  const admitted = await admitWorkspaceResource(client, prior.workspaceId, actor, {
    writerKind: 'memory', rowVisibility: { userId: next.userId, assistantId: next.assistantId },
    visibility: next.userId ? 'private' : 'workspace', sensitivity: next.sensitivity,
    inherited, inheritedAuthority: floor ? 'read' : 'mutation',
    // Retained General is inheritance, not a new unbound General destination.
    requestedLabels: { compartments: next.compartments.length ? next.compartments : undefined, projectIds: next.projectIds },
  })
  const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
  // Do not silently turn an intentional reclassification into another update.
  // Broadening needs its separate reviewed protocol, not a creation receipt.
  if (next.workspaceId !== prior.workspaceId || next.sensitivity !== admitted.envelope.sensitivity
    || next.userId !== prior.userId || next.assistantId !== prior.assistantId
    || !same(next.compartments, admitted.envelope.compartments) || !same(next.projectIds, admitted.envelope.projectIds)) {
    throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  }
}
