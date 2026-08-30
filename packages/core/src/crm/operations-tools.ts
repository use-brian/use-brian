/**
 * Brian and Brain-MCP tools for the canonical CRM operations plane.
 * Adapters inject one read port and the same command service used by REST;
 * tools never call HTTP or reproduce write orchestration.
 *
 * [COMP:crm/operations-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import {
  CrmDeliveryChannelSchema,
  type SendabilityVerdict,
} from './sendability.js'
import { CrmSegmentPredicateSchema } from './segments.js'
import {
  CrmExternalIdentityClaimSchema,
  CrmOperationsError,
  CrmOperationsStableKeySchema,
  CrmOperationsUuidSchema,
  RecordCrmSubmissionCommandSchema,
  type CrmOperationsActor,
  type CrmOperationsCommand,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from './operations-types.js'

export type CrmOperationsReadPort = {
  listIntakeDefinitions(workspaceId: string): Promise<Array<Record<string, unknown>>>
  listSubmissions(workspaceId: string, filters?: {
    status?: 'new' | 'in_progress' | 'resolved' | 'spam'
    definitionKey?: string
    ownerUserId?: string
    limit?: number
  }): Promise<Array<Record<string, unknown>>>
  getSubmission(workspaceId: string, submissionId: string): Promise<Record<string, unknown> | null>
  listConsentPurposes(workspaceId: string, includeArchived?: boolean): Promise<Array<Record<string, unknown>>>
  getConsent(workspaceId: string, contactId: string): Promise<{
    purposes: Array<Record<string, unknown>>
    events: Array<Record<string, unknown>>
    suppressions: Array<Record<string, unknown>>
  }>
  checkSendability(
    workspaceId: string,
    contactId: string,
    channel: z.infer<typeof CrmDeliveryChannelSchema>,
    purposeKey: string,
  ): Promise<SendabilityVerdict>
  listSegments(workspaceId: string, filters?: {
    entityKind?: 'person' | 'company' | 'deal'
    includeArchived?: boolean
  }): Promise<{
    segments: Array<Record<string, unknown>>
    catalog: Array<Record<string, unknown>>
  }>
  getSegment(workspaceId: string, segmentId: string): Promise<Record<string, unknown> | null>
  previewSegment(workspaceId: string, segmentId: string, options?: {
    limit?: number
    snapshotLimit?: number
  }): Promise<{
    rows: Array<Record<string, unknown>>
    count: number
    snapshotIds: string[]
  }>
}

export type CrmOperationsTools = {
  listCrmIntakeDefinitions: Tool
  listCrmSubmissions: Tool
  getCrmSubmission: Tool
  listCrmConsentPurposes: Tool
  getCrmConsent: Tool
  checkCrmSendability: Tool
  listCrmSegments: Tool
  previewCrmSegment: Tool
  recordCrmSubmission: Tool
  updateCrmSubmission: Tool
  recordCrmConsent: Tool
  recordCrmSuppression: Tool
  saveCrmSegment: Tool
  archiveCrmSegment: Tool
}

const SubmissionFiltersSchema = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  definition_key: CrmOperationsStableKeySchema.optional(),
  owner_user_id: CrmOperationsUuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()

const UpdateSubmissionInputSchema = z.object({
  submission_id: CrmOperationsUuidSchema,
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  queue_key: CrmOperationsStableKeySchema.optional(),
  owner_user_id: CrmOperationsUuidSchema.nullable().optional(),
  note: z.string().trim().min(1).max(20_000).optional(),
}).strict().refine(
  (value) => value.status !== undefined || value.queue_key !== undefined
    || value.owner_user_id !== undefined || value.note !== undefined,
  'at least one submission change is required',
)

const RecordConsentInputSchema = z.object({
  contact_id: CrmOperationsUuidSchema,
  purpose_key: CrmOperationsStableKeySchema,
  action: z.enum(['granted', 'withdrawn']),
  source: CrmOperationsStableKeySchema,
  occurred_at: z.string().datetime({ offset: true }).optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  provider_event_id: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().refine(
  (value) => (value.provider === undefined) === (value.provider_event_id === undefined),
  'provider and provider_event_id must be supplied together',
)

const RecordSuppressionInputSchema = z.object({
  contact_id: CrmOperationsUuidSchema,
  channel: z.enum(['all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack']),
  action: z.enum(['suppressed', 'released']),
  reason_code: z.enum([
    'manual_do_not_contact', 'hard_bounce', 'soft_bounce', 'complaint',
    'provider_block', 'legal', 'invalid_address', 'other',
  ]),
  source: CrmOperationsStableKeySchema,
  occurred_at: z.string().datetime({ offset: true }).optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  provider_event_id: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().refine(
  (value) => (value.provider === undefined) === (value.provider_event_id === undefined),
  'provider and provider_event_id must be supplied together',
)

const SaveSegmentInputSchema = z.object({
  segment_id: CrmOperationsUuidSchema.optional(),
  segment_key: CrmOperationsStableKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).default(''),
  entity_kind: z.enum(['person', 'company', 'deal']),
  predicate: CrmSegmentPredicateSchema,
  expected_version: z.number().int().positive().optional(),
}).strict()

function workspaceId(context: ToolContext): string | null {
  return context.workspaceId ?? null
}

function actorFor(context: ToolContext): CrmOperationsActor {
  const principal = context.programmaticPrincipal
  if (principal) {
    if (principal.kind === 'oauth_token') {
      return { kind: principal.kind, credentialId: principal.credentialId, userId: principal.userId }
    }
    if (principal.kind === 'home_app') {
      return { kind: principal.kind, credentialId: principal.credentialId, userId: principal.userId }
    }
    return { kind: principal.kind, credentialId: principal.credentialId }
  }
  return {
    kind: 'assistant',
    assistantId: context.assistantId,
    userId: context.userId,
    sessionId: context.sessionId,
  }
}

function operationsContext(context: ToolContext): CrmOperationsContext | null {
  const workspace = workspaceId(context)
  if (!workspace) return null
  return {
    workspaceId: workspace,
    actor: actorFor(context),
    authority: {
      role: 'member',
      canWrite: true,
      canConfigure: false,
      trustedIdentitySources: [],
    },
  }
}

function workspaceError() {
  return {
    data: 'CRM operations require a workspace-scoped assistant or programmatic credential.',
    isError: true as const,
  }
}

function failure(error: unknown) {
  if (error instanceof CrmOperationsError) {
    return { data: { error: error.code, message: error.message, ...error.details }, isError: true as const }
  }
  return { data: { error: 'internal', message: error instanceof Error ? error.message : String(error) }, isError: true as const }
}

export function createCrmOperationsTools(options: {
  reads: CrmOperationsReadPort
  service: CrmOperationsServicePort
}): CrmOperationsTools {
  const read = <T>(run: (workspaceId: string) => Promise<T>) => async (_input: unknown, context: ToolContext) => {
    const workspace = workspaceId(context)
    if (!workspace) return workspaceError()
    try {
      return { data: await run(workspace) }
    } catch (error) {
      return failure(error)
    }
  }
  const write = <T extends CrmOperationsCommand>(
    command: (input: Record<string, unknown>) => T,
  ) => async (input: Record<string, unknown>, context: ToolContext) => {
    const serviceContext = operationsContext(context)
    if (!serviceContext) return workspaceError()
    try {
      return { data: await options.service.execute(serviceContext, command(input)) }
    } catch (error) {
      return failure(error)
    }
  }

  const listCrmIntakeDefinitions = buildTool({
    name: 'listCrmIntakeDefinitions', requiresCapability: 'crm', isReadOnly: true,
    description: 'List the active and archived CRM intake definitions in this workspace, including stable definition keys, versions, field catalogs, identity policy, routing, and payload limits. Use a returned definition_key rather than guessing one.',
    inputSchema: z.object({}).strict(),
    execute: read((workspace) => options.reads.listIntakeDefinitions(workspace)),
  })
  const listCrmSubmissions = buildTool({
    name: 'listCrmSubmissions', requiresCapability: 'crm', isReadOnly: true,
    description: 'List CRM intake submissions with bounded status, definition, owner, and limit filters. Returns stable submission and contact ids. Use getCrmSubmission for the complete captured fields and notes.',
    inputSchema: SubmissionFiltersSchema,
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listSubmissions(workspace, {
          status: input.status,
          definitionKey: input.definition_key,
          ownerUserId: input.owner_user_id,
          limit: input.limit,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const getCrmSubmission = buildTool({
    name: 'getCrmSubmission', requiresCapability: 'crm', isReadOnly: true,
    description: 'Read one CRM submission by its stable submission_id, including its definition snapshot, submitted fields, linked contact, follow-up task, and notes.',
    inputSchema: z.object({ submission_id: CrmOperationsUuidSchema }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        const row = await options.reads.getSubmission(workspace, input.submission_id)
        return row ? { data: row } : { data: { error: 'not_found', message: 'CRM submission was not found.' }, isError: true }
      } catch (error) { return failure(error) }
    },
  })
  const listCrmConsentPurposes = buildTool({
    name: 'listCrmConsentPurposes', requiresCapability: 'crm', isReadOnly: true,
    description: 'Enumerate the workspace consent-purpose catalog, including stable purpose keys, applicable channels, consent requirement, wording version, and archive state. Use a returned purpose_key for consent and sendability calls.',
    inputSchema: z.object({ include_archived: z.boolean().default(false) }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listConsentPurposes(workspace, input.include_archived) } }
      catch (error) { return failure(error) }
    },
  })
  const getCrmConsent = buildTool({
    name: 'getCrmConsent', requiresCapability: 'crm', isReadOnly: true,
    description: 'Read the append-only consent and suppression evidence for one CRM contact, together with the purpose catalog needed to interpret effective state.',
    inputSchema: z.object({ contact_id: CrmOperationsUuidSchema }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.getConsent(workspace, input.contact_id) } }
      catch (error) { return failure(error) }
    },
  })
  const checkCrmSendability = buildTool({
    name: 'checkCrmSendability', requiresCapability: 'crm', isReadOnly: true,
    description: 'Run the canonical fail-closed sendability preflight for one contact, channel, and enumerated purpose. Only verdict=allowed is permission; blocked and unknown must stop delivery.',
    inputSchema: z.object({
      contact_id: CrmOperationsUuidSchema,
      channel: CrmDeliveryChannelSchema,
      purpose_key: CrmOperationsStableKeySchema,
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.checkSendability(workspace, input.contact_id, input.channel, input.purpose_key) } }
      catch (error) { return failure(error) }
    },
  })
  const listCrmSegments = buildTool({
    name: 'listCrmSegments', requiresCapability: 'crm', isReadOnly: true,
    description: 'List workspace-shared dynamic CRM segments and their bounded predicates. Optionally filter by entity kind. Returns stable segment ids and keys; use previewCrmSegment to evaluate current membership.',
    inputSchema: z.object({
      entity_kind: z.enum(['person', 'company', 'deal']).default('person'),
      include_archived: z.boolean().default(false),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listSegments(workspace, {
          entityKind: input.entity_kind,
          includeArchived: input.include_archived,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const previewCrmSegment = buildTool({
    name: 'previewCrmSegment', requiresCapability: 'crm', isReadOnly: true,
    description: 'Evaluate one saved CRM segment at read time. Returns a bounded row preview, the complete count, and a bounded stable-id snapshot suitable for workflow input or export. Unknown catalog fields fail closed with valid choices.',
    inputSchema: z.object({
      segment_id: CrmOperationsUuidSchema,
      limit: z.number().int().min(1).max(100).default(25),
      snapshot_limit: z.number().int().min(1).max(10_000).default(1_000),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.previewSegment(workspace, input.segment_id, {
          limit: input.limit,
          snapshotLimit: input.snapshot_limit,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const recordCrmSubmission = buildTool({
    name: 'recordCrmSubmission', requiresCapability: 'crm',
    description: 'Atomically record a CRM submission through an existing intake definition. The definition controls identity matching, field mappings, consent, routing, and follow-up. Pass an idempotency_key and a stable definition_key from listCrmIntakeDefinitions.',
    inputSchema: RecordCrmSubmissionCommandSchema.omit({ kind: true }),
    execute: write((input) => ({ kind: 'record_submission', ...input } as TRecordSubmission)),
  })
  const updateCrmSubmission = buildTool({
    name: 'updateCrmSubmission', requiresCapability: 'crm',
    description: 'Update one CRM submission status, queue, owner, or append a note using its stable submission_id. This mutation uses the same audited transaction service as the CRM Inbox.',
    inputSchema: UpdateSubmissionInputSchema,
    execute: write((input) => ({
      kind: 'update_submission', submissionId: input.submission_id,
      status: input.status, queueKey: input.queue_key,
      ownerUserId: input.owner_user_id, note: input.note,
    } as CrmOperationsCommand)),
  })
  const recordCrmConsent = buildTool({
    name: 'recordCrmConsent', requiresCapability: 'crm',
    description: 'Append consent evidence for a CRM contact and an enumerated purpose. This never overwrites history. Consent withdrawal requires user confirmation.',
    inputSchema: RecordConsentInputSchema,
    resolveConfirmation: async (_context, input) => RecordConsentInputSchema.parse(input).action === 'withdrawn',
    execute: write((input) => ({
      kind: 'record_consent', contactId: input.contact_id, purposeKey: input.purpose_key,
      action: input.action, source: input.source, occurredAt: input.occurred_at,
      provider: input.provider, providerEventId: input.provider_event_id, metadata: input.metadata,
    } as CrmOperationsCommand)),
  })
  const recordCrmSuppression = buildTool({
    name: 'recordCrmSuppression', requiresCapability: 'crm',
    description: 'Append a channel or global suppression/release event for one CRM contact. This never rewrites consent. Releasing a suppression requires user confirmation.',
    inputSchema: RecordSuppressionInputSchema,
    resolveConfirmation: async (_context, input) => RecordSuppressionInputSchema.parse(input).action === 'released',
    execute: write((input) => ({
      kind: 'record_suppression', contactId: input.contact_id, channel: input.channel,
      action: input.action, reasonCode: input.reason_code, source: input.source,
      occurredAt: input.occurred_at, provider: input.provider,
      providerEventId: input.provider_event_id, metadata: input.metadata,
    } as CrmOperationsCommand)),
  })
  const saveCrmSegment = buildTool({
    name: 'saveCrmSegment', requiresCapability: 'crm',
    description: 'Create or version-update a workspace-shared dynamic CRM segment. Use only fields and operators returned by the segment catalog; unknown vocabulary fails closed with bounded valid choices.',
    inputSchema: SaveSegmentInputSchema,
    execute: write((input) => ({
      kind: 'save_segment', segmentId: input.segment_id,
      segmentKey: input.segment_key, name: input.name,
      description: input.description, entityKind: input.entity_kind,
      predicate: input.predicate, expectedVersion: input.expected_version,
    } as CrmOperationsCommand)),
  })
  const archiveCrmSegment = buildTool({
    name: 'archiveCrmSegment', requiresCapability: 'crm',
    description: 'Archive a shared CRM segment by stable segment_id. Existing workflow inputs keep their captured stable-id snapshot; future dynamic evaluations stop listing the segment.',
    inputSchema: z.object({
      segment_id: CrmOperationsUuidSchema,
      expected_version: z.number().int().positive().optional(),
    }).strict(),
    resolveConfirmation: async () => true,
    execute: write((input) => ({
      kind: 'archive_segment', segmentId: input.segment_id,
      expectedVersion: input.expected_version,
    } as CrmOperationsCommand)),
  })

  return {
    listCrmIntakeDefinitions, listCrmSubmissions, getCrmSubmission,
    listCrmConsentPurposes, getCrmConsent, checkCrmSendability,
    listCrmSegments, previewCrmSegment,
    recordCrmSubmission, updateCrmSubmission, recordCrmConsent, recordCrmSuppression,
    saveCrmSegment, archiveCrmSegment,
  }
}

type TRecordSubmission = Extract<CrmOperationsCommand, { kind: 'record_submission' }>
