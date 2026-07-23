import { describe, it, expect } from 'vitest'
import { githubTaskIntent, parseCloseRefs } from '../task-lifecycle.js'
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

describe('[COMP:brain/github-task-lifecycle] githubTaskIntent', () => {
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

  it('issue.opened → create a backlinked task', () => {
    expect(
      githubTaskIntent(event({ event_type: 'issue.opened', payload: { issue: { number: 12, title: 'Add dark mode' } } })),
    ).toEqual({ action: 'create', ref: issueRef(12), title: 'Add dark mode' })
  })

  it('issue.opened with no title → null (nothing to name)', () => {
    expect(
      githubTaskIntent(event({ event_type: 'issue.opened', payload: { issue: { number: 12 } } })),
    ).toBeNull()
  })

  it('pull_request.opened (Closes #12) → in_review transition', () => {
    expect(
      githubTaskIntent(event({ event_type: 'pull_request.opened', payload: { pull_request: { body: 'Closes #12' } } })),
    ).toEqual({ action: 'transition', targets: [issueRef(12)], status: 'in_review' })
  })

  it('pull_request.merged → done', () => {
    expect(
      githubTaskIntent(event({ event_type: 'pull_request.merged', payload: { pull_request: { body: 'Fixes #7' } } })),
    ).toEqual({ action: 'transition', targets: [issueRef(7)], status: 'done' })
  })

  it('pull_request.closed (unmerged) → reopen to todo', () => {
    expect(
      githubTaskIntent(event({ event_type: 'pull_request.closed', payload: { pull_request: { body: 'Closes #4' } } })),
    ).toEqual({ action: 'transition', targets: [issueRef(4)], status: 'todo' })
  })

  it('issue.closed → done', () => {
    expect(
      githubTaskIntent(event({ event_type: 'issue.closed', payload: { issue: { number: 9 } } })),
    ).toEqual({ action: 'transition', targets: [issueRef(9)], status: 'done' })
  })

  it('PR referencing no issue → empty-target transition (executor no-ops)', () => {
    expect(
      githubTaskIntent(event({ event_type: 'pull_request.opened', payload: { pull_request: { body: 'just a refactor' } } })),
    ).toEqual({ action: 'transition', targets: [], status: 'in_review' })
  })

  it('push → null (retrospective, never a task)', () => {
    expect(githubTaskIntent(event({ event_type: 'push' }))).toBeNull()
  })
})
