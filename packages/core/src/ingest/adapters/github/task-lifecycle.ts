/**
 * [COMP:brain/github-task-lifecycle]
 *
 * Deterministic GitHub → task lifecycle. GitHub is structured data, so tasks
 * from it are derived by rule, NOT by the LLM extractor (which, run over
 * retrospective push history, produced the 314-todo slop — see
 * `pipeline-b.ts` `RETROSPECTIVE_SOURCE_KINDS` and the plan
 * docs/plans/github-task-extraction-fix.md).
 *
 * The lane split:
 *   - `issue.opened`   → CREATE one task, backlinked via `external_ref`.
 *   - `pull_request.opened` → the issue task(s) the PR `Closes #N` → `in_review`.
 *   - `pull_request.merged` → `done`.
 *   - `pull_request.closed` (unmerged) → reopen to `todo`.
 *   - `issue.closed`   → `done`.
 * A PR that references no issue is a no-op (a PR is execution, never new work).
 *
 * This module is PURE: it maps an event to an intent. The executor (in the
 * ingest processor) resolves the intent against `TaskStore`
 * (`findByExternalRefSystem` + `create`/`update`).
 */

import type { GithubNormalizedEvent } from './types.js'

/** Stable backlink stamped on a task's `external_ref`. `@>`-matchable. */
export type GithubTaskRef = {
  provider: 'github'
  repo: string
  kind: 'issue'
  number: number
}

export type GithubTaskIntent =
  | { action: 'create'; ref: GithubTaskRef; title: string }
  | { action: 'transition'; targets: GithubTaskRef[]; status: 'in_review' | 'done' | 'todo' }

// GitHub closing keywords (the set GitHub itself auto-links):
// close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, then `#<n>`.
const CLOSE_REF_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi

/** Extract the issue numbers a PR body says it closes ("Closes #12", "Fixes #7"). */
export function parseCloseRefs(body: string | null | undefined): number[] {
  if (!body) return []
  const out = new Set<number>()
  for (const m of body.matchAll(CLOSE_REF_RE)) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) out.add(n)
  }
  return [...out]
}

function issueRef(repo: string, num: number): GithubTaskRef {
  return { provider: 'github', repo, kind: 'issue', number: num }
}

/**
 * Map a normalized GitHub event to a task-lifecycle intent, or `null` when the
 * event neither creates nor reconciles a task. Pure — no IO.
 */
export function githubTaskIntent(event: GithubNormalizedEvent): GithubTaskIntent | null {
  const payload = event.payload
  switch (event.event_type) {
    case 'issue.opened': {
      const issue = payload.issue as { number?: number; title?: string } | undefined
      const title = issue?.title?.trim()
      if (!issue?.number || !title) return null
      return { action: 'create', ref: issueRef(event.repo, issue.number), title }
    }
    case 'issue.closed': {
      const issue = payload.issue as { number?: number } | undefined
      if (!issue?.number) return null
      return { action: 'transition', targets: [issueRef(event.repo, issue.number)], status: 'done' }
    }
    case 'pull_request.opened':
    case 'pull_request.merged':
    case 'pull_request.closed': {
      const pr = payload.pull_request as { body?: string } | undefined
      const targets = parseCloseRefs(pr?.body).map((n) => issueRef(event.repo, n))
      const status =
        event.event_type === 'pull_request.merged'
          ? ('done' as const)
          : event.event_type === 'pull_request.closed'
            ? ('todo' as const)
            : ('in_review' as const)
      return { action: 'transition', targets, status }
    }
    default:
      return null
  }
}
