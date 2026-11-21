import { migrationSqlTokens } from './migration-sql-tokens.js'

/** Strip only one explicitly declared outer transaction pair. */
export function withoutOuterTransaction(sql: string, file: string): string {
  const begins = sql.match(/^BEGIN;\s*$/gm)?.length ?? 0
  const commits = sql.match(/^COMMIT;\s*$/gm)?.length ?? 0
  if (begins === 0 && commits === 0) return sql
  if (begins !== 1 || commits !== 1) {
    throw new Error(`${file}: expected one outer BEGIN/COMMIT pair`)
  }
  return sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '')
}

/** Keep both migration trees on their shipped execution paths through 8332. */
export function isNewMigration(file: string): boolean {
  return /^\d{4,}_/.test(file) && file >= '8333'
}

const transactionCommands = new Set(['abort', 'begin', 'commit', 'end', 'release', 'rollback', 'savepoint', 'start'])

/** Unwrap a single optional outer pair and refuse executable transaction control inside it. */
export function atomicMigrationSql(sql: string, file: string): string {
  const statements: Array<{ command: string; second?: string; start: number; end: number }> = []
  let depth = 0
  let statement: (typeof statements)[number] | undefined
  for (const token of migrationSqlTokens(sql, file)) {
    if (token.text === ';' && depth === 0) {
      if (statement) statements.push({ ...statement, end: token.end })
      statement = undefined
      continue
    }
    if (!statement) statement = { command: token.text, start: token.start, end: token.end }
    else statement.second ??= token.text
    if (token.text === '(') depth++
    if (token.text === ')') depth--
    if (depth < 0) throw new Error(`${file}: unbalanced SQL parentheses`)
  }
  if (depth !== 0) throw new Error(`${file}: unbalanced SQL parentheses`)
  if (statement) statements.push(statement)
  const first = statements[0]
  const last = statements.at(-1)
  if (first?.command === 'begin' && first.second === undefined && last?.command === 'commit' && last.second === undefined) {
    statements.pop()
    statements.shift()
    sql = sql.slice(first.end, last.start)
  }
  if (statements.some(({ command, second }) => transactionCommands.has(command) ||
    ((command === 'prepare' || command === 'set') && second === 'transaction'))) {
    throw new Error(`${file}: transaction control belongs to the migration runner; use a plain optional outer BEGIN/COMMIT pair`)
  }
  if (statements.length === 0) throw new Error(`${file}: no executable migration SQL`)
  return sql
}
