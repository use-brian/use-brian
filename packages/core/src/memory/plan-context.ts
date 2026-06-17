/**
 * Execution-plan retrieval + system-prompt formatting.
 *
 * Fetches the session's ACTIVE attempt and formats it into a `# Active plan`
 * block. Returns `null` (block omitted) when there is no active attempt — a
 * dormant or archived attempt produces no rows from `listActiveBySession`, so
 * the block cannot leak into an unrelated turn. That liveness gate is the
 * inverse of the always-on session-state tier; see
 * `docs/architecture/context-engine/execution-plan.md` "Attempt lifecycle".
 *
 * Token budget ~600. Open (pending/in_progress) rows are load-bearing and
 * never trimmed; closed rows trim from the tail on overflow.
 */

import { isOpenStatus, type PlanStepRecord, type PlanStore } from './plan-types.js'

const ROUGH_CHARS_PER_TOKEN = 4
const DEFAULT_TOKEN_BUDGET = 600

export type BuildActivePlanBlockOptions = {
  store: PlanStore
  sessionId: string
  /** Defaults to 600. */
  tokenBudget?: number
}

const HEADER =
  '# Active plan\n\n' +
  'You are working a multi-step task. Work the next pending step; do not end ' +
  'your turn while steps are [pending] or [in_progress] unless every remaining ' +
  'step is [blocked] with a reason. If a step cannot be done, mark it [blocked] ' +
  'and say why.\n\n'

function estimateChars(s: string): number {
  return s.length
}

function formatRow(r: PlanStepRecord, n: number): string {
  const note = r.note?.trim() ? ` (${r.note.trim()})` : ''
  return `  ${n}. [${r.status}] ${r.key} - ${r.description}${note}`
}

function assemble(rows: PlanStepRecord[]): string {
  const lines = rows.map((r, i) => formatRow(r, i + 1))
  return HEADER + lines.join('\n')
}

/**
 * Returns the formatted `# Active plan` block, or `null` when the session has
 * no active attempt (the omit signal for the prompt builder).
 */
export async function buildActivePlanBlock(
  opts: BuildActivePlanBlockOptions,
): Promise<string | null> {
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET

  const rows = await opts.store.listActiveBySession(opts.sessionId)
  if (rows.length === 0) return null

  // Open rows are load-bearing; never trim. Trim closed rows from the tail.
  const open = rows.filter((r) => isOpenStatus(r.status))
  let kept: PlanStepRecord[] = rows
  let assembled = assemble(kept)
  while (
    estimateChars(assembled) > budget * ROUGH_CHARS_PER_TOKEN &&
    kept.length > open.length
  ) {
    // Drop the last closed row.
    const lastClosedIdx = [...kept]
      .map((r, i) => ({ r, i }))
      .reverse()
      .find(({ r }) => !isOpenStatus(r.status))?.i
    if (lastClosedIdx === undefined) break
    kept = kept.filter((_, i) => i !== lastClosedIdx)
    assembled = assemble(kept)
  }

  return assembled
}
