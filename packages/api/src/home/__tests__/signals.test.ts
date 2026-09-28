import { describe, expect, it, vi } from 'vitest'

import { countBrainInbox } from '../../db/brain-inbox-store.js'
import { assembleHomeSignals, groupPendingApprovalCounts } from '../signals.js'

vi.mock('../../db/brain-inbox-store.js', () => ({
  countBrainInbox: vi.fn(async () => ({ total: 3, byPrimitive: {} })),
}))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
}))
vi.mock('../../routes/local-session.js', () => ({
  isOssEdition: vi.fn(() => false),
}))

describe('[COMP:api/home-signals] approval presentation groups', () => {
  it('binds the Brain Review count to the authenticated viewer', async () => {
    const workflowStore = { list: vi.fn(async () => []) }
    const savedViewStore = { list: vi.fn(async () => []) }

    const result = await assembleHomeSignals(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      { workflowStore, savedViewStore } as never,
    )

    expect(countBrainInbox).toHaveBeenCalledWith({
      workspaceId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
    })
    expect(result.brainReviewCount).toBe(3)
  })

  it('folds all ten canonical approval kinds into four user-facing groups', () => {
    const summary = groupPendingApprovalCounts([
      { kind: 'workflow_step', count: '1' },
      { kind: 'tool_invocation', count: '2' },
      { kind: 'staged_write', count: '3' },
      { kind: 'browser_skill_send', count: '4' },
      { kind: 'distribution_draft', count: '5' },
      { kind: 'staged_skill_creation', count: '6' },
      { kind: 'staged_skill_update', count: '7' },
      { kind: 'workflow_refinement', count: '8' },
      { kind: 'question', count: '9' },
      { kind: 'email_sender', count: '10' },
    ])

    expect(summary).toEqual({
      total: 55,
      groups: {
        externalActions: 10,
        contentReview: 5,
        systemImprovements: 21,
        questionsAndAccess: 19,
      },
    })
  })

  it('keeps an unknown additive DB kind visible in the broad actions group', () => {
    expect(groupPendingApprovalCounts([{ kind: 'future_kind', count: '2' }])).toEqual({
      total: 2,
      groups: {
        externalActions: 2,
        contentReview: 0,
        systemImprovements: 0,
        questionsAndAccess: 0,
      },
    })
  })
})
