import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * `reprocessRecording` — re-run the recording pipeline (transcribe → segment →
 * brain ingest) for a recording that already has its bytes stored, as a thin
 * agent affordance over the existing recording-jobs queue — the same seam the
 * upload flow and `confirmRecordingProcessing` enqueue through. No parallel
 * mechanism (see docs/architecture/media/transcription.md §"Re-processing").
 *
 * Consent guard (the invariant): an uploaded recording is never silently
 * processed, and a completed one is never silently re-processed. The first
 * call returns purpose/cost context and instructs the model to ask the user;
 * only explicit `confirm: true` after agreement enqueues. An in-flight job is
 * a no-op (queue-level idempotency). The duration surcharge is idempotent per
 * recording, so a re-run never double-bills credits.
 *
 * [COMP:recordings/reprocess-recording-tool]
 */

/** The dependency surface this tool needs (injected at boot). */
export type ReprocessRecordingDeps = {
  /** Load the recording Episode as the acting user (RLS-scoped); null when
   *  absent or not visible. */
  getRecording: (
    actorUserId: string,
    recordingId: string,
  ) => Promise<{
    id: string
    workspaceId: string
    sourceKind: string
    sourceRef: Record<string, unknown> | null
    durationMs?: number | null
  } | null>
  /** True when a processing run already completed for this recording. */
  hasProcessed: (recordingId: string) => Promise<boolean>
  /** The existing recording-jobs queue seam (idempotent while a job is active). */
  enqueue: (input: {
    recordingId: string
    workspaceId: string
    actingUserId: string
    blueprintSlug?: string | null
  }) => Promise<{ enqueued: boolean; jobId: string | null }>
  /** Hosted credit quote; absent in OSS/self-hosted. */
  surchargeCredits?: (durationSeconds: number) => number
}

export function createReprocessRecordingTool(deps: ReprocessRecordingDeps) {
  return buildTool({
    name: 'reprocessRecording',
    description:
      'Process or re-process a recording whose audio is already stored. Uploading is NOT consent to transcribe. ' +
      'First clarify the desired outcome and blueprint, then call without confirm to obtain the confirmation wording. ' +
      'Call with confirm: true only after the user explicitly agrees. Re-processing re-transcribes at model cost and ' +
      're-files the transcript; the duration surcharge is not charged again.',
    inputSchema: z.object({
      recordingId: z.string().describe('The recording (Episode) id.'),
      blueprintSlug: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Optional blueprint id chosen with the user. Omit for ingest-only.'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Pass true ONLY after the user has explicitly agreed to process this stored recording with the chosen outcome.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not in a workspace, so there is no brain to ingest into.', isError: true }
      }

      const rec = await deps.getRecording(context.userId, input.recordingId)
      if (!rec || rec.sourceKind !== 'recording') {
        return { data: 'No recording with that id is visible in this workspace.', isError: true }
      }
      if (rec.workspaceId !== context.workspaceId) {
        return { data: 'That recording belongs to a different workspace, so it cannot be processed here.', isError: true }
      }
      const sref = (rec.sourceRef ?? {}) as { gcsKey?: string; fileName?: string }
      if (!sref.gcsKey) {
        return {
          data: 'That recording has no stored audio (the upload never completed), so there is nothing to process. The user must upload the file again.',
          isError: true,
        }
      }

      const alreadyProcessed = await deps.hasProcessed(rec.id)
      // The consent gate applies to first processing too: an upload is a
      // reversible storage action, never implied permission to transcribe.
      if (input.confirm !== true) {
        const name = sref.fileName ?? 'This recording'
        const durationSeconds = rec.durationMs == null
          ? null
          : Math.max(0, Math.round(rec.durationMs / 1000))
        const duration = durationSeconds == null
          ? ''
          : ` It is about ${Math.max(1, Math.round(durationSeconds / 60))} minutes long.`
        const credits = durationSeconds == null || !deps.surchargeCredits
          ? ''
          : ` Estimated processing cost: ${deps.surchargeCredits(durationSeconds)} credits.`
        return {
          data: alreadyProcessed
            ? `CONFIRMATION REQUIRED — ${name} already completed a processing run.${duration}${credits} ` +
              'Re-processing re-transcribes the audio and files the transcript into the brain again ' +
              '(the duration surcharge is not charged twice, but extracted memories may duplicate). ' +
              'Ask the user whether to proceed, and call this tool again with confirm: true only if they agree.'
            : `CONFIRMATION REQUIRED — ${name} is uploaded but has not been processed.${duration}${credits} ` +
              `Proposed outcome: ${input.blueprintSlug ? `use blueprint "${input.blueprintSlug}"` : 'ingest-only (no brief page)'}. ` +
              'Ask the user to confirm this outcome, and call this tool again with confirm: true only if they agree.',
        }
      }

      const { enqueued } = await deps.enqueue({
        recordingId: rec.id,
        workspaceId: rec.workspaceId,
        actingUserId: context.userId,
        blueprintSlug: input.blueprintSlug?.trim() || null,
      })
      if (!enqueued) {
        return { data: 'That recording is already being processed — no new run was started.' }
      }
      return {
        data:
          'Queued. The recording is being re-transcribed and filed into the brain in the background. ' +
          'Tell the user it is on the way.',
      }
    },
  })
}
