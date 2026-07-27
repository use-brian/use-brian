import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({
  query: mocks.query,
  getPool: () => ({ connect: mocks.connect }),
}))

import { createSupportDiagnosticsStore, SupportDiagnosticConflictError } from '../store.js'

describe('[COMP:api/support-diagnostics] support diagnostics store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts one capture transactionally and returns its current event count', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'capture-1',
          userId: 'user-1',
          workspaceId: 'workspace-1',
          includeContent: false,
          pseudonymSalt: Buffer.alloc(32),
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          eventCount: '0',
        }],
      })

    const store = createSupportDiagnosticsStore()
    const result = await store.start({
      id: 'capture-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      includeContent: false,
      pseudonymSalt: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(result.id).toBe('capture-1')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  it('maps the installation-wide unique constraint to a conflict', async () => {
    const conflict = Object.assign(new Error('duplicate'), { code: '23505' })
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO support_diagnostic_sessions')) throw conflict
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const store = createSupportDiagnosticsStore()

    await expect(store.start({
      id: 'capture-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      includeContent: false,
      pseudonymSalt: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toBeInstanceOf(SupportDiagnosticConflictError)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})
