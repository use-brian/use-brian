import { describe, it, expect } from 'vitest'
import {
  githubTaskIntent,
  githubTaskIntents,
  parseBranchIssueNumber,
  parseCloseRefs,
  parseIssueRefs,
} from '../task-lifecycle.js'
import type { GithubNormalizedEvent } from '../types.js'

function event(overrides: Partial<GithubNormalizedEvent> = {}): GithubNormalizedEvent {
  return {
    event_type: 'issue.opened',
    delivery_id: 'd1',
    occurred_at: new Date('2026-07-23T00:00:00Z'),
    repo: 'acme/widget',
    branch: null,
    actor: { login: 'octocat', is_bot: false },
    payload: {},
    ...overrides,
  }
}

const issueRef = (number: number) => ({ provider: 'github', repo: 'acme/widget', kind: 'issue', number })

describe('[COMP:brain/github-task-lifecycle] githubTaskIntents', () => {
  describe('parseCloseRefs', () => {
    it('extracts Closes / Fixes / Resolves refs', () => {
      expect(parseCloseRefs('Closes #12')).toEqual([12])
      expect(parseCloseRefs('fixes #7 and resolves #8')).toEqual([7, 8])
      expect(parseCloseRefs('Fixed #3.')).toEqual([3])
    })
    it('ignores plain mentions and keyword-less hashes', () => {
      expect(parseCloseRefs('see #99 for context')).toEqual([])
      expect(parseCloseRefs('refactor the #thing')).toEqual([])
      expect(parseCloseRefs(null)).toEqual([])
      expect(parseCloseRefs('')).toEqual([])
    })
    it('dedupes repeated refs', () => {
      expect(parseCloseRefs('closes #5, closes #5')).toEqual([5])
    })
  })

  describe('parseIssueRefs', () => {
    it('extracts every #N mention, closing or plain', () => {
      expect(parseIssueRefs('see #99 for context, closes #5')).toEqual([99, 5])
    })
    it('ignores non-numeric hashes', () => {
      expect(parseIssueRefs('refactor the #thing')).toEqual([])
      expect(parseIssueRefs(null)).toEqual([])
    })
  })

  describe('parseBranchIssueNumber', () => {
    it('accepts the branch shapes people actually use', () => {
      expect(parseBranchIssueNumber('12-fix-login')).toBe(12)
      expect(parseBranchIssueNumber('feat/12-login')).toBe(12)
      expect(parseBranchIssueNumber('fix/#12')).toBe(12)
      expect(parseBranchIssueNumber('issue-12')).toBe(12)
      expect(parseBranchIssueNumber('gh-12')).toBe(12)
    })
    it('refuses branches with no leading number segment', () => {
      expect(parseBranchIssueNumber('main')).toBeNull()
      expect(parseBranchIssueNumber('feat/login-v2')).toBeNull()
      expect(parseBranchIssueNumber(null)).toBeNull()
    })
  })

  it('issue.opened → create a backlinked task', () => {
    expect(
      githubTaskIntents(event({ event_type: 'issue.opened', payload: { issue: { number: 12, title: 'Add dark mode' } } })),
    ).toEqual([{ action: 'create', ref: issueRef(12), title: 'Add dark mode' }])
  })

  it('issue.opened with no title → no intents (nothing to name)', () => {
    expect(
      githubTaskIntents(event({ event_type: 'issue.opened', payload: { issue: { number: 12 } } })),
    ).toEqual([])
  })

  it('pull_request.opened (Closes #12) → strong in_review transition', () => {
    expect(
      githubTaskIntents(event({ event_type: 'pull_request.opened', payload: { pull_request: { body: 'Closes #12' } } })),
    ).toEqual([{ action: 'transition', targets: [issueRef(12)], status: 'in_review', strength: 'strong' }])
  })

  it('pull_request.merged (Fixes #7) → strong done', () => {
    expect(
      githubTaskIntents(event({ event_type: 'pull_request.merged', payload: { pull_request: { body: 'Fixes #7' } } })),
    ).toEqual([{ action: 'transition', targets: [issueRef(7)], status: 'done', strength: 'strong' }])
  })

  it('pull_request.closed (unmerged) → strong reopen to todo, plain refs ignored', () => {
    expect(
      githubTaskIntents(
        event({
          event_type: 'pull_request.closed',
          payload: { pull_request: { body: 'Closes #4, see also #9' } },
        }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(4)], status: 'todo', strength: 'strong' }])
  })

  it('issue.closed → strong done', () => {
    expect(
      githubTaskIntents(event({ event_type: 'issue.closed', payload: { issue: { number: 9 } } })),
    ).toEqual([{ action: 'transition', targets: [issueRef(9)], status: 'done', strength: 'strong' }])
  })

  // ── Weak signals (suggestion-first plan §1-D4) ────────────────────────────

  it('pull_request.opened with a plain #N mention in the TITLE → weak in_progress', () => {
    expect(
      githubTaskIntents(
        event({ event_type: 'pull_request.opened', payload: { pull_request: { title: 'Fix login flow (#31)' } } }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(31)], status: 'in_progress', strength: 'weak' }])
  })

  it('pull_request.opened with closing keyword in the TITLE → strong (titles count)', () => {
    expect(
      githubTaskIntents(
        event({ event_type: 'pull_request.opened', payload: { pull_request: { title: 'Fixes #31 login flow' } } }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(31)], status: 'in_review', strength: 'strong' }])
  })

  it('pull_request.opened on a numbered branch → weak in_progress', () => {
    expect(
      githubTaskIntents(
        event({
          event_type: 'pull_request.opened',
          payload: { pull_request: { title: 'Login flow', head: { ref: 'feat/31-login' } } },
        }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(31)], status: 'in_progress', strength: 'weak' }])
  })

  it('pull_request.merged with only a plain ref → weak in_review, never done', () => {
    expect(
      githubTaskIntents(
        event({ event_type: 'pull_request.merged', payload: { pull_request: { body: 'related to #8' } } }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(8)], status: 'in_review', strength: 'weak' }])
  })

  it('one PR can carry a strong set and a weak set with distinct targets', () => {
    expect(
      githubTaskIntents(
        event({
          event_type: 'pull_request.opened',
          payload: { pull_request: { body: 'Closes #4. See also #9.' } },
        }),
      ),
    ).toEqual([
      { action: 'transition', targets: [issueRef(4)], status: 'in_review', strength: 'strong' },
      { action: 'transition', targets: [issueRef(9)], status: 'in_progress', strength: 'weak' },
    ])
  })

  it('PR referencing no issue → no intents (the LLM matcher owns it)', () => {
    expect(
      githubTaskIntents(event({ event_type: 'pull_request.opened', payload: { pull_request: { body: 'just a refactor' } } })),
    ).toEqual([])
  })

  // ── Pushes ────────────────────────────────────────────────────────────────

  it('default-branch push whose commit closes #N → strong done (mirrors GitHub auto-close)', () => {
    expect(
      githubTaskIntents(
        event({
          event_type: 'push',
          branch: 'main',
          payload: { commits: [{ message: 'fix: closes #12' }] },
        }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(12)], status: 'done', strength: 'strong' }])
  })

  it('feature-branch push with a closing commit → weak in_review (GitHub would not auto-close)', () => {
    expect(
      githubTaskIntents(
        event({
          event_type: 'push',
          branch: 'feat/other',
          payload: { commits: [{ message: 'fixes #12' }] },
        }),
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(12)], status: 'in_review', strength: 'weak' }])
  })

  it('push to a numbered feature branch → weak in_progress (work started)', () => {
    expect(
      githubTaskIntents(event({ event_type: 'push', branch: '12-fix-login', payload: { commits: [] } })),
    ).toEqual([{ action: 'transition', targets: [issueRef(12)], status: 'in_progress', strength: 'weak' }])
  })

  it('honors an explicit defaultBranch option over the main/master heuristic', () => {
    expect(
      githubTaskIntents(
        event({
          event_type: 'push',
          branch: 'trunk',
          payload: { commits: [{ message: 'closes #3' }] },
        }),
        { defaultBranch: 'trunk' },
      ),
    ).toEqual([{ action: 'transition', targets: [issueRef(3)], status: 'done', strength: 'strong' }])
  })

  it('plain push with no refs → no intents (retrospective, never a task)', () => {
    expect(githubTaskIntents(event({ event_type: 'push', branch: 'main', payload: { commits: [] } }))).toEqual([])
  })

  // ── Back-compat single-intent view ────────────────────────────────────────

  it('githubTaskIntent returns the strongest intent for mixed events', () => {
    expect(
      githubTaskIntent(
        event({
          event_type: 'pull_request.opened',
          payload: { pull_request: { body: 'Closes #4. See also #9.' } },
        }),
      ),
    ).toEqual({ action: 'transition', targets: [issueRef(4)], status: 'in_review', strength: 'strong' })
  })

  it('githubTaskIntent returns null when there is nothing to do', () => {
    expect(githubTaskIntent(event({ event_type: 'push', branch: 'main', payload: {} }))).toBeNull()
  })
})
