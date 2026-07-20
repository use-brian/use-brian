import type { AnalyticsStore, AnalyticsEvent, DailyReport, WeeklyReport } from '@use-brian/core'
import { query } from './client.js'

export function createDbAnalyticsStore(): AnalyticsStore {
  return {
    async record(event) {
      await query(
        `INSERT INTO analytics_events (user_id, actor_user_id, assistant_id, session_id, event_name, metadata, channel_type, app_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [event.userId, event.actorUserId ?? event.userId, event.assistantId ?? null, event.sessionId ?? null, event.eventName, JSON.stringify(event.metadata), event.channelType ?? null, event.appId ?? null],
      )
    },

    async recordBatch(events) {
      if (events.length === 0) return
      // Build multi-row INSERT for efficiency
      const values: unknown[] = []
      const placeholders: string[] = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        const offset = i * 8
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`)
        values.push(e.userId, e.actorUserId ?? e.userId, e.assistantId ?? null, e.sessionId ?? null, e.eventName, JSON.stringify(e.metadata), e.channelType ?? null, e.appId ?? null)
      }
      await query(
        `INSERT INTO analytics_events (user_id, actor_user_id, assistant_id, session_id, event_name, metadata, channel_type, app_id)
         VALUES ${placeholders.join(', ')}`,
        values,
      )
    },

    async getDailyReport(date) {
      const targetDate = date ?? new Date().toISOString().split('T')[0]
      const [usage, engagement, tools, memory, errors, intelligence] = await Promise.all([
        getUsageMetrics(targetDate),
        getEngagementMetrics(targetDate),
        getToolMetrics(targetDate),
        getMemoryMetrics(targetDate),
        getErrorMetrics(targetDate),
        getIntelligenceMetrics(targetDate),
      ])
      return { date: targetDate, usage, engagement, tools, memory, errors, intelligence }
    },

    async listErrors(params) {
      const sinceHours = params.sinceHours ?? 24
      const limit = Math.min(params.limit ?? 100, 500)
      const result = await query<{
        id: string; user_id: string; assistant_id: string | null; session_id: string | null;
        event_name: string; metadata: Record<string, unknown>; channel_type: string | null;
        created_at: Date;
      }>(
        `SELECT id, user_id, assistant_id, session_id, event_name, metadata, channel_type, created_at
         FROM analytics_events
         WHERE event_name LIKE '%\\_error' ESCAPE '\\'
           AND created_at >= now() - ($1 || ' hours')::interval
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceHours, limit],
      )
      return result.rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        assistantId: r.assistant_id,
        sessionId: r.session_id,
        eventName: r.event_name,
        errorType: (r.metadata?.error_type as string) ?? 'unknown',
        metadata: r.metadata,
        channelType: r.channel_type,
        createdAt: r.created_at.toISOString(),
      }))
    },

    async summarizeErrors(params) {
      const sinceHours = params.sinceHours ?? 24
      const result = await query<{
        event_name: string; error_type: string; count: string;
        unique_users: string; first_seen: Date; last_seen: Date;
      }>(
        `SELECT
           event_name,
           COALESCE(metadata->>'error_type', 'unknown') as error_type,
           COUNT(*) as count,
           COUNT(DISTINCT user_id) as unique_users,
           MIN(created_at) as first_seen,
           MAX(created_at) as last_seen
         FROM analytics_events
         WHERE event_name LIKE '%\\_error' ESCAPE '\\'
           AND created_at >= now() - ($1 || ' hours')::interval
         GROUP BY event_name, error_type
         ORDER BY count DESC`,
        [sinceHours],
      )
      return result.rows.map((r) => ({
        eventName: r.event_name,
        errorType: r.error_type,
        count: parseInt(r.count, 10),
        uniqueUsers: parseInt(r.unique_users, 10),
        firstSeen: r.first_seen.toISOString(),
        lastSeen: r.last_seen.toISOString(),
      }))
    },

    async pruneOldEvents(retentionDays) {
      const result = await query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM analytics_events
           WHERE created_at < now() - ($1 || ' days')::interval
           RETURNING id
         ) SELECT COUNT(*) as count FROM deleted`,
        [retentionDays],
      )
      return parseInt(result.rows[0]?.count ?? '0', 10)
    },

    async getWeeklyReport(endDate) {
      const end = endDate ?? new Date().toISOString().split('T')[0]
      const start = new Date(new Date(end).getTime() - 6 * 86400000).toISOString().split('T')[0]
      const prevStart = new Date(new Date(start).getTime() - 7 * 86400000).toISOString().split('T')[0]

      // Get daily reports for the week
      const dailyReports: DailyReport[] = []
      for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0]
        const report = await this.getDailyReport(dateStr)
        dailyReports.push(report)
      }

      // Totals
      const totalRetrievals = dailyReports.reduce((s, d) => s + d.intelligence.totalMemoryRetrieval, 0)
      const hitRateSum = dailyReports.reduce((s, d) => s + d.intelligence.retrievalHitRate, 0)
      const daysWithRetrievals = dailyReports.filter((d) => d.intelligence.totalMemoryRetrieval > 0).length

      const totals = {
        totalCostUsd: dailyReports.reduce((s, d) => s + d.usage.totalCostUsd, 0),
        totalTurns: dailyReports.reduce((s, d) => s + d.usage.totalTurns, 0),
        uniqueUsers: await getUniqueUsersInRange(start, end),
        activeSessions: dailyReports.reduce((s, d) => s + d.engagement.activeSessions, 0),
        totalToolExecutions: dailyReports.reduce((s, d) => s + d.tools.totalExecutions, 0),
        totalMemoriesCreated: dailyReports.reduce((s, d) => s + d.memory.memoriesCreated, 0),
        totalErrors: dailyReports.reduce((s, d) => s + d.errors.total, 0),
        totalRetrievals,
        avgRetrievalHitRate: daysWithRetrievals > 0 ? hitRateSum / daysWithRetrievals : 0,
        totalConsolidationRuns: dailyReports.reduce((s, d) => s + d.intelligence.consolidationRuns, 0),
        totalSoulUpdates: dailyReports.reduce((s, d) => s + d.intelligence.soulUpdates, 0),
      }

      // Previous week totals for trends
      const prevTotals = await getPreviousWeekTotals(prevStart, start)
      const pct = (curr: number, prev: number) => prev === 0 ? 0 : Math.round(((curr - prev) / prev) * 100)

      return {
        startDate: start,
        endDate: end,
        daily: dailyReports,
        totals,
        trends: {
          costTrend: pct(totals.totalCostUsd, prevTotals.cost),
          turnsTrend: pct(totals.totalTurns, prevTotals.turns),
          usersTrend: pct(totals.uniqueUsers, prevTotals.users),
          errorRateTrend: pct(totals.totalErrors, prevTotals.errors),
          retrievalHitRateTrend: pct(totals.avgRetrievalHitRate, prevTotals.retrievalHitRate),
        },
      }
    },
  }
}

