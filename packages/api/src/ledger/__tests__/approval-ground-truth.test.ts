/**
 * Approval ground truth - the agent-proposed vs human-decided diff over
 * pending_approvals rows the product already collects.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect, vi } from 'vitest'

const rows = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async (text: string) => {
    if (!text.includes('FROM pending_approvals')) throw new Error('unexpected query')
    return { rows: rows.data }
  }),
  getPool: vi.fn(),
}))

import { listApprovalGroundTruth, summarizeApprovalGroundTruth } from '../approval-ground-truth.js'

function row(tool: string, status: string, reason: string | null = null): Record<string, unknown> {
  return {
    id: `${tool}-${Math.random()}`,
    tool_name: tool,
    arguments: { x: 1 },
    status,
    responded_by: 'u1',
    reject_reason: reason,
    created_at: new Date('2026-08-01T00:00:00Z'),
    responded_at: new Date('2026-08-01T00:05:00Z'),
  }
}

describe('[COMP:api/approval-ground-truth] the labelled set', () => {
  it('maps decided rows with latency', async () => {
    rows.data = [row('gmailSendMessage', 'approved')]
    const got = await listApprovalGroundTruth({ workspaceId: 'ws1' })
    expect(got).toHaveLength(1)
    expect(got[0].toolName).toBe('gmailSendMessage')
    expect(got[0].decision).toBe('approved')
    expect(got[0].latencyMs).toBe(5 * 60 * 1000)
  })

  it('summarizes per tool - the rejection rate IS the eval signal', async () => {
    rows.data = [
      row('gmailSendMessage', 'approved'),
      row('gmailSendMessage', 'approved'),
      row('deleteMemory', 'rejected', 'wrong memory'),
      row('deleteMemory', 'rejected', 'never delete these'),
      row('deleteMemory', 'approved'),
    ]
    const got = await listApprovalGroundTruth({ workspaceId: 'ws1' })
    const summary = summarizeApprovalGroundTruth(got)
    expect(summary[0].toolName).toBe('deleteMemory')
    expect(summary[0].proposed).toBe(3)
    expect(summary[0].rejected).toBe(2)
    expect(summary[0].rejectionRate).toBeCloseTo(2 / 3)
    expect(summary[0].rejectReasons).toEqual(['wrong memory', 'never delete these'])
    expect(summary[1].toolName).toBe('gmailSendMessage')
    expect(summary[1].rejectionRate).toBe(0)
  })
})
