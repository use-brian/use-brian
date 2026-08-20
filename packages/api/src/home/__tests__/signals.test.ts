import { describe, expect, it } from 'vitest'
import { groupPendingApprovalCounts } from '../signals.js'

describe('[COMP:api/home-signals] approval presentation groups', () => {
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
