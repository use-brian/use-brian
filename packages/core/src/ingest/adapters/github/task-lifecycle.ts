/**
 * [COMP:brain/github-task-lifecycle]
 *
 * Deterministic GitHub → task lifecycle. GitHub is structured data, so tasks
 * from it are derived by rule, NOT by the LLM extractor (which, run over
 * retrospective push history, produced the 314-todo slop — see
 * `pipeline-b.ts` `RETROSPECTIVE_SOURCE_KINDS` and the plan
 * docs/plans/github-task-extraction-fix.md).
 *
 * TWO SIGNAL TIERS (docs/plans/tasks-suggestion-first.md §1-D4). The original
 * lifecycle only reacted to closing keywords in a PR body, which made status
 * reconciliation nearly blind — a PR titled "Fix #12", a branch named
 * `12-fix-login`, or a commit message closing an issue never moved anything.
 *
 *   STRONG — an explicit closing keyword (`closes/fixes/resolves #N`) in the
 *   PR title or body, a commit message on the default branch, or a structured
 *   issue event. Full lifecycle:
 *     - `issue.opened`        → CREATE one task, backlinked via `external_ref`.
 *     - PR opened             → `in_review`.
 *     - PR merged             → `done`.
 *     - PR closed (unmerged)  → reopen to `todo` (never yanks a `done` task).
 *     - `issue.closed`        → `done`.
 *     - default-branch push whose commit message closes #N → `done`.
 *
 *   WEAK — a plain `#N` reference anywhere in the PR title/body, an issue
 *   number encoded in the head branch name (`12-fix`, `feat/12-…`, `fix/#12`,
 *   `issue-12`), or a non-default-branch push. Weak signals are hints, not
 *   claims, so the executor applies them FORWARD-ONLY (todo < in_progress <
 *   in_review < done) and they can never set `done`:
 *     - PR opened / numbered-branch push → `in_progress`.
 *     - PR merged / non-default-branch closing commit → `in_review`.
 *
 * A PR that references no issue at all is not handled here — the LLM matcher
 * (`task-match.ts`) covers content-level matching against open tasks.
 *
 * This module is PURE: it maps an event to intents. The executor (in the
 * ingest processor) resolves them against `TaskStore`
 * (`findByExternalRefSystem` + `create`/`update`) and enforces the
 * forward-only guard, because only it can see the task's current status.
 */

import type { GithubNormalizedEvent } from './types.js'

/** Stable backlink stamped on a task's `external_ref`. `@>`-matchable. */
export type GithubTaskRef = {
  provider: 'github'
  repo: string
  kind: 'issue'
  number: number
}

export type GithubTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

export type GithubTaskIntent =
  | { action: 'create'; ref: GithubTaskRef; title: string }
  | {
      action: 'transition'
      targets: GithubTaskRef[]
      status: GithubTaskStatus
      /** Weak transitions apply forward-only and never set `done`. */
      strength: 'strong' | 'weak'
    }

/**
 * Rank for the forward-only guard on weak transitions. `todo` is deliberately
 * rank 0: a weak signal can never reopen anything.
 */
export const GITHUB_TASK_STATUS_RANK: Record<GithubTaskStatus, number> = {
  todo: 0,
  in_progress: 1,
  in_review: 2,
  done: 3,
}

// GitHub closing keywords (the set GitHub itself auto-links):
// close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, then `#<n>`.
const CLOSE_REF_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi

/** Any `#N` reference, closing or not. */
const PLAIN_REF_RE = /#(\d+)\b/g

/**
 * Issue number encoded in a branch name. Accepts the shapes people actually
 * use — `12-fix-login`, `feat/12-login`, `fix/#12`, `issue-12`, `gh-12` —
 * while refusing bare digits that are more likely a version (`v2`, `2.0`).
 */
const BRANCH_NUM_RE = /(?:^|\/)(?:(?:issue|gh)-)?#?(\d+)(?:$|[-_])/i

