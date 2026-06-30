// [COMP:recordings/recording-search-tool] — searchRecording as an in-process core Tool.
//
// The retrieval store already exposes searchRecording() / readRecordingRange()
// (RLS + vector/ILIKE fusion over transcript_segments), but only wrapped as a
// `BrainTool` for the external MCP server. The in-process synthesis loop (and any
// server-side queryLoop) consumes the core `Tool` shape, so this re-wraps the
// SAME store functions in that shape. The `recordingId` is BOUND IN THE CLOSURE,
// not a model input — the model physically cannot pivot to another recording.
//
// Mirrors the BrainTool body in brain-mcp/tools.ts (`searchRecordingTool`); the
// external BrainTool version stays for MCP clients. See
// docs/architecture/brain/structural-synthesis.md → "searchRecording as an
// in-process tool".

import { z } from 'zod'
import { buildTool, type Embedder, type RetrievalActor, type Tool } from '@sidanclaw/core'
import {
  searchRecording as searchRecordingFn,
  readRecordingRange,
  type RecordingSegmentHit,
} from '../db/retrieval-store.js'

export type CreateSearchRecordingToolDeps = {
  /** The recording Episode id, pinned for the whole run — NOT a model input. */
  recordingId: string
  /** The retrieval actor (workspace/user/assistant/clearance) the reads are scoped to. */
  actor: RetrievalActor
  /** Query embedder for the vector arm; omit to fall back to the ILIKE arm. */
  embedder?: Pick<Embedder, 'embed'>
}

/** Sequential paging defaults to a 10-segment window when only `fromIndex` is given. */
const RANGE_WINDOW = 9

const inputSchema = z.object({
  query: z
    .string()
    .default('')
    .describe('What to look for in this recording, in natural language.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('How many segments to return (default 8, max 20). Ignored when paging with fromIndex.'),
  fromIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Sequential paging: first segment index to read (use instead of query for an overview).'),
  toIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Sequential paging: last segment index to read (defaults to fromIndex + 9).'),
})

/**
 * Build an in-process `searchRecording` tool pinned to one recording + actor.
 * Routes to `readRecordingRange` (sequential paging) when `fromIndex` is present,
 * otherwise the hybrid vector/ILIKE search. Read-only and concurrency-safe; the
 * 30s timeout matches the external BrainTool budget.
 */
export function createSearchRecordingTool(deps: CreateSearchRecordingToolDeps): Tool {
  const { recordingId, actor, embedder } = deps
  return buildTool({
    name: 'searchRecording',
    description:
      'Retrieve passages from THIS transcribed recording only (never the whole company brain). ' +
      'Pass a `query`; returns the most relevant segments with `start_ms` timestamps and `speaker`, ' +
      'so you can cite the exact moment ("around 47:12, Priya said ..."). For an overview that spans ' +
      'many segments, page sequential windows with `fromIndex`/`toIndex` instead of relying on top-K. ' +
      'Never returns the whole transcript at once.',
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input) {
      try {
        let hits: RecordingSegmentHit[]
        if (typeof input.fromIndex === 'number') {
          const from = input.fromIndex
          const to = typeof input.toIndex === 'number' ? input.toIndex : from + RANGE_WINDOW
          hits = await readRecordingRange(actor, { recordingId, fromIndex: from, toIndex: to })
        } else {
          hits = await searchRecordingFn(
            actor,
            { recordingId, query: input.query ?? '', topK: input.topK },
            embedder ? { embedder } : undefined,
          )
        }
        return { data: hits }
      } catch (err) {
        return {
          data: `searchRecording failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}
