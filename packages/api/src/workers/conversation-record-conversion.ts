/** [COMP:api/conversation-record-conversion] Bounded owner-side maintenance. */
import { startJitteredInterval, stopJitteredInterval, type JitteredIntervalHandle } from '@use-brian/core/scheduling/jitter.js'
import { getPool } from '../db/client.js'

const INTERVAL_MS = 2_000
const UNITS_PER_PAGE = 32
const BYTES_PER_PAGE = 4 * 1024 * 1024

export async function startConversationRecordConversionWorker() {
  const pool = getPool()
  const capabilities = (await pool.query<{ installed: boolean; backfill: boolean }>(`SELECT
    to_regprocedure('public.compile_conversation_record_page(integer,integer)') IS NOT NULL
    AND to_regprocedure('public.enroll_existing_conversation_records(integer)') IS NOT NULL AS installed,
    to_regprocedure('public.advance_conversation_envelope_backfill(integer)') IS NOT NULL AS backfill`)).rows[0]
  if (!capabilities?.installed) return null

  let inFlight: Promise<void> | null = null
  const tick = async () => {
    const client = await pool.connect()
    try {
      const tasks = [
        ...(capabilities.backfill ? [{ sql: 'SELECT public.advance_conversation_envelope_backfill($1)', values: [UNITS_PER_PAGE] }] : []),
        { sql: 'SELECT public.enroll_existing_conversation_records($1)', values: [UNITS_PER_PAGE] },
        { sql: 'SELECT public.compile_conversation_record_page($1,$2)', values: [UNITS_PER_PAGE, BYTES_PER_PAGE] },
      ]
      for (const task of tasks) {
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='3s'")
        await client.query(task.sql, task.values)
        await client.query('COMMIT')
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code !== '55P03' && code !== '57014') throw error
    } finally {
      client.release()
    }
  }
  const schedule: JitteredIntervalHandle = startJitteredInterval(() => {
    inFlight = tick()
      .catch(error => console.error('[conversation-record-conversion] page failed:', error))
      .finally(() => { inFlight = null })
    return inFlight
  }, INTERVAL_MS)
  return { async stop() { stopJitteredInterval(schedule); await inFlight } }
}
