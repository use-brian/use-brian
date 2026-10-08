/** Member-authenticated native campaign REST adapter. [COMP:campaigns/store] */
import { Router, type Response } from 'express'
import { z } from 'zod'
import {
  CampaignError,
  type CampaignContext,
  type CampaignReadPort,
  type CampaignServicePort,
} from '@use-brian/core'
import {
  campaignAttachContentSchema,
  campaignCreateLinkSchema,
  campaignEmailMetadataSchema,
  campaignManualPublicationSchema,
  campaignPrepareDispatchSchema,
  campaignSaveObjectSchema,
  campaignSetLinkEnabledSchema,
  campaignSiteSaveObjectSchema,
  campaignUuidSchema,
} from '@use-brian/shared/campaigns'
import { createCampaignService } from '../campaigns/service.js'
import { createDbCampaignStore } from '../db/campaign-store.js'
import { createCampaignTrackingStore, type CampaignTrackingStore } from '../db/campaign-tracking-store.js'
import { canMemberDraftRole, getWorkspaceMembershipSystem } from '../db/workspace-store.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import { getEntityById } from '../db/entities-store.js'
import { campaignReadActor, createCampaignEmailService, type CampaignEmailService } from '../content-planning/email.js'
import type { CampaignDispatchService } from '../campaigns/dispatch.js'

