import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/brain-inbox-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/brain-inbox-store.js')>()
  const appendBrainVerification = vi.fn()
  return {
    ...actual,
    getBrainInboxRow: vi.fn(),
    listBrainInbox: vi.fn(),
    appendBrainVerification,
    applyBrainCorrection: vi.fn(async <T,>(params: {
      mutate: (client: never) => Promise<T>
      verifications: (result: T) => readonly unknown[]
    }) => {
      const result = await params.mutate({} as never)
      for (const verification of params.verifications(result)) {
        await appendBrainVerification(verification)
      }
      return result
    }),
    markVerifiedGeneric: vi.fn(),
  }
})
vi.mock('../db/memories.js', () => ({
  updateMemory: vi.fn(),
  getMemoryByIdSystem: vi.fn(),
  markVerifiedDirect: vi.fn(),
}))
vi.mock('../db/memory-verifications-store.js', () => ({
  adjustMemoryDecision: vi.fn(),
  recordVerification: vi.fn(),
}))
vi.mock('../brain-stream/notify.js', () => ({
  notifyBrainInboxChange: vi.fn(),
}))

import { createBrainEntryMutator } from '../brain-entry-mutation.js'
import { getBrainInboxRow } from '../db/brain-inbox-store.js'
import {
  getMemoryByIdSystem,
} from '../db/memories.js'
import { adjustMemoryDecision } from '../db/memory-verifications-store.js'

const workspaceStore = {
  getRole: vi.fn().mockResolvedValue('member'),
} as never

const row = {
  primitive: 'memory' as const,
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'workspace-1',
  createdAt: new Date('2026-08-10T00:00:00.000Z'),
  updatedAt: new Date('2026-08-11T08:48:30.359Z'),
  createdByAssistantId: 'assistant-1',
  verifiedByUserId: null,
  verifiedAt: null,
  body: {
    summary: 'Application essay draft',
    detail: 'Third-year student.',
    scope: 'shared',
    sensitivity: 'public',
  },
}

describe('[COMP:api/brain-entry-mutation] shared Review-entry mutation seam', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hides another user\'s personal visibility-double row from discovery/read', async () => {
    vi.mocked(getBrainInboxRow).mockResolvedValueOnce({
      ...row,
      body: { ...row.body, user_id: 'user-2' },
    })
    const mutator = createBrainEntryMutator({ workspaceStore })
    const result = await mutator.getEditableEntry(
      'workspace-1',
      'memory',
      row.id,
      { userId: 'user-1', clearance: 'confidential' },
    )
    expect(result).toBeNull()
  })

  it('hides rows above the acting viewer clearance', async () => {
    vi.mocked(getBrainInboxRow).mockResolvedValueOnce({
      ...row,
      body: { ...row.body, sensitivity: 'confidential' },
    })
    const mutator = createBrainEntryMutator({ workspaceStore })
    const result = await mutator.getEditableEntry(
      'workspace-1',
      'memory',
      row.id,
      { userId: 'user-1', clearance: 'internal' },
    )
    expect(result).toBeNull()
  })

  it('checks workspace membership before reading or writing the target', async () => {
    const deniedWorkspaceStore = {
      getRole: vi.fn().mockResolvedValue(null),
    } as never
    const mutator = createBrainEntryMutator({ workspaceStore: deniedWorkspaceStore })

    const result = await mutator.mutate({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      primitive: 'memory',
      rowId: row.id,
      changes: { detail: 'Graduate.' },
    })

    expect(result.status).toBe(403)
    expect(getBrainInboxRow).not.toHaveBeenCalled()
    expect(adjustMemoryDecision).not.toHaveBeenCalled()
  })

  it('returns not-found rather than stale when the bound row disappeared', async () => {
    vi.mocked(getBrainInboxRow).mockResolvedValueOnce(null)
    const mutator = createBrainEntryMutator({ workspaceStore })

    const result = await mutator.mutate({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      primitive: 'memory',
      rowId: row.id,
      expectedUpdatedAt: row.updatedAt.toISOString(),
      changes: { detail: 'Graduate.' },
    })

    expect(result.status).toBe(404)
    expect(adjustMemoryDecision).not.toHaveBeenCalled()
  })

  it('fails a stale confirmed preview before any writer runs', async () => {
    vi.mocked(getBrainInboxRow).mockResolvedValueOnce(row)
    const mutator = createBrainEntryMutator({ workspaceStore })

    const result = await mutator.mutate({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      primitive: 'memory',
      rowId: row.id,
      expectedUpdatedAt: '2026-08-10T00:00:00.000Z',
      changes: { detail: 'Graduate.' },
    })

    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ code: 'stale_entry' })
    expect(adjustMemoryDecision).not.toHaveBeenCalled()
  })

  it('applies an assistant-owned memory through the same non-redirecting path', async () => {
    vi.mocked(getBrainInboxRow).mockResolvedValueOnce(row)
    vi.mocked(getMemoryByIdSystem).mockResolvedValueOnce({
      id: row.id,
      assistantId: 'assistant-1',
      workspaceId: 'workspace-1',
      scope: 'shared',
      sensitivity: 'public',
      summary: 'Application essay draft',
      detail: 'Third-year student.',
    } as never)
    vi.mocked(adjustMemoryDecision).mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'workspace-1',
      scope: 'shared',
      sensitivity: 'public',
      summary: 'Application essay draft',
      detail: 'Graduate.',
    } as never)
    const mutator = createBrainEntryMutator({ workspaceStore })

    const result = await mutator.mutate({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      primitive: 'memory',
      rowId: row.id,
      expectedUpdatedAt: row.updatedAt.toISOString(),
      changes: { detail: 'Graduate.' },
    })

    expect(result.status).toBe(200)
    expect(result.body.memory).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
    })
    expect(adjustMemoryDecision).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: row.id,
      workspaceId: 'workspace-1',
      verifiedBy: 'user-1',
      updates: expect.objectContaining({ detail: 'Graduate.' }),
      verifications: [expect.objectContaining({ action: 'edit_summary' })],
    }))
  })
})
