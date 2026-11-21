import { migrationSqlTokens } from './migration-sql-tokens.js'

type ConcurrentIndex = {
  file: string
  schema: string
  table: string
  name: string
  definition: string
  sql: string
  embeddedSql: string
}

const identifier = /^[a-z_][a-z0-9_]{0,62}$/

/** Recognize one declared, canonical CREATE INDEX CONCURRENTLY statement. */
export function concurrentIndexMigration(sql: string, file: string): ConcurrentIndex | undefined {
  if (sql.split('\n', 1)[0].trimEnd() !== '-- migration: concurrent-index') return
  const tokens = Array.from(migrationSqlTokens(sql, file))
  if (tokens.at(-1)?.text === ';') tokens.pop()
  const words = tokens.map(token => token.text)
  const offset = words[1] === 'unique' ? 3 : 2
  const [concurrent, name, on, schema, dot, table, using] = words.slice(offset)
  if (words[0] !== 'create' || words[offset - 1] !== 'index' || concurrent !== 'concurrently' ||
    on !== 'on' || dot !== '.' || using !== 'using' ||
    ![name, schema, table].every(value => value !== undefined && identifier.test(value)) || words.includes(';')) {
    throw new Error(`${file}: expected one CREATE [UNIQUE] INDEX CONCURRENTLY name ON schema.table USING ... statement`)
  }
  const { start, end } = tokens[offset]
  words.splice(offset, 1)
  return { file, schema, table, name, definition: words.join('\x00'), sql, embeddedSql: sql.slice(0, start) + sql.slice(end) }
}

type IndexState = { definition: string | null; valid: boolean | null }
type IndexConnection = { query(sql: string, values: string[]): Promise<{ rows: IndexState[] }> }

export async function readConcurrentIndex(db: IndexConnection, index: ConcurrentIndex): Promise<IndexState | undefined> {
  const { rows } = await db.query(`SELECT pg_catalog.pg_get_indexdef(c.oid) AS definition,
      i.indislive AND i.indisready AND i.indisvalid AS valid
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = $1 AND c.relname = $2`, [index.schema, index.name])
  return rows[0]
}

/** Call with pg_catalog search_path so the installed definition qualifies the table. */
export async function verifyConcurrentIndex(db: IndexConnection, index: ConcurrentIndex): Promise<void> {
  const installed = await readConcurrentIndex(db, index)
  const definition = installed?.definition && Array.from(migrationSqlTokens(installed.definition, index.file), token => token.text).join('\x00')
  const name = `${index.schema}.${index.name}`
  if (definition !== index.definition) throw new Error(`${index.file}: missing or mismatched index ${name}; inspect the installed definition before retrying`)
  if (!installed?.valid) throw new Error(`${index.file}: index ${name} is invalid or incomplete; inspect and repair the build before retrying`)
}
