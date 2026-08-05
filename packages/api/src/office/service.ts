import type { OfficeToolPort } from '@use-brian/core'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'
import type { ResolvedOfficeAccess } from './access.js'

export type OfficeServiceDeps = {
  generationAvailable(): boolean
  createShell(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; title: string; templateVersionId: string | null; capabilityVersion: number; sensitivity: 'public' | 'internal' | 'confidential'; visibilityUserIds?: string[]; requiredCompartments?: string[] }): Promise<OfficeArtifactRow>
  deleteEmptyShell(userId: string, artifactId: string): Promise<boolean>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  createJob(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: OfficeGenerationJobRow['jobKind']; brief: unknown; authorityProjection: unknown; templateVersionId?: string; baseArtifactVersion?: number; idempotencyKey: string }): Promise<OfficeGenerationJobRow>
  latestJob(userId: string, artifactId: string): Promise<OfficeGenerationJobRow | null>
  wakeGeneration?(userId: string): void
}

export class OfficeGenerationUnavailableError extends Error {
  readonly code = 'office_generation_unavailable'

  constructor() {
    super('Office generation is unavailable because no generation runner is configured')
  }
}

function titleFromOutcome(outcome: string, family: 'document' | 'presentation'): string {
  const line = outcome.trim().split(/[\n.!?]/)[0]?.trim()
  return (line || (family === 'document' ? 'Untitled document' : 'Untitled presentation')).slice(0, 1_000)
}

export function createOfficeService(deps: OfficeServiceDeps): OfficeToolPort {
  return {
    async create(params) {
      if (!deps.generationAvailable()) throw new OfficeGenerationUnavailableError()
      const artifact = await deps.createShell({ userId: params.userId, workspaceId: params.workspaceId, family: params.family, title: titleFromOutcome(params.outcome, params.family), templateVersionId: params.templateId ?? null, capabilityVersion: 1, sensitivity: 'internal' })
      const brief = {
        workspaceId: params.workspaceId,
        actingUserId: params.userId,
        assistantId: params.assistantId,
        family: params.family,
        outcome: params.outcome,
        audience: params.audience,
        sourceHandles: params.sourceHandles,
        requestedSensitivityFloor: 'internal',
        templateId: params.templateId,
        canonicalWebsite: params.canonicalWebsite,
        companyHasNoWebsite: params.companyHasNoWebsite,
        idempotencyKey: params.idempotencyKey,
      }
      let job: OfficeGenerationJobRow
      try {
        job = await deps.createJob({ userId: params.userId, workspaceId: params.workspaceId, artifactId: artifact.id, assistantId: params.assistantId, jobKind: 'create', brief, authorityProjection: { sensitivity: 'internal', visibilityUserIds: [], compartments: [], sourceHandles: params.sourceHandles }, templateVersionId: params.templateId, idempotencyKey: params.idempotencyKey })
      } catch (cause) {
        await deps.deleteEmptyShell(params.userId, artifact.id)
        throw cause
      }
      if (job.artifactId !== artifact.id) await deps.deleteEmptyShell(params.userId, artifact.id)
      deps.wakeGeneration?.(params.userId)
      return { artifactId: job.artifactId, jobId: job.id }
    },

    async get(params) {
      const [artifact, access] = await Promise.all([deps.getArtifact(params.userId, params.artifactId), deps.resolveAccess(params.userId, params.artifactId)])
      if (!artifact || !access) return null
      const job = await deps.latestJob(params.userId, params.artifactId)
      return { artifactId: artifact.id, family: artifact.family, mode: artifact.mode, title: artifact.title, version: artifact.headVersion, lifecycleState: artifact.lifecycleState === 'purged' ? 'retained' : artifact.lifecycleState, role: access.role, job: job ? { id: job.id, status: job.status, stage: job.stage } : undefined }
    },

    async revise(params) {
      const [artifact, access] = await Promise.all([deps.getArtifact(params.userId, params.artifactId), deps.resolveAccess(params.userId, params.artifactId)])
      if (!artifact || !access || !access.canComment) return null
      if (artifact.headVersion !== params.expectedVersion) return 'version_conflict'
      const job = await deps.createJob({ userId: params.userId, workspaceId: artifact.workspaceId, artifactId: artifact.id, assistantId: params.assistantId, jobKind: 'revise', brief: { instruction: params.instruction, targetIds: params.targetIds, expectedVersion: params.expectedVersion }, authorityProjection: { role: access.role }, baseArtifactVersion: artifact.headVersion, idempotencyKey: params.idempotencyKey })
      return { jobId: job.id, mode: access.canEdit ? 'direct' : 'proposal' }
    },
  }
}
