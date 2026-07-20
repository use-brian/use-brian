// [COMP:api/brain-source-tool] — the company brain as a synthesis SOURCE, as an
// in-process core Tool.
//
// For `kind:'brain'` synthesis (the GENERATE fill mode — "draft from what the
// brain already knows"), the model gathers context from the company brain
// instead of a recording transcript. The retrieval store already exposes
// `search()` (RRF + trust + MMR over the whole brain, RLS-scoped), and the core
// `createRetrievalTools` already wraps it as a `search` core Tool — but that
// wrapper reads the viewer clearance from `ToolContext.clearance`, which the
// unattended synthesis loop never sets (undefined → `confidential` passthrough).
// Sensitivity-inherited is a LOCKED synthesis invariant, so this wrapper pins the
// `RetrievalActor` (clearance derived from the source Episode's sensitivity) in
// the CLOSURE — the read ceiling cannot be widened by the loop context, exactly
// the way `createSearchRecordingTool` pins its `recordingId` + actor.
//
// The tool is named `searchSource` so the engine's source-tool envelope reads the
// same across both source kinds (the recording path passes `searchRecording`; the
// generate path passes this). See docs/architecture/brain/structural-synthesis.md
// → "The three fill modes" (Generate) + "searchRecording as an in-process tool".

import { z } from 'zod'
import { buildTool, type RetrievalActor, type Tool } from '@use-brian/core'
import { search as searchBrain, type RetrievalStoreDeps } from '../db/retrieval-store.js'

export type CreateBrainSourceToolDeps = {
  /**
   * The retrieval actor (workspace / user / assistant / clearance) the brain
   * reads are scoped to. `clearance` is the read ceiling — pin it from the
   * source's sensitivity so the generate loop can never read above the source.
   */
  actor: RetrievalActor
  /** Vector-arm deps (embedder) forwarded to the store; omit → FTS/ILIKE only. */
  storeDeps?: RetrievalStoreDeps
}

/** Mirrors the retrieval `search` tool's cap so the model cannot over-fetch. */
const LIMIT_CAP = 100

const inputSchema = z.object({
  query: z
    .string()
    .min(1, 'query is required')
    .describe('What to look for in the company brain, in natural language.'),
  scope: z
    .string()
    .optional()
    .describe('Optional primitive kind to narrow the search (e.g. a single brain scope).'),
  limit: z
    .number()
    .int()
    .positive()
    .max(LIMIT_CAP)
    .optional()
    .describe('How many rows to return (default store page size, max 100).'),
})

/**
 * Build an in-process `searchSource` tool that reads the company brain under a
 * fixed actor + clearance. Read-only and concurrency-safe; the 30s timeout
 * matches the recording source tool. Errors are returned in-band (`isError`) so
 * a brain miss degrades the synthesis loop rather than aborting it.
 */
export function createBrainSourceTool(deps: CreateBrainSourceToolDeps): Tool {
  const { actor, storeDeps } = deps
  return buildTool({
    name: 'searchSource',
    description:
      'Search the company brain for the facts this draft needs (people, companies, deals, ' +
      'past notes, decisions). Pass a `query` in natural language; returns matched brain rows ' +
      'keyed by `primitive` + `row_id`. This is your only source — synthesize the draft from ' +
      'what it returns, never invent facts the brain does not hold.',
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input) {
      try {
        const result = await searchBrain(
          actor,
          { query: input.query, scope: input.scope, limit: input.limit },
          storeDeps,
        )
        return { data: result }
      } catch (err) {
        return {
          data: `searchSource failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}