function positiveInt(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Extract the issue numbers a PR text says it closes ("Closes #12", "Fixes #7"). */
export function parseCloseRefs(body: string | null | undefined): number[] {
  if (!body) return []
  const out = new Set<number>()
  for (const m of body.matchAll(CLOSE_REF_RE)) {
    const n = positiveInt(m[1])
    if (n !== null) out.add(n)
  }
  return [...out]
}

/** Every `#N` reference in the text, closing or plain. */
export function parseIssueRefs(text: string | null | undefined): number[] {
  if (!text) return []
  const out = new Set<number>()
  for (const m of text.matchAll(PLAIN_REF_RE)) {
    const n = positiveInt(m[1])
    if (n !== null) out.add(n)
  }
  return [...out]
}

/** The issue number a branch name encodes, or null. */
export function parseBranchIssueNumber(branch: string | null | undefined): number | null {
  if (!branch) return null
  const m = BRANCH_NUM_RE.exec(branch)
  return m ? positiveInt(m[1]) : null
}

function issueRef(repo: string, num: number): GithubTaskRef {
  return { provider: 'github', repo, kind: 'issue', number: num }
}

function refs(repo: string, nums: Iterable<number>): GithubTaskRef[] {
  return [...new Set(nums)].map((n) => issueRef(repo, n))
}

export type GithubTaskIntentOptions = {
  /**
   * The repo's default branch when the caller knows it (webhook context /
   * connector config). Unset, `main`/`master` are treated as default — the
   * poll feed does not carry it and guessing conservatively only affects
   * whether a closing commit lands `done` (strong) or `in_review` (weak).
   */
  defaultBranch?: string | null
}

/**
 * Map a normalized GitHub event to task-lifecycle intents (possibly several:
 * one event can carry strong refs and weak refs with different targets).
 * Empty array when the event neither creates nor reconciles a task.
 * Pure — no IO.
 */
export function githubTaskIntents(
  event: GithubNormalizedEvent,
  options: GithubTaskIntentOptions = {},
): GithubTaskIntent[] {
  const payload = event.payload
  switch (event.event_type) {
    case 'issue.opened': {
      const issue = payload.issue as { number?: number; title?: string } | undefined
      const title = issue?.title?.trim()
      if (!issue?.number || !title) return []
      return [{ action: 'create', ref: issueRef(event.repo, issue.number), title }]
    }
    case 'issue.closed': {
      const issue = payload.issue as { number?: number } | undefined
      if (!issue?.number) return []
      return [
        {
          action: 'transition',
          targets: [issueRef(event.repo, issue.number)],
          status: 'done',
          strength: 'strong',
        },
      ]
    }
    case 'pull_request.opened':
    case 'pull_request.merged':
    case 'pull_request.closed': {
      const pr = payload.pull_request as
        | { title?: string; body?: string; head?: { ref?: string } }
        | undefined
      const text = [pr?.title, pr?.body].filter(Boolean).join('\n')
      const closing = new Set(parseCloseRefs(text))
      const plain = new Set(parseIssueRefs(text))
      for (const n of closing) plain.delete(n)
      const branchNum = parseBranchIssueNumber(pr?.head?.ref)
      if (branchNum !== null && !closing.has(branchNum)) plain.add(branchNum)

      const intents: GithubTaskIntent[] = []
      if (event.event_type === 'pull_request.opened') {
        if (closing.size > 0) {
          intents.push({
            action: 'transition',
            targets: refs(event.repo, closing),
            status: 'in_review',
            strength: 'strong',
          })
        }
        if (plain.size > 0) {
          intents.push({
            action: 'transition',
            targets: refs(event.repo, plain),
            status: 'in_progress',
            strength: 'weak',
          })
        }
      } else if (event.event_type === 'pull_request.merged') {
        if (closing.size > 0) {
          intents.push({
            action: 'transition',
            targets: refs(event.repo, closing),
            status: 'done',
            strength: 'strong',
          })
        }
        if (plain.size > 0) {
          intents.push({
            action: 'transition',
            targets: refs(event.repo, plain),
            status: 'in_review',
            strength: 'weak',
          })
        }
      } else if (closing.size > 0) {
        // Unmerged close: only the explicit closing claim reopens. A plain
        // mention of #N on an abandoned PR says nothing about the task.
        intents.push({
          action: 'transition',
          targets: refs(event.repo, closing),
          status: 'todo',
          strength: 'strong',
        })
      }
      return intents
    }
    case 'push': {
      const isDefault =
        event.push?.default_branch ??
        (options.defaultBranch
          ? event.branch === options.defaultBranch
          : event.branch === 'main' || event.branch === 'master')

      const commits = Array.isArray(payload.commits) ? payload.commits : []
      const closing = new Set<number>()
      for (const commit of commits) {
        const message = (commit as { message?: string } | null)?.message
        for (const n of parseCloseRefs(message)) closing.add(n)
      }

      const intents: GithubTaskIntent[] = []
      if (closing.size > 0) {
        // GitHub itself only auto-closes on the default branch; mirror that.
        intents.push({
          action: 'transition',
          targets: refs(event.repo, closing),
          status: isDefault ? 'done' : 'in_review',
          strength: isDefault ? 'strong' : 'weak',
        })
      }

      // A push to a numbered feature branch is "work started" on that issue.
      const branchNum = parseBranchIssueNumber(event.branch)
      if (!isDefault && branchNum !== null && !closing.has(branchNum)) {
        intents.push({
          action: 'transition',
          targets: [issueRef(event.repo, branchNum)],
          status: 'in_progress',
          strength: 'weak',
        })
      }
      return intents
    }
    default:
      return []
  }
}

/**
 * Back-compat single-intent view of `githubTaskIntents` — the strongest
 * intent, or null. Kept because the original API returned one intent; new
 * callers should iterate `githubTaskIntents`.
 */
export function githubTaskIntent(event: GithubNormalizedEvent): GithubTaskIntent | null {
  const intents = githubTaskIntents(event)
  if (intents.length === 0) return null
  const create = intents.find((i) => i.action === 'create')
  if (create) return create
  const strong = intents.find((i) => i.action === 'transition' && i.strength === 'strong')
  return strong ?? intents[0]
}
