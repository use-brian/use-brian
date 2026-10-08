/** Explicit recovery of one failed, unedited template import. [COMP:api/office-generation] */
import { canRead, scopeGrantContains } from '@use-brian/core'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeFileBinding } from './file-binding.js'

export type TemplateImportRetry = {
  userId: string; workspaceId: string; artifactId: string; failedJobId: string; fileId?: string; assistantId?: string
  clearance?: 'public' | 'internal' | 'confidential'; compartmentGrant?: string[] | null; projectGrant?: string[] | null
}
export function createTemplateImportRecovery(deps: {
  getJob(userId: string, jobId: string): Promise<OfficeGenerationJobRow | null>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  canEdit(userId: string, artifactId: string): Promise<boolean>
  readSource(input: { userId: string; workspaceId: string; fileId: string; assistantId?: string }): Promise<{ binding: OfficeFileBinding } | null>
  retry(input: TemplateImportRetry): Promise<OfficeGenerationJobRow | null>
  wake(userId: string): void
}) {
  return async (input: TemplateImportRetry): Promise<{ jobId: string } | null> => {
    const [job, artifact, editable] = await Promise.all([deps.getJob(input.userId,input.failedJobId),deps.getArtifact(input.userId,input.artifactId),deps.canEdit(input.userId,input.artifactId)])
    if (!job || !artifact || !editable || job.workspaceId !== input.workspaceId || artifact.workspaceId !== input.workspaceId || job.artifactId !== artifact.id || artifact.mode !== 'template' || job.initiatedByUserId !== input.userId) return null
    if (!['failed','cancelled'].includes(job.status) || job.jobKind !== 'template_compile') return null
    const brief = job.brief as { source?: { kind?: unknown; fileId?: unknown } } | null
    if (brief?.source?.kind !== 'upload' || typeof brief.source.fileId !== 'string') return null
    const source = await deps.readSource({ userId: input.userId, workspaceId: input.workspaceId, fileId: input.fileId ?? brief.source.fileId, ...(input.assistantId ? { assistantId: input.assistantId } : {}) })
    if (!source) return null
    for (const scope of [artifact, source.binding]) {
      if (input.clearance && !canRead(input.clearance,scope.sensitivity) || !scopeGrantContains(input.compartmentGrant,scope.compartments) || !scopeGrantContains(input.projectGrant,scope.projectIds)) return null
    }
    const retried = await deps.retry(input)
    if (!retried) return null
    deps.wake(input.userId)
    return { jobId: retried.id }
  }
}
