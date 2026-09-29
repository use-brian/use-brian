/** Protected file persistence for draft anchors. [COMP:api/office-suggestions] */
import { randomUUID } from 'node:crypto'
import type { FilesApi } from '@use-brian/core'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'

export function createOfficeCommentAnchorWriter(deps: {
  filesApi: Pick<FilesApi, 'writeBytes' | 'delete'> | null
  membership: typeof getWorkspaceMembershipWithClearanceSystem
  authorizePath(userId: string, workspaceId: string, path: string): Promise<boolean>
}) {
  return async (userId: string, artifact: OfficeArtifactRow, bytes: Uint8Array, hash: string) => {
    if (!deps.filesApi) throw new Error('Office file storage is unavailable')
    const member = await deps.membership(userId, artifact.workspaceId)
    if (!member) throw new Error('Office anchor membership unavailable')
    const clearance = member.role === 'owner' || member.role === 'admin' ? 'confidential' as const : member.clearance
    const context = { workspaceId: artifact.workspaceId, userId, assistantKind: 'standard' as const,
      clearance, writeSensitivity: artifact.sensitivity,
      writeCompartments: artifact.compartments, writeProjectIds: artifact.projectIds }
    // This namespace is protected by Office-root RLS even via generic file reads,
    // and the existing Files writer marks it noIndex before insertion.
    const path = `/office/anchors/${artifact.id}/0-${hash}-${randomUUID()}.json`
    // Calling the migration-owned predicate also fails closed on an old schema.
    if (!await deps.authorizePath(userId, artifact.workspaceId, path)) throw new Error('Office anchor storage unavailable')
    const saved = await deps.filesApi.writeBytes(context, {
      path,
      bytes, mime: 'application/json', sensitivity: artifact.sensitivity,
    })
    if (!saved.ok) throw new Error(`Office comment anchor save failed: ${saved.error.kind}`)
    return { fileId: saved.value.id, discard: async () => {
      await deps.filesApi!.delete(context, saved.value.id)
    } }
  }
}
