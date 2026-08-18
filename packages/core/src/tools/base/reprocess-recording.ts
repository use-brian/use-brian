import { z } from 'zod'
import { buildTool } from '../types.js'
import { toolFailure } from '../tool-failure.js'

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
        return {
          data:
            'This chat is not bound to a workspace, so there is no company brain to ingest into — brain rows are workspace-scoped and there is no permission boundary to evaluate. ' +
            'No argument change or retry will help in this session. Nothing was processed. Tell the user to ask from a workspace chat.',
          isError: true,
        }
      }

      let rec: Awaited<ReturnType<ReprocessRecordingDeps['getRecording']>>
      try {
        rec = await deps.getRecording(context.userId, input.recordingId)
      } catch (err) {
        return toolFailure(err, {
          tool: 'reprocessRecording',
          action: 'The recording lookup',
          target: `recording \`${input.recordingId}\``,
          next: 'Nothing was processed and no credits were spent.',
        })
      }
      // Two distinct causes, two distinct messages: an id that resolves to
      // nothing is a discovery problem, an id that resolves to the wrong KIND
      // of thing is a routing problem. Collapsing them made the model retry
      // the same id against the same tool.
      if (!rec) {
        return {
          data:
            `No recording with id \`${input.recordingId}\` is visible in this workspace. ` +
            'Either the id is wrong or the recording is above your clearance. ' +
            'Ids for stored media come from `fileSearch` (search the workspace files) or from the `<attached_file id="…">` tag on the message that carried it. ' +
            'Do NOT retry this exact id — re-resolve it with `fileSearch` first, or ask the user which recording they mean.',
          isError: true,
        }
      }
      if (rec.sourceKind !== 'recording') {
        return {
          data:
            `\`${input.recordingId}\` exists but is a "${rec.sourceKind}", not a recording. ` +
            '`reprocessRecording` only accepts recordings (audio/video episodes with stored bytes); ' +
            'stored documents and other files go through `ingestFile` instead. ' +
            'Retrying this exact id here will fail the same way — call `ingestFile` with it, or find the real recording with `fileSearch`.',
          isError: true,
        }
      }
      if (rec.workspaceId !== context.workspaceId) {
        return {
          data:
            `Recording \`${input.recordingId}\` belongs to a different workspace, so it cannot be processed here — recordings are processed into the brain of their own workspace. ` +
            'Do NOT retry this id; ask the user to run this from the workspace that owns the recording.',
          isError: true,
        }
      }
      const sref = (rec.sourceRef ?? {}) as { gcsKey?: string; fileName?: string }
      if (!sref.gcsKey) {
        return {
          data:
            `Recording \`${input.recordingId}\` has no stored audio (the upload never completed), so there is nothing to transcribe. ` +
            'No retry of this id can succeed until the bytes exist. Tell the user to upload the file again.',
          isError: true,
        }
      }

      let alreadyProcessed: boolean
      try {
        alreadyProcessed = await deps.hasProcessed(rec.id)
      } catch (err) {
        return toolFailure(err, {
          tool: 'reprocessRecording',
          action: 'The previous-run check',
          target: `recording \`${rec.id}\``,
          next:
            'Nothing was processed. This check is what stops a silent duplicate re-transcription, so do not skip it by passing confirm: true.',
        })
      }
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

      let enqueued: boolean
      try {
        ;({ enqueued } = await deps.enqueue({
          recordingId: rec.id,
          workspaceId: rec.workspaceId,
          actingUserId: context.userId,
          blueprintSlug: input.blueprintSlug?.trim() || null,
        }))
      } catch (err) {
        return toolFailure(err, {
          tool: 'reprocessRecording',
          action: 'Queueing the recording for processing',
          target: `recording \`${rec.id}\``,
          mutating: true,
          next:
            'Processing did NOT start and no credits were spent. The user has already consented, so the same call can be repeated once the cause is fixed — do not ask them again.',
        })
      }
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
