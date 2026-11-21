type SqlToken = { text: string; start: number; end: number }

/** PostgreSQL lexical boundaries with standard_conforming_strings enabled. */
export function* migrationSqlTokens(sql: string, file: string): Generator<SqlToken> {
  const skip = /(?:\s+|--[^\r\n]*)/y
  const token = /(?:[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-zA-Z_\u0080-\uffff][a-zA-Z_0-9$\u0080-\uffff]*)/y
  const dollarTag = /\$(?:[a-zA-Z_\u0080-\uffff][a-zA-Z_0-9\u0080-\uffff]*)?\$/y
  if (sql.includes('\x00')) throw new Error(`${file}: SQL contains a NUL byte`)
  let at = 0
  while (at < sql.length) {
    const start = at
    skip.lastIndex = token.lastIndex = dollarTag.lastIndex = start
    if (skip.test(sql)) {
      at = skip.lastIndex
      continue
    }
    if (sql.startsWith('/*', start)) {
      at += 2
      let depth = 1
      while (depth && at < sql.length) {
        if (sql.startsWith('/*', at)) { depth++; at += 2 }
        else if (sql.startsWith('*/', at)) { depth--; at += 2 }
        else at++
      }
      if (depth) throw new Error(`${file}: unterminated SQL comment`)
      continue
    }
    const tag = sql[start] === '$' && dollarTag.exec(sql)?.[0]
    if (tag) {
      const close = sql.indexOf(tag, dollarTag.lastIndex)
      if (close === -1) throw new Error(`${file}: unterminated dollar-quoted SQL body`)
      at = close + tag.length
      yield { text: sql.slice(start, at), start, end: at }
      continue
    }
    const match = token.exec(sql)?.[0]
    if (match) {
      at = token.lastIndex
      const quoted = match.includes("'") || match.startsWith('"')
      yield { text: quoted ? match : match.replace(/[A-Z]/g, letter => letter.toLowerCase()), start, end: at }
      continue
    }
    if (sql[start] === "'" || sql[start] === '"') throw new Error(`${file}: unterminated SQL quote`)
    yield { text: sql[at++], start, end: at }
  }
}
