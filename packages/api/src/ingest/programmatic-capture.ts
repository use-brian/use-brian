/**
 * Deterministic routed capture for Brain MCP events.
 *
 * The HTTP/MCP request does only cheap profile resolution, first-match rule
 * evaluation, deduplication, and a durable append. Scheduled rules never call
 * an LLM here. The dedicated processor below renders the complete pending
 * window and invokes Pipeline B once when the batch worker drains it.
 *
 * [COMP:api/programmatic-capture]
 */

import {
  composeFilters,
  computeNextRun,
  minSensitivity,
  resolveIngestRoute,
  universalFilters,
  type FilterRegistry,
  type IngestEvent,
  type IngestRule,
  type PendingBatch,
  type PipelineBResult,
  type Sensitivity,
} from '@use-brian/core'
import type { BrainAuth } from '../brain-mcp/auth.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { toEpisodeSensitivity } from '../episode-sensitivity.js'
import type {
  ProgrammaticCaptureRule,
  ProgrammaticCaptureStore,
  ProgrammaticCaptureTarget,
} from '../db/programmatic-capture-store.js'
import {
  appendProgrammaticBatchEvent,
  finishRealtimeProgrammaticEvent,
  getProgrammaticReceipt,
  recordDroppedProgrammaticEvent,
  reserveRealtimeProgrammaticEvent,
  type ProgrammaticCaptureReceiptStatus,
  type QueuedProgrammaticCaptureEvent,
} from '../db/pending-ingest-batches-store.js'

export type ProgrammaticMetadata = Record<string, string | number | boolean>

export type ProgrammaticCaptureInput = {
  eventId: string
  content: string
  occurredAt?: Date
  sessionId?: string
  subjectId?: string
  role?: 'user' | 'assistant' | 'system' | 'tool'
  sourceLabel?: string
  metadata?: ProgrammaticMetadata
}

export type ProgrammaticCaptureResult = {
  outcome: 'queued' | 'dropped' | 'processed' | 'duplicate'
  receiptStatus: ProgrammaticCaptureReceiptStatus
  profileId?: string
  ruleId?: string
  batchId?: string
  firesAt?: Date
  extraction?: PipelineBResult
}

export class ProgrammaticCaptureError extends Error {
  constructor(
    readonly code:
      | 'capture_profile_not_configured'
      | 'capture_partition_missing'
      | 'capture_rule_invalid'
      | 'capture_target_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ProgrammaticCaptureError'
  }
}

function scalarEquals(left: unknown, right: unknown): boolean {
  return ['string', 'number', 'boolean'].includes(typeof left) && left === right
}

const programmaticFilters: FilterRegistry = composeFilters(universalFilters, {
  role_match(event, params) {
    const values = Array.isArray(params.values) ? params.values : []
    return values.some((value) => typeof value === 'string' && value === event.normalized.role)
  },
  metadata_match(event, params) {
    const metadata = event.normalized.metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
    const key = typeof params.key === 'string' ? params.key : ''
    if (!key) return false
    const actual = (metadata as Record<string, unknown>)[key]
    if (Array.isArray(params.values)) {
      return params.values.some((expected) => scalarEquals(actual, expected))
    }
    return scalarEquals(actual, params.value)
  },
})

function asCoreRule(rule: ProgrammaticCaptureRule): IngestRule {
  return {
    id: rule.id,
    connector_instance_id: null,
    source: 'programmatic',
    rule_order: rule.ruleOrder,
    filter_type: rule.filterType,
    filter_params: rule.filterParams,
    routing_mode: rule.routingMode,
    routing_schedule: rule.routingSchedule,
    routing_timezone: rule.routingTimezone,
    alert: false,
    episode_sensitivity: rule.episodeSensitivity,
    compartments: rule.compartments,
    project_ids: rule.projectIds,
  }
}

function principalKind(auth: BrainAuth): 'api_key' | 'oauth_token' | 'home_app' {
  return auth.authKind
}

