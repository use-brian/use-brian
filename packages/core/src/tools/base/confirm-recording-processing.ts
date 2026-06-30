import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * `confirmRecordingProcessing` — the agent-native commit for the channel
 * pre-flight-confirm flow (channel-recording-preflight-confirm §5, decision D2).
 *
 * When a BIG recording lands in a channel, the intake stores a pending
 * confirmation and the assistant asks the user (cost + blueprint). The user's
 * free-text reply is interpreted by the model, which calls this tool with the
 * recording's id and the user's choice. No brittle keyword parser.
 *
 * `choice`:
 *   - a blueprint id  → enqueue the recording with that blueprint (a shaped brief)
 *   - `'ingest-only'` → enqueue with no blueprint (file the transcript only)
 *   - `'cancel'`      → drop the pending row, process nothing (no charge)
 *
 * The tool validates a pending row exists AND that it belongs to THIS turn's
 * channel session (`{channel}:{channel_id}:{user_id}`) before acting — one
 * actor can never confirm another's pending recording. Enqueue reuses the
 * existing `enqueueRecordingJob` seam; the worker does the heavy processing.
 *
 * [COMP:recordings/confirm-recording-processing]
 */

/** The dependency surface this tool needs (injected at boot). */
export type ConfirmRecordingProcessingDeps = {
  /** Build the correlation key the pending row was stored under. */
  buildChannelSessionKey: (input: { channel: string; channelId: string; userId: string }) => string
  /** Fetch the pending confirmation by recording (Episode) id, or null. */
  getPending: (recordingId: string) => Promise<{
    recordingId: string
    channelSessionKey: string
    defaultBlueprintSlug: string | null
  } | null>
  /** Drop the pending row (after enqueue or on cancel). */
  deletePending: (recordingId: string) => Promise<void>
  /** Enqueue the recording job (the existing seam). */
  enqueueRecordingJob: (input: {
    recordingId: string
    workspaceId: string
    actingUserId: string
    blueprintSlug?: string | null
  }) => Promise<{ enqueued: boolean; jobId: string | null }>
}

export function createConfirmRecordingProcessingTool(deps: ConfirmRecordingProcessingDeps) {
  return buildTool({
    name: 'confirmRecordingProcessing',
    description:
      'Commit (or cancel) a big recording that is waiting for the user to confirm processing. ' +
      'A recording awaiting confirmation is surfaced in your turn context with its id, duration, and credit cost. ' +
      'Call this ONLY when the user has replied to that confirmation. ' +
      'Pass the `recordingId` from the context, and `choice`: ' +
      'a blueprint id to shape a brief with that blueprint, ' +
      '"ingest-only" to just file the transcript (no brief), ' +
      'or "cancel" to skip processing entirely (nothing is charged). ' +
      'If the user names the workspace default, pass the default blueprint id shown in the context.',
    inputSchema: z.object({
      recordingId: z
        .string()
        .describe('The id of the recording awaiting confirmation (from your turn context).'),
      choice: z
        .string()
        .describe(
          'A blueprint id to shape a brief, the literal "ingest-only" to file the transcript only, or the literal "cancel" to skip processing.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: 'This recording cannot be processed: the assistant is not in a workspace.',
          isError: true,
        }
      }

      const pending = await deps.getPending(input.recordingId)
      if (!pending) {
        return {
          data: 'No recording is waiting for confirmation under that id. It may have already been processed, cancelled, or expired.',
          isError: true,
        }
      }

      // Actor / conversation check: the pending row must belong to THIS turn's
      // channel session. Prevents confirming a recording from another chat.
      const expectedKey = deps.buildChannelSessionKey({
        channel: context.channelType,
        channelId: context.channelId,
        userId: context.userId,
      })
      if (pending.channelSessionKey !== expectedKey) {
        return {
          data: 'That recording belongs to a different conversation, so it cannot be confirmed here.',
          isError: true,
        }
      }

      const choice = input.choice.trim()

      if (choice.toLowerCase() === 'cancel') {
        await deps.deletePending(pending.recordingId)
        return { data: 'Cancelled. The recording was dropped and nothing was processed or charged.' }
      }

      const blueprintSlug = choice.toLowerCase() === 'ingest-only' ? null : choice
      const { enqueued } = await deps.enqueueRecordingJob({
        recordingId: pending.recordingId,
        workspaceId: context.workspaceId,
        actingUserId: context.userId,
        blueprintSlug,
      })
      // Whether or not the insert was a fresh enqueue (idempotent), the user has
      // decided — drop the pending row so it can't be re-confirmed or expire.
      await deps.deletePending(pending.recordingId)

      if (!enqueued) {
        return { data: 'That recording is already being processed.' }
      }
      return {
        data: blueprintSlug
          ? 'Confirmed. The recording is now being processed into a brief. Tell the user it is on the way.'
          : 'Confirmed. The recording transcript is now being filed. Tell the user it is on the way.',
      }
    },
  })
}
