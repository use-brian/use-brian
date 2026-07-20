// [COMP:files/artifact-tools] — searchFileContent as an in-process core Tool.
//
// The model-facing surface over the file_segments substrate
// (large-content-artifacts §Phase 1.4): ONE tool with two modes, mirroring the
// searchRecording pattern —
//   • query mode  → searchFileSegments (hybrid vector/ILIKE inside ONE file)
//   • range mode  → readFileSegmentRange (sequential section windows)
// `fileId` IS a model input (uuid) — manifests hand the artifact id to the
// model in-transcript, unlike the synthesis loop's closure-pinned recording
// tool. The actor is built per call from the ToolContext (chat threads
// clearance directly; the callee executor threads resolveReadCeilingsSystem
// output), so every read is ceiling-correct on every injection path.
//
// Registered ONCE in the boot base toolset beside readFileContent, so chat,
// the callee/inter-assistant executor, and workflows all get it by
// construction (the "works in chat, missing in workflow" footgun is closed
// structurally). A brain-MCP twin lives in brain-mcp/tools.ts.
// Named searchFileContent, NOT searchFile — `fileSearch` (workspace-file
// DESCRIPTOR search) already exists and the pair would be model-confusable.

import { z } from 'zod'
import { buildTool, actorFromContext, type Embedder, type Tool } from '@use-brian/core'
import {
  searchFileSegments,
  readFileSegmentRange,
  type FileSegmentHit,
} from '../db/retrieval-store.js'

export type CreateSearchFileContentToolDeps = {
  /** Query embedder for the vector arm; omit to fall back to the ILIKE arm. */
  embedder?: Pick<Embedder, 'embed'>
}

/** Sequential paging defaults to a 10-segment window when only `fromIndex` is given. */
const RANGE_WINDOW = 9

const inputSchema = z.object({
  fileId: z
    .string()
    .uuid()
    .describe('The stored file (artifact) id, from an <attached_file kind="artifact"> manifest or a file_segment search hit.'),
  query: z
    .string()
    .default('')
    .describe('What to look for inside this one file, in natural language. Ignored when paging with fromIndex.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('How many sections to return (default 8, max 20). Ignored when paging with fromIndex.'),
  fromIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Sequential paging: first section index to read (use instead of query for an ordered read-through).'),
  toIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Sequential paging: last section index to read (defaults to fromIndex + 9).'),
})

/**
 * Build the searchFileContent tool. Read-only and concurrency-safe; the 30s
 * timeout matches searchRecording's budget. Errors cleanly (never throws into
 * the loop) and returns a plain message when the session has no workspace.
 */
export function createSearchFileContentTool(deps: CreateSearchFileContentToolDeps = {}): Tool {
  const { embedder } = deps
  return buildTool({
    name: 'searchFileContent',
    description:
      'Retrieve passages from ONE stored document (a workspace file artifact), scoped to that file only — ' +
      'never the whole company brain. Pass the `fileId` from an attached-file manifest or a file_segment ' +
      'search hit, plus a `query`; returns the most relevant sections, each with its `segment_index` and ' +
      '`heading_path` breadcrumb so you can cite the exact place. For a summary or ordered read-through, ' +
      'page sequential windows with `fromIndex`/`toIndex` instead of relying on top-K. ' +
      'Never returns the whole document at once.',
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor.error, isError: true }
      try {
        let hits: FileSegmentHit[]
        if (typeof input.fromIndex === 'number') {
          const from = input.fromIndex
          const to = typeof input.toIndex === 'number' ? input.toIndex : from + RANGE_WINDOW
          hits = await readFileSegmentRange(actor, { fileId: input.fileId, fromIndex: from, toIndex: to })
        } else {
          hits = await searchFileSegments(
            actor,
            { fileId: input.fileId, query: input.query ?? '', topK: input.topK },
            embedder ? { embedder } : undefined,
          )
        }
        return { data: hits }
      } catch (err) {
        return {
          data: `searchFileContent failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}
