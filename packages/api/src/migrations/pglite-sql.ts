/**
 * Normalize one migration file for the embedded PGLite startup runner.
 *
 * PGLite migrations run in one runner-owned transaction per file. PostgreSQL's
 * `CREATE INDEX CONCURRENTLY` is therefore both unnecessary (startup has no
 * application traffic yet) and invalid inside that transaction. The hosted
 * node-postgres runner never calls this helper and keeps the original SQL.
 *
 * Spec: docs/architecture/platform/database-schema.md
 * [COMP:api/pglite-migration-sql]
 */

function withoutOuterTransaction(sql: string, file: string): string {
  const begins = sql.match(/^BEGIN;\s*$/gm)?.length ?? 0
  const commits = sql.match(/^COMMIT;\s*$/gm)?.length ?? 0
  if (begins === 0 && commits === 0) return sql
  if (begins !== 1 || commits !== 1) {
    throw new Error(`${file}: expected one outer BEGIN/COMMIT pair`)
  }
  return sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '')
}

export function toPgliteMigrationSql(sql: string, file: string): string {
  return withoutOuterTransaction(sql, file).replace(
    /\bCREATE(\s+UNIQUE)?\s+INDEX\s+CONCURRENTLY\b/gi,
    (_match, unique: string | undefined) => `CREATE${unique ?? ''} INDEX`,
  )
}
