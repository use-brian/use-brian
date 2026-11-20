/**
 * [COMP:platform/managed-postgres] Release pins for the managed local PostgreSQL
 * artifact. Spec: docs/architecture/platform/database-schema.md
 * → "Managed local PostgreSQL runtime".
 *
 * The manifest hash is the only way an artifact becomes executable. A platform
 * without a pin is unsupported: the launcher refuses the managed branch there
 * instead of guessing at a binary.
 */

export const MANAGED_POSTGRES_PROFILE = 'managed-postgresql18-posix-fence-v1'
export const MANAGED_POSTGRES_POSTGRESQL_VERSION = '18.7'
export const MANAGED_POSTGRES_PGVECTOR_VERSION = '0.8.7'

/** SHA-256 of `use-brian/scripts/managed-postgres/lifecycle-fence.c`. */
export const LIFECYCLE_FENCE_SOURCE_SHA256 = '6ed0529cd17c38a38ad479552809a754c96539bbf0b410392632dc629392b61f'

/** Upstream sources the recipe builds from (also pinned in build-artifact.sh). */
export const MANAGED_POSTGRES_SOURCES = Object.freeze([
  Object.freeze({
    url: 'https://ftp.postgresql.org/pub/source/v18.7/postgresql-18.7.tar.bz2',
    sha256: '441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd',
  }),
  Object.freeze({
    url: 'https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz',
    commit: 'f37c13f68b57d2c3472b2214fbcff699d6d34876',
    sha256: 'cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85',
  }),
])

export interface ManagedPostgresRelease {
  readonly platform: string
  readonly arch: string
  readonly manifestSha256: string
  readonly minimumOS: string
}

const RELEASES: Readonly<Record<string, ManagedPostgresRelease>> = Object.freeze({
  'darwin-arm64': Object.freeze({
    platform: 'darwin',
    arch: 'arm64',
    manifestSha256: '57ce71deedda9e21f75a2e3f1a0c3d66830533560b0a1e82e3649d39e22631a6',
    minimumOS: '13.0',
  }),
})

/** The pinned release for this platform, or null when it is unqualified. */
export function managedPostgresRelease(
  platform: string = process.platform,
  arch: string = process.arch,
): ManagedPostgresRelease | null {
  return RELEASES[`${platform}-${arch}`] ?? null
}
