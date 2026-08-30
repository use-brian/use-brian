/**
 * Member-authenticated REST adapter for CRM operations.
 *
 * [COMP:api/crm-operations-route]
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  CreateCrmIntakeCredentialCommandSchema,
  CrmDeliveryChannelSchema,
  GrantCrmEntitlementCommandSchema,
  CrmOperationsError,
  CrmOperationsStableKeySchema,
  CrmOperationsUuidSchema,
  RecordCrmConsentCommandSchema,
  RecordCrmParticipationCommandSchema,
  RecordCrmSuppressionCommandSchema,
  SaveCrmIntakeDefinitionCommandSchema,
  SaveCrmConsentPurposeCommandSchema,
  SaveCrmSegmentCommandSchema,
  UpdateCrmSubmissionCommandSchema,
  UpdateCrmEntitlementCommandSchema,
  UpdateCrmParticipationCommandSchema,
  SetDealPipelineStageCommandSchema,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { DbCrmOperationsReadStore } from '../db/crm-intake-store.js'
import {
  CrmImportConfirmSchema,
  CrmImportPreflightSchema,
  type CrmProductionImportService,
} from '../crm-operations/import-service.js'
import {
  exportCrmOperationsPrivacy,
  listCrmEventDelivery,
  listCrmOperationsAudit,
  pruneCrmOperationsRetention,
} from '../crm-operations/privacy.js'

const SaveDefinitionBody = SaveCrmIntakeDefinitionCommandSchema.omit({ kind: true }).strict()
const CreateCredentialBody = CreateCrmIntakeCredentialCommandSchema.omit({ kind: true }).strict()
const UpdateSubmissionBody = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  queueKey: CrmOperationsStableKeySchema.optional(),
  ownerUserId: CrmOperationsUuidSchema.nullable().optional(),
  note: z.string().trim().min(1).max(20_000).optional(),
}).strict().refine(
  (value) => value.status !== undefined || value.queueKey !== undefined
    || value.ownerUserId !== undefined || value.note !== undefined,
  'at least one submission change is required',
)
const SavePurposeBody = SaveCrmConsentPurposeCommandSchema.omit({ kind: true }).strict()
const ConsentBody = z.object({
  purposeKey: CrmOperationsStableKeySchema,
  action: z.enum(['granted', 'withdrawn']),
  source: CrmOperationsStableKeySchema,
  occurredAt: z.string().datetime({ offset: true }).optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)
const SuppressionBody = z.object({
  channel: z.enum(['all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack']),
  action: z.enum(['suppressed', 'released']),
  reasonCode: z.enum([
    'manual_do_not_contact', 'hard_bounce', 'soft_bounce', 'complaint',
    'provider_block', 'legal', 'invalid_address', 'other',
  ]),
  source: CrmOperationsStableKeySchema,
  occurredAt: z.string().datetime({ offset: true }).optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)
const SubmissionQuery = z.object({
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  definitionKey: CrmOperationsStableKeySchema.optional(),
  ownerUserId: CrmOperationsUuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const SendabilityQuery = z.object({
  channel: CrmDeliveryChannelSchema,
  purposeKey: CrmOperationsStableKeySchema,
}).strict()
const SaveSegmentCreateBody = SaveCrmSegmentCommandSchema.omit({ kind: true, segmentId: true }).strict()
const SaveSegmentUpdateBody = SaveCrmSegmentCommandSchema.omit({ kind: true, segmentId: true }).strict()
const SegmentListQuery = z.object({
  entityKind: z.enum(['person', 'company', 'deal']).default('person'),
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()
const SegmentPreviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  snapshotLimit: z.coerce.number().int().min(1).max(10_000).default(1_000),
}).strict()
const EntitlementStatus = z.enum(['pending', 'active', 'expired', 'cancelled'])
const ParticipationStatus = z.enum(['registered', 'attended', 'cancelled', 'no_show'])
const EntitlementPlansQuery = z.object({
  published: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const EntitlementsQuery = z.object({
  contactId: CrmOperationsUuidSchema.optional(),
  planId: CrmOperationsUuidSchema.optional(),
  status: EntitlementStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const EventsQuery = z.object({
  status: z.enum(['draft', 'published', 'cancelled', 'completed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const ParticipationQuery = z.object({
  contactId: CrmOperationsUuidSchema.optional(),
  eventId: CrmOperationsUuidSchema.optional(),
  status: ParticipationStatus.optional(),
  sourceKind: z.enum(['commerce', 'manual', 'form', 'workflow', 'import']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const GrantEntitlementBody = z.object({
  contactId: CrmOperationsUuidSchema,
  planId: CrmOperationsUuidSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  status: EntitlementStatus.default('pending'),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).default('none'),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEntitlementId: z.string().trim().min(1).max(500).optional(),
}).strict().refine(
  (value) => (value.provider === undefined) === (value.providerEntitlementId === undefined),
  'provider and providerEntitlementId must be supplied together',
).refine((value) => !value.endsAt || value.startsAt < value.endsAt, 'endsAt must be after startsAt')
const UpdateEntitlementBody = z.object({
  status: EntitlementStatus.optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).optional(),
}).strict().refine(
  (value) => value.status !== undefined || value.endsAt !== undefined || value.renewalMode !== undefined,
  'at least one entitlement change is required',
)
const RecordParticipationBody = RecordCrmParticipationCommandSchema.omit({ kind: true }).strict()
const UpdateParticipationBody = UpdateCrmParticipationCommandSchema.omit({ kind: true, participationId: true }).strict()
const PipelineListQuery = z.object({
  entityKind: z.literal('deal').default('deal'),
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()
const SetPipelineStageBody = SetDealPipelineStageCommandSchema
  .omit({ kind: true, dealId: true }).strict()
const OperationsLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const RetentionBody = z.object({
  before: z.string().datetime({ offset: true }),
  confirmed: z.literal(true),
}).strict()

type Options = {
  workspaceStore: WorkspaceStore
  service: CrmOperationsServicePort
  readStore: DbCrmOperationsReadStore
  importService?: CrmProductionImportService
}

function writeError(res: Response, error: unknown): void {
  if (error instanceof CrmOperationsError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'not_authorized' ? 403
      : error.code === 'conflict' || error.code === 'idempotency_conflict' ? 409 : 400
    res.status(status).json({ error: error.code, message: error.message, ...error.details })
    return
  }
  console.error('[crm-operations] request failed', error instanceof Error ? error.message : 'unknown')
  res.status(500).json({ error: 'internal' })
}

export function crmOperationsRoutes(options: Options): Router {
  const router = Router()

  async function context(req: Request, res: Response): Promise<CrmOperationsContext | null> {
    const userId = req.userId
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : ''
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await options.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    return {
      workspaceId,
      actor: { kind: 'user', userId },
      authority: {
        role,
        canWrite: true,
        canConfigure: role === 'owner' || role === 'admin',
        trustedIdentitySources: [],
      },
    }
  }

  router.get('/:workspaceId/operations/intake-definitions', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    try {
      res.json({ definitions: await options.readStore.listDefinitions(ctx.workspaceId) })
    } catch (error) {
      writeError(res, error)
    }
  })

  router.post('/:workspaceId/operations/intake-definitions', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = SaveDefinitionBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, { kind: 'save_intake_definition', ...body.data })
      res.status(output.created ? 201 : 200).json(output)
    } catch (error) {
      writeError(res, error)
    }
  })

  router.get('/:workspaceId/operations/intake-credentials', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!ctx.authority.canConfigure) {
      res.status(403).json({ error: 'not_authorized' })
      return
    }
    try {
      res.json({ credentials: await options.readStore.listCredentials(ctx.workspaceId) })
    } catch (error) {
      writeError(res, error)
    }
  })

  router.post('/:workspaceId/operations/intake-credentials', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = CreateCredentialBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, { kind: 'create_intake_credential', ...body.data })
      res.status(201).json({ ...output, key: output.oneTimeSecret })
    } catch (error) {
      writeError(res, error)
    }
  })

  router.delete('/:workspaceId/operations/intake-credentials/:credentialId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const credentialId = typeof req.params.credentialId === 'string' ? req.params.credentialId : ''
    try {
      const output = await options.service.execute(ctx, { kind: 'revoke_intake_credential', credentialId })
      res.json(output)
    } catch (error) {
      writeError(res, error)
    }
  })

  router.get('/:workspaceId/operations/submissions', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = SubmissionQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ submissions: await options.readStore.listSubmissions(ctx.workspaceId, filters.data) })
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/submissions/:submissionId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const submissionId = CrmOperationsUuidSchema.safeParse(req.params.submissionId)
    if (!submissionId.success) {
      res.status(400).json({ error: 'invalid_input', issues: submissionId.error.issues })
      return
    }
    try {
      const submission = await options.readStore.getSubmission(ctx.workspaceId, submissionId.data)
      if (!submission) res.status(404).json({ error: 'not_found' })
      else res.json({ submission })
    } catch (error) { writeError(res, error) }
  })

  router.patch('/:workspaceId/operations/submissions/:submissionId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const submissionId = CrmOperationsUuidSchema.safeParse(req.params.submissionId)
    const body = UpdateSubmissionBody.safeParse(req.body)
    if (!submissionId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: submissionId.success ? body.error?.issues : submissionId.error.issues })
      return
    }
    try {
      res.json(await options.service.execute(ctx, UpdateCrmSubmissionCommandSchema.parse({
        kind: 'update_submission', submissionId: submissionId.data, ...body.data,
      })))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/consent-purposes', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    try {
      res.json({ purposes: await options.readStore.listConsentPurposes(
        ctx.workspaceId, req.query.includeArchived === 'true',
      ) })
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/consent-purposes', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = SavePurposeBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, { kind: 'save_consent_purpose', ...body.data })
      res.status(output.created ? 201 : 200).json(output)
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/contacts/:contactId/compliance', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const contactId = CrmOperationsUuidSchema.safeParse(req.params.contactId)
    if (!contactId.success) {
      res.status(400).json({ error: 'invalid_input', issues: contactId.error.issues })
      return
    }
    try { res.json(await options.readStore.getConsent(ctx.workspaceId, contactId.data)) }
    catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/contacts/:contactId/consent', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const contactId = CrmOperationsUuidSchema.safeParse(req.params.contactId)
    const body = ConsentBody.safeParse(req.body)
    if (!contactId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: contactId.success ? body.error?.issues : contactId.error.issues })
      return
    }
    try {
      res.status(201).json(await options.service.execute(ctx, RecordCrmConsentCommandSchema.parse({
        kind: 'record_consent', contactId: contactId.data, ...body.data,
      })))
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/contacts/:contactId/suppressions', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const contactId = CrmOperationsUuidSchema.safeParse(req.params.contactId)
    const body = SuppressionBody.safeParse(req.body)
    if (!contactId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: contactId.success ? body.error?.issues : contactId.error.issues })
      return
    }
    try {
      res.status(201).json(await options.service.execute(ctx, RecordCrmSuppressionCommandSchema.parse({
        kind: 'record_suppression', contactId: contactId.data, ...body.data,
      })))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/contacts/:contactId/sendability', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const contactId = CrmOperationsUuidSchema.safeParse(req.params.contactId)
    const query = SendabilityQuery.safeParse(req.query)
    if (!contactId.success || !query.success) {
      res.status(400).json({ error: 'invalid_input', issues: contactId.success ? query.error?.issues : contactId.error.issues })
      return
    }
    try {
      res.json(await options.readStore.checkSendability(
        ctx.workspaceId, contactId.data, query.data.channel, query.data.purposeKey,
      ))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/segments', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const parsed = SegmentListQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input', issues: parsed.error.issues })
      return
    }
    try {
      res.json(await options.readStore.listSegments(ctx.workspaceId, {
        entityKind: parsed.data.entityKind,
        includeArchived: parsed.data.includeArchived === 'true',
      }))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/workflow-event-catalog', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    try { res.json(await options.readStore.listCrmEventFilterCatalog(ctx.workspaceId)) }
    catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/segments', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = SaveSegmentCreateBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, { kind: 'save_segment', ...body.data })
      res.status(201).json(output)
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/segments/:segmentId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const segmentId = CrmOperationsUuidSchema.safeParse(req.params.segmentId)
    if (!segmentId.success) {
      res.status(400).json({ error: 'invalid_input', issues: segmentId.error.issues })
      return
    }
    try {
      const segment = await options.readStore.getSegment(ctx.workspaceId, segmentId.data)
      if (!segment) res.status(404).json({ error: 'not_found' })
      else res.json({ segment })
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/segments/:segmentId/preview', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const segmentId = CrmOperationsUuidSchema.safeParse(req.params.segmentId)
    const query = SegmentPreviewQuery.safeParse(req.query)
    if (!segmentId.success || !query.success) {
      res.status(400).json({ error: 'invalid_input', issues: segmentId.success ? query.error?.issues : segmentId.error.issues })
      return
    }
    try {
      res.json(await options.readStore.previewSegment(ctx.workspaceId, segmentId.data, query.data))
    } catch (error) { writeError(res, error) }
  })

  router.patch('/:workspaceId/operations/segments/:segmentId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const segmentId = CrmOperationsUuidSchema.safeParse(req.params.segmentId)
    const body = SaveSegmentUpdateBody.safeParse(req.body)
    if (!segmentId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: segmentId.success ? body.error?.issues : segmentId.error.issues })
      return
    }
    try {
      res.json(await options.service.execute(ctx, {
        kind: 'save_segment', segmentId: segmentId.data, ...body.data,
      }))
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/segments/:segmentId/archive', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const segmentId = CrmOperationsUuidSchema.safeParse(req.params.segmentId)
    const body = z.object({ expectedVersion: z.number().int().positive().optional() }).strict().safeParse(req.body)
    if (!segmentId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: segmentId.success ? body.error?.issues : segmentId.error.issues })
      return
    }
    try {
      res.json(await options.service.execute(ctx, {
        kind: 'archive_segment', segmentId: segmentId.data,
        expectedVersion: body.data.expectedVersion,
      }))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/entitlement-plans', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = EntitlementPlansQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ plans: await options.readStore.listEntitlementPlans(ctx.workspaceId, filters.data) })
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/entitlements', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = EntitlementsQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ entitlements: await options.readStore.listEntitlements(ctx.workspaceId, filters.data) })
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/entitlements', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = GrantEntitlementBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, GrantCrmEntitlementCommandSchema.parse({
        kind: 'grant_entitlement', ...body.data,
      }))
      res.status(output.created ? 201 : 200).json(output)
    } catch (error) { writeError(res, error) }
  })

  router.patch('/:workspaceId/operations/entitlements/:entitlementId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const entitlementId = CrmOperationsUuidSchema.safeParse(req.params.entitlementId)
    const body = UpdateEntitlementBody.safeParse(req.body)
    if (!entitlementId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: entitlementId.success ? body.error?.issues : entitlementId.error.issues })
      return
    }
    try {
      res.json(await options.service.execute(ctx, UpdateCrmEntitlementCommandSchema.parse({
        kind: 'update_entitlement', entitlementId: entitlementId.data, ...body.data,
      })))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/events', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = EventsQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try { res.json({ events: await options.readStore.listEvents(ctx.workspaceId, filters.data) }) }
    catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/participation', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = ParticipationQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ participation: await options.readStore.listParticipation(ctx.workspaceId, filters.data) })
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/participation', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = RecordParticipationBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, RecordCrmParticipationCommandSchema.parse({
        kind: 'record_participation', ...body.data,
      }))
      res.status(output.created ? 201 : 200).json(output)
    } catch (error) { writeError(res, error) }
  })

  router.patch('/:workspaceId/operations/participation/:participationId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const participationId = CrmOperationsUuidSchema.safeParse(req.params.participationId)
    const body = UpdateParticipationBody.safeParse(req.body)
    if (!participationId.success || !body.success) {
      res.status(400).json({ error: 'invalid_input', issues: participationId.success ? body.error?.issues : participationId.error.issues })
      return
    }
    try {
      res.json(await options.service.execute(ctx, UpdateCrmParticipationCommandSchema.parse({
        kind: 'update_participation', participationId: participationId.data, ...body.data,
      })))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/pipelines', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = PipelineListQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ pipelines: await options.readStore.listPipelines(ctx.workspaceId, {
        entityKind: filters.data.entityKind,
        includeArchived: filters.data.includeArchived === 'true',
      }) })
    } catch (error) { writeError(res, error) }
  })

  router.patch('/:workspaceId/operations/deals/:dealId/pipeline-stage', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const dealId = CrmOperationsUuidSchema.safeParse(req.params.dealId)
    const body = SetPipelineStageBody.safeParse(req.body)
    if (!dealId.success || !body.success) {
      res.status(400).json({
        error: 'invalid_input',
        issues: dealId.success ? body.error?.issues : dealId.error.issues,
      })
      return
    }
    try {
      res.json(await options.service.execute(ctx, {
        kind: 'set_deal_pipeline_stage', dealId: dealId.data, ...body.data,
      }))
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/imports/dry-run', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    const input = CrmImportPreflightSchema.safeParse(req.body)
    if (!input.success) {
      res.status(400).json({ error: 'invalid_input', issues: input.error.issues })
      return
    }
    try {
      if (ctx.actor.kind !== 'user') throw new Error('Member import requires a user actor.')
      res.json(await options.importService.dryRun(ctx as CrmOperationsContext & { actor: { kind: 'user'; userId: string } }, input.data))
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/imports', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    const input = CrmImportConfirmSchema.safeParse(req.body)
    if (!input.success) {
      res.status(400).json({ error: 'invalid_input', issues: input.error.issues })
      return
    }
    try {
      if (ctx.actor.kind !== 'user') throw new Error('Member import requires a user actor.')
      res.status(201).json(await options.importService.confirm(ctx as CrmOperationsContext & { actor: { kind: 'user'; userId: string } }, input.data))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/imports', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    try {
      res.json({ jobs: await options.importService.list(ctx.workspaceId) })
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/imports/:jobId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    const jobId = CrmOperationsUuidSchema.safeParse(req.params.jobId)
    if (!jobId.success) {
      res.status(400).json({ error: 'invalid_input', issues: jobId.error.issues })
      return
    }
    try {
      const job = await options.importService.get(ctx.workspaceId, jobId.data)
      if (!job) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.json(job)
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/imports/:jobId/resume', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    const jobId = CrmOperationsUuidSchema.safeParse(req.params.jobId)
    if (!jobId.success) {
      res.status(400).json({ error: 'invalid_input', issues: jobId.error.issues })
      return
    }
    try {
      if (ctx.actor.kind !== 'user') throw new Error('Member import requires a user actor.')
      res.json(await options.importService.resume(ctx as CrmOperationsContext & { actor: { kind: 'user'; userId: string } }, jobId.data))
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/imports/:jobId/cancel', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    const jobId = CrmOperationsUuidSchema.safeParse(req.params.jobId)
    if (!jobId.success) {
      res.status(400).json({ error: 'invalid_input', issues: jobId.error.issues })
      return
    }
    try {
      if (ctx.actor.kind !== 'user') throw new Error('Member import requires a user actor.')
      res.json(await options.importService.cancel(ctx as CrmOperationsContext & { actor: { kind: 'user'; userId: string } }, jobId.data))
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/imports/:jobId/errors.csv', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!options.importService) {
      res.status(503).json({ error: 'import_unavailable' })
      return
    }
    const jobId = CrmOperationsUuidSchema.safeParse(req.params.jobId)
    if (!jobId.success) {
      res.status(400).json({ error: 'invalid_input', issues: jobId.error.issues })
      return
    }
    try {
      const csv = await options.importService.errorsCsv(ctx.workspaceId, jobId.data)
      if (csv === null) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="crm-import-${jobId.data}-errors.csv"`)
      res.send(csv)
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/audit', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = OperationsLogQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ entries: await listCrmOperationsAudit(ctx.workspaceId, filters.data.limit) })
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/event-delivery', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const filters = OperationsLogQuery.safeParse(req.query)
    if (!filters.success) {
      res.status(400).json({ error: 'invalid_input', issues: filters.error.issues })
      return
    }
    try {
      res.json({ events: await listCrmEventDelivery(ctx.workspaceId, filters.data.limit) })
    } catch (error) { writeError(res, error) }
  })

  router.get('/:workspaceId/operations/privacy-export', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!ctx.authority.canConfigure) {
      res.status(403).json({ error: 'not_authorized' })
      return
    }
    try {
      res.setHeader('Content-Disposition', `attachment; filename="crm-operations-${ctx.workspaceId}.json"`)
      res.json(await exportCrmOperationsPrivacy(ctx.workspaceId))
    } catch (error) { writeError(res, error) }
  })

  router.post('/:workspaceId/operations/retention', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!ctx.authority.canConfigure) {
      res.status(403).json({ error: 'not_authorized' })
      return
    }
    const body = RetentionBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      res.json(await pruneCrmOperationsRetention(ctx.workspaceId, new Date(body.data.before)))
    } catch (error) { writeError(res, error) }
  })

  return router
}
