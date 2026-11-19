/**
 * [COMP:platform/managed-postgres] Release-pinned artifact verification.
 *
 * The manifest hash authenticates every byte, mode and link of the packaged
 * PostgreSQL before anything executes. Only a value returned by
 * `resolveManagedPostgresArtifact` can yield executable paths.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  LIFECYCLE_FENCE_SOURCE_SHA256,
  MANAGED_POSTGRES_PGVECTOR_VERSION,
  MANAGED_POSTGRES_POSTGRESQL_VERSION,
  MANAGED_POSTGRES_PROFILE,
} from './release.js'

export interface ManagedPostgresBinaries {
  readonly postgres: string
  readonly initdb: string
  readonly pg_ctl: string
  readonly pg_dump: string
  readonly pg_restore: string
  readonly lifecycleFence: string
}

export interface ManagedPostgresArtifact {
  readonly root: string
  readonly manifestSha256: string
  readonly postgresql: string
  readonly pgvector: string
  readonly binaries: ManagedPostgresBinaries
}

type ManifestEntry = { readonly link: string } | { readonly sha256: string; readonly mode: string }

const verifiedArtifacts = new WeakSet<ManagedPostgresArtifact>()
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 128 * 1024 * 1024
const REQUIRED_FILES = [
  'share/licenses/postgresql/COPYRIGHT',
  'share/licenses/pgvector/LICENSE',
  'share/licenses/usebrian/LICENSE',
  'share/usebrian-source/lifecycle-fence.c',
] as const
const BINARY_FILES: Readonly<Record<keyof ManagedPostgresBinaries, string>> = {
  postgres: 'postgres',
  initdb: 'initdb',
  pg_ctl: 'pg_ctl',
  pg_dump: 'pg_dump',
  pg_restore: 'pg_restore',
  lifecycleFence: 'usebrian-pg-lifecycle',
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path)
  return name !== '' && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name)
}

function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'MANAGED_POSTGRES_ARTIFACT_REFUSED' })
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = []
  async function scan(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) await scan(path)
      else found.push(relative(root, path))
    }
  }
  await scan(root)
  return found
}

/**
 * Authenticate an installed artifact against its release-pinned manifest hash.
 * The install path must be absolute and canonical: a symlinked install
 * directory or parent could be redirected after verification.
 */
export async function resolveManagedPostgresArtifact(
  directory: string,
  expectedManifestSha256: string,
): Promise<ManagedPostgresArtifact> {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '')) refuse('Managed PostgreSQL requires a release-pinned artifact manifest')
  if (typeof directory !== 'string' || !isAbsolute(directory)) refuse('Managed PostgreSQL artifact requires an absolute install path')
  const requested = resolve(directory)
  const root = await realpath(requested)
  if (root !== requested) refuse('Managed PostgreSQL artifact must be installed at a canonical path; symlinked parent refused')

  const manifestPath = join(root, 'manifest.json')
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) refuse('Managed PostgreSQL manifest must be a regular package file')
  const bytes = await readFile(manifestPath)
  if (bytes.length > MAX_MANIFEST_BYTES || sha256(bytes) !== expectedManifestSha256) refuse('Managed PostgreSQL artifact manifest changed')
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const files = manifest.files as Record<string, ManifestEntry> | undefined
  if (
    manifest.format !== 1 || manifest.profile !== MANAGED_POSTGRES_PROFILE ||
    manifest.platform !== platform() || manifest.arch !== arch() ||
    manifest.postgresql !== MANAGED_POSTGRES_POSTGRESQL_VERSION || manifest.pgvector !== MANAGED_POSTGRES_PGVECTOR_VERSION ||
    manifest.lifecycleFenceSourceSha256 !== LIFECYCLE_FENCE_SOURCE_SHA256 ||
    !files || typeof files !== 'object' || Array.isArray(files)
  ) refuse('Managed PostgreSQL artifact profile is unavailable')

  const names = Object.keys(files)
  if (names.length < 1 || names.length > 10000) refuse('Managed PostgreSQL artifact roster is invalid')
  const expected = new Set(['manifest.json', ...names])
  const actual = await listFiles(root)
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) refuse('Managed PostgreSQL artifact file roster changed')
  for (const name of REQUIRED_FILES) if (!(name in files) || 'link' in files[name]) refuse('Managed PostgreSQL artifact lacks its license or source record: ' + name)

  for (const name of names) {
    const path = resolve(root, name)
    const entry = files[name]
    if (!inside(root, path) || name !== relative(root, path)) refuse('Managed PostgreSQL artifact path escapes its package')
    const stat = await lstat(path)
    if (!inside(root, await realpath(path))) refuse('Managed PostgreSQL artifact link escapes its package')
    if (entry && 'link' in entry && typeof entry.link === 'string') {
      if (!stat.isSymbolicLink() || (await readlink(path)) !== entry.link) refuse('Managed PostgreSQL artifact link changed: ' + name)
      continue
    }
    const file = entry as { sha256?: unknown; mode?: unknown } | undefined
    if (
      !file || typeof file.mode !== 'string' || !/^0o[0-7]{3,4}$/.test(file.mode) ||
      !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES ||
      '0o' + (stat.mode & 0o777).toString(8) !== file.mode ||
      sha256(await readFile(path)) !== file.sha256
    ) refuse('Managed PostgreSQL artifact file changed: ' + name)
  }

  const binaries = {} as Record<keyof ManagedPostgresBinaries, string>
  for (const [key, filename] of Object.entries(BINARY_FILES) as Array<[keyof ManagedPostgresBinaries, string]>) {
    const path = join(root, 'bin', filename)
    const entry = files[relative(root, path)]
    if (!entry || !('sha256' in entry) || ((await lstat(path)).mode & 0o111) === 0) refuse('Managed PostgreSQL required binary is unavailable: ' + filename)
    binaries[key] = path
  }
  const artifact: ManagedPostgresArtifact = Object.freeze({
    root,
    manifestSha256: expectedManifestSha256,
    postgresql: manifest.postgresql as string,
    pgvector: manifest.pgvector as string,
    binaries: Object.freeze(binaries),
  })
  verifiedArtifacts.add(artifact)
  return artifact
}

/** Only the verifier can introduce executable package paths. */
export function managedPostgresBinaries(artifact: ManagedPostgresArtifact): ManagedPostgresBinaries {
  if (!verifiedArtifacts.has(artifact)) refuse('Managed PostgreSQL requires its authenticated packaged artifact')
  return artifact.binaries
}

/** Re-authenticate every byte immediately before native execution. */
export async function verifyManagedPostgresArtifact(artifact: ManagedPostgresArtifact): Promise<void> {
  managedPostgresBinaries(artifact)
  const current = await resolveManagedPostgresArtifact(artifact.root, artifact.manifestSha256)
  if (JSON.stringify(current.binaries) !== JSON.stringify(artifact.binaries)) refuse('Managed PostgreSQL artifact executable roster changed')
}
