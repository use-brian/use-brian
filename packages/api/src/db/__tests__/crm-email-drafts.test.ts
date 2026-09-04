import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  applyRLSGucs: vi.fn(),
  getAppPool: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { applyRLSGucs, getAppPool, queryWithRLS } from '../client.js'
import { createDbCrmEmailDraftStore } from '../crm-email-drafts.js'

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

describe('[COMP:crm/email-drafts] database store', () => {
  it('atomically saves the current row, immutable revision, and session anchor', async () => {
    const issued: Array<{ text: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        issued.push({ text, values })
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
      [WORKSPACE_ID, 'session-1'],
    )
  })
})
