/**
 * [COMP:brain/github-task-match]
 *
 * LLM matcher: does this GitHub PR implement one of the workspace's open dev
 * tasks? The deterministic lifecycle (`task-lifecycle.ts`) covers PRs that
 * reference an issue number; this covers the common case it cannot — a task
 * created from chat ("fix the login redirect bug") that no issue mirrors, and
 * a PR whose author never typed `#N`.
 *
 * Spec: docs/plans/tasks-suggestion-first.md §1-D4, §7.
 *
 * SHAPE. This module is the pure half: prompt, response schema, and parsing/
 * verification. The executor (ingest processor) supplies the candidate pool
 * (live open tasks by `word_similarity` against the PR text, capped), makes
 * the provider call on the background/extraction model, meters it as
 * `overhead:classifier` (trigger `github_task_match`), and applies the
 * verdict:
 *   - only `confidence: 'high'` acts; `medium`/`low`/no-match do nothing
 *     (no status-review queue in v1 — a wrong auto-transition is worse than
 *     a missed one).
 *   - `pull_request.opened` match → `in_review`, and the task is stamped
 *     with a `{provider:'github', repo, kind:'pr', number}` external ref so
 *     the eventual merge reconciles DETERMINISTICALLY (one judge call per
 *     PR, not per event).
 *   - `pull_request.merged` match → `done`.
 * Tasks already backlinked to a github ref are excluded from the pool — the
 * deterministic lane owns them.
 */

import { z } from 'zod'

/** PR-side backlink stamped when the judge matches a ref-less PR to a task. */
export type GithubPrRef = {
  provider: 'github'
  repo: string
  kind: 'pr'
  number: number
}

export function githubPrRef(repo: string, number: number): GithubPrRef {
  return { provider: 'github', repo, kind: 'pr', number }
}

export type GithubTaskMatchCandidate = {
  id: string
  title: string
  /** Optional `attributes.description`, truncated by the caller. */
  description?: string | null
}

export type GithubTaskMatchResult = {
  /** Index into the candidate list, or null when nothing matches. */
  matchIndex: number | null
  confidence: 'high' | 'medium' | 'low'
  explanation: string
}

export const GITHUB_TASK_MATCH_SYSTEM_PROMPT =
  'You judge whether a GitHub pull request implements one of a team\'s tracked tasks. ' +
  'You only answer with the requested JSON. Be conservative: a wrong match silently moves ' +
  'a task the PR did not touch, which is worse than no match. "high" confidence means the PR ' +
  'clearly implements the specific work the task describes, not merely a related area.'

export const GITHUB_TASK_MATCH_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    match_index: { type: ['integer', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    explanation: { type: 'string' },
  },
  required: ['match_index', 'confidence', 'explanation'],
  additionalProperties: false,
} as const

const matchResponseSchema = z.object({
  match_index: z.number().int().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  explanation: z.string(),
})

export function buildGithubTaskMatchPrompt(
  pr: { repo: string; number: number | null; title: string; body: string | null; branch: string | null },
  candidates: readonly GithubTaskMatchCandidate[],
): string {
  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i}. ${c.title}${c.description ? `\n   ${c.description.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
    )
    .join('\n')
  return `Pull request in ${pr.repo}${pr.number !== null ? ` (#${pr.number})` : ''}:
Title: ${pr.title}
${pr.branch ? `Branch: ${pr.branch}\n` : ''}${pr.body ? `Body:\n${pr.body.slice(0, 2000)}\n` : ''}
Tracked open tasks (index is identity):
${candidateLines}

Does this pull request implement exactly one of these tasks?
- match_index: the task's index, or null if none clearly matches.
- confidence: "high" only when the PR unambiguously implements that specific task's work. A PR that merely touches the same file, feature area, or dependency is "low".
- explanation: one short sentence.

Output exactly: {"match_index": <int|null>, "confidence": "high"|"medium"|"low", "explanation": "..."}`
}

/**
 * Parse + verify a judge response. Returns null (no action) rather than
 * throwing on malformed output or an out-of-range index — a matcher that
 * fails open into a status write would defeat its own conservatism.
 */
export function parseGithubTaskMatch(
  rawText: string,
  candidateCount: number,
): GithubTaskMatchResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return null
  }
  const result = matchResponseSchema.safeParse(parsed)
  if (!result.success) return null
  const { match_index, confidence, explanation } = result.data
  if (match_index !== null && (match_index < 0 || match_index >= candidateCount)) return null
  return { matchIndex: match_index, confidence, explanation }
}
