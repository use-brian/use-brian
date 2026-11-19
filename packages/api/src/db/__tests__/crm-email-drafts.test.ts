import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  applyRLSGucs: vi.fn(),
  getAppPool: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { applyRLSGucs, getAppPool, queryWithRLS } from '../client.js'
import { CrmEmailDraftAnchorConflictError, createDbCrmEmailDraftStore } from '../crm-email-drafts.js'

/** [COMP:crm/email-drafts] Atomic current projection, version, and session anchor. */

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DRAFT_ID = '11111111-1111-4111-8111-111111111111'
const now = new Date('2026-08-27T00:00:00.000Z')

function draftRow(revision = 1) {
  return {
    id: DRAFT_ID,
    workspaceId: WORKSPACE_ID,
    status: 'draft' as const,
    revision,
    from: 'team@example.test',
    to: ['recipient@example.test'],
    cc: [],
    bcc: [],
    subject: 'Exact draft',
    body: revision === 1 ? 'Complete body one' : 'Complete body two',
    attachments: ['/travel/receipt.pdf'],
    createdByUserId: 'user-1',
    createdByAssistantId: 'assistant-1',
    sourceSessionId: 'session-1',
    createdAt: now,
    updatedAt: now,
  }
}

const baseParams = {
  userId: 'user-1',
  workspaceId: WORKSPACE_ID,
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  from: 'team@example.test',
  to: ['recipient@example.test'],
  cc: [],
  bcc: [],
  subject: 'Exact draft',
  body: 'Complete body one',
  attachments: ['/travel/receipt.pdf'],
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** The caller's membership row and a fresh anchor insert, which every successful save sees first. */
function memberAndAnchor(text: string, anchor: 'inserted' | 'same_workspace' | 'other_workspace' = 'inserted') {
  if (text.includes('FROM workspace_members') && text.includes('FOR SHARE')) return { rows: [{ user_id: 'user-1' }], rowCount: 1 }
  if (text.includes('INSERT INTO crm_email_draft_session_anchors')) {
    return anchor === 'inserted' ? { rows: [{ session_id: 'session-1' }], rowCount: 1 } : { rows: [], rowCount: 0 }
  }
  if (text.includes('UPDATE crm_email_draft_session_anchors')) {
    return anchor === 'same_workspace' ? { rows: [{ session_id: 'session-1' }], rowCount: 1 } : { rows: [], rowCount: 0 }
  }
  return null
}

describe('[COMP:crm/email-drafts] database store', () => {
  it('atomically saves the current row, immutable revision, and session anchor', async () => {
    const issued: Array<{ text: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        issued.push({ text, values })
        const proven = memberAndAnchor(text)
        if (proven) return proven
        if (text.includes('INSERT INTO crm_email_drafts')) {
          return { rows: [{ id: DRAFT_ID }], rowCount: 1 }
        }
        if (text.includes('SELECT') && text.includes('FROM crm_email_drafts d')) {
          return { rows: [draftRow()], rowCount: 1 }
        }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    }
    vi.mocked(getAppPool).mockReturnValue({ connect: async () => client } as never)

    await expect(createDbCrmEmailDraftStore().saveRevision(baseParams))
      .resolves.toMatchObject({ id: DRAFT_ID, revision: 1, body: 'Complete body one', attachments: ['/travel/receipt.pdf'] })

    expect(issued[0]?.text).toBe('BEGIN')
    expect(applyRLSGucs).toHaveBeenCalledWith(client, 'user-1')
    expect(issued[1]).toEqual({ text: 'SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', values: [WORKSPACE_ID, 'user-1'] })
    expect(issued.some((entry) => entry.text.includes('DO UPDATE'))).toBe(false)
    expect(issued.some((entry) => entry.text.includes('INSERT INTO crm_email_draft_versions'))).toBe(true)
    expect(issued.some((entry) => entry.text.includes('INSERT INTO crm_email_draft_session_anchors'))).toBe(true)
    expect(issued.at(-1)?.text).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('increments the locked revision and preserves the full replacement body and attachments', async () => {
    const issued: Array<{ text: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        issued.push({ text, values })
        const proven = memberAndAnchor(text, 'same_workspace')
        if (proven) return proven
        if (text.includes('SELECT revision') && text.includes('FOR UPDATE')) {
          return { rows: [{ revision: 1 }], rowCount: 1 }
        }
        if (text.includes('SELECT') && text.includes('FROM crm_email_drafts d')) {
          return { rows: [draftRow(2)], rowCount: 1 }
        }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    }
    vi.mocked(getAppPool).mockReturnValue({ connect: async () => client } as never)

    await expect(createDbCrmEmailDraftStore().saveRevision({
      ...baseParams,
      draftId: DRAFT_ID,
      body: 'Complete body two',
      attachments: ['/travel/receipt.pdf', '/travel/itinerary.pdf'],
    })).resolves.toMatchObject({ id: DRAFT_ID, revision: 2, body: 'Complete body two' })

    const anchor = issued.find((entry) => entry.text.includes('UPDATE crm_email_draft_session_anchors'))!
    expect(anchor.text).toContain('WHERE session_id = $1 AND workspace_id = $2')
    expect(anchor.values).toEqual(['session-1', WORKSPACE_ID, DRAFT_ID])
    const update = issued.find((entry) => entry.text.includes('UPDATE crm_email_drafts'))!
    expect(update.values).toEqual(expect.arrayContaining([2, 'Complete body two', ['/travel/receipt.pdf', '/travel/itinerary.pdf']]))
    const version = issued.find((entry) => entry.text.includes('INSERT INTO crm_email_draft_versions'))!
    expect(version.values).toEqual(expect.arrayContaining([DRAFT_ID, 2, 'Complete body two', ['/travel/receipt.pdf', '/travel/itinerary.pdf']]))
    expect(issued.at(-1)?.text).toBe('COMMIT')
  })

  it('reads the active exact revision through the user-scoped RLS boundary', async () => {
    vi.mocked(queryWithRLS).mockResolvedValue({ rows: [draftRow(2)], rowCount: 1 } as never)

    await expect(createDbCrmEmailDraftStore().getActiveForSession({
      userId: 'user-1',
      workspaceId: WORKSPACE_ID,
      sessionId: 'session-1',
    })).resolves.toMatchObject({ id: DRAFT_ID, revision: 2, body: 'Complete body two' })

    expect(queryWithRLS).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('JOIN crm_email_drafts d'),
      [WORKSPACE_ID, 'session-1', 'user-1'],
    )
    expect(vi.mocked(queryWithRLS).mock.calls[0]?.[1]).toContain('FROM workspace_members m WHERE m.workspace_id = $1 AND m.user_id = $3')
  })

  it('returns null without writing when the caller is not a current member', async () => {
    const issued: string[] = []
    const client = {
      query: vi.fn(async (text: string) => { issued.push(text); return { rows: [], rowCount: 0 } }),
      release: vi.fn(),
    }
    vi.mocked(getAppPool).mockReturnValue({ connect: async () => client } as never)
    await expect(createDbCrmEmailDraftStore().saveRevision(baseParams)).resolves.toBeNull()
    expect(issued.filter((text) => /INSERT|UPDATE/.test(text))).toEqual([])
    expect(issued).toContain('ROLLBACK')
    expect(issued).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('refuses explicitly when the conversation anchor belongs to another workspace', async () => {
    const issued: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        issued.push(text)
        const proven = memberAndAnchor(text, 'other_workspace')
        if (proven) return proven
        if (text.includes('INSERT INTO crm_email_drafts')) return { rows: [{ id: DRAFT_ID }], rowCount: 1 }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    }
    vi.mocked(getAppPool).mockReturnValue({ connect: async () => client } as never)
    await expect(createDbCrmEmailDraftStore().saveRevision(baseParams)).rejects.toBeInstanceOf(CrmEmailDraftAnchorConflictError)
    expect(issued).toContain('ROLLBACK')
    expect(issued).not.toContain('COMMIT')
  })

  it('carries the membership predicate on the list and by-id reads', async () => {
    vi.mocked(queryWithRLS).mockResolvedValue({ rows: [], rowCount: 0 } as never)
    const store = createDbCrmEmailDraftStore()
    await store.list({ userId: 'user-1', workspaceId: WORKSPACE_ID })
    await store.getById({ userId: 'user-1', workspaceId: WORKSPACE_ID, draftId: DRAFT_ID })
    expect(vi.mocked(queryWithRLS).mock.calls.map(call => call[2])).toEqual([[WORKSPACE_ID, 25, 'user-1'], [WORKSPACE_ID, DRAFT_ID, 'user-1']])
    for (const call of vi.mocked(queryWithRLS).mock.calls) {
      expect(call[1]).toContain('FROM workspace_members m WHERE m.workspace_id = $1 AND m.user_id = $3')
    }
  })
})
