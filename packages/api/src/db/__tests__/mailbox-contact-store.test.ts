import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ queryWithRLS: vi.fn(), queryGated: vi.fn() }))

import { queryGated, queryWithRLS } from '../client.js'
import { listMailboxContactImportCandidates } from '../mailbox-contact-store.js'

const mockRls = vi.mocked(queryWithRLS)
const mockGated = vi.mocked(queryGated)

beforeEach(() => {
  mockRls.mockReset()
  mockGated.mockReset()
})

describe('[COMP:api/mailbox-contact-import-store] candidates', () => {
  it('is owner/instance scoped and excludes self, machine senders, and visible CRM emails', async () => {
    mockRls.mockResolvedValue({ rows: [
      { from_addr: 'Alex Example <alex@example.com>', message_count: '4', last_sent_at: '2026-08-01T00:00:00Z' },
      { from_addr: 'No Reply <no-reply@example.com>', message_count: '8', last_sent_at: '2026-08-02T00:00:00Z' },
      { from_addr: 'Me <me@example.com>', message_count: '2', last_sent_at: '2026-08-03T00:00:00Z' },
      { from_addr: 'Existing <known@example.com>', message_count: '1', last_sent_at: '2026-08-04T00:00:00Z' },
    ], rowCount: 4 } as never)
    mockGated.mockResolvedValue({ rows: [{ email: 'known@example.com' }], rowCount: 1 } as never)

    const result = await listMailboxContactImportCandidates({
      ownerUserId: 'owner-1',
      instanceId: 'instance-1',
      accountEmail: 'me@example.com',
      access: {
        workspaceId: 'workspace-1', userId: 'owner-1', assistantId: 'assistant-1',
        assistantKind: 'standard', clearance: 'internal',
      },
    })

    expect(result.candidates).toEqual([expect.objectContaining({
      name: 'Alex Example', email: 'alex@example.com', messageCount: 4,
    })])
    expect(mockRls).toHaveBeenCalledWith(
      'owner-1', expect.stringContaining('owner_user_id = $1 AND instance_id = $2'),
      ['owner-1', 'instance-1', 2001],
    )
    expect(mockGated.mock.calls[0][1]).toContain("e.kind = 'person'")
  })
})
