import { AsyncLocalStorage } from 'node:async_hooks'
import type { SqlPoolLabel } from './turn-sql-accounting.js'

/** Numeric request timings independent of the opt-in statement ledger. [COMP:api/turn-timings] */
type Operation = 'checkout' | 'query'
type Bucket = { count: number; failed: number; elapsedMs: number; maxMs: number }
const storage = new AsyncLocalStorage<{ active: boolean; buckets: Map<string, Bucket> }>()

export async function withChatDatabaseTiming<T>(run: () => Promise<T>): Promise<T> {
  const stats = { active: true, buckets: new Map<string, Bucket>() }
  try {
    return await storage.run(stats, run)
  } finally {
    stats.active = false
  }
}

/** Capture the submitter. A queued checkout may be delivered by another turn's release. */
export function startChatDatabaseTiming(pool: SqlPoolLabel, operation: Operation) {
  const stats = storage.getStore()
  if (!stats?.active) return undefined
  const key = `db_${pool}_${operation}`
  const start = performance.now()
  let done = false
  return (error: unknown) => {
    if (done || !stats.active) return
    done = true
    const ms = performance.now() - start
    const bucket = stats.buckets.get(key) ?? { count: 0, failed: 0, elapsedMs: 0, maxMs: 0 }
    bucket.count++
    if (error != null) bucket.failed++
    bucket.elapsedMs += ms
    bucket.maxMs = Math.max(bucket.maxMs, ms)
    stats.buckets.set(key, bucket)
  }
}

export function chatDatabaseTimingSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = {}
  const stats = storage.getStore()
  if (!stats) return snapshot
  for (const [key, bucket] of stats.buckets) {
    snapshot[`${key}_count`] = bucket.count
    snapshot[`${key}_failed_count`] = bucket.failed
    snapshot[`${key}_ms`] = Math.round(bucket.elapsedMs)
    snapshot[`${key}_max_ms`] = Math.round(bucket.maxMs)
  }
  return snapshot
}
