import { z } from 'zod'
import { buildTool } from '../types.js'
import { toolFailure } from '../tool-failure.js'

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
 * `choice` is also validated against the choice set this confirmation
 * OFFERED before anything is queued. It used to be passed straight through
 * as a blueprint slug, so a model relaying the user's words verbatim
 * ("yes", "the default", "process it") enqueued `blueprintSlug: "yes"` — the
 * synthesizer then failed to resolve that blueprint, logged a warning, and
 * silently produced no brief. The user paid the surcharge and got nothing,
 * with no error anywhere in the chain. An unrecognised `choice` is now a
 * refusal that names the value and the ids that WOULD work.
 *
 * [COMP:recordings/confirm-recording-processing]
 */

/**
 * Replies a user gives to the confirmation ask that the model must MAP to a
 * choice rather than forward verbatim. None of these is a blueprint id.
 */
const NON_CHOICE_REPLIES = new Set([
  'yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'please', 'yes please',
  'default', 'the default', 'use the default', 'workspace default', 'the workspace default',
  'go', 'go ahead', 'do it', 'proceed', 'confirm', 'confirmed', 'process', 'process it',
  'brief', 'a brief', 'make a brief', 'summarise', 'summarize', 'transcribe',
  'no', 'nope', 'skip', 'stop', 'nothing', 'none',
])

/** A blueprint id is a slug or uuid — never a phrase, never empty. */
const BLUEPRINT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

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
      'If the user names the workspace default, pass the default blueprint id shown in the context. ' +
      'Never forward the user\'s wording verbatim ("yes", "the default", "process it") — map it to one of those values first; an unrecognised choice is refused and nothing is processed.',
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
          data:
            'This chat is not bound to a workspace, so the recording cannot be processed here — recordings and their briefs are workspace-scoped. ' +
            'No argument change or retry will help in this session. Tell the user to confirm the recording from a workspace chat.',
          isError: true,
        }
      }

      let pending: Awaited<ReturnType<ConfirmRecordingProcessingDeps['getPending']>>
      try {
        pending = await deps.getPending(input.recordingId)
      } catch (err) {
        return toolFailure(err, {
          tool: 'confirmRecordingProcessing',
          action: 'The pending-confirmation lookup',
          target: `recording \`${input.recordingId}\``,
          next: 'Nothing was queued and nothing was charged; the recording is still held.',
        })
      }
      if (!pending) {
        return {
          data:
            `No recording is waiting for confirmation under id \`${input.recordingId}\`. ` +
            'It was already confirmed, cancelled, or expired (held confirmations are dropped after 24h). ' +
            'Recording ids come from the "Recording awaiting confirmation" section of your turn context — there is no lookup tool for them, ' +
            'so if that section is absent there is nothing to confirm. ' +
            `Do NOT retry this exact id; tell the user the recording is no longer held and ask them to re-send it if they still want it processed.`,
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
          data:
            `Recording \`${input.recordingId}\` was held in a different conversation, so it cannot be confirmed here — ` +
            'a held recording is only confirmable by the person and chat it was sent from. ' +
            'Do NOT retry this id; tell the user to reply in the conversation where they sent the recording.',
          isError: true,
        }
      }

      const choice = input.choice.trim()
      const lowered = choice.toLowerCase()

      // Choice validation — BEFORE anything is queued or charged. The choice
      // set this confirmation offered is: the workspace default blueprint id
      // (when one is set), any other blueprint id, "ingest-only", "cancel".
      const isCancel = lowered === 'cancel'
      const isIngestOnly = lowered === 'ingest-only' || lowered === 'ingest only' || lowered === 'ingest_only'
      if (!isCancel && !isIngestOnly) {
        const looksLikeId = BLUEPRINT_ID_SHAPE.test(choice) && !NON_CHOICE_REPLIES.has(lowered)
        if (!looksLikeId) {
          const defaultPart = pending.defaultBlueprintSlug
            ? `the blueprint id \`${pending.defaultBlueprintSlug}\` (this workspace's default — this is what "yes" or "the default" maps to)`
            : 'a blueprint id from your turn context (this workspace has no default blueprint set)'
          return {
            data:
              `\`confirmRecordingProcessing\` did not run on recording \`${input.recordingId}\`: ` +
              `"${choice}" is not one of the choices this confirmation offers. ` +
              `Valid choices are ${defaultPart}, "ingest-only" to file the transcript with no brief, ` +
              'or "cancel" to drop the recording without charging. ' +
              'The user\'s wording is not the choice — map their reply to one of those values and pass THAT. ' +
              'Nothing was queued, nothing was charged, and the recording is still held. ' +
              `Retrying with "${choice}" will fail the same way.`,
            isError: true,
          }
        }
      }

      if (isCancel) {
        try {
          await deps.deletePending(pending.recordingId)
        } catch (err) {
          return toolFailure(err, {
            tool: 'confirmRecordingProcessing',
            action: 'Cancelling the pending confirmation',
            target: `recording \`${pending.recordingId}\``,
            mutating: true,
            next: 'The recording is still held awaiting confirmation; nothing was processed or charged.',
          })
        }
        return { data: 'Cancelled. The recording was dropped and nothing was processed or charged.' }
      }

      const blueprintSlug = isIngestOnly ? null : choice
      let enqueued: boolean
      try {
        ;({ enqueued } = await deps.enqueueRecordingJob({
          recordingId: pending.recordingId,
          workspaceId: context.workspaceId,
          actingUserId: context.userId,
          blueprintSlug,
        }))
      } catch (err) {
        return toolFailure(err, {
          tool: 'confirmRecordingProcessing',
          action: 'Queueing the recording for processing',
          target: `recording \`${pending.recordingId}\``,
          mutating: true,
          next:
            'Processing did NOT start and no surcharge was applied; the recording is still held, so the same choice can be re-sent once the cause is fixed.',
        })
      }
      // Whether or not the insert was a fresh enqueue (idempotent), the user has
      // decided — drop the pending row so it can't be re-confirmed or expire.
      try {
        await deps.deletePending(pending.recordingId)
      } catch (err) {
        // Processing HAS started here — the copy must not claim otherwise, and
        // must not invite a re-confirm that would look like a second charge.
        return toolFailure(err, {
          tool: 'confirmRecordingProcessing',
          action: 'Clearing the pending confirmation after queueing',
          target: `recording \`${pending.recordingId}\``,
          next:
            'Processing DID start — the recording is being processed and the surcharge applies. Only the held confirmation row was left behind (it expires on its own). Tell the user their recording is on the way, and do NOT call this tool again for this recording.',
        })
      }

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
