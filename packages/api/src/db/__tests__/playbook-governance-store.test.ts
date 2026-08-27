import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  activeCount: 0,
  client: null as null | { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> },
}))
const journal = vi.hoisted(() => ({ appendDecisionEvent: vi.fn() }))
const provenance = vi.hoisted(() => ({ appendDecisionDerivation: vi.fn() }))

vi.mock('../client.js', () => ({
  query: vi.fn(),
  getPool: () => ({ connect: vi.fn(async () => state.client) }),
}))
vi.mock('../decision-event-store.js', () => ({
  appendDecisionEvent: journal.appendDecisionEvent,
}))
vi.mock('../decision-provenance-store.js', () => ({
  appendDecisionDerivation: provenance.appendDecisionDerivation,
}))

import { query as systemQuery } from '../client.js'
import {
  decidePlaybookRule,
  listActivePlaybookRulesForActor,
  listPlaybookRulesForViewer,
} from '../playbook-store.js'

const RULE_ID = '00000000-0000-4000-8000-000000000010'
const ASSISTANT = '00000000-0000-4000-8000-000000000011'
const ACTOR = '00000000-0000-4000-8000-000000000012'
const WORKSPACE = '00000000-0000-4000-8000-000000000013'
const EVENT = '00000000-0000-4000-8000-000000000014'

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    assistantId: ASSISTANT,
    rule: 'Show a draft before sending.',
    rationale: null,
    provenance: { sourceKinds: ['pending_approval'] },
    status: 'active',
    createdBy: 'decision_reflection',
    appliesToUserId: ACTOR,
    applicabilityKind: 'tool',
    applicabilityKey: 'sendMessage',
    evidenceCount: 3,
    semanticKey: 'semantic',
    decisionSensitivity: 'confidential',
    decidedByUserId: null,
    decidedAt: null,
    createdAt: '2026-08-25T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.row = rule()
  state.activeCount = 0
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (sql.includes('FOR UPDATE')) return { rows: state.row ? [state.row] : [] }
    if (sql.includes('COUNT(*)::text')) return { rows: [{ count: String(state.activeCount) }] }
    if (sql.includes('UPDATE assistant_playbook_rules')) {
      return { rows: state.row ? [{ ...state.row, status: params?.[0] }] : [] }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  state.client = { query, release: vi.fn() }
  journal.appendDecisionEvent.mockResolvedValue({
    inserted: true,
    event: { id: EVENT },
  })
  provenance.appendDecisionDerivation.mockResolvedValue({ id: 'd-1', inserted: true })
})

describe('[COMP:api/assistant-playbook] [COMP:api/decision-capture] playbook governance writer', () => {
  it('atomically retires an own scoped rule and invalidates its derivation', async () => {
    const result = await decidePlaybookRule({
      assistantId: ASSISTANT,
      ruleId: RULE_ID,
      decision: 'retire',
      userId: ACTOR,
      workspaceId: WORKSPACE,
      isAssistantOwner: false,
    })
    expect(result).toMatchObject({ status: 'retired' })
    expect(journal.appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: 'playbook.rule_decided',
      declaredScope: 'user',
      visibility: 'owner',
      sensitivity: 'confidential',
      payload: { ruleId: RULE_ID, decision: 'retire' },
    }), state.client)
    expect(provenance.appendDecisionDerivation).toHaveBeenCalledWith({
      decisionEventId: EVENT,
      artifactKind: 'assistant_playbook_rule',
      artifactId: RULE_ID,
      relation: 'invalidates',
    }, state.client)
    expect(state.client!.query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('allows an owner to decide an assistant-wide rule but not another member scoped rule', async () => {
    state.row = rule({
      status: 'suggested',
      createdBy: 'reflection',
      appliesToUserId: null,
    })
    const approved = await decidePlaybookRule({
      assistantId: ASSISTANT,
      ruleId: RULE_ID,
      decision: 'approve',
      userId: ACTOR,
      workspaceId: WORKSPACE,
      isAssistantOwner: true,
    })
    expect(approved).toMatchObject({ status: 'active' })
    expect(provenance.appendDecisionDerivation).not.toHaveBeenCalled()

    state.row = rule({ appliesToUserId: '00000000-0000-4000-8000-000000000099' })
    const forbidden = await decidePlaybookRule({
      assistantId: ASSISTANT,
      ruleId: RULE_ID,
      decision: 'retire',
      userId: ACTOR,
      workspaceId: WORKSPACE,
      isAssistantOwner: true,
    })
    expect(forbidden).toBe('forbidden')
  })

  it('rolls the status change back when journal capture fails', async () => {
    journal.appendDecisionEvent.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(decidePlaybookRule({
      assistantId: ASSISTANT,
      ruleId: RULE_ID,
      decision: 'retire',
      userId: ACTOR,
      workspaceId: WORKSPACE,
      isAssistantOwner: false,
    })).rejects.toThrow('journal unavailable')
    expect(state.client!.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
})

describe('[COMP:api/decision-playbook-context] scoped playbook reads', () => {
  it('binds prompt reads to the exact actor and excludes scoped rows for external principals', async () => {
    vi.mocked(systemQuery).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await listActivePlaybookRulesForActor({
      assistantId: ASSISTANT,
      actorUserId: ACTOR,
      externalPrincipal: true,
    })
    const [sql, params] = vi.mocked(systemQuery).mock.calls.at(-1)!
    expect(sql).toContain('applies_to_user_id = $2')
    expect(sql).toContain('$3::boolean = false')
    expect(params).toEqual([ASSISTANT, ACTOR, true])
  })

  it('limits governance reads to active shared rules and the viewer own scoped corpus', async () => {
    vi.mocked(systemQuery).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await listPlaybookRulesForViewer({
      assistantId: ASSISTANT,
      userId: ACTOR,
      isAssistantOwner: false,
    })
    const [sql, params] = vi.mocked(systemQuery).mock.calls.at(-1)!
    expect(sql).toContain("applies_to_user_id = $2")
    expect(sql).toContain("created_by = 'decision_reflection'")
    expect(sql).toContain("status IN ('suggested', 'active', 'retired')")
    expect(params).toEqual([ASSISTANT, ACTOR, false])
  })
})
