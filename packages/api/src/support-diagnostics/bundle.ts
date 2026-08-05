import os from 'node:os'
import { query } from '../db/client.js'
import { getSessionMessages } from '../db/sessions.js'
import { gateSessionRead } from '../routes/sessions.js'
import { pseudonymize, scrubCapsuleValue } from './sanitize.js'
import type {
  SupportDiagnosticCapture,
  SupportDiagnosticPreview,
  SupportDiagnosticsStore,
} from './types.js'

type SessionRow = {
  id: string
  assistantId: string
  userId: string
  workspaceId: string
  channelType: string
  appOrigin: string | null
  status: string
  mode: string | null
  visibility: string | null
  effectiveClearance: string | null
  compactionCount: number
  createdAt: Date
  lastActiveAt: Date
}

export type SupportCapsule = {
  schemaVersion: 1
  generatedAt: string
  manifest: {
    captureId: string
    startedAt: string
    expiresAt: string
    includeContent: boolean
    selectedSessionId: string | null
    categories: Array<{ name: string; count: number }>
    exclusions: string[]
  }
  system: Record<string, unknown>
  database: {
    migrations: string[]
    health: Record<string, number>
  }
  captureEvents: unknown[]
  analyticsEvents: unknown[]
  session: unknown | null
  sessionMessages: unknown[]
  workflowRuns: unknown[]
  scheduledJobs: unknown[]
}

export class SupportDiagnosticNotFoundError extends Error {
  constructor(message = 'No active support capture was found') {
    super(message)
    this.name = 'SupportDiagnosticNotFoundError'
  }
}

export class SupportDiagnosticSessionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'SupportDiagnosticSessionError'
  }
}

export class SupportCapsuleBuilder {
  constructor(private readonly store: SupportDiagnosticsStore) {}

  async preview(params: {
    userId: string
    workspaceId: string
    sessionId?: string
  }): Promise<SupportDiagnosticPreview> {
    const { capsule } = await this.build(params)
    return {
      captureId: capsule.manifest.captureId,
      expiresAt: capsule.manifest.expiresAt,
      includeContent: capsule.manifest.includeContent,
      selectedSessionId: capsule.manifest.selectedSessionId,
      categories: capsule.manifest.categories,
      warnings: [
        'Credentials, environment values, file bytes, and database dumps are always excluded.',
        capsule.manifest.includeContent
          ? 'Selected session message and tool content is included after credential redaction.'
          : 'Message and tool content is omitted; only structural session metadata is included.',
      ],
    }
  }

