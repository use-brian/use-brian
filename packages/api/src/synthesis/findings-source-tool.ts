// [COMP:api/findings-source-tool] — pre-gathered research findings as a synthesis
// SOURCE, as an in-process core Tool.
//
// For `kind:'research'` synthesis (the EXTRACT fill mode over a web gather), the
// source is NOT an Episode and NOT the brain: it is the findings a research
// fan-out already gathered, returned by `runPreflight` as a formatted string that
// is never persisted. The synthesis engine only ever needs a `sourceTool`, so the
// findings ARE the source — this tool hands the model the gathered text. There is
// no store call and no remote fetch: the findings are bound in the closure (like
// `createSearchRecordingTool` pins its `recordingId`), so the model physically
// cannot pivot to anything the fan-out did not gather.
//
// Named `searchSource` so the engine's source-tool envelope reads identically
// across the brain (generate) and research sources. The `query` is accepted (so
// the model can call it conversationally) but only used to scope the returned
// slice when the findings are long; the full findings are the default. See
// docs/architecture/brain/structural-synthesis.md → "The three fill modes"
// (Research) + "Build status".

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'

export type CreateFindingsSourceToolDeps = {
  /** The pre-gathered research findings (a `runPreflight` formatted gather string). */
  findings: string
}

/** Above this, a query-scoped read returns only the matching paragraphs to keep
 *  the tool result bounded; below it the whole gather is cheap to hand back. */
const FULL_RETURN_CHARS = 12_000

const inputSchema = z.object({
  query: z
    .string()
    .default('')
    .describe(
      'Optional focus for this read. The gathered research is returned in full by default; ' +
        'pass a query only to narrow a long gather to the relevant passages.',
    ),
})

/** Split a findings blob into paragraph blocks for loose query filtering. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * Build an in-process `searchSource` tool that returns the pre-gathered research
 * findings. Read-only and concurrency-safe. The query loosely filters a long
 * gather (substring match over paragraphs, falling back to the full text when
 * nothing matches) — there is no I/O to fail, so this never errors.
 */
export function createFindingsSourceTool(deps: CreateFindingsSourceToolDeps): Tool {
  const findings = deps.findings ?? ''
  return buildTool({
    name: 'searchSource',
    description:
      'Read the research already gathered for this brief (web sources the workflow collected). ' +
      'Returns those findings — your ONLY source. Pass a `query` to focus a long gather on the ' +
      'relevant passages, or omit it to see everything. Synthesize the brief from these findings; ' +
      'never invent facts they do not contain.',
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 5_000,
    async execute(input) {
      const query = (input.query ?? '').trim().toLowerCase()
      // Default: hand back the full gather. Only narrow when it is large AND a
      // query is given — a loose substring filter over paragraphs, never an
      // empty result (fall back to the full text so a section is never starved).
      if (!query || findings.length <= FULL_RETURN_CHARS) {
        return { data: findings }
      }
      const matched = paragraphs(findings).filter((p) => p.toLowerCase().includes(query))
      return { data: matched.length > 0 ? matched.join('\n\n') : findings }
    },
  })
}
