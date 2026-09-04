import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

vi.mock('../client.js', () => ({
  query: db.query,
  queryWithRLS: db.queryWithRLS,
}))

import { createProgrammaticCaptureStore } from '../programmatic-capture-store.js'

describe('[COMP:api/programmatic-capture] target resolution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fails closed without an explicitly selected capture assistant', async () => {
    const store = createProgrammaticCaptureStore()
    await expect(store.resolveTargetSystem({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      assistantId: null,
      overrideProfileId: null,
    })).resolves.toBeNull()
    expect(db.query).not.toHaveBeenCalled()
  })

  it('selects the connection override before the assistant default', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{
        workspaceId: '11111111-1111-4111-8111-111111111111',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        assistantId: '33333333-3333-4333-8333-333333333333',
        assistantName: 'Writing assistant',
        assistantClearance: 'internal',
        assistantDefaultCompartments: [],
        assistantDefaultProjectId: null,
        profileId: '44444444-4444-4444-8444-444444444444',
        profileName: 'Draft capture',
        partitionBy: 'session',
      }] })
      .mockResolvedValueOnce({ rows: [] })

    const store = createProgrammaticCaptureStore()
    const target = await store.resolveTargetSystem({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      assistantId: '33333333-3333-4333-8333-333333333333',
      overrideProfileId: '44444444-4444-4444-8444-444444444444',
    })

    expect(target?.profileId).toBe('44444444-4444-4444-8444-444444444444')
    const [sql, params] = db.query.mock.calls[0]!
    expect(sql).toContain('COALESCE($3::uuid, a.capture_profile_id)')
    expect(params).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
    ])
  })
})
