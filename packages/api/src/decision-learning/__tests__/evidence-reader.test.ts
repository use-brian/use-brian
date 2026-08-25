import { describe, expect, it, vi } from 'vitest'

import {
  changedEmailRegion,
  readDecisionEvidence,
  stripQuotedEmailHistory,
} from '../evidence-reader.js'

const ASSISTANT = '00000000-0000-4000-8000-000000000001'
const ACTOR = '00000000-0000-4000-8000-000000000002'
const A1 = '00000000-0000-4000-8000-000000000010'
const A2 = '00000000-0000-4000-8000-000000000011'
const A3 = '00000000-0000-4000-8000-000000000012'

describe('[COMP:workers/decision-reflection] evidence reader', () => {
  it('strips headers and quoted history before bounding changed regions', () => {
    const cleaned = stripQuotedEmailHistory(
      'Thanks\n\nFrom: client@example.test\nSubject: Prior\n> secret history\nOn Monday someone wrote:',
    )
    expect(cleaned).toBe('Thanks')
    const changed = changedEmailRegion('Hello old value', `Hello ${'new'.repeat(500)}`)
    expect(changed.before).toBe('old value')
    expect(changed.after.length).toBe(1_000)
  })

  it('collapses repeated revisions in one approval chain and excludes plain approvals by SQL', async () => {
    const now = new Date('2026-08-25T12:00:00Z')
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        {
          id: '00000000-0000-4000-8000-000000000101',
          eventKind: 'email.draft_revised',
          sourceId: A2,
          reason: null,
          payload: { previousApprovalId: A1, replacementApprovalId: A2, accountKey: 'primary' },
          sensitivity: 'internal',
          createdAt: new Date(now.getTime() - 2_000),
        },
        {
          id: '00000000-0000-4000-8000-000000000102',
          eventKind: 'email.draft_revised',
          sourceId: A3,
          reason: null,
          payload: { previousApprovalId: A2, replacementApprovalId: A3, accountKey: 'primary' },
          sensitivity: 'confidential',
          createdAt: new Date(now.getTime() - 1_000),
        },
        {
          id: '00000000-0000-4000-8000-000000000103',
          eventKind: 'approval.decided',
          sourceId: 'tool-1',
          reason: 'Ask before sending',
          payload: { toolCallId: 'tool-1', approvalKind: 'tool_invocation', toolName: 'sendMessage', resolution: 'deny' },
          sensitivity: 'internal',
          createdAt: now,
        },
      ] })
      .mockResolvedValueOnce({ rows: [
        { id: A1, body: 'Hello old wording\n> quoted secret' },
        { id: A3, body: 'Hello final wording' },
      ] })
      .mockResolvedValueOnce({ rows: [{ rule: 'Existing rule', status: 'rejected', semanticKey: 'x', appliesToUserId: ACTOR }] })
      .mockResolvedValueOnce({ rows: [{ newest: null }] })
    const bundle = await readDecisionEvidence(
      { assistantId: ASSISTANT, actorUserId: ACTOR },
      { query } as never,
    )

    expect(bundle.evidence).toHaveLength(2)
    const email = bundle.evidence.find((item) => item.sourceKind === 'reviewed_email')!
    expect(email.eventIds).toHaveLength(2)
    expect(email.sourceObjectId).toBe(A1)
    expect(email.sensitivity).toBe('confidential')
    expect(email.changedRegion).toEqual({ before: 'old', after: 'final' })
    expect(bundle.corpus[0].status).toBe('rejected')
    expect(bundle.hasNewEvidence).toBe(true)
    expect(query.mock.calls[0][0]).toContain("de.payload->>'resolution' IN ('deny', 'always_deny')")
    expect(query.mock.calls[0][0]).toContain('NULLIF(btrim(de.reason)')
    expect(query.mock.calls[0][0]).toContain("ep_u.auth_provider_id LIKE 'api:%'")
  })

  it('marks a bundle unchanged when every grouped source predates linked evidence', async () => {
    const eventAt = new Date('2026-08-20T00:00:00Z')
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: '00000000-0000-4000-8000-000000000110',
        eventKind: 'approval.decided',
        sourceId: 'tool-1',
        reason: 'Do not send automatically',
        payload: { toolCallId: 'tool-1', approvalKind: 'tool_invocation', toolName: 'sendMessage', resolution: 'deny' },
        sensitivity: 'internal',
        createdAt: eventAt,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ newest: new Date('2026-08-21T00:00:00Z') }] })
    const bundle = await readDecisionEvidence(
      { assistantId: ASSISTANT, actorUserId: ACTOR },
      { query } as never,
    )
    expect(bundle.hasNewEvidence).toBe(false)
  })
})
