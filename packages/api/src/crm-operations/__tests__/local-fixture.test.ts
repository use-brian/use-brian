import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { validateAmbientDatabase, cleanRuntimeEnvironment, assertLocalFixture, loadMigrationEnvironment, parseLocalFixtureArguments } = await import(script)

describe('[COMP:crm/assurance-fixture] Disposable database safety', () => {
  it('binds an explicit production role selection to the maintained fixture command without changing the default', () => {
    const command=['node','fictional-case.mjs','--flag']
    expect(parseLocalFixtureArguments(['--',...command])).toMatchObject({runtimeRole:'assurance_app',command})
    expect(parseLocalFixtureArguments(['--pg-bin','/fictional/pg18','--runtime-role','app_user','--migration-dir','/fictional/overlay','--',...command])).toEqual({pgBin:'/fictional/pg18',runtimeRole:'app_user',migrationDirs:['/fictional/overlay'],walArchive:false,command})
  })
  it('rejects arbitrary or missing role selection before fixture creation', () => {
    for (const role of ['owner','app_user; SET ROLE owner','other_runtime']) expect(() => parseLocalFixtureArguments(['--runtime-role',role,'--','node','fictional-case.mjs'])).toThrow('Unsupported fixture runtime role')
    expect(() => parseLocalFixtureArguments(['--runtime-role'])).toThrow('Missing value')
    expect(() => parseLocalFixtureArguments(['--runtime-role','app_user'])).toThrow('Supply an explicit test command')
  })

  it('refuses remote databases, socket overrides and libpq services before starting', () => {
    for (const value of ['postgresql://db.example/brain', 'postgres:///brain',
      'postgresql://127.0.0.1/brain?host=db.example', 'postgresql://localhost/brain?service=live', 'bad']) {
      expect(() => validateAmbientDatabase({ DATABASE_URL: value })).toThrow(/Unset DATABASE_URL/)
    }
    expect(() => validateAmbientDatabase({ DATABASE_URL_APP: 'postgresql://db.example/brain' })).toThrow()
    expect(() => validateAmbientDatabase({ DATABASE_URL: 'postgresql://127.0.0.1/unused' })).not.toThrow()
    expect(() => validateAmbientDatabase({})).not.toThrow()
  })

  it('does not propagate provider secrets, libpq switches or migration targets', () => {
    expect(cleanRuntimeEnvironment({ PATH: '/bin', HOME: '/tmp/fictional', DATABASE_URL: 'secret',
      PGHOST: 'db.example', PGOPTIONS: '-c role=admin', GOOGLE_API_KEY: 'secret',
      MIGRATION_DIRS: '/somewhere' })).toEqual({ PATH: '/bin', HOME: '/tmp/fictional' })
  })

  it('refuses integration tests outside an owned fixture', async () => {
    await expect(assertLocalFixture({ DATABASE_URL: 'postgresql://localhost/brain' }))
      .rejects.toThrow('Run this suite through')
  })

  it('retains ordinary migrator environment loading without a fixture marker', async () => {
    const load = vi.fn()
    await expect(loadMigrationEnvironment(load, {})).resolves.toBe('workspace')
    expect(load).toHaveBeenCalledOnce()
  })

  it('skips workspace loading only after validating both fixture database URLs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fixture-environment-test-'))
    const marker = join(directory, 'marker.json')
    await writeFile(marker, JSON.stringify({ token: 'synthetic-token', port: 54329 }))
    const env = { BRIAN_ASSURANCE_FIXTURE: marker, BRIAN_ASSURANCE_TOKEN: 'synthetic-token',
      DATABASE_URL: 'postgresql://owner:synthetic@127.0.0.1:54329/brian_assurance',
      DATABASE_URL_APP: 'postgresql://app:synthetic@127.0.0.1:54329/brian_assurance' }
    try {
      const load = vi.fn()
      await expect(loadMigrationEnvironment(load, env)).resolves.toBe('fixture')
      expect(load).not.toHaveBeenCalled()
      for (const altered of [
        { ...env, BRIAN_ASSURANCE_TOKEN: 'wrong-token' },
        { ...env, DATABASE_URL: 'postgresql://db.example:54329/brian_assurance' },
        { ...env, DATABASE_URL_APP: 'postgresql://127.0.0.1:54330/brian_assurance' },
        { ...env, DATABASE_URL_APP: 'postgresql://127.0.0.1:54329/other_database' },
        { BRIAN_ASSURANCE_FIXTURE: marker }, { BRIAN_ASSURANCE_TOKEN: 'partial' },
      ]) {
        await expect(loadMigrationEnvironment(load, altered)).rejects.toThrow()
        expect(load).not.toHaveBeenCalled()
      }
    } finally { await rm(directory, { recursive: true }) }
  })
})
