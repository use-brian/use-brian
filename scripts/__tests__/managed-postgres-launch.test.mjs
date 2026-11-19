import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MANAGED_POSTGRES_QUALIFIED_PLATFORMS,
  applyManagedDatabaseEnv,
  isLibpqEnvironmentKey,
  managedServerEnvironment,
  resolveLocalDatabaseSelection,
} from '../managed-postgres-launch.mjs'

const mac = { platform: 'darwin', arch: 'arm64' }
const artifact = '/Applications/Use Brian.app/Contents/Resources/managed-postgres'
const managed = { USEBRIAN_LOCAL_DATABASE: 'managed-postgres', USEBRIAN_MANAGED_POSTGRES_ARTIFACT: artifact }

describe('[COMP:platform/managed-postgres-launch] Local database selection', () => {
  it('keeps the embedded default and the external escape hatch unchanged', () => {
    assert.deepEqual(resolveLocalDatabaseSelection({}, mac), { kind: 'embedded' })
    assert.deepEqual(resolveLocalDatabaseSelection({ USEBRIAN_LOCAL_DATABASE: 'embedded' }, mac), { kind: 'embedded' })
    assert.deepEqual(resolveLocalDatabaseSelection({ DATABASE_URL: 'postgres://u@db/x' }, mac), { kind: 'external' })
    assert.deepEqual(resolveLocalDatabaseSelection({ DATABASE_URL: 'postgres://u@db/x', USEBRIAN_LOCAL_DATABASE: 'embedded' }, mac), { kind: 'external' })
  })

  it('selects the managed branch only when explicitly chosen with an absolute artifact path', () => {
    assert.deepEqual(resolveLocalDatabaseSelection(managed, mac), { kind: 'managed-postgres', artifactDirectory: artifact, transfer: false })
    assert.throws(() => resolveLocalDatabaseSelection({ USEBRIAN_LOCAL_DATABASE: 'managed-postgres' }, mac), /USEBRIAN_MANAGED_POSTGRES_ARTIFACT/)
    assert.throws(() => resolveLocalDatabaseSelection({ ...managed, USEBRIAN_MANAGED_POSTGRES_ARTIFACT: 'relative/path' }, mac), /absolute path/)
  })

  it('transfers an existing brain only when both the managed branch and the transfer are chosen', () => {
    assert.deepEqual(resolveLocalDatabaseSelection({ ...managed, USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' }, mac), { kind: 'managed-postgres', artifactDirectory: artifact, transfer: true })
    assert.deepEqual(resolveLocalDatabaseSelection({ ...managed, USEBRIAN_MANAGED_POSTGRES_TRANSFER: '0' }, mac), { kind: 'managed-postgres', artifactDirectory: artifact, transfer: false })
    // The transfer flag alone never leaves the embedded default.
    assert.deepEqual(resolveLocalDatabaseSelection({ USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' }, mac), { kind: 'embedded' })
    assert.throws(() => resolveLocalDatabaseSelection({ ...managed, USEBRIAN_MANAGED_POSTGRES_TRANSFER: 'yes' }, mac), /USEBRIAN_MANAGED_POSTGRES_TRANSFER must be "1"/)
    // Windows and Linux stay refused even with the transfer chosen.
    for (const host of [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }]) {
      assert.throws(() => resolveLocalDatabaseSelection({ ...managed, USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' }, host), /not qualified/)
    }
  })

  it('refuses conflicting, unknown and unqualified choices instead of falling back', () => {
    assert.throws(() => resolveLocalDatabaseSelection({ ...managed, DATABASE_URL: 'postgres://u@db/x' }, mac), /conflicts with DATABASE_URL/)
    assert.throws(() => resolveLocalDatabaseSelection({ USEBRIAN_LOCAL_DATABASE: 'postgres' }, mac), /must be "embedded" or "managed-postgres"/)
    assert.throws(() => resolveLocalDatabaseSelection(managed, { platform: 'win32', arch: 'x64' }), /not qualified on win32-x64/)
    assert.throws(() => resolveLocalDatabaseSelection(managed, { platform: 'linux', arch: 'x64' }), /not qualified on linux-x64/)
    assert.throws(() => resolveLocalDatabaseSelection(managed, { platform: 'darwin', arch: 'x64' }), /not qualified on darwin-x64/)
  })

  it('agrees with the runtime release pins', () => {
    const release = readFileSync(new URL('../../packages/api/src/db/managed-postgres/release.ts', import.meta.url), 'utf8')
    const pinned = [...release.matchAll(/^ {2}'([a-z0-9]+-[a-z0-9]+)': Object\.freeze/gm)].map((match) => match[1])
    assert.deepEqual([...MANAGED_POSTGRES_QUALIFIED_PLATFORMS], pinned)
  })
})

describe('[COMP:platform/managed-postgres-launch] Managed DSN composition', () => {
  const urls = { ownerUrl: 'postgres://brian_owner:o@127.0.0.1:5999/usebrian', appUrl: 'postgres://app_user:a@127.0.0.1:5999/usebrian' }

  it('sets owner and app DSNs and drops the inherited single-connection alias and libpq input', () => {
    const env = {
      DATABASE_URL: 'postgres://localhost:54329/postgres', PG_SINGLE_CONNECTION: '1', PGOPTIONS: '-c x=y', PGHOST: '/tmp',
      PGSSLMODE: 'disable', PG_STATEMENT_TIMEOUT_MS: '0', PG_POOL_MAX: '4', JWT_SECRET: 'kept',
    }
    const result = applyManagedDatabaseEnv(env, urls)
    assert.equal(result, env)
    assert.deepEqual(env, { DATABASE_URL: urls.ownerUrl, DATABASE_URL_APP: urls.appUrl, PG_STATEMENT_TIMEOUT_MS: '0', PG_POOL_MAX: '4', JWT_SECRET: 'kept' })
  })

  it('refuses a missing or aliased application DSN', () => {
    assert.throws(() => applyManagedDatabaseEnv({}, { ownerUrl: urls.ownerUrl, appUrl: urls.ownerUrl }), /distinct owner and application DSNs/)
    assert.throws(() => applyManagedDatabaseEnv({}, { ownerUrl: urls.ownerUrl }), /distinct owner and application DSNs/)
  })

  it('gives the managed child OS essentials only', () => {
    assert.deepEqual(managedServerEnvironment({ PATH: '/usr/bin', HOME: '/h', DATABASE_URL: 'x', NODE_OPTIONS: '--require /x', PGOPTIONS: 'y', JWT_SECRET: 's', LANG: 'C' }), { PATH: '/usr/bin', HOME: '/h', LANG: 'C' })
    assert.equal(isLibpqEnvironmentKey('PGPASSWORD'), true)
    assert.equal(isLibpqEnvironmentKey('PG_SINGLE_CONNECTION'), false)
  })

  it('is wired into the launcher as an isolated branch ahead of PGlite', () => {
    const launcher = readFileSync(new URL('../launch.mjs', import.meta.url), 'utf8')
    assert.match(launcher, /resolveLocalDatabaseSelection\(process\.env, \{ platform: platform\(\), arch: arch\(\) \}\)/)
    const managedAt = launcher.indexOf("if (localDatabase.kind === 'managed-postgres') {")
    const embeddedAt = launcher.indexOf('} else if (useEmbedded) {')
    assert.ok(managedAt > 0 && embeddedAt > managedAt)
    const branch = launcher.slice(managedAt, embeddedAt)
    assert.match(branch, /legacyBrainDirectory: BRAIN_DIR/)
    assert.match(branch, /applyManagedDatabaseEnv\(env, managedDatabase\.urls\)/)
    assert.match(branch, /MANAGED_NATIVE_TRANSFER_REQUIRED/)
    assert.match(branch, /MANAGED_NATIVE_TRANSFER_REFUSED/)
    assert.match(branch, /transfer: localDatabase\.transfer === true/)
    assert.match(branch, /process\.exit\(1\)/)
    // The embedded single-connection flag stays limited to the embedded branch.
    assert.match(launcher, /\.\.\.\(useEmbedded \? \{ PG_SINGLE_CONNECTION: '1' \} : \{\}\)/)
    assert.match(launcher, /managedDatabase\.stop\(20_000\)/)
  })
})
