/** Lease/checkpoint runner for Office generation jobs.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { runOfficeGenerationPipeline, type OfficeGenerationEvent, type OfficeGenerationPipelineDeps } from '@use-brian/core'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeGenerationWorkerStore = {
  claim(params: { userId: string; leaseToken: string; leaseMs: number }): Promise<OfficeGenerationJobRow | null>
  checkpoint(params: { userId: string; jobId: string; leaseToken: string; stage: string; expectedVersion: number; checkpoint: unknown; status?: OfficeGenerationJobRow['status'] }): Promise<boolean>
  appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'user' | 'assistant' | 'system'; actorUserId?: string; actorAssistantId?: string; safeNarration?: string }): Promise<unknown>
  drainSteering(params: { userId: string; jobId: string; checkpointVersion: number }): Promise<Array<{ id: string; instruction: string }>>
  finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed' | 'cancelled' | 'needs_input'; stage: string; errorCode?: string; errorDetail?: string }): Promise<boolean>
}

export type OfficeGenerationWorkerDeps = {
  store: OfficeGenerationWorkerStore
  workerUserId: string
  buildPipelineDeps(job: OfficeGenerationJobRow, controls: {
    checkpoint(value: Parameters<OfficeGenerationPipelineDeps['checkpoint']>[0]): Promise<void>
    emit(event: OfficeGenerationEvent): Promise<void>
    drainSteering(stage: string): Promise<string[]>
  }): Omit<OfficeGenerationPipelineDeps, 'checkpoint' | 'emit' | 'drainSteering'>
  leaseMs?: number
}

const safeNarration: Partial<Record<OfficeGenerationEvent['code'], string>> = {
  'office.job.queued': 'Queued',
  'office.job.authority_resolved': 'Access checked',
  'office.job.template_selected': 'Template selected',
  'office.job.grounding_started': 'Collecting permitted context',
  'office.job.reference_url_inspected': 'Reference URL inspected',
  'office.job.context_grounded': 'Context ready',
  'office.job.claim_plan_ready': 'Evidence plan ready',
  'office.job.objects_constructed': 'Content constructed',
  'office.job.media_processed': 'Media processed',
  'office.job.fit_validated': 'Layout fitted',
  'office.job.candidate_validated': 'Candidate validated',
  'office.job.export_reopened': 'Office file reopened successfully',
  'office.job.completed': 'Completed',
  'office.job.needs_input': 'Input needed',
  'office.job.failed': 'Generation failed',
  'office.job.cancelled': 'Cancelled',
  'office.job.steering_applied': 'Steering applied',
}

export function createOfficeGenerationWorker(deps: OfficeGenerationWorkerDeps) {
  return {
    async runOnce(): Promise<'idle' | 'completed' | 'failed' | 'cancelled' | 'needs_input'> {
      const leaseToken = randomUUID()
      const job = await deps.store.claim({ userId: deps.workerUserId, leaseToken, leaseMs: deps.leaseMs ?? 60_000 })
      if (!job) return 'idle'
      let checkpointVersion = job.checkpointVersion
      const controls = {
        async checkpoint(value: Parameters<OfficeGenerationPipelineDeps['checkpoint']>[0]) {
          const advanced = await deps.store.checkpoint({ userId: deps.workerUserId, jobId: job.id, leaseToken, stage: value.stage, expectedVersion: checkpointVersion, checkpoint: value })
          if (!advanced) throw new Error('Office generation checkpoint lease/version conflict')
          checkpointVersion += 1
        },
        async emit(event: OfficeGenerationEvent) {
          await deps.store.appendEvent({ userId: deps.workerUserId, jobId: job.id, workspaceId: job.workspaceId, code: event.code, values: event.params, actorType: 'system', safeNarration: safeNarration[event.code] })
        },
        async drainSteering(_stage: string) {
          return (await deps.store.drainSteering({ userId: deps.workerUserId, jobId: job.id, checkpointVersion: checkpointVersion + 1 })).map((row) => row.instruction)
        },
      }
      const pipelineDeps = { ...deps.buildPipelineDeps(job, controls), ...controls }
      const outcome = await runOfficeGenerationPipeline(job.brief, pipelineDeps)
      const status = outcome.status
      if (status === 'completed') await deps.store.finish({ userId: deps.workerUserId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
      else if (status === 'cancelled') await deps.store.finish({ userId: deps.workerUserId, jobId: job.id, leaseToken, status: 'cancelled', stage: 'cancelled' })
      else if (status === 'needs_input') await deps.store.finish({ userId: deps.workerUserId, jobId: job.id, leaseToken, status: 'needs_input', stage: 'needs_input', errorCode: outcome.code, errorDetail: outcome.question })
      else await deps.store.finish({ userId: deps.workerUserId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: outcome.code, errorDetail: outcome.message })
      return status
    },
  }
}
