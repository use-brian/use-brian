/** Canonical Association command authority. [COMP:crm/association-service] */
import {
  ASSOCIATION_READ_COMMANDS, AssociationCommandSchema, AssociationContextSchema,
  AssociationError, CrmOperationsError, CrmIntegrationScopeError,
  actorAuditIdentity, crmIntegrationResourceSelection,
  requireCrmIntegrationOperation, requireCrmIntegrationResources,
  type AssociationActor, type AssociationContext, type AssociationServicePort,
  AssociationPromotionImportSchema, type AssociationPromotionImportPort,
  AssociationSourceMembershipImportSchema, type AssociationSourceMembershipImportPort,
  AssociationSourceOrderImportSchema, type AssociationSourceOrderImportPort,
  type CrmIntegrationOperation, type CrmOperationsServicePort,
} from '@use-brian/core'
import { createMembershipCatalogueStore } from '../db/membership-catalogue-store.js'
import { createProgrammeCatalogueStore } from '../db/programme-catalogue-store.js'
import { createSiteContentStore } from '../db/site-content-store.js'
import { createAssociationStore, type AssociationStore } from '../db/association-store.js'
import { getWorkspaceMembershipSystem } from '../db/workspace-store.js'
import type { WorkspaceModulesStore } from '../db/workspace-modules-store.js'
import {
  ASSOCIATION_MODULE_KEY,
  associationPendingOrders,
  createAssociationWorkspaceModulesStore,
} from './workspace-module.js'

function actor(context: AssociationContext): AssociationActor {
  const identity = actorAuditIdentity(context.actor)
  return { credentialKind: context.actor.kind, credentialId: identity.actorCredentialId,
    ...(identity.actingUserId ? { actingUserId: identity.actingUserId } : {}),
    ...(context.authority.integration ? { integration: context.authority.integration } : {}) }
}

/** The website media library as assistant tools reach it; wired at boot once the files API exists. */
export type AssociationWebsiteMediaPort = {
  list(workspaceId: string): Promise<Array<{ id: string; name: string; title: string | null; mime: string; sizeBytes: number; updatedAt: string }>>
  /** Copy a chat upload the acting person can read into the library. */
  importUpload(input: { workspaceId: string; userId: string; assistantId: string | null; fileId: string; name?: string }):
    Promise<{ id: string; name: string; mime: string; sizeBytes: number } | { error: 'upload_not_found' | 'unsupported_type' | 'not_stored' | string }>
  audit(workspaceId: string, mediaId: string, actor: AssociationActor): Promise<void>
}
const MANAGERS = ['owner', 'admin']

