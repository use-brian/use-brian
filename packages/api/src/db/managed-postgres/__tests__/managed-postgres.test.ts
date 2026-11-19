import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LIFECYCLE_FENCE_SOURCE_SHA256,
  MANAGED_POSTGRES_PGVECTOR_VERSION,
  MANAGED_POSTGRES_POSTGRESQL_VERSION,
  MANAGED_POSTGRES_PROFILE,
  MANAGED_POSTGRES_SOURCES,
  isLibpqEnvironmentKey,
  managedClientConfig,
  managedNativeChildEnvironment,
  managedPostgresBinaries,
  managedPostgresRelease,
  readControlSystemIdentifier,
  readManagedPostmaster,
  resolveManagedPostgresArtifact,
  verifyManagedPostgresArtifact,
  withoutAmbientDatabaseEnvironment,
  type ManagedPostgresArtifact,
} from '../index.js'

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })

async function scratch(prefix: string) {
  const path = await mkdtemp(join(await realpath(tmpdir()), prefix))
  temporary.push(path)
  return path
}

/** A structurally complete synthetic artifact; no native code is executed. */
async function syntheticArtifact(root: string) {
  const files: Record<string, string> = {
    'bin/postgres': '#!/bin/sh\n', 'bin/initdb': '#!/bin/sh\n', 'bin/pg_ctl': '#!/bin/sh\n', 'bin/pg_dump': '#!/bin/sh\n',
    'bin/pg_restore': '#!/bin/sh\n', 'bin/usebrian-pg-lifecycle': '#!/bin/sh\n',
    'lib/libpq.5.dylib': 'library', 'share/licenses/postgresql/COPYRIGHT': 'PostgreSQL license',
    'share/licenses/pgvector/LICENSE': 'pgvector license', 'share/licenses/usebrian/LICENSE': 'AGPL',
    'share/usebrian-source/lifecycle-fence.c': 'source',
  }
  const entries: Record<string, unknown> = {}
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
    const mode = name.startsWith('bin/') ? 0o755 : 0o644
    await chmod(join(root, name), mode)
    entries[name] = { sha256: sha(content), mode: '0o' + mode.toString(8) }
  }
  await symlink('libpq.5.dylib', join(root, 'lib/libpq.dylib'))
  entries['lib/libpq.dylib'] = { link: 'libpq.5.dylib' }
  const manifest = JSON.stringify({
    format: 1, profile: MANAGED_POSTGRES_PROFILE, platform: platform(), arch: arch(),
    postgresql: MANAGED_POSTGRES_POSTGRESQL_VERSION, pgvector: MANAGED_POSTGRES_PGVECTOR_VERSION,
    lifecycleFenceSourceSha256: LIFECYCLE_FENCE_SOURCE_SHA256, files: entries,
  })
  await writeFile(join(root, 'manifest.json'), manifest)
  return sha(manifest)
}