function resolvePartition(
  target: ProgrammaticCaptureTarget,
  auth: BrainAuth,
  input: ProgrammaticCaptureInput,
): string {
  const connection = `${auth.authKind}:${auth.keyId}`
  switch (target.partitionBy) {
    case 'connection':
      return connection
    case 'user':
      return auth.actingUserId ? `user:${auth.actingUserId}` : connection
    case 'session':
      if (input.sessionId) return `session:${input.sessionId}`
      throw new ProgrammaticCaptureError(
        'capture_partition_missing',
        'This capture profile partitions by session, so sessionId is required.',
      )
    case 'subject':
      if (input.subjectId) return `subject:${input.subjectId}`
      throw new ProgrammaticCaptureError(
        'capture_partition_missing',
        'This capture profile partitions by subject, so subjectId is required.',
      )
  }
}

function effectiveSensitivity(
  target: ProgrammaticCaptureTarget,
  ruleSensitivity: Sensitivity | null,
  authCap: Sensitivity | null,
): Sensitivity {
  const assistantAndCredential = authCap
    ? minSensitivity(target.assistantClearance, authCap)
    : target.assistantClearance
  return ruleSensitivity
    ? minSensitivity(assistantAndCredential, ruleSensitivity)
    : assistantAndCredential
}

function effectiveCompartments(target: ProgrammaticCaptureTarget, rule: ProgrammaticCaptureRule): string[] {
  return rule.compartments.length > 0 ? rule.compartments : target.assistantDefaultCompartments
}

function effectiveProjects(target: ProgrammaticCaptureTarget, rule: ProgrammaticCaptureRule): string[] {
  return rule.projectIds.length > 0
    ? rule.projectIds
    : target.assistantDefaultProjectId
      ? [target.assistantDefaultProjectId]
      : []
}

