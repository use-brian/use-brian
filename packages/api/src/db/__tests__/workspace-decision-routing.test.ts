import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { query, queryWithRLS } from '../client.js'
import { createWorkspaceDecisionRoutingStore } from '../workspace-decision-routing.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const store = createWorkspaceDecisionRoutingStore()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:decisions/workspace-routing] workspace decision routing store', () => {
  it('reads runtime policy through the system query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      workspace_id: 'workspace-fictional',
      mode: 'shadow',
      model_alias: 'typesafe-jev-1.13',
      updated_at: '2026-09-28T00:00:00.000Z',
    }] } as never)

    await expect(store.getSystem('workspace-fictional')).resolves.toMatchObject({
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
    })
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('workspace_decision_routing'), ['workspace-fictional'])
  })

  it('persists an active decision model through the member-scoped connection', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{
      workspace_id: 'workspace-fictional',
      mode: 'shadow',
      model_alias: 'typesafe-jev-1.13',
      updated_at: '2026-09-28T00:00:00.000Z',
    }] } as never)

    await store.set({
      actingUserId: 'user-fictional',
      workspaceId: 'workspace-fictional',
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
    })

    expect(mockQueryWithRLS).toHaveBeenCalledWith(
      'user-fictional',
      expect.stringContaining('ON CONFLICT (workspace_id)'),
      ['workspace-fictional', 'shadow', 'typesafe-jev-1.13', 'user-fictional', 0.1],
    )
  })

  it('persists a hybrid preference for an active decision model', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{
      workspace_id: 'workspace-fictional',
      mode: 'hybrid',
      model_alias: 'typesafe-jev-1.13',
      updated_at: '2026-09-28T00:00:00.000Z',
    }] } as never)

    await store.set({
      actingUserId: 'user-fictional',
      workspaceId: 'workspace-fictional',
      mode: 'hybrid',
      modelAlias: 'typesafe-jev-1.13',
    })

    expect(mockQueryWithRLS).toHaveBeenCalledWith(
      'user-fictional',
      expect.any(String),
      ['workspace-fictional', 'hybrid', 'typesafe-jev-1.13', 'user-fictional', 0.1],
    )
  })

  it('rejects chat models before touching the database', async () => {
    await expect(store.set({
      actingUserId: 'user-fictional',
      workspaceId: 'workspace-fictional',
      mode: 'shadow',
      modelAlias: 'gemini-3-flash-standard',
    })).rejects.toThrow('not an active decision model')
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })
})

describe('shadow sampling persistence', () => {
  it.each(['typesafe-jev-1.13', 'openai-decisions-gpt-6-luna'])('writes and reads both rates for %s', async modelAlias => {
    for (const rate of [undefined, 0.1, 1] as const) {
      const row = { workspace_id: 'w', mode: 'shadow', model_alias: modelAlias, shadow_sample_rate: rate ?? 0.1, updated_at: 'now' }
      mockQueryWithRLS.mockResolvedValue({ rows: [row] } as never)
      mockQuery.mockResolvedValue({ rows: [row] } as never)
      const written = await store.set({ actingUserId: 'u', workspaceId: 'w', mode: 'shadow', modelAlias, shadowSampleRate: rate })
      expect(written.shadowSampleRate).toBe(rate ?? 0.1)
      expect(mockQueryWithRLS).toHaveBeenLastCalledWith('u', expect.stringContaining('shadow_sample_rate = EXCLUDED.shadow_sample_rate'), ['w', 'shadow', modelAlias, 'u', rate ?? 0.1])
      expect(await store.get({ actingUserId: 'u', workspaceId: 'w' })).toEqual(written)
      expect(await store.getSystem('w')).toEqual(written)
    }
  })

  it.each(['llm_only', 'hybrid'] as const)('resets rate for %s writes', async mode => {
    mockQueryWithRLS.mockResolvedValue({ rows: [{ workspace_id: 'w', mode, model_alias: null, shadow_sample_rate: 0.1, updated_at: 'now' }] } as never)
    await store.set({ actingUserId: 'u', workspaceId: 'w', mode, modelAlias: mode === 'llm_only' ? null : 'typesafe-jev-1.13', shadowSampleRate: 1 })
    expect(mockQueryWithRLS).toHaveBeenLastCalledWith('u', expect.any(String), ['w', mode, mode === 'llm_only' ? null : 'typesafe-jev-1.13', 'u', 0.1])
  })

  it.each([0, 0.5, 100, NaN, null, '1'])('rejects invalid rate %j before writing', async rate => {
    await expect(store.set({ actingUserId: 'u', workspaceId: 'w', mode: 'shadow', modelAlias: 'typesafe-jev-1.13', shadowSampleRate: rate as 1 })).rejects.toThrow('invalid shadow sample rate')
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })
})

