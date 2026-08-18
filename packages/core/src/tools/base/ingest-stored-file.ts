import { z } from 'zod'
import { buildTool } from '../types.js'
import { actorFromContext } from '../../retrieval/tools.js'
import type { RetrievalActor } from '../../retrieval/types.js'
import { toolFailure } from '../tool-failure.js'

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
 * Consent guard (the invariant): storing or pinning a file is not permission to
 * interpret it. The first call always returns the proposed work and instructs
 * the model to ask the user; only explicit `confirm: true` after agreement
 * enqueues. Previously-ingested files add the duplicate-memory warning. An
 * in-flight job is a no-op (queue-level idempotency).
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
      'Uploading or pinning is NOT consent to interpret: first clarify the user\'s purpose, then call without confirm ' +
      'to obtain the confirmation wording. Call with confirm: true only after the user explicitly agrees. ' +
      'Re-ingesting a previously processed file can duplicate extracted memories. ' +
      'Not for audio/video recordings — use reprocessRecording for those.',
    inputSchema: z.object({
      fileId: z.string().describe('The stored file id (from the file listing or search results).'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Pass true ONLY after the user has explicitly agreed to parse, index, and extract this stored file.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) {
        // Same sentence the retrieval gate uses (`retrieval/tools.ts` →
        // `actorFromContext`), adapted for the write direction — one wording
        // for "this chat has no workspace", so the model does not read two
        // different sentences as two different problems.
        return {
          data:
            'This chat is not bound to a workspace, so there is no company brain to ingest into — brain rows are workspace-scoped and there is no permission boundary to evaluate. ' +
            'No argument change or retry will help in this session. Nothing was ingested. Tell the user to ask from a workspace chat.',
          isError: true,
        }
      }

      let file: Awaited<ReturnType<IngestStoredFileDeps['getFile']>>
      try {
        file = await deps.getFile(actor, input.fileId)
      } catch (err) {
        return toolFailure(err, {
          tool: 'ingestFile',
          action: 'The stored-file lookup',
          target: `file \`${input.fileId}\``,
          next: 'Nothing was ingested and no credits were spent.',
        })
      }
      if (!file) {
        // Same dead-end shape as the workspace-files `not_found` (see
        // `workspace-files/tool-helpers.ts` → errorMessage). This tool is NOT
        // capability-gated, so on an assistant without `files` it is the only
        // file-shaped tool left in the list — which is exactly what a model
        // reaches for when asked to attach a photo it can see. It must say
        // where to go instead of just failing.
        return {
          data:
            `No stored file with id ${input.fileId} is visible in this workspace. ` +
            'If that id came from an <attached_file id="…"> tag it is an UPLOADED attachment, not a stored file — ' +
            'this tool only re-ingests files already saved in the workspace. Save the upload into the workspace files first, ' +
            'then ingest the id that save returns. If you have no tool to save uploaded files, tell the user plainly that ' +
            'this assistant cannot keep files and that Workspace files must be turned on for it in Studio → the assistant → Capabilities.',
          isError: true,
        }
      }
      if (file.mime.startsWith('audio/') || file.mime.startsWith('video/')) {
        return {
          data: `"${file.name}" is a recording (${file.mime}); recordings transcribe through the recording pipeline. Use reprocessRecording instead.`,
          isError: true,
        }
      }

      // The consent gate applies to first ingest too: storage/pinning is a
      // reversible action and cannot silently turn into knowledge extraction.
      if (input.confirm !== true) {
        const sizeKb = Math.max(1, Math.round(file.sizeBytes / 1024))
        return {
          data: file.sourceEpisodeId
            ? `CONFIRMATION REQUIRED — "${file.name}" (${sizeKb} KB) was already ingested into the brain. ` +
              'Re-ingesting runs parsing, indexing, and knowledge extraction again: it spends model credits and may duplicate extracted memories ' +
              '(entities deduplicate; memories do not). Ask the user whether to proceed, and call this tool again with confirm: true only if they agree.'
            : `CONFIRMATION REQUIRED — "${file.name}" (${sizeKb} KB) is stored but has not been ingested. ` +
              'Ingesting will parse and index its content, then extract knowledge such as memories, entities, and possible tasks. ' +
              'Ask what outcome the user wants and whether to proceed; call this tool again with confirm: true only after they explicitly agree.',
        }
      }

      let enqueued: boolean
      try {
        ;({ enqueued } = await deps.enqueue({
          fileId: file.id,
          workspaceId: actor.workspaceId,
          actingUserId: actor.userId,
          assistantId: actor.assistantId,
          sourceLabel: file.sourceEpisodeId ? 'reingest' : 'upload',
        }))
      } catch (err) {
        return toolFailure(err, {
          tool: 'ingestFile',
          action: 'Queueing the file for brain ingestion',
          target: `file \`${file.id}\` ("${file.name}")`,
          mutating: true,
          next:
            'Ingestion did NOT start and no credits were spent. The user has already consented, so the same call can be repeated once the cause is fixed — do not ask them again.',
        })
      }
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
