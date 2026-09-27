/**
 * Brian and Brain-MCP tools for the canonical CRM operations plane.
 * Adapters inject one read port and the same command service used by REST;
 * tools never call HTTP or reproduce write orchestration.
 *
 * [COMP:crm/operations-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { AssociationPlanInputSchema, AssociationEventInputSchema } from '../association/domain.js'
import {
  CrmDeliveryChannelSchema,
  type SendabilityVerdict,
} from './sendability.js'
import { CrmSegmentPredicateSchema } from './segments.js'
import type { CrmPage, CrmPageQuery } from './pagination.js'
import {
  CrmExternalIdentityClaimSchema,
  CrmOperationsError,
  CrmOperationsStableKeySchema,
  CrmOperationsUuidSchema,
  SendCrmMessageInputSchema, SendCrmMessageCommandSchema, type CrmDeliveryServicePort,
  CrmWordingLocaleSchema,
  RecordCrmSubmissionCommandSchema,
  type CrmOperationsActor,
  type CrmOperationsCommand,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from './operations-types.js'

export type CrmOperationsReadPort = {
  listIntakeDefinitions(workspaceId: string, filters?: CrmPageQuery): Promise<CrmPage<'definitions'>>
  listSubmissions(workspaceId: string, filters?: CrmPageQuery & {
    status?: 'new' | 'in_progress' | 'resolved' | 'spam'
    definitionKey?: string
    ownerUserId?: string
    limit?: number
  }): Promise<CrmPage<'submissions'>>
  getSubmission(workspaceId: string, submissionId: string): Promise<Record<string, unknown> | null>
  listConsentPurposes(workspaceId: string, includeArchived?: boolean, page?: CrmPageQuery): Promise<CrmPage<'purposes'>>
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
  listSegments(workspaceId: string, filters?: CrmPageQuery & {
    entityKind?: 'person' | 'company' | 'deal'
    includeArchived?: boolean
  }): Promise<CrmPage<'segments'> & { catalog: Array<Record<string, unknown>> }>
  getSegment(workspaceId: string, segmentId: string): Promise<Record<string, unknown> | null>
  previewSegment(workspaceId: string, segmentId: string, options?: CrmPageQuery & {
    snapshotLimit?: number
    snapshotCursor?: string
  }): Promise<{
    rows: Array<Record<string, unknown>>
    count: number
    snapshotIds: string[]
    nextCursor: string | null
    snapshotNextCursor: string | null
  }>
  listEntitlementPlans(workspaceId: string, filters?: CrmPageQuery & {
    published?: boolean
    limit?: number
  }): Promise<CrmPage<'plans'>>
  listEntitlements(workspaceId: string, filters?: CrmPageQuery & {
    activeOnly?: boolean
    effectiveAt?: string
    contactId?: string
    planId?: string
    status?: 'pending' | 'active' | 'expired' | 'cancelled'
    limit?: number
  }): Promise<CrmPage<'entitlements'>>
  listEvents(workspaceId: string, filters?: CrmPageQuery & {
    status?: 'draft' | 'published' | 'cancelled' | 'completed'
    limit?: number
  }): Promise<CrmPage<'events'>>
  listParticipation(workspaceId: string, filters?: CrmPageQuery & {
    contactId?: string
    eventId?: string
    status?: 'registered' | 'attended' | 'cancelled' | 'no_show'
    sourceKind?: 'commerce' | 'source_order' | 'manual' | 'form' | 'workflow' | 'import'
    limit?: number
  }): Promise<CrmPage<'participation'>>
  listPipelines(workspaceId: string, filters?: CrmPageQuery & {
    entityKind?: 'deal'
    includeArchived?: boolean
  }): Promise<CrmPage<'pipelines'>>
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
  listCrmPipelines: Tool
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
  setDealPipelineStage: Tool
  saveCrmEntitlementPlan: Tool
  saveCrmEvent: Tool
  sendCrmMessage: Tool
  getCrmDelivery: Tool
}

const PageInput = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4096).optional(),
  created_after: z.string().datetime({ offset: true }).optional(),
  created_before: z.string().datetime({ offset: true }).optional(),
}
function pageFilters(input: { limit?: number; cursor?: string; created_after?: string; created_before?: string }): CrmPageQuery {
  return { limit: input.limit, cursor: input.cursor, createdAfter: input.created_after, createdBefore: input.created_before }
}

const SubmissionFiltersSchema = z.object({
  ...PageInput,
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
  locale: CrmWordingLocaleSchema.optional(),
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
  provider_period_id: z.string().trim().min(1).max(500).optional(),
  predecessor_id: CrmOperationsUuidSchema.optional(),
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

const SetDealPipelineStageInputSchema = z.object({
  deal_id: CrmOperationsUuidSchema,
  pipeline_id: CrmOperationsUuidSchema,
  stage_id: CrmOperationsUuidSchema,
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

/** Preserve the calling principal when adapting native tools to CRM/Association. */
export function crmOperationsToolContext(context: ToolContext): CrmOperationsContext | null {
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
  if ((error as { code?: string } | null)?.code === 'scope_operation_denied') {
    return { data: { error: 'scope_operation_denied',
      message: 'This operation is unavailable in your current scope. Ask a workspace administrator to review access.' }, isError: true as const }
  }
  if (error instanceof CrmOperationsError) {
    return { data: { error: error.code, message: error.message, ...error.details }, isError: true as const }
  }
  return { data: { error: 'internal', message: error instanceof Error ? error.message : String(error) }, isError: true as const }
}