it('migrates existing settings to 10% and enforces the persisted rate constraint', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { readFile } = await import('node:fs/promises')
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE workspace_decision_routing (workspace_id TEXT PRIMARY KEY);
      INSERT INTO workspace_decision_routing VALUES ('existing');`)
    await db.exec(await readFile(new URL('../../../migrations/8259_workspace_decision_shadow_sampling.sql', import.meta.url), 'utf8'))
    expect((await db.query('SELECT shadow_sample_rate FROM workspace_decision_routing')).rows)
      .toEqual([{ shadow_sample_rate: 0.1 }])
    await db.exec("INSERT INTO workspace_decision_routing (workspace_id) VALUES ('new')")
    for (const rate of [0.1, 1]) {
      await db.query('UPDATE workspace_decision_routing SET shadow_sample_rate = $1 WHERE workspace_id = $2', [rate, 'existing'])
      expect((await db.query("SELECT shadow_sample_rate FROM workspace_decision_routing WHERE workspace_id = 'existing'")).rows)
        .toEqual([{ shadow_sample_rate: rate }])
    }
    for (const rate of [0, 0.5, 10, 100, null]) {
      await expect(db.query('UPDATE workspace_decision_routing SET shadow_sample_rate = $1', [rate])).rejects.toThrow()
    }
    expect((await db.query("SELECT shadow_sample_rate FROM workspace_decision_routing WHERE workspace_id = 'new'")).rows)
      .toEqual([{ shadow_sample_rate: 0.1 }])
  } finally {
    await db.close()
  }
}, 30_000)

it.each(['typesafe-jev-1.13', 'openai-decisions-gpt-6-luna'])('persists classifier-first %s with the acting user audit', async modelAlias => {
  const row = { workspace_id: 'w', mode: 'classifier_first', model_alias: modelAlias, shadow_sample_rate: 0.1, updated_at: 'now' }
  mockQueryWithRLS.mockResolvedValue({ rows: [row] } as never)
  mockQuery.mockResolvedValue({ rows: [row] } as never)
  const setting = await store.set({ actingUserId: 'admin', workspaceId: 'w', mode: 'classifier_first', modelAlias })
  expect(mockQueryWithRLS).toHaveBeenLastCalledWith('admin', expect.stringContaining('updated_by_user_id = EXCLUDED.updated_by_user_id'), ['w', 'classifier_first', modelAlias, 'admin', 0.1])
  expect(setting.mode).toBe('classifier_first')
  expect(await store.getSystem('w')).toEqual(setting)
  expect(await store.get({ actingUserId: 'admin', workspaceId: 'w' })).toEqual(setting)
})

it('extends the 605 named constraints without changing existing settings', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { readFile } = await import('node:fs/promises')
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE workspace_decision_routing (
      mode TEXT NOT NULL CONSTRAINT workspace_decision_routing_mode_check CHECK (mode IN ('llm_only', 'shadow', 'hybrid')),
      model_alias TEXT,
      CONSTRAINT workspace_decision_routing_target_check CHECK ((mode = 'llm_only' AND model_alias IS NULL) OR (mode IN ('shadow', 'hybrid') AND model_alias IS NOT NULL)));
      INSERT INTO workspace_decision_routing VALUES ('llm_only', NULL), ('shadow', 'jev'), ('hybrid', 'jev');`)
    await db.exec(await readFile(new URL('../../../migrations/8260_workspace_decision_classifier_first.sql', import.meta.url), 'utf8'))
    expect((await db.query('SELECT * FROM workspace_decision_routing')).rows).toHaveLength(3)
    await db.exec("INSERT INTO workspace_decision_routing VALUES ('classifier_first', 'jev')")
    for (const [mode, alias] of [['classifier_first', null], ['hybrid', null], ['shadow', null], ['llm_only', 'jev'], ['invalid', 'jev']]) {
      await expect(db.query('INSERT INTO workspace_decision_routing VALUES ($1, $2)', [mode, alias])).rejects.toThrow()
    }
  } finally { await db.close() }
}, 30_000)
