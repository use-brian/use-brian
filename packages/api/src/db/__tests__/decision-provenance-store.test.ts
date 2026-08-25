import { describe, expect, it, vi } from 'vitest'

import {
  appendDecisionApplication,
  appendDecisionDerivation,
} from '../decision-provenance-store.js'

const UUID = {
  event: '00000000-0000-4000-8000-000000000001',
  actor: '00000000-0000-4000-8000-000000000002',
  assistant: '00000000-0000-4000-8000-000000000003',
  workspace: '00000000-0000-4000-8000-000000000004',
  artifact: '00000000-0000-4000-8000-000000000005',
  record: '00000000-0000-4000-8000-000000000006',
}

describe('[COMP:api/decision-provenance-store] provenance writes', () => {
  it('deduplicates one semantic derivation edge', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: UUID.record }], rowCount: 1 }),
    }
    const result = await appendDecisionDerivation({
      decisionEventId: UUID.event,
      artifactKind: 'playbook_rule',
      artifactId: UUID.artifact,
      relation: 'supports',
    }, client as never)
    expect(result).toEqual({ id: UUID.record, inserted: false })
    expect(client.query.mock.calls[0][0]).toContain('ON CONFLICT')
  })

  it('validates bounded content-free artifact refs before application SQL', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: UUID.record }] }) }
    await appendDecisionApplication({
      workspaceId: UUID.workspace,
      actorUserId: UUID.actor,
      assistantId: UUID.assistant,
      operationKind: 'chat_turn',
      operationId: 'session-turn-7',
      artifactRefs: [{ kind: 'playbook_rule', id: UUID.artifact }],
      visibility: 'owner',
      sensitivity: 'internal',
    }, client as never)
    const [sql, params] = client.query.mock.calls[0]
    expect(sql).toContain('INSERT INTO decision_applications')
    expect(params).toContain(JSON.stringify([{ kind: 'playbook_rule', id: UUID.artifact }]))
    expect(JSON.stringify(params)).not.toMatch(/prompt|response|email|argument/i)

    const invalid = { query: vi.fn() }
    await expect(appendDecisionApplication({
      workspaceId: UUID.workspace,
      actorUserId: UUID.actor,
      assistantId: UUID.assistant,
      operationKind: 'chat_turn',
      operationId: 'turn-8',
      artifactRefs: [{ kind: 'playbook_rule', id: UUID.artifact, prompt: 'private' } as never],
      visibility: 'owner',
      sensitivity: 'internal',
    }, invalid as never)).rejects.toThrow()
    expect(invalid.query).not.toHaveBeenCalled()
  })
})
