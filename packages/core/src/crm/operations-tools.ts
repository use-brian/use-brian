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
  listEntitlementPlans(workspaceId: string, filters?: {
    published?: boolean
    limit?: number
  }): Promise<Array<Record<string, unknown>>>
  listEntitlements(workspaceId: string, filters?: {
    contactId?: string
    planId?: string
    status?: 'pending' | 'active' | 'expired' | 'cancelled'
    limit?: number
  }): Promise<Array<Record<string, unknown>>>
  listEvents(workspaceId: string, filters?: {
    status?: 'draft' | 'published' | 'cancelled' | 'completed'
    limit?: number
  }): Promise<Array<Record<string, unknown>>>
  listParticipation(workspaceId: string, filters?: {
    contactId?: string
    eventId?: string
    status?: 'registered' | 'attended' | 'cancelled' | 'no_show'
    sourceKind?: 'commerce' | 'manual' | 'form' | 'workflow' | 'import'
    limit?: number
  }): Promise<Array<Record<string, unknown>>>
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
  listCrmEntitlementPlans: Tool
  listCrmEntitlements: Tool
  listCrmEvents: Tool
  listCrmParticipation: Tool
  recordCrmSubmission: Tool
  updateCrmSubmission: Tool
  recordCrmConsent: Tool
  recordCrmSuppression: Tool
  saveCrmSegment: Tool
  archiveCrmSegment: Tool
  grantCrmEntitlement: Tool
  updateCrmEntitlement: Tool
  recordCrmParticipation: Tool
  updateCrmParticipation: Tool
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

const EntitlementStatusSchema = z.enum(['pending', 'active', 'expired', 'cancelled'])
const ParticipationStatusSchema = z.enum(['registered', 'attended', 'cancelled', 'no_show'])
const ParticipationSourceSchema = z.enum(['manual', 'form', 'workflow', 'import'])

const GrantEntitlementInputSchema = z.object({
  contact_id: CrmOperationsUuidSchema,
  plan_id: CrmOperationsUuidSchema,
  idempotency_key: z.string().trim().min(1).max(200),
  status: EntitlementStatusSchema.default('pending'),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  renewal_mode: z.enum(['none', 'manual', 'auto']).default('none'),
  provider: CrmOperationsStableKeySchema.optional(),
  provider_entitlement_id: z.string().trim().min(1).max(500).optional(),
}).strict().refine(
  (value) => (value.provider === undefined) === (value.provider_entitlement_id === undefined),
  'provider and provider_entitlement_id must be supplied together',
).refine(
  (value) => !value.ends_at || value.starts_at < value.ends_at,
  'ends_at must be after starts_at',
)

const UpdateEntitlementInputSchema = z.object({
  entitlement_id: CrmOperationsUuidSchema,
  status: EntitlementStatusSchema.optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  renewal_mode: z.enum(['none', 'manual', 'auto']).optional(),
}).strict().refine(
  (value) => value.status !== undefined || value.ends_at !== undefined
    || value.renewal_mode !== undefined,
  'at least one entitlement change is required',
)

