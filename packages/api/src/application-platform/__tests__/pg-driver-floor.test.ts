/**
 * [COMP:api/portable-restore] [COMP:api/db-client] The resolved `pg` driver
 * carries `Client.prototype.getTransactionStatus`.
 *
 * The portable-restore idle-owner check, the conversation installation
 * authenticators and `db/client.ts` release accounting read the last
 * ReadyForQuery status through that method. `pg` added it in 8.21.0; on an
 * older driver every restore refuses with `portable_restore_requires_idle_owner`
 * and every installation authentication refuses as non-idle. A workspace
 * install that resolves an older `pg` (the platform lockfile once resolved
 * 8.20.0 for `"pg": "^8"`) must fail here, not in a restore.
 * See docs/architecture/platform/deployment.md → "Database driver floor".
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

const FLOOR = '8.21.0'
const require = createRequire(import.meta.url)
const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10))
const atLeast = (version: string, floor: string) => {
  const [a, b] = [parts(version), parts(floor)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

describe('[COMP:api/portable-restore] pg driver floor', () => {
  it(`resolves pg >= ${FLOOR} with Client.prototype.getTransactionStatus`, () => {
    const version = (require('pg/package.json') as { version: string }).version
    expect(atLeast(version, FLOOR), `resolved pg ${version} is below the ${FLOOR} floor (getTransactionStatus); reinstall so the lockfile resolves pg ^${FLOOR}`).toBe(true)
    expect(typeof (pg.Client.prototype as unknown as Record<string, unknown>).getTransactionStatus, `pg ${version} lacks Client.getTransactionStatus (added in ${FLOOR}); idle-owner and installation checks would refuse`).toBe('function')
  })

  it(`declares the ^${FLOOR} floor in the @use-brian/api manifest`, () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    const range = manifest.dependencies.pg ?? ''
    expect(range, `packages/api/package.json must declare "pg": "^${FLOOR}" (or higher)`).toMatch(/^\^8\.(\d+)\.\d+$/)
    expect(atLeast(range.slice(1), FLOOR), `pg range ${range} is below the ${FLOOR} floor`).toBe(true)
  })
})