function duplicateResult(
  status: ProgrammaticCaptureReceiptStatus,
  batchId: string | null,
  firesAt: Date | null,
  profileId?: string,
  ruleId?: string,
): ProgrammaticCaptureResult {
  return {
    outcome: 'duplicate',
    receiptStatus: status,
    ...(profileId ? { profileId } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(batchId ? { batchId } : {}),
    ...(firesAt ? { firesAt } : {}),
  }
}

export function createProgrammaticCaptureRouter(deps: {
  store: ProgrammaticCaptureStore
  ingest: BrainEpisodeIngestor
  now?: () => Date
}) {
  return async function routeProgrammaticCapture(
    auth: BrainAuth,
    input: ProgrammaticCaptureInput,
  ): Promise<ProgrammaticCaptureResult> {
    const target = await deps.store.resolveTargetSystem({
      workspaceId: auth.workspaceId,
      assistantId: auth.captureAssistantId ?? null,
      overrideProfileId: auth.captureProfileId ?? null,
    })
    if (!target) {
      throw new ProgrammaticCaptureError(
        'capture_profile_not_configured',
        'Routed capture is not configured for this connection. Assign a capture profile to its selected assistant or set a connection override.',
      )
    }

    const occurredAt = input.occurredAt ?? deps.now?.() ?? new Date()
    const metadata = input.metadata ?? {}
    const event: IngestEvent = {
      source: 'programmatic',
      normalized: {
        text: input.content,
        actor_id: auth.actingUserId ?? input.subjectId ?? `${auth.authKind}:${auth.keyId}`,
        role: input.role ?? 'user',
        metadata,
      },
    }
    const { decision, rule: coreRule } = await resolveIngestRoute({
      rules: target.rules.map(asCoreRule),
      event,
      ctx: {
        workspace_id: auth.workspaceId,
        connector_instance_id: target.profileId,
      },
      filters: programmaticFilters,
      // Programmatic rule creation rejects placeholders. Keep resolution
      // fail-closed if an older/manual row nevertheless contains one.
      resolvePlaceholders: async () => [],
    })
    const matchedRule = coreRule
      ? target.rules.find((candidate) => candidate.id === coreRule.id) ?? null
      : null

    if (!matchedRule || decision.routing_mode === 'drop') {
      const receipt = await recordDroppedProgrammaticEvent({
        workspaceId: auth.workspaceId,
        principalKind: principalKind(auth),
        principalId: auth.keyId,
        eventId: input.eventId,
        ruleId: matchedRule?.id ?? null,
      })
      if (receipt.duplicate) {
        return duplicateResult(
          receipt.status,
          receipt.batchId,
          receipt.firesAt,
          target.profileId,
          matchedRule?.id,
        )
      }
      return {
        outcome: 'dropped',
        receiptStatus: 'dropped',
        profileId: target.profileId,
        ...(matchedRule ? { ruleId: matchedRule.id } : {}),
      }
    }

    const sensitivity = effectiveSensitivity(target, matchedRule.episodeSensitivity, auth.maxClearance)
    const compartments = effectiveCompartments(target, matchedRule)
    const projectIds = effectiveProjects(target, matchedRule)

    if (decision.routing_mode === 'realtime') {
      const reserved = await reserveRealtimeProgrammaticEvent({
        workspaceId: auth.workspaceId,
        principalKind: principalKind(auth),
        principalId: auth.keyId,
        eventId: input.eventId,
        ruleId: matchedRule.id,
      })
      if (!reserved) {
        const receipt = await getProgrammaticReceipt(
          principalKind(auth),
          auth.keyId,
          input.eventId,
        )
        return duplicateResult(
          receipt.status,
          receipt.batchId,
          receipt.firesAt,
          target.profileId,
          matchedRule.id,
        )
      }
      try {
        const extraction = await deps.ingest({
          workspaceId: auth.workspaceId,
          userId: target.ownerUserId,
          assistantId: target.assistantId,
          content: input.content,
          occurredAt,
          sourceLabel: input.sourceLabel,
          sensitivity: toEpisodeSensitivity(sensitivity),
          compartments,
          projectIds,
          sourceRef: {
            connector: 'programmatic',
            capture_mode: 'routed',
            profile_id: target.profileId,
            rule_id: matchedRule.id,
            event_id: input.eventId,
            principal_kind: auth.authKind,
            ...(auth.actingUserId ? { acting_user_id: auth.actingUserId } : {}),
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
            ...(input.subjectId ? { subject_id: input.subjectId } : {}),
          },
        })
        await finishRealtimeProgrammaticEvent({
          principalKind: principalKind(auth),
          principalId: auth.keyId,
          eventId: input.eventId,
          status: 'completed',
        })
        return {
          outcome: 'processed',
          receiptStatus: 'completed',
          profileId: target.profileId,
          ruleId: matchedRule.id,
          extraction,
        }
      } catch (err) {
        await finishRealtimeProgrammaticEvent({
          principalKind: principalKind(auth),
          principalId: auth.keyId,
          eventId: input.eventId,
          status: 'failed',
          error: err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000),
        })
        throw err
      }
    }

    if (!decision.schedule) {
      throw new ProgrammaticCaptureError(
        'capture_rule_invalid',
        `Scheduled capture rule ${matchedRule.id} has no schedule.`,
      )
    }
    const partitionKey = resolvePartition(target, auth, input)
    const firesAt = computeNextRun(
      { type: 'cron', expression: decision.schedule },
      decision.timezone,
      deps.now?.(),
    )
    const queuedEvent: QueuedProgrammaticCaptureEvent = {
      eventId: input.eventId,
      content: input.content,
      occurredAt: occurredAt.toISOString(),
      receivedAt: (deps.now?.() ?? new Date()).toISOString(),
      role: input.role ?? 'user',
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
      metadata,
      principalKind: principalKind(auth),
      principalId: auth.keyId,
      ...(auth.actingUserId ? { actingUserId: auth.actingUserId } : {}),
    }
    const receipt = await appendProgrammaticBatchEvent({
      workspaceId: auth.workspaceId,
      assistantId: target.assistantId,
      ruleId: matchedRule.id,
      partitionKey,
      firesAt,
      event: queuedEvent,
      episodeSensitivity: sensitivity,
      compartments,
      projectIds,
    })
    if (receipt.duplicate) {
      return duplicateResult(
        receipt.status,
        receipt.batchId,
        receipt.firesAt,
        target.profileId,
        matchedRule.id,
      )
    }
    return {
      outcome: 'queued',
      receiptStatus: 'queued',
      profileId: target.profileId,
      ruleId: matchedRule.id,
      batchId: receipt.batchId ?? undefined,
      firesAt: receipt.firesAt ?? firesAt,
    }
  }
}

