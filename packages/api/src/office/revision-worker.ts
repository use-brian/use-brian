/** Targeted @Brian revision worker for committed Office documents.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import type { OfficeArtifactSnapshot, OfficeCommand } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeRevisionWorkerDeps = {
  claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot; baseVersion: number } | null>
  revise(params: { snapshot: OfficeArtifactSnapshot; targetIds: string[]; instruction: string; currentVersion: number; versionDrifted: boolean; job: OfficeGenerationJobRow }): Promise<{ mode: 'direct' | 'proposal'; snapshot?: OfficeArtifactSnapshot; commands: OfficeCommand[]; affectedObjectIds: string[] }>
  commit(params: { job: OfficeGenerationJobRow; snapshot: OfficeArtifactSnapshot; expectedVersion: number }): Promise<number>
  propose(params: { job: OfficeGenerationJobRow; baseVersion: number; commands: OfficeCommand[]; affectedObjectIds: string[] }): Promise<void>
  appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'system'; safeNarration: string }): Promise<unknown>
  finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed'; stage: string; errorCode?: string; errorDetail?: string }): Promise<boolean>
  leaseMs?: number
}

export function createOfficeRevisionWorker(deps: OfficeRevisionWorkerDeps) {
  return async function runOne(userId: string): Promise<boolean> {
    const leaseToken = randomUUID()
    const job = await deps.claim({ userId, leaseToken, leaseMs: deps.leaseMs ?? 120_000, jobKinds: ['revise'] })
    if (!job) return false
    try {
      const brief = job.brief as { instruction?: unknown; targetIds?: unknown; expectedVersion?: unknown }
      if (typeof brief.instruction !== 'string' || !Array.isArray(brief.targetIds) || !brief.targetIds.every((id) => typeof id === 'string') || typeof brief.expectedVersion !== 'number') throw new Error('invalid_revision_brief')
      const live = await deps.getSnapshot(userId, job.artifactId)
      if (!live || live.baseVersion < brief.expectedVersion) throw new Error('revision_version_conflict')
      const revision = await deps.revise({ snapshot: live.snapshot, targetIds: brief.targetIds, instruction: brief.instruction, currentVersion: live.baseVersion, versionDrifted: live.baseVersion !== brief.expectedVersion, job })
      if (revision.mode === 'proposal') {
        await deps.propose({ job, baseVersion: live.baseVersion, commands: revision.commands, affectedObjectIds: revision.affectedObjectIds })
        await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { proposal: true }, actorType: 'system', safeNarration: 'Revision proposed' })
      } else {
        if (!revision.snapshot) throw new Error('Office direct revision did not return a snapshot')
        const version = await deps.commit({ job, snapshot: revision.snapshot, expectedVersion: live.baseVersion })
        await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { version }, actorType: 'system', safeNarration: 'Revision completed' })
      }
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
    } catch (cause) {
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.failed', values: { code: 'revision_failed' }, actorType: 'system', safeNarration: 'Revision failed' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: 'revision_failed', errorDetail: cause instanceof Error ? cause.message : String(cause) })
    }
    return true
  }
}
