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
