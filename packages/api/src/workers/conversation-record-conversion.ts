/** [COMP:api/conversation-record-conversion] Bounded owner-side maintenance. */
import { startJitteredInterval, stopJitteredInterval, type JitteredIntervalHandle } from '@use-brian/core/scheduling/jitter.js'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool } from '../db/client.js'

const INTERVAL_MS = 2_000
const UNITS_PER_PAGE = 32
const BYTES_PER_PAGE = 4 * 1024 * 1024
const SINGLE_SESSION_RETRY_MS = 8_000
const MAX_BACKFILL_RETRY_MS = 60_000

async function runPage<Row extends QueryResultRow>(client: PoolClient, sql: string, values: number[]) {
  await client.query('BEGIN')
  try {
    await client.query("SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='3s'")
    const result = await client.query<Row>(sql, values)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === '55P03' || code === '57014') return null
    throw error
  }
}

export async function startConversationRecordConversionWorker() {
  const pool = getPool()
  const capabilities = (await pool.query<{ installed: boolean; backfill: boolean }>(`SELECT
    to_regprocedure('public.compile_conversation_record_page(integer,integer)') IS NOT NULL
    AND to_regprocedure('public.enroll_existing_conversation_records(integer)') IS NOT NULL AS installed,
    to_regprocedure('public.advance_conversation_envelope_backfill(integer)') IS NOT NULL AS backfill`)).rows[0]
  if (!capabilities?.installed) return null

  let backfillDone = !capabilities.backfill
  let backfillUnits = UNITS_PER_PAGE
  let backfillRetryAt = 0
  let backfillRetryMs = SINGLE_SESSION_RETRY_MS
  let inFlight: Promise<void> | null = null
  const tick = async () => {
    const client = await pool.connect()
    let connectionFailure: Error | undefined
    try {
      if (!backfillDone && performance.now() >= backfillRetryAt) {
        const result = await runPage<{ value: { done?: boolean; scanned: number } }>(client,
          'SELECT public.advance_conversation_envelope_backfill($1) AS value', [backfillUnits])
        const progress = result?.rows[0]?.value
        if (progress?.done) backfillDone = true
        if (progress?.scanned) {
          backfillUnits = Math.min(UNITS_PER_PAGE, backfillUnits + 1)
          backfillRetryMs = SINGLE_SESSION_RETRY_MS
        }
        if (!result) {
          if (backfillUnits > 1) {
            backfillUnits = Math.floor(backfillUnits / 2)
          } else {
            backfillRetryAt = performance.now() + backfillRetryMs
            backfillRetryMs = Math.min(MAX_BACKFILL_RETRY_MS, backfillRetryMs * 2)
          }
        }
      }
      await runPage(client, 'SELECT public.enroll_existing_conversation_records($1)', [UNITS_PER_PAGE])
      await runPage(client, 'SELECT public.compile_conversation_record_page($1,$2)', [UNITS_PER_PAGE, BYTES_PER_PAGE])
    } catch (error) {
      connectionFailure = error instanceof Error ? error : new Error('Failed conversation conversion transaction')
      throw error
    } finally {
      client.release(connectionFailure)
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
