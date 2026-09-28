/** Canonical vertical command port, shared by member/legacy/integration/tool adapters.
 * [COMP:crm/association-service]
 */
import { z } from 'zod'
import { AssociationWaitlistOfferInputSchema } from './waitlist.js'
import { ProviderEntitlementEventSchema, ProviderReceiptStateSchema } from './provider-inbox.js'
import { WORKSPACE_MODULE_ACTIONS, type WorkspaceModuleBlockingWork } from '@use-brian/shared'
import { CrmOperationsActorSchema, CrmOperationsAuthoritySchema } from '../crm/operations-types.js'
import {
  AssociationTicketInputSchema, AssociationOrderCreateSchema, AssociationProviderEventInputSchema, AssociationProviderFinancialEventInputSchema, AssociationProviderBindingInputSchema,
  AssociationMembershipCheckoutCreateSchema, AssociationMembershipCheckoutProviderBindingSchema,
  AssociationRegistrationUpdateSchema, AssociationOrderStatusSchema, AssociationRegistrationStatusSchema,
  AssociationCheckInCorrectionSchema,
  AssociationMembershipRescueCreateSchema, AssociationMembershipRescueSettlementSchema,
  AssociationMembershipRescueReversalSchema, AssociationMembershipRescueCancellationSchema,
  AssociationMembershipRescueStatusSchema,
  AssociationSponsorshipAllocationCreateSchema, AssociationSponsorshipAllocationStatusSchema,
  AssociationSponsorshipInvitationCreateSchema, AssociationSponsorshipInvitationStatusSchema,
  AssociationSponsorshipReasonSchema, AssociationSponsorshipRedemptionSchema,
  AssociationPromotionInputSchema,
  AssociationListPageSchema, type AssociationOrderFinancialSummary,
  type AssociationPromotionImportInput, type AssociationSourceMembershipImportInput,
  type AssociationSourceOrderImportInput,
} from './domain.js'

import { MembershipDraftSaveSchema, MembershipPublishSchema, MembershipSiteSchema } from './membership-catalogue.js'
import { ProgrammeDraftSaveSchema, ProgrammePublishSchema } from './programme-catalogue.js'
import { SiteContentCollectionSchema, SiteContentDraftSaveSchema, SiteContentPublishSchema } from './site-content.js'
import { SiteContentOperationsSchema } from './site-content-edit.js'

const Id = z.string().uuid()
export const AssociationContextSchema = z.object({
  workspaceId: Id,
  actor: CrmOperationsActorSchema,
  authority: CrmOperationsAuthoritySchema.extend({
    canRead: z.boolean(), canReconcileProvider: z.boolean().default(false),
  }),
}).strict()
export type AssociationContext = z.infer<typeof AssociationContextSchema>

