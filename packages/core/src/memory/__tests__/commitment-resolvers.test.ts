/**
 * Unit tests for the commitment-memory resolvers.
 * Component tag: [COMP:brain/commitment-resolvers].
 *
 * Verifies the `due:` tag parsing, the kind-agnostic deadline resolver, and
 * the composite resolver's dispatch order: goal_* skip → per-kind domain
 * resolver → deadline backstop → fail-closed still-open.
 */

import { describe, it, expect } from 'vitest'
import {
  commitmentKind,
  commitmentDeadline,
  createDeadlineCommitmentResolver,
  createCompositeCommitmentResolver,
} from '../commitment-resolvers.js'
import type { CommitmentResolver } from '../commitment-lifecycle-worker.js'
import type { MemoryRecord } from '../types.js'

function memory(over: Partial<MemoryRecord> & { id: string; tags: string[] }): MemoryRecord {
  return {
    scope: 'shared',
    summary: 'placeholder',
    detail: null,
    confidence: 0.8,
    sensitivity: 'internal',
    ...over,
  }
}

const NOW = () => new Date('2026-05-15T12:00:00Z')

describe('[COMP:brain/commitment-resolvers] commitmentKind', () => {
  it('extracts the kind, ignoring the open/resolved lifecycle tags', () => {
    expect(
      commitmentKind(memory({ id: 'm', tags: ['commitment:open', 'commitment:follow_up_due'] })),
    ).toBe('follow_up_due')
  })

  it('returns null when no commitment:<kind> tag is present', () => {
    expect(
      commitmentKind(memory({ id: 'm', tags: ['commitment:open', 'sprint:2026Q3'] })),
    ).toBeNull()
  })
})

describe('[COMP:brain/commitment-resolvers] commitmentDeadline', () => {
  it('parses a due: tag into a Date', () => {
    expect(
      commitmentDeadline(memory({ id: 'm', tags: ['due:2026-05-20'] }))?.toISOString(),
    ).toBe('2026-05-20T00:00:00.000Z')
  })

  it('returns the earliest of several due: tags', () => {
    expect(
      commitmentDeadline(
        memory({ id: 'm', tags: ['due:2026-06-01', 'due:2026-05-20'] }),
      )?.toISOString(),
    ).toBe('2026-05-20T00:00:00.000Z')
  })

  it('returns null when no due: tag is present or it is unparseable', () => {
    expect(commitmentDeadline(memory({ id: 'm', tags: ['commitment:open'] }))).toBeNull()
    expect(commitmentDeadline(memory({ id: 'm', tags: ['due:not-a-date'] }))).toBeNull()
  })
})

describe('[COMP:brain/commitment-resolvers] deadline resolver', () => {
  it('resolves when the due: deadline is in the past', async () => {
    const resolve = createDeadlineCommitmentResolver({ now: NOW })
    const out = await resolve(memory({ id: 'm', tags: ['commitment:open', 'due:2026-05-10'] }))
    expect(out.resolved).toBe(true)
    if (out.resolved) expect(out.reason).toContain('2026-05-10')
  })

  it('stays open when the deadline is in the future', async () => {
    const resolve = createDeadlineCommitmentResolver({ now: NOW })
    const out = await resolve(memory({ id: 'm', tags: ['due:2026-06-01'] }))
    expect(out.resolved).toBe(false)
  })

  it('stays open when the commitment carries no due: tag', async () => {
    const resolve = createDeadlineCommitmentResolver({ now: NOW })
    const out = await resolve(
      memory({ id: 'm', tags: ['commitment:open', 'commitment:follow_up_due'] }),
    )
    expect(out.resolved).toBe(false)
  })
})

describe('[COMP:brain/commitment-resolvers] composite resolver', () => {
  it('never resolves goal_* kinds, even with a past deadline (workflow-owned)', async () => {
    const resolve = createCompositeCommitmentResolver({ now: NOW })
    const out = await resolve(
      memory({ id: 'm', tags: ['commitment:open', 'commitment:goal_research', 'due:2026-05-10'] }),
    )
    expect(out.resolved).toBe(false)
  })

  it('delegates to a registered per-kind domain resolver', async () => {
    const sprint: CommitmentResolver = async () => ({ resolved: true, reason: 'variance cleared' })
    const resolve = createCompositeCommitmentResolver({
      resolvers: { sprint_variance: sprint },
      now: NOW,
    })
    const out = await resolve(
      memory({ id: 'm', tags: ['commitment:open', 'commitment:sprint_variance'] }),
    )
    expect(out.resolved).toBe(true)
    if (out.resolved) expect(out.reason).toBe('variance cleared')
  })

  it('falls through to the deadline backstop when the domain resolver keeps it open', async () => {
    const sprint: CommitmentResolver = async () => ({ resolved: false })
    const resolve = createCompositeCommitmentResolver({
      resolvers: { sprint_variance: sprint },
      now: NOW,
    })
    const out = await resolve(
      memory({
        id: 'm',
        tags: ['commitment:open', 'commitment:sprint_variance', 'due:2026-05-10'],
      }),
    )
    expect(out.resolved).toBe(true)
    if (out.resolved) expect(out.reason).toContain('window closed')
  })

  it('resolves follow_up_due via the deadline backstop with no domain resolver registered', async () => {
    const resolve = createCompositeCommitmentResolver({ now: NOW })
    const out = await resolve(
      memory({
        id: 'm',
        tags: ['commitment:open', 'commitment:follow_up_due', 'due:2026-05-10'],
      }),
    )
    expect(out.resolved).toBe(true)
  })

  it('stays open for an unknown kind with no deadline (fail-closed)', async () => {
    const resolve = createCompositeCommitmentResolver({ now: NOW })
    const out = await resolve(
      memory({ id: 'm', tags: ['commitment:open', 'commitment:incident_summary'] }),
    )
    expect(out.resolved).toBe(false)
  })
})