export function createAssociationService(options: {
  crmService: CrmOperationsServicePort
  store?: AssociationStore
  membershipCatalogue?: ReturnType<typeof createMembershipCatalogueStore>
  programmeCatalogue?: ReturnType<typeof createProgrammeCatalogueStore>
  siteContent?: ReturnType<typeof createSiteContentStore>
  modules?: WorkspaceModulesStore
  /** Late-bound: the files API is created after the service at boot. */
  websiteMedia?: () => AssociationWebsiteMediaPort | null
  /** The workspace role of the person an assistant acts for. */
  memberRole?: (userId: string, workspaceId: string) => Promise<string | null>
}): AssociationServicePort & AssociationSourceOrderImportPort & AssociationPromotionImportPort & AssociationSourceMembershipImportPort {
  const store = options.store ?? createAssociationStore()
  // Resolve the default lazily so pure command tests never open a database.
  const membershipCatalogue = () => options.membershipCatalogue ?? createMembershipCatalogueStore()
  const programmeCatalogue = () => options.programmeCatalogue ?? createProgrammeCatalogueStore()
  const siteContent = () => options.siteContent ?? createSiteContentStore()
  const modules = () => options.modules ?? createAssociationWorkspaceModulesStore()
  const memberRole = options.memberRole ?? (async (userId: string, workspaceId: string) => (await getWorkspaceMembershipSystem(userId, workspaceId))?.role ?? null)
  /**
   * Website and catalogue editing is owner/admin work, like the console. An assistant or app holding the
   * configure grant acts for a person, so that person must be an owner or admin too; otherwise any member
   * chatting with a configured assistant could publish. Integration keys never edit.
   */
  async function requireContentManager(context: AssociationContext, message: string) {
    const { actor, authority } = context
    if (!authority.canConfigure || actor.kind === 'integration_key') throw new CrmOperationsError('not_authorized', message)
    if (actor.kind === 'user') { if (!MANAGERS.includes(authority.role)) throw new CrmOperationsError('not_authorized', message); return }
    if (actor.kind === 'assistant' || actor.kind === 'workflow' || actor.kind === 'oauth_token' || actor.kind === 'home_app') {
      const role = actor.userId ? await memberRole(actor.userId, context.workspaceId) : null
      if (!role || !MANAGERS.includes(role)) throw new CrmOperationsError('not_authorized', `${message} The person asking must be a workspace owner or admin.`)
    }
  }
  return {
    async importSourceMembership(rawContext, rawInput) {
      const context = AssociationContextSchema.parse(rawContext)
      const input = AssociationSourceMembershipImportSchema.parse(rawInput)
      if (context.actor.kind !== 'import' || context.actor.jobId !== input.importJobId
        || !context.authority.canWrite || !context.authority.canConfigure
        || !['owner', 'admin'].includes(context.authority.role)) {
        throw new CrmOperationsError('not_authorized', 'Source memberships require the current owner/admin production import job.')
      }
      const saved = await store.importSourceMembership(context.workspaceId, input, actor(context))
      return { record: saved.record, created: saved.created, duplicate: !saved.created }
    },
    async importPromotion(rawContext, rawInput) {
      const context = AssociationContextSchema.parse(rawContext)
      const input = AssociationPromotionImportSchema.parse(rawInput)
      if (context.actor.kind !== 'import' || context.actor.jobId !== input.importJobId
        || !context.authority.canWrite || !context.authority.canConfigure
        || !['owner', 'admin'].includes(context.authority.role)) {
        throw new CrmOperationsError('not_authorized', 'Promotions require the current owner/admin production import job.')
      }
      const saved = await store.importPromotion(context.workspaceId, input, actor(context))
      return { record: saved.record, created: saved.created, duplicate: !saved.created }
    },
    async importSourceOrder(rawContext, rawInput) {
      const context = AssociationContextSchema.parse(rawContext)
      const input = AssociationSourceOrderImportSchema.parse(rawInput)
      if (context.actor.kind !== 'import' || context.actor.jobId !== input.importJobId
        || !context.authority.canWrite || !context.authority.canConfigure
        || !['owner', 'admin'].includes(context.authority.role)) {
        throw new CrmOperationsError('not_authorized', 'Source orders require the current owner/admin production import job.')
      }
      const saved = await store.importSourceOrder(context.workspaceId, input, actor(context))
      return { record: saved.record, created: saved.created, duplicate: !saved.created }
    },
    async execute(rawContext, rawCommand) {
      const context = AssociationContextSchema.parse(rawContext)
      const command = AssociationCommandSchema.parse(rawCommand)
      const { workspaceId, authority } = context
      const integration = authority.integration
      const read = (ASSOCIATION_READ_COMMANDS as readonly string[]).includes(command.kind)
      if (!(read ? authority.canRead : authority.canWrite)) throw new CrmOperationsError('not_authorized', 'Association authority is required.')
      if (context.actor.kind === 'intake_key') throw new CrmOperationsError('not_authorized', 'An intake credential cannot operate Association commerce.')
      if (context.actor.kind === 'integration_key' && integration?.credentialId !== context.actor.credentialId) throw new CrmIntegrationScopeError('association.read')
      const operation: CrmIntegrationOperation = command.kind === 'redeem_sponsorship_invitation' ? 'crm.entitlements.write'
        : read ? 'association.read'
        : ['save_ticket', 'save_promotion', 'save_membership_catalogue', 'publish_membership_catalogue'].includes(command.kind) ? 'crm.catalog.configure'
        : command.kind === 'reserve_membership_checkout' ? 'crm.entitlements.write'
        : ['reconcile_provider_event', 'reconcile_provider_financial_event', 'reconcile_provider_entitlement', 'bind_order_provider', 'bind_membership_checkout_provider'].includes(command.kind) ? 'association.provider_events.write' : 'association.orders.write'
      if (integration) {
        if (command.kind === 'module_action') throw new CrmOperationsError('not_authorized', 'A member owner or admin is required for module actions.')
        requireCrmIntegrationOperation(integration, operation)
        if ('eventId' in command && command.eventId) requireCrmIntegrationResources(integration, operation, { eventIds: command.eventId })
      }
      if(command.kind==='expire_due_order' && !(context.actor.kind==='system_job' && context.actor.job==='association_expiry'))
        throw new CrmOperationsError('not_authorized','Due reservation expiry requires its dedicated system job.')
      if (context.actor.kind === 'system_job' && !(
        (context.actor.job === 'association_reconciliation' && ['reconcile_provider_event', 'reconcile_provider_financial_event'].includes(command.kind))
        || (context.actor.job === 'association_expiry' && command.kind === 'expire_due_order')
        || (context.actor.job === 'entitlement_reconciliation' && command.kind === 'reconcile_provider_entitlement')
      )) throw new CrmOperationsError('not_authorized', 'This system job cannot perform the requested Association command.')
      const dbActor = actor(context)
      const output = { command: command.kind }
      const pagination = () => {
        if (!('limit' in command)) throw new Error('Command has no pagination')
        return { limit: command.limit, cursor: command.cursor ?? null,
          createdAfter: command.createdAfter, createdBefore: command.createdBefore }
      }
      const requireFinanceReviewer = () => {
        if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
          throw new CrmOperationsError('not_authorized', 'A workspace owner or admin is required to review offline payment evidence.')
        }
      }
      const requireSponsorshipManager = () => {
        if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
          throw new CrmOperationsError('not_authorized', 'A workspace owner or admin is required to manage sponsorship allocations.')
        }
      }
      switch (command.kind) {
        case 'membership_catalogue_draft':
        case 'save_membership_catalogue':
        case 'publish_membership_catalogue': {
          await requireContentManager(context, 'Membership publishing requires workspace configuration authority.')
          const catalogue = membershipCatalogue()
          const record = command.kind === 'membership_catalogue_draft' ? await catalogue.draft(workspaceId)
            : command.kind === 'save_membership_catalogue' ? await catalogue.save(workspaceId, command.expectedVersion, command.document, dbActor)
            : await catalogue.publish(workspaceId, command.expectedVersion, dbActor)
          return { ...output, record }
        }
        case 'published_membership_catalogue': {
          if (integration) requireCrmIntegrationOperation(integration, 'crm.entitlements.read')
          const selected = integration ? crmIntegrationResourceSelection(integration, 'crm.entitlements.read', 'planIds') : 'all'
          return { ...output, record: await membershipCatalogue().read(workspaceId, command.site, selected) }
        }
        case 'observe_membership_catalogue': {
          if (!integration) throw new CrmOperationsError('not_authorized', 'Only a scoped website reader may acknowledge a publication.')
          requireCrmIntegrationOperation(integration, 'crm.entitlements.read')
          return { ...output, record: await membershipCatalogue().observe(workspaceId, command.site, command.revision) }
        }
        case 'programme_catalogue_draft':
        case 'save_programme_catalogue':
        case 'publish_programme_catalogue': {
          await requireContentManager(context, 'Programme publishing requires workspace configuration authority.')
          const catalogue = programmeCatalogue()
          const record = command.kind === 'programme_catalogue_draft' ? await catalogue.draft(workspaceId)
            : command.kind === 'save_programme_catalogue' ? await catalogue.save(workspaceId, command.expectedVersion, command.document, dbActor)
            : await catalogue.publish(workspaceId, command.expectedVersion, dbActor)
          return { ...output, record }
        }
        case 'published_programme_catalogue': {
          // Public website content: the generic Association read grant, no resource dimension.
          if (integration) requireCrmIntegrationOperation(integration, 'association.read')
          return { ...output, record: await programmeCatalogue().read(workspaceId, command.site) }
        }
        case 'observe_programme_catalogue': {
          if (!integration) throw new CrmOperationsError('not_authorized', 'Only a scoped website reader may acknowledge a publication.')
          requireCrmIntegrationOperation(integration, 'association.read')
          return { ...output, record: await programmeCatalogue().observe(workspaceId, command.site, command.revision) }
        }
        case 'site_content_draft':
        case 'save_site_content':
        case 'update_site_content':
        case 'publish_site_content': {
          await requireContentManager(context, 'Website content publishing requires workspace configuration authority.')
          const store = siteContent()
          const record = command.kind === 'site_content_draft' ? await store.draft(workspaceId, command.collection)
            : command.kind === 'save_site_content' ? await store.save(workspaceId, command.collection, command.expectedVersion, command.document, dbActor)
            : command.kind === 'update_site_content' ? await store.update(workspaceId, command.collection, command.expectedVersion, command.operations, dbActor)
            : await store.publish(workspaceId, command.collection, command.expectedVersion, dbActor)
          return { ...output, record }
        }
        case 'list_website_media':
        case 'add_website_media': {
          await requireContentManager(context, 'The website media library requires workspace configuration authority.')
          const media = options.websiteMedia?.()
          if (!media) throw new AssociationError('not_available', 'The website media library is not available on this deployment.')
          if (command.kind === 'list_website_media') {
            const needle = command.query?.toLowerCase()
            const files = (await media.list(workspaceId)).filter(file => !needle || `${file.title ?? ''} ${file.name}`.toLowerCase().includes(needle))
            return { ...output, items: files.slice(0, 100).map(file => ({ mediaId: file.id, name: file.title ?? file.name, mime: file.mime, sizeBytes: file.sizeBytes, updatedAt: file.updatedAt })),
              nextCursor: null, record: { total: files.length } }
          }
          const actor = context.actor
          const userId = actor.kind === 'user' || actor.kind === 'assistant' || actor.kind === 'workflow' || actor.kind === 'oauth_token' || actor.kind === 'home_app' ? actor.userId : undefined
          if (!userId) throw new CrmOperationsError('not_authorized', 'Adding website media needs the person who uploaded the file.')
          const added = await media.importUpload({ workspaceId, userId, assistantId: actor.kind === 'assistant' ? actor.assistantId : null, fileId: command.fileId, name: command.name })
          if ('error' in added) throw new AssociationError(added.error === 'upload_not_found' ? 'not_found' : 'invalid_edit',
            added.error === 'upload_not_found' ? 'No uploaded file with that id is available; it may have expired. Ask for the file again.'
              : added.error === 'unsupported_type' ? 'Website media must be a JPEG, PNG, WebP, GIF, AVIF image or a PDF.' : 'The file could not be stored.')
          await media.audit(workspaceId, added.id, dbActor)
          return { ...output, record: { mediaId: added.id, name: added.name, mime: added.mime, sizeBytes: added.sizeBytes } }
        }
        case 'published_site_content': {
          // Public website content: the generic Association read grant, no resource dimension.
          if (integration) requireCrmIntegrationOperation(integration, 'association.read')
          return { ...output, record: await siteContent().read(workspaceId, command.collection, command.site) }
        }
        case 'observe_site_content': {
          if (!integration) throw new CrmOperationsError('not_authorized', 'Only a scoped website reader may acknowledge a publication.')
          requireCrmIntegrationOperation(integration, 'association.read')
          return { ...output, record: await siteContent().observe(workspaceId, command.collection, command.site, command.revision) }
        }
        case 'website_status': {
          // Publication summaries only (no document bodies), readable by every workspace member for the console Home.
          if (context.actor.kind !== 'user' && context.actor.kind !== 'assistant') throw new CrmOperationsError('not_authorized', 'Website status is a workspace member read.')
          const [collections, programmes, membership] = await Promise.all([siteContent().status(workspaceId), programmeCatalogue().status(workspaceId), membershipCatalogue().status(workspaceId)])
          return { ...output, record: { collections, programmes, membership } }
        }
        case 'module_status': return { ...output, record: { ...(await modules().get(workspaceId, ASSOCIATION_MODULE_KEY)) } }
        case 'module_action': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A member owner or admin is required for module actions.')
          }
          const changed = await modules().act(workspaceId, context.actor.userId, ASSOCIATION_MODULE_KEY, command)
          return { ...output, record: { ...changed.module }, created: changed.changed,
            blockingWork: changed.blockingWork, pendingOrders: associationPendingOrders(changed.blockingWork) }
        }
        case 'list_tickets': return { ...output, items: await store.listTickets(workspaceId, command.eventId) }
        case 'save_ticket': return { ...output, ...(await store.upsertTicket(workspaceId, command.eventId, command.ticket, dbActor)) }
        case 'list_promotions': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A workspace owner or admin must manage promotions.')
          }
          return { ...output, ...(await store.listPromotions(workspaceId, { ...pagination(), status: command.status }, dbActor)) }
        }
        case 'save_promotion': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A workspace owner or admin must manage promotions.')
          }
          return { ...output, ...(await store.upsertPromotion(workspaceId, command.promotion, dbActor)) }
        }
        case 'list_waitlist': {
          const events = integration ? crmIntegrationResourceSelection(integration, 'association.read', 'eventIds') : 'all'
          if (integration) requireCrmIntegrationOperation(integration, 'crm.submissions.read')
          const definitions = integration ? crmIntegrationResourceSelection(integration, 'crm.submissions.read', 'definitionIds') : 'all'
          return { ...output, ...(await store.listWaitlist(workspaceId, { ...pagination(), eventId: command.eventId, includeClosed: command.includeClosed,
            ...(events === 'all' ? {} : { allowedEventIds: events }), ...(definitions === 'all' ? {} : { allowedDefinitionIds: definitions }) }, dbActor)) }
        }
        case 'offer_waitlist_place': return { ...output, ...(await store.offerWaitlistPlace(workspaceId, command.offer, dbActor)) }
        case 'list_provider_receipts': {
          const events = integration ? crmIntegrationResourceSelection(integration, 'association.read', 'eventIds') : 'all'
          const plans = integration ? (integration.grants.some(grant => grant.operation === 'crm.entitlements.read')
            ? crmIntegrationResourceSelection(integration, 'crm.entitlements.read', 'planIds') : []) : 'all'
          return { ...output, ...(await store.listProviderReceipts(workspaceId, { ...pagination(), orderId: command.orderId, entitlementId: command.entitlementId, state: command.state,
            ...(events === 'all' ? {} : { allowedEventIds: events }), ...(plans === 'all' ? {} : { allowedPlanIds: plans }) }, dbActor)) }
        }
        case 'list_order_notifications': {
          const order = await store.getOrder(workspaceId, command.orderId, dbActor)
          if (!order) throw new AssociationError('not_found', 'order not found')
          return { ...output, ...(await store.listNotifications(workspaceId, {
            ...pagination(), sourceKind: 'order', sourceId: command.orderId,
          }, dbActor)) }
        }
        case 'retry_provider_receipt': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A workspace owner or admin is required to retry provider evidence.')
          }
          return { ...output, ...(await store.resolveProviderReceipt(workspaceId, command.receiptId, dbActor)) }
        }
        case 'list_membership_rescues': {
          requireFinanceReviewer()
          return { ...output, ...(await store.listMembershipRescues(workspaceId, { ...pagination(), contactId: command.contactId,
            planId: command.planId, status: command.status }, dbActor)) }
        }
        case 'create_membership_rescue': {
          requireFinanceReviewer()
          return { ...output, ...(await store.createMembershipRescue(workspaceId, command.rescue, dbActor)) }
        }
        case 'settle_membership_rescue': {
          requireFinanceReviewer()
          return { ...output, ...(await store.settleMembershipRescue(workspaceId, command.rescueId, command.settlement, dbActor)) }
        }
        case 'reverse_membership_rescue': {
          requireFinanceReviewer()
          return { ...output, ...(await store.reverseMembershipRescue(workspaceId, command.rescueId, command.reversal, dbActor)) }
        }
        case 'cancel_membership_rescue': {
          requireFinanceReviewer()
          return { ...output, ...(await store.cancelMembershipRescue(workspaceId, command.rescueId, command.cancellation, dbActor)) }
        }
        case 'list_sponsorship_allocations': {
          requireSponsorshipManager()
          return { ...output, ...(await store.listSponsorshipAllocations(workspaceId, { ...pagination(), sponsorContactId: command.sponsorContactId, status: command.status }, dbActor)) }
        }
        case 'create_sponsorship_allocation': {
          requireSponsorshipManager()
          return { ...output, ...(await store.createSponsorshipAllocation(workspaceId, command.allocation, dbActor)) }
        }
        case 'cancel_sponsorship_allocation': {
          requireSponsorshipManager()
          return { ...output, ...(await store.cancelSponsorshipAllocation(workspaceId, command.allocationId, command.cancellation, dbActor)) }
        }
        case 'list_sponsorship_invitations': {
          requireSponsorshipManager()
          return { ...output, ...(await store.listSponsorshipInvitations(workspaceId, { ...pagination(), allocationId: command.allocationId,
            nomineeContactId: command.nomineeContactId, status: command.status }, dbActor)) }
        }
        case 'issue_sponsorship_invitation': {
          requireSponsorshipManager()
          return { ...output, ...(await store.issueSponsorshipInvitation(workspaceId, command.invitation, dbActor)) }
        }
        case 'revoke_sponsorship_invitation': {
          requireSponsorshipManager()
          return { ...output, ...(await store.revokeSponsorshipInvitation(workspaceId, command.invitationId, command.revocation, dbActor)) }
        }
        case 'redeem_sponsorship_invitation': {
          if (context.actor.kind !== 'integration_key' || !integration) {
            throw new CrmOperationsError('not_authorized', 'A credential-scoped member backend is required to redeem a sponsorship invitation.')
          }
          return { ...output, ...(await store.redeemSponsorshipInvitation(workspaceId, command.redemption, dbActor)) }
        }
        case 'preview_order_destinations': return { ...output, record: await store.previewOrderDestinations(workspaceId, command.contactIds, dbActor) }
        case 'create_order': {
          const human = context.actor.kind === 'user' ? context.actor.userId
            : 'userId' in context.actor ? context.actor.userId : undefined
          const role = context.actor.kind === 'user' ? authority.role : human ? await memberRole(human, workspaceId) : null
          if (human && (!role || !MANAGERS.includes(role))) throw new CrmOperationsError('not_authorized', 'A workspace owner or admin must create staff reservations.')
          return { ...output, ...(await store.createOrder(workspaceId, command.order, dbActor)) }
        }
        case 'reserve_membership_checkout': return { ...output, ...(await store.reserveMembershipCheckout(workspaceId, command.checkout, dbActor)) }
        case 'get_order': {
          const record = await store.getOrder(workspaceId, command.orderId, dbActor)
          if (!record) throw new AssociationError('not_found', 'order not found')
          return { ...output, record }
        }
        case 'list_orders':
        case 'module_blockers': {
          const selected = integration ? crmIntegrationResourceSelection(integration, 'association.read', 'eventIds') : 'all'
          const page = await store.listOrders(workspaceId, { ...pagination(),
            ...(command.kind === 'module_blockers' ? { status: 'pending' as const }
              : { eventId: command.eventId, status: command.status, contactId: command.contactId }),
            ...(selected === 'all' ? {} : { allowedEventIds: selected }),
          }, dbActor)
          return { ...output, items: page.items, nextCursor: page.nextCursor,
            ...(command.kind === 'module_blockers' ? { pendingOrders: page.total } : { financialSummary: page.financialSummary }) }
        }
        case 'expire_due_order': return { ...output, ...(await store.expireDueOrder(workspaceId,command.orderId,dbActor)) }
        case 'cancel_order': return { ...output, ...(await store.cancelOrder(workspaceId, command.orderId, dbActor)) }
        case 'confirm_free_order': return { ...output, ...(await store.confirmFreeOrder(workspaceId, command.orderId, dbActor)) }
        case 'bind_order_provider':
        case 'bind_membership_checkout_provider':
        case 'reconcile_provider_entitlement':
        case 'reconcile_provider_financial_event':
        case 'reconcile_provider_event': {
          if (!authority.canReconcileProvider || !['brain_key', 'oauth_token', 'integration_key', 'provider', 'system_job'].includes(context.actor.kind)) {
            throw new CrmOperationsError('not_authorized', 'Verified backend payment evidence is required; member and assistant commands cannot mark a checkout paid.')
          }
          if (context.actor.kind === 'provider' && (command.kind === 'bind_order_provider' || command.kind === 'bind_membership_checkout_provider'
            || context.actor.provider !== command.event.provider || context.actor.eventId !== command.event.eventId)) {
            throw new CrmOperationsError('not_authorized', 'Provider evidence does not match the authenticated provider event.')
          }
          return { ...output, ...(command.kind === 'bind_order_provider'
            ? await store.bindOrderProvider(workspaceId, command.orderId, command.binding, dbActor)
            : command.kind === 'bind_membership_checkout_provider'
              ? await store.bindMembershipCheckoutProvider(workspaceId, command.checkoutId, command.binding, dbActor)
            : command.kind === 'reconcile_provider_entitlement' ? await store.reconcileProviderEntitlement(workspaceId, command.event, dbActor)
            : command.kind === 'reconcile_provider_financial_event' ? await store.reconcileProviderFinancialEvent(workspaceId, command.orderId, command.event, dbActor)
            : await store.reconcileProviderEvent(workspaceId, command.orderId, command.event, dbActor)) }
        }
        case 'list_registrations': return { ...output, ...(await store.listEventRegistrations(workspaceId, command.eventId, { ...pagination(), status: command.status }, dbActor)) }
        case 'list_operational_roster': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A workspace owner or admin is required to export an operational event roster.')
          }
          return { ...output, ...(await store.listOperationalRoster(workspaceId, command.eventId, pagination(), dbActor)) }
        }
        case 'update_registration': {
          const management = await store.getRegistrationManagement(workspaceId, command.registrationId, dbActor)
          if (!management) throw new AssociationError('not_found', 'registration not found')
          if (integration) requireCrmIntegrationResources(integration, operation, { eventIds: management.eventId ?? null })
          if (['commerce', 'source_order'].includes(management.sourceKind)) return { ...output, record: await store.updateRegistration(workspaceId, command.registrationId, command.update, dbActor) }
          const result = await options.crmService.execute(context, { kind: 'update_participation', participationId: command.registrationId,
            status: command.update.status === 'checked_in' ? 'attended' : 'cancelled' })
          const { contactId, metadata, ...rest } = result.record
          return { ...output, record: { workspaceId, ...rest, attendeeContactId: contactId ?? null,
            attendeeMetadata: metadata ?? {}, orderId: null, orderLineId: null, ticketId: null,
            reservationExpiresAt: null, status: command.update.status } }
        }
        case 'correct_check_in': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A workspace owner or admin is required to correct a check-in.')
          }
          const management = await store.getRegistrationManagement(workspaceId, command.registrationId, dbActor)
          if (!management) throw new AssociationError('not_found', 'registration not found')
          if (['commerce', 'source_order'].includes(management.sourceKind)) {
            if (command.correction.expectedStatus !== 'checked_in') throw new AssociationError('conflict', 'Commerce check-in correction expects checked_in.')
            return { ...output, record: await store.correctRegistrationCheckIn(workspaceId, command.registrationId, command.correction, dbActor) }
          }
          if (command.correction.expectedStatus !== 'attended') throw new AssociationError('conflict', 'Participation check-in correction expects attended.')
          const result = await options.crmService.execute(context, { kind: 'correct_participation_check_in', participationId: command.registrationId,
            expectedStatus: 'attended', reason: command.correction.reason })
          const { contactId, metadata, ...rest } = result.record
          return { ...output, record: { workspaceId, ...rest, attendeeContactId: contactId ?? null,
            attendeeMetadata: metadata ?? {}, orderId: null, orderLineId: null, ticketId: null,
            reservationExpiresAt: null, status: 'registered' } }
        }
      }
    },
  }
}
