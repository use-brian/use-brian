import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), capture: vi.fn(), rollback: vi.fn() }))
vi.mock('../client.js', () => ({
  getAppPool: () => ({ connect: async () => ({ query: mocks.query }) }),
  applyRLSGucs: vi.fn(),
  rollbackAndRelease: mocks.rollback,
}))
vi.mock('../../application-platform/native-reader.js', () => ({
  runCanonicalNativeQueryFrame: (_context: unknown, operation: () => unknown) => operation(),
  readCanonicalNativeQueryDefinition: async () => ({}),
  captureCanonicalNativeQueryCandidates: mocks.capture,
}))
vi.mock('../crm-reader.js', () => ({ nativeQueryDataCeiling: () => ({ typeKey: 'task' }) }))
vi.mock('../derived-scope-store.js', () => ({ readCurrentScopeSources: async () => [] }))
vi.mock('../../application-platform/execution-context.js', () => ({ currentApplicationReadTransaction: () => undefined }))
vi.mock('../../application-platform/public-share-context.js', () => ({ currentCanonicalPublicShare: () => undefined }))
vi.mock('../../application-platform/field-evidence.js', () => ({}))

import { listLegacyCanonicalTasks } from '../task-reader.js'

const access = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  assistantId: '', assistantKind: 'primary' as const,
}

describe('[COMP:api/application-records] task reader transaction errors', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.query.mockResolvedValue({ rows: [] })
    mocks.capture.mockResolvedValue([])
  })

  it('preserves the admission refusal when restoring a selector hits an aborted transaction', async () => {
    let aborted = false
    mocks.capture.mockImplementation(async () => {
      aborted = true
      throw Object.assign(new Error('query_domain_unavailable'), { code: '42501' })
    })
    mocks.query.mockImplementation(async () => {
      if (aborted) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' })
      return { rows: [] }
    })
    await expect(listLegacyCanonicalTasks(access, {})).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(mocks.rollback).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
  })

  it('does not turn a selector restoration failure after a successful capture into success', async () => {
    const failure = new Error('connection lost while restoring selector')
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("set_config('app.native_query_data_ceilings'") && params?.[0] === '') throw failure
      return { rows: [] }
    })
    await expect(listLegacyCanonicalTasks(access, {})).rejects.toBe(failure)
    expect(mocks.rollback).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
  })
})
