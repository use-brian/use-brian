import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFeedEditorialWorker } from '../feed-editorial-worker.js'
import { claimFeedRun, failFeedRun, type FeedEditorialRun } from '../../db/feed-editorial-runs-store.js'
import { FeedCollaborationError } from '../../db/feed-collaboration-store.js'
import { GoogleRequestNotDispatchedError } from '@use-brian/agent-runtime/providers/google-auth.js'

vi.mock('../../db/feed-editorial-runs-store.js', () => ({ claimFeedRun: vi.fn(), failFeedRun: vi.fn(), renewFeedLease: vi.fn() }))
vi.mock('../../db/feed-collaboration-store.js', () => ({
  FeedCollaborationError: class extends Error { constructor(public status: number, public code: string) { super(code) } },
}))
vi.mock('../../brain-stream/notify.js', () => ({ notifyWorkspaceChange: vi.fn() }))

function claimedRun(): FeedEditorialRun {
  return {
    id: 'run-fictional', workspaceId: 'workspace-fictional', assistantId: 'assistant-fictional',
    sessionId: 'session-fictional', actorUserId: 'user-fictional', kind: 'image_generation',
    revision: 1, requestId: 'request-fictional', fingerprint: 'fingerprint', logicalKey: 'key',
    request: {}, context: {}, leaseId: 'lease-fictional', leaseUntil: new Date(),
    dispatchedPart: 'generation', result: { parts: {} }, usage: {}, parentRunId: null,
    createdAt: new Date(), status: 'running', attempts: 1, error: null,
    coverage: {}, summaryThreadId: null, model: 'image-model',
  }
}

describe('[COMP:feed/draft-review] editorial worker failure diagnostics', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(failFeedRun).mockResolvedValue(undefined) })
  afterEach(() => { vi.restoreAllMocks() })

  it('retains transport cause codes without private exception content or another dispatch', async () => {
    const run = claimedRun()
    vi.mocked(claimFeedRun).mockResolvedValueOnce(run).mockResolvedValue(null)
    const cause = Object.assign(new Error('private provider payload'), { code: 'ECONNRESET' })
    const error = new TypeError('fetch failed', { cause: new AggregateError([cause], 'private response') })
    const handler = vi.fn().mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const worker = createFeedEditorialWorker({ handlers: { image_generation: handler } })

    await worker.tick(); await worker.tick()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(failFeedRun).toHaveBeenCalledExactlyOnceWith(run, 'generation_transport_failed')
    expect(run.dispatchedPart).toBe('generation') // The store keeps an unanswered dispatch unknown.
    expect(log).toHaveBeenCalledExactlyOnceWith('[feed-editorial] run failed', {
      runId: run.id, workspaceId: run.workspaceId, assistantId: run.assistantId,
      sessionId: run.sessionId, kind: 'image_generation', errorName: 'TypeError', causeCodes: ['ECONNRESET'],
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })

  it('keeps unknown exceptions generic and bounds cyclic causes without logging arbitrary names or codes', async () => {
    const run = claimedRun()
    vi.mocked(claimFeedRun).mockResolvedValueOnce(run)
    const error: { name: string; code: string; cause?: unknown } = { name: 'private_token', code: 'private_token' }
    error.cause = error
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await createFeedEditorialWorker({ handlers: { image_generation: vi.fn().mockRejectedValue(error) } }).tick()
    expect(failFeedRun).toHaveBeenCalledExactlyOnceWith(run, 'editorial_run_failed')
    expect(log.mock.calls[0]?.[1]).toMatchObject({ errorName: 'UnknownError', causeCodes: [] })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private_token')
  })

  it('preserves known collaboration failures and does not mislabel a pre-dispatch network failure', async () => {
    const run = claimedRun(); run.dispatchedPart = null
    vi.mocked(claimFeedRun).mockResolvedValue(run)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = vi.fn().mockRejectedValueOnce(new FeedCollaborationError(409, 'run_no_longer_active'))
      .mockRejectedValueOnce(Object.assign(new Error('private database URL'), { code: 'ECONNREFUSED' }))
    const worker = createFeedEditorialWorker({ handlers: { image_generation: handler } })
    await worker.tick(); await worker.tick()
    expect(failFeedRun).toHaveBeenNthCalledWith(1, run, 'run_no_longer_active')
    expect(failFeedRun).toHaveBeenNthCalledWith(2, run, 'editorial_run_failed')
  })

  it('does not infer provider transport from an unrelated socket error after dispatch', async () => {
    const run = claimedRun()
    vi.mocked(claimFeedRun).mockResolvedValueOnce(run)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = Object.assign(new Error('private database URL'), { code: 'ECONNREFUSED' })
    await createFeedEditorialWorker({ handlers: { image_generation: vi.fn().mockRejectedValue(error) } }).tick()
    expect(failFeedRun).toHaveBeenCalledExactlyOnceWith(run, 'editorial_run_failed')
  })
  it('requeues a provider request that provably never left the host', async () => {
    const run = claimedRun()
    vi.mocked(claimFeedRun).mockResolvedValueOnce(run)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = Object.assign(new Error('private route detail'), { code: 'ENETUNREACH' })
    await createFeedEditorialWorker({ handlers: { image_generation: vi.fn().mockRejectedValue(new GoogleRequestNotDispatchedError(cause)) } }).tick()
    expect(failFeedRun).toHaveBeenCalledExactlyOnceWith(run, 'provider_request_not_dispatched', { providerRequest: 'not_dispatched' })
  })
  it('retains a receipt-storage SQLSTATE without logging the query or confusing it with provider failure', async () => {
    const run = claimedRun(); vi.mocked(claimFeedRun).mockResolvedValueOnce(run)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = Object.assign(new Error('private query details'), { code: '40001', detail: 'private row' })
    await createFeedEditorialWorker({ handlers: { image_generation: vi.fn().mockRejectedValue(error) } }).tick()
    expect(failFeedRun).toHaveBeenCalledExactlyOnceWith(run, 'editorial_run_failed')
    expect(log.mock.calls[0]?.[1]).toMatchObject({ causeCodes: ['40001'] })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })

})
