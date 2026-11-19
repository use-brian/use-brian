/**
 * [COMP:brain/session-resume-worker] The resume's predecessor-lease slot wait
 * (askquestion-suspend-resume.md → "Resumed turn execution (D9)", step 1): the
 * suspended turn's own lease, named by the resume point, is reclaimed by the
 * resume the moment it is stale; a fresh lease or any other lease is never
 * reclaimed and keeps the ordinary wait, failing closed at its bound.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lease: vi.fn(), reclaim: vi.fn(), wait: vi.fn() }))
vi.mock('../../db/session-resume-store.js', () => ({ readResumePredecessorLease: mocks.lease }))
vi.mock('../../db/sessions.js', async importOriginal => ({ ...await importOriginal<typeof import('../../db/sessions.js')>(),
  reclaimStaleTurnOutcome: mocks.reclaim }))
vi.mock('../../turn/lease.js', async importOriginal => ({ ...await importOriginal<typeof import('../../turn/lease.js')>(),
  waitForTurnSlot: mocks.wait }))

import { resumePredecessorSlotWait } from '../session-resume-replay.js'

const predecessor = 'a1a1a1a1-0000-4000-8000-000000000001'
const recovered = { turnId: 'd'.repeat(64), reason: 'stalled_reclaimed' as const }
beforeEach(() => { vi.clearAllMocks(); mocks.wait.mockResolvedValue(false); mocks.reclaim.mockResolvedValue(recovered) })

describe('[COMP:brain/session-resume-worker] predecessor-lease slot wait', () => {
  it('ends at once when no turn is running', async () => {
    mocks.lease.mockResolvedValue({ running: false, predecessorToken: null, stale: false })
    const onReclaimed = vi.fn()
    await expect(resumePredecessorSlotWait({ approvalId: 'fictional-approval', onReclaimed })('fictional-session')).resolves.toBe(true)
    expect(mocks.reclaim).not.toHaveBeenCalled(); expect(onReclaimed).not.toHaveBeenCalled()
  })

  it('waits while the predecessor lease is fresh and reclaims it, fenced to its token, the moment it is stale', async () => {
    mocks.lease.mockResolvedValueOnce({ running: true, predecessorToken: predecessor, stale: false })
      .mockResolvedValueOnce({ running: true, predecessorToken: predecessor, stale: false })
      .mockResolvedValue({ running: true, predecessorToken: predecessor, stale: true })
    const onReclaimed = vi.fn()
    const wait = resumePredecessorSlotWait({ approvalId: 'fictional-approval', onReclaimed, options: { staleAfterMs: 3_000, pollMs: 50 } })
    await expect(wait('fictional-session')).resolves.toBe(true)
    // Each fresh read waits one poll of the ordinary slot wait, never the whole bound.
    expect(mocks.wait).toHaveBeenCalledTimes(2)
    expect(mocks.wait.mock.calls[0]![1]).toMatchObject({ timeoutMs: 50, pollMs: 50 })
    expect(mocks.lease).toHaveBeenCalledWith('fictional-session', 'fictional-approval', 3_000)
    expect(mocks.reclaim).toHaveBeenCalledExactlyOnceWith('fictional-session', 3_000, predecessor)
    expect(onReclaimed).toHaveBeenCalledExactlyOnceWith(recovered)
  })

  it('re-reads instead of claiming when the fenced reclaim finds the lease changed', async () => {
    mocks.lease.mockResolvedValueOnce({ running: true, predecessorToken: predecessor, stale: true })
      .mockResolvedValue({ running: false, predecessorToken: null, stale: false })
    mocks.reclaim.mockResolvedValueOnce(null)
    const onReclaimed = vi.fn()
    await expect(resumePredecessorSlotWait({ approvalId: 'fictional-approval', onReclaimed })('fictional-session')).resolves.toBe(true)
    expect(onReclaimed).not.toHaveBeenCalled(); expect(mocks.lease).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a stale lease the resume point does not name', { running: true, predecessorToken: null, stale: true }],
    ['a fresh lease the resume point does not name', { running: true, predecessorToken: null, stale: false }],
  ])('never reclaims %s and fails closed at the ordinary wait bound', async (_case, lease) => {
    mocks.lease.mockResolvedValue(lease)
    const onReclaimed = vi.fn()
    const wait = resumePredecessorSlotWait({ approvalId: 'fictional-approval', onReclaimed, options: { timeoutMs: 1_000, pollMs: 50 } })
    await expect(wait('fictional-session')).resolves.toBe(false)
    expect(mocks.reclaim).not.toHaveBeenCalled(); expect(onReclaimed).not.toHaveBeenCalled()
    expect(mocks.wait).toHaveBeenCalledTimes(1)
    expect(mocks.wait.mock.calls[0]![1].timeoutMs).toBeGreaterThan(900)
  })

  it('keeps waiting on a live predecessor until the bound, then fails closed without reclaiming', async () => {
    mocks.lease.mockResolvedValue({ running: true, predecessorToken: predecessor, stale: false })
    const onReclaimed = vi.fn()
    const wait = resumePredecessorSlotWait({ approvalId: 'fictional-approval', onReclaimed, options: { timeoutMs: 300, pollMs: 50 } })
    mocks.wait.mockImplementation(async (_id: string, opts: { timeoutMs: number }) => {
      await new Promise(resolve => setTimeout(resolve, opts.timeoutMs)); return false })
    await expect(wait('fictional-session')).resolves.toBe(false)
    expect(mocks.wait.mock.calls.length).toBeGreaterThan(2)
    expect(mocks.reclaim).not.toHaveBeenCalled(); expect(onReclaimed).not.toHaveBeenCalled()
  })

  it('ends when the holder releases during a poll', async () => {
    mocks.lease.mockResolvedValue({ running: true, predecessorToken: predecessor, stale: false })
    mocks.wait.mockResolvedValueOnce(true)
    await expect(resumePredecessorSlotWait({ approvalId: 'fictional-approval', onReclaimed: vi.fn() })('fictional-session')).resolves.toBe(true)
    expect(mocks.reclaim).not.toHaveBeenCalled()
  })
})
