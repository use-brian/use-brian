/**
 * Shared disposable fixture for the native managed-postgres suites. Native
 * suites run only when `USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT` names an
 * installed artifact matching this platform's release pin; otherwise they skip.
 * Every profile lives under `USEBRIAN_MANAGED_POSTGRES_TEST_ROOT` (default: the
 * canonical temp directory) and is stopped and removed by `disposeProfiles`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { managedPostgresRelease, resolveManagedPostgresArtifact, startManagedPostgres, type ManagedPostgres, type ManagedPostgresArtifact, type ManagedPostgresOptions } from '../index.js'
import type { ManagedQueryable } from '../types.js'

export const nativeArtifactDirectory = process.env.USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT?.trim() || ''
export const nativeEnabled = Boolean(nativeArtifactDirectory && managedPostgresRelease())
export const repoRoot = new URL('../../../../../../', import.meta.url).pathname.replace(/\/$/, '')

type RuntimeRoles = {
  prepareRuntimeRole: (client: ManagedQueryable) => Promise<void>
  activateRuntimeRole: (client: ManagedQueryable, options: { password: string }) => Promise<void>
}

export async function runtimeRoles(): Promise<RuntimeRoles> {
  return (await import(join(repoRoot, 'scripts/crm/runtime-role.mjs'))) as RuntimeRoles
}

export async function pinnedArtifact(directory = nativeArtifactDirectory): Promise<ManagedPostgresArtifact> {
  const release = managedPostgresRelease()
  if (!release) throw new Error('No release pin for this platform')
  return resolveManagedPostgresArtifact(directory, release.manifestSha256)
}

/**
 * A one-row migration prefix makes the maintained `app_user` activation legal
 * without replaying the full open chain; lifecycle controls do not depend on it.
 */
export async function fixtureMigrate(ownerUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl, options: '-c usebrian.fixture=on', application_name: 'managed-fixture', ssl: false })
  await client.connect()
  try {
    await client.query("CREATE TABLE IF NOT EXISTS public._migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());INSERT INTO public._migrations(name) VALUES('000_fixture_prefix.sql') ON CONFLICT DO NOTHING")
  } finally {
    await client.end()
  }
}

const profiles: string[] = []
const started: ManagedPostgres[] = []

export async function testRoot(): Promise<string> {
  return realpath(process.env.USEBRIAN_MANAGED_POSTGRES_TEST_ROOT?.trim() || tmpdir())
}

export async function newProfile(name: string): Promise<string> {
  const path = await mkdtemp(join(await testRoot(), `managed-${name}-`))
  profiles.push(path)
  return path
}

export function track(path: string): void { profiles.push(path) }

export async function fixtureOptions(directory: string, artifact: ManagedPostgresArtifact, extra: Partial<ManagedPostgresOptions> = {}): Promise<ManagedPostgresOptions> {
  const roles = await runtimeRoles()
  return {
    directory,
    legacyBrainDirectory: join(directory, 'original-pglite'),
    artifact,
    prepareRuntimeRole: roles.prepareRuntimeRole,
    activateRuntimeRole: roles.activateRuntimeRole,
    migrate: fixtureMigrate,
    authenticateInstallation: async () => {},
    onOwnershipLost: () => {},
    ...extra,
  }
}

export async function start(options: ManagedPostgresOptions): Promise<ManagedPostgres> {
  const managed = await startManagedPostgres(options)
  started.push(managed)
  return managed
}

/** postgres processes whose command line names a fixture profile. */
export function fixturePostgresProcesses(root: string): string[] {
  return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n').map((line) => line.trim()).filter((line) => line.includes('/bin/postgres') && line.includes(root))
}

export function forceStopData(artifact: ManagedPostgresArtifact, data: string): boolean {
  try {
    execFileSync(artifact.binaries.pg_ctl, ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop'], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Stop every instance this run started, force-stop leftovers, remove profiles. */
export async function disposeProfiles(artifact: ManagedPostgresArtifact | undefined): Promise<string[]> {
  for (const managed of started.splice(0)) await managed.stop().catch(() => {})
  const root = await testRoot()
  const leftovers: string[] = []
  for (const line of fixturePostgresProcesses(root)) {
    const data = line.match(/-D (\S+)/)?.[1]
    if (!data || !profiles.some((profile) => data.startsWith(profile))) continue
    leftovers.push(line)
    if (artifact) forceStopData(artifact, data)
  }
  for (const path of profiles.splice(0)) await rm(path, { recursive: true, force: true })
  return leftovers
}
