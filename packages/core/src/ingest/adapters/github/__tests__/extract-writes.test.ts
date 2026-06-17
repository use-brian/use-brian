import { describe, expect, it } from 'vitest'

import { extractWritesFromGithubEvent } from '../extract-writes.js'
import type { GithubNormalizedEvent } from '../types.js'

function event(overrides: Partial<GithubNormalizedEvent> = {}): GithubNormalizedEvent {
  return {
    event_type: 'pull_request.opened',
    delivery_id: 'd-1',
    occurred_at: new Date('2026-05-28T10:00:00Z'),
    repo: 'whatever/belvedere',
    branch: 'feature/x',
    actor: { login: 'alice', is_bot: false },
    payload: {},
    ...overrides,
  }
}

describe('[COMP:brain/source-adapters/github/extract-writes] extractWritesFromGithubEvent', () => {
  it('produces a primary repository entity with canonical github URL', () => {
    const writes = extractWritesFromGithubEvent(event())
    expect(writes).not.toBeNull()
    expect(writes!.primary?.kind).toBe('repository')
    expect(writes!.primary?.canonical_id).toBe('https://github.com/whatever/belvedere')
    expect(writes!.primary?.attributes?.provider).toBe('github')
    expect(writes!.primary?.attributes?.owner).toBe('whatever')
    expect(writes!.primary?.attributes?.repo_name).toBe('belvedere')
    expect(writes!.primary?.display_name).toBe('belvedere')
  })

  it('produces a derived person entity for the actor', () => {
    const writes = extractWritesFromGithubEvent(event({ actor: { login: 'alice', is_bot: false } }))
    expect(writes!.entities).toHaveLength(1)
    const actor = writes!.entities![0]
    expect(actor?.kind).toBe('person')
    expect(actor?.display_name).toBe('alice')
    expect(actor?.canonical_id).toBe('https://github.com/alice')
    expect(actor?.attributes?.github_login).toBe('alice')
  })

  it('produces a documented_by edge from repo → actor', () => {
    const writes = extractWritesFromGithubEvent(event())
    expect(writes!.edges).toHaveLength(1)
    const edge = writes!.edges![0]
    expect(edge?.edge_type).toBe('documented_by')
    expect(edge?.source_ref).toBe('primary')  // repo is the composition primary ref
    expect(edge?.target_ref).toBe('actor')
    expect(edge?.attributes?.github_event).toBe('pull_request.opened')
    expect(edge?.attributes?.delivery_id).toBe('d-1')
  })

  it('skips actor entity + edge when actor is a bot', () => {
    const writes = extractWritesFromGithubEvent(
      event({ actor: { login: 'dependabot[bot]', is_bot: true } }),
    )
    expect(writes!.primary?.kind).toBe('repository')
    expect(writes!.entities).toHaveLength(0)
    expect(writes!.edges).toHaveLength(0)
  })

  it('handles push events the same way', () => {
    const writes = extractWritesFromGithubEvent(event({ event_type: 'push' }))
    expect(writes!.primary?.kind).toBe('repository')
    expect(writes!.edges![0]?.attributes?.github_event).toBe('push')
  })

  it('handles issue events', () => {
    const writes = extractWritesFromGithubEvent(event({ event_type: 'issue.opened' }))
    expect(writes!.edges![0]?.attributes?.github_event).toBe('issue.opened')
  })

  it('handles release.published', () => {
    const writes = extractWritesFromGithubEvent(event({ event_type: 'release.published' }))
    expect(writes!.primary?.kind).toBe('repository')
  })

  it('different repos produce different canonical_ids (dedup boundary)', () => {
    const w1 = extractWritesFromGithubEvent(event({ repo: 'a/x' }))
    const w2 = extractWritesFromGithubEvent(event({ repo: 'b/x' }))
    expect(w1!.primary?.canonical_id).toBe('https://github.com/a/x')
    expect(w2!.primary?.canonical_id).toBe('https://github.com/b/x')
  })
})
