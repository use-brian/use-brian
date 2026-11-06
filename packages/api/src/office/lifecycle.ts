/** Shared native lifecycle decisions. [COMP:api/office-routes] */
import type { ResolvedOfficeAccess } from './access.js'

export type OfficeLifecycleAction = 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge'
export type OfficeLifecycleDeps = {
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  transition(params: { userId: string; artifactId: string; action: OfficeLifecycleAction; reason: string; actorAssistantId?: string }): Promise<unknown | null>
  revokeOffline(userId: string, artifactId: string): Promise<void>
}
export async function changeOfficeLifecycle(deps: OfficeLifecycleDeps, input: {
  userId: string; workspaceId?: string; artifactId: string; action: OfficeLifecycleAction; reason: string; actorAssistantId?: string
}): Promise<{ status: 404 | 409; error: string } | { status: 200; artifact: unknown }> {
  const access = await deps.resolveAccess(input.userId, input.artifactId)
  if (!access || access.mode === 'session' || input.workspaceId && access.workspaceId !== input.workspaceId) return { status: 404, error: 'Office artifact not found' }
  const permitted = input.action === 'purge' ? access.canDeletePermanently
    : input.action === 'restore' || input.action === 'unarchive' ? access.canRestore : access.role === 'edit'
  if (!permitted) return { status: 404, error: 'Office artifact not found' }
  const artifact = await deps.transition(input)
  if (!artifact) return { status: 409, error: 'lifecycle_transition_blocked' }
  if (input.action === 'archive' || input.action === 'trash' || input.action === 'purge') await deps.revokeOffline(input.userId, input.artifactId)
  return { status: 200, artifact }
}
