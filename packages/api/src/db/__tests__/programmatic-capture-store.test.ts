import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

// Configuration writes run in an admitted transaction (captureWrite). Its
// control and admission statements answer as a legacy workspace; every other
// statement is recorded on queryWithRLS so the SQL-shape assertions see it.
const txClient = vi.hoisted(() => ({
  query: async (sql: string, params?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('FOR UPDATE') || sql.includes('set_config(')) return { rows: [] }
    if (sql.includes("current_setting('app.system_bypass'")) return { rows: [{ value: null }] }
    if (sql.includes('FROM workspace_access_policies')) return { rows: [] }
    return db.queryWithRLS('tx', sql, params)
  },
  release: () => {},
}))
vi.mock('../client.js', () => ({
  query: db.query,
  queryWithRLS: db.queryWithRLS,
  getAppPool: () => ({ connect: async () => txClient }),
  applyRLSGucs: async () => {},
}))

import { createProgrammaticCaptureStore } from '../programmatic-capture-store.js'

describe('[COMP:api/programmatic-capture] store queries', () => {
  beforeEach(() => vi.resetAllMocks())

  it('qualifies rule projections in profile joins and update returning clauses', async () => {
    db.queryWithRLS.mockResolvedValue({ rows: [] })
    const store = createProgrammaticCaptureStore()
    await expect(store.listProfiles('user', 'workspace')).resolves.toEqual([])
    await expect(store.updateRule({
      actingUserId: 'user', workspaceId: 'workspace', profileId: 'profile', ruleId: 'rule',
      rule: { filterType: 'always', routingMode: 'drop' },
    })).resolves.toBeNull()

    const joinedQueries = db.queryWithRLS.mock.calls
      .map(([, sql]) => sql as string)
      .filter((sql) => /(?:JOIN|FROM) programmatic_capture_profiles p/.test(sql))
    expect(joinedQueries).toHaveLength(2)
    for (const sql of joinedQueries) {
      const projection = sql.includes('RETURNING')
        ? sql.split('RETURNING')[1]!
        : sql.split('SELECT')[1]!.split('FROM')[0]!
      expect(projection.trim()).toMatch(/^r\.id,/)
      expect(projection.trim().split(/,\s*/).every((column) => column.startsWith('r.'))).toBe(true)
    }
  })

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
