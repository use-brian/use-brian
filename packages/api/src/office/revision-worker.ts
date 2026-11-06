import { withOfficeWorkspaceAuthority } from './workspace-authority.js'
/** Targeted @Brian revision worker for committed Office documents.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { applyOfficeSnapshotCommand, type OfficeArtifactSnapshot, type OfficeCommand } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeRevisionWorkerDeps = {
  get(userId: string, jobId: string): Promise<OfficeGenerationJobRow | null>
  claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot; baseVersion: number; seq: number } | null>
  revise(params: { snapshot: OfficeArtifactSnapshot; targetIds: string[]; instruction: string; currentVersion: number; versionDrifted: boolean; job: OfficeGenerationJobRow }): Promise<{ mode: 'direct' | 'proposal'; snapshot?: OfficeArtifactSnapshot; commands: OfficeCommand[]; affectedObjectIds: string[] }>
  commit(params: { job: OfficeGenerationJobRow; snapshot: OfficeArtifactSnapshot; expectedVersion: number; expectedSeq: number }): Promise<number>
  propose(params: { job: OfficeGenerationJobRow; baseVersion: number; commands: OfficeCommand[]; affectedObjectIds: string[] }): Promise<void>
  appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'system'; safeNarration: string }): Promise<unknown>
  finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed' | 'cancelled'; stage: string; errorCode?: string; errorDetail?: string }): Promise<boolean>
  leaseMs?: number
}

export function createOfficeRevisionWorker(deps: OfficeRevisionWorkerDeps) {
  return async function runOne(userId: string): Promise<boolean> {
    const leaseToken = randomUUID()
    const job = await deps.claim({ userId, leaseToken, leaseMs: deps.leaseMs ?? 120_000, jobKinds: ['revise'] })
    if (!job) return false
    let cancelled = false, leaseLost = false
    const assertActive = async () => {
      const current = await deps.get(userId, job.id)
      if (!current || current.status !== 'running' || current.leaseToken !== job.leaseToken
        || !current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= Date.now()) {
        leaseLost = true
        throw new Error('revision_lease_lost')
      }
      if (current.cancelRequestedAt) {
        cancelled = true
        throw new Error('revision_cancelled')
      }
    }
    try {
      await assertActive()
      const brief = job.brief as { instruction?: unknown; targetIds?: unknown; expectedVersion?: unknown }
      if (typeof brief.instruction !== 'string' || !Array.isArray(brief.targetIds) || !brief.targetIds.every((id) => typeof id === 'string') || typeof brief.expectedVersion !== 'number') throw new Error('invalid_revision_brief')
      const instruction=brief.instruction,targetIds=brief.targetIds
      const live = await withOfficeWorkspaceAuthority(job,()=>deps.getSnapshot(userId, job.artifactId))
      if (!live || live.baseVersion < brief.expectedVersion) throw new Error('revision_version_conflict')
      const revision = await withOfficeWorkspaceAuthority(job,()=>deps.revise({ snapshot: live.snapshot, targetIds, instruction, currentVersion: live.baseVersion, versionDrifted: live.baseVersion !== brief.expectedVersion, job }))
      await assertActive()
      if (!revision.commands.length) throw new Error('Office revision has no commands')
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.revision_drafted', values: { mode: revision.mode, commands: revision.commands.length }, actorType: 'system', safeNarration: 'Changes drafted' })
      let replayed = live.snapshot
      for (const command of revision.commands) {
        if (command.baseVersion !== live.baseVersion || command.artifactId !== job.artifactId) throw new Error('Office revision command envelope mismatch')
        replayed = applyOfficeSnapshotCommand(replayed, command)
      }
      if (revision.mode === 'direct' && JSON.stringify(replayed) !== JSON.stringify(revision.snapshot)) throw new Error('Office revision snapshot differs from canonical command replay')
      await assertActive()
      if (revision.mode === 'proposal') {
        await withOfficeWorkspaceAuthority(job,()=>deps.propose({ job, baseVersion: live.baseVersion, commands: revision.commands, affectedObjectIds: revision.affectedObjectIds }))
        await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { proposal: true }, actorType: 'system', safeNarration: 'Revision proposed' })
      } else {
        if (!revision.snapshot) throw new Error('Office direct revision did not return a snapshot')
        const version = await withOfficeWorkspaceAuthority(job,()=>deps.commit({ job, snapshot: revision.snapshot!, expectedVersion: live.baseVersion, expectedSeq: live.seq }))
        await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { version }, actorType: 'system', safeNarration: 'Revision completed' })
      }
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
    } catch (cause) {
      // An expired/replaced claim cannot settle or narrate another worker's job.
      if (leaseLost) return true
      if (cancelled) {
        await deps.finish({ userId, jobId: job.id, leaseToken, status: 'cancelled', stage: 'cancelled' })
        return true
      }
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.failed', values: { code: 'revision_failed' }, actorType: 'system', safeNarration: 'Revision failed' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: 'revision_failed', errorDetail: cause instanceof Error ? cause.message : String(cause) })
    }
    return true
  }
}