export function createCrmOperationsTools(options: {
  reads: CrmOperationsReadPort
  service: CrmOperationsServicePort
  deliveries?: CrmDeliveryServicePort
}): CrmOperationsTools {
  function configure<Input extends z.ZodType>(name: string, description: string, inputSchema: Input,
    toCommand: (input: z.infer<Input>) => CrmOperationsCommand): Tool<Input> {
    const tool: Tool<Input> = buildTool({
      name, description, inputSchema, requiresCapability: 'configure',
      homeAppToolSet: { app: 'crm', set: 'write' },
      async execute(input, context) {
        const missing = missingToolCapability(tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const serviceContext = crmOperationsToolContext(context)
        if (!serviceContext) return workspaceError()
        try {
          return { data: await options.service.execute({ ...serviceContext,
            authority: { ...serviceContext.authority, canConfigure: true },
          }, toCommand(inputSchema.parse(input))) }
        } catch (error) {
          if (error instanceof CrmOperationsError) return failure(error)
          return { isError: true, data: { error: error instanceof z.ZodError ? 'invalid_input' : 'internal', message: 'CRM configuration could not complete.' } }
        }
      },
    })
    return tool
  }
  const saveCrmEntitlementPlan = configure('saveCrmEntitlementPlan',
    'Save a generic CRM entitlement plan by stable key. Read the plan catalog first. Requires explicit configuration and CRM write grants; no Association module is required. This does not grant membership or assert payment.',
    z.object({ plan: AssociationPlanInputSchema }).strict(), input => ({ kind: 'save_entitlement_plan', ...input.plan }))
  const saveCrmEvent = configure('saveCrmEvent',
    'Save a generic CRM event by stable slug using the declared timezone and registration windows. Read the event catalog first. Requires explicit configuration and CRM write grants; no Association module is required. This does not create a ticket or registration.',
    z.object({ event: AssociationEventInputSchema }).strict(), input => ({ kind: 'save_event', ...input.event }))
  function delivery<Input extends z.ZodType>(name:string,description:string,inputSchema:Input,read:boolean):Tool<Input> {
    const tool:Tool<Input>=buildTool({name,description,inputSchema,requiresCapability:'crm',
      homeAppToolSet:{app:'crm',set:read?'read':'write'},isReadOnly:read,requiresConfirmation:!read,
      async execute(input,context) {
        const missing=missingToolCapability(tool,context.activeCapabilities)
        if(missing) return {isError:true,data:{error:'not_authorized',requiredCapability:missing}}
        const caller=crmOperationsToolContext(context)
        if(!caller) return workspaceError()
        caller.authority.nativeDelivery={assistantId:context.assistantId,compartments:context.compartments ?? null,projectIds:context.projectIds ?? null,
          mutationCompartments:context.mutationCompartments === undefined ? context.compartments ?? null : context.mutationCompartments}
        try {
          const parsed=inputSchema.parse(input)
          if(read) {
            if(!options.deliveries) throw new CrmOperationsError('conflict','CRM delivery is unavailable.',{reason:'delivery_unavailable'})
            return {data:{receipt:await options.deliveries.get(caller,parsed.deliveryId)}}
          }
          return {data:await options.service.execute(caller,SendCrmMessageCommandSchema.parse({...parsed,kind:'send_message'}))}
        } catch(error) {
          if(error instanceof CrmOperationsError) return failure(error)
          return {isError:true,data:{error:error instanceof z.ZodError?'invalid_input':'internal',message:'CRM delivery could not complete. Inspect the original delivery identity before another attempt.'}}
        }
      },
    })
    return tool
  }
  const sendCrmMessage=delivery('sendCrmMessage',
    'Send one managed CRM email with a stable deliveryId and exact connectorInstanceId. Requires CRM write and the current mailbox send grant. All To/Cc/Bcc recipients are checked for this purpose immediately before dispatch. Inspect uncertain results with getCrmDelivery using the SAME deliveryId; never invent a new identity to retry. Sent means provider acceptance, not confirmed recipient delivery.',
    SendCrmMessageInputSchema,false)
  const getCrmDelivery=delivery('getCrmDelivery',
    'Inspect a durable CRM delivery receipt by its original deliveryId, including provider acceptance, blocked or uncertain outcomes. This never resends a message and does not expose message content.',
    z.object({deliveryId:CrmOperationsUuidSchema}).strict(),true)
  const write = <T extends CrmOperationsCommand>(
    command: (input: Record<string, unknown>) => T,
  ) => async (input: Record<string, unknown>, context: ToolContext) => {
    const serviceContext = crmOperationsToolContext(context)
    if (!serviceContext) return workspaceError()
    try {
      return { data: await options.service.execute(serviceContext, command(input)) }
    } catch (error) {
      return failure(error)
    }
  }

  const listCrmIntakeDefinitions = buildTool({
    name: 'listCrmIntakeDefinitions', requiresCapability: 'crm', isReadOnly: true,
    description: 'List the active and archived CRM intake definitions in this workspace, including stable definition keys, versions, field catalogs, identity policy, routing, and payload limits. Use a returned definition_key rather than guessing one. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object(PageInput).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listIntakeDefinitions(workspace, pageFilters(input)) } }
      catch (error) { return failure(error) }
    },
  })
  const listCrmSubmissions = buildTool({
    name: 'listCrmSubmissions', requiresCapability: 'crm', isReadOnly: true,
    description: 'List CRM intake submissions with bounded status, definition, owner, and limit filters. Returns stable submission and contact ids. Use getCrmSubmission for the complete captured fields and notes. Follow nextCursor with the same filters until it is null.',
    inputSchema: SubmissionFiltersSchema,
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listSubmissions(workspace, {
          ...pageFilters(input), status: input.status,
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
    description: 'Enumerate the workspace consent-purpose catalog, including stable purpose keys, applicable channels, consent requirement, wording version, and archive state. Use a returned purpose_key for consent and sendability calls. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({ ...PageInput, include_archived: z.boolean().default(false) }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listConsentPurposes(workspace, input.include_archived, pageFilters(input)) } }
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
    description: 'List workspace-shared dynamic CRM segments and their bounded predicates. Optionally filter by entity kind. Returns stable segment ids and keys; use previewCrmSegment to evaluate current membership. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({
      ...PageInput,
      entity_kind: z.enum(['person', 'company', 'deal']).default('person'),
      include_archived: z.boolean().default(false),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listSegments(workspace, {
          ...pageFilters(input),
          entityKind: input.entity_kind,
          includeArchived: input.include_archived,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const previewCrmSegment = buildTool({
    name: 'previewCrmSegment', requiresCapability: 'crm', isReadOnly: true,
    description: 'Evaluate one saved CRM segment at read time. Returns a row preview, complete current count and stable-id page. Continue rows with nextCursor/cursor and IDs with snapshotNextCursor/snapshot_cursor until null; keep the same segment and filters. A dynamic snapshot is not continuing send permission. Unknown catalog fields fail closed with valid choices.',
    inputSchema: z.object({
      ...PageInput,
      segment_id: CrmOperationsUuidSchema,
      snapshot_cursor: z.string().min(1).max(4096).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      snapshot_limit: z.number().int().min(1).max(10_000).default(1_000),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.previewSegment(workspace, input.segment_id, {
          ...pageFilters(input),
          snapshotLimit: input.snapshot_limit,
          snapshotCursor: input.snapshot_cursor,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const listCrmEntitlementPlans = buildTool({
    name: 'listCrmEntitlementPlans', requiresCapability: 'crm', isReadOnly: true,
    description: 'Enumerate CRM entitlement plans with stable plan ids and keys, lifecycle dates, publication state, and any provider or fee metadata. Use returned ids for entitlement grants instead of guessing labels. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({
      ...PageInput,
      published: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listEntitlementPlans(workspace, { ...pageFilters(input), published: input.published }) } }
      catch (error) { return failure(error) }
    },
  })
  const listCrmEntitlements = buildTool({
    name: 'listCrmEntitlements', requiresCapability: 'crm', isReadOnly: true,
    description: 'List canonical CRM entitlements with bounded contact, plan, and lifecycle-status filters. Results reuse Association membership ids and include stable plan keys, raw status, isEffective and effectiveAt. Use active_only for effective access at an optional effective_at instant; status active alone does not grant access. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({
      ...PageInput,
      contact_id: CrmOperationsUuidSchema.optional(),
      plan_id: CrmOperationsUuidSchema.optional(),
      status: EntitlementStatusSchema.optional(),
      active_only: z.boolean().optional(),
      effective_at: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listEntitlements(workspace, {
          ...pageFilters(input),
          contactId: input.contact_id, planId: input.plan_id,
          status: input.status, limit: input.limit,
          activeOnly: input.active_only, effectiveAt: input.effective_at,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const listCrmEvents = buildTool({
    name: 'listCrmEvents', requiresCapability: 'crm', isReadOnly: true,
    description: 'Enumerate CRM events over the existing Association event catalog, including stable event ids and slugs, schedule, status, capacity, and whether ticket commerce is configured. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({
      ...PageInput,
      status: z.enum(['draft', 'published', 'cancelled', 'completed']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try { return { data: await options.reads.listEvents(workspace, { ...pageFilters(input), status: input.status }) } }
      catch (error) { return failure(error) }
    },
  })
  const listCrmParticipation = buildTool({
    name: 'listCrmParticipation', requiresCapability: 'crm', isReadOnly: true,
    description: 'List canonical event participation with bounded contact, event, status, and source filters. Order-backed registrations are mapped to generic lifecycle statuses and marked commerce_managed. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({
      ...PageInput,
      contact_id: CrmOperationsUuidSchema.optional(),
      event_id: CrmOperationsUuidSchema.optional(),
      status: ParticipationStatusSchema.optional(),
      source_kind: z.enum(['commerce', 'source_order', 'manual', 'form', 'workflow', 'import']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listParticipation(workspace, {
          ...pageFilters(input),
          contactId: input.contact_id, eventId: input.event_id,
          status: input.status, sourceKind: input.source_kind, limit: input.limit,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const listCrmPipelines = buildTool({
    name: 'listCrmPipelines', requiresCapability: 'crm', isReadOnly: true,
    description: 'Enumerate the live deal pipeline catalog for this workspace, including stable pipeline and stage ids, keys, labels, categories, order, probability, required fields, and archive state. Call this before moving a deal and never guess a stage from prose. Follow nextCursor with the same filters until it is null.',
    inputSchema: z.object({
      ...PageInput,
      entity_kind: z.literal('deal').default('deal'),
      include_archived: z.boolean().default(false),
    }).strict(),
    async execute(input, context) {
      const workspace = workspaceId(context)
      if (!workspace) return workspaceError()
      try {
        return { data: await options.reads.listPipelines(workspace, {
          ...pageFilters(input),
          ...pageFilters(input),
          entityKind: input.entity_kind,
          includeArchived: input.include_archived,
        }) }
      } catch (error) { return failure(error) }
    },
  })
  const recordCrmSubmission = buildTool({
    name: 'recordCrmSubmission', requiresCapability: 'crm',
    description: 'Atomically record a CRM submission through an existing intake definition. Pass a stable definitionKey and idempotencyKey. Trusted email or external-subject matching requires owner-configured backend identityProof; never fabricate proof. Use new_or_review definitions for unverified claims and omit submittedAt. The definition controls mappings, consent, routing and follow-up. A duplicate with outcome submission_retired has no record ids: it acknowledges an erased or retained-away submission. Do not invent ids or change the key to recreate it.',
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
    description: 'Append consent evidence for a CRM contact and an enumerated purpose. Optional locale selects stored translated wording, falling back to the stored default; never infer language from the operator. The server freezes wording, hash and version. Consent withdrawal requires user confirmation.',
    inputSchema: RecordConsentInputSchema,
    resolveConfirmation: async (_context, input) => RecordConsentInputSchema.parse(input).action === 'withdrawn',
    execute: write((input) => ({
      kind: 'record_consent', contactId: input.contact_id, purposeKey: input.purpose_key,
      locale: input.locale,
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
    description: 'Idempotently grant a CRM entitlement to a contact using a stable plan_id from listCrmEntitlementPlans. This uses the same canonical membership row seen by Association operations. Provider-backed grants require backend evidence authority. A renewal after a terminal grant needs a new provider_period_id and its predecessor_id; active periods extend in place.',
    inputSchema: GrantEntitlementInputSchema,
    execute: write((input) => ({
      kind: 'grant_entitlement', contactId: input.contact_id, planId: input.plan_id,
      idempotencyKey: input.idempotency_key, status: input.status,
      startsAt: input.starts_at, endsAt: input.ends_at,
      renewalMode: input.renewal_mode, provider: input.provider,
      providerEntitlementId: input.provider_entitlement_id,
      providerPeriodId: input.provider_period_id, predecessorId: input.predecessor_id,
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
  const setDealPipelineStage = buildTool({
    name: 'setDealPipelineStage', requiresCapability: 'crm',
    description: 'Move one deal to an enumerated workspace pipeline stage using stable ids returned by listCrmPipelines. The pipeline_id and stage_id must describe the same live catalog entry.',
    inputSchema: SetDealPipelineStageInputSchema,
    execute: write((input) => ({
      kind: 'set_deal_pipeline_stage', dealId: input.deal_id,
      pipelineId: input.pipeline_id, stageId: input.stage_id,
    } as CrmOperationsCommand)),
  })

  return {
    listCrmIntakeDefinitions, listCrmSubmissions, getCrmSubmission,
    listCrmConsentPurposes, getCrmConsent, checkCrmSendability,
    listCrmSegments, previewCrmSegment,
    listCrmEntitlementPlans, listCrmEntitlements, listCrmEvents, listCrmParticipation,
    listCrmPipelines,
    recordCrmSubmission, updateCrmSubmission, recordCrmConsent, recordCrmSuppression,
    saveCrmSegment, archiveCrmSegment,
    grantCrmEntitlement, updateCrmEntitlement,
    recordCrmParticipation, updateCrmParticipation, setDealPipelineStage,
    saveCrmEntitlementPlan, saveCrmEvent, sendCrmMessage, getCrmDelivery,
  }
}

type TRecordSubmission = Extract<CrmOperationsCommand, { kind: 'record_submission' }>