// ── Usage metrics (from usage_tracking + daily_usage) ─────────

async function getUsageMetrics(date: string) {
  const [costRow, modelRows] = await Promise.all([
    query<{ total_cost: string; total_turns: string; unique_users: string }>(
      `SELECT
         COALESCE(SUM(total_actual_cost), 0) as total_cost,
         COALESCE(SUM(total_turns), 0) as total_turns,
         COUNT(DISTINCT user_id) as unique_users
       FROM daily_usage WHERE date = $1`,
      [date],
    ),
    query<{ model: string; turns: string; cost: string; main_cost: string; overhead_cost: string }>(
      `SELECT model, COUNT(*) as turns,
              COALESCE(SUM(actual_cost_usd), 0) as cost,
              COALESCE(SUM(actual_cost_usd) FILTER (WHERE source NOT LIKE 'overhead:%'), 0) AS main_cost,
              COALESCE(SUM(actual_cost_usd) FILTER (WHERE source LIKE 'overhead:%'), 0) AS overhead_cost
       FROM usage_tracking WHERE created_at::date = $1
       GROUP BY model ORDER BY cost DESC`,
      [date],
    ),
  ])

  const row = costRow.rows[0]
  const totalCost = parseFloat(row?.total_cost ?? '0')
  const totalTurns = parseInt(row?.total_turns ?? '0', 10)
  const uniqueUsers = parseInt(row?.unique_users ?? '0', 10)

  return {
    totalCostUsd: totalCost,
    totalTurns,
    uniqueUsers,
    avgCostPerUser: uniqueUsers > 0 ? totalCost / uniqueUsers : 0,
    avgTurnsPerUser: uniqueUsers > 0 ? totalTurns / uniqueUsers : 0,
    byModel: modelRows.rows.map((r) => ({
      model: r.model,
      turns: parseInt(r.turns, 10),
      costUsd: parseFloat(r.cost),
      mainCostUsd: parseFloat(r.main_cost),
      overheadCostUsd: parseFloat(r.overhead_cost),
    })),
  }
}

// ── Engagement metrics (from sessions + analytics_events) ─────