function isQueuedEvent(value: unknown): value is QueuedProgrammaticCaptureEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<QueuedProgrammaticCaptureEvent>
  return typeof event.eventId === 'string'
    && typeof event.content === 'string'
    && typeof event.occurredAt === 'string'
    && typeof event.receivedAt === 'string'
    && typeof event.role === 'string'
}

function renderBatchWindow(events: QueuedProgrammaticCaptureEvent[]): string {
  return events.map((event) => {
    const subject = event.subjectId ? ` subject=${event.subjectId}` : ''
    const session = event.sessionId ? ` session=${event.sessionId}` : ''
    const label = event.sourceLabel ? ` source=${event.sourceLabel}` : ''
    const metadata = Object.keys(event.metadata).length > 0
      ? ` metadata=${JSON.stringify(event.metadata)}`
      : ''
    return `[${event.occurredAt}] role=${event.role}${subject}${session}${label}${metadata}\n${event.content.trim()}`
  }).join('\n\n')
}

export function createProgrammaticBatchProcessor(deps: {
  store: ProgrammaticCaptureStore
  ingest: BrainEpisodeIngestor
}) {
  return async function processProgrammaticBatch(batch: PendingBatch): Promise<void> {
    if (batch.source !== 'programmatic') {
      throw new Error(`programmatic batch processor received source=${batch.source}`)
    }
    if (!batch.assistantId) {
      throw new ProgrammaticCaptureError(
        'capture_target_unavailable',
        `Programmatic batch ${batch.id} has no assistant.`,
      )
    }
    const target = await deps.store.resolveBatchTargetSystem(
      batch.workspaceId,
      batch.assistantId,
      batch.ruleId,
    )
    if (!target) {
      throw new ProgrammaticCaptureError(
        'capture_target_unavailable',
        `Programmatic batch ${batch.id} target is unavailable.`,
      )
    }
    const events = batch.events
      .map((event, appendOrder) => ({ event, appendOrder }))
      .filter((entry): entry is { event: QueuedProgrammaticCaptureEvent; appendOrder: number } =>
        isQueuedEvent(entry.event) && entry.event.content.trim().length > 0)
      .sort((left, right) => {
        const occurred = Date.parse(left.event.occurredAt) - Date.parse(right.event.occurredAt)
        return occurred !== 0 ? occurred : left.appendOrder - right.appendOrder
      })
      .map((entry) => entry.event)
    if (events.length === 0) return

    const batchSensitivity = batch.episodeSensitivity ?? target.assistantClearance
    const sensitivity = minSensitivity(target.assistantClearance, batchSensitivity)
    const occurredAt = new Date(events[0]!.occurredAt)
    await deps.ingest({
      workspaceId: batch.workspaceId,
      userId: target.ownerUserId,
      assistantId: target.assistantId,
      content: renderBatchWindow(events),
      occurredAt,
      sourceLabel: `Programmatic capture (${events.length} messages)`,
      sensitivity: toEpisodeSensitivity(sensitivity),
      compartments: batch.compartments ?? target.assistantDefaultCompartments,
      projectIds: batch.projectIds
        ?? (target.assistantDefaultProjectId ? [target.assistantDefaultProjectId] : []),
      sourceRef: {
        connector: 'programmatic',
        capture_mode: 'routed_batch',
        profile_id: target.profileId,
        rule_id: batch.ruleId,
        partition_key: batch.partitionKey ?? '',
        batch_id: batch.id,
        message_count: events.length,
        principal_kinds: [...new Set(events.map((event) => event.principalKind))].sort(),
        principal_refs: [...new Set(events.map((event) => `${event.principalKind}:${event.principalId}`))].sort(),
        acting_user_ids: [...new Set(events.flatMap((event) =>
          event.actingUserId ? [event.actingUserId] : []))].sort(),
      },
    })
  }
}
