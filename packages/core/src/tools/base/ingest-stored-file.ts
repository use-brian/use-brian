import { z } from 'zod'
import { buildTool } from '../types.js'
import { actorFromContext } from '../../retrieval/tools.js'
import type { RetrievalActor } from '../../retrieval/types.js'

/**
 * `ingestFile` — deterministic (re-)ingestion of a file ALREADY stored in
 * `workspace_files`, as a first-class operation (existing-file re-ingest;
 * see docs/architecture/brain/file-artifacts.md §"Re-ingest").
 *
 * This is NOT the model reading a file and saving what it deems salient — it
 * enqueues the same derive-text → chunk → Pipeline B routine the upload
 * boundary uses, so coverage, provenance (`source_episode_id`), metering, and
 * failure surfacing are identical to a fresh ingest.
 *
 * Double-ingestion guard (the invariant): a file that ALREADY produced an
 * episode is never silently re-ingested. The first call returns the cost
 * context and instructs the model to ask the user; only an explicit
 * `confirm: true` (after the user agreed) enqueues. An in-flight job is a
 * no-op (queue-level idempotency).
 *
 * [COMP:files/ingest-stored-file-tool]
 */

/** The dependency surface this tool needs (injected at boot). */
export type IngestStoredFileDeps = {
  /** Sensitivity/RLS-scoped file lookup; null when absent OR not visible. */
  getFile: (
    actor: RetrievalActor,
    fileId: string,
  ) => Promise<{
    id: string
    name: string
    mime: string
    sizeBytes: number
    sourceEpisodeId: string | null
  } | null>
  /** The existing file-ingest queue seam (idempotent while a job is active). */
  enqueue: (input: {
    fileId: string
    workspaceId: string
    actingUserId: string
    assistantId?: string | null
    sourceLabel?: string
  }) => Promise<{ enqueued: boolean; jobId: string | null }>
}

export function createIngestStoredFileTool(deps: IngestStoredFileDeps) {
  return buildTool({
    name: 'ingestFile',
    description:
      'Start deterministic brain ingestion for a file that is already stored in this workspace ' +
      '(parse → index → knowledge extraction, the same pipeline an upload uses). ' +
      'Use when the user asks to ingest, re-ingest, or "file into the brain" an existing stored file. ' +
      'If the file was already ingested before, the first call returns a confirmation request instead of running — ' +
      'relay it to the user (re-ingesting spends model credits and can duplicate extracted memories), ' +
      'and call again with confirm: true only after they agree. ' +
      'Not for audio/video recordings — use reprocessRecording for those.',
    inputSchema: z.object({
      fileId: z.string().describe('The stored file id (from the file listing or search results).'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Pass true ONLY after the user has explicitly agreed to re-ingest an already-ingested file.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) {
        return { data: 'This assistant is not in a workspace, so there is no brain to ingest into.', isError: true }
      }

      const file = await deps.getFile(actor, input.fileId)
      if (!file) {
        return { data: 'No stored file with that id is visible in this workspace.', isError: true }
      }
      if (file.mime.startsWith('audio/') || file.mime.startsWith('video/')) {
        return {
          data: `"${file.name}" is a recording (${file.mime}); recordings transcribe through the recording pipeline. Use reprocessRecording instead.`,
          isError: true,
        }
      }

      // The double-ingestion gate: an already-ingested file re-ingests only on
      // an explicit, user-approved confirm.
      if (file.sourceEpisodeId && input.confirm !== true) {
        const sizeKb = Math.max(1, Math.round(file.sizeBytes / 1024))
        return {
          data:
            `CONFIRMATION REQUIRED — "${file.name}" (${sizeKb} KB) was already ingested into the brain. ` +
            'Re-ingesting runs knowledge extraction again: it spends model credits and may duplicate extracted memories ' +
            '(entities deduplicate; memories do not). ' +
            'Ask the user whether to proceed, and call this tool again with confirm: true only if they agree.',
        }
      }

      const { enqueued } = await deps.enqueue({
        fileId: file.id,
        workspaceId: actor.workspaceId,
        actingUserId: actor.userId,
        assistantId: actor.assistantId,
        sourceLabel: file.sourceEpisodeId ? 'reingest' : 'upload',
      })
      if (!enqueued) {
        return { data: `"${file.name}" is already being ingested — no new run was started.` }
      }
      return {
        data:
          `Queued. "${file.name}" is being parsed and filed into the brain in the background; ` +
          'extracted knowledge will be searchable shortly. Tell the user it is on the way.',
      }
    },
  })
}
