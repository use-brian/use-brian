import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'

// [COMP:ci/execution-topology] Same-run prepared state, never a cached verdict.
export async function preparedIdentity(): Promise<string> {
  const root = new URL('../../../../', import.meta.url)
  const migrations = (await readdir(new URL('packages/api/migrations/', root))).filter(name => name.endsWith('.sql')).sort()
  const hash = createHash('sha256')
  for (const path of ['pnpm-lock.yaml', 'apps/api/src/migrate-pglite.ts',
    'packages/api/src/migrations/pglite-sql.ts', 'packages/api/src/migrations/renames.ts', 'packages/api/src/migrations/execution-sql.ts', 'apps/api/src/__tests__/prepared-pglite.ts',
    'apps/api/src/__tests__/migration-owner-role.test.ts', 'apps/api/src/__tests__/migration-owner-groups.ts', ...migrations.map(name => `packages/api/migrations/${name}`)]) {
    hash.update(path).update('\0').update(await readFile(new URL(path, root))).update('\0')
  }
  return hash.digest('hex')
}

export async function savePreparedPglite(db: PGlite, path: string, identity: string): Promise<void> {
  if (await preparedIdentity() !== identity) throw new Error('Source changed while preparing PGlite')
  const bytes = Buffer.from(await (await db.dumpDataDir('none')).arrayBuffer())
  await writeFile(path, bytes, { mode: 0o600 })
  await writeFile(`${path}.json`, JSON.stringify({ identity, digest: createHash('sha256').update(bytes).digest('hex') }), { mode: 0o600 })
}

export async function loadPreparedPglite(path: string): Promise<PGlite> {
  const manifest = JSON.parse(await readFile(`${path}.json`, 'utf8'))
  const bytes = await readFile(path)
  if (manifest.identity !== await preparedIdentity() || manifest.digest !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error('Prepared PGlite source or image mismatch')
  }
  const db = new PGlite({ extensions: { vector, pg_trgm }, loadDataDir: new Blob([new Uint8Array(bytes)]) })
  await db.waitReady
  return db
}
