/**
 * Type-safe analytics logger.
 *
 * Only numbers and booleans are accepted as metadata values.
 * Strings require explicit sanitization to prevent accidental PII leaks.
 * Events are fire-and-forget — never block the main request path.
 */

// ── Type-safe metadata ────────────────────────────────────────

type SafeValue = number | boolean | undefined

/** Branded string type — forces developer to acknowledge the value is safe */
type SanitizedString = string & { readonly __sanitized: true }

/** Mark a string as sanitized (developer acknowledges no PII) */
export function sanitize(value: string): SanitizedString {
  return value as SanitizedString
}

export type EventMetadata = Record<string, SafeValue | SanitizedString>

// ── Event types ───────────────────────────────────────────────

export type AnalyticsEvent = {
  /**
   * The party billed for the turn. For first-party traffic this is also
   * the actor; for public-API / team-custom-connector traffic this is
   * the API-key owner who pays for the request.
   */
  userId: string
  assistantId?: string
  sessionId?: string
  eventName: string
  metadata: EventMetadata
  channelType?: string
  appId?: string
  /**
   * The user who actually drove the turn. Equal to `userId` for
   * first-party traffic; the shadow user's id for public-API and team
   * custom connector traffic. The store fills this in from `userId` when
   * omitted, so existing call-sites stay unchanged. Migration 100.
   */
  actorUserId?: string
}

// ── Store interface ───────────────────────────────────────────

export type AnalyticsStore = {
  /** Insert a single event into analytics_events */
  record(event: AnalyticsEvent): Promise<void>

  /** Insert a batch of events */
  recordBatch(events: AnalyticsEvent[]): Promise<void>

  /** Daily system-wide aggregation */
  getDailyReport(date?: string): Promise<DailyReport>

  /** Weekly system-wide aggregation (last 7 days from date) */
  getWeeklyReport(date?: string): Promise<WeeklyReport>

  /** Delete raw events older than retentionDays. Returns count of deleted rows. */
  pruneOldEvents(retentionDays: number): Promise<number>

  /** List recent error events, newest first */
  listErrors(params: { sinceHours?: number; limit?: number }): Promise<ErrorEvent[]>

  /** Grouped error summary — for daily triage ("what broke today?") */
  summarizeErrors(params: { sinceHours?: number }): Promise<ErrorSummary[]>
}

export type ErrorEvent = {
  id: string
  userId: string
  assistantId: string | null
  sessionId: string | null
  eventName: string
  errorType: string
  metadata: Record<string, unknown>
  channelType: string | null
  createdAt: string
}

export type ErrorSummary = {
  eventName: string
  errorType: string
  count: number
  uniqueUsers: number
  firstSeen: string
  lastSeen: string
}

// ── Report types ──────────────────────────────────────────────

export type DailyReport = {
  date: string
  usage: {
    totalCostUsd: number
    totalTurns: number
    uniqueUsers: number
    avgCostPerUser: number
    avgTurnsPerUser: number
    byModel: Array<{ model: string; turns: number; costUsd: number }>
  }
  engagement: {
    activeSessions: number
    newSessions: number
    avgTurnsPerSession: number
    byChannel: Array<{ channel: string; sessions: number; turns: number }>
  }
  tools: {
    totalExecutions: number
    byTool: Array<{ tool: string; count: number; successRate: number }>
  }
  memory: {
    memoriesCreated: number
    memoriesRetrieved: number
    compactionTriggered: number
    byType: Array<{ type: string; count: number }>
  }
  errors: {
    total: number
    byType: Array<{ type: string; count: number }>
  }
  intelligence: {
    memoriesCreatedByModel: number
    memoriesCreatedByExtraction: number
    totalMemoryRetrieval: number
    retrievalHitRate: number          // % of getMemory searches that returned results
    retrievalEmptyRate: number        // % that returned nothing
    avgResultsPerSearch: number
    consolidationRuns: number
    consolidationMerged: number
    consolidationPatternsFound: number
    soulUpdates: number
    avgSoulDrift: number              // average change magnitude across soul_updated events
  }
}

export type WeeklyReport = {
  startDate: string
  endDate: string
  daily: DailyReport[]
  totals: {
    totalCostUsd: number
    totalTurns: number
    uniqueUsers: number
    activeSessions: number
    totalToolExecutions: number
    totalMemoriesCreated: number
    totalErrors: number
    totalRetrievals: number
    avgRetrievalHitRate: number
    totalConsolidationRuns: number
    totalSoulUpdates: number
  }
  trends: {
    costTrend: number        // % change vs previous week
    turnsTrend: number
    usersTrend: number
    errorRateTrend: number
    retrievalHitRateTrend: number
  }
}

// ── Logger class ──────────────────────────────────────────────

/**
 * Analytics logger — fire-and-forget event recording.
 *
 * Usage:
 *   const analytics = new AnalyticsLogger(store)
 *   analytics.logEvent({ userId, eventName: 'turn_completed', metadata: { ... } })
 *
 * Events are buffered and flushed in batches for efficiency.
 * Failures are swallowed — analytics must never break the product.
 */
export class AnalyticsLogger {
  private store: AnalyticsStore
  private buffer: AnalyticsEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly flushIntervalMs: number
  private readonly maxBufferSize: number

  constructor(store: AnalyticsStore, opts?: { flushIntervalMs?: number; maxBufferSize?: number }) {
    this.store = store
    this.flushIntervalMs = opts?.flushIntervalMs ?? 5000
    this.maxBufferSize = opts?.maxBufferSize ?? 50
  }

  /** Log a single analytics event (fire-and-forget) */
  logEvent(event: AnalyticsEvent): void {
    this.buffer.push(event)

    if (this.buffer.length >= this.maxBufferSize) {
      this.flush()
      return
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs)
    }
  }

  /** Flush buffer to store */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.buffer.length === 0) return

    const batch = this.buffer.splice(0)
    try {
      await this.store.recordBatch(batch)
    } catch (err) {
      console.error('[analytics] Flush failed:', err)
      // Events are lost — acceptable for analytics
    }
  }

  /** Graceful shutdown — flush remaining events */
  async shutdown(): Promise<void> {
    await this.flush()
  }
}