async function getEngagementMetrics(date: string) {
  const [sessionRow, channelRows] = await Promise.all([
    query<{ active: string; new_sessions: string }>(
      `SELECT
         COUNT(DISTINCT CASE WHEN last_active_at::date = $1 THEN id END) as active,
         COUNT(DISTINCT CASE WHEN created_at::date = $1 THEN id END) as new_sessions
       FROM sessions WHERE created_at::date = $1 OR last_active_at::date = $1`,
      [date],
    ),
    query<{ channel: string; sessions: string; turns: string }>(
      `SELECT s.channel_type as channel,
              COUNT(DISTINCT s.id) as sessions,
              COALESCE(SUM(du.total_turns), 0) as turns
       FROM sessions s
       LEFT JOIN usage_tracking ut ON ut.session_id = s.id AND ut.created_at::date = $1
       LEFT JOIN daily_usage du ON du.user_id = s.user_id AND du.date = $1
       WHERE s.last_active_at::date = $1 OR s.created_at::date = $1
       GROUP BY s.channel_type`,
      [date],
    ),
  ])

  const active = parseInt(sessionRow.rows[0]?.active ?? '0', 10)
  const newSessions = parseInt(sessionRow.rows[0]?.new_sessions ?? '0', 10)

  // Average turns per session from usage_tracking
  const avgResult = await query<{ avg_turns: string }>(
    `SELECT COALESCE(AVG(turn_count), 0) as avg_turns FROM (
       SELECT session_id, COUNT(*) as turn_count
       FROM usage_tracking WHERE created_at::date = $1
       GROUP BY session_id
     ) sub`,
    [date],
  )

  return {
    activeSessions: active,
    newSessions,
    avgTurnsPerSession: parseFloat(avgResult.rows[0]?.avg_turns ?? '0'),
    byChannel: channelRows.rows.map((r) => ({
      channel: r.channel,
      sessions: parseInt(r.sessions, 10),
      turns: parseInt(r.turns, 10),
    })),
  }
}

// ── Tool metrics (from analytics_events) ──────────────────────

async function getToolMetrics(date: string) {
  const result = await query<{ tool: string; total: string; succeeded: string }>(
    `SELECT
       metadata->>'tool_name' as tool,
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE (metadata->>'success')::boolean = true) as succeeded
     FROM analytics_events
     WHERE event_name = 'tool_executed' AND created_at::date = $1
     GROUP BY metadata->>'tool_name'
     ORDER BY total DESC`,
    [date],
  )

  const byTool = result.rows.map((r) => ({
    tool: r.tool,
    count: parseInt(r.total, 10),
    successRate: parseInt(r.total, 10) > 0
      ? parseInt(r.succeeded, 10) / parseInt(r.total, 10)
      : 0,
  }))

  return {
    totalExecutions: byTool.reduce((s, t) => s + t.count, 0),
    byTool,
  }
}

// ── Memory metrics (from analytics_events + memories) ─────────