const WorkspaceQuery = z.object({ workspaceId: campaignUuidSchema }).strict()
const ListQuery = WorkspaceQuery.extend({
  state: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const CommandBody = z.object({
  workspaceId: campaignUuidSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
  command: z.discriminatedUnion('kind', [
    campaignSaveObjectSchema.extend({ kind: z.literal('save_campaign') }),
    z.object({ kind: z.literal('archive_campaign'), campaignId: campaignUuidSchema }).strict(),
    campaignAttachContentSchema.extend({ kind: z.literal('attach_content') }),
    campaignManualPublicationSchema.extend({ kind: z.literal('record_manual_publication') }),
    campaignCreateLinkSchema.extend({ kind: z.literal('create_link') }),
    campaignSetLinkEnabledSchema.extend({ kind: z.literal('set_link_enabled') }),
    campaignSiteSaveObjectSchema.extend({ kind: z.literal('save_site') }),
    campaignPrepareDispatchSchema.extend({ kind: z.literal('prepare_dispatch') }),
    z.object({ kind: z.literal('schedule_dispatch'), dispatchId: campaignUuidSchema, scheduledAt: z.string().datetime({ offset: true }) }).strict(),
    z.object({ kind: z.literal('pause_dispatch'), dispatchId: campaignUuidSchema }).strict(),
    z.object({ kind: z.literal('cancel_dispatch'), dispatchId: campaignUuidSchema }).strict(),
  ]),
}).strict()

export type CampaignRouteAccess = {
  userId: string
  workspaceId: string
  role: 'owner' | 'admin' | 'member'
  canWrite: boolean
}

function campaignContext(access: CampaignRouteAccess): CampaignContext {
  return {
    workspaceId: access.workspaceId,
    actor: { kind: 'user', userId: access.userId },
    authority: {
      role: access.role,
      canRead: true,
      canWrite: access.canWrite,
      canConfigure: access.role === 'owner' || access.role === 'admin',
      // Final transport admission still rechecks the exact mailbox and CRM
      // policy. Only workspace operators may create or control a broadcast.
      canSend: access.canWrite && (access.role === 'owner' || access.role === 'admin'),
    },
  }
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid_input', details: error.flatten() })
    return
  }
  if (error instanceof CampaignError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'forbidden' ? 403
        : error.code === 'conflict' ? 409
          : error.code === 'rate_limited' ? 429
            : error.code === 'unavailable' ? 503 : 400
    res.status(status).json({ error: error.code, message: error.message, ...error.details })
    return
  }
  console.error('[campaigns] request failed:', error)
  res.status(500).json({ error: 'internal' })
}

export function campaignRoutes(options: {
  service?: CampaignServicePort
  reads?: CampaignReadPort
  trackingStore?: CampaignTrackingStore
  emailService?: CampaignEmailService
  dispatchService?: CampaignDispatchService
  resolveAccess?: (userId: string, workspaceId: string) => Promise<CampaignRouteAccess | null>
  canReadCrmRecord?: (userId: string, workspaceId: string, recordId: string) => Promise<boolean>
} = {}): Router {
  const router = Router()
  const store = createDbCampaignStore()
  const trackingStore = options.trackingStore ?? createCampaignTrackingStore()
  const emailService = options.emailService ?? createCampaignEmailService()
  const service = options.service ?? createCampaignService(store, trackingStore, emailService, options.dispatchService)
  const reads: CampaignReadPort = options.reads ?? {
    listCampaigns: (workspaceId, filters) => store.listCampaigns(workspaceId, filters),
    getCampaign: (workspaceId, campaignId) => store.getCampaign(workspaceId, campaignId),
    listLinks: (workspaceId, campaignId) => store.listLinks(workspaceId, campaignId),
    getTrackingSetup: (workspaceId, siteId) => trackingStore.trackingSetup(workspaceId, siteId),
    getResults: (workspaceId, campaignId, filters) => trackingStore.results(workspaceId, campaignId, filters),
    getAttribution: (workspaceId, campaignId, filters) => trackingStore.attribution(workspaceId, campaignId, filters),
    previewAudience: async () => ({ state: 'unavailable', reason: 'Email audience review is not enabled.' }),
    previewEmail: async () => ({ state: 'unavailable', reason: 'Email preview is not enabled.' }),
  }
  const resolveAccess = options.resolveAccess ?? (async (userId: string, workspaceId: string) => {
    const membership = await getWorkspaceMembershipSystem(userId, workspaceId)
    return membership ? {
      userId,
      workspaceId,
      role: membership.role,
      canWrite: canMemberDraftRole(membership.role, membership.canDraft),
    } : null
  })
  const canReadCrmRecord = options.canReadCrmRecord ?? (async (userId: string, workspaceId: string, recordId: string) => {
    const viewpoint = await resolveWorkspaceViewpoint(userId, workspaceId)
    if (!viewpoint) return false
    const entity = await getEntityById(viewpoint, recordId)
    return entity?.kind === 'person' || entity?.kind === 'deal'
  })

  async function access(req: { userId?: string }, res: Response, workspaceId: string): Promise<CampaignRouteAccess | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'unauthorized' })
      return null
    }
    const resolved = await resolveAccess(req.userId, workspaceId)
    if (!resolved) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    return resolved
  }

  router.get('/', async (req, res) => {
    try {
      const input = ListQuery.parse(req.query)
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      res.json({ campaigns: await reads.listCampaigns(input.workspaceId, { state: input.state, limit: input.limit }) })
    } catch (error) { respondError(res, error) }
  })

  router.post('/commands', async (req, res) => {
    try {
      const input = CommandBody.parse(req.body)
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      const receipt = await service.execute(campaignContext(auth), {
        idempotencyKey: input.idempotencyKey,
        command: input.command,
      })
      res.status(receipt.replayed ? 200 : 201).json(receipt)
    } catch (error) { respondError(res, error) }
  })

  router.get('/sites', async (req, res) => {
    try {
      const input = WorkspaceQuery.parse(req.query)
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      res.json(await reads.getTrackingSetup(input.workspaceId))
    } catch (error) { respondError(res, error) }
  })

  router.get('/email/catalog', async (req, res) => {
    try {
      const input = WorkspaceQuery.parse(req.query)
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      res.json(await emailService.catalog(auth))
    } catch (error) { respondError(res, error) }
  })

  const EmailPlacement = WorkspaceQuery.extend({
    campaignId: campaignUuidSchema,
    placementId: campaignUuidSchema,
  }).strict()

  router.get('/:campaignId/placements/:placementId/email', async (req, res) => {
    try {
      const input = EmailPlacement.parse({ ...req.query, campaignId: req.params.campaignId, placementId: req.params.placementId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      const draft = await emailService.read(input.workspaceId, input.placementId)
      if (draft.campaignId !== input.campaignId) throw new CampaignError('not_found', 'Email campaign placement was not found.')
      res.json({ draft: { ...draft, content: undefined } })
    } catch (error) { respondError(res, error) }
  })

  router.post('/:campaignId/placements/:placementId/email/commands', async (req, res) => {
    try {
      const input = EmailPlacement.extend({
        mutationId: campaignUuidSchema,
        expectedRevision: z.number().int().nonnegative(),
        metadata: campaignEmailMetadataSchema,
      }).parse({ ...req.body, campaignId: req.params.campaignId, placementId: req.params.placementId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      if (!auth.canWrite) throw new CampaignError('forbidden', 'Campaign draft permission is required.')
      const current = await emailService.read(input.workspaceId, input.placementId)
      if (current.campaignId !== input.campaignId) throw new CampaignError('not_found', 'Email campaign placement was not found.')
      res.json(await emailService.update(auth, input.placementId, input))
    } catch (error) { respondError(res, error) }
  })

  router.post('/:campaignId/placements/:placementId/email/preview', async (req, res) => {
    try {
      const input = EmailPlacement.extend({
        revision: z.number().int().nonnegative().optional(),
        values: z.record(z.string(), z.string().max(2_000)).default({}),
      }).parse({ ...req.body, campaignId: req.params.campaignId, placementId: req.params.placementId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      const current = await emailService.read(input.workspaceId, input.placementId)
      if (current.campaignId !== input.campaignId) throw new CampaignError('not_found', 'Email campaign placement was not found.')
      res.json(await emailService.preview(input.workspaceId, input.placementId, input.values, input.revision))
    } catch (error) { respondError(res, error) }
  })

  router.post('/:campaignId/placements/:placementId/email/audience-preview', async (req, res) => {
    try {
      const input = EmailPlacement.parse({ ...req.body, campaignId: req.params.campaignId, placementId: req.params.placementId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      const current = await emailService.read(input.workspaceId, input.placementId)
      if (current.campaignId !== input.campaignId) throw new CampaignError('not_found', 'Email campaign placement was not found.')
      res.json(await emailService.audience(input.workspaceId, input.placementId, campaignReadActor(campaignContext(auth).actor)))
    } catch (error) { respondError(res, error) }
  })

  router.post('/:campaignId/placements/:placementId/email/test', async (req, res) => {
    try {
      const input = EmailPlacement.extend({ contactId: campaignUuidSchema, deliveryId: campaignUuidSchema })
        .parse({ ...req.body, campaignId: req.params.campaignId, placementId: req.params.placementId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      if (!auth.canWrite) throw new CampaignError('forbidden', 'Campaign draft permission is required.')
      const current = await emailService.read(input.workspaceId, input.placementId)
      if (current.campaignId !== input.campaignId) throw new CampaignError('not_found', 'Email campaign placement was not found.')
      res.status(201).json(await emailService.sendTest(auth, input.placementId, input.contactId, undefined, input.deliveryId))
    } catch (error) { respondError(res, error) }
  })

  router.get('/:campaignId/dispatches/:dispatchId', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({ campaignId: campaignUuidSchema, dispatchId: campaignUuidSchema })
        .parse({ ...req.query, campaignId: req.params.campaignId, dispatchId: req.params.dispatchId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      if (!options.dispatchService) throw new CampaignError('unavailable', 'Campaign dispatch is not configured.')
      const result = await options.dispatchService.read(input.workspaceId, input.dispatchId, campaignReadActor(campaignContext(auth).actor))
      if ((result.dispatch as { campaignId?: string }).campaignId !== input.campaignId) throw new CampaignError('not_found', 'Campaign dispatch was not found.')
      res.json(result)
    } catch (error) { respondError(res, error) }
  })

  router.get('/contacts/:contactId/attribution', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({ contactId: campaignUuidSchema }).parse({ ...req.query, contactId: req.params.contactId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      if (!await canReadCrmRecord(auth.userId, input.workspaceId, input.contactId)) {
        return void res.status(404).json({ error: 'not_found' })
      }
      res.json(await trackingStore.subjectAttribution(input.workspaceId, input.contactId))
    } catch (error) { respondError(res, error) }
  })

  router.post('/sites/:siteId/credentials', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({ siteId: campaignUuidSchema }).parse({ ...req.body, siteId: req.params.siteId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      if (auth.role === 'member') throw new CampaignError('forbidden', 'Campaign configuration authority is required.')
      const { secret, ...credential } = await trackingStore.issueCredential(input.workspaceId, input.siteId, auth.userId)
      res.status(201).json({ credential: { ...credential, oneTimeSecret: secret } })
    } catch (error) { respondError(res, error) }
  })

  router.delete('/sites/:siteId/credentials/:credentialId', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({ siteId: campaignUuidSchema, credentialId: campaignUuidSchema })
        .parse({ ...req.query, siteId: req.params.siteId, credentialId: req.params.credentialId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      if (auth.role === 'member') throw new CampaignError('forbidden', 'Campaign configuration authority is required.')
      if (!await trackingStore.revokeCredential(input.workspaceId, input.siteId, input.credentialId)) {
        throw new CampaignError('not_found', 'Campaign credential not found.')
      }
      res.status(204).end()
    } catch (error) { respondError(res, error) }
  })

  router.get('/:campaignId/links', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({ campaignId: campaignUuidSchema }).parse({ ...req.query, campaignId: req.params.campaignId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      res.json({ links: await reads.listLinks(input.workspaceId, input.campaignId) })
    } catch (error) { respondError(res, error) }
  })

  router.get('/:campaignId/results', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({
        campaignId: campaignUuidSchema,
        model: z.enum(['first_touch', 'last_touch']).default('last_touch'),
        include_test: z.enum(['true', 'false']).default('false'),
      }).parse({ ...req.query, campaignId: req.params.campaignId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      res.json(await reads.getResults(input.workspaceId, input.campaignId, {
        model: input.model,
        include_test: input.include_test === 'true',
      }))
    } catch (error) { respondError(res, error) }
  })

  router.get('/:campaignId/attribution', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({
        campaignId: campaignUuidSchema,
        model: z.enum(['first_touch', 'last_touch']).default('last_touch'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }).parse({ ...req.query, campaignId: req.params.campaignId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      res.json(await reads.getAttribution(input.workspaceId, input.campaignId, input))
    } catch (error) { respondError(res, error) }
  })

  router.get('/:campaignId', async (req, res) => {
    try {
      const input = WorkspaceQuery.extend({ campaignId: campaignUuidSchema }).parse({ ...req.query, campaignId: req.params.campaignId })
      const auth = await access(req, res, input.workspaceId)
      if (!auth) return
      const campaign = await reads.getCampaign(input.workspaceId, input.campaignId)
      if (!campaign) return void res.status(404).json({ error: 'not_found' })
      res.json({ campaign })
    } catch (error) { respondError(res, error) }
  })

  return router
}
