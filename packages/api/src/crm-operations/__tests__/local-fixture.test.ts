import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { validateAmbientDatabase, cleanRuntimeEnvironment, fixtureCommandEnvironment, assertLocalFixture, loadMigrationEnvironment, parseLocalFixtureArguments, createLocalFixture } = await import(script)

describe('[COMP:crm/assurance-fixture] Disposable database safety', () => {
  it('uses the canonical runtime by default and accepts its explicit selection', () => {
    const command=['node','fictional-case.mjs','--flag']
    expect(parseLocalFixtureArguments(['--',...command])).toMatchObject({runtimeRole:'app_user',command})
    expect(parseLocalFixtureArguments(['--pg-bin','/fictional/pg18','--runtime-role','app_user','--migration-dir','/fictional/overlay','--',...command])).toEqual({pgBin:'/fictional/pg18',runtimeRole:'app_user',migrationDirs:['/fictional/overlay'],walArchive:false,ordinaryOwner:true,statementStatistics:false,command})
    expect(parseLocalFixtureArguments(['--ordinary-owner','--',...command])).toMatchObject({ordinaryOwner:true,runtimeRole:'app_user',command})
  })
  it('keeps statement statistics off unless explicitly selected and forwards the marker only from the fixture', async () => {
    const command=['node','fictional-case.mjs','--statement-statistics']
    // Off by default; an option after `--` belongs to the command, not the launcher.
    expect(parseLocalFixtureArguments(['--',...command])).toMatchObject({statementStatistics:false,command})
    expect(parseLocalFixtureArguments(['--statement-statistics','--pg-bin','/fictional/pg18','--',...command])).toEqual({pgBin:'/fictional/pg18',runtimeRole:'app_user',migrationDirs:[],walArchive:false,ordinaryOwner:true,statementStatistics:true,command})
    await expect(createLocalFixture({ env: {}, statementStatistics: 'true' })).rejects.toThrow('Invalid statement statistics profile')
    // A caller cannot claim the profile: only the fixture's own environment carries the marker.
    expect(fixtureCommandEnvironment({ BRIAN_ASSURANCE_STATEMENT_STATS: 'true', BRIAN_CHAT_COST_OUTPUT: '/tmp/fictional.json' }, { PGPORT: '54329' }))
      .toEqual({ BRIAN_CHAT_COST_OUTPUT: '/tmp/fictional.json', PGPORT: '54329' })
    expect(fixtureCommandEnvironment({}, { PGPORT: '54329', BRIAN_ASSURANCE_STATEMENT_STATS: 'true' }))
      .toEqual({ PGPORT: '54329', BRIAN_ASSURANCE_STATEMENT_STATS: 'true' })
  })
  it('refuses a superuser-owned fixture before creating a cluster, because 8274 admits only an ordinary owner', async () => {
    await expect(createLocalFixture({ env: {}, ordinaryOwner: false })).rejects.toThrow('Superuser-owned fixtures cannot apply migration 8274')
  })
  it('rejects arbitrary or missing role selection before fixture creation', () => {
    for (const role of ['assurance_app','admin_fixture_app','owner','app_user; SET ROLE owner','other_runtime']) expect(() => parseLocalFixtureArguments(['--runtime-role',role,'--','node','fictional-case.mjs'])).toThrow('Unsupported fixture runtime role')
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
    await writeFile(marker, JSON.stringify({ token: 'synthetic-token', port: 54329, database: 'brian_assurance' }))
    const env = { BRIAN_ASSURANCE_FIXTURE: marker, BRIAN_ASSURANCE_TOKEN: 'synthetic-token',
      DATABASE_URL: 'postgresql://owner:synthetic@127.0.0.1:54329/brian_assurance',
      DATABASE_URL_APP: 'postgresql://app:synthetic@127.0.0.1:54329/brian_assurance' }
    try {
      const load = vi.fn()
      await expect(loadMigrationEnvironment(load, env)).resolves.toBe('fixture')
      expect(load).not.toHaveBeenCalled()
      const baseMarker={token:'synthetic-token',port:54329,database:'brian_assurance'}
      await writeFile(marker,JSON.stringify({...baseMarker,bootstrapRole:'unreviewed-role'}))
      await expect(loadMigrationEnvironment(load,env)).rejects.toThrow('Unsupported fixture bootstrap role')
      await writeFile(marker,JSON.stringify({...baseMarker,bootstrapRole:'assurance_bootstrap'}))
      await expect(loadMigrationEnvironment(load,env)).resolves.toBe('fixture')
      await writeFile(marker,JSON.stringify(baseMarker))
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
      await writeFile(marker, JSON.stringify({ token: 'synthetic-token', port: 54329, database: 'brian_assurance_abc123' }))
      await expect(loadMigrationEnvironment(load, env)).rejects.toThrow('outside the owned fixture')
      const clone = { ...env,
        DATABASE_URL: env.DATABASE_URL.replace('/brian_assurance', '/brian_assurance_abc123'),
        DATABASE_URL_APP: env.DATABASE_URL_APP.replace('/brian_assurance', '/brian_assurance_abc123') }
      await expect(loadMigrationEnvironment(load, clone)).resolves.toBe('fixture')
      await expect(loadMigrationEnvironment(load, { ...clone,
        DATABASE_URL_APP: clone.DATABASE_URL_APP.replace('abc123', 'def456') })).rejects.toThrow('outside the owned fixture')
    } finally { await rm(directory, { recursive: true }) }
  })
})
