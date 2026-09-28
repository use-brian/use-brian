/** Bounded durable provider recovery under OSS runWorkers. [COMP:crm/provider-inbox] */
import { query } from '../db/client.js'
export function createProviderInboxWorker(options: {
  due?: (after: string | null, limit: number) => Promise<Array<{ id: string; workspaceId: string }>>
  process: (workspaceId: string, receiptId: string) => Promise<unknown>
  onError?: () => void
  intervalMs?: number
}) {
  const due = options.due ?? (async (after, limit) => (await query<{ id: string; workspaceId: string }>(`SELECT id,workspace_id AS "workspaceId"
    FROM association_integration_events WHERE ($1::uuid IS NULL OR id>$1) AND (
      (state IN('pending','retry') AND next_attempt_at<=clock_timestamp()) OR (state='processing' AND lease_expires_at<=clock_timestamp()))
    ORDER BY id LIMIT $2`, [after, limit])).rows)
  const process = options.process
  let cursor: string | null = null, timer: ReturnType<typeof setInterval> | null = null, running: Promise<number> | null = null
  async function perform() {
    let count = 0
    for (let page = 0; page < 10; page++) {
      const rows = await due(cursor, 100)
      for (const row of rows) {
        try { await process(row.workspaceId, row.id) } catch { options.onError?.() }
        cursor = row.id; count++
      }
      if (rows.length < 100) { cursor = null; break }
    }
    return count
  }
  const tick = () => running ?? (running = perform().catch(() => { options.onError?.(); return 0 }).finally(() => { running = null }))
  return { tick, start() { if (timer) return; timer = setInterval(() => void tick(), Math.max(1000, options.intervalMs ?? 60_000)); timer.unref?.(); void tick() },
    stop() { if (timer) clearInterval(timer); timer = null } }
}