describe('[COMP:platform/managed-postgres] clean environment', () => {
  it('passes native children only OS essentials with a fixed locale', () => {
    const env = managedNativeChildEnvironment({
      PATH: '/usr/bin', HOME: '/home/fixture', TMPDIR: '/tmp/fixture', LANG: 'en_US.UTF-8',
      DYLD_INSERT_LIBRARIES: '/x.dylib', LD_PRELOAD: '/x.so', NODE_OPTIONS: '--require /x.js',
      PGOPTIONS: '-c x=y', PGDATA: '/elsewhere', DATABASE_URL: 'postgres://owner@h/db',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/fixture', TMPDIR: '/tmp/fixture', LANG: 'en_US.UTF-8', LC_ALL: 'C' })
  })

  it('distinguishes libpq input from product PG_ settings', () => {
    expect(['PGOPTIONS', 'PGHOST', 'PGSSLMODE', 'PGAPPNAME', 'PGPASSWORD'].every(isLibpqEnvironmentKey)).toBe(true)
    expect(['PG_SINGLE_CONNECTION', 'PG_POOL_MAX', 'PG_STATEMENT_TIMEOUT_MS', 'DATABASE_URL'].some(isLibpqEnvironmentKey)).toBe(false)
    expect(withoutAmbientDatabaseEnvironment({ PGOPTIONS: '-c x=y', PG_SINGLE_CONNECTION: '1', PG_STATEMENT_TIMEOUT_MS: '0', PATH: '/bin' }))
      .toEqual({ PG_STATEMENT_TIMEOUT_MS: '0', PATH: '/bin' })
  })

  it('overrides every node-postgres environment fallback for runtime sessions', () => {
    const require = createRequire(import.meta.url)
    const ConnectionParameters = require('pg/lib/connection-parameters') as new (config: unknown) => Record<string, unknown>
    const saved = { ...process.env }
    Object.assign(process.env, { PGOPTIONS: '-c usebrian.sentinel=leaked', PGAPPNAME: 'sentinel', PGCLIENTENCODING: 'LATIN1', PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '99' })
    try {
      const parameters = new ConnectionParameters(managedClientConfig('postgres://brian_owner:secret@127.0.0.1:5999/usebrian'))
      expect(parameters.options).toBe('-c usebrian.managed_runtime=on')
      expect(parameters.application_name).toBe('usebrian-managed-postgres')
      expect(parameters.client_encoding).toBe('UTF8')
      expect(parameters.ssl).toBe(false)
      expect(parameters.connect_timeout).toBe(1)
      expect([parameters.host, parameters.port, parameters.user, parameters.database]).toEqual(['127.0.0.1', 5999, 'brian_owner', 'usebrian'])
      // The unpatched shape (`options: ''`) is the regression: it inherits PGOPTIONS.
      expect(new ConnectionParameters({ connectionString: 'postgres://u@127.0.0.1:5999/d', options: '' }).options).toBe('-c usebrian.sentinel=leaked')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
})

describe('[COMP:platform/managed-postgres] release pin and source recipe', () => {
  it('pins macOS arm64 only; Windows and Linux are unqualified', () => {
    expect(managedPostgresRelease('darwin', 'arm64')?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(managedPostgresRelease('win32', 'x64')).toBeNull()
    expect(managedPostgresRelease('linux', 'x64')).toBeNull()
    expect(managedPostgresRelease('darwin', 'x64')).toBeNull()
  })

  it('binds the executor pin to the shipped source and the recipe to the pinned upstream tarballs', async () => {
    const recipe = join(repo, 'scripts/managed-postgres')
    expect(sha(await readFile(join(recipe, 'lifecycle-fence.c')))).toBe(LIFECYCLE_FENCE_SOURCE_SHA256)
    const build = await readFile(join(recipe, 'build-artifact.sh'), 'utf8')
    const assemble = await readFile(join(recipe, 'assemble-artifact.mjs'), 'utf8')
    for (const source of MANAGED_POSTGRES_SOURCES) {
      expect(build).toContain(source.sha256)
      expect(assemble).toContain(source.sha256)
    }
    expect(assemble).toContain(MANAGED_POSTGRES_PROFILE)
    expect(assemble).toContain("'share/licenses/usebrian/LICENSE'")
  })
})

describe('[COMP:platform/managed-postgres] artifact verification', () => {
  it('accepts an exact pinned package and yields executable paths only from the verifier', async () => {
    const root = join(await scratch('managed-artifact-'), 'runtime')
    const pin = await syntheticArtifact(root)
    const artifact = await resolveManagedPostgresArtifact(root, pin)
    expect(relative(root, managedPostgresBinaries(artifact).pg_ctl)).toBe('bin/pg_ctl')
    await verifyManagedPostgresArtifact(artifact)
    const forged = { ...artifact } as ManagedPostgresArtifact
    expect(() => managedPostgresBinaries(forged)).toThrow(/authenticated packaged artifact/)
  })

  it('refuses a self-rehashed manifest, a symlinked install parent and roster, byte, mode or link changes', async () => {
    const base = await scratch('managed-artifact-')
    const root = join(base, 'runtime')
    const pin = await syntheticArtifact(root)
    await expect(resolveManagedPostgresArtifact(root, 'a'.repeat(64))).rejects.toThrow(/manifest changed/)
    await symlink(base, join(base, '..', relative(join(base, '..'), base) + '-link'))
    temporary.push(base + '-link')
    await expect(resolveManagedPostgresArtifact(join(base + '-link', 'runtime'), pin)).rejects.toThrow(/canonical path/)

    const artifact = await resolveManagedPostgresArtifact(root, pin)
    await appendFile(join(root, 'share/licenses/postgresql/COPYRIGHT'), 'x')
    await expect(verifyManagedPostgresArtifact(artifact)).rejects.toThrow(/file changed: share\/licenses\/postgresql\/COPYRIGHT/)
    await writeFile(join(root, 'share/licenses/postgresql/COPYRIGHT'), 'PostgreSQL license')
    await verifyManagedPostgresArtifact(artifact)

    await chmod(join(root, 'bin/pg_dump'), 0o775)
    await expect(resolveManagedPostgresArtifact(root, pin)).rejects.toThrow(/file changed: bin\/pg_dump/)
    await chmod(join(root, 'bin/pg_dump'), 0o755)

    await writeFile(join(root, 'bin/extra'), 'unlisted')
    await expect(resolveManagedPostgresArtifact(root, pin)).rejects.toThrow(/roster changed/)
    await rm(join(root, 'bin/extra'))

    await rm(join(root, 'lib/libpq.dylib'))
    await symlink('../../outside', join(root, 'lib/libpq.dylib'))
    await expect(resolveManagedPostgresArtifact(root, pin)).rejects.toThrow()
  })

  it('refuses a package without its licenses or executor source record', async () => {
    const root = join(await scratch('managed-artifact-'), 'runtime')
    await syntheticArtifact(root)
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    delete manifest.files['share/licenses/usebrian/LICENSE']
    await rm(join(root, 'share/licenses/usebrian/LICENSE'))
    const bytes = JSON.stringify(manifest)
    await writeFile(join(root, 'manifest.json'), bytes)
    await expect(resolveManagedPostgresArtifact(root, sha(bytes))).rejects.toThrow(/license or source record/)
  })
})

describe('[COMP:platform/managed-postgres] instance identity files', () => {
  it('reads the PostgreSQL 18 system identifier from pg_control and refuses other formats', async () => {
    const data = await scratch('managed-control-')
    await mkdir(join(data, 'global'))
    const control = Buffer.alloc(64)
    control.writeBigUInt64LE(7708712405278107248n, 0)
    control.writeUInt32LE(1800, 8)
    await writeFile(join(data, 'global/pg_control'), control)
    expect(await readControlSystemIdentifier(data)).toBe('7708712405278107248')
    control.writeUInt32LE(1700, 8)
    await writeFile(join(data, 'global/pg_control'), control)
    await expect(readControlSystemIdentifier(data)).rejects.toMatchObject({ code: 'MANAGED_INSTANCE_IDENTITY_CHANGED' })
  })

  it('parses the postmaster PID file only as a crosscheck', async () => {
    const data = await scratch('managed-postmaster-')
    expect(await readManagedPostmaster(data)).toBeNull()
    await writeFile(join(data, 'postmaster.pid'), `4242\n${data}\n1794824846\n54699\n\n127.0.0.1\n`)
    expect(await readManagedPostmaster(data)).toEqual({ pid: 4242, data, started: 1794824846, port: 54699 })
    await writeFile(join(data, 'postmaster.pid'), `0\n${data}\n1794824846\n54699\n`)
    await expect(readManagedPostmaster(data)).rejects.toThrow(/Invalid native postmaster identity/)
  })
})
