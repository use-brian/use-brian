import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordOverheadUsage } from '../_overhead-usage.js'

describe('[COMP:api/route-helpers] recordOverheadUsage', () => {
  const mockRecord = vi.fn().mockResolvedValue(undefined)
  const usageStore = { recordUsage: mockRecord } as never

  const baseParams = {
    usageStore,
    userId: 'owner-id',
    assistantId: 'asst_1',
    sessionId: 'sess_1',
    userMessageId: 'umsg_1',
    model: 'gemini-flash',
    usage: { inputTokens: 100, outputTokens: 50 },
    source: 'overhead:compaction',
  }

  beforeEach(() => {
    mockRecord.mockClear()
  })

  it('defaults actor_user_id to userId when actorUserId omitted (preserves web/Telegram behaviour)', async () => {
    await recordOverheadUsage(baseParams)
    expect(mockRecord).toHaveBeenCalledTimes(1)
    const args = mockRecord.mock.calls[0][0]
    expect(args.userId).toBe('owner-id')
    expect(args.actorUserId).toBe('owner-id')
  })

  it('passes actorUserId through when distinct from userId (API-shadow case)', async () => {
    // The bug this fixes: pre-fix, overhead rows for shadow-driven turns
    // were tagged actor_user_id = ownerId, so the admin per-user rollup
    // (filtered WHERE actor_user_id = shadow.id) missed them and reported
    // "tokens per turn = tokens per message". With actorUserId plumbed
    // through, overhead rows attribute to the visible visitor.
    await recordOverheadUsage({ ...baseParams, actorUserId: 'shadow-visitor-id' })
    const args = mockRecord.mock.calls[0][0]
    expect(args.userId).toBe('owner-id')          // billing party unchanged
    expect(args.actorUserId).toBe('shadow-visitor-id')
  })

  it('refuses to record non-overhead sources (guard against billable contamination)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await recordOverheadUsage({ ...baseParams, source: 'included' })
    expect(mockRecord).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing to record'))
    warn.mockRestore()
  })

  it('no-ops cleanly when usageStore is undefined', async () => {
    await recordOverheadUsage({ ...baseParams, usageStore: undefined })
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('no-ops cleanly when usage is null/missing (best-effort)', async () => {
    await recordOverheadUsage({ ...baseParams, usage: null })
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('swallows recordUsage errors so the main turn never breaks', async () => {
    mockRecord.mockRejectedValueOnce(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordOverheadUsage(baseParams)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
