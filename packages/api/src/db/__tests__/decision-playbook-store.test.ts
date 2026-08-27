/** Store-side threshold and projector validation for decision rules. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  eventRows: [] as Record<string, unknown>[],
  insertRule: true,
  activeCount: 0,
  client: null as null | { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> },
}))
const provenance = vi.hoisted(() => ({ appendDecisionDerivation: vi.fn() }))

vi.mock('../client.js', () => ({
  query: vi.fn(),
  getPool: () => ({ connect: vi.fn(async () => state.client) }),
}))
vi.mock('../decision-provenance-store.js', () => ({
  appendDecisionDerivation: provenance.appendDecisionDerivation,
}))

import {
  type DecisionRuleProposal,
  insertDecisionReflectedRules,
  isProhibitedDecisionRule,
  semanticKeyForDecisionRule,
} from '../playbook-store.js'

const ASSISTANT = '00000000-0000-4000-8000-000000000001'
const ACTOR = '00000000-0000-4000-8000-000000000002'
const WORKSPACE = '00000000-0000-4000-8000-000000000003'

function toolEvent(index: number, source = `approval-${index}`) {
  return {
    id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
    eventKind: 'approval.decided',
    sourceKind: 'pending_approval',
    sourceId: source,
    payload: {
      approvalId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
      resolution: 'deny',
      toolName: 'sendMessage',
    },
    reason: 'Show a draft first',
    sensitivity: index === 3 ? 'confidential' : 'internal',
    createdAt: new Date(`2026-08-${20 + index}T00:00:00Z`),
  }
}

function proposal(ids: string[], rule = 'Show me a draft before sending messages.'): DecisionRuleProposal {
  return {
    rule,
    applicabilityKind: 'tool',
    applicabilityKey: 'sendMessage',
    sourceEventIds: ids,
    eligibility: 'activation',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.eventRows = []
  state.insertRule = true
  state.activeCount = 0
  const query = vi.fn(async (text: string) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('COUNT(*)::text')) return { rows: [{ count: String(state.activeCount) }] }
    if (text.includes('FROM decision_events de')) return { rows: state.eventRows }
    if (text.includes('INSERT INTO assistant_playbook_rules')) {
      return { rows: state.insertRule ? [{ id: '00000000-0000-4000-8000-000000000900' }] : [] }
    }
    throw new Error(`Unexpected SQL: ${text}`)
  })
  state.client = { query, release: vi.fn() }
  provenance.appendDecisionDerivation.mockResolvedValue({ inserted: true })
})

describe('[COMP:workers/decision-reflection] decision playbook admission', () => {
  it('keeps one eligible event suggested even when the model claims activation', async () => {
    state.eventRows = [toolEvent(1)]
    const result = await insertDecisionReflectedRules({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
      proposals: [proposal(state.eventRows.map((row) => row.id as string))],
    })
    expect(result).toEqual({ activated: 0, suggested: 1, deduped: 0, rejected: 0 })
    const insert = state.client!.query.mock.calls.find(([text]) =>
      String(text).includes('INSERT INTO assistant_playbook_rules'))!
    expect(insert[1][3]).toBe('suggested')
  })

  it('activates three consistent events from distinct source objects and keeps max sensitivity', async () => {
    const first = toolEvent(1)
    const second = toolEvent(2)
    const previousApprovalId = '00000000-0000-4000-8000-000000000301'
    const replacementApprovalId = '00000000-0000-4000-8000-000000000302'
    state.eventRows = [
      {
        ...first,
        eventKind: 'email.draft_revised',
        payload: { previousApprovalId, replacementApprovalId, accountKey: 'primary' },
      },
      {
        ...second,
        payload: {
          ...second.payload,
          approvalId: replacementApprovalId,
          approvalKind: 'workflow_step',
          toolName: 'imapSendMessage',
          accountKey: 'primary',
        },
      },
      toolEvent(3),
    ]
    const activationProposal = {
      ...proposal(state.eventRows.map((row) => row.id as string)),
      applicabilityKind: 'general' as const,
      applicabilityKey: null,
    }
    const result = await insertDecisionReflectedRules({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
      proposals: [activationProposal],
    })
    expect(result.activated).toBe(1)
    const insert = state.client!.query.mock.calls.find(([text]) =>
      String(text).includes('INSERT INTO assistant_playbook_rules'))!
    expect(insert[1][3]).toBe('active')
    expect(insert[1][7]).toBe(3)
    expect(insert[1][9]).toBe('confidential')
    expect(provenance.appendDecisionDerivation).toHaveBeenCalledTimes(3)
  })

  it('collapses repeated revisions in one approval chain before thresholding', async () => {
    const first = toolEvent(1)
    const second = toolEvent(2)
    state.eventRows = [
      {
        ...first,
        eventKind: 'email.draft_revised',
        payload: {
          previousApprovalId: '00000000-0000-4000-8000-000000000301',
          replacementApprovalId: '00000000-0000-4000-8000-000000000302',
          accountKey: 'primary',
        },
      },
      {
        ...second,
        eventKind: 'email.draft_revised',
        payload: {
          previousApprovalId: '00000000-0000-4000-8000-000000000302',
          replacementApprovalId: '00000000-0000-4000-8000-000000000303',
          accountKey: 'primary',
        },
      },
      toolEvent(3),
    ]
    const general = {
      ...proposal(state.eventRows.map((row) => row.id as string)),
      applicabilityKind: 'general',
      applicabilityKey: null,
    }
    const result = await insertDecisionReflectedRules({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
      proposals: [general],
    })
    expect(result.suggested).toBe(1)
    const insert = state.client!.query.mock.calls.find(([text]) =>
      String(text).includes('INSERT INTO assistant_playbook_rules'))!
    expect(insert[1][7]).toBe(2)
  })

  it('keeps threshold-qualified overflow suggested at the six-rule user cap', async () => {
    state.activeCount = 6
    state.eventRows = [toolEvent(1), toolEvent(2), toolEvent(3)]
    const result = await insertDecisionReflectedRules({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
      proposals: [proposal(state.eventRows.map((row) => row.id as string))],
    })
    expect(result).toEqual({ activated: 0, suggested: 1, deduped: 0, rejected: 0 })
  })

  it('rejects identity, permission, workspace-policy, skill, and workflow mutations before SQL', async () => {
    const rules = [
      'Merge contacts when their names look similar.',
      'Grant the member admin permission.',
      'Update the workspace policy automatically.',
      'Create a skill for this action.',
      'Modify the workflow after every denial.',
    ]
    expect(rules.every(isProhibitedDecisionRule)).toBe(true)
    const result = await insertDecisionReflectedRules({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
      proposals: rules.map((rule) => proposal([toolEvent(1).id], rule)),
    })
    // The input is bounded to two proposals per call; both are rejected.
    expect(result.rejected).toBe(2)
    expect(state.client).not.toBeNull()
    expect(state.client!.query).not.toHaveBeenCalled()
  })

  it('suppresses semantic-key duplicates across every prior status', async () => {
    state.eventRows = [toolEvent(1)]
    state.insertRule = false
    const input = proposal([toolEvent(1).id])
    const result = await insertDecisionReflectedRules({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
      proposals: [input],
    })
    expect(result.deduped).toBe(1)
    expect(provenance.appendDecisionDerivation).not.toHaveBeenCalled()
    expect(semanticKeyForDecisionRule(input)).toHaveLength(64)
    const evidenceQuery = state.client!.query.mock.calls.find(([text]) =>
      String(text).includes('FROM decision_events de'))!
    expect(evidenceQuery[0]).toContain("ep_u.auth_provider_id LIKE 'chatlink:%'")
  })
})
