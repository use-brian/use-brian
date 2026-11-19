/**
 * [COMP:platform/managed-postgres] Clean environments for the managed runtime.
 *
 * Native database children receive OS essentials only, never ambient loader,
 * preload or libpq configuration. Runtime-owned client sessions set every field
 * node-postgres would otherwise read from `PGOPTIONS`, `PGAPPNAME`,
 * `PGCLIENTENCODING`, `PGSSLMODE` or `PGCONNECT_TIMEOUT`.
 */

const NATIVE_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'ComSpec', 'PATHEXT'] as const

export function managedNativeChildEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of NATIVE_KEYS) {
    const value = source[name]
    if (value !== undefined) result[name] = value
  }
  result.LC_ALL = 'C'
  return result
}

/**
 * libpq client variables (`PGHOST`, `PGOPTIONS`, `PGSSLMODE`, ...). Product
 * settings spelled `PG_...` (pool size, statement timeout) are not libpq input.
 */
export function isLibpqEnvironmentKey(key: string): boolean {
  return /^PG[A-Z][A-Z0-9_]*$/.test(key)
}

/** Remove ambient libpq input and the embedded single-connection alias. */
export function withoutAmbientDatabaseEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isLibpqEnvironmentKey(key) || key === 'PG_SINGLE_CONNECTION') continue
    result[key] = value
  }
  return result
}

export interface ManagedClientConfig {
  readonly connectionString: string
  readonly options: string
  readonly application_name: string
  readonly client_encoding: string
  readonly ssl: false
  readonly connectionTimeoutMillis: number
  readonly keepAlive: true
}

/** Explicit session parameters for every runtime-owned connection. */
export function managedClientConfig(connectionString: string): ManagedClientConfig {
  return Object.freeze({
    connectionString,
    options: '-c usebrian.managed_runtime=on',
    application_name: 'usebrian-managed-postgres',
    client_encoding: 'UTF8',
    ssl: false,
    connectionTimeoutMillis: 1000,
    keepAlive: true,
  })
}
