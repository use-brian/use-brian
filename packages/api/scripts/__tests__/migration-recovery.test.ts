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
    db.connect.mockResolvedValue(undefined)
    db.end.mockResolvedValue(undefined)
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('pg_backend_pid()') ? [{ pid: 123 }] : [] }))
  })

  it('waits for the migration lock before reading or recovering the ledger', async () => {
    let release!: () => void
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_lock')) await new Promise<void>(resolve => { release = resolve })
      return { rows: sql.includes('pg_backend_pid()') ? [{ pid: 123 }] : [] }
    })
    const running = runMigrations({ databaseUrl: 'postgresql://fixture@localhost/fixture' })
    await vi.waitFor(() => expect(db.query).toHaveBeenCalledTimes(2))
    expect(db.query.mock.calls[1][0]).toContain("pg_advisory_lock(hashtextextended('use-brian:migrations', 0))")
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('_migrations'))).toBe(false)
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
      return { rows: sql.includes('pg_backend_pid()') ? [{ pid: 123 }] : [] }
    })
    await expect(runMigrations({ databaseUrl: 'postgresql://fixture@localhost/fixture' })).rejects.toThrow('canonical successor changed')
    expect(db.end).toHaveBeenCalledOnce()
    expect(db.query.mock.calls.some(([sql]) => sql === 'SELECT name FROM public._migrations ORDER BY name')).toBe(false)
  })

  it('preserves the original database error if connection cleanup also fails', async () => {
    const original = Object.assign(new Error('canonical successor changed'), { code: '55000' })
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DO $recover_page_completion$')) throw original
      return { rows: sql.includes('pg_backend_pid()') ? [{ pid: 123 }] : [] }
    })
    db.end.mockRejectedValueOnce(new Error('connection cleanup failed'))
    await expect(runMigrations({ databaseUrl: 'postgresql://fixture@localhost/fixture' })).rejects.toBe(original)
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