  async build(params: {
    userId: string
    workspaceId: string
    sessionId?: string
  }): Promise<{ capture: SupportDiagnosticCapture; capsule: SupportCapsule }> {
    const capture = await this.store.getOwnedActive(params.userId, params.workspaceId)
    if (!capture) throw new SupportDiagnosticNotFoundError()

    const session = await this.resolveSession(capture, params.sessionId)
    const events = await this.store.listEvents(capture.id)
    const messages = session ? await getSessionMessages(session.id, { limit: 1_000 }) : []

    const analyticsResult = await query<Record<string, unknown>>(
      `SELECT e.id,
              e.user_id AS "userId",
              e.assistant_id AS "assistantId",
              e.session_id AS "sessionId",
              e.event_name AS "eventName",
              e.metadata,
              e.channel_type AS "channelType",
              e.app_id AS "appId",
              e.created_at AS "createdAt"
       FROM analytics_events e
       WHERE e.user_id = $1
         AND e.created_at BETWEEN $2 AND $3
         AND (
           ($4::uuid IS NOT NULL AND e.session_id = $4)
           OR e.assistant_id IN (
             SELECT id FROM assistants WHERE workspace_id = $5
           )
           OR e.assistant_id IS NULL
         )
       ORDER BY e.created_at
       LIMIT 1_000`,
      [capture.userId, capture.startedAt, capture.expiresAt, session?.id ?? null, capture.workspaceId],
    )

    const workflowResult = await query<Record<string, unknown>>(
      `SELECT id,
              workflow_id AS "workflowId",
              triggered_by AS "triggeredBy",
              trigger_kind AS "triggerKind",
              status,
              current_step_id AS "currentStepId",
              error,
              started_at AS "startedAt",
              finished_at AS "finishedAt",
              last_active_at AS "lastActiveAt"
       FROM workflow_runs
       WHERE workspace_id = $1
         AND started_at BETWEEN $2 AND $3
       ORDER BY started_at
       LIMIT 250`,
      [capture.workspaceId, capture.startedAt, capture.expiresAt],
    )

    const jobsResult = await query<Record<string, unknown>>(
      `SELECT j.id,
              j.assistant_id AS "assistantId",
              j.mode,
              j.enabled,
              j.next_run_at AS "nextRunAt",
              j.last_run_at AS "lastRunAt",
              j.last_status AS "lastStatus",
              j.created_at AS "createdAt",
              j.updated_at AS "updatedAt",
              j.workflow_id AS "workflowId",
              j.workflow_step_run_id AS "workflowStepRunId"
       FROM scheduled_jobs j
       JOIN assistants a ON a.id = j.assistant_id
       WHERE a.workspace_id = $1
         AND (
           j.created_at BETWEEN $2 AND $3
           OR j.updated_at BETWEEN $2 AND $3
           OR j.last_run_at BETWEEN $2 AND $3
         )
       ORDER BY j.updated_at
       LIMIT 250`,
      [capture.workspaceId, capture.startedAt, capture.expiresAt],
    )

    const migrationsResult = await query<{ name: string }>(
      `SELECT name FROM _migrations ORDER BY name`,
    )
    const healthResult = await query<{
      sessions: string
      messages: string
      analytics: string
      failedWorkflows: string
      archiveMessages: string
      archiveUnembedded: string
      archiveOutboxPending: string
      archiveOutboxDead: string
      archiveEnrichmentFailed: string
      archiveBackfillsFailed: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM sessions s
          JOIN assistants a ON a.id = s.assistant_id
          WHERE a.workspace_id = $1) AS sessions,
         (SELECT count(*)::text FROM session_messages m
          JOIN sessions s ON s.id = m.session_id
          JOIN assistants a ON a.id = s.assistant_id
          WHERE a.workspace_id = $1) AS messages,
         (SELECT count(*)::text FROM analytics_events e
          WHERE e.user_id = $2 AND e.created_at BETWEEN $3 AND $4) AS analytics,
         (SELECT count(*)::text FROM workflow_runs
          WHERE workspace_id = $1 AND status IN ('failed', 'timeout')) AS "failedWorkflows",
         (SELECT count(*)::text FROM chat_archive_messages
          WHERE workspace_id = $1) AS "archiveMessages",
         (SELECT count(*)::text FROM chat_archive_segments
          WHERE workspace_id = $1 AND embedding IS NULL) AS "archiveUnembedded",
         (SELECT count(*)::text FROM ingest_outbox o
          JOIN ingest_external_sink s ON s.id = o.sink_id
          WHERE o.workspace_id = $1
            AND s.managed_by = 'local_chat_archive'
            AND o.status IN ('pending', 'processing')) AS "archiveOutboxPending",
         (SELECT count(*)::text FROM ingest_outbox o
          JOIN ingest_external_sink s ON s.id = o.sink_id
          WHERE o.workspace_id = $1
            AND s.managed_by = 'local_chat_archive'
            AND o.status = 'dead') AS "archiveOutboxDead",
         (SELECT count(*)::text FROM chat_archive_enrichment_windows
          WHERE workspace_id = $1 AND status IN ('failed', 'dead')) AS "archiveEnrichmentFailed",
         (SELECT count(*)::text FROM chat_archive_backfill_runs
          WHERE workspace_id = $1 AND status = 'failed') AS "archiveBackfillsFailed"`,
      [capture.workspaceId, capture.userId, capture.startedAt, capture.expiresAt],
    )

    const scrubMetadata = (value: unknown, allowContent = false) =>
      scrubCapsuleValue(value, capture.pseudonymSalt, { allowContent })

    const sessionMessages = messages.map((message) => {
      const base: Record<string, unknown> = {
        id: pseudonymize(message.id, capture.pseudonymSalt),
        role: message.role,
        sequenceNum: message.sequenceNum,
        createdAt: message.createdAt,
        hasAttachments: message.attachments.length > 0,
      }
      if (capture.includeContent) {
        base.content = scrubMetadata(message.content, true)
        base.replyToText = scrubMetadata(message.replyToText, true)
      } else {
        base.contentShape = summarizeContent(message.content)
      }
      return base
    })

    const categories = [
      { name: 'captureEvents', count: events.length },
      { name: 'analyticsEvents', count: analyticsResult.rows.length },
      { name: 'sessionMessages', count: sessionMessages.length },
      { name: 'workflowRuns', count: workflowResult.rows.length },
      { name: 'scheduledJobs', count: jobsResult.rows.length },
      { name: 'migrations', count: migrationsResult.rows.length },
    ]

    const capsule: SupportCapsule = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      manifest: {
        captureId: pseudonymize(capture.id, capture.pseudonymSalt, 'capture'),
        startedAt: capture.startedAt.toISOString(),
        expiresAt: capture.expiresAt.toISOString(),
        includeContent: capture.includeContent,
        selectedSessionId: session
          ? pseudonymize(session.id, capture.pseudonymSalt, 'session')
          : null,
        categories,
        exclusions: [
          'credentials and authentication material',
          'environment variable values',
          'database dumps and unrelated rows',
          'file bytes and filesystem contents',
          'raw user, workspace, assistant, session, and message identifiers',
        ],
      },
      system: {
        edition: 'oss',
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        hostname: pseudonymize(os.hostname(), capture.pseudonymSalt, 'host'),
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageBytes: process.memoryUsage(),
        configuredCapabilities: {
          gemini: Boolean(process.env.GEMINI_API_KEY || process.env.VERTEX_PROJECT_ID),
          anthropicFallback: Boolean(process.env.ANTHROPIC_API_KEY),
          dashscope: Boolean(process.env.DASHSCOPE_API_KEY),
          localFiles: Boolean(process.env.LOCAL_FILES_DIR),
          browserRelay: Boolean(process.env.BROWSER_RELAY_URL),
          localMessageStore: Boolean(
            process.env.BRIAN_MESSAGE_STORE_URL && process.env.BRIAN_MESSAGE_STORE_HMAC_SECRET,
          ),
        },
      },
      database: {
        migrations: migrationsResult.rows.map((row) => row.name),
        health: {
          sessions: Number.parseInt(healthResult.rows[0]?.sessions ?? '0', 10),
          messages: Number.parseInt(healthResult.rows[0]?.messages ?? '0', 10),
          analytics: Number.parseInt(healthResult.rows[0]?.analytics ?? '0', 10),
          failedWorkflows: Number.parseInt(healthResult.rows[0]?.failedWorkflows ?? '0', 10),
          archiveMessages: Number.parseInt(healthResult.rows[0]?.archiveMessages ?? '0', 10),
          archiveUnembedded: Number.parseInt(healthResult.rows[0]?.archiveUnembedded ?? '0', 10),
          archiveOutboxPending: Number.parseInt(healthResult.rows[0]?.archiveOutboxPending ?? '0', 10),
          archiveOutboxDead: Number.parseInt(healthResult.rows[0]?.archiveOutboxDead ?? '0', 10),
          archiveEnrichmentFailed: Number.parseInt(healthResult.rows[0]?.archiveEnrichmentFailed ?? '0', 10),
          archiveBackfillsFailed: Number.parseInt(healthResult.rows[0]?.archiveBackfillsFailed ?? '0', 10),
        },
      },
      captureEvents: events.map((event) => ({
        level: event.level,
        message: event.message,
        fingerprint: event.fingerprint,
        createdAt: event.createdAt,
      })),
      analyticsEvents: analyticsResult.rows.map((row) => scrubMetadata(row)),
      session: session ? scrubMetadata(session) : null,
      sessionMessages,
      workflowRuns: workflowResult.rows.map((row) => scrubMetadata(row)),
      scheduledJobs: jobsResult.rows.map((row) => scrubMetadata(row)),
    }

    return { capture, capsule }
  }

  private async resolveSession(
    capture: SupportDiagnosticCapture,
    requestedSessionId?: string,
  ): Promise<SessionRow | null> {
    const values: unknown[] = [capture.workspaceId, capture.userId]
    let predicate = `s.user_id = $2`
    if (requestedSessionId) {
      values.push(requestedSessionId)
      predicate = `s.id = $3`
    }
    const result = await query<SessionRow>(
      `SELECT s.id,
              s.assistant_id AS "assistantId",
              s.user_id AS "userId",
              COALESCE(s.workspace_id, a.workspace_id) AS "workspaceId",
              s.channel_type AS "channelType",
              s.app_origin AS "appOrigin",
              s.status,
              s.mode,
              s.visibility,
              s.effective_clearance AS "effectiveClearance",
              s.compaction_count AS "compactionCount",
              s.created_at AS "createdAt",
              s.last_active_at AS "lastActiveAt"
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       WHERE a.workspace_id = $1
         AND ${predicate}
       ORDER BY s.last_active_at DESC
       LIMIT 1`,
      values,
    )
    const session = result.rows[0]
    if (!session) {
      if (requestedSessionId) {
        throw new SupportDiagnosticSessionError('Session was not found in this workspace', 404)
      }
      return null
    }
    const denied = await gateSessionRead(capture.userId, session)
    if (denied) throw new SupportDiagnosticSessionError(denied.error, denied.status)
    return {
      ...session,
      createdAt: new Date(session.createdAt),
      lastActiveAt: new Date(session.lastActiveAt),
    }
  }
}

function summarizeContent(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') return { kind: 'string', characterCount: content.length }
  if (Array.isArray(content)) {
    const toolNames = content
      .slice(0, 100)
      .flatMap((block) => {
        if (!block || typeof block !== 'object') return []
        const record = block as Record<string, unknown>
        return typeof record.name === 'string' &&
          (record.type === 'tool_use' || record.type === 'tool_result')
          ? [record.name]
          : []
      })
    return {
      kind: 'blocks',
      blockCount: content.length,
      blockTypes: content.slice(0, 100).map((block) =>
        block && typeof block === 'object' && 'type' in block
          ? String((block as { type: unknown }).type)
          : typeof block),
      toolNames: [...new Set(toolNames)],
    }
  }
  if (content && typeof content === 'object') {
    return { kind: 'object', keys: Object.keys(content as Record<string, unknown>).slice(0, 25) }
  }
  return { kind: typeof content }
}
