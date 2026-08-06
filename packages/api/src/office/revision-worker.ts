/** Targeted @Brian revision worker for committed Office documents.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeRevisionWorkerDeps = {
  claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot; baseVersion: number } | null>
  revise(params: { snapshot: OfficeArtifactSnapshot; targetIds: string[]; instruction: string; job: OfficeGenerationJobRow }): Promise<OfficeArtifactSnapshot>
  commit(params: { job: OfficeGenerationJobRow; snapshot: OfficeArtifactSnapshot; expectedVersion: number }): Promise<number>
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
      if (!live || live.baseVersion !== brief.expectedVersion) throw new Error('revision_version_conflict')
      const snapshot = await deps.revise({ snapshot: live.snapshot, targetIds: brief.targetIds, instruction: brief.instruction, job })
      const version = await deps.commit({ job, snapshot, expectedVersion: brief.expectedVersion })
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { version }, actorType: 'system', safeNarration: 'Revision completed' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
    } catch (cause) {
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.failed', values: { code: 'revision_failed' }, actorType: 'system', safeNarration: 'Revision failed' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: 'revision_failed', errorDetail: cause instanceof Error ? cause.message : String(cause) })
    }
    return true
  }
}
