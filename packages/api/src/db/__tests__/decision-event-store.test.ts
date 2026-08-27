import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { appendDecisionEvent } from '../decision-event-store.js'

const UUID = {
  workspace: '00000000-0000-4000-8000-000000000001',
  actor: '00000000-0000-4000-8000-000000000002',
  approval: '00000000-0000-4000-8000-000000000003',
  event: '00000000-0000-4000-8000-000000000004',
}

function validEvent() {
  return {
    idempotencyKey: `approval:${UUID.approval}:deny`,
    workspaceId: UUID.workspace,
    actorUserId: UUID.actor,
    eventKind: 'approval.decided' as const,
    schemaVersion: 1 as const,
    sourceKind: 'pending_approval',
    sourceId: UUID.approval,
    declaredScope: 'tool' as const,
    visibility: 'owner' as const,
    sensitivity: 'internal' as const,
    reason: 'Show a draft first',
    payload: {
      approvalId: UUID.approval,
      approvalKind: 'tool_invocation',
      toolName: 'sendMessage',
      resolution: 'deny' as const,
    },
  }
}

describe('[COMP:api/decision-event-store] appendDecisionEvent', () => {
  it('rejects invalid payload and version before issuing SQL', async () => {
    const client = { query: vi.fn() }
    await expect(appendDecisionEvent({
      ...validEvent(),
      schemaVersion: 2,
    } as never, client as never)).rejects.toThrow()
    expect(client.query).not.toHaveBeenCalled()
  })

  it('inserts a minimized validated event through the supplied transaction client', async () => {
    const input = validEvent()
    const row = {
      id: UUID.event,
      ...input,
      assistantId: null,
      sessionId: null,
      causedByEventId: null,
      causedByApplicationId: null,
      reversesEventId: null,
      createdAt: new Date('2026-08-25T00:00:00Z'),
    }
    const client = { query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) }
    const result = await appendDecisionEvent(input, client as never)
    expect(result.inserted).toBe(true)
    expect(result.event.payload).toEqual(input.payload)
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls[0][0]).toContain('INSERT INTO decision_events')
    expect(client.query.mock.calls[0][1]).not.toContain('Show a draft first' + ' private payload')
  })

  it('returns the existing row without appending a duplicate on retry', async () => {
    const input = validEvent()
    const row = {
      id: UUID.event,
      ...input,
      assistantId: null,
      sessionId: null,
      causedByEventId: null,
      causedByApplicationId: null,
      reversesEventId: null,
      createdAt: new Date('2026-08-25T00:00:00Z'),
    }
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 }),
    }
    const result = await appendDecisionEvent(input, client as never)
    expect(result.inserted).toBe(false)
    expect(result.event.id).toBe(UUID.event)
  })

  it('keeps raw decision-event inserts confined to this store and migrations', () => {
    const srcDir = fileURLToPath(new URL('../..', import.meta.url))
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => `${entry.parentPath}/${entry.name}`)
    const offenders = files.filter((path) => {
      if (path.includes('/__tests__/') || path.endsWith('/decision-event-store.ts')) return false
      return /INSERT\s+INTO\s+decision_events/i.test(readFileSync(path, 'utf8'))
    })
    expect(offenders).toEqual([])
  })
})
