import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * `reprocessRecording` — re-run the recording pipeline (transcribe → segment →
 * brain ingest) for a recording that already has its bytes stored, as a thin
 * agent affordance over the existing recording-jobs queue — the same seam the
 * upload flow and `confirmRecordingProcessing` enqueue through. No parallel
 * mechanism (see docs/architecture/media/transcription.md §"Re-processing").
 *
 * Double-ingestion guard (the invariant): a recording that ALREADY completed a
 * processing run is never silently re-processed. The first call returns the
 * cost context and instructs the model to ask the user; only an explicit
 * `confirm: true` (after the user agreed) enqueues. An in-flight job is a
 * no-op (queue-level idempotency). The duration surcharge is idempotent per
 * recording, so a re-run never double-bills credits — the spend is the
 * re-transcription COGS plus extraction.
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
}

export function createReprocessRecordingTool(deps: ReprocessRecordingDeps) {
  return buildTool({
    name: 'reprocessRecording',
    description:
      'Re-run transcription and brain ingestion for a recording whose audio is already stored ' +
      '(e.g. a recording whose earlier processing failed or produced nothing usable). ' +
      'If the recording already completed a processing run, the first call returns a confirmation request instead of running — ' +
      'relay it to the user (re-processing re-transcribes at model cost and re-files the transcript; ' +
      'the duration surcharge is NOT charged again), and call again with confirm: true only after they agree.',
    inputSchema: z.object({
      recordingId: z.string().describe('The recording (Episode) id.'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Pass true ONLY after the user has explicitly agreed to re-process an already-processed recording.',
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

      // The double-ingestion gate: a completed recording re-processes only on
      // an explicit, user-approved confirm.
      if ((await deps.hasProcessed(rec.id)) && input.confirm !== true) {
        const name = sref.fileName ?? 'This recording'
        return {
          data:
            `CONFIRMATION REQUIRED — ${name} already completed a processing run. ` +
            'Re-processing re-transcribes the audio (model cost) and files the transcript into the brain again ' +
            '(the duration surcharge is NOT charged twice, but extracted memories may duplicate). ' +
            'Ask the user whether to proceed, and call this tool again with confirm: true only if they agree.',
        }
      }

      const { enqueued } = await deps.enqueue({
        recordingId: rec.id,
        workspaceId: rec.workspaceId,
        actingUserId: context.userId,
        blueprintSlug: null,
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
