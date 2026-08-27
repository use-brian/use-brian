import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  listActivePlaybookRulesForActor: vi.fn(),
  appendDecisionApplication: vi.fn(),
}))

vi.mock('../../db/playbook-store.js', () => ({
  listActivePlaybookRulesForActor: store.listActivePlaybookRulesForActor,
}))
vi.mock('../../db/decision-provenance-store.js', () => ({
  appendDecisionApplication: store.appendDecisionApplication,
}))

import { loadDecisionPlaybookContext } from '../playbook-context.js'

const ASSISTANT = '00000000-0000-4000-8000-000000000001'
const ACTOR = '00000000-0000-4000-8000-000000000002'
const WORKSPACE = '00000000-0000-4000-8000-000000000003'

function rule(input: Partial<{
  id: string
  rule: string
  createdBy: 'reflection' | 'owner' | 'decision_reflection'
  appliesToUserId: string | null
  applicabilityKind: 'general' | 'email' | 'tool'
  applicabilityKey: string | null
  decisionSensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
}> = {}) {
  return {
    id: input.id ?? 'rule-1',
    rule: input.rule ?? 'Confirm the final draft before sending.',
    createdBy: input.createdBy ?? 'decision_reflection',
    appliesToUserId: input.appliesToUserId === undefined ? ACTOR : input.appliesToUserId,
    applicabilityKind: input.applicabilityKind ?? 'general',
    applicabilityKey: input.applicabilityKey ?? null,
    decisionSensitivity: input.decisionSensitivity ?? 'internal',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.appendDecisionApplication.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000090',
  })
})

describe('[COMP:api/decision-playbook-context] scoped prompt loader', () => {
  it('orders matching operation rules, general user rules, then assistant-wide rules', async () => {
    store.listActivePlaybookRulesForActor.mockResolvedValue([
      rule({ id: 'assistant', rule: 'Assistant-wide', createdBy: 'owner', appliesToUserId: null }),
      rule({ id: 'general', rule: 'General user rule' }),
      rule({ id: 'email', rule: 'Mailbox rule', applicabilityKind: 'email', applicabilityKey: 'primary' }),
      rule({ id: 'other', rule: 'Other tool rule', applicabilityKind: 'tool', applicabilityKey: 'sendMessage' }),
    ])

    const result = await loadDecisionPlaybookContext({
      workspaceId: WORKSPACE,
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: false,
      operationKind: 'workflow_assistant_call',
      operationId: 'run-1:draft',
      applicability: { kind: 'email', key: 'primary' },
      logLabel: 'test',
    })

    expect(result.playbookRules).toEqual(['Mailbox rule', 'General user rule', 'Assistant-wide'])
    expect(result.appliedRuleIds).toEqual(['email', 'general'])
    expect(store.appendDecisionApplication).toHaveBeenCalledWith(expect.objectContaining({
      artifactRefs: [
        { kind: 'assistant_playbook_rule', id: 'email' },
        { kind: 'assistant_playbook_rule', id: 'general' },
      ],
      sensitivity: 'internal',
    }))
  })

  it('asks the store to exclude scoped rows for an external principal', async () => {
    store.listActivePlaybookRulesForActor.mockResolvedValue([
      rule({ id: 'assistant', createdBy: 'owner', appliesToUserId: null }),
      rule({ id: 'scoped-leak' }),
    ])
    const result = await loadDecisionPlaybookContext({
      workspaceId: WORKSPACE,
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: true,
      operationKind: 'public_turn',
      operationId: 'turn-1',
      logLabel: 'test',
    })
    expect(store.listActivePlaybookRulesForActor).toHaveBeenCalledWith({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: true,
    })
    expect(result.playbookRules).toEqual(['Confirm the final draft before sending.'])
    expect(result.appliedRuleIds).toEqual([])
    expect(store.appendDecisionApplication).not.toHaveBeenCalled()
  })

  it('does not widen a keyed operation rule when the frozen key is absent', async () => {
    store.listActivePlaybookRulesForActor.mockResolvedValue([
      rule({ id: 'mailbox', rule: 'Mailbox-specific', applicabilityKind: 'email', applicabilityKey: 'primary' }),
      rule({ id: 'email-general', rule: 'Any reviewed email', applicabilityKind: 'email' }),
      rule({ id: 'general', rule: 'General user rule' }),
    ])
    const result = await loadDecisionPlaybookContext({
      workspaceId: WORKSPACE,
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: false,
      operationKind: 'workflow_assistant_call',
      operationId: 'run-1:draft',
      applicability: { kind: 'email' },
      logLabel: 'test',
    })
    expect(result.playbookRules).toEqual(['Any reviewed email', 'General user rule'])
  })

  it('renders only whole rules under the existing combined cap', async () => {
    store.listActivePlaybookRulesForActor.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => rule({
        id: `rule-${index}`,
        rule: `${index}:${'x'.repeat(275)}`,
      })),
    )
    const result = await loadDecisionPlaybookContext({
      workspaceId: WORKSPACE,
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: false,
      operationKind: 'chat_turn',
      operationId: 'turn-1',
      logLabel: 'test',
    })
    expect(result.playbookRules).toHaveLength(7)
    expect(result.playbookRules.every((value) => value.length === 277)).toBe(true)
  })

  it('omits the whole learned block on a scoped read failure', async () => {
    store.listActivePlaybookRulesForActor.mockRejectedValue(new Error('db unavailable'))
    const result = await loadDecisionPlaybookContext({
      workspaceId: WORKSPACE,
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: false,
      operationKind: 'chat_turn',
      operationId: 'turn-1',
      logLabel: 'test',
    })
    expect(result).toEqual({
      playbookRules: [],
      appliedRuleIds: [],
      decisionApplicationId: null,
      readFailed: true,
    })
  })

  it('continues with rules but returns no fabricated id when application capture fails', async () => {
    store.listActivePlaybookRulesForActor.mockResolvedValue([rule()])
    store.appendDecisionApplication.mockRejectedValue(new Error('write unavailable'))
    const result = await loadDecisionPlaybookContext({
      workspaceId: WORKSPACE,
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: false,
      operationKind: 'chat_turn',
      operationId: 'turn-1',
      logLabel: 'test',
    })
    expect(result.playbookRules).toHaveLength(1)
    expect(result.decisionApplicationId).toBeNull()
  })
})