async function getMemoryMetrics(date: string) {
  const [created, retrieved, compaction, byType] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM memories WHERE created_at::date = $1`,
      [date],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM analytics_events
       WHERE event_name = 'memory_retrieved' AND created_at::date = $1`,
      [date],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM analytics_events
       WHERE event_name = 'compaction_triggered' AND created_at::date = $1`,
      [date],
    ),
    query<{ type: string; count: string }>(
      `SELECT type, COUNT(*) as count FROM memories
       WHERE created_at::date = $1 GROUP BY type`,
      [date],
    ),
  ])

  return {
    memoriesCreated: parseInt(created.rows[0]?.count ?? '0', 10),
    memoriesRetrieved: parseInt(retrieved.rows[0]?.count ?? '0', 10),
    compactionTriggered: parseInt(compaction.rows[0]?.count ?? '0', 10),
    byType: byType.rows.map((r) => ({ type: r.type, count: parseInt(r.count, 10) })),
  }
}

// ── Error metrics (from analytics_events) ─────────────────────

async function getErrorMetrics(date: string) {
  const result = await query<{ error_type: string; count: string }>(
    `SELECT
       COALESCE(metadata->>'error_type', 'unknown') as error_type,
       COUNT(*) as count
     FROM analytics_events
     WHERE event_name LIKE '%_error' AND created_at::date = $1
     GROUP BY metadata->>'error_type'
     ORDER BY count DESC`,
    [date],
  )

  const byType = result.rows.map((r) => ({
    type: r.error_type,
    count: parseInt(r.count, 10),
  }))

  return {
    total: byType.reduce((s, e) => s + e.count, 0),
    byType,
  }
}

// ── Intelligence health metrics (self-evolving signals) ───────

async function getIntelligenceMetrics(date: string) {
  const [creation, retrieval, consolidation, soul] = await Promise.all([
    // Memory creation by source (model vs extraction)
    query<{ source: string; count: string }>(
      `SELECT COALESCE(metadata->>'source', 'unknown') as source, COUNT(*) as count
       FROM analytics_events
       WHERE event_name = 'memory_created' AND created_at::date = $1
       GROUP BY metadata->>'source'`,
      [date],
    ),
    // Retrieval stats: hits vs misses, avg result count
    query<{ total: string; hits: string; total_results: string }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE (metadata->>'hit')::boolean = true) as hits,
         COALESCE(SUM((metadata->>'result_count')::int), 0) as total_results
       FROM analytics_events
       WHERE event_name = 'memory_retrieved' AND created_at::date = $1`,
      [date],
    ),
    // Consolidation runs
    query<{ runs: string; merged: string; patterns: string }>(
      `SELECT
         COUNT(*) as runs,
         COALESCE(SUM((metadata->>'merged')::int), 0) as merged,
         COALESCE(SUM((metadata->>'patterns_found')::int), 0) as patterns
       FROM analytics_events
       WHERE event_name = 'consolidation_completed' AND created_at::date = $1`,
      [date],
    ),
    // SOUL updates
    query<{ updates: string; avg_drift: string }>(
      `SELECT
         COUNT(*) as updates,
         COALESCE(AVG((metadata->>'change_magnitude')::numeric), 0) as avg_drift
       FROM analytics_events
       WHERE event_name = 'soul_updated' AND created_at::date = $1`,
      [date],
    ),
  ])

  const bySource = Object.fromEntries(creation.rows.map((r) => [r.source, parseInt(r.count, 10)]))
  const ret = retrieval.rows[0]
  const totalRetrieval = parseInt(ret?.total ?? '0', 10)
  const hits = parseInt(ret?.hits ?? '0', 10)
  const totalResults = parseInt(ret?.total_results ?? '0', 10)
  const con = consolidation.rows[0]
  const soulRow = soul.rows[0]

  return {
    memoriesCreatedByModel: bySource['model'] ?? 0,
    memoriesCreatedByExtraction: bySource['instant'] ?? 0,
    totalMemoryRetrieval: totalRetrieval,
    retrievalHitRate: totalRetrieval > 0 ? hits / totalRetrieval : 0,
    retrievalEmptyRate: totalRetrieval > 0 ? (totalRetrieval - hits) / totalRetrieval : 0,
    avgResultsPerSearch: totalRetrieval > 0 ? totalResults / totalRetrieval : 0,
    consolidationRuns: parseInt(con?.runs ?? '0', 10),
    consolidationMerged: parseInt(con?.merged ?? '0', 10),
    consolidationPatternsFound: parseInt(con?.patterns ?? '0', 10),
    soulUpdates: parseInt(soulRow?.updates ?? '0', 10),
    avgSoulDrift: parseFloat(soulRow?.avg_drift ?? '0'),
  }
}

// ── Helpers ───────────────────────────────────────────────────

async function getUniqueUsersInRange(start: string, end: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT user_id) as count FROM daily_usage WHERE date >= $1 AND date <= $2`,
    [start, end],
  )
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

async function getPreviousWeekTotals(start: string, end: string) {
  const [usage, users, errors, retrieval] = await Promise.all([
    query<{ cost: string; turns: string }>(
      `SELECT COALESCE(SUM(total_actual_cost), 0) as cost, COALESCE(SUM(total_turns), 0) as turns
       FROM daily_usage WHERE date >= $1 AND date < $2`,
      [start, end],
    ),
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT user_id) as count FROM daily_usage WHERE date >= $1 AND date < $2`,
      [start, end],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM analytics_events
       WHERE event_name LIKE '%_error' AND created_at >= $1::date AND created_at < $2::date`,
      [start, end],
    ),
    query<{ total: string; hits: string }>(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE (metadata->>'hit')::boolean = true) as hits
       FROM analytics_events
       WHERE event_name = 'memory_retrieved' AND created_at >= $1::date AND created_at < $2::date`,
      [start, end],
    ),
  ])
  const retTotal = parseInt(retrieval.rows[0]?.total ?? '0', 10)
  const retHits = parseInt(retrieval.rows[0]?.hits ?? '0', 10)
  return {
    cost: parseFloat(usage.rows[0]?.cost ?? '0'),
    turns: parseInt(usage.rows[0]?.turns ?? '0', 10),
    users: parseInt(users.rows[0]?.count ?? '0', 10),
    errors: parseInt(errors.rows[0]?.count ?? '0', 10),
    retrievalHitRate: retTotal > 0 ? retHits / retTotal : 0,
  }
}
