import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }))
vi.mock('pg', () => ({ default: { Client: class {
  connect = db.connect
  query = db.query
  end = db.end
} } }))
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  readdir: vi.fn().mockResolvedValue([]),
}))

import { nativePageCompletionRecoverySql } from '../migration-recovery.js'
import { runMigrations } from '../migrate.js'

describe('[COMP:api/migration-recovery] serialized migration recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.query.mockResolvedValue({ rows: [] })
  })

  it('waits for the migration lock before reading or recovering the ledger', async () => {
    let release!: () => void
    db.query.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const running = runMigrations({ databaseUrl: 'postgresql://fixture@localhost/fixture' })
    await vi.waitFor(() => expect(db.query).toHaveBeenCalledTimes(1))
    expect(db.query.mock.calls[0][0]).toContain("pg_advisory_lock(hashtextextended('use-brian:migrations', 0))")
    release()
    await running
    const calls = db.query.mock.calls.map(([sql]) => String(sql))
    const recovery = calls.findIndex(sql => sql.startsWith('DO $recover_page_completion$'))
    const ledger = calls.indexOf('SELECT name FROM public._migrations ORDER BY name')
    expect(recovery).toBeGreaterThan(0)
    expect(ledger).toBeGreaterThan(recovery)
    expect(db.end).toHaveBeenCalledOnce()
  })

  it('closes the lock-owning session and never continues after failed authentication', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DO $recover_page_completion$')) throw new Error('canonical successor changed')
      return { rows: [] }
    })
    await expect(runMigrations({ databaseUrl: 'postgresql://fixture@localhost/fixture' })).rejects.toThrow('canonical successor changed')
    expect(db.end).toHaveBeenCalledOnce()
    expect(db.query.mock.calls.some(([sql]) => sql === 'SELECT name FROM public._migrations ORDER BY name')).toBe(false)
  })

  it('uses all five immutable successor authentication blocks without successor installation', async () => {
    const sql = await nativePageCompletionRecoverySql()
    for (const block of ['canonical', 'publication_tables', 'reader_manifest', 'native_legacy_shape', 'bridge']) {
      expect(sql).toContain(`DO $${block}$`)
      expect(sql).toContain(`END $${block}$;`)
    }
    expect(sql).not.toContain('CREATE TEMP TABLE pg_temp.native_cohort_originals')
    expect(sql).not.toContain('CREATE FUNCTION public.native_turn_capture_publication_cohorts')
  })
})
