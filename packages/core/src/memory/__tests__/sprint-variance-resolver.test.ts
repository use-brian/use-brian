import { describe, expect, it } from 'vitest'
import {
  TASK_TAG_PREFIX,
  createSprintVarianceResolver,
  taskIdFromCommitment,
  type SprintTaskLookup,
  type SprintTaskSnapshot,
} from '../sprint-variance-resolver.js'
import type { MemoryRecord } from '../types.js'

const TASK_ID = '11111111-1111-1111-1111-111111111111'
const NOW = new Date('2026-05-20T12:00:00Z')
const fixedNow = () => NOW

function fakeCommitment(tags: string[]): MemoryRecord {
  return {
    id: 'mem-1',
    type: 'commitment',
    scope: 'workspace',
    summary: 'task slipped',
    detail: null,
    tags,
    confidence: 0.9,
    sensitivity: 'internal',
    workspaceId: 'ws-1',
  } as unknown as MemoryRecord
}

function lookupReturning(snapshot: SprintTaskSnapshot | null): SprintTaskLookup {
  return async () => snapshot
}

describe('[COMP:brain/sprint-variance-resolver] taskIdFromCommitment', () => {
  it('parses the `task:<uuid>` tag', () => {
    const mem = fakeCommitment(['commitment:open', `${TASK_TAG_PREFIX}${TASK_ID}`])
    expect(taskIdFromCommitment(mem)).toBe(TASK_ID)
  })

  it('returns null when no task tag is present', () => {
    const mem = fakeCommitment(['commitment:open', 'commitment:sprint_variance'])
    expect(taskIdFromCommitment(mem)).toBeNull()
  })

  it('returns null when the task tag has an empty suffix', () => {
    const mem = fakeCommitment(['commitment:open', TASK_TAG_PREFIX])
    expect(taskIdFromCommitment(mem)).toBeNull()
  })
})

describe('[COMP:brain/sprint-variance-resolver] createSprintVarianceResolver', () => {
  const openCommitment = fakeCommitment([
    'commitment:open',
    'commitment:sprint_variance',
    `${TASK_TAG_PREFIX}${TASK_ID}`,
  ])

  it('resolves when the task is `done`', async () => {
    const resolver = createSprintVarianceResolver({
      lookup: lookupReturning({ status: 'done', due: new Date('2026-05-15T00:00:00Z') }),
      now: fixedNow,
    })
    const outcome = await resolver(openCommitment)
    expect(outcome.resolved).toBe(true)
  })

  it('resolves when the task is `archived`', async () => {
    const resolver = createSprintVarianceResolver({
      lookup: lookupReturning({ status: 'archived', due: new Date('2026-05-15T00:00:00Z') }),
      now: fixedNow,
    })
    const outcome = await resolver(openCommitment)
    expect(outcome.resolved).toBe(true)
  })

  it('resolves when the task has been replanned into the future', async () => {
    const resolver = createSprintVarianceResolver({
      lookup: lookupReturning({ status: 'in_progress', due: new Date('2026-06-01T00:00:00Z') }),
      now: fixedNow,
    })
    const outcome = await resolver(openCommitment)
    expect(outcome.resolved).toBe(true)
  })

  it('resolves when the task no longer has a `due` date', async () => {
    const resolver = createSprintVarianceResolver({
      lookup: lookupReturning({ status: 'in_progress', due: null }),
      now: fixedNow,
    })
    const outcome = await resolver(openCommitment)
    expect(outcome.resolved).toBe(true)
  })

  it('resolves when the task lookup returns null (deleted / retracted)', async () => {
    const resolver = createSprintVarianceResolver({
      lookup: lookupReturning(null),
      now: fixedNow,
    })
    const outcome = await resolver(openCommitment)
    expect(outcome.resolved).toBe(true)
  })

  it('stays open when the task is still slipping (past `due`, not done)', async () => {
    const resolver = createSprintVarianceResolver({
      lookup: lookupReturning({ status: 'in_progress', due: new Date('2026-05-15T00:00:00Z') }),
      now: fixedNow,
    })
    const outcome = await resolver(openCommitment)
    expect(outcome.resolved).toBe(false)
  })

  it('stays open when the commitment has no `task:<uuid>` tag', async () => {
    const resolver = createSprintVarianceResolver({
      // Lookup that would resolve if called — but it never gets called.
      lookup: lookupReturning({ status: 'done', due: null }),
      now: fixedNow,
    })
    const outcome = await resolver(
      fakeCommitment(['commitment:open', 'commitment:sprint_variance']),
    )
    expect(outcome.resolved).toBe(false)
  })
})
