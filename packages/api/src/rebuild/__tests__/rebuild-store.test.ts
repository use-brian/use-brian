/**
 * Rebuild store - the atomic promote (capture -> delete live derived ->
 * move shadow in -> stamp promoted, ONE transaction; failure rolls back
 * and the live brain is untouched), the confirm gate, and cancel safety.
 *
 * Spec: docs/architecture/brain/retroactive-rebuild.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({
  client: [] as string[],
  clientResults: [] as Array<{ rows: unknown[]; rowCount?: number }>,
  captures: [] as Array<{ ids: string[]; opts: Record<string, unknown>; inTx: boolean }>,
  failOn: null as string | null,
}))

const RUN_ROW = {
  id: 'run-1',
  workspace_id: 'ws1',
  status: 'derived',
  target_pipeline_version: 2,
  probe: {},
  progress: {},
  diff: null,
  error: null,
  confirmed_at: null,
  derived_at: null,
  promoted_at: null,
  created_at: new Date(),
}

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getPool: vi.fn(() => ({
    connect: async () => ({
      query: async (text: string, _v?: unknown[]) => {
        calls.client.push(text)
        if (calls.failOn && text.includes(calls.failOn)) throw new Error(`boom on ${calls.failOn}`)
        if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) return { rows: [] }
        return calls.clientResults.shift() ?? { rows: [], rowCount: 0 }
      },
      release: () => {},
    }),
  })),
}))

vi.mock('../../db/brain-row-versions.js', () => ({
  captureMemoryVersions: vi.fn(async (ids: string[], opts: Record<string, unknown>, client?: unknown) => {
    calls.captures.push({ ids, opts, inTx: client != null })
    return ids.length
  }),
}))

import { promoteRebuildRun } from '../rebuild-store.js'

beforeEach(() => {
  calls.client.length = 0
  calls.clientResults.length = 0
  calls.captures.length = 0
  calls.failOn = null
})

function seedHappyPromote() {
  calls.clientResults.push({ rows: [RUN_ROW] }) // SELECT run FOR UPDATE
  calls.clientResults.push({ rows: [{ id: 'live-1' }, { id: 'live-2' }] }) // live derived ids
  calls.clientResults.push({ rows: [], rowCount: 2 }) // DELETE live
  calls.clientResults.push({ rows: [{ column_name: 'id' }, { column_name: 'summary' }, { column_name: 'pipeline_version' }] }) // shared columns
  calls.clientResults.push({ rows: [], rowCount: 3 }) // INSERT from shadow
  calls.clientResults.push({ rows: [], rowCount: 3 }) // DELETE shadow
  calls.clientResults.push({ rows: [{ ...RUN_ROW, status: 'promoted', promoted_at: new Date() }] }) // UPDATE run
}

describe('[COMP:api/rebuild-store] atomic promote', () => {
  it('runs capture -> delete live -> move shadow -> stamp, inside one transaction', async () => {
    seedHappyPromote()
    const run = await promoteRebuildRun('run-1')
    expect(run?.status).toBe('promoted')

    expect(calls.client[0]).toBe('BEGIN')
    expect(calls.client[calls.client.length - 1]).toBe('COMMIT')
    // Capture used the SAME transaction client and the rebuild attribution.
    expect(calls.captures).toEqual([
      {
        ids: ['live-1', 'live-2'],
        opts: { actor: 'human_edit', reason: 'rebuild-promote', workspaceId: 'ws1' },
        inTx: true,
      },
    ])
    // Order: delete live BEFORE inserting shadow, both before COMMIT.
    const del = calls.client.findIndex((t) => t.includes('DELETE FROM memories WHERE workspace_id'))
    const ins = calls.client.findIndex((t) => t.includes('INSERT INTO memories'))
    const shadowDel = calls.client.findIndex((t) => t.includes('DELETE FROM memories_shadow'))
    expect(del).toBeGreaterThan(0)
    expect(ins).toBeGreaterThan(del)
    expect(shadowDel).toBeGreaterThan(ins)
    // The INSERT..SELECT column list is catalog-derived and excludes the run key.
    const insertSql = calls.client[ins]
    expect(insertSql).toContain('"id", "summary", "pipeline_version"')
    expect(insertSql).not.toContain('rebuild_run_id"')
  })

  it('rolls the whole transaction back when the shadow move fails - live brain untouched', async () => {
    seedHappyPromote()
    calls.failOn = 'INSERT INTO memories'
    await expect(promoteRebuildRun('run-1')).rejects.toThrow('boom')
    expect(calls.client).toContain('ROLLBACK')
    expect(calls.client).not.toContain('COMMIT')
  })

  it('refuses a run that is not derived', async () => {
    calls.clientResults.push({ rows: [{ ...RUN_ROW, status: 'confirmed' }] })
    const run = await promoteRebuildRun('run-1')
    expect(run).toBeNull()
    expect(calls.client).toContain('ROLLBACK')
    expect(calls.captures).toEqual([])
  })
})
