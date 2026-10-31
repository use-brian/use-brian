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
  // These immutable guards pin a reviewed int4 DEFAULT 0 expression. PostgreSQL
  // prints sizeof(Datum) bytes: native 64-bit emits eight; PGlite wasm32 emits four.
  // Translate only this full literal at these two known prerequisite boundaries.
  const nativeZero = '({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})'
  const embeddedZero = nativeZero.replace('[ 0 0 0 0 0 0 0 0 ]', '[ 0 0 0 0 ]')
  const compatible = file === '81660_legacy_native_query_privileges.sql' || file === '8166_native_session_query_acquisition.sql'
    ? sql.replaceAll(nativeZero, embeddedZero) : sql
  return withoutOuterTransaction(compatible, file).replace(
    /\bCREATE(\s+UNIQUE)?\s+INDEX\s+CONCURRENTLY\b/gi,
    (_match, unique: string | undefined) => `CREATE${unique ?? ''} INDEX`,
  )
}
