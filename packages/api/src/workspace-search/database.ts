import type { QueryResultRow } from 'pg'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from '../db/client.js'
import type { SearchScope } from './service.js'

/** A cancelled adapter destroys its connection, so PostgreSQL stops its work. */
export async function searchDatabase<T extends QueryResultRow>(scope: SearchScope, signal: AbortSignal, sql: string, values: unknown[]): Promise<T[]> {
  if (signal.aborted) throw new Error('Search cancelled')
  const pending = getAppPool().connect()
  const client = await pending
  if (signal.aborted) { client.release(); throw new Error('Search cancelled') }
  let released = false
  const abort = () => {
    if (!released) { released = true; client.release(true) }
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await client.query('BEGIN READ ONLY')
    await applyRLSGucs(client, scope.userId)
    await client.query("SET LOCAL statement_timeout = '1500ms'")
    const result = await client.query<T>(sql, values)
    await client.query('COMMIT')
    return result.rows
  } finally {
    signal.removeEventListener('abort', abort)
    if (!released) await rollbackAndRelease(client)
  }
}
