import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectHarnessCandidateBoundarySql, projectHarnessSuccessorFiles } from '../../src/migrations/project-harness-candidate-boundary.js'
const mock = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn() }))
vi.mock('pg', () => ({ default: { Client: class { query = mock.query; connect = mock.connect; end = mock.end } } }))
vi.mock('../migration-diagnostics.js', () => ({ MigrationDiagnostics: class {
  start() {} finish() { return 0 } fail() {} async stop() {}
} }))
vi.mock('../migration-recovery.js', () => ({ nativePageCompletionRecoverySql: async () => 'SELECT 123 /* recovery */' }))
import { runMigrations } from '../migrate.js'
const files = await readdir(new URL('../../migrations/', import.meta.url))
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  mock.connect.mockResolvedValue(undefined)
  mock.end.mockResolvedValue(undefined)
  mock.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_backend_pid()')) return { rows: [{ pid: 1 }] }
    if (sql === 'SELECT name FROM public._migrations ORDER BY name') return { rows: files.filter(f => f.endsWith('.sql') && !(projectHarnessSuccessorFiles as readonly string[]).includes(f)).map(name => ({ name })) }
    return { rows: [] }
  })
})
afterEach(() => { vi.restoreAllMocks() })
const run = () => runMigrations({ databaseUrl: 'postgres://synthetic.invalid/never-connects' })
describe('[COMP:api/harness-migration-upgrade] actual native runner receipt/refusal ordering (no connection)', () => {
  it('refuses before recovery, ledger creation, aliases and callbacks', async () => {
    const beforeApply = vi.fn()
    mock.query.mockImplementation(async (sql: string) => {
      if (sql === projectHarnessCandidateBoundarySql) throw Error('project_harness_candidate_upgrade_unsupported')
      return { rows: [{ pid: 1 }] }
    })
    await expect(runMigrations({ databaseUrl: 'synthetic', beforeApply })).rejects.toThrow('project_harness_candidate_upgrade_unsupported')
    const queries = mock.query.mock.calls.map(([sql]) => sql)
    expect(queries.at(-1)).toBe(projectHarnessCandidateBoundarySql)
    expect(queries.join('\n')).not.toContain('CREATE TABLE')
    expect(queries.join('\n')).not.toContain('/* recovery */')
    expect(beforeApply).not.toHaveBeenCalled()
    expect(mock.end).toHaveBeenCalledOnce()
  })
  it('applies each exact successor and ledger row in one transaction', async () => {
    expect(await run()).toMatchObject({ appliedCount: 3 })
    const calls = mock.query.mock.calls
    for (const file of projectHarnessSuccessorFiles) {
      const index = calls.findIndex(([sql, values]) => sql === 'INSERT INTO public._migrations (name) VALUES ($1)' && values[0] === file)
      expect(index).toBeGreaterThan(1)
      expect(calls[index - 2][0]).toBe('BEGIN')
      expect(calls[index - 1][0]).not.toMatch(/^BEGIN;|^COMMIT;/m)
      expect(calls[index + 1][0]).toBe('COMMIT')
    }
  })
  it('a lost commit acknowledgment resumes only from the committed receipts', async () => {
    const base = mock.query.getMockImplementation()!
    let lost = false
    mock.query.mockImplementation(async (sql: string, ...args: unknown[]) => {
      if (sql === 'COMMIT' && !lost) { lost = true; throw Error('synthetic lost acknowledgment') }
      return base(sql, ...args)
    })
    await expect(run()).rejects.toThrow('synthetic lost acknowledgment')
    mock.query.mockClear()
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_backend_pid()')) return { rows: [{ pid: 1 }] }
      if (sql === 'SELECT name FROM public._migrations ORDER BY name') return { rows: files.filter(f => f.endsWith('.sql') && f !== projectHarnessSuccessorFiles[1] && f !== projectHarnessSuccessorFiles[2]).map(name => ({ name })) }
      return { rows: [] }
    })
    expect(await run()).toMatchObject({ appliedCount: 2 })
    const inserts = mock.query.mock.calls.filter(([sql]) => sql === 'INSERT INTO public._migrations (name) VALUES ($1)').map(([,values]) => values[0])
    expect(inserts).toEqual(projectHarnessSuccessorFiles.slice(1))
  })
  it('does not commit SQL if its ledger insertion fails', async () => {
    const base = mock.query.getMockImplementation()!
    mock.query.mockImplementation(async (sql: string, ...args: unknown[]) => {
      if (sql === 'INSERT INTO public._migrations (name) VALUES ($1)') throw Error('synthetic ledger failure')
      return base(sql, ...args)
    })
    await expect(run()).rejects.toThrow('synthetic ledger failure')
    expect(mock.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
    expect(mock.end).toHaveBeenCalledOnce() // connection close rolls back the uncommitted SQL
  })
})
