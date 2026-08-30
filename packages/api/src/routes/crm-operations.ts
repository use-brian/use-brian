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
  CrmOperationsError,
  CrmOperationsStableKeySchema,
  CrmOperationsUuidSchema,
  RecordCrmConsentCommandSchema,
  RecordCrmSuppressionCommandSchema,
  SaveCrmIntakeDefinitionCommandSchema,
  SaveCrmConsentPurposeCommandSchema,
  UpdateCrmSubmissionCommandSchema,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { DbCrmOperationsReadStore } from '../db/crm-intake-store.js'

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

type Options = {
  workspaceStore: WorkspaceStore
  service: CrmOperationsServicePort
  readStore: DbCrmOperationsReadStore
}

function writeError(res: Response, error: unknown): void {
  if (error instanceof CrmOperationsError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'not_authorized' ? 403
        : error.code === 'conflict' ? 409 : 400
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

  return router
}