const RecordParticipationInputSchema = z.object({
  contact_id: CrmOperationsUuidSchema,
  event_id: CrmOperationsUuidSchema,
  source_kind: ParticipationSourceSchema,
  source_id: z.string().trim().min(1).max(500),
  status: ParticipationStatusSchema.default('registered'),
  attendee_name: z.string().trim().min(1).max(200),
  attendee_email: z.string().trim().email().max(320).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict()

const UpdateParticipationInputSchema = z.object({
  participation_id: CrmOperationsUuidSchema,
  status: ParticipationStatusSchema,
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
  const listCrmEntitlementPlans = buildTool({
    name: 'listCrmEntitlementPlans', requiresCapability: 'crm', isReadOnly: true,
    description: 'Enumerate CRM entitlement plans with stable plan ids and keys, lifecycle dates, publication state, and any provider or fee metadata. Use returned ids for entitlement grants instead of guessing labels.',
    inputSchema: z.object({
      published: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listEntitlementPlans(workspace, input) } }
      catch (error) { return failure(error) }
    },
  })
  const listCrmEntitlements = buildTool({
    name: 'listCrmEntitlements', requiresCapability: 'crm', isReadOnly: true,
    description: 'List canonical CRM entitlements with bounded contact, plan, and lifecycle-status filters. Results reuse Association membership ids and include stable plan keys.',
    inputSchema: z.object({
      contact_id: CrmOperationsUuidSchema.optional(),
      plan_id: CrmOperationsUuidSchema.optional(),
      status: EntitlementStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listEntitlements(workspace, {
          contactId: input.contact_id, planId: input.plan_id,
          status: input.status, limit: input.limit,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const listCrmEvents = buildTool({
    name: 'listCrmEvents', requiresCapability: 'crm', isReadOnly: true,
    description: 'Enumerate CRM events over the existing Association event catalog, including stable event ids and slugs, schedule, status, capacity, and whether ticket commerce is configured.',
    inputSchema: z.object({
      status: z.enum(['draft', 'published', 'cancelled', 'completed']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listEvents(workspace, input) } }
      catch (error) { return failure(error) }
    },
  })
  const listCrmParticipation = buildTool({
    name: 'listCrmParticipation', requiresCapability: 'crm', isReadOnly: true,
    description: 'List canonical event participation with bounded contact, event, status, and source filters. Commerce-created registrations are mapped to generic lifecycle statuses and marked commerce_managed.',
    inputSchema: z.object({
      contact_id: CrmOperationsUuidSchema.optional(),
      event_id: CrmOperationsUuidSchema.optional(),
      status: ParticipationStatusSchema.optional(),
      source_kind: z.enum(['commerce', 'manual', 'form', 'workflow', 'import']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listParticipation(workspace, {
          contactId: input.contact_id, eventId: input.event_id,
          status: input.status, sourceKind: input.source_kind, limit: input.limit,
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
  const grantCrmEntitlement = buildTool({
    name: 'grantCrmEntitlement', requiresCapability: 'crm',
    description: 'Idempotently grant a CRM entitlement to a contact using a stable plan_id from listCrmEntitlementPlans. This uses the same canonical membership row seen by Association operations.',
    inputSchema: GrantEntitlementInputSchema,
    execute: write((input) => ({
      kind: 'grant_entitlement', contactId: input.contact_id, planId: input.plan_id,
      idempotencyKey: input.idempotency_key, status: input.status,
      startsAt: input.starts_at, endsAt: input.ends_at,
      renewalMode: input.renewal_mode, provider: input.provider,
      providerEntitlementId: input.provider_entitlement_id,
    } as CrmOperationsCommand)),
  })
  const updateCrmEntitlement = buildTool({
    name: 'updateCrmEntitlement', requiresCapability: 'crm',
    description: 'Apply a valid lifecycle update to one entitlement by stable entitlement_id. Cancellation is consequential and requires confirmation.',
    inputSchema: UpdateEntitlementInputSchema,
    resolveConfirmation: async (_context, input) => UpdateEntitlementInputSchema.parse(input).status === 'cancelled',
    execute: write((input) => ({
      kind: 'update_entitlement', entitlementId: input.entitlement_id,
      status: input.status, endsAt: input.ends_at, renewalMode: input.renewal_mode,
    } as CrmOperationsCommand)),
  })
  const recordCrmParticipation = buildTool({
    name: 'recordCrmParticipation', requiresCapability: 'crm',
    description: 'Idempotently record non-commerce CRM event participation using a stable event_id and source identity. Ticket, order, and payment fields are intentionally unavailable.',
    inputSchema: RecordParticipationInputSchema,
    execute: write((input) => ({
      kind: 'record_participation', contactId: input.contact_id,
      eventId: input.event_id, sourceKind: input.source_kind,
      sourceId: input.source_id, status: input.status,
      attendeeName: input.attendee_name, attendeeEmail: input.attendee_email,
      metadata: input.metadata,
    } as CrmOperationsCommand)),
  })
  const updateCrmParticipation = buildTool({
    name: 'updateCrmParticipation', requiresCapability: 'crm',
    description: 'Apply a valid generic lifecycle status to non-commerce participation. Commerce-managed rows must be changed through Association order or registration operations.',
    inputSchema: UpdateParticipationInputSchema,
    execute: write((input) => ({
      kind: 'update_participation', participationId: input.participation_id,
      status: input.status,
    } as CrmOperationsCommand)),
  })

  return {
    listCrmIntakeDefinitions, listCrmSubmissions, getCrmSubmission,
    listCrmConsentPurposes, getCrmConsent, checkCrmSendability,
    listCrmSegments, previewCrmSegment,
    listCrmEntitlementPlans, listCrmEntitlements, listCrmEvents, listCrmParticipation,
    recordCrmSubmission, updateCrmSubmission, recordCrmConsent, recordCrmSuppression,
    saveCrmSegment, archiveCrmSegment,
    grantCrmEntitlement, updateCrmEntitlement,
    recordCrmParticipation, updateCrmParticipation,
  }
}

type TRecordSubmission = Extract<CrmOperationsCommand, { kind: 'record_submission' }>
