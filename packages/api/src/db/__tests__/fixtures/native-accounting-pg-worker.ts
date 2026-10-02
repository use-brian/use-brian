import pg from 'pg'
import { createOssNativeAccounting, type NativeAccountingConnection } from '../../oss-native-accounting.js'
import { NativeAccountingKeySchema } from '../../../computer-use/accounting.js'
import { assertPrivateDatabase, connectionConfig, validateOwnedRoot } from './owned-native-postgres.js'

// Only the acceptance harness forks this worker. It never accepts a URL, host,
// port, user, password or SQL from arguments/environment.
const [root, token, mode, encodedKey] = process.argv.slice(2)
if (!root || !token || !encodedKey || !process.send || !['lose-commit','recover'].includes(mode ?? '')) throw new Error('Owned test worker arguments required')
await validateOwnedRoot(root, token)
const key = NativeAccountingKeySchema.parse(JSON.parse(encodedKey))
const pool = new pg.Pool(connectionConfig(root, `native-accounting-worker-${process.pid}`))
const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as object, error => error ? reject(error) : resolve()))
let backendPid = 0
try {
  await assertPrivateDatabase(pool, root)
  await send({ kind: 'ready',pid: process.pid })
  const cap = createOssNativeAccounting(async (): Promise<NativeAccountingConnection> => {
    const client = await pool.connect()
    backendPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    return {
      async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]) {
        const result = await client.query<R>(sql, params)
        if (sql === 'COMMIT' && mode === 'lose-commit') {
          // Real COMMIT has completed, but the production transaction helper has
          // NOT received its resolution. Parent kills this client process here.
          await send({ kind: 'committed-before-ack', pid: process.pid, backendPid })
          await new Promise<never>(() => {})
        }
        return result
      },
      release(error?: Error) { client.release(error) },
    }
  })
  const result = await cap.reconcile(key)
  await send({ kind: 'result', result, pid: process.pid, backendPid })
} finally {
  await pool.end()
  process.disconnect?.()
}
