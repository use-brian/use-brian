/**
 * Resolve the local rig's brain database from one source of truth: DATABASE_URL.
 *
 * `scripts/rig-up.sh` needs the URL's parts (user, password, database, port) to
 * create a matching Postgres container, and needs them WITHOUT printing the
 * password — so this module parses and the shell `eval`s quoted assignments.
 * Resolution order, first hit wins:
 *
 *   1. `DATABASE_URL` in the caller's environment (a session pointing the rig at
 *      some other local Postgres),
 *   2. `DATABASE_URL` in `use-brian/.env` (a symlink to the platform `.env`, so
 *      one file serves both trees),
 *   3. the default below — the same coordinates docs/runbooks and the rig doc
 *      use, so a fresh clone needs no configuration at all.
 *
 * The rig refuses a non-loopback host (see `isLoopback`): it creates, stops and
 * — with `--wipe` — deletes this database, and none of that may ever be aimed at
 * a shared or production server.
 *
 * Kept pure/injected so the resolution rules are testable without a database.
 *
 * [COMP:platform/local-rig]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN_DATABASE_URL } from './rig-admin.mjs'

/** Postgres 18 + pgvector, port 5442, throwaway credentials. */
export const DEFAULT_DATABASE_URL = 'postgres://brian:brian@127.0.0.1:5442/usebrian'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Read one key out of a dotenv file's text.
 *
 * Deliberately mirrors `scripts/launch.mjs`'s `loadDotEnv` rules — quoted values
 * keep their contents verbatim (so a password containing `#` survives), an
 * unquoted value drops an inline `#` comment, and `export ` prefixes are
 * tolerated — because the rig and the launcher must read the same `.env` the
 * same way. Last assignment wins, as a shell would.
 */
export function readDotEnvValue(text, key) {
  let found = null
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/)
    if (!m || m[1] !== key) continue
    let val = m[2]
    const quote = val[0]
    if (quote === '"' || quote === "'") {
      const end = val.indexOf(quote, 1)
      val = end === -1 ? val.slice(1) : val.slice(1, end)
    } else {
      val = val.replace(/(^|\s)#.*$/, '').trim()
    }
    found = val
  }
  return found
}

/**
 * @returns {{
 *   url: string, source: 'env'|'dotenv'|'default'|'admin-fixture', display: string,
 *   host: string, port: string, database: string, user: string, password: string,
 *   isLoopback: boolean,
 * }}
 */
export function resolveRigDatabase({
  root,
  env = {},
  readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  defaultUrl = DEFAULT_DATABASE_URL,
} = {}) {
  let url = env.USEBRIAN_ADMIN_ONLY === '1' ? ADMIN_DATABASE_URL : env.DATABASE_URL?.trim()
  let source = env.USEBRIAN_ADMIN_ONLY === '1' ? 'admin-fixture' : 'env'
  if (!url) {
    const text = readText(join(root, '.env'))
    const fromFile = text ? readDotEnvValue(text, 'DATABASE_URL')?.trim() : null
    if (fromFile) {
      url = fromFile
      source = 'dotenv'
    } else {
      url = defaultUrl
      source = 'default'
    }
  }

  // libpq's unix-socket form (`postgres://user@/db?host=/cloudsql/...`, which is
  // what production uses) has an empty authority and does not parse as a URL at
  // all. Name it, rather than reporting a generic parse failure for a string
  // that is a perfectly valid connection string — just never one the rig owns.
  // Empty authority (`@/db`, `///db`) or an explicit `host=` socket parameter.
  if (/@\//.test(url) || /:\/\/\//.test(url) || /[?&]host=/i.test(url)) {
    throw new Error(
      `DATABASE_URL uses libpq's unix-socket form (${maskUrl(url)}). The rig manages a TCP`
      + ` Postgres container on loopback, so point DATABASE_URL at 127.0.0.1 or unset it.`,
    )
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`DATABASE_URL is not a URL (from ${source}): ${maskUrl(url)}`)
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`DATABASE_URL must be a postgres:// URL (from ${source}), got ${parsed.protocol}`)
  }

  const host = parsed.hostname
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const result = {
    url,
    source,
    display: maskUrl(url),
    host,
    // A socket-style URL (`@/db?host=/cloudsql/...`) has no port; the caller
    // refuses it on isLoopback anyway, so report the default rather than ''.
    port: parsed.port || '5432',
    database: database || 'postgres',
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: decodeURIComponent(parsed.password),
    isLoopback: LOOPBACK_HOSTS.has(host),
  }
  return result
}

/** `postgres://user:secret@host:port/db` -> `postgres://user@host:port/db`. */
export function maskUrl(url) {
  return String(url).replace(/(\/\/[^:/?#@]*):[^@/?#]*@/, '$1@')
}

/** Single-quote for `eval` in sh: wrap, and close/escape/reopen each quote. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

// CLI: `node scripts/rig-env.mjs --shell` prints assignments for the rig to eval.
// Nothing is printed on stderr-free success but the assignments themselves, and
// the password is never echoed — it only ever lands in a shell variable.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = new URL('..', import.meta.url).pathname
  try {
    const db = resolveRigDatabase({ root, env: process.env })
    const out = {
      RIG_DB_URL: db.url,
      RIG_DB_SOURCE: db.source,
      RIG_DB_DISPLAY: db.display,
      RIG_DB_HOST: db.host,
      RIG_DB_PORT: db.port,
      RIG_DB_NAME: db.database,
      RIG_DB_USER: db.user,
      RIG_DB_PASSWORD: db.password,
      RIG_DB_LOOPBACK: db.isLoopback ? '1' : '0',
    }
    for (const [key, value] of Object.entries(out)) {
      process.stdout.write(`${key}=${shellQuote(value)}\n`)
    }
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`)
    process.exit(1)
  }
}