export const AssociationCommandSchema = z.union([
  z.object({ kind: z.literal('membership_catalogue_draft') }).strict(),
  MembershipDraftSaveSchema.extend({ kind: z.literal('save_membership_catalogue') }),
  MembershipPublishSchema.extend({ kind: z.literal('publish_membership_catalogue') }),
  z.object({ kind: z.literal('published_membership_catalogue'), site: MembershipSiteSchema }).strict(),
  z.object({ kind: z.literal('observe_membership_catalogue'), site: MembershipSiteSchema, revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('programme_catalogue_draft') }).strict(),
  ProgrammeDraftSaveSchema.extend({ kind: z.literal('save_programme_catalogue') }),
  ProgrammePublishSchema.extend({ kind: z.literal('publish_programme_catalogue') }),
  z.object({ kind: z.literal('published_programme_catalogue'), site: MembershipSiteSchema }).strict(),
  z.object({ kind: z.literal('observe_programme_catalogue'), site: MembershipSiteSchema, revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('site_content_draft'), collection: SiteContentCollectionSchema }).strict(),
  SiteContentDraftSaveSchema.extend({ kind: z.literal('save_site_content'), collection: SiteContentCollectionSchema }),
  SiteContentPublishSchema.extend({ kind: z.literal('publish_site_content'), collection: SiteContentCollectionSchema }),
  z.object({ kind: z.literal('published_site_content'), collection: SiteContentCollectionSchema, site: MembershipSiteSchema }).strict(),
  z.object({ kind: z.literal('observe_site_content'), collection: SiteContentCollectionSchema, site: MembershipSiteSchema, revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('update_site_content'), collection: SiteContentCollectionSchema, expectedVersion: z.number().int().nonnegative(), operations: SiteContentOperationsSchema }).strict(),
  z.object({ kind: z.literal('website_status') }).strict(),
  z.object({ kind: z.literal('list_website_media'), query: z.string().trim().max(120).optional() }).strict(),
  z.object({ kind: z.literal('add_website_media'), fileId: z.string().uuid(), name: z.string().trim().min(1).max(180).optional() }).strict(),
  z.object({ kind: z.literal('module_status') }).strict(),
  z.object({ kind: z.literal('module_action'), action: z.enum(WORKSPACE_MODULE_ACTIONS), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('list_tickets'), eventId: Id }).strict(),
  z.object({ kind: z.literal('save_ticket'), eventId: Id, ticket: AssociationTicketInputSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_promotions'), status: z.enum(['draft', 'active', 'disabled']).optional() }).strict(),
  z.object({ kind: z.literal('save_promotion'), promotion: AssociationPromotionInputSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_waitlist'), eventId: Id.optional(), includeClosed: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('offer_waitlist_place'), offer: AssociationWaitlistOfferInputSchema }).strict(),
  z.object({ kind: z.literal('create_order'), order: AssociationOrderCreateSchema }).strict(),
  z.object({ kind: z.literal('reserve_membership_checkout'), checkout: AssociationMembershipCheckoutCreateSchema }).strict(),
  z.object({ kind: z.literal('bind_membership_checkout_provider'), checkoutId: Id, binding: AssociationMembershipCheckoutProviderBindingSchema }).strict(),
  z.object({ kind: z.literal('get_order'), orderId: Id }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_orders'), eventId: Id.optional(),
    contactId: Id.optional(), status: AssociationOrderStatusSchema.optional() }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('module_blockers') }).strict(),
  z.object({ kind: z.literal('expire_due_order'), orderId: Id }).strict(),
  z.object({ kind: z.literal('cancel_order'), orderId: Id }).strict(),
  z.object({ kind: z.literal('confirm_free_order'), orderId: Id }).strict(),
  z.object({ kind: z.literal('bind_order_provider'), orderId: Id, binding: AssociationProviderBindingInputSchema }).strict(),
  z.object({ kind: z.literal('reconcile_provider_event'), orderId: Id, event: AssociationProviderEventInputSchema }).strict(),
  z.object({ kind: z.literal('reconcile_provider_financial_event'), orderId: Id, event: AssociationProviderFinancialEventInputSchema }).strict(),
  z.object({ kind: z.literal('reconcile_provider_entitlement'), event: ProviderEntitlementEventSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_provider_receipts'), orderId: Id.optional(), entitlementId: Id.optional(), state: ProviderReceiptStateSchema.optional() }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_order_notifications'), orderId: Id }).strict(),
  z.object({ kind: z.literal('retry_provider_receipt'), receiptId: Id }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_membership_rescues'), contactId: Id.optional(),
    planId: Id.optional(), status: AssociationMembershipRescueStatusSchema.optional() }).strict(),
  z.object({ kind: z.literal('create_membership_rescue'), rescue: AssociationMembershipRescueCreateSchema }).strict(),
  z.object({ kind: z.literal('settle_membership_rescue'), rescueId: Id, settlement: AssociationMembershipRescueSettlementSchema }).strict(),
  z.object({ kind: z.literal('reverse_membership_rescue'), rescueId: Id, reversal: AssociationMembershipRescueReversalSchema }).strict(),
  z.object({ kind: z.literal('cancel_membership_rescue'), rescueId: Id, cancellation: AssociationMembershipRescueCancellationSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_sponsorship_allocations'), sponsorContactId: Id.optional(),
    status: AssociationSponsorshipAllocationStatusSchema.optional() }).strict(),
  z.object({ kind: z.literal('create_sponsorship_allocation'), allocation: AssociationSponsorshipAllocationCreateSchema }).strict(),
  z.object({ kind: z.literal('cancel_sponsorship_allocation'), allocationId: Id, cancellation: AssociationSponsorshipReasonSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_sponsorship_invitations'), allocationId: Id.optional(),
    nomineeContactId: Id.optional(), status: AssociationSponsorshipInvitationStatusSchema.optional() }).strict(),
  z.object({ kind: z.literal('issue_sponsorship_invitation'), invitation: AssociationSponsorshipInvitationCreateSchema }).strict(),
  z.object({ kind: z.literal('revoke_sponsorship_invitation'), invitationId: Id, revocation: AssociationSponsorshipReasonSchema }).strict(),
  z.object({ kind: z.literal('redeem_sponsorship_invitation'), redemption: AssociationSponsorshipRedemptionSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_registrations'), eventId: Id, status: AssociationRegistrationStatusSchema.optional() }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_operational_roster'), eventId: Id }).strict(),
  z.object({ kind: z.literal('update_registration'), registrationId: Id, update: AssociationRegistrationUpdateSchema }).strict(),
  z.object({ kind: z.literal('correct_check_in'), registrationId: Id, correction: AssociationCheckInCorrectionSchema }).strict(),
])
export type AssociationCommand = z.infer<typeof AssociationCommandSchema>
export type AssociationCommandResult = {
  command: AssociationCommand['kind']
  record?: Record<string, unknown>
  items?: Array<Record<string, unknown>>
  nextCursor?: string | null
  created?: boolean
  blockingWork?: WorkspaceModuleBlockingWork[]
  pendingOrders?: number
  financialSummary?: AssociationOrderFinancialSummary[]
  receipt?: Record<string, unknown>
}
export interface AssociationServicePort {
  execute(context: AssociationContext, command: AssociationCommand): Promise<AssociationCommandResult>
}
/** Internal port used only by the confirmed production-import service. */
export interface AssociationSourceOrderImportPort {
  importSourceOrder(
    context: AssociationContext,
    input: AssociationSourceOrderImportInput,
  ): Promise<{ record: Record<string, unknown>; created: boolean; duplicate: boolean }>
}
/** Internal port used only by the confirmed production-import service. */
export interface AssociationPromotionImportPort {
  importPromotion(
    context: AssociationContext,
    input: AssociationPromotionImportInput,
  ): Promise<{ record: Record<string, unknown>; created: boolean; duplicate: boolean }>
}
/** Internal port used only by the confirmed production-import service. */
export interface AssociationSourceMembershipImportPort {
  importSourceMembership(
    context: AssociationContext,
    input: AssociationSourceMembershipImportInput,
  ): Promise<{ record: Record<string, unknown>; created: boolean; duplicate: boolean }>
}
export const ASSOCIATION_READ_COMMANDS = ['membership_catalogue_draft', 'published_membership_catalogue', 'observe_membership_catalogue', 'programme_catalogue_draft', 'published_programme_catalogue', 'observe_programme_catalogue', 'site_content_draft', 'published_site_content', 'observe_site_content', 'website_status', 'list_website_media', 'module_status', 'list_tickets', 'list_promotions', 'get_order', 'list_orders', 'module_blockers', 'list_registrations', 'list_operational_roster', 'list_waitlist', 'list_provider_receipts', 'list_order_notifications', 'list_membership_rescues', 'list_sponsorship_allocations', 'list_sponsorship_invitations'] as const
