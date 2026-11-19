/** Canonical semantic mutation service for campaigns. [COMP:campaigns/store] */
import {
  CampaignError,
  campaignRequestFingerprint,
  requireCampaignAuthority,
  type CampaignCommand,
  type CampaignContext,
  type CampaignServicePort,
} from '@use-brian/core/campaigns/types.js'
import {
  campaignAttachContentSchema,
  campaignCreateLinkSchema,
  campaignHttpUrlSchema,
  campaignManualPublicationSchema,
  campaignPrepareDispatchSchema,
  campaignSaveSchema,
  campaignSiteSaveSchema,
} from '@use-brian/shared/campaigns'
import { campaignOpaqueToken, createDbCampaignStore, type CampaignStore } from '../db/campaign-store.js'
import { createCampaignTrackingStore, type CampaignTrackingStore } from '../db/campaign-tracking-store.js'
import { buildCampaignDestination } from './links.js'
import type { CampaignDispatchService } from './dispatch.js'

function actorUserId(context: CampaignContext): string | null {
  return context.actor.userId ?? null
}

export function createCampaignService(
  store: CampaignStore = createDbCampaignStore(),
  trackingStore: CampaignTrackingStore = createCampaignTrackingStore(),
  email?: { sendTest(actor: { userId: string; workspaceId: string; role: 'owner' | 'admin' | 'member'; canWrite: boolean }, placementId: string, contactId: string, expectedRevision?: number, deliveryId?: string): Promise<Record<string, unknown>> },
  dispatch?: CampaignDispatchService,
): CampaignServicePort {
  return {
    async execute(context, request) {
      if (!request.idempotencyKey || request.idempotencyKey.length < 8 || request.idempotencyKey.length > 200) {
        throw new CampaignError('invalid_input', 'A stable idempotency key between 8 and 200 characters is required.')
      }
      const fingerprint = campaignRequestFingerprint(request.command)
      return store.executeIdempotent(context, request.idempotencyKey, fingerprint, async (client) => {
        const command: CampaignCommand = request.command
        switch (command.kind) {
          case 'save_campaign': {
            requireCampaignAuthority(context, 'write', { campaignId: command.campaignId })
            const { kind: _kind, ...input } = command
            const parsed = campaignSaveSchema.parse(input)
            const campaign = await store.saveCampaign(client, {
              workspaceId: context.workspaceId,
              ownerUserId: actorUserId(context),
              ...parsed,
            })
            return { campaign }
          }
          case 'archive_campaign': {
            requireCampaignAuthority(context, 'write', { campaignId: command.campaignId })
            return { campaign: await store.archiveCampaign(client, context.workspaceId, command.campaignId) }
          }
          case 'attach_content': {
            requireCampaignAuthority(context, 'write', { campaignId: command.campaignId })
            const { kind: _kind, ...input } = command
            const parsed = campaignAttachContentSchema.parse(input)
            return { placement: await store.attachContent(client, {
              workspaceId: context.workspaceId,
              actorUserId: actorUserId(context),
              ...parsed,
            }) }
          }
          case 'record_manual_publication': {
            requireCampaignAuthority(context, 'write')
            const parsed = campaignManualPublicationSchema.parse({
              placementId: command.placementId,
              permalink: campaignHttpUrlSchema.parse(command.permalink),
              publishedAt: command.publishedAt,
              approvedRevision: command.approvedRevision,
            })
            return { placement: await store.recordManualPublication(client, {
              workspaceId: context.workspaceId,
              ...parsed,
            }) }
          }
          case 'create_link': {
            requireCampaignAuthority(context, 'write', { campaignId: command.campaignId })
            const { kind: _kind, ...input } = command
            const parsed = campaignCreateLinkSchema.parse(input)
            const publicId = campaignOpaqueToken()
            const destination = buildCampaignDestination({
              destination: parsed.destination,
              utm: parsed.utm,
              publicLinkId: publicId,
              existingAttribution: parsed.existingAttribution,
            }).url
            return { link: await store.createLink(client, {
              workspaceId: context.workspaceId,
              actorUserId: actorUserId(context),
              campaignId: parsed.campaignId,
              placementId: parsed.placementId,
              publicId,
              destination,
              utm: parsed.utm,
            }) }
          }
          case 'set_link_enabled': {
            requireCampaignAuthority(context, 'write')
            await store.setLinkEnabled(client, context.workspaceId, command.linkId, command.enabled)
            return { linkId: command.linkId, enabled: command.enabled }
          }
          case 'save_site': {
            requireCampaignAuthority(context, 'configure', { siteId: command.siteId })
            const { kind: _kind, ...input } = command
            return { site: await trackingStore.saveSite(client, context.workspaceId, actorUserId(context), campaignSiteSaveSchema.parse(input)) }
          }
          case 'record_conversion':
            throw new CampaignError('forbidden', 'Trusted conversions require a scoped site credential or committed CRM outcome.')
          case 'send_test': {
            requireCampaignAuthority(context, 'write', { campaignId: command.campaignId })
            if (!email || !context.actor.userId) throw new CampaignError('unavailable', 'Campaign test delivery is not configured.')
            return email.sendTest({
              userId: context.actor.userId,
              workspaceId: context.workspaceId,
              role: context.authority.role,
              canWrite: context.authority.canWrite,
            }, command.placementId, command.contactId, command.approvedRevision, command.deliveryId)
          }
          case 'prepare_dispatch': {
            requireCampaignAuthority(context, 'send', { campaignId: 'campaignId' in command ? command.campaignId : undefined })
            if (!dispatch) throw new CampaignError('unavailable', 'Campaign dispatch is not configured.')
            const { kind: _kind, ...input } = command
            return { dispatch: await dispatch.prepare(client, context, campaignPrepareDispatchSchema.parse(input)) }
          }
          case 'schedule_dispatch': {
            requireCampaignAuthority(context, 'send')
            if (!dispatch) throw new CampaignError('unavailable', 'Campaign dispatch is not configured.')
            return { dispatch: await dispatch.schedule(client, context, command.dispatchId, command.scheduledAt) }
          }
          case 'pause_dispatch': {
            requireCampaignAuthority(context, 'send')
            if (!dispatch) throw new CampaignError('unavailable', 'Campaign dispatch is not configured.')
            return { dispatch: await dispatch.pause(client, context, command.dispatchId) }
          }
          case 'cancel_dispatch': {
            requireCampaignAuthority(context, 'send')
            if (!dispatch) throw new CampaignError('unavailable', 'Campaign dispatch is not configured.')
            return { dispatch: await dispatch.cancel(client, context, command.dispatchId) }
          }
        }
      })
    },
  }
}
