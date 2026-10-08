import { previewAssociationDestinations, associationWaitlistInheritance, assertAssociationConsentAuthority, admitAssociationSourceScope, beginAssociationCreation, associationOrderReadPredicate, assertAssociationOrderAuthority, assertAssociationSourceAuthority, loadAssociationOrderScope } from '../association/source-scope.js'
/**
 * PostgreSQL store for association operations.
 *
 * Every system-pool query repeats `workspace_id` in its predicate. Mutations
 * that create side effects (audit/outbox) and all inventory/payment changes
 * use one transaction, so callers never observe a record without its evidence
 * or a payment state without matching registrations.
 *
 * [COMP:crm/association-store]
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { receiveProviderInbox, type ProviderInboxHandlers, type ProviderInboxRow } from '../association/provider-inbox.js'
import type { ProviderEntitlementServicePort } from '../association/provider-entitlement-service.js'
import type { ProviderEntitlementEvent, ProviderReceiptState } from '@use-brian/core'
import { AssociationMembershipCheckoutProviderBindingSchema, AssociationProviderBindingInputSchema, AssociationProviderEventInputSchema, AssociationProviderFinancialEventInputSchema, crmOperationsSha256, type AssociationProviderBindingInput } from '@use-brian/core'
import { requireAssociationProviderActor, requireBoundProviderOrder, requireBoundProviderOrderIdentity, requireProviderOrderMoney, type ProviderOrderIdentity } from '../association/provider.js'
import { CrmOperationsError, CrmEffectiveEntitlementQuerySchema, type CrmEffectiveEntitlementQuery, type CrmPageQuery, CrmIntegrationScopeError, requireCrmIntegrationResources, crmIntegrationResourceSelection, intersectCrmIntegrationAuthorities, type CrmIntegrationOperation } from '@use-brian/core'
import { listAssociationWaitlist, offerAssociationWaitlist, type WaitlistListInput } from '../association/waitlist.js'
import type { AssociationWaitlistOfferInput } from '@use-brian/core'
import { prepareProviderEntitlementPeriod, requireProviderEntitlementActor } from '../crm-operations/entitlement-periods.js'
import { mayTransitionCrmEntitlement, deriveResourceScope } from '@use-brian/core'
import {lockAssociationInventory,refreshAssociationInventory} from '../association/inventory.js'
import { crmPageInstant, queryCrmPage } from '../crm-operations/pagination.js'
import { getPool } from './client.js'
import { saveCrmEntitlementPlanRecord, saveCrmEventRecord } from './crm-catalog-records.js'
import { lockCrmIntegrationCredential, type CrmIntegrationPrincipal } from './crm-integration-store.js'
import { crmEvidenceRequestHash, resolveCrmEvidenceReplay, type CrmEvidenceRequest } from '../crm-operations/evidence-replay.js'
import { lockAssociationModule, requireAssociationAdmission } from '../association/workspace-module.js'
import {
  AssociationError,
  associationFingerprint,
  mayTransitionOrder,
  type AssociationActor,
  type ConsentInput,
  type EnquiryCreateInput,
  type EnquiryNoteInput,
  type EnquiryStatus,
  type EnquiryUpdateInput,
  type EventInput,
  type ExternalIdentityInput,
  type MembershipInput,
  type SourceMembershipImportInput,
  type MembershipCheckoutCreateInput,
  type MembershipCheckoutProviderBindingInput,
  type MembershipRescueCancellationInput,
  type MembershipRescueCreateInput,
  type MembershipRescueReversalInput,
  type MembershipRescueSettlementInput,
  type MembershipRescueStatus,
  type MembershipUpdateInput,
  type SponsorshipAllocationCreateInput,
  type SponsorshipAllocationStatus,
  type SponsorshipInvitationCreateInput,
  type SponsorshipInvitationStatus,
  type SponsorshipReasonInput,
  type SponsorshipRedemptionInput,
  type OrderCreateInput,
  type SourceOrderImportInput,
  type AssociationOrderFinancialSummary,
  type AssociationOperationalRosterRow,
  type CheckInCorrectionInput,
  type OrderStatus,
  type PlanInput,
  type PromotionImportInput,
  type PromotionInput,
  type ProviderEventInput,
  type ProviderFinancialEventInput,
  mayTransitionRegistration,
  type RegistrationStatus,
  type RegistrationUpdateInput,
  type TicketInput,
} from '../association/domain.js'

export type AssociationRecord = Record<string, unknown>
export type AssociationPage = { items: AssociationRecord[]; nextCursor: string | null }
export type MutationResult = { record: AssociationRecord; created: boolean; receipt?: Record<string, unknown> }

export type AssociationListInput = Omit<CrmPageQuery, 'cursor'> & {
  limit: number
  cursor: string | null
}

export type AssociationStore = {
  linkExternalIdentity(workspaceId: string, input: ExternalIdentityInput, actor: AssociationActor): Promise<MutationResult>
  resolveExternalIdentity(workspaceId: string, provider: string, providerSubject: string): Promise<AssociationRecord | null>
  createEnquiry(workspaceId: string, input: EnquiryCreateInput, actor: AssociationActor): Promise<MutationResult>
  listEnquiries(workspaceId: string, input: AssociationListInput & { status?: EnquiryStatus; queueKey?: string; ownerUserId?: string }, actor?: AssociationActor): Promise<AssociationPage>
  updateEnquiry(workspaceId: string, id: string, input: EnquiryUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  addEnquiryNote(workspaceId: string, enquiryId: string, input: EnquiryNoteInput, actor: AssociationActor): Promise<AssociationRecord>
  listEnquiryNotes(workspaceId: string, enquiryId: string, actor?: AssociationActor): Promise<AssociationRecord[]>
  appendConsent(workspaceId: string, input: ConsentInput, actor: AssociationActor): Promise<MutationResult>
  listConsents(workspaceId: string, contactId: string, actor?: AssociationActor): Promise<{ events: AssociationRecord[]; effective: Record<string, string> }>
  upsertPlan(workspaceId: string, input: PlanInput, actor: AssociationActor): Promise<MutationResult>
  listPlans(workspaceId: string, input: AssociationListInput & { published?: boolean }): Promise<AssociationPage>
  createMembership(workspaceId: string, input: MembershipInput, actor: AssociationActor): Promise<MutationResult>
  importSourceMembership(workspaceId: string, input: SourceMembershipImportInput, actor: AssociationActor): Promise<MutationResult>
  listMemberships(workspaceId: string, contactId: string, filters?: CrmEffectiveEntitlementQuery, actor?: AssociationActor): Promise<AssociationRecord[]>
  updateMembership(workspaceId: string, id: string, input: MembershipUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  listSponsorshipAllocations(workspaceId: string, input: AssociationListInput & { sponsorContactId?: string; status?: SponsorshipAllocationStatus }, actor?: AssociationActor): Promise<AssociationPage>
  createSponsorshipAllocation(workspaceId: string, input: SponsorshipAllocationCreateInput, actor: AssociationActor): Promise<MutationResult>
  cancelSponsorshipAllocation(workspaceId: string, id: string, input: SponsorshipReasonInput, actor: AssociationActor): Promise<MutationResult>
  listSponsorshipInvitations(workspaceId: string, input: AssociationListInput & { allocationId?: string; nomineeContactId?: string; status?: SponsorshipInvitationStatus }, actor?: AssociationActor): Promise<AssociationPage>
  issueSponsorshipInvitation(workspaceId: string, input: SponsorshipInvitationCreateInput, actor: AssociationActor): Promise<MutationResult>
  revokeSponsorshipInvitation(workspaceId: string, id: string, input: SponsorshipReasonInput, actor: AssociationActor): Promise<MutationResult>
  redeemSponsorshipInvitation(workspaceId: string, input: SponsorshipRedemptionInput, actor: AssociationActor): Promise<MutationResult>
  listMembershipRescues(workspaceId: string, input: AssociationListInput & { contactId?: string; planId?: string; status?: MembershipRescueStatus }, actor?: AssociationActor): Promise<AssociationPage>
  createMembershipRescue(workspaceId: string, input: MembershipRescueCreateInput, actor: AssociationActor): Promise<MutationResult>
  settleMembershipRescue(workspaceId: string, id: string, input: MembershipRescueSettlementInput, actor: AssociationActor): Promise<MutationResult>
  reverseMembershipRescue(workspaceId: string, id: string, input: MembershipRescueReversalInput, actor: AssociationActor): Promise<MutationResult>
  cancelMembershipRescue(workspaceId: string, id: string, input: MembershipRescueCancellationInput, actor: AssociationActor): Promise<MutationResult>
  upsertEvent(workspaceId: string, input: EventInput, actor: AssociationActor): Promise<MutationResult>
  listEvents(workspaceId: string, input: AssociationListInput & { status?: string }): Promise<AssociationPage>
  upsertTicket(workspaceId: string, eventId: string, input: TicketInput, actor: AssociationActor): Promise<MutationResult>
  listTickets(workspaceId: string, eventId: string): Promise<AssociationRecord[]>
  upsertPromotion(workspaceId: string, input: PromotionInput, actor: AssociationActor): Promise<MutationResult>
  importPromotion(workspaceId: string, input: PromotionImportInput, actor: AssociationActor): Promise<MutationResult>
  listPromotions(workspaceId: string, input: AssociationListInput & { status?: string }, actor: AssociationActor): Promise<AssociationPage>
  reserveMembershipCheckout(workspaceId: string, input: MembershipCheckoutCreateInput, actor: AssociationActor): Promise<MutationResult>
  bindMembershipCheckoutProvider(workspaceId: string, checkoutId: string, input: MembershipCheckoutProviderBindingInput, actor: AssociationActor): Promise<MutationResult>
  listWaitlist(workspaceId: string, input: WaitlistListInput, actor: AssociationActor): Promise<AssociationPage>
  offerWaitlistPlace(workspaceId: string, input: AssociationWaitlistOfferInput, actor: AssociationActor): Promise<MutationResult>
  previewOrderDestinations(workspaceId: string, contactIds: string[], actor: AssociationActor): Promise<AssociationRecord>
  createOrder(workspaceId: string, input: OrderCreateInput, actor: AssociationActor): Promise<MutationResult>
  importSourceOrder(workspaceId: string, input: SourceOrderImportInput, actor: AssociationActor): Promise<MutationResult>
  getOrder(workspaceId: string, id: string, actor?: AssociationActor): Promise<AssociationRecord | null>
  listOrders(workspaceId: string, input: AssociationListInput & { status?: OrderStatus; eventId?: string; contactId?: string; allowedEventIds?: readonly string[] }, actor?: AssociationActor): Promise<AssociationPage & { total: number; financialSummary: AssociationOrderFinancialSummary[] }>
  expireDueOrder(workspaceId:string,id:string,actor:AssociationActor):Promise<MutationResult>
  cancelOrder(workspaceId: string, id: string, actor: AssociationActor): Promise<MutationResult>
  confirmFreeOrder(workspaceId: string, id: string, actor: AssociationActor): Promise<MutationResult>
  bindOrderProvider(workspaceId: string, orderId: string, input: AssociationProviderBindingInput, actor: AssociationActor): Promise<MutationResult>
  retryProviderEventReceipt(workspaceId: string, receiptId: string): Promise<MutationResult>
  resolveProviderReceipt(workspaceId: string, receiptId: string, actor: AssociationActor): Promise<MutationResult>
  reconcileProviderEntitlement(workspaceId: string, input: ProviderEntitlementEvent, actor: AssociationActor): Promise<MutationResult>
  listProviderReceipts(workspaceId: string, input: AssociationListInput & { orderId?: string; entitlementId?: string; state?: ProviderReceiptState; allowedEventIds?: readonly string[]; allowedPlanIds?: readonly string[] }, actor: AssociationActor): Promise<AssociationPage>
  reconcileProviderEvent(workspaceId: string, orderId: string, input: ProviderEventInput, actor: AssociationActor): Promise<MutationResult>
  reconcileProviderFinancialEvent(workspaceId: string, orderId: string, input: ProviderFinancialEventInput, actor: AssociationActor): Promise<MutationResult>
  listEventRegistrations(workspaceId: string, eventId: string, input: AssociationListInput & { status?: RegistrationStatus }, actor?: AssociationActor): Promise<AssociationPage>
  listOperationalRoster(workspaceId: string, eventId: string, input: AssociationListInput, actor?: AssociationActor): Promise<AssociationPage>
  getRegistrationManagement(workspaceId: string, id: string, actor?: AssociationActor): Promise<{ sourceKind: string; eventId?: string } | null>
  updateRegistration(workspaceId: string, id: string, input: RegistrationUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  correctRegistrationCheckIn(workspaceId: string, id: string, input: CheckInCorrectionInput, actor: AssociationActor): Promise<AssociationRecord>
  listNotifications(workspaceId: string, input: AssociationListInput & { status?: string; sourceKind?: string; sourceId?: string }, actor: AssociationActor): Promise<AssociationPage>
}

type DbRow = QueryResultRow & Record<string, unknown>

function authorizeIntegration(actor: AssociationActor, operation: CrmIntegrationOperation,
  resources: Parameters<typeof requireCrmIntegrationResources>[2], current?: CrmIntegrationPrincipal): void {
  if (actor.credentialKind === 'integration_key' && actor.integration?.credentialId !== actor.credentialId) {
    throw new CrmIntegrationScopeError(operation)
  }
  if (actor.integration) requireCrmIntegrationResources(actor.integration, operation, resources)
  if (current) requireCrmIntegrationResources(current, operation, resources)
}

async function lockIntegrationActor(client: PoolClient, workspaceId: string, actor: AssociationActor): Promise<CrmIntegrationPrincipal | undefined> {
  if (actor.credentialKind !== 'integration_key') return undefined
  if (actor.integration?.credentialId !== actor.credentialId) throw new CrmIntegrationScopeError('association.orders.write')
  return lockCrmIntegrationCredential(client, workspaceId, actor.credentialId)
}

async function authorizeOrderIntegration(client: PoolClient, workspaceId: string, orderId: string, actor: AssociationActor,
  operation: CrmIntegrationOperation, provider?: string, current?: CrmIntegrationPrincipal): Promise<void> {
  if (!actor.integration && actor.credentialKind !== 'integration_key') return
  const events = await client.query<{ event_id: string }>(`SELECT DISTINCT t.event_id FROM association_order_lines l
    JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
    WHERE l.workspace_id=$1 AND l.order_id=$2`, [workspaceId, orderId])
  authorizeIntegration(actor, operation, { eventIds: events.rows.map((row) => row.event_id), ...(provider ? { providerKeys: provider } : {}) }, current)
}

async function transitionPromotionUse(
  client: PoolClient,
  workspaceId: string,
  orderId: string,
  target: 'redeemed' | 'released',
  reason?: 'cancelled' | 'expired' | 'payment_failed' | 'full_refund',
): Promise<void> {
  if (target === 'redeemed') {
    await client.query(`UPDATE association_promotion_uses SET state='redeemed',reservation_expires_at=NULL,
      released_reason=NULL,updated_at=now() WHERE workspace_id=$1 AND order_id=$2 AND state='reserved'`,
    [workspaceId, orderId])
    return
  }
  await client.query(`UPDATE association_promotion_uses u SET state='released',reservation_expires_at=NULL,
      released_reason=$3,updated_at=now() FROM association_promotions p
    WHERE u.workspace_id=$1 AND u.order_id=$2 AND p.workspace_id=u.workspace_id AND p.id=u.promotion_id
      AND (u.state='reserved' OR (u.state='redeemed' AND $3='full_refund' AND p.release_on_full_refund))`,
  [workspaceId, orderId, reason])
}

async function settleWithoutProvider(pool: Pool, workspaceId: string, id: string, actor: AssociationActor, action: 'cancel' | 'confirm_free' | 'expire'): Promise<MutationResult> {
  if(action==='expire' && !(actor.credentialKind==='system_job' && /^association_expiry:[a-f0-9-]{36}$/i.test(actor.credentialId)))
    throw new CrmOperationsError('not_authorized','Due reservation expiry requires its dedicated system job')
  return transaction(pool, async (client) => {
    const integration = await lockIntegrationActor(client, workspaceId, actor)
    await lockAssociationModule(client, workspaceId)
    await authorizeOrderIntegration(client, workspaceId, id, actor, 'association.orders.write', undefined, integration)
    const inventoryEvents=await lockAssociationInventory(client,workspaceId,{orderId:id})
    const current = await client.query<{ status: OrderStatus; total_minor: string; unexpired: boolean }>(
      `SELECT status,total_minor::text,reservation_expires_at>clock_timestamp() AS unexpired FROM association_orders
       WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, id])
    const order = current.rows[0]
    if (!order) {
      if(action==='expire')return {record:{id,changed:false},created:false}
      throw new AssociationError('not_found', 'order not found')
    }
    if (action !== 'expire') await assertAssociationOrderAuthority(client, workspaceId, id, actor)
    if(action==='expire') {
      const due=(await client.query<{due:boolean}>(`SELECT reservation_expires_at<=clock_timestamp() due FROM association_orders WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0]?.due
      if(order.status!=='pending' || !due)return {record:(await getOrderRecord(client,workspaceId,id))!,created:false}
    }
    const target = action === 'confirm_free' ? 'paid' : 'cancelled'
    if (action === 'confirm_free' && order.total_minor !== '0') throw new AssociationError('invalid_transition', 'Only a zero-total order can be confirmed without payment evidence')
    if (order.status === target) return { record: (await getOrderRecord(client, workspaceId, id))!, created: false }
    if (order.status !== 'pending') throw new AssociationError('invalid_transition', 'Only a pending order can be settled by this command')
    if (action === 'confirm_free' && !(await client.query<{unexpired:boolean}>('SELECT reservation_expires_at>clock_timestamp() unexpired FROM association_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0]?.unexpired) throw new AssociationError('not_available', 'The free-order reservation expired; create a new order after availability is checked')
    await client.query(`UPDATE association_orders SET status=$3,reservation_expires_at=NULL WHERE workspace_id=$1 AND id=$2`, [workspaceId, id, target])
    await client.query(`UPDATE association_registrations SET status=$3,reservation_expires_at=NULL
      WHERE workspace_id=$1 AND order_id=$2 AND status='reserved'`, [workspaceId, id, target === 'paid' ? 'confirmed' : 'cancelled'])
    await transitionPromotionUse(client, workspaceId, id, action === 'confirm_free' ? 'redeemed' : 'released',
      action === 'expire' ? 'expired' : action === 'cancel' ? 'cancelled' : undefined)
    if (action === 'confirm_free') await client.query(`INSERT INTO association_notification_outbox
      (workspace_id,source_kind,source_id,template_key,recipient_kind,recipient_ref,payload)
      SELECT workspace_id,'order',id,'order_receipt','contact',contact_id::text,jsonb_build_object('orderId',id)
      FROM association_orders WHERE workspace_id=$1 AND id=$2 ON CONFLICT DO NOTHING`, [workspaceId, id])
    await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
    await audit(client, workspaceId, action === 'expire' ? 'order.expired' : action === 'cancel' ? 'order.cancelled' : 'order.free_confirmed', 'order', id, actor)
    if (action !== 'expire') await assertAssociationOrderAuthority(client, workspaceId, id, actor)
    return { record: (await getOrderRecord(client, workspaceId, id))!, created: true }
  })
}

const IDENTITY_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", provider,
  provider_subject AS "providerSubject", created_at AS "createdAt", updated_at AS "updatedAt"`
const ENQUIRY_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", source,
  source_submission_id AS "sourceSubmissionId", subject, message,
  submitted_data AS "submittedData", status, queue_key AS "queueKey",
  owner_user_id AS "ownerUserId", submitted_at AS "submittedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const ENQUIRY_NOTE_SELECT = `
  id, workspace_id AS "workspaceId", enquiry_id AS "enquiryId", body,
  actor_kind AS "actorKind", actor_credential_id AS "actorCredentialId",
  acting_user_id AS "actingUserId", created_at AS "createdAt"`
const CONSENT_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", purpose, action,
  wording_version AS "wordingVersion", source, occurred_at AS "occurredAt",
  wording_snapshot AS wording, wording_hash AS "wordingHash",
  wording_version_id AS "wordingVersionId", wording_locale AS "wordingLocale",
  provider, provider_event_id AS "providerEventId", metadata,
  created_at AS "createdAt"`
const PLAN_SELECT = `
  id, workspace_id AS "workspaceId", plan_key AS "key", name, currency,
  fee_minor::text AS "feeMinor", billing_period AS "billingPeriod", benefits,
  eligibility_note AS "eligibilityNote", active_from AS "activeFrom",
  active_to AS "activeTo", published, provider, provider_plan_id AS "providerPlanId",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const MEMBERSHIP_SELECT = `
  m.id, m.workspace_id AS "workspaceId", m.contact_id AS "contactId",
  m.plan_id AS "planId", p.plan_key AS "planKey", p.name AS "planName",
  m.idempotency_key AS "idempotencyKey", m.status, m.starts_at AS "startsAt",
  m.ends_at AS "endsAt", m.renewal_mode AS "renewalMode", m.provider,
  m.provider_membership_id AS "providerMembershipId", m.provider_membership_id AS "providerEntitlementId",
  m.provider_period_id AS "providerPeriodId", m.predecessor_id AS "predecessorId",
  m.sponsorship_allocation_id AS "sponsorshipAllocationId",
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"`
const SPONSORSHIP_ALLOCATION_SELECT = `
  a.id,a.workspace_id AS "workspaceId",a.sponsor_contact_id AS "sponsorContactId",
  sponsor.display_name AS "sponsorContactName",a.sponsor_membership_id AS "sponsorMembershipId",
  a.beneficiary_plan_id AS "beneficiaryPlanId",beneficiary.plan_key AS "beneficiaryPlanKey",
  beneficiary.name AS "beneficiaryPlanName",a.seat_limit AS "seatLimit",
  (SELECT count(*)::int FROM association_sponsorship_invitations i
    WHERE i.workspace_id=a.workspace_id AND i.allocation_id=a.id
      AND (i.status='redeemed' OR (i.status='pending' AND i.expires_at>statement_timestamp()))) AS "allocatedSeats",
  a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.invitation_ttl_hours AS "invitationTtlHours",
  a.status,a.cancellation_reason AS "cancellationReason",a.cancelled_at AS "cancelledAt",
  a.created_at AS "createdAt",a.updated_at AS "updatedAt"`
/** Joined seat totals are unknown when any contributing invitation is unreadable. */
async function protectSponsorshipSeatCount(client: PoolClient, workspaceId: string, record: AssociationRecord, actor: AssociationActor): Promise<void> {
  const scope=await associationOrderReadPredicate(client,workspaceId,actor,3,'invitation')
  if(!scope.params.length)return
  const result=await client.query<{count:number|null}>(`SELECT CASE WHEN coalesce(bool_and(${scope.sql}),true) THEN count(*)::int ELSE NULL END AS count
    FROM association_sponsorship_invitations WHERE workspace_id=$1 AND allocation_id=$2
    AND (status='redeemed' OR (status='pending' AND expires_at>statement_timestamp()))`,[workspaceId,record.id,...scope.params])
  record.allocatedSeats=result.rows[0]?.count ?? null
  const renewed=await associationOrderReadPredicate(client,workspaceId,actor,3,'invitation')
  if(JSON.stringify(renewed.params)!==JSON.stringify(scope.params))throw new CrmOperationsError('not_authorized','Sponsorship access changed.')
}
const SPONSORSHIP_INVITATION_SELECT = `
  i.id,i.workspace_id AS "workspaceId",i.allocation_id AS "allocationId",
  i.nominee_contact_id AS "nomineeContactId",nominee.display_name AS "nomineeContactName",
  i.status,CASE WHEN i.status='pending' AND i.expires_at<=statement_timestamp() THEN true ELSE false END AS expired,
  i.expires_at AS "expiresAt",i.redeemed_contact_id AS "redeemedContactId",i.membership_id AS "membershipId",
  i.redeemed_at AS "redeemedAt",i.revocation_reason AS "revocationReason",i.revoked_at AS "revokedAt",
  i.created_at AS "createdAt",i.updated_at AS "updatedAt"`
const MEMBERSHIP_RESCUE_SELECT = `
  r.id, r.workspace_id AS "workspaceId", r.contact_id AS "contactId",
  e.display_name AS "contactName", r.plan_id AS "planId", p.plan_key AS "planKey", p.name AS "planName",
  r.idempotency_key AS "idempotencyKey", r.status, r.amount_minor::text AS "amountMinor", r.currency,
  r.starts_at AS "startsAt", r.ends_at AS "endsAt", r.due_at AS "dueAt", r.reason,
  (r.status='outstanding' AND r.due_at<=statement_timestamp()) AS overdue,
  r.membership_id AS "membershipId", m.status AS "membershipStatus",
  r.settlement_method AS "settlementMethod", r.settlement_reference AS "settlementReference",
  r.settlement_occurred_at AS "settlementOccurredAt", r.settlement_note AS "settlementNote",
  r.reversal_reference AS "reversalReference", r.reversal_occurred_at AS "reversalOccurredAt",
  r.reversal_reason AS "reversalReason", r.cancellation_reason AS "cancellationReason",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"`
const EVENT_SELECT = `
  id, workspace_id AS "workspaceId", slug, programme_key AS "programmeKey",
  title, description, starts_at AS "startsAt", ends_at AS "endsAt", timezone,
  mode, venue, online_url AS "onlineUrl",
  registration_opens_at AS "registrationOpensAt",
  registration_closes_at AS "registrationClosesAt", capacity, status,
  canonical_url AS "canonicalUrl", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`
const TICKET_SELECT = `
  t.id, t.workspace_id AS "workspaceId", t.event_id AS "eventId",
  t.ticket_key AS "key", t.name, t.currency,
  t.price_minor::text AS "priceMinor", t.member_price_minor::text AS "memberPriceMinor",
  t.eligible_plan_keys AS "eligiblePlanKeys", t.eligibility_required AS "eligibilityRequired",
  t.eligibility_scope AS "eligibilityScope", t.capacity,
  t.per_order_limit AS "perOrderLimit", t.sale_starts_at AS "saleStartsAt",
  t.sale_ends_at AS "saleEndsAt", t.status,
  COALESCE(i.reserved_count, 0)::int AS "reservedCount",
  CASE WHEN t.capacity IS NULL THEN NULL
       ELSE GREATEST(t.capacity - COALESCE(i.reserved_count, 0), 0)::int END AS "available",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`
const PROMOTION_SELECT = `
  p.id, p.workspace_id AS "workspaceId", p.promotion_key AS "key", p.name,
  p.discount_type AS "discountType", p.percentage_basis_points AS "percentageBasisPoints",
  p.amount_minor::text AS "amountMinor", p.currency,
  p.buy_quantity AS "buyQuantity", p.get_quantity AS "getQuantity",
  p.target_kind AS "targetKind", p.target_ids AS "targetIds",
  p.recurrence_mode AS "recurrenceMode", p.recurrence_cycles AS "recurrenceCycles",
  p.apply_mode AS "applyMode",
  p.valid_from AS "validFrom", p.valid_to AS "validTo", p.max_uses AS "maxUses",
  p.max_uses_per_contact AS "maxUsesPerContact",
  p.source_system AS "sourceSystem", p.source_site AS "sourceSite",
  p.source_promotion_id AS "sourcePromotionId", p.source_redeemed_uses AS "sourceRedeemedUses",
  p.combines_with_member_price AS "combinesWithMemberPrice",
  p.release_on_full_refund AS "releaseOnFullRefund", p.status,
  true AS "hasCode", COALESCE(u.reserved_uses,0)::int AS "reservedUses",
  (COALESCE(u.redeemed_uses,0)+p.source_redeemed_uses)::int AS "redeemedUses",
  p.created_at AS "createdAt", p.updated_at AS "updatedAt"`
function promotionProjection(allowed: string): string {
  return PROMOTION_SELECT
    .replace('p.source_redeemed_uses AS "sourceRedeemedUses"', `CASE WHEN ${allowed} THEN p.source_redeemed_uses END AS "sourceRedeemedUses"`)
    .replace('COALESCE(u.reserved_uses,0)::int AS "reservedUses"', `CASE WHEN ${allowed} THEN COALESCE(u.reserved_uses,0)::int END AS "reservedUses"`)
    .replace('(COALESCE(u.redeemed_uses,0)+p.source_redeemed_uses)::int AS "redeemedUses"', `CASE WHEN ${allowed} THEN (COALESCE(u.redeemed_uses,0)+p.source_redeemed_uses)::int END AS "redeemedUses"`)
}
async function promotionUsageScope(client: PoolClient, workspaceId: string, actor: AssociationActor, index: number) {
  const workspace = (await client.query<{ v2: boolean }>('SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]
  if (workspace?.v2 === false) return { sql: 'TRUE', params: [] }
  const order = await associationOrderReadPredicate(client, workspaceId, actor, index, 'order')
  const checkout = await associationOrderReadPredicate(client, workspaceId, actor, index + order.params.length, 'checkout')
  const imported = await associationOrderReadPredicate(client, workspaceId, actor, index + order.params.length + checkout.params.length, 'promotion_usage')
  return { params: [...order.params, ...checkout.params, ...imported.params], sql: `((p.source_redeemed_uses=0 OR ${imported.sql.replaceAll('association_promotions.', 'p.')}) AND NOT EXISTS (
    SELECT 1 FROM association_promotion_uses x WHERE x.workspace_id=p.workspace_id AND x.promotion_id=p.id
      AND (x.state='redeemed' OR (x.state='reserved' AND x.reservation_expires_at>statement_timestamp()))
      AND NOT ((x.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM association_orders WHERE workspace_id=x.workspace_id AND id=x.order_id AND ${order.sql}))
        OR (x.membership_checkout_id IS NOT NULL AND EXISTS(SELECT 1 FROM association_membership_checkouts WHERE workspace_id=x.workspace_id AND id=x.membership_checkout_id AND ${checkout.sql})))) )` }
}
const MEMBERSHIP_CHECKOUT_SELECT = `
  c.id,c.workspace_id AS "workspaceId",c.contact_id AS "contactId",c.plan_id AS "planId",
  c.idempotency_key AS "idempotencyKey",c.status,c.currency,
  c.subtotal_minor::text AS "subtotalMinor",c.discount_minor::text AS "discountMinor",
  c.total_minor::text AS "totalMinor",c.promotion_id AS "promotionId",
  c.promotion_snapshot AS "promotionSnapshot",c.reservation_expires_at AS "reservationExpiresAt",
  c.provider,c.provider_reference AS "providerReference",
  c.provider_coupon_reference AS "providerCouponReference",
  c.created_at AS "createdAt",c.updated_at AS "updatedAt"`
const ORDER_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId",
  idempotency_key AS "idempotencyKey", status, currency,
  subtotal_minor::text AS "subtotalMinor", discount_minor::text AS "discountMinor",
  total_minor::text AS "totalMinor", reservation_expires_at AS "reservationExpiresAt",
  provider, provider_reference AS "providerReference", refunded_minor::text AS "refundedMinor",
  refund_state AS "refundState", dispute_state AS "disputeState",
  source_system AS "sourceSystem", source_site AS "sourceSite",
  source_order_id AS "sourceOrderId", source_occurred_at AS "sourceOccurredAt",
  source_order_status AS "sourceOrderStatus", source_import AS "sourceImport",
  promotion_id AS "promotionId", promotion_snapshot AS "promotionSnapshot", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`
const REGISTRATION_SELECT = `
  id, workspace_id AS "workspaceId", order_id AS "orderId",
  order_line_id AS "orderLineId", event_id AS "eventId", ticket_id AS "ticketId",
  attendee_contact_id AS "attendeeContactId", attendee_name AS "attendeeName",
  attendee_email AS "attendeeEmail", attendee_metadata AS "attendeeMetadata",
  eligible_membership_id AS "eligibleMembershipId",
  status, reservation_expires_at AS "reservationExpiresAt",
  checked_in_at AS "checkedInAt", source_kind AS "sourceKind", source_id AS "sourceId", historical_import AS "historicalImport",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const NOTIFICATION_SELECT = `
  id, workspace_id AS "workspaceId", source_kind AS "sourceKind",
  source_id AS "sourceId", template_key AS "templateKey",
  recipient_kind AS "recipientKind", recipient_ref AS "recipientRef", payload,
  status, attempts, retired_at AS "retiredAt", retired_from_status AS "retiredFromStatus", next_attempt_at AS "nextAttemptAt",
  provider_message_id AS "providerMessageId", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"`

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function requirePerson(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM entities
      WHERE workspace_id = $1 AND id = $2 AND kind = 'person' AND valid_to IS NULL`,
    [workspaceId, contactId],
  )
  if (!found.rowCount) {
    throw new AssociationError('contact_required', 'contactId must identify a live CRM person in this workspace')
  }
}

function promotionDigest(code: string, configuredKey?: string): string {
  const key = configuredKey ?? process.env.ASSOCIATION_PROMOTION_HMAC_KEY
  if (!key || Buffer.byteLength(key, 'utf8') < 32) {
    throw new AssociationError('promotion_invalid', 'Promotion service is unavailable.')
  }
  return createHmac('sha256', key)
    .update(code.trim().normalize('NFKC').toUpperCase(), 'utf8')
    .digest('hex')
}

async function requireWorkspaceUser(client: PoolClient, workspaceId: string, userId: string): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  if (!found.rowCount) throw new AssociationError('not_found', 'ownerUserId is not a workspace member')
}

async function requireFinanceActor(client: PoolClient, workspaceId: string, actor: AssociationActor): Promise<string> {
  if (actor.credentialKind !== 'user' || !actor.actingUserId || actor.credentialId !== actor.actingUserId) {
    throw new CrmOperationsError('not_authorized', 'A current workspace owner or admin must review offline payment evidence.')
  }
  const member = await client.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR KEY SHARE`,
    [workspaceId, actor.actingUserId],
  )
  if (!['owner', 'admin'].includes(member.rows[0]?.role ?? '')) {
    throw new CrmOperationsError('not_authorized', 'A current workspace owner or admin must review offline payment evidence.')
  }
  return actor.actingUserId
}

async function requireSourceOrderImportActor(client: PoolClient, workspaceId: string, actor: AssociationActor): Promise<string> {
  if (actor.credentialKind !== 'import' || !actor.actingUserId) {
    throw new CrmOperationsError('not_authorized', 'Source orders are only available to a confirmed owner/admin import job.')
  }
  const member = await client.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR KEY SHARE`,
    [workspaceId, actor.actingUserId],
  )
  if (!['owner', 'admin'].includes(member.rows[0]?.role ?? '')) {
    throw new CrmOperationsError('not_authorized', 'Source order imports require a current workspace owner or admin.')
  }
  return actor.actingUserId
}

async function requireSourceMembershipImportActor(
  client: PoolClient,
  workspaceId: string,
  actor: AssociationActor,
  importJobId: string,
): Promise<string> {
  if (actor.credentialKind !== 'import' || actor.credentialId !== importJobId || !actor.actingUserId) {
    throw new CrmOperationsError('not_authorized', 'Source memberships are only available to a confirmed owner/admin import job.')
  }
  const member = await client.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR KEY SHARE`,
    [workspaceId, actor.actingUserId],
  )
  if (!['owner', 'admin'].includes(member.rows[0]?.role ?? '')) {
    throw new CrmOperationsError('not_authorized', 'Source membership imports require a current workspace owner or admin.')
  }
  return actor.actingUserId
}

async function requirePromotionImportActor(
  client: PoolClient,
  workspaceId: string,
  actor: AssociationActor,
  importJobId: string,
): Promise<string> {
  if (actor.credentialKind !== 'import' || actor.credentialId !== importJobId || !actor.actingUserId) {
    throw new CrmOperationsError('not_authorized', 'Promotions are only available to a confirmed owner/admin import job.')
  }
  const member = await client.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR KEY SHARE`,
    [workspaceId, actor.actingUserId],
  )
  if (!['owner', 'admin'].includes(member.rows[0]?.role ?? '')) {
    throw new CrmOperationsError('not_authorized', 'Promotion imports require a current workspace owner or admin.')
  }
  return actor.actingUserId
}

async function audit(
  client: PoolClient,
  workspaceId: string,
  action: string,
  subjectKind: string,
  subjectId: string,
  actor: AssociationActor,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO association_audit_log
       (workspace_id, action, subject_kind, subject_id, actor_kind,
        actor_credential_id, acting_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, action, subjectKind, subjectId, actor.credentialKind,
      actor.credentialId, actor.actingUserId ?? null, metadata],
  )
}

function page(pool: Pick<Pool, 'query'>, workspaceId: string, resource: string, input: AssociationListInput, sql: string, params: unknown[]): Promise<AssociationPage> {
  return queryCrmPage(pool.query.bind(pool), { workspaceId, resource, key: 'items', sql, params,
    query: { limit: input.limit, cursor: input.cursor ?? undefined, createdAfter: input.createdAfter, createdBefore: input.createdBefore } })
}

async function getOrderRecord(client: Pick<PoolClient, 'query'>, workspaceId: string, id: string): Promise<AssociationRecord | null> {
  const orderResult = await client.query<DbRow>(
    `SELECT ${ORDER_SELECT} FROM association_orders WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  )
  const order = orderResult.rows[0]
  if (!order) return null
  const [lines, registrations] = await Promise.all([
    client.query<DbRow>(
      `SELECT l.id, l.order_id AS "orderId", l.ticket_id AS "ticketId",
              t.ticket_key AS "ticketKey", t.name AS "ticketName", l.quantity,
              l.unit_price_minor::text AS "unitPriceMinor",
              l.discount_minor::text AS "discountMinor",
              l.member_discount_minor::text AS "memberDiscountMinor",
              l.promotion_discount_minor::text AS "promotionDiscountMinor",
              l.source_discount_minor::text AS "sourceDiscountMinor",
              l.line_total_minor::text AS "lineTotalMinor",
              l.pricing_basis AS "pricingBasis",
              l.eligible_membership_id AS "eligibleMembershipId",
              l.created_at AS "createdAt"
         FROM association_order_lines l
         JOIN association_ticket_types t ON t.workspace_id = l.workspace_id AND t.id = l.ticket_id
        WHERE l.workspace_id = $1 AND l.order_id = $2
        ORDER BY l.created_at, l.id`,
      [workspaceId, id],
    ),
    client.query<DbRow>(
      `SELECT ${REGISTRATION_SELECT}
         FROM association_registrations
        WHERE workspace_id = $1 AND order_id = $2
        ORDER BY created_at, id`,
      [workspaceId, id],
    ),
  ])
  return { ...order, lines: lines.rows, registrations: registrations.rows }
}

async function getMembershipRescueRecord(client: Pick<PoolClient, 'query'>, workspaceId: string, id: string): Promise<AssociationRecord | null> {
  const result = await client.query<DbRow>(
    `SELECT ${MEMBERSHIP_RESCUE_SELECT}
       FROM association_membership_offline_rescues r
       JOIN association_membership_plans p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id
       JOIN entities e ON e.workspace_id=r.workspace_id AND e.id=r.contact_id
       LEFT JOIN association_memberships m ON m.workspace_id=r.workspace_id AND m.id=r.membership_id
      WHERE r.workspace_id=$1 AND r.id=$2`,
    [workspaceId, id],
  )
  return result.rows[0] ?? null
}

async function getMembershipCheckoutRecord(client: Pick<PoolClient, 'query'>, workspaceId: string, id: string): Promise<AssociationRecord | null> {
  const result = await client.query<DbRow>(
    `SELECT ${MEMBERSHIP_CHECKOUT_SELECT} FROM association_membership_checkouts c
      WHERE c.workspace_id=$1 AND c.id=$2`,
    [workspaceId, id],
  )
  return result.rows[0] ?? null
}

async function getSourceMembershipRecord(
  client: Pick<PoolClient, 'query'>,
  workspaceId: string,
  id: string,
): Promise<AssociationRecord | null> {
  const result = await client.query<DbRow>(
    `SELECT ${MEMBERSHIP_SELECT},true AS "sourceImport",
       jsonb_build_object(
         'source',s.source_system,'site',s.source_site,'membershipId',s.source_membership_id,
         'planId',s.source_plan_id,'memberId',s.source_member_id,'orderId',s.source_order_id,
         'subscriptionId',s.source_subscription_id,'paymentProvider',s.source_payment_provider,
         'paymentReference',s.source_payment_reference,'status',s.source_status,
         'renewalStatus',s.source_renewal_status,'paymentStatus',s.source_payment_status,
         'refundStatus',s.source_refund_status,'purchasedAt',s.purchased_at,
         'cancelledAt',s.cancelled_at,'relationships',s.relationships,'metadata',s.metadata
       ) AS "sourceEvidence"
       FROM association_memberships m
       JOIN association_membership_plans p ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
       JOIN association_membership_source_imports s ON s.workspace_id=m.workspace_id AND s.membership_id=m.id
      WHERE m.workspace_id=$1 AND m.id=$2`,
    [workspaceId, id],
  )
  return result.rows[0] ?? null
}


async function applyProviderOrderEvent(client: PoolClient, workspaceId: string, orderId: string, input: ProviderEventInput, actor: AssociationActor): Promise<MutationResult> {
  const fingerprint = crmOperationsSha256({ orderId, ...input, occurredAt: crmPageInstant(input.occurredAt) })
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        await lockAssociationModule(client, workspaceId)
        await authorizeOrderIntegration(client, workspaceId, orderId, actor, 'association.provider_events.write', input.provider, integration)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('association-provider-event:'||$1::text||':'||$2||':'||$3,0))", [workspaceId, input.provider, input.eventId])
        const inventoryEvents=await lockAssociationInventory(client,workspaceId,{orderId})
        const order = (await client.query<ProviderOrderIdentity>(
          'SELECT status,provider,provider_reference,currency,total_minor::text,refunded_minor::text FROM association_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [workspaceId, orderId],
        )).rows[0]
        if (!order) throw new AssociationError('not_found', 'order not found')
        requireBoundProviderOrder(order, input)
        const replay = (await client.query<{ order_id: string; target_status: string; request_fingerprint: string | null; provider_reference: string | null; same_time: boolean; same_metadata: boolean }>(
          `SELECT order_id,target_status,request_fingerprint,provider_reference,occurred_at=$4::timestamptz same_time,metadata=$5::jsonb same_metadata
           FROM association_provider_events WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3`,
          [workspaceId, input.provider, input.eventId, input.occurredAt, input.metadata],
        )).rows[0]
        if (replay) {
          if (replay.order_id !== orderId || replay.target_status !== input.targetStatus || (replay.request_fingerprint
            ? replay.request_fingerprint !== fingerprint
            : replay.provider_reference !== input.providerReference || !replay.same_time || !replay.same_metadata)) {
            throw new AssociationError('conflict', 'Provider event identity was already used for different normalized evidence.')
          }
          return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
        }
        const unchanged = order.status === input.targetStatus
        if (!unchanged && !mayTransitionOrder(order.status as OrderStatus, input.targetStatus)) {
          throw new AssociationError('invalid_transition', `order cannot transition from ${order.status} to ${input.targetStatus}`)
        }
        if (order.status === 'pending' && input.targetStatus === 'paid'
          && !(await client.query<{unexpired:boolean}>('SELECT reservation_expires_at>clock_timestamp() unexpired FROM association_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,orderId])).rows[0]?.unexpired) {
          throw new AssociationError(
            'not_available',
            'the order reservation expired before payment confirmation; manual reconciliation is required',
          )
        }
        await client.query(
          `INSERT INTO association_provider_events
             (workspace_id, order_id, provider, provider_event_id, target_status,
              provider_reference, occurred_at, metadata, request_fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [workspaceId, orderId, input.provider, input.eventId, input.targetStatus,
            input.providerReference, input.occurredAt, input.metadata, fingerprint],
        )
        if (unchanged) return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
        await client.query(
          `UPDATE association_orders SET status = $3, provider = $4,
                  provider_reference = COALESCE($5, provider_reference),
                  refunded_minor = CASE WHEN $3 = 'refunded' THEN total_minor ELSE refunded_minor END,
                  refund_state = CASE WHEN $3 = 'refunded' THEN 'full' ELSE refund_state END,
                  reservation_expires_at = CASE WHEN $3 = 'pending' THEN reservation_expires_at ELSE NULL END
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, orderId, input.targetStatus, input.provider,
            input.providerReference ?? null],
        )
        const registrationStatus = input.targetStatus === 'paid' ? 'confirmed'
          : input.targetStatus === 'refunded' ? 'refunded' : 'cancelled'
        await client.query(
          `UPDATE association_registrations
              SET status = $3,
                  reservation_expires_at = NULL
            WHERE workspace_id = $1 AND order_id = $2
              AND status IN ('reserved','confirmed','checked_in')`,
          [workspaceId, orderId, registrationStatus],
        )
        if (input.targetStatus === 'paid') {
          await transitionPromotionUse(client, workspaceId, orderId, 'redeemed')
        } else if (input.targetStatus === 'failed' || input.targetStatus === 'cancelled') {
          await transitionPromotionUse(client, workspaceId, orderId, 'released',
            input.targetStatus === 'failed' ? 'payment_failed' : 'cancelled')
        } else if (input.targetStatus === 'refunded') {
          await transitionPromotionUse(client, workspaceId, orderId, 'released', 'full_refund')
        }
        if (input.targetStatus === 'paid') {
          const orderContact = await client.query<{ contact_id: string }>(
            `SELECT contact_id FROM association_orders WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, orderId],
          )
          await client.query(
            `INSERT INTO association_notification_outbox
               (workspace_id, source_kind, source_id, template_key,
                recipient_kind, recipient_ref, payload)
             VALUES
               ($1,'order',$2,'order_receipt','contact',$3,$4),
               ($1,'order',$2,'order_paid_staff_alert','queue','registrations',$4)
             ON CONFLICT DO NOTHING`,
            [workspaceId, orderId, orderContact.rows[0].contact_id, { orderId }],
          )
        }
        await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
        await audit(client, workspaceId, `order.${input.targetStatus}`, 'order', orderId, actor, {
          provider: input.provider,
          providerEventId: input.eventId,
          from: order.status,
          to: input.targetStatus,
        })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }

}

async function applyProviderOrderFinancialEvent(client: PoolClient, workspaceId: string, orderId: string,
  raw: ProviderFinancialEventInput, actor: AssociationActor): Promise<MutationResult> {
  const input = AssociationProviderFinancialEventInputSchema.parse(raw)
  const fingerprint = crmOperationsSha256({ orderId, ...input, occurredAt: crmPageInstant(input.occurredAt) })
  const integration = await lockIntegrationActor(client, workspaceId, actor)
  await lockAssociationModule(client, workspaceId)
  await authorizeOrderIntegration(client, workspaceId, orderId, actor, 'association.provider_events.write', input.provider, integration)
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('association-provider-event:'||$1::text||':'||$2||':'||$3,0))",
    [workspaceId, input.provider, input.eventId])
  const inventoryEvents = await lockAssociationInventory(client, workspaceId, { orderId })
  const order = (await client.query<ProviderOrderIdentity>(
    'SELECT status,provider,provider_reference,currency,total_minor::text,refunded_minor::text FROM association_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [workspaceId, orderId],
  )).rows[0]
  if (!order) throw new AssociationError('not_found', 'order not found')
  requireBoundProviderOrderIdentity(order, input)
  const total = Number(order.total_minor)
  if (!Number.isSafeInteger(total) || input.currency !== order.currency || input.amountMinor > total) {
    throw new AssociationError('conflict', 'Financial evidence currency and amount must fit the bound Brian order.')
  }
  if (!['paid', 'refunded'].includes(order.status)) {
    throw new AssociationError('invalid_transition', 'Refund or dispute evidence requires a paid or refunded order.')
  }
  const replay = (await client.query<{ request_fingerprint: string | null }>(
    'SELECT request_fingerprint FROM association_provider_events WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3',
    [workspaceId, input.provider, input.eventId],
  )).rows[0]
  if (replay) {
    if (replay.request_fingerprint !== fingerprint) {
      throw new AssociationError('conflict', 'Provider event identity was already used for different normalized evidence.')
    }
    return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
  }
  const previous = (await client.query<{
    financial_status: string; financial_amount_minor: string; financial_currency: string; incoming_not_older: boolean;
  }>(`SELECT financial_status,financial_amount_minor::text,financial_currency,$5::timestamptz>=occurred_at incoming_not_older
      FROM association_provider_events
      WHERE workspace_id=$1 AND order_id=$2 AND event_kind=$3 AND provider_adjustment_reference=$4
      ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`,
    [workspaceId, orderId, input.kind, input.adjustmentReference, input.occurredAt])).rows[0]
  if (previous && (previous.financial_amount_minor !== String(input.amountMinor) || previous.financial_currency !== input.currency)) {
    throw new AssociationError('conflict', 'A provider financial object cannot change amount or currency.')
  }
  const terminal = input.kind === 'refund' ? ['succeeded', 'failed', 'cancelled'] : ['won', 'lost', 'prevented']
  if (previous && terminal.includes(previous.financial_status) && previous.financial_status !== input.status
    && previous.incoming_not_older) {
    throw new AssociationError('conflict', 'A terminal provider financial object cannot change state.')
  }
  await client.query(
    `INSERT INTO association_provider_events
       (workspace_id,order_id,provider,provider_event_id,target_status,provider_reference,occurred_at,metadata,request_fingerprint,
        event_kind,provider_adjustment_reference,financial_status,financial_amount_minor,financial_currency)
     VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [workspaceId, orderId, input.provider, input.eventId, input.providerReference, input.occurredAt, input.metadata, fingerprint,
      input.kind, input.adjustmentReference, input.status, input.amountMinor, input.currency],
  )
  const summary = (await client.query<{
    refunded_minor: string; refund_pending: boolean; refund_failed: boolean;
    dispute_open: number; dispute_won: number; dispute_lost: number;
  }>(`WITH latest AS (
      SELECT DISTINCT ON(event_kind,provider_adjustment_reference)
        event_kind,financial_status,financial_amount_minor
      FROM association_provider_events
      WHERE workspace_id=$1 AND order_id=$2 AND event_kind IN('refund','dispute')
      ORDER BY event_kind,provider_adjustment_reference,occurred_at DESC,created_at DESC,id DESC
    ) SELECT
      COALESCE(sum(financial_amount_minor) FILTER(WHERE event_kind='refund' AND financial_status='succeeded'),0)::text refunded_minor,
      COALESCE(bool_or(financial_status='pending') FILTER(WHERE event_kind='refund'),false) refund_pending,
      COALESCE(bool_or(financial_status IN('failed','cancelled')) FILTER(WHERE event_kind='refund'),false) refund_failed,
      count(*) FILTER(WHERE event_kind='dispute' AND financial_status='open')::int dispute_open,
      count(*) FILTER(WHERE event_kind='dispute' AND financial_status IN('won','prevented'))::int dispute_won,
      count(*) FILTER(WHERE event_kind='dispute' AND financial_status='lost')::int dispute_lost
    FROM latest`, [workspaceId, orderId])).rows[0]
  const aggregateRefunded = Number(summary.refunded_minor)
  const priorRefunded = Number(order.refunded_minor)
  if (!Number.isSafeInteger(aggregateRefunded) || !Number.isSafeInteger(priorRefunded) || aggregateRefunded > total
    || (order.status === 'refunded' && aggregateRefunded > 0 && aggregateRefunded !== total)) {
    throw new AssociationError('conflict', 'Financial evidence contradicts the order refund total.')
  }
  const refunded = Math.max(aggregateRefunded, priorRefunded)
  const refundState = refunded === total ? 'full'
    : refunded > 0 && summary.refund_pending ? 'partial_pending'
      : refunded > 0 && summary.refund_failed ? 'partial_failed'
      : refunded > 0 ? 'partial'
        : summary.refund_pending ? 'pending'
          : summary.refund_failed ? 'failed' : 'none'
  const disputeState = summary.dispute_open > 0 ? 'open'
    : summary.dispute_won > 0 && summary.dispute_lost > 0 ? 'mixed'
      : summary.dispute_lost > 0 ? 'lost'
        : summary.dispute_won > 0 ? 'won' : 'none'
  const fullRefund = order.status === 'paid' && refunded === total
  await client.query(`UPDATE association_orders SET refunded_minor=$3,refund_state=$4,dispute_state=$5,
    status=CASE WHEN $6 THEN 'refunded' ELSE status END WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, orderId, refunded, refundState, disputeState, fullRefund])
  if (fullRefund) {
    await client.query(`UPDATE association_registrations SET status='refunded',reservation_expires_at=NULL
      WHERE workspace_id=$1 AND order_id=$2 AND status IN('reserved','confirmed','checked_in')`, [workspaceId, orderId])
    await refreshAssociationInventory(client, workspaceId, inventoryEvents, actor.credentialKind)
    await transitionPromotionUse(client, workspaceId, orderId, 'released', 'full_refund')
  }
  await audit(client, workspaceId, 'order.financial_evidence', 'order', orderId, actor, {
    provider: input.provider, providerEventId: input.eventId, kind: input.kind, status: input.status,
    amountMinor: input.amountMinor, currency: input.currency,
  })
  if (fullRefund) await audit(client, workspaceId, 'order.refunded', 'order', orderId, actor, {
    provider: input.provider, providerEventId: input.eventId, from: order.status, to: 'refunded',
  })
  return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
}

export function createAssociationStore(
  pool: Pool = getPool(),
  transactionClient?: PoolClient,
  options: {
    promotionHmacKey?: string
    providerEntitlements?: ProviderEntitlementServicePort
  } = {},
): AssociationStore {
  // A waitlist promotion shares this exact order implementation and outer commit.
  const transact = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => transactionClient ? fn(transactionClient) : transaction(pool, fn)
  const providerHandlers = (workspaceId: string): ProviderInboxHandlers => ({
    async authorize(client, envelope, actor, admittedActor) {
      if (envelope.target !== 'order') throw new CrmOperationsError('invalid_input', 'Order evidence is required.')
      requireAssociationProviderActor(actor)
      const integration = await lockIntegrationActor(client, workspaceId, actor)
      await lockAssociationModule(client, workspaceId)
      await authorizeOrderIntegration(client, workspaceId, envelope.orderId, actor, 'association.provider_events.write', envelope.event.provider, integration)
      if (admittedActor) await authorizeOrderIntegration(client, workspaceId, envelope.orderId, admittedActor, 'association.provider_events.write', envelope.event.provider)
      await assertAssociationOrderAuthority(client, workspaceId, envelope.orderId, actor)
      const order = (await client.query<{ contact_id: string }>('SELECT contact_id FROM association_orders WHERE workspace_id=$1 AND id=$2', [workspaceId, envelope.orderId])).rows[0]
      if (!order) throw new CrmOperationsError('not_found', 'Order is unavailable.')
      return { contactId: order.contact_id, planId: null, entitlementId: null }
    },
    async apply(client, envelope, actor) {
      if (envelope.target !== 'order') throw new CrmOperationsError('invalid_input', 'Order evidence is required.')
      return 'targetStatus' in envelope.event
        ? applyProviderOrderEvent(client, workspaceId, envelope.orderId, envelope.event, actor)
        : applyProviderOrderFinancialEvent(client, workspaceId, envelope.orderId, envelope.event, actor)
    },
    async read(client, row) {
      const order = await getOrderRecord(client, workspaceId, row.order_id!)
      if (!order) throw new CrmOperationsError('not_found', 'Order is unavailable.')
      return order
    },
  })
  return {
    async linkExternalIdentity(workspaceId, input, actor) {
      return transact(async (client) => {
        await requirePerson(client, workspaceId, input.contactId)
        const inserted = await client.query<DbRow>(
          `INSERT INTO association_external_identities
             (workspace_id, contact_id, provider, provider_subject)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (workspace_id, provider, provider_subject) DO NOTHING
           RETURNING ${IDENTITY_SELECT}`,
          [workspaceId, input.contactId, input.provider, input.providerSubject],
        )
        if (inserted.rows[0]) {
          await audit(client, workspaceId, 'external_identity.linked', 'external_identity', String(inserted.rows[0].id), actor)
          return { record: inserted.rows[0], created: true }
        }
        const existing = await client.query<DbRow>(
          `SELECT ${IDENTITY_SELECT} FROM association_external_identities
            WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
          [workspaceId, input.provider, input.providerSubject],
        )
        if (!existing.rows[0]) throw new AssociationError('conflict', 'provider identity could not be resolved after a concurrent link')
        if (existing.rows[0].contactId !== input.contactId) {
          throw new AssociationError('conflict', 'provider identity is already linked to another contact')
        }
        return { record: existing.rows[0], created: false }
      })
    },

    async resolveExternalIdentity(workspaceId, provider, providerSubject) {
      const result = await pool.query<DbRow>(
        `SELECT ${IDENTITY_SELECT} FROM association_external_identities
          WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
        [workspaceId, provider, providerSubject],
      )
      return result.rows[0] ?? null
    },

    async createEnquiry(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        if (integration) requireCrmIntegrationResources(integration, 'crm.submissions.write', { definitionIds: null })
        const fingerprint = associationFingerprint(input)
        await requirePerson(client, workspaceId, input.contactId)
        const evidence = await admitAssociationSourceScope(client, workspaceId, actor,
          await loadAssociationOrderScope(client, workspaceId, [input.contactId]))
        const inserted = await client.query<DbRow>(
          `INSERT INTO association_enquiries
             (workspace_id, contact_id, source, source_submission_id,
              request_fingerprint, subject, message, queue_key, submitted_at, submitted_data,scope_snapshot,scope_sources)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11::jsonb,$12::jsonb)
           ON CONFLICT (workspace_id, source, source_submission_id) DO NOTHING
           RETURNING ${ENQUIRY_SELECT}`,
          [workspaceId, input.contactId, input.source, input.sourceSubmissionId,
            fingerprint, input.subject, input.message, input.queueKey,
            input.submittedAt ?? null, input.submittedData, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)],
        )
        if (!inserted.rows[0]) {
          const existing = await client.query<DbRow>(
            `SELECT ${ENQUIRY_SELECT}, request_fingerprint AS "requestFingerprint"
               FROM association_enquiries
              WHERE workspace_id = $1 AND source = $2 AND source_submission_id = $3`,
            [workspaceId, input.source, input.sourceSubmissionId],
          )
          if (!existing.rows[0]) throw new AssociationError('conflict', 'enquiry could not be resolved after a concurrent submission')
          await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), actor, 'submission')
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'source submission id was already used for a different enquiry')
          }
          const { requestFingerprint: _ignored, ...record } = existing.rows[0]
          return { record, created: false }
        }
        const enquiry = inserted.rows[0]
        await client.query(
          `INSERT INTO association_notification_outbox
             (workspace_id, source_kind, source_id, template_key,
              recipient_kind, recipient_ref, payload)
           VALUES
             ($1,'enquiry',$2,'enquiry_acknowledgement','contact',$3,$4),
             ($1,'enquiry',$2,'enquiry_staff_alert','queue',$5,$4)`,
          [workspaceId, enquiry.id, input.contactId,
            { enquiryId: enquiry.id, subject: input.subject }, input.queueKey],
        )
        await audit(client, workspaceId, 'enquiry.created', 'enquiry', String(enquiry.id), actor, {
          source: input.source,
          queueKey: input.queueKey,
        })
        return { record: enquiry, created: true }
      })
    },

    async listEnquiries(workspaceId, input, actor) {
      return transact(async client => {
      if (!actor && (await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[workspaceId])).rows[0]?.department_read_v2 !== false)
        throw new CrmOperationsError('not_authorized','Submission reads require current actor scope.')
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      const access = actor ? await associationOrderReadPredicate(client,workspaceId,actor,2,'submission') : null
      if (access) { conditions.push(access.sql); values.push(...access.params) }
      const credential = actor ? await lockIntegrationActor(client,workspaceId,actor) : undefined
      if (credential && actor?.integration) {
        const selected=crmIntegrationResourceSelection(intersectCrmIntegrationAuthorities(actor.integration,credential),'crm.submissions.read','definitionIds')
        if(selected!=='all') { values.push([...selected]); conditions.push(`definition_id=ANY($${values.length}::uuid[])`) }
      }
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      if (input.queueKey) {
        values.push(input.queueKey)
        conditions.push(`queue_key = $${values.length}`)
      }
      if (input.ownerUserId) {
        values.push(input.ownerUserId)
        conditions.push(`owner_user_id = $${values.length}`)
      }
      const result = await page(client, workspaceId, 'association.enquiries', input,
        `SELECT ${ENQUIRY_SELECT} FROM association_enquiries WHERE ${conditions.join(' AND ')}`, values)
      if (actor && access) {
        const renewed=await associationOrderReadPredicate(client,workspaceId,actor,2,'submission')
        if(JSON.stringify(renewed.params)!==JSON.stringify(access.params))throw new CrmOperationsError('not_authorized','Submission access changed.')
      }
      return result
      })
    },

    async updateEnquiry(workspaceId, id, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        if (integration) {
          const row = (await client.query('SELECT definition_id FROM association_enquiries WHERE workspace_id=$1 AND id=$2', [workspaceId, id])).rows[0]
          requireCrmIntegrationResources(integration, 'crm.submissions.write', { definitionIds: row?.definition_id ?? null })
        }
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'submission')
        if (input.ownerUserId) await requireWorkspaceUser(client, workspaceId, input.ownerUserId)
        const result = await client.query<DbRow>(
          `UPDATE association_enquiries
              SET status = COALESCE($3, status),
                  queue_key = COALESCE($4, queue_key),
                  owner_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_user_id END
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${ENQUIRY_SELECT}`,
          [workspaceId, id, input.status ?? null, input.queueKey ?? null,
            Object.prototype.hasOwnProperty.call(input, 'ownerUserId'), input.ownerUserId ?? null],
        )
        const enquiry = result.rows[0]
        if (!enquiry) throw new AssociationError('not_found', 'enquiry not found')
        await audit(client, workspaceId, 'enquiry.updated', 'enquiry', id, actor, input)
        return enquiry
      })
    },

    async addEnquiryNote(workspaceId, enquiryId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        if (integration) {
          const row = (await client.query('SELECT definition_id FROM association_enquiries WHERE workspace_id=$1 AND id=$2', [workspaceId, enquiryId])).rows[0]
          requireCrmIntegrationResources(integration, 'crm.submissions.write', { definitionIds: row?.definition_id ?? null })
        }
        await assertAssociationOrderAuthority(client, workspaceId, enquiryId, actor, 'submission')
        const enquiry = await client.query(
          `SELECT 1 FROM association_enquiries WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, enquiryId],
        )
        if (!enquiry.rowCount) throw new AssociationError('not_found', 'enquiry not found')
        const result = await client.query<DbRow>(
          `INSERT INTO association_enquiry_notes
             (workspace_id, enquiry_id, body, actor_kind,
              actor_credential_id, acting_user_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ENQUIRY_NOTE_SELECT}`,
          [workspaceId, enquiryId, input.body, actor.credentialKind,
            actor.credentialId, actor.actingUserId ?? null],
        )
        const note = result.rows[0]
        await audit(client, workspaceId, 'enquiry.note_added', 'enquiry', enquiryId, actor, {
          noteId: note.id,
        })
        return note
      })
    },

    async listEnquiryNotes(workspaceId, enquiryId, actor) {
      return transact(async client => {
      if (!actor && (await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[workspaceId])).rows[0]?.department_read_v2 !== false)
        throw new CrmOperationsError('not_authorized','Submission reads require current actor scope.')
      if(actor) {
        const credential=await lockIntegrationActor(client,workspaceId,actor)
        if(credential) {
          const row=(await client.query('SELECT definition_id FROM association_enquiries WHERE workspace_id=$1 AND id=$2',[workspaceId,enquiryId])).rows[0]
          authorizeIntegration(actor,'crm.submissions.read',{definitionIds:row?.definition_id??null},credential)
        }
        await assertAssociationOrderAuthority(client,workspaceId,enquiryId,actor,'submission')
      }
      const result = await client.query<DbRow>(
        `SELECT ${ENQUIRY_NOTE_SELECT} FROM association_enquiry_notes
          WHERE workspace_id = $1 AND enquiry_id = $2
          ORDER BY created_at, id`,
        [workspaceId, enquiryId],
      )
      if(actor)await assertAssociationOrderAuthority(client,workspaceId,enquiryId,actor,'submission')
      return result.rows
      })
    },

    async appendConsent(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client,workspaceId)
        const integration=await lockIntegrationActor(client,workspaceId,actor)
        authorizeIntegration(actor,'crm.consent.write',{purposeKeys:input.purpose},integration)
        const evidence=await admitAssociationSourceScope(client,workspaceId,actor,await loadAssociationOrderScope(client,workspaceId,[input.contactId]))
        const request: CrmEvidenceRequest = { kind: 'consent', contactId: input.contactId,
          purposeKey: input.purpose, action: input.action, wordingVersion: input.wordingVersion,
          locale: input.locale,
          source: input.source, occurredAt: input.occurredAt, metadata: input.metadata }
        const replay = () => client.query<DbRow>(
          `SELECT ${CONSENT_SELECT}, request_fingerprint AS "__requestHash",
                  to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__occurredAt"
             FROM association_consent_events
            WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3`,
          [workspaceId, input.provider, input.providerEventId],
        )
        if (input.provider && input.providerEventId) {
          const existing = await replay()
          if (existing.rows[0]) {
            await assertAssociationOrderAuthority(client,workspaceId,String(existing.rows[0].id),actor,'consent')
            return { record: resolveCrmEvidenceReplay(existing.rows[0], request), created: false }
          }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const catalog = await client.query<DbRow>(
          `SELECT p.id AS "purposeId", p.archived_at AS "archivedAt", v.id AS "versionId",
            v.wording_snapshot AS wording, v.wording_hash AS "wordingHash", v.default_locale AS "defaultLocale",
            v.locale_wordings AS "localeWordings", v.locale_wording_hashes AS "localeWordingHashes"
           FROM crm_consent_purposes p LEFT JOIN crm_consent_purpose_versions v
             ON v.workspace_id=p.workspace_id AND v.purpose_id=p.id AND v.version=$3
           WHERE p.workspace_id=$1 AND p.purpose_key=$2`, [workspaceId,input.purpose,input.wordingVersion])
        const purpose = catalog.rows[0]
        if (purpose && (purpose.archivedAt || !purpose.versionId)) {
          throw new AssociationError('conflict', 'Consent purpose or wording version is unavailable.')
        }
        if (!purpose && input.locale) throw new AssociationError('conflict', 'Localized consent requires a catalogued wording version.')
        const localized = input.locale ? (purpose?.localeWordings as Record<string, string> | undefined)?.[input.locale] : undefined
        const result = await client.query<DbRow>(
          `INSERT INTO association_consent_events
             (workspace_id, contact_id, purpose, action, wording_version, source,
              occurred_at, provider, provider_event_id, metadata, request_fingerprint,
              purpose_id,wording_version_id,wording_snapshot,wording_hash,wording_locale,scope_snapshot,scope_sources)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
           ON CONFLICT (workspace_id, provider, provider_event_id)
             WHERE provider IS NOT NULL DO NOTHING
           RETURNING ${CONSENT_SELECT}`,
          [workspaceId, input.contactId, input.purpose, input.action,
            input.wordingVersion, input.source, input.occurredAt ?? null,
            input.provider ?? null, input.providerEventId ?? null, input.metadata,
            input.provider ? crmEvidenceRequestHash(request) : null,
            purpose?.purposeId ?? null, purpose?.versionId ?? null, localized ?? purpose?.wording ?? null,
            localized ? (purpose!.localeWordingHashes as Record<string,string>)[input.locale!] : purpose?.wordingHash ?? null,
            localized ? input.locale : purpose?.defaultLocale ?? null,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)],
        )
        if (!result.rows[0] && input.provider && input.providerEventId) {
          const raced = await replay()
          if (!raced.rows[0]) throw new AssociationError('conflict', 'consent event could not be resolved after a concurrent submission')
          await assertAssociationOrderAuthority(client,workspaceId,String(raced.rows[0].id),actor,'consent')
          return { record: resolveCrmEvidenceReplay(raced.rows[0], request), created: false }
        }
        const consent = result.rows[0]
        await audit(client, workspaceId, `consent.${input.action}`, 'consent_event', String(consent.id), actor, {
          contactId: input.contactId, purpose: input.purpose, wordingVersion: input.wordingVersion,
        })
        return { record: consent, created: true }
      })
    },

    async listConsents(workspaceId, contactId, actor) {
      return transact(async client=>{
        const integration=actor ? await lockIntegrationActor(client,workspaceId,actor) : undefined
        if(actor)authorizeIntegration(actor,'crm.consent.read',{purposeKeys:null},integration)
        const scope=await assertAssociationConsentAuthority(client,workspaceId,contactId,actor)
      const result = await client.query<DbRow>(
        `SELECT ${CONSENT_SELECT} FROM association_consent_events
          WHERE workspace_id = $1 AND contact_id = $2
          ORDER BY occurred_at DESC, created_at DESC, id DESC`,
        [workspaceId, contactId],
      )
      const effective: Record<string, string> = {}
      for (const event of result.rows) {
        const purpose = String(event.purpose)
        if (!(purpose in effective)) effective[purpose] = String(event.action)
      }
      if(scope!==await assertAssociationConsentAuthority(client,workspaceId,contactId,actor))throw new CrmOperationsError('not_authorized','Consent access changed.')
      return { events: result.rows, effective }
      })
    },

    async upsertPlan(workspaceId, input, actor) {
      return transact(async (client) => {
        const saved = await saveCrmEntitlementPlanRecord(client, workspaceId, input)
        await audit(client, workspaceId, saved.created ? 'plan.created' : 'plan.updated', 'membership_plan', String(saved.record.id), actor)
        return saved
      })
    },

    async listPlans(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.published !== undefined) {
        values.push(input.published)
        conditions.push(`published = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.plans', input,
        `SELECT ${PLAN_SELECT} FROM association_membership_plans WHERE ${conditions.join(' AND ')}`, values)
    },

    async createMembership(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        authorizeIntegration(actor, 'crm.entitlements.write', { planIds: input.planId }, integration)
        if (input.provider) {
          requireProviderEntitlementActor(actor, input.provider)
          authorizeIntegration(actor, 'association.provider_events.write', { providerKeys: input.provider }, integration)
        }
        const period = await prepareProviderEntitlementPeriod(client, workspaceId, { ...input, providerEntitlementId: input.providerMembershipId })
        const fingerprint = period?.requestHash ?? associationFingerprint(input)
        const existing = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT}, m.request_fingerprint AS "requestFingerprint"
             FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND (m.idempotency_key = $2 OR m.id=$3) ORDER BY (m.idempotency_key=$2) DESC FOR UPDATE OF m`,
          [workspaceId, input.idempotencyKey, period?.existingId ?? null],
        )
        if (existing.rows[0]) {
          await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), actor, 'membership')
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different membership')
          }
          const { requestFingerprint: _ignored, ...record } = existing.rows[0]
          return { record, created: false }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const plan = await client.query(
          `SELECT 1 FROM association_membership_plans WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, input.planId],
        )
        if (!plan.rowCount) throw new AssociationError('not_found', 'membership plan not found')
        let evidence = await loadAssociationOrderScope(client, workspaceId, [input.contactId])
        evidence = await admitAssociationSourceScope(client, workspaceId, actor, evidence)
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO association_memberships
             (workspace_id, contact_id, plan_id, idempotency_key,
              request_fingerprint, status, starts_at, ends_at, renewal_mode,
              provider, provider_membership_id, provider_period_id, predecessor_id, scope_snapshot, scope_sources)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [workspaceId, input.contactId, input.planId, input.idempotencyKey,
            fingerprint, input.status, input.startsAt, input.endsAt ?? null,
            input.renewalMode, input.provider ?? null, input.providerMembershipId ?? null, input.providerPeriodId ?? null, input.predecessorId ?? null, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)],
        )
        if (!inserted.rows[0]) {
          const raced = await client.query<DbRow>(
            `SELECT ${MEMBERSHIP_SELECT}, m.request_fingerprint AS "requestFingerprint"
               FROM association_memberships m
               JOIN association_membership_plans p
                 ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
              WHERE m.workspace_id = $1 AND m.idempotency_key = $2`,
            [workspaceId, input.idempotencyKey],
          )
          if (!raced.rows[0]) throw new AssociationError('conflict', 'membership could not be resolved after a concurrent submission')
          await assertAssociationOrderAuthority(client, workspaceId, String(raced.rows[0].id), actor, 'membership')
          if (raced.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different membership')
          }
          const { requestFingerprint: _ignored, ...record } = raced.rows[0]
          return { record, created: false }
        }
        const membership = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.id = $2`,
          [workspaceId, inserted.rows[0].id],
        )
        await audit(client, workspaceId, 'membership.created', 'membership', inserted.rows[0].id, actor, {
          contactId: input.contactId,
          planId: input.planId,
          status: input.status,
        })
        await assertAssociationOrderAuthority(client, workspaceId, inserted.rows[0].id, actor, 'membership')
        return { record: membership.rows[0], created: true }
      })
    },

    async importSourceMembership(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const reviewer = await requireSourceMembershipImportActor(client, workspaceId, actor, input.importJobId)
        const { importJobId, importRow, ...evidence } = input
        const fingerprint = associationFingerprint(evidence)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-source-membership:'||$1::text||':'||$2||':'||$3||':'||$4,0))",
          [workspaceId, input.source, input.sourceSite, input.sourceMembershipId],
        )
        const existing = (await client.query<{ membership_id: string; request_fingerprint: string }>(
          `SELECT membership_id,request_fingerprint FROM association_membership_source_imports
            WHERE workspace_id=$1 AND source_system=$2 AND source_site=$3 AND source_membership_id=$4`,
          [workspaceId, input.source, input.sourceSite, input.sourceMembershipId],
        )).rows[0]
        if (existing) {
          await assertAssociationOrderAuthority(client, workspaceId, existing.membership_id, actor, 'membership')
          if (existing.request_fingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'Source membership identity was already used with different evidence.')
          }
          return { record: (await getSourceMembershipRecord(client, workspaceId, existing.membership_id))!, created: false }
        }
        const timing = (await client.query<{ purchased_valid: boolean; cancelled_valid: boolean }>(
          `SELECT $1::timestamptz<=clock_timestamp() purchased_valid,
             ($2::timestamptz IS NULL OR $2::timestamptz<=clock_timestamp()) cancelled_valid`,
          [input.purchasedAt, input.cancelledAt ?? null],
        )).rows[0]
        if (!timing.purchased_valid || !timing.cancelled_valid) {
          throw new AssociationError('conflict', 'Source membership evidence cannot be dated in the future.')
        }
        await requirePerson(client, workspaceId, input.contactId)
        const plan = await client.query(
          `SELECT 1 FROM association_membership_plans WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE`,
          [workspaceId, input.planId],
        )
        if (!plan.rowCount) throw new AssociationError('not_found', 'membership plan not found')
        let scopeEvidence = await loadAssociationOrderScope(client, workspaceId, [input.contactId])
        scopeEvidence = await admitAssociationSourceScope(client, workspaceId, actor, scopeEvidence)
        const membership = (await client.query<{ id: string }>(
          `INSERT INTO association_memberships(
             workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,
             starts_at,ends_at,renewal_mode,provider,provider_membership_id,provider_period_id,
             predecessor_id,created_at,updated_at,scope_snapshot,scope_sources)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,NULL,NULL,$10,$10,$11::jsonb,$12::jsonb)
           RETURNING id`,
          [workspaceId, input.contactId, input.planId, input.idempotencyKey,
            fingerprint, input.status, input.startsAt, input.endsAt ?? null,
            input.targetRenewalMode, input.purchasedAt, JSON.stringify(scopeEvidence.scope), JSON.stringify(scopeEvidence.sources)],
        )).rows[0]
        await client.query("SELECT set_config('app.association_source_membership_actor',$1,true)", [reviewer])
        await client.query(
          `INSERT INTO association_membership_source_imports(
             workspace_id,membership_id,source_system,source_site,source_membership_id,
             source_plan_id,source_member_id,source_order_id,source_subscription_id,
             source_payment_provider,source_payment_reference,source_status,source_renewal_status,
             source_payment_status,source_refund_status,purchased_at,cancelled_at,
             relationships,metadata,import_job_id,import_row,request_fingerprint)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [workspaceId, membership.id, input.source, input.sourceSite, input.sourceMembershipId,
            input.sourcePlanId, input.sourceMemberId ?? null, input.sourceOrderId ?? null,
            input.sourceSubscriptionId ?? null, input.sourcePaymentProvider ?? null,
            input.sourcePaymentReference ?? null, input.sourceStatus, input.sourceRenewalStatus,
            input.sourcePaymentStatus ?? null, input.sourceRefundStatus ?? null,
            input.purchasedAt, input.cancelledAt ?? null, input.relationships, input.metadata,
            importJobId, importRow, fingerprint],
        )
        await audit(client, workspaceId, 'membership.source_imported', 'membership', membership.id, actor, {
          contactId: input.contactId, planId: input.planId, source: input.source,
          sourceSite: input.sourceSite, sourceMembershipId: input.sourceMembershipId,
          importJobId, importRow,
        })
        await assertAssociationOrderAuthority(client, workspaceId, membership.id, actor, 'membership')
        return { record: (await getSourceMembershipRecord(client, workspaceId, membership.id))!, created: true }
      })
    },

    async listMemberships(workspaceId, contactId, filters = {}, actor) {
      return transact(async client => {
      const scope = actor ? await associationOrderReadPredicate(client, workspaceId, actor, 5, 'membership') : { sql: 'TRUE', params: [] }
      const input = CrmEffectiveEntitlementQuerySchema.parse(filters)
      const at = 'coalesce($4::timestamptz,statement_timestamp())'
      const result = await client.query<DbRow>(
        `SELECT ${MEMBERSHIP_SELECT},(s.id IS NOT NULL) AS "sourceImport",
             CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
               'source',s.source_system,'site',s.source_site,'membershipId',s.source_membership_id,
               'planId',s.source_plan_id,'memberId',s.source_member_id,'orderId',s.source_order_id,
               'subscriptionId',s.source_subscription_id,'paymentProvider',s.source_payment_provider,
               'paymentReference',s.source_payment_reference,'status',s.source_status,
               'renewalStatus',s.source_renewal_status,'paymentStatus',s.source_payment_status,
               'refundStatus',s.source_refund_status,'purchasedAt',s.purchased_at,
               'cancelledAt',s.cancelled_at,'relationships',s.relationships,'metadata',s.metadata)
             END AS "sourceEvidence",
             association_membership_is_effective(m.workspace_id,m.id,m.status,m.starts_at,m.ends_at,${at}) AS "isEffective",
             to_char(${at} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "effectiveAt"
           FROM association_memberships m JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
           LEFT JOIN association_membership_source_imports s
             ON s.workspace_id=m.workspace_id AND s.membership_id=m.id
          WHERE m.workspace_id=$1 AND m.contact_id=$2
            AND EXISTS(SELECT 1 FROM association_memberships WHERE association_memberships.workspace_id=m.workspace_id AND association_memberships.id=m.id AND ${scope.sql})
            AND (NOT $3::boolean OR association_membership_is_effective(m.workspace_id,m.id,m.status,m.starts_at,m.ends_at,${at}))
          ORDER BY m.created_at DESC,m.id DESC`,
        [workspaceId, contactId, input.activeOnly ?? false, input.effectiveAt ? crmPageInstant(input.effectiveAt) : null, ...scope.params],
      )
      if (actor) {
        const renewed = await associationOrderReadPredicate(client, workspaceId, actor, 5, 'membership')
        if (JSON.stringify(renewed.params) !== JSON.stringify(scope.params)) throw new CrmOperationsError('not_authorized', 'Membership access changed.')
      }
      return result.rows
      })
    },

    async updateMembership(workspaceId, id, input, actor) {
      return transact(async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const current = await client.query<{ starts_at: Date; status: string; plan_id: string; provider: string | null }>(
          `SELECT starts_at,status,plan_id,provider FROM association_memberships
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        )
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'membership')
        if (!current.rows[0]) throw new AssociationError('not_found', 'membership not found')
        const membership = current.rows[0]
        authorizeIntegration(actor, 'crm.entitlements.write', { planIds: membership.plan_id }, integration)
        if (membership.provider) {
          requireProviderEntitlementActor(actor, membership.provider)
          authorizeIntegration(actor, 'association.provider_events.write', { providerKeys: membership.provider }, integration)
        }
        if (input.status && !mayTransitionCrmEntitlement(membership.status, input.status)) {
          throw new AssociationError('invalid_transition', 'Terminal membership cannot be revived; renew with a new period.')
        }
        if (input.endsAt && new Date(input.endsAt) <= current.rows[0].starts_at) {
          throw new AssociationError('conflict', 'endsAt must be after startsAt')
        }
        await client.query(
          `UPDATE association_memberships
              SET status = COALESCE($3, status),
                  ends_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE ends_at END,
                  renewal_mode = COALESCE($6, renewal_mode)
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, id, input.status ?? null,
            Object.prototype.hasOwnProperty.call(input, 'endsAt'), input.endsAt ?? null,
            input.renewalMode ?? null],
        )
        const result = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.id = $2`,
          [workspaceId, id],
        )
        await audit(client, workspaceId, 'membership.updated', 'membership', id, actor, input)
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'membership')
        return result.rows[0]
      })
    },

    async listSponsorshipAllocations(workspaceId, input, actor) {
      return transact(async client => {
      const scope=actor?await associationOrderReadPredicate(client,workspaceId,actor,2,'allocation'):{sql:'TRUE',params:[]}
      const conditions = ['a.workspace_id=$1', `EXISTS(SELECT 1 FROM association_sponsorship_allocations WHERE association_sponsorship_allocations.workspace_id=a.workspace_id AND association_sponsorship_allocations.id=a.id AND ${scope.sql})`]
      const values: unknown[] = [workspaceId,...scope.params]
      for (const [column, value] of [['a.sponsor_contact_id', input.sponsorContactId], ['a.status', input.status]] as const) {
        if (value) { values.push(value); conditions.push(`${column}=$${values.length}`) }
      }
      const result=await page(client, workspaceId, 'association.sponsorship_allocations', input,
        `SELECT ${SPONSORSHIP_ALLOCATION_SELECT}
           FROM association_sponsorship_allocations a
           JOIN entities sponsor ON sponsor.workspace_id=a.workspace_id AND sponsor.id=a.sponsor_contact_id
           JOIN association_membership_plans beneficiary ON beneficiary.workspace_id=a.workspace_id AND beneficiary.id=a.beneficiary_plan_id
          WHERE ${conditions.join(' AND ')}`, values)
      if(actor)for(const record of result.items)await protectSponsorshipSeatCount(client,workspaceId,record,actor)
      if(actor){const renewed=await associationOrderReadPredicate(client,workspaceId,actor,2,'allocation');if(JSON.stringify(renewed.params)!==JSON.stringify(scope.params))throw new CrmOperationsError('not_authorized','Sponsorship access changed.')}
      return result
      })
    },

    async createSponsorshipAllocation(workspaceId, input, actor) {
      return transact(async client => {
        await beginAssociationCreation(client, workspaceId)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:association-sponsorship`])
        const fingerprint = associationFingerprint(input)
        const replay = async () => client.query<DbRow>(
          `SELECT ${SPONSORSHIP_ALLOCATION_SELECT},a.request_fingerprint AS "requestFingerprint"
             FROM association_sponsorship_allocations a
             JOIN entities sponsor ON sponsor.workspace_id=a.workspace_id AND sponsor.id=a.sponsor_contact_id
             JOIN association_membership_plans beneficiary ON beneficiary.workspace_id=a.workspace_id AND beneficiary.id=a.beneficiary_plan_id
            WHERE a.workspace_id=$1 AND a.idempotency_key=$2 FOR UPDATE OF a`, [workspaceId, input.idempotencyKey])
        const existing = (await replay()).rows[0]
        if (existing) {
          await assertAssociationOrderAuthority(client,workspaceId,String(existing.id),actor,'allocation')
          if (existing.requestFingerprint !== fingerprint) throw new AssociationError('conflict', 'idempotency key was already used for a different sponsorship allocation')
          const { requestFingerprint: _ignored, ...record } = existing
          await protectSponsorshipSeatCount(client,workspaceId,record,actor)
          return { record, created: false }
        }
        await requirePerson(client, workspaceId, input.sponsorContactId)
        const sponsor = (await client.query<{contact_id:string;starts_at:Date;ends_at:Date|null;sponsorship_allocation_id:string|null;effective:boolean}>(
          `SELECT contact_id,starts_at,ends_at,sponsorship_allocation_id,
             crm_entitlement_is_effective(status,starts_at,ends_at,statement_timestamp()) effective
             FROM association_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, input.sponsorMembershipId])).rows[0]
        const inherited=await assertAssociationOrderAuthority(client,workspaceId,input.sponsorMembershipId,actor,'membership')
        if (!sponsor) throw new AssociationError('not_found', 'sponsor membership not found')
        if (sponsor.contact_id !== input.sponsorContactId) throw new AssociationError('conflict', 'sponsor membership belongs to a different contact')
        if (sponsor.sponsorship_allocation_id || !sponsor.effective) throw new AssociationError('not_available', 'sponsor membership must be a current direct entitlement')
        if (Date.parse(input.startsAt) < sponsor.starts_at.getTime()) throw new AssociationError('conflict', 'allocation cannot start before the sponsor membership')
        if (sponsor.ends_at && Date.parse(input.endsAt) > sponsor.ends_at.getTime()) throw new AssociationError('conflict', 'allocation cannot outlive the sponsor membership')
        const plan = (await client.query<{fee_minor:string;provider:string|null}>(
          `SELECT fee_minor::text,provider FROM association_membership_plans WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
          [workspaceId, input.beneficiaryPlanId])).rows[0]
        if (!plan) throw new AssociationError('not_found', 'beneficiary plan not found')
        if (plan.provider || plan.fee_minor !== '0') throw new AssociationError('not_available', 'sponsorship requires a zero-fee plan managed by Brian')
        const current=await loadAssociationOrderScope(client,workspaceId,[input.sponsorContactId,...(inherited?.sources.map(source=>source.resourceId) ?? [])])
        let evidence={sources:current.sources,scope:deriveResourceScope({producer:'association.sponsorship',sources:current.sources},inherited?.scope ?? current.scope)}
        evidence = await admitAssociationSourceScope(client, workspaceId, actor, evidence)
        const inserted = (await client.query<{id:string}>(
          `INSERT INTO association_sponsorship_allocations
             (workspace_id,sponsor_contact_id,sponsor_membership_id,beneficiary_plan_id,idempotency_key,request_fingerprint,
              seat_limit,starts_at,ends_at,invitation_ttl_hours,scope_snapshot,scope_sources)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
           ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
          [workspaceId,input.sponsorContactId,input.sponsorMembershipId,input.beneficiaryPlanId,input.idempotencyKey,
            fingerprint,input.seatLimit,input.startsAt,input.endsAt,input.invitationTtlHours,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])).rows[0]
        if (!inserted) {
          const raced=(await replay()).rows[0]
          if(raced)await assertAssociationOrderAuthority(client,workspaceId,String(raced.id),actor,'allocation')
          if(!raced || raced.requestFingerprint!==fingerprint)throw new AssociationError('conflict','sponsorship allocation could not be resolved after a concurrent submission')
          const {requestFingerprint:_ignored,...record}=raced
          await protectSponsorshipSeatCount(client,workspaceId,record,actor)
          return {record,created:false}
        }
        const record=(await client.query<DbRow>(`SELECT ${SPONSORSHIP_ALLOCATION_SELECT}
          FROM association_sponsorship_allocations a
          JOIN entities sponsor ON sponsor.workspace_id=a.workspace_id AND sponsor.id=a.sponsor_contact_id
          JOIN association_membership_plans beneficiary ON beneficiary.workspace_id=a.workspace_id AND beneficiary.id=a.beneficiary_plan_id
          WHERE a.workspace_id=$1 AND a.id=$2`,[workspaceId,inserted.id])).rows[0]!
        await audit(client,workspaceId,'sponsorship.allocation_created','sponsorship_allocation',inserted.id,actor,
          {contactId:input.sponsorContactId,beneficiaryPlanId:input.beneficiaryPlanId,seatLimit:input.seatLimit})
        await assertAssociationOrderAuthority(client,workspaceId,inserted.id,actor,'allocation')
        await protectSponsorshipSeatCount(client,workspaceId,record,actor)
        return {record,created:true}
      })
    },

    async cancelSponsorshipAllocation(workspaceId, id, input, actor) {
      return transact(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:association-sponsorship`])
        const allocation=(await client.query<{status:string}>(
          'SELECT status FROM association_sponsorship_allocations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,id])).rows[0]
        await assertAssociationOrderAuthority(client,workspaceId,id,actor,'allocation')
        if(!allocation)throw new AssociationError('not_found','sponsorship allocation not found')
        const children=await client.query<{id:string}>('SELECT id FROM association_sponsorship_invitations WHERE workspace_id=$1 AND allocation_id=$2 ORDER BY id FOR UPDATE',[workspaceId,id])
        const memberships=await client.query<{id:string}>('SELECT id FROM association_memberships WHERE workspace_id=$1 AND sponsorship_allocation_id=$2 ORDER BY id FOR UPDATE',[workspaceId,id])
        for(const child of children.rows)await assertAssociationOrderAuthority(client,workspaceId,child.id,actor,'invitation')
        for(const membership of memberships.rows)await assertAssociationOrderAuthority(client,workspaceId,membership.id,actor,'membership')
        if(allocation.status==='cancelled')return {record:{id,status:'cancelled'},created:false}
        await client.query(`UPDATE association_sponsorship_allocations SET status='cancelled',cancellation_reason=$3,cancelled_at=statement_timestamp()
          WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,input.reason])
        await client.query(`UPDATE association_sponsorship_invitations SET status='revoked',revocation_reason=$3,revoked_at=statement_timestamp()
          WHERE workspace_id=$1 AND allocation_id=$2 AND status='pending'`,[workspaceId,id,input.reason])
        await client.query(`UPDATE association_memberships SET status='cancelled'
          WHERE workspace_id=$1 AND sponsorship_allocation_id=$2 AND status IN('pending','active')`,[workspaceId,id])
        await audit(client,workspaceId,'sponsorship.allocation_cancelled','sponsorship_allocation',id,actor,{reason:input.reason,requestId:input.requestId})
        await assertAssociationOrderAuthority(client,workspaceId,id,actor,'allocation')
        for(const child of children.rows)await assertAssociationOrderAuthority(client,workspaceId,child.id,actor,'invitation')
        for(const membership of memberships.rows)await assertAssociationOrderAuthority(client,workspaceId,membership.id,actor,'membership')
        return {record:{id,status:'cancelled',cancellationReason:input.reason},created:true}
      })
    },

    async listSponsorshipInvitations(workspaceId, input, actor) {
      return transact(async client => {
      const scope=actor?await associationOrderReadPredicate(client,workspaceId,actor,2,'invitation'):{sql:'TRUE',params:[]}
      const conditions=['i.workspace_id=$1', `EXISTS(SELECT 1 FROM association_sponsorship_invitations WHERE association_sponsorship_invitations.workspace_id=i.workspace_id AND association_sponsorship_invitations.id=i.id AND ${scope.sql})`];const values:unknown[]=[workspaceId,...scope.params]
      for(const [column,value] of [['i.allocation_id',input.allocationId],['i.nominee_contact_id',input.nomineeContactId],['i.status',input.status]] as const)
        if(value){values.push(value);conditions.push(`${column}=$${values.length}`)}
      const result=await page(client,workspaceId,'association.sponsorship_invitations',input,
        `SELECT ${SPONSORSHIP_INVITATION_SELECT} FROM association_sponsorship_invitations i
          JOIN entities nominee ON nominee.workspace_id=i.workspace_id AND nominee.id=i.nominee_contact_id
          WHERE ${conditions.join(' AND ')}`,values)
      if(actor){const renewed=await associationOrderReadPredicate(client,workspaceId,actor,2,'invitation');if(JSON.stringify(renewed.params)!==JSON.stringify(scope.params))throw new CrmOperationsError('not_authorized','Sponsorship access changed.')}
      return result
      })
    },

    async issueSponsorshipInvitation(workspaceId, input, actor) {
      return transact(async client => {
        await beginAssociationCreation(client, workspaceId)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:association-sponsorship`])
        const fingerprint=associationFingerprint(input)
        const replay=async()=>client.query<DbRow>(`SELECT ${SPONSORSHIP_INVITATION_SELECT},i.request_fingerprint AS "requestFingerprint"
          FROM association_sponsorship_invitations i JOIN entities nominee ON nominee.workspace_id=i.workspace_id AND nominee.id=i.nominee_contact_id
          WHERE i.workspace_id=$1 AND i.idempotency_key=$2 FOR UPDATE OF i`,[workspaceId,input.idempotencyKey])
        const existing=(await replay()).rows[0]
        if(existing){
          await assertAssociationOrderAuthority(client,workspaceId,String(existing.id),actor,'invitation')
          if(existing.requestFingerprint!==fingerprint)throw new AssociationError('conflict','idempotency key was already used for a different sponsorship invitation')
          const {requestFingerprint:_ignored,...record}=existing
          return {record:{...record,redemptionToken:null},created:false}
        }
        const allocation=(await client.query<{status:string;starts_at:Date;ends_at:Date;invitation_ttl_hours:number;seat_limit:number}>(
          `SELECT status,starts_at,ends_at,invitation_ttl_hours,seat_limit FROM association_sponsorship_allocations
            WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,input.allocationId])).rows[0]
        const inherited=await assertAssociationOrderAuthority(client,workspaceId,input.allocationId,actor,'allocation')
        if(!allocation)throw new AssociationError('not_found','sponsorship allocation not found')
        if(allocation.status!=='active'||allocation.ends_at.getTime()<=Date.now())throw new AssociationError('not_available','sponsorship allocation is not available')
        const evidenceBase=await loadAssociationOrderScope(client,workspaceId,[input.nomineeContactId,...(inherited?.sources.map(source=>source.resourceId) ?? [])])
        let evidence={sources:evidenceBase.sources,scope:deriveResourceScope({producer:'association.sponsorship-invitation',sources:evidenceBase.sources},inherited?.scope ?? evidenceBase.scope)}
        evidence = await admitAssociationSourceScope(client, workspaceId, actor, evidence)
        const expiring=await client.query<{id:string}>("SELECT id FROM association_sponsorship_invitations WHERE workspace_id=$1 AND allocation_id=$2 AND status='pending' AND expires_at<=statement_timestamp() ORDER BY id FOR UPDATE",[workspaceId,input.allocationId])
        for(const child of expiring.rows)await assertAssociationOrderAuthority(client,workspaceId,child.id,actor,'invitation')
        const expired=await client.query<{id:string}>(`UPDATE association_sponsorship_invitations
          SET status='revoked',revocation_reason='Invitation expired before replacement.',revoked_at=statement_timestamp()
          WHERE workspace_id=$1 AND allocation_id=$2 AND status='pending' AND expires_at<=statement_timestamp() RETURNING id`,
          [workspaceId,input.allocationId])
        for(const row of expired.rows)await audit(client,workspaceId,'sponsorship.invitation_expired','sponsorship_invitation',row.id,actor,
          {allocationId:input.allocationId})
        await requirePerson(client,workspaceId,input.nomineeContactId)
        const duplicateNominee=await client.query(`SELECT 1 FROM association_sponsorship_invitations
          WHERE workspace_id=$1 AND allocation_id=$2 AND nominee_contact_id=$3 AND status IN('pending','redeemed')`,
          [workspaceId,input.allocationId,input.nomineeContactId])
        if(duplicateNominee.rowCount)throw new AssociationError('conflict','nominee already has a live invitation in this allocation')
        const counted=await client.query<{id:string}>("SELECT id FROM association_sponsorship_invitations WHERE workspace_id=$1 AND allocation_id=$2 AND (status='redeemed' OR (status='pending' AND expires_at>statement_timestamp())) ORDER BY id FOR SHARE",[workspaceId,input.allocationId])
        for(const child of counted.rows)await assertAssociationOrderAuthority(client,workspaceId,child.id,actor,'invitation')
        const used=Number((await client.query<{count:string}>(`SELECT count(*)::text count FROM association_sponsorship_invitations
          WHERE workspace_id=$1 AND allocation_id=$2 AND (status='redeemed' OR (status='pending' AND expires_at>statement_timestamp()))`,
          [workspaceId,input.allocationId])).rows[0]!.count)
        if(used>=allocation.seat_limit)throw new AssociationError('not_available','sponsorship allocation has no available seats')
        const token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex')
        const expiresAt=new Date(Math.min(Date.now()+allocation.invitation_ttl_hours*3_600_000,allocation.ends_at.getTime()))
        const inserted=(await client.query<{id:string}>(`INSERT INTO association_sponsorship_invitations
          (workspace_id,allocation_id,nominee_contact_id,token_hash,idempotency_key,request_fingerprint,expires_at,scope_snapshot,scope_sources)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
          [workspaceId,input.allocationId,input.nomineeContactId,tokenHash,input.idempotencyKey,fingerprint,expiresAt,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])).rows[0]
        if(!inserted){
          const raced=(await replay()).rows[0]
          if(raced)await assertAssociationOrderAuthority(client,workspaceId,String(raced.id),actor,'invitation')
          if(!raced||raced.requestFingerprint!==fingerprint)throw new AssociationError('conflict','sponsorship invitation could not be resolved after a concurrent submission')
          const {requestFingerprint:_ignored,...record}=raced
          return {record:{...record,redemptionToken:null},created:false}
        }
        const record=(await client.query<DbRow>(`SELECT ${SPONSORSHIP_INVITATION_SELECT}
          FROM association_sponsorship_invitations i JOIN entities nominee ON nominee.workspace_id=i.workspace_id AND nominee.id=i.nominee_contact_id
          WHERE i.workspace_id=$1 AND i.id=$2`,[workspaceId,inserted.id])).rows[0]!
        await audit(client,workspaceId,'sponsorship.invitation_issued','sponsorship_invitation',inserted.id,actor,
          {contactId:input.nomineeContactId,allocationId:input.allocationId})
        await assertAssociationOrderAuthority(client,workspaceId,inserted.id,actor,'invitation')
        for(const child of counted.rows)await assertAssociationOrderAuthority(client,workspaceId,child.id,actor,'invitation')
        for(const child of expiring.rows)await assertAssociationOrderAuthority(client,workspaceId,child.id,actor,'invitation')
        return {record:{...record,redemptionToken:token},created:true}
      })
    },

    async revokeSponsorshipInvitation(workspaceId,id,input,actor){
      return transact(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:association-sponsorship`])
        const invitation=(await client.query<{status:string;membership_id:string|null}>(
          'SELECT status,membership_id FROM association_sponsorship_invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,id])).rows[0]
        await assertAssociationOrderAuthority(client,workspaceId,id,actor,'invitation')
        if(!invitation)throw new AssociationError('not_found','sponsorship invitation not found')
        if(invitation.membership_id)await assertAssociationOrderAuthority(client,workspaceId,invitation.membership_id,actor,'membership')
        if(invitation.status==='revoked')return {record:{id,status:'revoked'},created:false}
        await client.query(`UPDATE association_sponsorship_invitations SET status='revoked',revocation_reason=$3,revoked_at=statement_timestamp(),
          redeemed_at=NULL,redeemed_contact_id=NULL,membership_id=NULL WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,input.reason])
        if(invitation.membership_id)await client.query(`UPDATE association_memberships SET status='cancelled'
          WHERE workspace_id=$1 AND id=$2 AND status IN('pending','active')`,[workspaceId,invitation.membership_id])
        await audit(client,workspaceId,'sponsorship.invitation_revoked','sponsorship_invitation',id,actor,{reason:input.reason,requestId:input.requestId})
        await assertAssociationOrderAuthority(client,workspaceId,id,actor,'invitation')
        if(invitation.membership_id)await assertAssociationOrderAuthority(client,workspaceId,invitation.membership_id,actor,'membership')
        return {record:{id,status:'revoked',revocationReason:input.reason},created:true}
      })
    },

    async redeemSponsorshipInvitation(workspaceId,input,actor){
      return transact(async client=>{
        await beginAssociationCreation(client, workspaceId)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:association-sponsorship`])
        const tokenHash=createHash('sha256').update(input.token).digest('hex')
        const invitation=(await client.query<{id:string;allocation_id:string;nominee_contact_id:string;status:string;expires_at:Date;redeemed_contact_id:string|null;membership_id:string|null}>(
          `SELECT id,allocation_id,nominee_contact_id,status,expires_at,redeemed_contact_id,membership_id
             FROM association_sponsorship_invitations WHERE workspace_id=$1 AND token_hash=$2 FOR UPDATE`,[workspaceId,tokenHash])).rows[0]
        if(!invitation)throw new AssociationError('not_found','sponsorship invitation not found')
        const inherited=await assertAssociationOrderAuthority(client,workspaceId,invitation.id,actor,'invitation')
        if(invitation.nominee_contact_id!==input.contactId)throw new AssociationError('not_available','sponsorship invitation belongs to a different member')
        if(invitation.status==='redeemed'&&invitation.redeemed_contact_id===input.contactId&&invitation.membership_id){
          const record=(await client.query<DbRow>(`SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
            JOIN association_membership_plans p ON p.workspace_id=m.workspace_id AND p.id=m.plan_id WHERE m.workspace_id=$1 AND m.id=$2`,
            [workspaceId,invitation.membership_id])).rows[0]
          await assertAssociationOrderAuthority(client,workspaceId,invitation.membership_id,actor,'membership')
          if(record)return {record,created:false}
        }
        if(invitation.status!=='pending'||invitation.expires_at.getTime()<=Date.now())throw new AssociationError('not_available','sponsorship invitation is expired or unavailable')
        const allocation=(await client.query<{status:string;starts_at:Date;ends_at:Date;beneficiary_plan_id:string;sponsor_membership_id:string}>(
          `SELECT status,starts_at,ends_at,beneficiary_plan_id,sponsor_membership_id FROM association_sponsorship_allocations
            WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,invitation.allocation_id])).rows[0]
        if(!allocation||allocation.status!=='active'||allocation.starts_at.getTime()>Date.now()||allocation.ends_at.getTime()<=Date.now())
          throw new AssociationError('not_available','sponsorship allocation is not currently active')
        const integration=await lockIntegrationActor(client,workspaceId,actor)
        authorizeIntegration(actor,'crm.entitlements.write',{planIds:allocation.beneficiary_plan_id},integration)
        const sponsor=(await client.query<{effective:boolean;sponsorship_allocation_id:string|null}>(`SELECT sponsorship_allocation_id,
          crm_entitlement_is_effective(status,starts_at,ends_at,statement_timestamp()) effective
          FROM association_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,allocation.sponsor_membership_id])).rows[0]
        if(!sponsor||sponsor.sponsorship_allocation_id||!sponsor.effective)throw new AssociationError('not_available','sponsor membership is no longer active')
        const duplicate=await client.query(`SELECT 1 FROM association_memberships m WHERE m.workspace_id=$1 AND m.contact_id=$2 AND m.plan_id=$3
          AND association_membership_is_effective(m.workspace_id,m.id,m.status,m.starts_at,m.ends_at,statement_timestamp())`,
          [workspaceId,input.contactId,allocation.beneficiary_plan_id])
        if(duplicate.rowCount)throw new AssociationError('conflict','member already has an effective entitlement for this plan')
        const current=await loadAssociationOrderScope(client,workspaceId,[input.contactId,...(inherited?.sources.map(source=>source.resourceId) ?? [])])
        let evidence={sources:current.sources,scope:deriveResourceScope({producer:'association.sponsorship-redemption',sources:current.sources},inherited?.scope ?? current.scope)}
        evidence = await admitAssociationSourceScope(client, workspaceId, actor, evidence)
        const membershipId=(await client.query<{id:string}>(`INSERT INTO association_memberships
          (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at,renewal_mode,sponsorship_allocation_id,scope_snapshot,scope_sources)
          VALUES($1,$2,$3,$4,$5,'active',statement_timestamp(),$6,'none',$7,$8::jsonb,$9::jsonb) RETURNING id`,
          [workspaceId,input.contactId,allocation.beneficiary_plan_id,`sponsorship:${invitation.id}`,
            associationFingerprint({invitationId:invitation.id,contactId:input.contactId,planId:allocation.beneficiary_plan_id}),
            allocation.ends_at,invitation.allocation_id,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])).rows[0]!.id
        await client.query(`UPDATE association_sponsorship_invitations SET status='redeemed',redeemed_contact_id=$3,membership_id=$4,
          redeemed_at=statement_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,invitation.id,input.contactId,membershipId])
        await audit(client,workspaceId,'sponsorship.invitation_redeemed','sponsorship_invitation',invitation.id,actor,
          {contactId:input.contactId,allocationId:invitation.allocation_id,membershipId})
        const record=(await client.query<DbRow>(`SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
          JOIN association_membership_plans p ON p.workspace_id=m.workspace_id AND p.id=m.plan_id WHERE m.workspace_id=$1 AND m.id=$2`,
          [workspaceId,membershipId])).rows[0]!
        await assertAssociationOrderAuthority(client,workspaceId,invitation.id,actor,'invitation')
        await assertAssociationOrderAuthority(client,workspaceId,membershipId,actor,'membership')
        return {record,created:true}
      })
    },

    async listMembershipRescues(workspaceId, input, actor) {
      return transact(async client => {
      const scope = actor ? await associationOrderReadPredicate(client, workspaceId, actor, 2, 'rescue') : { sql: 'TRUE', params: [] }
      const conditions = ['r.workspace_id=$1', `EXISTS(SELECT 1 FROM association_membership_offline_rescues WHERE association_membership_offline_rescues.workspace_id=r.workspace_id AND association_membership_offline_rescues.id=r.id AND ${scope.sql})`]
      const values: unknown[] = [workspaceId, ...scope.params]
      for (const [column, value] of [['r.contact_id', input.contactId], ['r.plan_id', input.planId], ['r.status', input.status]] as const) {
        if (value) { values.push(value); conditions.push(`${column}=$${values.length}`) }
      }
      const result = await page(client, workspaceId, 'association.membership_offline_rescues', input,
        `SELECT ${MEMBERSHIP_RESCUE_SELECT}
           FROM association_membership_offline_rescues r
           JOIN association_membership_plans p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id
           JOIN entities e ON e.workspace_id=r.workspace_id AND e.id=r.contact_id
           LEFT JOIN association_memberships m ON m.workspace_id=r.workspace_id AND m.id=r.membership_id
          WHERE ${conditions.join(' AND ')}`, values)
      if (actor) {
        const renewed = await associationOrderReadPredicate(client, workspaceId, actor, 2, 'rescue')
        if (JSON.stringify(renewed.params) !== JSON.stringify(scope.params)) throw new CrmOperationsError('not_authorized', 'Rescue access changed.')
      }
      return result
      })
    },

    async createMembershipRescue(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const userId = await requireFinanceActor(client, workspaceId, actor)
        const fingerprint = associationFingerprint(input)
        const existing = (await client.query<{ id: string; request_fingerprint: string }>(
          `SELECT id,request_fingerprint FROM association_membership_offline_rescues
            WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [workspaceId, input.idempotencyKey],
        )).rows[0]
        if (existing) {
          await assertAssociationOrderAuthority(client, workspaceId, existing.id, actor, 'rescue')
          if (existing.request_fingerprint !== fingerprint) throw new AssociationError('conflict', 'Offline rescue request identity was already used for different details.')
          return { record: (await getMembershipRescueRecord(client, workspaceId, existing.id))!, created: false }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const plan = (await client.query<{ fee_minor: string; currency: string; provider: string | null }>(
          `SELECT fee_minor::text,currency,provider FROM association_membership_plans
            WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [workspaceId, input.planId],
        )).rows[0]
        if (!plan) throw new AssociationError('not_found', 'membership plan not found')
        if (BigInt(plan.fee_minor) <= 0n) throw new AssociationError('conflict', 'Offline payment rescue requires a paid plan; use the complimentary grant workflow for a free plan.')
        if (plan.provider) throw new AssociationError('conflict', 'Provider-bound plans must use verified provider settlement and cannot use offline rescue.')
        let evidence = await loadAssociationOrderScope(client, workspaceId, [input.contactId])
        evidence = await admitAssociationSourceScope(client, workspaceId, actor, evidence)
        const inserted = (await client.query<{ id: string }>(
          `INSERT INTO association_membership_offline_rescues
             (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,amount_minor,currency,
              starts_at,ends_at,due_at,reason,created_by_user_id,scope_snapshot,scope_sources)
           VALUES($1,$2,$3,$4,$5,'outstanding',$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
           ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
          [workspaceId, input.contactId, input.planId, input.idempotencyKey, fingerprint, plan.fee_minor, plan.currency,
            input.startsAt, input.endsAt, input.dueAt, input.reason, userId, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)],
        )).rows[0]
        if (!inserted) {
          const raced = (await client.query<{ id: string; request_fingerprint: string }>(
            `SELECT id,request_fingerprint FROM association_membership_offline_rescues
              WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, input.idempotencyKey],
          )).rows[0]
          if (raced) await assertAssociationOrderAuthority(client, workspaceId, raced.id, actor, 'rescue')
          if (!raced || raced.request_fingerprint !== fingerprint) throw new AssociationError('conflict', 'Offline rescue request identity was used concurrently for different details.')
          return { record: (await getMembershipRescueRecord(client, workspaceId, raced.id))!, created: false }
        }
        await audit(client, workspaceId, 'membership_rescue.created', 'membership_rescue', inserted.id, actor,
          { contactId: input.contactId, planId: input.planId, amountMinor: plan.fee_minor, currency: plan.currency })
        await assertAssociationOrderAuthority(client, workspaceId, inserted.id, actor, 'rescue')
        return { record: (await getMembershipRescueRecord(client, workspaceId, inserted.id))!, created: true }
      })
    },

    async settleMembershipRescue(workspaceId, id, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const userId = await requireFinanceActor(client, workspaceId, actor)
        const fingerprint = crmOperationsSha256(input)
        const rescue = (await client.query<{
          contact_id: string; plan_id: string; status: string; amount_minor: string; currency: string;
          starts_at: Date; ends_at: Date; settlement_request_id: string | null; settlement_fingerprint: string | null;
        }>(`SELECT contact_id,plan_id,status,amount_minor::text,currency,starts_at,ends_at,
                    settlement_request_id,settlement_fingerprint
               FROM association_membership_offline_rescues WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, id])).rows[0]
        const inherited = await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'rescue')
        if (!rescue) throw new AssociationError('not_found', 'offline membership rescue not found')
        if (rescue.settlement_request_id === input.requestId) {
          if (rescue.settlement_fingerprint !== fingerprint) throw new AssociationError('conflict', 'Settlement request identity was already used for different evidence.')
          return { record: (await getMembershipRescueRecord(client, workspaceId, id))!, created: false }
        }
        if (rescue.settlement_request_id || rescue.status !== 'outstanding') throw new AssociationError('invalid_transition', 'Only an outstanding rescue can be settled.')
        if (rescue.amount_minor !== String(input.amountMinor) || rescue.currency !== input.currency) {
          throw new AssociationError('conflict', 'Settlement money must exactly match the amount and currency locked on the rescue case.')
        }
        const admissible = (await client.query<{ allowed: boolean }>(
          `SELECT $1::timestamptz<=clock_timestamp()+interval '5 minutes' allowed`, [input.occurredAt],
        )).rows[0]?.allowed
        if (!admissible) throw new AssociationError('conflict', 'Settlement evidence cannot be dated in the future.')
        const membershipInput: MembershipInput = {
          contactId: rescue.contact_id, planId: rescue.plan_id, idempotencyKey: `offline-rescue:${id}`,
          status: 'active', startsAt: rescue.starts_at.toISOString(), endsAt: rescue.ends_at.toISOString(), renewalMode: 'manual',
        }
        const membershipFingerprint = associationFingerprint(membershipInput)
        let evidence = inherited
          ? { scope: deriveResourceScope({ producer: 'association.rescue-settlement', sources: inherited.sources }, inherited.scope), sources: inherited.sources }
          : await loadAssociationOrderScope(client, workspaceId, [rescue.contact_id])
        evidence = await admitAssociationSourceScope(client, workspaceId, actor, evidence)
        let membershipId = (await client.query<{ id: string }>(
          `INSERT INTO association_memberships
             (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at,renewal_mode,scope_snapshot,scope_sources)
           VALUES($1,$2,$3,$4,$5,'active',$6,$7,'manual',$8::jsonb,$9::jsonb)
           ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
          [workspaceId, rescue.contact_id, rescue.plan_id, membershipInput.idempotencyKey, membershipFingerprint,
            rescue.starts_at, rescue.ends_at, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)],
        )).rows[0]?.id
        if (!membershipId) {
          const existing = (await client.query<{ id: string; request_fingerprint: string }>(
            `SELECT id,request_fingerprint FROM association_memberships WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
            [workspaceId, membershipInput.idempotencyKey],
          )).rows[0]
          if (existing) await assertAssociationOrderAuthority(client, workspaceId, existing.id, actor, 'membership')
          if (!existing || existing.request_fingerprint !== membershipFingerprint) throw new AssociationError('conflict', 'The rescue entitlement identity is already bound to different access.')
          membershipId = existing.id
        }
        await client.query(
          `UPDATE association_membership_offline_rescues SET status='settled',membership_id=$3,
             settlement_request_id=$4,settlement_fingerprint=$5,settlement_method=$6,settlement_reference=$7,
             settlement_occurred_at=$8,settlement_note=$9,settlement_by_user_id=$10
           WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, id, membershipId, input.requestId, fingerprint, input.method, input.evidenceReference,
            input.occurredAt, input.note ?? null, userId],
        )
        await audit(client, workspaceId, 'membership.created', 'membership', membershipId, actor,
          { contactId: rescue.contact_id, planId: rescue.plan_id, status: 'active', rescueId: id })
        await audit(client, workspaceId, 'membership_rescue.settled', 'membership_rescue', id, actor,
          { contactId: rescue.contact_id, planId: rescue.plan_id, membershipId, amountMinor: rescue.amount_minor, currency: rescue.currency, method: input.method })
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'rescue')
        return { record: (await getMembershipRescueRecord(client, workspaceId, id))!, created: true }
      })
    },

    async reverseMembershipRescue(workspaceId, id, input, actor) {
      return transact(async (client) => {
        const userId = await requireFinanceActor(client, workspaceId, actor)
        const fingerprint = crmOperationsSha256(input)
        const rescue = (await client.query<{
          contact_id: string; plan_id: string; status: string; amount_minor: string; currency: string; membership_id: string | null;
          settlement_occurred_at: Date | null; reversal_request_id: string | null; reversal_fingerprint: string | null;
        }>(`SELECT contact_id,plan_id,status,amount_minor::text,currency,membership_id,settlement_occurred_at,
                    reversal_request_id,reversal_fingerprint
               FROM association_membership_offline_rescues WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, id])).rows[0]
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'rescue')
        if (!rescue) throw new AssociationError('not_found', 'offline membership rescue not found')
        if (rescue.reversal_request_id === input.requestId) {
          if (rescue.reversal_fingerprint !== fingerprint) throw new AssociationError('conflict', 'Reversal request identity was already used for different evidence.')
          return { record: (await getMembershipRescueRecord(client, workspaceId, id))!, created: false }
        }
        if (rescue.reversal_request_id || rescue.status !== 'settled' || !rescue.membership_id || !rescue.settlement_occurred_at) {
          throw new AssociationError('invalid_transition', 'Only a settled rescue can be reversed.')
        }
        if (rescue.amount_minor !== String(input.amountMinor) || rescue.currency !== input.currency) {
          throw new AssociationError('conflict', 'Reversal money must exactly match the settled rescue.')
        }
        const admissible = (await client.query<{ allowed: boolean }>(
          `SELECT $1::timestamptz>=$2::timestamptz AND $1::timestamptz<=clock_timestamp()+interval '5 minutes' allowed`,
          [input.occurredAt, rescue.settlement_occurred_at],
        )).rows[0]?.allowed
        if (!admissible) {
          throw new AssociationError('conflict', 'Reversal evidence must follow settlement and cannot be dated in the future.')
        }
        const membership = (await client.query<{ status: string; provider: string | null }>(
          `SELECT status,provider FROM association_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, rescue.membership_id],
        )).rows[0]
        await assertAssociationOrderAuthority(client, workspaceId, rescue.membership_id, actor, 'membership')
        if (!membership || membership.provider) throw new AssociationError('conflict', 'The rescue entitlement no longer matches manual access.')
        const changed = await client.query(
          `UPDATE association_memberships SET status='cancelled' WHERE workspace_id=$1 AND id=$2 AND status IN('pending','active')`,
          [workspaceId, rescue.membership_id],
        )
        await client.query(
          `UPDATE association_membership_offline_rescues SET status='reversed',reversal_request_id=$3,
             reversal_fingerprint=$4,reversal_reference=$5,reversal_occurred_at=$6,reversal_reason=$7,reversed_by_user_id=$8
           WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, id, input.requestId, fingerprint, input.evidenceReference, input.occurredAt, input.reason, userId],
        )
        if (changed.rowCount) await audit(client, workspaceId, 'membership.updated', 'membership', rescue.membership_id, actor,
          { status: 'cancelled', rescueId: id, reason: 'offline_settlement_reversed' })
        await audit(client, workspaceId, 'membership_rescue.reversed', 'membership_rescue', id, actor,
          { contactId: rescue.contact_id, planId: rescue.plan_id, membershipId: rescue.membership_id, amountMinor: rescue.amount_minor, currency: rescue.currency })
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'rescue')
        return { record: (await getMembershipRescueRecord(client, workspaceId, id))!, created: true }
      })
    },

    async cancelMembershipRescue(workspaceId, id, input, actor) {
      return transact(async (client) => {
        const userId = await requireFinanceActor(client, workspaceId, actor)
        const fingerprint = crmOperationsSha256(input)
        const rescue = (await client.query<{
          contact_id: string; plan_id: string; status: string; cancellation_request_id: string | null; cancellation_fingerprint: string | null;
        }>(`SELECT contact_id,plan_id,status,cancellation_request_id,cancellation_fingerprint
               FROM association_membership_offline_rescues WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, id])).rows[0]
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'rescue')
        if (!rescue) throw new AssociationError('not_found', 'offline membership rescue not found')
        if (rescue.cancellation_request_id === input.requestId) {
          if (rescue.cancellation_fingerprint !== fingerprint) throw new AssociationError('conflict', 'Cancellation request identity was already used for a different reason.')
          return { record: (await getMembershipRescueRecord(client, workspaceId, id))!, created: false }
        }
        if (rescue.cancellation_request_id || rescue.status !== 'outstanding') throw new AssociationError('invalid_transition', 'Only an outstanding rescue can be cancelled.')
        await client.query(
          `UPDATE association_membership_offline_rescues SET status='cancelled',cancellation_request_id=$3,
             cancellation_fingerprint=$4,cancellation_reason=$5,cancelled_by_user_id=$6 WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, id, input.requestId, fingerprint, input.reason, userId],
        )
        await audit(client, workspaceId, 'membership_rescue.cancelled', 'membership_rescue', id, actor,
          { contactId: rescue.contact_id, planId: rescue.plan_id })
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'rescue')
        return { record: (await getMembershipRescueRecord(client, workspaceId, id))!, created: true }
      })
    },

    async upsertEvent(workspaceId, input, actor) {
      return transact(async (client) => {
        const saved = await saveCrmEventRecord(client, workspaceId, input, actor.credentialKind)
        await audit(client, workspaceId, saved.created ? 'event.created' : 'event.updated', 'event', String(saved.record.id), actor)
        return saved
      })
    },

    async listEvents(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.events', input,
        `SELECT ${EVENT_SELECT} FROM association_events WHERE ${conditions.join(' AND ')}`, values)
    },

    async upsertTicket(workspaceId, eventId, input, actor) {
      return transact(async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        requireAssociationAdmission(module)
        authorizeIntegration(actor, 'crm.catalog.configure', { eventIds: eventId }, integration)
        await lockAssociationInventory(client,workspaceId,{eventIds:[eventId]})
        const event = await client.query(
          `SELECT 1 FROM association_events WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, eventId],
        )
        if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
        if (input.eligiblePlanKeys.length > 0) {
          const plans = await client.query<{ id: string; plan_key: string }>(
            `SELECT id,plan_key FROM association_membership_plans
              WHERE workspace_id = $1 AND plan_key = ANY($2::text[])`,
            [workspaceId, input.eligiblePlanKeys],
          )
          const found = new Set(plans.rows.map((plan) => plan.plan_key))
          const missing = input.eligiblePlanKeys.filter((key) => !found.has(key))
          if (missing.length > 0) {
            throw new AssociationError('not_found', 'one or more eligible membership plan keys do not exist', { missing })
          }
          authorizeIntegration(actor, 'crm.catalog.configure', { planIds: plans.rows.map((plan) => plan.id) }, integration)
        }
        const before = await client.query<{ id: string }>(
          `SELECT id FROM association_ticket_types WHERE workspace_id = $1 AND event_id = $2 AND ticket_key = $3`,
          [workspaceId, eventId, input.key],
        )
        const result = await client.query<DbRow>(
          `INSERT INTO association_ticket_types
             (workspace_id, event_id, ticket_key, name, currency, price_minor,
              member_price_minor, eligible_plan_keys, eligibility_required, eligibility_scope, capacity, per_order_limit,
              sale_starts_at, sale_ends_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (event_id, ticket_key) DO UPDATE SET
             name = EXCLUDED.name, currency = EXCLUDED.currency,
             price_minor = EXCLUDED.price_minor,
             member_price_minor = EXCLUDED.member_price_minor,
             eligible_plan_keys = EXCLUDED.eligible_plan_keys,
             eligibility_required = EXCLUDED.eligibility_required,
             eligibility_scope = EXCLUDED.eligibility_scope,
             capacity = EXCLUDED.capacity, per_order_limit = EXCLUDED.per_order_limit,
             sale_starts_at = EXCLUDED.sale_starts_at,
             sale_ends_at = EXCLUDED.sale_ends_at, status = EXCLUDED.status
           RETURNING id`,
          [workspaceId, eventId, input.key, input.name, input.currency,
            input.priceMinor, input.memberPriceMinor ?? null, input.eligiblePlanKeys,
            input.eligibilityRequired, input.eligibilityScope, input.capacity ?? null, input.perOrderLimit,
            input.saleStartsAt ?? null, input.saleEndsAt ?? null, input.status],
        )
        const tickets = await client.query<DbRow>(
          `SELECT ${TICKET_SELECT}
             FROM association_ticket_types t
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS reserved_count FROM association_registrations r
                WHERE r.workspace_id = t.workspace_id AND r.ticket_id = t.id
                  AND NOT r.historical_import AND (r.status IN ('confirmed','checked_in','registered','attended')
                    OR (r.status = 'reserved' AND r.reservation_expires_at > statement_timestamp()))
             ) i ON true
            WHERE t.workspace_id = $1 AND t.id = $2`,
          [workspaceId, result.rows[0].id],
        )
        const created = before.rows.length === 0
        await refreshAssociationInventory(client,workspaceId,[eventId],actor.credentialKind)
        await audit(client, workspaceId, created ? 'ticket.created' : 'ticket.updated', 'ticket', String(result.rows[0].id), actor, { eventId })
        return { record: tickets.rows[0], created }
      })
    },

    async listTickets(workspaceId, eventId) {
      const result = await pool.query<DbRow>(
        `SELECT ${TICKET_SELECT}
           FROM association_ticket_types t
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS reserved_count FROM association_registrations r
              WHERE r.workspace_id = t.workspace_id AND r.ticket_id = t.id
                AND NOT r.historical_import AND (r.status IN ('confirmed','checked_in','registered','attended')
                  OR (r.status = 'reserved' AND r.reservation_expires_at > statement_timestamp()))
           ) i ON true
          WHERE t.workspace_id = $1 AND t.event_id = $2
          ORDER BY t.created_at, t.id`,
        [workspaceId, eventId],
      )
      return result.rows
    },

    async upsertPromotion(workspaceId, input, actor) {
      return transact(async (client) => {
        requireAssociationAdmission(await lockAssociationModule(client, workspaceId))
        if (actor.credentialKind !== 'user' || !actor.actingUserId) {
          throw new CrmOperationsError('not_authorized', 'A workspace owner or admin must manage promotions.')
        }
        const role = (await client.query<{ role: string }>(
          'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
          [workspaceId, actor.actingUserId],
        )).rows[0]?.role
        if (!['owner', 'admin'].includes(role ?? '')) {
          throw new CrmOperationsError('not_authorized', 'A workspace owner or admin must manage promotions.')
        }
        const targetIds = [...new Set(input.targetIds)].sort()
        if (targetIds.length !== input.targetIds.length) {
          throw new AssociationError('promotion_invalid', 'Promotion targets must be unique.')
        }
        const targetTable = input.targetKind === 'event' ? 'association_events'
          : input.targetKind === 'ticket' ? 'association_ticket_types' : 'association_membership_plans'
        const targets = await client.query<{ id: string }>(
          `SELECT id FROM ${targetTable} WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
          [workspaceId, targetIds],
        )
        if (targets.rows.length !== targetIds.length) {
          throw new AssociationError('not_found', 'One or more promotion targets were not found.')
        }
        if (input.targetKind === 'plan') {
          const plans = await client.query<{ id: string; billing_period: string; currency: string }>(
            `SELECT id,billing_period,currency FROM association_membership_plans
              WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [workspaceId, targetIds])
          if (plans.rows.some(plan => !['monthly', 'annual'].includes(plan.billing_period))) {
            throw new AssociationError('promotion_invalid', 'Plan promotions require a recurring monthly or annual plan.')
          }
          if (input.discountType === 'fixed_amount' && plans.rows.some(plan => plan.currency !== input.currency)) {
            throw new AssociationError('promotion_invalid', 'Fixed promotion currency must match every target plan.')
          }
        }
        const existing = (await client.query<{ id: string; code_digest: string; source_redeemed_uses: number; max_uses: number | null; max_uses_per_contact: number | null }>(
          'SELECT id,code_digest,source_redeemed_uses,max_uses,max_uses_per_contact FROM association_promotions WHERE workspace_id=$1 AND promotion_key=$2 FOR UPDATE',
          [workspaceId, input.key],
        )).rows[0]
        if (!existing && !input.code) {
          throw new AssociationError('promotion_invalid', 'A new promotion requires a code.')
        }
        const codeDigest = input.code ? promotionDigest(input.code, options.promotionHmacKey) : existing!.code_digest
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-promotion-code:'||$1::text||':'||$2,0))",
          [workspaceId, codeDigest],
        )
        const conflicting = (await client.query<{ id: string }>(
          'SELECT id FROM association_promotions WHERE workspace_id=$1 AND code_digest=$2 FOR UPDATE',
          [workspaceId, codeDigest],
        )).rows[0]
        if (conflicting && conflicting.id !== existing?.id) {
          throw new AssociationError('conflict', 'That promotion code is already assigned.')
        }
        if (existing && ((input.maxUses ?? null) !== existing.max_uses || (input.maxUsesPerContact ?? null) !== existing.max_uses_per_contact)) {
          const usageScope = await promotionUsageScope(client, workspaceId, actor, 3)
          const allowed = (await client.query<{ allowed: boolean }>(`SELECT ${usageScope.sql} AS allowed FROM association_promotions p WHERE p.workspace_id=$1 AND p.id=$2`, [workspaceId, existing.id, ...usageScope.params])).rows[0]?.allowed
          if (allowed !== true) throw new CrmOperationsError('not_authorized', 'Current usage authority is required to change promotion limits.')
        }
        if (existing && input.maxUses !== null && input.maxUses !== undefined) {
          const used = (await client.query<{ count: number }>(`SELECT count(*)::int count FROM association_promotion_uses
            WHERE workspace_id=$1 AND promotion_id=$2
              AND (state='redeemed' OR (state='reserved' AND reservation_expires_at>clock_timestamp()))`,
          [workspaceId, existing.id])).rows[0]?.count ?? 0
          if (used + existing.source_redeemed_uses > input.maxUses) {
            throw new AssociationError('promotion_invalid', 'Maximum uses cannot be below current reserved and redeemed uses.')
          }
        }
        if (existing && input.maxUsesPerContact !== null && input.maxUsesPerContact !== undefined) {
          const maximum = (await client.query<{ count: number }>(`SELECT COALESCE(max(total),0)::int count FROM (
            SELECT contact_id,sum(uses)::int total FROM (
              SELECT contact_id,count(*)::int uses FROM association_promotion_uses
                WHERE workspace_id=$1 AND promotion_id=$2 AND contact_id IS NOT NULL
                  AND (state='redeemed' OR (state='reserved' AND reservation_expires_at>clock_timestamp()))
                GROUP BY contact_id
              UNION ALL
              SELECT contact_id,uses FROM association_promotion_source_contact_uses
                WHERE workspace_id=$1 AND promotion_id=$2 AND contact_id IS NOT NULL
            ) combined GROUP BY contact_id
          ) totals`, [workspaceId, existing.id])).rows[0]?.count ?? 0
          if (maximum > input.maxUsesPerContact) {
            throw new AssociationError('promotion_invalid', 'Per-contact maximum cannot be below current source and live use.')
          }
        }
        const saved = (await client.query<{ id: string }>(`INSERT INTO association_promotions
          (workspace_id,promotion_key,name,code_digest,discount_type,percentage_basis_points,amount_minor,currency,buy_quantity,get_quantity,
           target_kind,target_ids,recurrence_mode,recurrence_cycles,apply_mode,valid_from,valid_to,max_uses,max_uses_per_contact,combines_with_member_price,
           release_on_full_refund,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
          ON CONFLICT(workspace_id,promotion_key) DO UPDATE SET
            name=EXCLUDED.name,code_digest=EXCLUDED.code_digest,discount_type=EXCLUDED.discount_type,
            percentage_basis_points=EXCLUDED.percentage_basis_points,amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,
            buy_quantity=EXCLUDED.buy_quantity,
            get_quantity=EXCLUDED.get_quantity,target_kind=EXCLUDED.target_kind,target_ids=EXCLUDED.target_ids,
            recurrence_mode=EXCLUDED.recurrence_mode,recurrence_cycles=EXCLUDED.recurrence_cycles,apply_mode=EXCLUDED.apply_mode,
            valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,max_uses=EXCLUDED.max_uses,
            max_uses_per_contact=EXCLUDED.max_uses_per_contact,
            combines_with_member_price=EXCLUDED.combines_with_member_price,
            release_on_full_refund=EXCLUDED.release_on_full_refund,status=EXCLUDED.status,updated_at=now()
          RETURNING id`, [workspaceId, input.key, input.name, codeDigest, input.discountType,
            input.percentageBasisPoints ?? null, input.amountMinor ?? null, input.currency ?? null,
            input.buyQuantity ?? null, input.getQuantity ?? null,
            input.targetKind, targetIds, input.recurrenceMode, input.recurrenceCycles ?? null, input.applyMode,
            input.validFrom ?? null, input.validTo ?? null,
            input.maxUses ?? null, input.maxUsesPerContact ?? null, input.combinesWithMemberPrice,
            input.releaseOnFullRefund, input.status])).rows[0]
        const usageScope = await promotionUsageScope(client, workspaceId, actor, 3)
        const record = (await client.query<DbRow>(`SELECT ${promotionProjection(usageScope.sql)} FROM association_promotions p
          LEFT JOIN LATERAL(SELECT
            count(*) FILTER(WHERE state='reserved' AND reservation_expires_at>statement_timestamp())::int reserved_uses,
            count(*) FILTER(WHERE state='redeemed')::int redeemed_uses
            FROM association_promotion_uses x WHERE x.workspace_id=p.workspace_id AND x.promotion_id=p.id) u ON true
          WHERE p.workspace_id=$1 AND p.id=$2`, [workspaceId, saved.id, ...usageScope.params])).rows[0]
        await audit(client, workspaceId, existing ? 'promotion.updated' : 'promotion.created', 'promotion', saved.id, actor,
          { key: input.key, targetKind: input.targetKind, targetCount: targetIds.length, codeChanged: Boolean(input.code) })
        return { record, created: !existing }
      })
    },

    async importPromotion(workspaceId, input, actor) {
      return transact(async (client) => {
        const reviewer = await requirePromotionImportActor(client, workspaceId, actor, input.importJobId)
        const { importJobId, importRow, ...evidence } = input
        const fingerprint = associationFingerprint(evidence)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-source-promotion:'||$1::text||':'||$2||':'||$3||':'||$4,0))",
          [workspaceId, input.source, input.sourceSite, input.sourcePromotionId],
        )
        const existing = (await client.query<{ id: string; fingerprint: string }>(
          `SELECT id,source_import->>'fingerprint' fingerprint FROM association_promotions
            WHERE workspace_id=$1 AND source_system=$2 AND source_site=$3
              AND source_promotion_id=$4 FOR UPDATE`,
          [workspaceId, input.source, input.sourceSite, input.sourcePromotionId],
        )).rows[0]
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'Source promotion identity was already used with different evidence.')
          }
          const usageScope = await promotionUsageScope(client, workspaceId, actor, 3)
          const record = (await client.query<DbRow>(`SELECT ${promotionProjection(usageScope.sql)}
            FROM association_promotions p LEFT JOIN LATERAL(SELECT
              count(*) FILTER(WHERE state='reserved' AND reservation_expires_at>statement_timestamp())::int reserved_uses,
              count(*) FILTER(WHERE state='redeemed')::int redeemed_uses
              FROM association_promotion_uses x WHERE x.workspace_id=p.workspace_id AND x.promotion_id=p.id) u ON true
            WHERE p.workspace_id=$1 AND p.id=$2`, [workspaceId, existing.id, ...usageScope.params])).rows[0]
          return { record, created: false }
        }

        requireAssociationAdmission(await lockAssociationModule(client, workspaceId))
        const promotion = input.promotion
        const targetIds = [...new Set(promotion.targetIds)].sort()
        if (targetIds.length !== promotion.targetIds.length) {
          throw new AssociationError('promotion_invalid', 'Promotion targets must be unique.')
        }
        const targetTable = promotion.targetKind === 'event' ? 'association_events'
          : promotion.targetKind === 'ticket' ? 'association_ticket_types' : 'association_membership_plans'
        const targets = await client.query<{ id: string }>(
          `SELECT id FROM ${targetTable} WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
          [workspaceId, targetIds],
        )
        if (targets.rows.length !== targetIds.length) {
          throw new AssociationError('not_found', 'One or more promotion targets were not found.')
        }
        if (promotion.targetKind === 'plan') {
          const plans = await client.query<{ id: string; billing_period: string; currency: string }>(
            `SELECT id,billing_period,currency FROM association_membership_plans
              WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [workspaceId, targetIds])
          if (plans.rows.some(plan => !['monthly', 'annual'].includes(plan.billing_period))) {
            throw new AssociationError('promotion_invalid', 'Plan promotions require a recurring monthly or annual plan.')
          }
          if (promotion.discountType === 'fixed_amount' && plans.rows.some(plan => plan.currency !== promotion.currency)) {
            throw new AssociationError('promotion_invalid', 'Fixed promotion currency must match every target plan.')
          }
        }
        const contactIds = input.sourceContactUses.map((entry) => entry.contactId)
        if (contactIds.length > 0) {
          const contacts = await client.query<{ id: string }>(
            `SELECT id FROM entities WHERE workspace_id=$1 AND kind='person' AND id=ANY($2::uuid[])
              AND valid_to IS NULL AND retracted_at IS NULL ORDER BY id FOR SHARE`,
            [workspaceId, contactIds],
          )
          if (contacts.rows.length !== contactIds.length) {
            throw new AssociationError('not_found', 'One or more source promotion contacts were not found.')
          }
        }
        const contactEvidence = contactIds.length ? await loadAssociationOrderScope(client, workspaceId, contactIds) : null
        if (contactEvidence) await assertAssociationSourceAuthority(client, workspaceId, actor, contactEvidence)
        const attributedUses = input.sourceContactUses.reduce((sum, entry) => sum + entry.uses, 0)
        const usageEvidence = contactEvidence && attributedUses === input.sourceRedeemedUses
          ? await admitAssociationSourceScope(client, workspaceId, actor, contactEvidence) : null
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-promotion-code:'||$1::text||':'||$2,0))",
          [workspaceId, input.codeDigest],
        )
        const conflict = await client.query(
          `SELECT 1 FROM association_promotions WHERE workspace_id=$1
            AND (promotion_key=$2 OR code_digest=$3) FOR UPDATE`,
          [workspaceId, promotion.key, input.codeDigest],
        )
        if (conflict.rowCount) {
          throw new AssociationError('conflict', 'The promotion key or code digest is already assigned.')
        }
        const saved = (await client.query<{ id: string }>(`INSERT INTO association_promotions
          (workspace_id,promotion_key,name,code_digest,discount_type,percentage_basis_points,amount_minor,currency,buy_quantity,get_quantity,
           target_kind,target_ids,recurrence_mode,recurrence_cycles,apply_mode,valid_from,valid_to,max_uses,max_uses_per_contact,combines_with_member_price,
           release_on_full_refund,status,source_system,source_site,source_promotion_id,source_redeemed_uses,source_import,scope_snapshot,scope_sources)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb)
          RETURNING id`, [workspaceId, promotion.key, promotion.name, input.codeDigest, promotion.discountType,
            promotion.percentageBasisPoints ?? null, promotion.amountMinor ?? null, promotion.currency ?? null,
            promotion.buyQuantity ?? null, promotion.getQuantity ?? null,
            promotion.targetKind, targetIds, promotion.recurrenceMode, promotion.recurrenceCycles ?? null, promotion.applyMode,
            promotion.validFrom ?? null, promotion.validTo ?? null,
            promotion.maxUses ?? null, promotion.maxUsesPerContact ?? null, promotion.combinesWithMemberPrice,
            promotion.releaseOnFullRefund, promotion.status, input.source, input.sourceSite,
            input.sourcePromotionId, input.sourceRedeemedUses, { jobId: importJobId, row: importRow, fingerprint },
            usageEvidence ? JSON.stringify(usageEvidence.scope) : null, usageEvidence ? JSON.stringify(usageEvidence.sources) : null])).rows[0]
        if (input.sourceContactUses.length > 0) {
          await client.query(`INSERT INTO association_promotion_source_contact_uses
            (workspace_id,promotion_id,contact_id,uses)
            SELECT $1,$2,entry.contact_id,entry.uses
              FROM unnest($3::uuid[],$4::integer[]) AS entry(contact_id,uses)`,
          [workspaceId, saved.id, contactIds, input.sourceContactUses.map((entry) => entry.uses)])
        }
        const usageScope = await promotionUsageScope(client, workspaceId, actor, 3)
        const record = (await client.query<DbRow>(`SELECT ${promotionProjection(usageScope.sql)}
          FROM association_promotions p LEFT JOIN LATERAL(SELECT
            count(*) FILTER(WHERE state='reserved' AND reservation_expires_at>statement_timestamp())::int reserved_uses,
            count(*) FILTER(WHERE state='redeemed')::int redeemed_uses
            FROM association_promotion_uses x WHERE x.workspace_id=p.workspace_id AND x.promotion_id=p.id) u ON true
          WHERE p.workspace_id=$1 AND p.id=$2`, [workspaceId, saved.id, ...usageScope.params])).rows[0]
        await audit(client, workspaceId, 'promotion.source_imported', 'promotion', saved.id, actor, {
          source: input.source, sourceSite: input.sourceSite, sourcePromotionId: input.sourcePromotionId,
          sourceRedeemedUses: input.sourceRedeemedUses, attributedContacts: contactIds.length,
          importJobId, importRow, reviewedByUserId: reviewer,
        })
        return { record, created: true }
      })
    },

    async listPromotions(workspaceId, input, actor) {
      return transact(async client => {
      const usageScope = await promotionUsageScope(client, workspaceId, actor, 2)
      const conditions = ['p.workspace_id=$1']
      const values: unknown[] = [workspaceId, ...usageScope.params]
      if (input.status) { values.push(input.status); conditions.push(`p.status=$${values.length}`) }
      return page(client, workspaceId, 'association.promotions', input, `SELECT ${promotionProjection(usageScope.sql)}
        FROM association_promotions p LEFT JOIN LATERAL(SELECT
          count(*) FILTER(WHERE state='reserved' AND reservation_expires_at>statement_timestamp())::int reserved_uses,
          count(*) FILTER(WHERE state='redeemed')::int redeemed_uses
          FROM association_promotion_uses x WHERE x.workspace_id=p.workspace_id AND x.promotion_id=p.id) u ON true
        WHERE ${conditions.join(' AND ')}`, values)
      })
    },

    async reserveMembershipCheckout(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        const codeDigest = promotionDigest(input.promotionCode, options.promotionHmacKey)
        const { promotionCode: _promotionCode, ...fingerprintInput } = input
        const fingerprint = associationFingerprint({ ...fingerprintInput, promotionCodeDigest: codeDigest })
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-membership-checkout:'||$1::text||':'||$2,0))",
          [workspaceId, input.idempotencyKey],
        )
        const existing = (await client.query<{ id: string; plan_id: string; request_fingerprint: string }>(
          `SELECT id,plan_id,request_fingerprint FROM association_membership_checkouts
            WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [workspaceId, input.idempotencyKey],
        )).rows[0]
        if (existing) {
          await assertAssociationOrderAuthority(client, workspaceId, existing.id, actor, 'checkout')
          authorizeIntegration(actor, 'crm.entitlements.write', { planIds: existing.plan_id }, integration)
          if (existing.request_fingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'Idempotency key was already used for a different membership checkout.')
          }
          return { record: (await getMembershipCheckoutRecord(client, workspaceId, existing.id))!, created: false }
        }
        requireAssociationAdmission(module)
        await requirePerson(client, workspaceId, input.contactId)
        const scopeEvidence = await admitAssociationSourceScope(client, workspaceId, actor,
          await loadAssociationOrderScope(client, workspaceId, [input.contactId]))
        const admittedAt = (await client.query<{ instant: string }>('SELECT clock_timestamp()::text instant')).rows[0].instant
        const plan = (await client.query<{
          id: string; plan_key: string; name: string; currency: string; fee_minor: string;
          billing_period: 'monthly' | 'annual'; provider: string | null; provider_plan_id: string | null;
        }>(`SELECT id,plan_key,name,currency,fee_minor::text,billing_period,provider,provider_plan_id
          FROM association_membership_plans WHERE workspace_id=$1 AND id=$2 AND published
            AND billing_period IN('monthly','annual') AND ((provider IS NOT NULL AND provider_plan_id IS NOT NULL)
              OR EXISTS (SELECT 1 FROM association_membership_catalogues c
                JOIN association_membership_catalogue_revisions r ON r.workspace_id=c.workspace_id AND r.revision=c.published_revision
                WHERE c.workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.document->'plans') p WHERE p->>'planId'=$2::text)))
            AND (active_from IS NULL OR active_from<=$3::timestamptz)
            AND (active_to IS NULL OR active_to>$3::timestamptz) FOR SHARE`,
        [workspaceId, input.planId, admittedAt])).rows[0]
        if (!plan) throw new AssociationError('not_available', 'Membership plan is not available for provider checkout.')
        authorizeIntegration(actor, 'crm.entitlements.write', { planIds: plan.id }, integration)

        const promotion = (await client.query<{
          id: string; promotion_key: string; name: string;
          discount_type: 'percentage' | 'fixed_amount' | 'full';
          percentage_basis_points: number | null; amount_minor: string | null; currency: string | null;
          target_kind: 'event' | 'ticket' | 'plan'; target_ids: string[];
          recurrence_mode: 'once' | 'forever' | 'repeating'; recurrence_cycles: number | null;
          apply_mode: 'once_per_order' | 'each_eligible_item'; valid_from: Date | null; valid_to: Date | null;
          max_uses: number | null; max_uses_per_contact: number | null; source_redeemed_uses: number;
          release_on_full_refund: boolean; status: string;
        }>(`SELECT id,promotion_key,name,discount_type,percentage_basis_points,amount_minor::text,currency,
            target_kind,target_ids,recurrence_mode,recurrence_cycles,apply_mode,valid_from,valid_to,max_uses,
            max_uses_per_contact,source_redeemed_uses,release_on_full_refund,status
          FROM association_promotions WHERE workspace_id=$1 AND code_digest=$2 FOR UPDATE`,
        [workspaceId, codeDigest])).rows[0]
        if (!promotion || promotion.status !== 'active'
          || (promotion.valid_from && promotion.valid_from.getTime() > Date.parse(admittedAt))
          || (promotion.valid_to && promotion.valid_to.getTime() <= Date.parse(admittedAt))) {
          throw new AssociationError('promotion_invalid', 'Promotion code is invalid or unavailable.')
        }
        if (promotion.target_kind !== 'plan' || !promotion.target_ids.includes(plan.id)
          || (promotion.discount_type === 'fixed_amount' && promotion.currency !== plan.currency)) {
          throw new AssociationError('promotion_not_applicable', 'Promotion code does not apply to this membership plan.')
        }

        await client.query(`UPDATE association_promotion_uses u SET state='released',reservation_expires_at=NULL,
            released_reason='expired',updated_at=clock_timestamp()
          FROM association_membership_checkouts c
          WHERE u.workspace_id=$1 AND u.promotion_id=$2 AND u.membership_checkout_id=c.id
            AND c.workspace_id=u.workspace_id AND u.state='reserved' AND c.status IN('reserved','provider_bound')
            AND c.reservation_expires_at<=$3::timestamptz`, [workspaceId, promotion.id, admittedAt])
        await client.query(`UPDATE association_membership_checkouts SET status='expired',updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND promotion_id=$2 AND status IN('reserved','provider_bound')
            AND reservation_expires_at<=$3::timestamptz`, [workspaceId, promotion.id, admittedAt])
        const counts = (await client.query<{ all_uses: number; contact_uses: number; source_contact_uses: number }>(`SELECT
            count(*) FILTER(WHERE state='redeemed' OR (state='reserved' AND reservation_expires_at>$3::timestamptz))::int all_uses,
            count(*) FILTER(WHERE contact_id=$4 AND (state='redeemed' OR (state='reserved' AND reservation_expires_at>$3::timestamptz)))::int contact_uses,
            COALESCE((SELECT uses FROM association_promotion_source_contact_uses
              WHERE workspace_id=$1 AND promotion_id=$2 AND contact_id=$4),0)::int source_contact_uses
          FROM association_promotion_uses WHERE workspace_id=$1 AND promotion_id=$2`,
        [workspaceId, promotion.id, admittedAt, input.contactId])).rows[0]
        if ((promotion.max_uses !== null && counts.all_uses + promotion.source_redeemed_uses >= promotion.max_uses)
          || (promotion.max_uses_per_contact !== null
            && counts.contact_uses + counts.source_contact_uses >= promotion.max_uses_per_contact)) {
          throw new AssociationError('promotion_exhausted', 'Promotion code has reached its usage limit.')
        }

        const subtotal = Number(plan.fee_minor)
        if (!Number.isSafeInteger(subtotal) || subtotal <= 0) {
          throw new AssociationError('conflict', 'Membership plan money exceeds the supported exact positive integer range.')
        }
        const discount = promotion.discount_type === 'full' ? subtotal
          : promotion.discount_type === 'percentage'
            ? Math.floor(subtotal * promotion.percentage_basis_points! / 10_000)
            : Math.min(subtotal, Number(promotion.amount_minor))
        if (!Number.isSafeInteger(discount) || discount <= 0) {
          throw new AssociationError('promotion_not_applicable', 'Promotion amount does not produce a discount.')
        }
        const total = subtotal - discount
        const reservationExpiresAt = (await client.query<{ deadline: string }>(
          "SELECT ($1::timestamptz+$2::integer*interval '1 minute')::text deadline",
          [admittedAt, input.reservationMinutes],
        )).rows[0].deadline
        const durationMonths = promotion.recurrence_mode === 'repeating'
          ? promotion.recurrence_cycles! * (plan.billing_period === 'annual' ? 12 : 1) : null
        const promotionSnapshot = {
          promotionId: promotion.id, key: promotion.promotion_key, name: promotion.name,
          discountType: promotion.discount_type, percentageBasisPoints: promotion.percentage_basis_points,
          amountMinor: promotion.amount_minor, currency: promotion.currency,
          targetKind: 'plan', targetIds: promotion.target_ids,
          recurrenceMode: promotion.recurrence_mode, recurrenceCycles: promotion.recurrence_cycles,
          durationMonths, applyMode: promotion.apply_mode,
          releaseOnFullRefund: promotion.release_on_full_refund,
          validTo: promotion.valid_to?.toISOString() ?? null, discountMinor: discount,
        }
        await assertAssociationSourceAuthority(client, workspaceId, actor, scopeEvidence)
        const checkout = (await client.query<{ id: string }>(`INSERT INTO association_membership_checkouts
          (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,currency,
           subtotal_minor,discount_minor,total_minor,promotion_id,promotion_snapshot,reservation_expires_at,scope_snapshot,scope_sources)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb) RETURNING id`,
        [workspaceId, input.contactId, plan.id, input.idempotencyKey, fingerprint, plan.currency,
          subtotal, discount, total, promotion.id, promotionSnapshot, reservationExpiresAt, JSON.stringify(scopeEvidence.scope), JSON.stringify(scopeEvidence.sources)])).rows[0]
        await client.query(`INSERT INTO association_promotion_uses
          (workspace_id,promotion_id,membership_checkout_id,contact_id,state,reservation_expires_at)
          VALUES($1,$2,$3,$4,'reserved',$5)`,
        [workspaceId, promotion.id, checkout.id, input.contactId, reservationExpiresAt])
        await audit(client, workspaceId, 'membership_checkout.reserved', 'membership_checkout', checkout.id, actor, {
          contactId: input.contactId, planId: plan.id, promotionId: promotion.id,
          totalMinor: total, currency: plan.currency,
        })
        await assertAssociationOrderAuthority(client, workspaceId, checkout.id, actor, 'checkout')
        return { record: (await getMembershipCheckoutRecord(client, workspaceId, checkout.id))!, created: true }
      })
    },

    async bindMembershipCheckoutProvider(workspaceId, checkoutId, raw, actor) {
      const input = AssociationMembershipCheckoutProviderBindingSchema.parse(raw)
      requireAssociationProviderActor(actor)
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-provider-object:'||$1::text||':'||$2||':'||$3,0))",
          [workspaceId, input.provider, input.providerReference],
        )
        const checkout = (await client.query<{
          plan_id: string; status: string; provider: string | null; provider_reference: string | null;
          provider_coupon_reference: string | null; currency: string; total_minor: string; unexpired: boolean;
        }>(`SELECT plan_id,status,provider,provider_reference,provider_coupon_reference,currency,total_minor::text,
            reservation_expires_at>clock_timestamp() unexpired
          FROM association_membership_checkouts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, checkoutId])).rows[0]
        if (!checkout) throw new AssociationError('not_found', 'Membership checkout was not found.')
        await assertAssociationOrderAuthority(client, workspaceId, checkoutId, actor, 'checkout')
        authorizeIntegration(actor, 'crm.entitlements.write', { planIds: checkout.plan_id }, integration)
        authorizeIntegration(actor, 'association.provider_events.write', { providerKeys: input.provider }, integration)
        if (checkout.provider_reference) {
          if (checkout.provider !== input.provider || checkout.provider_reference !== input.providerReference
            || checkout.provider_coupon_reference !== input.providerCouponReference
            || checkout.total_minor !== String(input.amountMinor) || checkout.currency !== input.currency) {
            throw new AssociationError('conflict', 'Provider evidence does not match the bound membership checkout.')
          }
          await assertAssociationOrderAuthority(client, workspaceId, checkoutId, actor, 'checkout')
          return { record: (await getMembershipCheckoutRecord(client, workspaceId, checkoutId))!, created: false }
        }
        requireAssociationAdmission(module)
        if (checkout.status !== 'reserved' || !checkout.unexpired) {
          throw new AssociationError('not_available', 'A provider binding requires an unexpired membership checkout reservation.')
        }
        if (checkout.total_minor !== String(input.amountMinor) || checkout.currency !== input.currency) {
          throw new AssociationError('conflict', 'Provider amount and currency must match the Brian membership checkout.')
        }
        const duplicate = await client.query(`SELECT id FROM association_membership_checkouts
          WHERE workspace_id=$1 AND provider=$2 AND provider_reference=$3
          UNION ALL SELECT id FROM association_orders
          WHERE workspace_id=$1 AND provider=$2 AND provider_reference=$3 LIMIT 1`,
        [workspaceId, input.provider, input.providerReference])
        if (duplicate.rowCount) throw new AssociationError('conflict', 'The provider object is already bound to another checkout.')
        await client.query(`UPDATE association_membership_checkouts SET status='provider_bound',provider=$3,
            provider_reference=$4,provider_coupon_reference=$5,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, checkoutId, input.provider, input.providerReference, input.providerCouponReference])
        await audit(client, workspaceId, 'membership_checkout.provider_bound', 'membership_checkout', checkoutId, actor, {
          planId: checkout.plan_id, provider: input.provider,
        })
        await assertAssociationOrderAuthority(client, workspaceId, checkoutId, actor, 'checkout')
        return { record: (await getMembershipCheckoutRecord(client, workspaceId, checkoutId))!, created: true }
      })
    },

    listWaitlist: (workspaceId, input, actor) => listAssociationWaitlist(pool, workspaceId, input, actor),
    offerWaitlistPlace: (workspaceId, input, actor) => transact(async client => {
      await beginAssociationCreation(client, workspaceId)
      return offerAssociationWaitlist(client, workspaceId, input, actor,
        order => createAssociationStore(pool, client, options).createOrder(workspaceId, order, actor),
        id => getOrderRecord(client, workspaceId, id))
    }),

    async importSourceOrder(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const reviewer = await requireSourceOrderImportActor(client, workspaceId, actor)
        const { importJobId, importRow, ...evidence } = input
        const fingerprint = associationFingerprint(evidence)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('association-source-order:'||$1::text||':'||$2||':'||$3||':'||$4,0))",
          [workspaceId, input.source, input.sourceSite, input.sourceOrderId],
        )
        const existing = (await client.query<{ id: string; request_fingerprint: string }>(
          `SELECT id,request_fingerprint FROM association_orders
            WHERE workspace_id=$1 AND source_system=$2 AND source_site=$3
              AND source_order_id=$4 FOR UPDATE`,
          [workspaceId, input.source, input.sourceSite, input.sourceOrderId],
        )).rows[0]
        if (existing) {
          await assertAssociationOrderAuthority(client, workspaceId, existing.id, actor)
          if (existing.request_fingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'Source order identity was already used with different evidence.')
          }
          return { record: (await getOrderRecord(client, workspaceId, existing.id))!, created: false }
        }

        const module = await lockAssociationModule(client, workspaceId)
        requireAssociationAdmission(module)
        await requirePerson(client, workspaceId, input.contactId)
        let sourceEvidence = await loadAssociationOrderScope(client, workspaceId, [input.contactId,
          ...input.lines.flatMap(line => line.attendees.flatMap(attendee => attendee.contactId ? [attendee.contactId] : []))])
        sourceEvidence = await admitAssociationSourceScope(client, workspaceId, actor, sourceEvidence)
        const timing = (await client.query<{ admitted_at: string; occurred_valid: boolean; expiry_valid: boolean; check_ins_valid: boolean }>(
          `SELECT clock_timestamp()::text admitted_at,
             $1::timestamptz<=clock_timestamp() occurred_valid,
             ($2::timestamptz IS NULL OR $2::timestamptz>clock_timestamp()) expiry_valid,
             NOT EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb) line,
               jsonb_array_elements(line->'attendees') attendee
               WHERE attendee ? 'checkedInAt' AND (attendee->>'checkedInAt')::timestamptz>clock_timestamp()) check_ins_valid`,
          [input.occurredAt, input.reservationExpiresAt ?? null, JSON.stringify(input.lines)],
        )).rows[0]
        if (!timing.occurred_valid || !timing.check_ins_valid) {
          throw new AssociationError('conflict', 'Source order evidence cannot be dated in the future.')
        }
        if (input.status === 'pending' && !timing.expiry_valid) {
          throw new AssociationError('not_available', 'Expired source reservations must be archived or reconciled before import.')
        }

        if (input.provider && input.providerReference) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('association-provider-object:'||$1::text||':'||$2||':'||$3,0))",
            [workspaceId, input.provider, input.providerReference],
          )
          const providerOrder = await client.query(
            `SELECT 1 FROM association_orders WHERE workspace_id=$1 AND provider=$2 AND provider_reference=$3`,
            [workspaceId, input.provider, input.providerReference],
          )
          if (providerOrder.rowCount) throw new AssociationError('conflict', 'The source provider object is already bound to another order.')
        }

        const ticketIds = input.lines.map((line) => line.ticketId)
        const inventoryEvents = await lockAssociationInventory(client, workspaceId, { ticketIds })
        const ticketsResult = await client.query<{
          id: string; event_id: string; currency: string; capacity: number | null;
          event_capacity: number | null; event_status: string; event_ended: boolean;
        }>(
          `SELECT t.id,t.event_id,t.currency,t.capacity,e.capacity event_capacity,
             e.status event_status,e.ends_at<=$3::timestamptz event_ended
           FROM association_ticket_types t JOIN association_events e
             ON e.workspace_id=t.workspace_id AND e.id=t.event_id
           WHERE t.workspace_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.id`,
          [workspaceId, ticketIds, timing.admitted_at],
        )
        if (ticketsResult.rows.length !== ticketIds.length) {
          throw new AssociationError('not_found', 'one or more source order ticket types were not found')
        }
        const tickets = new Map(ticketsResult.rows.map((ticket) => [ticket.id, ticket]))
        if (ticketsResult.rows.some((ticket) => ticket.currency !== input.currency)) {
          throw new AssociationError('conflict', 'Source order currency must match every mapped ticket.')
        }

        const occupiedStatus = (status: string) => status === 'reserved' || status === 'confirmed' || status === 'checked_in'
        const requestedByTicket = new Map<string, number>()
        const requestedByEvent = new Map<string, number>()
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          const occupied = ticket.event_ended ? 0 : line.attendees.filter((attendee) => occupiedStatus(attendee.status)).length
          if (occupied && ticket.event_status !== 'published') {
            throw new AssociationError('not_available', 'An active source booking requires a published event.', { eventId: ticket.event_id })
          }
          requestedByTicket.set(ticket.id, occupied)
          requestedByEvent.set(ticket.event_id, (requestedByEvent.get(ticket.event_id) ?? 0) + occupied)
        }
        const inventory = await client.query<{ ticket_id: string; event_id: string; used: number }>(
          `SELECT ticket_id,event_id,count(*)::int used FROM association_registrations
           WHERE workspace_id=$1 AND NOT historical_import
             AND (status IN('confirmed','checked_in','registered','attended')
               OR (status='reserved' AND reservation_expires_at>$4::timestamptz))
             AND (ticket_id=ANY($2::uuid[]) OR event_id=ANY($3::uuid[]))
           GROUP BY ticket_id,event_id`,
          [workspaceId, ticketIds, inventoryEvents, timing.admitted_at],
        )
        const ticketUsed = new Map<string, number>()
        const eventUsed = new Map<string, number>()
        for (const row of inventory.rows) {
          ticketUsed.set(row.ticket_id, (ticketUsed.get(row.ticket_id) ?? 0) + row.used)
          eventUsed.set(row.event_id, (eventUsed.get(row.event_id) ?? 0) + row.used)
        }
        for (const ticket of ticketsResult.rows) {
          if (ticket.capacity !== null
            && (ticketUsed.get(ticket.id) ?? 0) + (requestedByTicket.get(ticket.id) ?? 0) > ticket.capacity) {
            throw new AssociationError('not_available', 'Source order exceeds current ticket capacity.', { ticketId: ticket.id })
          }
          if (ticket.event_capacity !== null
            && (eventUsed.get(ticket.event_id) ?? 0) + (requestedByEvent.get(ticket.event_id) ?? 0) > ticket.event_capacity) {
            throw new AssociationError('not_available', 'Source order exceeds current event capacity.', { eventId: ticket.event_id })
          }
        }

        const refundState = input.refundedMinor === input.totalMinor && input.status === 'refunded'
          ? 'full' : input.refundedMinor > 0 ? 'partial' : 'none'
        await assertAssociationSourceAuthority(client, workspaceId, actor, sourceEvidence)
        const order = (await client.query<{ id: string }>(
          `INSERT INTO association_orders(
             workspace_id,contact_id,idempotency_key,request_fingerprint,status,currency,
             subtotal_minor,discount_minor,total_minor,refunded_minor,refund_state,dispute_state,
             reservation_expires_at,provider,provider_reference,metadata,
             source_system,source_site,source_order_id,source_occurred_at,source_order_status,source_import,
             created_at,updated_at,scope_snapshot,scope_sources)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'none',$12,$13,$14,$15,$16,$17,$18,$19,$20,true,$19,$19,$21,$22)
           RETURNING id`,
          [workspaceId, input.contactId, `source-order:${fingerprint}`, fingerprint,
            input.status, input.currency, input.subtotalMinor, input.discountMinor,
            input.totalMinor, input.refundedMinor, refundState,
            input.reservationExpiresAt ?? null, input.provider ?? null, input.providerReference ?? null,
            { ...input.metadata, historicalSource: { source: input.source, site: input.sourceSite, orderId: input.sourceOrderId } },
            input.source, input.sourceSite, input.sourceOrderId, input.occurredAt, input.status, JSON.stringify(sourceEvidence.scope), JSON.stringify(sourceEvidence.sources)],
        )).rows[0]
        await client.query("SELECT set_config('app.association_source_order_actor',$1,true)", [reviewer])
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          const lineId = (await client.query<{ id: string }>(
            `INSERT INTO association_order_lines(
               workspace_id,order_id,ticket_id,quantity,unit_price_minor,discount_minor,
               source_discount_minor,line_total_minor,pricing_basis,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$6,$7,'source',$8) RETURNING id`,
            [workspaceId, order.id, line.ticketId, line.quantity, line.unitPriceMinor,
              line.discountMinor, line.lineTotalMinor, input.occurredAt],
          )).rows[0].id
          for (const attendee of line.attendees) {
            if (attendee.contactId) await requirePerson(client, workspaceId, attendee.contactId)
            const sourceId = associationFingerprint({
              source: input.source, sourceSite: input.sourceSite,
              sourceOrderId: input.sourceOrderId, sourceRegistrationId: attendee.sourceRegistrationId,
            })
            const registrationFingerprint = associationFingerprint({
              sourceOrder: fingerprint, ticketId: line.ticketId, attendee,
            })
            await client.query(
              `INSERT INTO association_registrations(
                 workspace_id,order_id,order_line_id,event_id,ticket_id,attendee_contact_id,
                 attendee_name,attendee_email,attendee_metadata,status,reservation_expires_at,
                 checked_in_at,source_kind,source_id,request_fingerprint,historical_import,
                 created_at,updated_at,scope_snapshot,scope_sources)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'source_order',$13,$14,$15,$16,$16,$17,$18)`,
              [workspaceId, order.id, lineId, ticket.event_id, line.ticketId,
                attendee.contactId ?? null, attendee.name, attendee.email ?? null,
                { ...attendee.metadata, historicalSource: {
                  source: input.source, site: input.sourceSite, orderId: input.sourceOrderId,
                  registrationId: attendee.sourceRegistrationId,
                } }, attendee.status,
                attendee.status === 'reserved' ? input.reservationExpiresAt ?? null : null,
                attendee.checkedInAt ?? null, sourceId, registrationFingerprint,
                ticket.event_ended, input.occurredAt, JSON.stringify(sourceEvidence.scope), JSON.stringify(sourceEvidence.sources)],
            )
          }
        }
        await refreshAssociationInventory(client, workspaceId, inventoryEvents, actor.credentialKind, { emitEvents: false })
        await audit(client, workspaceId, 'order.source_imported', 'order', order.id, actor, {
          source: input.source, sourceSite: input.sourceSite, sourceOrderId: input.sourceOrderId,
          sourceStatus: input.status, importJobId, importRow,
        })
        return { record: (await getOrderRecord(client, workspaceId, order.id))!, created: true }
      })
    },

    previewOrderDestinations: (workspaceId, contactIds, actor) => transact(client => previewAssociationDestinations(client, workspaceId, actor, contactIds)),

    async createOrder(workspaceId, input, actor) {
      return transact(async (client) => {
        await beginAssociationCreation(client, workspaceId)
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        const codeDigest = input.promotionCode
          ? promotionDigest(input.promotionCode, options.promotionHmacKey) : null
        const { promotionCode: _promotionCode, ...fingerprintOrder } = input
        const fingerprint = associationFingerprint({ ...fingerprintOrder,
          ...(codeDigest ? { promotionCodeDigest: codeDigest } : {}) })
        const existing = await client.query<DbRow>(
          `SELECT id, request_fingerprint AS "requestFingerprint"
             FROM association_orders
            WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [workspaceId, input.idempotencyKey],
        )
        if (existing.rows[0]) {
          await authorizeOrderIntegration(client, workspaceId, String(existing.rows[0].id), actor, 'association.orders.write', undefined, integration)
          await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), actor)
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different order')
          }
          const record = await getOrderRecord(client, workspaceId, String(existing.rows[0].id))
          return { record: record!, created: false }
        }
        requireAssociationAdmission(module)
        await requirePerson(client, workspaceId, input.contactId)
        let sourceEvidence = await loadAssociationOrderScope(client, workspaceId, [input.contactId,
          ...input.lines.flatMap(line => line.attendees.flatMap(attendee => attendee.contactId ? [attendee.contactId] : []))])
        const waitlist = await associationWaitlistInheritance(client, workspaceId, input.contactId, actor)
        if (waitlist) sourceEvidence = {
          sources: [...sourceEvidence.sources, ...waitlist.sources],
          scope: deriveResourceScope({ producer: 'association.waitlist-order', sources: [
            ...sourceEvidence.sources, { ...waitlist.scope, resourceKind: 'submission', resourceId: waitlist.submissionId, version: 'saved' },
          ] }, sourceEvidence.scope),
        }
        sourceEvidence = await admitAssociationSourceScope(client, workspaceId, actor, sourceEvidence, input.destination)
        const attendeeContactIds = [...new Set(input.lines.flatMap((line) =>
          line.attendees.flatMap((attendee) => attendee.contactId ? [attendee.contactId] : [])))]
        for (const contactId of attendeeContactIds) await requirePerson(client, workspaceId, contactId)
        const ticketIds = input.lines.map((line) => line.ticketId)
        const inventoryEvents=await lockAssociationInventory(client,workspaceId,{ticketIds})
        const admittedAt=(await client.query<{instant:string}>('SELECT clock_timestamp()::text instant')).rows[0].instant
        const ticketsResult = await client.query<{
          id: string
          event_id: string
          currency: string
          price_minor: string
          member_price_minor: string | null
          eligible_plan_keys: string[]
          eligibility_required: boolean
          eligibility_scope: 'buyer' | 'attendees' | 'buyer_and_attendees'
          capacity: number | null
          per_order_limit: number
          sale_starts_at: Date | null
          sale_ends_at: Date | null
          status: string
          admissible: boolean
          event_status: string
          event_capacity: number | null
          registration_opens_at: Date | null
          registration_closes_at: Date | null
        }>(
          `SELECT t.id, t.event_id, t.currency, t.price_minor::text,
                  t.member_price_minor::text, t.eligible_plan_keys, t.eligibility_required,
                  t.eligibility_scope, t.capacity,
                  t.per_order_limit, t.sale_starts_at, t.sale_ends_at, t.status,
                  e.status AS event_status, e.capacity AS event_capacity,
                  e.registration_opens_at, e.registration_closes_at,
                  (t.status='on_sale' AND e.status='published' AND e.ends_at>$3::timestamptz
                    AND(t.sale_starts_at IS NULL OR t.sale_starts_at<=$3::timestamptz)
                    AND(t.sale_ends_at IS NULL OR t.sale_ends_at>$3::timestamptz)
                    AND(e.registration_opens_at IS NULL OR e.registration_opens_at<=$3::timestamptz)
                    AND(e.registration_closes_at IS NULL OR e.registration_closes_at>$3::timestamptz)) AS admissible
             FROM association_ticket_types t
             JOIN association_events e
               ON e.workspace_id = t.workspace_id AND e.id = t.event_id
            WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])
            ORDER BY t.id`,
          [workspaceId, ticketIds, admittedAt],
        )
        if (ticketsResult.rows.length !== ticketIds.length) {
          throw new AssociationError('not_found', 'one or more ticket types were not found')
        }
        authorizeIntegration(actor, 'association.orders.write', { eventIds: ticketsResult.rows.map((ticket) => ticket.event_id) }, integration)
        // A concurrent retry with the same request blocks on the same ticket
        // locks. Re-check after acquiring them so the loser returns the
        // winner's order instead of reserving inventory twice or surfacing a
        // unique-index error.
        const racedOrder = await client.query<DbRow>(
          `SELECT id, request_fingerprint AS "requestFingerprint"
             FROM association_orders
            WHERE workspace_id = $1 AND idempotency_key = $2`,
          [workspaceId, input.idempotencyKey],
        )
        if (racedOrder.rows[0]) {
          await assertAssociationOrderAuthority(client, workspaceId, String(racedOrder.rows[0].id), actor)
          if (racedOrder.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different order')
          }
          return {
            record: (await getOrderRecord(client, workspaceId, String(racedOrder.rows[0].id)))!,
            created: false,
          }
        }
        const tickets = new Map(ticketsResult.rows.map((ticket) => [ticket.id, ticket]))
        const promotion = codeDigest ? (await client.query<{
          id: string
          promotion_key: string
          name: string
          discount_type: 'percentage' | 'fixed_amount' | 'full' | 'buy_x_get_y'
          percentage_basis_points: number | null
          amount_minor: string | null
          currency: string | null
          buy_quantity: number | null
          get_quantity: number | null
          target_kind: 'event' | 'ticket' | 'plan'
          target_ids: string[]
          recurrence_mode: 'once' | 'forever' | 'repeating'
          recurrence_cycles: number | null
          apply_mode: 'once_per_order' | 'each_eligible_item'
          valid_from: Date | null
          valid_to: Date | null
          max_uses: number | null
          max_uses_per_contact: number | null
          source_redeemed_uses: number
          combines_with_member_price: boolean
          release_on_full_refund: boolean
          status: string
        }>(`SELECT id,promotion_key,name,discount_type,percentage_basis_points,amount_minor::text,currency,buy_quantity,get_quantity,
              target_kind,target_ids,recurrence_mode,recurrence_cycles,apply_mode,valid_from,valid_to,max_uses,max_uses_per_contact,source_redeemed_uses,
              combines_with_member_price,release_on_full_refund,status
            FROM association_promotions WHERE workspace_id=$1 AND code_digest=$2 FOR UPDATE`,
        [workspaceId, codeDigest])).rows[0] : null
        if (codeDigest && (!promotion || promotion.status !== 'active'
          || (promotion.valid_from && promotion.valid_from.getTime() > Date.parse(admittedAt))
          || (promotion.valid_to && promotion.valid_to.getTime() <= Date.parse(admittedAt)))) {
          throw new AssociationError('promotion_invalid', 'Promotion code is invalid or unavailable.')
        }
        if (promotion) {
          const counts = (await client.query<{ all_uses: number; contact_uses: number; source_contact_uses: number }>(`SELECT
              count(*) FILTER(WHERE state='redeemed' OR (state='reserved' AND reservation_expires_at>$3::timestamptz))::int all_uses,
              count(*) FILTER(WHERE contact_id=$4 AND (state='redeemed' OR (state='reserved' AND reservation_expires_at>$3::timestamptz)))::int contact_uses,
              COALESCE((SELECT uses FROM association_promotion_source_contact_uses
                WHERE workspace_id=$1 AND promotion_id=$2 AND contact_id=$4),0)::int source_contact_uses
            FROM association_promotion_uses WHERE workspace_id=$1 AND promotion_id=$2`,
          [workspaceId, promotion.id, admittedAt, input.contactId])).rows[0]
          if ((promotion.max_uses !== null && counts.all_uses + promotion.source_redeemed_uses >= promotion.max_uses)
            || (promotion.max_uses_per_contact !== null
              && counts.contact_uses + counts.source_contact_uses >= promotion.max_uses_per_contact)) {
            throw new AssociationError('promotion_exhausted', 'Promotion code has reached its usage limit.')
          }
        }
        const needsMembershipEvidence = input.lines.some((line) => {
          const ticket = tickets.get(line.ticketId)!
          return line.useMemberPrice || ticket.eligibility_required
        })
        const membershipContactIds = [...new Set([input.contactId, ...attendeeContactIds])]
        const lockedMemberships = needsMembershipEvidence
          ? (await client.query<{ id: string; contact_id: string }>(`SELECT id,contact_id FROM association_memberships
              WHERE workspace_id=$1 AND contact_id=ANY($2::uuid[]) AND status='active'
              ORDER BY contact_id,id FOR SHARE`, [workspaceId, membershipContactIds])).rows : []
        const lockedMembershipIds = lockedMemberships.map(row => row.id)
        const currencies = new Set(ticketsResult.rows.map((ticket) => ticket.currency))
        if (currencies.size !== 1) throw new AssociationError('conflict', 'one order cannot mix currencies')

        const inventory = await client.query<{ ticket_id: string; event_id: string; used: number }>(
          `SELECT ticket_id, event_id, count(*)::int AS used
             FROM association_registrations
            WHERE workspace_id = $1
              AND NOT historical_import AND (status IN ('confirmed','checked_in','registered','attended')
                OR (status = 'reserved' AND reservation_expires_at > $4::timestamptz))
              AND (ticket_id = ANY($2::uuid[]) OR event_id = ANY($3::uuid[]))
            GROUP BY ticket_id, event_id`,
          [workspaceId, ticketIds, inventoryEvents, admittedAt],
        )
        const ticketUsed = new Map<string, number>()
        const eventUsed = new Map<string, number>()
        for (const row of inventory.rows) {
          ticketUsed.set(row.ticket_id, (ticketUsed.get(row.ticket_id) ?? 0) + row.used)
          eventUsed.set(row.event_id, (eventUsed.get(row.event_id) ?? 0) + row.used)
        }
        const requestedByEvent = new Map<string, number>()
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          requestedByEvent.set(ticket.event_id, (requestedByEvent.get(ticket.event_id) ?? 0) + line.quantity)
        }

        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          if (!ticket.admissible) {
            throw new AssociationError('not_available', 'ticket is not currently on sale', { ticketId: line.ticketId })
          }
          if (line.quantity > ticket.per_order_limit) {
            throw new AssociationError('not_available', 'ticket quantity exceeds its per-order limit', { ticketId: line.ticketId })
          }
          if (ticket.capacity !== null && (ticketUsed.get(ticket.id) ?? 0) + line.quantity > ticket.capacity) {
            throw new AssociationError('not_available', 'ticket capacity is exhausted', { ticketId: line.ticketId })
          }
          if (ticket.event_capacity !== null
            && (eventUsed.get(ticket.event_id) ?? 0) + (requestedByEvent.get(ticket.event_id) ?? 0) > ticket.event_capacity) {
            throw new AssociationError('not_available', 'event capacity is exhausted', { eventId: ticket.event_id })
          }
        }

        const pricedLines: Array<{
          input: OrderCreateInput['lines'][number]
          ticket: (typeof ticketsResult.rows)[number]
          unitPrice: number
          publicPrice: number
          memberDiscount: number
          promotionDiscount: number
          membershipId: string | null
          attendeeMembershipIds: Array<string | null>
        }> = []
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          if (ticket.eligibility_required && !line.useMemberPrice) {
            throw new AssociationError('member_price_ineligible',
              'restricted tickets require eligibility-priced admission', { ticketId: line.ticketId })
          }
          const publicPrice = Number(ticket.price_minor)
          let membershipId: string | null = null
          const attendeeMembershipIds: Array<string | null> = line.attendees.map(() => null)
          let unitPrice = publicPrice
          if (line.useMemberPrice) {
            if (ticket.member_price_minor === null) {
              throw new AssociationError('member_price_ineligible', 'ticket has no member price', { ticketId: line.ticketId })
            }
            const membershipFor = async (contactId: string): Promise<string | null> => {
              const eligibility = await client.query<{ id: string }>(
                `SELECT m.id FROM association_memberships m
                 JOIN association_membership_plans p
                   ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
                WHERE m.workspace_id = $1 AND m.contact_id = $2
                  AND m.id=ANY($4::uuid[])
                  AND association_membership_is_effective(m.workspace_id,m.id,m.status,m.starts_at,m.ends_at,$5::timestamptz)
                  AND (cardinality($3::text[]) = 0 OR p.plan_key = ANY($3::text[]))
                ORDER BY m.starts_at DESC LIMIT 1`,
                [workspaceId, contactId, ticket.eligible_plan_keys, lockedMembershipIds, admittedAt],
              )
              return eligibility.rows[0]?.id ?? null
            }
            if (ticket.eligibility_scope === 'buyer' || ticket.eligibility_scope === 'buyer_and_attendees') {
              membershipId = await membershipFor(input.contactId)
              if (!membershipId) {
                throw new AssociationError('member_price_ineligible', 'buyer has no eligible active membership', { ticketId: line.ticketId })
              }
            }
            if (ticket.eligibility_scope === 'attendees' || ticket.eligibility_scope === 'buyer_and_attendees') {
              const seen = new Set<string>()
              for (const [index, attendee] of line.attendees.entries()) {
                if (!attendee.contactId || seen.has(attendee.contactId)) {
                  throw new AssociationError('attendee_membership_ineligible',
                    'each restricted place requires a distinct attendee contact with an eligible active membership',
                    { ticketId: line.ticketId, attendeeIndex: index })
                }
                seen.add(attendee.contactId)
                attendeeMembershipIds[index] = await membershipFor(attendee.contactId)
                if (!attendeeMembershipIds[index]) {
                  throw new AssociationError('attendee_membership_ineligible',
                    'attendee has no eligible active membership', { ticketId: line.ticketId, attendeeIndex: index })
                }
              }
            }
            unitPrice = Number(ticket.member_price_minor)
          }
          pricedLines.push({ input: line, ticket, unitPrice, publicPrice,
            memberDiscount: (publicPrice - unitPrice) * line.quantity,
            promotionDiscount: 0, membershipId, attendeeMembershipIds })
        }
        const subtotal = pricedLines.reduce((sum, line) => sum + line.publicPrice * line.input.quantity, 0)
        if (promotion) {
          if (promotion.target_kind === 'plan') {
            throw new AssociationError('promotion_not_applicable', 'Plan promotion codes do not apply to event orders.')
          }
          if (promotion.discount_type === 'fixed_amount' && promotion.currency !== [...currencies][0]) {
            throw new AssociationError('promotion_not_applicable', 'Promotion currency does not match this order.')
          }
          const targets = new Set(promotion.target_ids)
          const applicable = pricedLines.filter(line =>
            (promotion.target_kind === 'event' ? targets.has(line.ticket.event_id) : targets.has(line.ticket.id))
            && (promotion.combines_with_member_price || !line.input.useMemberPrice))
          if (applicable.length === 0) {
            throw new AssociationError('promotion_not_applicable', 'Promotion code does not apply to this order.')
          }
          if (promotion.apply_mode === 'once_per_order') {
            const eligibleTotal = applicable.reduce((sum, line) => sum + line.unitPrice * line.input.quantity, 0)
            const discountTotal = promotion.discount_type === 'full' ? eligibleTotal
              : promotion.discount_type === 'percentage'
                ? Math.floor(eligibleTotal * promotion.percentage_basis_points! / 10_000)
                : Math.min(eligibleTotal, Number(promotion.amount_minor))
            let remaining = discountTotal
            for (const line of applicable) {
              line.promotionDiscount = Math.min(line.unitPrice * line.input.quantity, remaining)
              remaining -= line.promotionDiscount
            }
          } else {
            for (const line of applicable) {
              const base = line.unitPrice * line.input.quantity
              if (promotion.discount_type === 'full') line.promotionDiscount = base
              else if (promotion.discount_type === 'percentage') {
                line.promotionDiscount = Math.floor(base * promotion.percentage_basis_points! / 10_000)
              } else if (promotion.discount_type === 'fixed_amount') {
                line.promotionDiscount = Math.min(base, Number(promotion.amount_minor) * line.input.quantity)
              } else {
                const group = promotion.buy_quantity! + promotion.get_quantity!
                const freeUnits = Math.floor(line.input.quantity / group) * promotion.get_quantity!
                line.promotionDiscount = Math.min(base, freeUnits * line.unitPrice)
              }
            }
          }
          if (!applicable.some(line => line.promotionDiscount > 0)) {
            throw new AssociationError('promotion_not_applicable', 'Promotion quantity or amount does not produce a discount.')
          }
        }
        const total = pricedLines.reduce((sum, line) =>
          sum + line.unitPrice * line.input.quantity - line.promotionDiscount, 0)
        const discount = subtotal - total
        if (![subtotal, total, discount].every(Number.isSafeInteger)) {
          throw new AssociationError('conflict', 'Order money exceeds the supported exact integer range.')
        }
        const reservationExpiresAt=(await client.query<{deadline:string}>(
          "SELECT ($1::timestamptz+$2::integer*interval '1 minute')::text deadline",[admittedAt,input.reservationMinutes])).rows[0].deadline
        const promotionSnapshot = promotion ? {
          promotionId: promotion.id,
          key: promotion.promotion_key,
          name: promotion.name,
          discountType: promotion.discount_type,
          percentageBasisPoints: promotion.percentage_basis_points,
          amountMinor: promotion.amount_minor,
          currency: promotion.currency,
          buyQuantity: promotion.buy_quantity,
          getQuantity: promotion.get_quantity,
          targetKind: promotion.target_kind,
          targetIds: promotion.target_ids,
          recurrenceMode: promotion.recurrence_mode,
          recurrenceCycles: promotion.recurrence_cycles,
          applyMode: promotion.apply_mode,
          combinesWithMemberPrice: promotion.combines_with_member_price,
          releaseOnFullRefund: promotion.release_on_full_refund,
          validTo: promotion.valid_to?.toISOString() ?? null,
          discountMinor: pricedLines.reduce((sum, line) => sum + line.promotionDiscount, 0),
          applicableLines: pricedLines.filter(line => line.promotionDiscount > 0)
            .map(line => ({ ticketId: line.ticket.id, discountMinor: line.promotionDiscount })),
        } : null
        await assertAssociationSourceAuthority(client, workspaceId, actor, sourceEvidence)
        const orderResult = await client.query<{ id: string }>(
          `INSERT INTO association_orders
             (workspace_id, contact_id, idempotency_key, request_fingerprint,
              status, currency, subtotal_minor, discount_minor, total_minor,
              reservation_expires_at, promotion_id, promotion_snapshot, metadata, scope_snapshot, scope_sources)
           VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [workspaceId, input.contactId, input.idempotencyKey, fingerprint,
            [...currencies][0], subtotal, discount, total, reservationExpiresAt,
            promotion?.id ?? null, promotionSnapshot, input.metadata, JSON.stringify(sourceEvidence.scope), JSON.stringify(sourceEvidence.sources)],
        )
        const orderId = orderResult.rows[0].id
        if (promotion) {
          await client.query(`INSERT INTO association_promotion_uses
            (workspace_id,promotion_id,order_id,contact_id,state,reservation_expires_at)
            VALUES($1,$2,$3,$4,'reserved',$5)`,
          [workspaceId, promotion.id, orderId, input.contactId, reservationExpiresAt])
        }
        for (const priced of pricedLines) {
          const lineTotal = priced.unitPrice * priced.input.quantity - priced.promotionDiscount
          const lineDiscount = priced.memberDiscount + priced.promotionDiscount
          const lineResult = await client.query<{ id: string }>(
            `INSERT INTO association_order_lines
               (workspace_id, order_id, ticket_id, quantity, unit_price_minor,
                discount_minor, member_discount_minor, promotion_discount_minor,
                line_total_minor, pricing_basis, eligible_membership_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [workspaceId, orderId, priced.ticket.id, priced.input.quantity,
              priced.unitPrice, lineDiscount, priced.memberDiscount, priced.promotionDiscount, lineTotal,
              priced.input.useMemberPrice ? 'member' : 'public', priced.membershipId],
          )
          for (const [attendeeIndex, attendee] of priced.input.attendees.entries()) {
            await client.query(
              `INSERT INTO association_registrations
                 (workspace_id, order_id, order_line_id, event_id, ticket_id,
                  attendee_contact_id, attendee_name, attendee_email,
                  attendee_metadata, eligible_membership_id, status, reservation_expires_at,
                  source_kind, source_id, request_fingerprint, scope_snapshot, scope_sources)
               VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,'reserved',$11,'commerce',$3::text,$12,$13,$14)`,
              [workspaceId, orderId, lineResult.rows[0].id, priced.ticket.event_id,
                priced.ticket.id, attendee.contactId ?? null, attendee.name,
                attendee.email ?? null, attendee.metadata, priced.attendeeMembershipIds[attendeeIndex], reservationExpiresAt,
                associationFingerprint({ order: fingerprint, ticketId: priced.ticket.id, attendeeIndex }), JSON.stringify(sourceEvidence.scope), JSON.stringify(sourceEvidence.sources)],
            )
          }
        }
        await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
        await audit(client, workspaceId, 'order.reserved', 'order', orderId, actor, {
          contactId: input.contactId,
          totalMinor: total,
          currency: [...currencies][0],
          ...(promotion ? { promotionId: promotion.id,
            promotionDiscountMinor: promotionSnapshot!.discountMinor } : {}),
        })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
      })
    },

    async getOrder(workspaceId, id, actor) {
      return transact(async (client) => {
        if (actor) {
          await authorizeOrderIntegration(client, workspaceId, id, actor, 'association.read')
          await assertAssociationOrderAuthority(client, workspaceId, id, actor)
        }
        const record = await getOrderRecord(client, workspaceId, id)
        if (actor && record) await assertAssociationOrderAuthority(client, workspaceId, id, actor)
        return record
      })
    },

    async listOrders(workspaceId, input, actor) {
      return transact(async (client) => {
        const conditions = ['workspace_id=$1']
        const values: unknown[] = [workspaceId]
        const access = actor ? await associationOrderReadPredicate(client, workspaceId, actor, 2) : null
        if (access) { conditions.push(access.sql); values.push(...access.params) }
        if (input.status) { values.push(input.status); conditions.push(`status=$${values.length}`) }
        if (input.contactId) { values.push(input.contactId); conditions.push(`contact_id=$${values.length}`) }
        if (input.eventId) {
          values.push(input.eventId)
          conditions.push(`EXISTS (SELECT 1 FROM association_order_lines l JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
            WHERE l.workspace_id=$1 AND l.order_id=association_orders.id AND t.event_id=$${values.length})`)
        }
        if (input.allowedEventIds) {
          values.push([...input.allowedEventIds].sort())
          conditions.push(`EXISTS (SELECT 1 FROM association_order_lines l WHERE l.workspace_id=$1 AND l.order_id=association_orders.id)`)
          conditions.push(`NOT EXISTS (SELECT 1 FROM association_order_lines l JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
            WHERE l.workspace_id=$1 AND l.order_id=association_orders.id AND NOT (t.event_id=ANY($${values.length}::uuid[])))`)
        }
        if (input.createdAfter) { values.push(crmPageInstant(input.createdAfter)); conditions.push(`created_at>=$${values.length}::timestamptz`) }
        if (input.createdBefore) { values.push(crmPageInstant(input.createdBefore)); conditions.push(`created_at<$${values.length}::timestamptz`) }
        const summaries = await client.query<{
          currency: string; orderCount: number; settledOrderCount: number; subtotalMinor: string; discountMinor: string;
          grossMinor: string; refundedMinor: string; netMinor: string; pendingMinor: string;
        }>(`SELECT currency,count(*)::int AS "orderCount",
            count(*) FILTER(WHERE status IN('paid','refunded'))::int AS "settledOrderCount",
            COALESCE(sum(subtotal_minor) FILTER(WHERE status IN('paid','refunded')),0)::text AS "subtotalMinor",
            COALESCE(sum(discount_minor) FILTER(WHERE status IN('paid','refunded')),0)::text AS "discountMinor",
            COALESCE(sum(total_minor) FILTER(WHERE status IN('paid','refunded')),0)::text AS "grossMinor",
            COALESCE(sum(refunded_minor),0)::text AS "refundedMinor",
            (COALESCE(sum(total_minor) FILTER(WHERE status IN('paid','refunded')),0)-COALESCE(sum(refunded_minor),0))::text AS "netMinor",
            COALESCE(sum(total_minor) FILTER(WHERE status='pending'),0)::text AS "pendingMinor"
          FROM association_orders WHERE ${conditions.join(' AND ')} GROUP BY currency ORDER BY currency`, values)
        const result = await page(client, workspaceId, 'association.orders', input,
          `SELECT ${ORDER_SELECT} FROM association_orders WHERE ${conditions.join(' AND ')}`, values)
        if (actor && access) {
          const renewed = await associationOrderReadPredicate(client, workspaceId, actor, 2)
          if (JSON.stringify(renewed.params) !== JSON.stringify(access.params)) {
            throw new CrmOperationsError('not_authorized', 'Order access changed. Reload before continuing.')
          }
        }
        return { ...result, total: summaries.rows.reduce((sum, row) => sum + row.orderCount, 0), financialSummary: summaries.rows }
      })
    },

    expireDueOrder: (workspaceId,id,actor)=>settleWithoutProvider(pool,workspaceId,id,actor,'expire'),
    cancelOrder: (workspaceId, id, actor) => settleWithoutProvider(pool, workspaceId, id, actor, 'cancel'),
    confirmFreeOrder: (workspaceId, id, actor) => settleWithoutProvider(pool, workspaceId, id, actor, 'confirm_free'),

    async bindOrderProvider(workspaceId, orderId, raw, actor) {
      const input = AssociationProviderBindingInputSchema.parse(raw)
      requireAssociationProviderActor(actor)
      return transact(async client => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        await authorizeOrderIntegration(client, workspaceId, orderId, actor, 'association.provider_events.write', input.provider, integration)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('association-provider-object:'||$1::text||':'||$2||':'||$3,0))", [workspaceId, input.provider, input.providerReference])
        const order = (await client.query<ProviderOrderIdentity & { source_import: boolean }>('SELECT status,provider,provider_reference,currency,total_minor::text,refunded_minor::text,source_import FROM association_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, orderId])).rows[0]
        if (!order) throw new AssociationError('not_found', 'order not found')
        requireProviderOrderMoney(order, input)
        if (order.provider_reference) {
          requireBoundProviderOrder(order, input)
          return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
        }
        if (order.source_import) {
          throw new AssociationError('invalid_transition', 'An imported source order cannot start a new provider checkout.')
        }
        requireAssociationAdmission(module)
        if (order.status !== 'pending' || !(await client.query<{ available: boolean }>('SELECT reservation_expires_at>clock_timestamp() available FROM association_orders WHERE workspace_id=$1 AND id=$2', [workspaceId, orderId])).rows[0]?.available)
          throw new AssociationError('not_available', 'A new provider binding requires an unexpired pending order.')
        if ((await client.query('SELECT id FROM association_orders WHERE workspace_id=$1 AND provider=$2 AND provider_reference=$3', [workspaceId, input.provider, input.providerReference])).rowCount)
          throw new AssociationError('conflict', 'The provider object is already bound to another order.')
        await client.query('UPDATE association_orders SET provider=$3,provider_reference=$4 WHERE workspace_id=$1 AND id=$2', [workspaceId, orderId, input.provider, input.providerReference])
        await audit(client, workspaceId, 'order.provider_bound', 'order', orderId, actor, { provider: input.provider })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
      })
    },

    reconcileProviderEvent: (workspaceId, orderId, event, actor) => receiveProviderInbox(pool, { target: 'order', orderId, event }, actor, workspaceId, providerHandlers(workspaceId)),
    reconcileProviderFinancialEvent: (workspaceId, orderId, event, actor) => receiveProviderInbox(pool, { target: 'order', orderId, event }, actor, workspaceId, providerHandlers(workspaceId)),
    reconcileProviderEntitlement: (workspaceId, input, actor) => {
      if (!options.providerEntitlements) throw new CrmOperationsError('conflict', 'Provider entitlement processing is unavailable.', { reason: 'provider_entitlement_service_unavailable' })
      return options.providerEntitlements.submit(workspaceId, input, actor)
    },
    async retryProviderEventReceipt(workspaceId, receiptId) {
      const row = (await pool.query<ProviderInboxRow>('SELECT * FROM association_integration_events WHERE workspace_id=$1 AND id=$2', [workspaceId, receiptId])).rows[0]
      if (!row) throw new CrmOperationsError('not_found', 'Provider receipt is unavailable.')
      if (row.target_kind === 'entitlement') {
        if (!options.providerEntitlements) throw new CrmOperationsError('conflict', 'Provider entitlement processing is unavailable.', { reason: 'provider_entitlement_service_unavailable' })
        return options.providerEntitlements.retry(row)
      }
      return receiveProviderInbox(pool, row.normalized_payload, row.execution_actor, workspaceId, providerHandlers(workspaceId), 'worker')
    },
    async resolveProviderReceipt(workspaceId, receiptId, actor) {
      if (actor.credentialKind !== 'user' || !actor.actingUserId) {
        throw new CrmOperationsError('not_authorized', 'A workspace owner or admin is required to retry provider evidence.')
      }
      const row = await transact(async client => {
        await beginAssociationCreation(client, workspaceId)
        const current = (await client.query<ProviderInboxRow>(
          'SELECT * FROM association_integration_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [workspaceId, receiptId],
        )).rows[0]
        if (!current) throw new CrmOperationsError('not_found', 'Provider receipt is unavailable.')
        await assertAssociationOrderAuthority(client, workspaceId, current.id, actor, 'provider_receipt')
        if (!['needs_reconciliation', 'applied'].includes(current.state)) {
          throw new CrmOperationsError('conflict', 'Only a receipt requiring reconciliation can be retried by an operator.',
            { reason: 'provider_receipt_not_reconcilable', receiptState: current.state })
        }
        if (current.state === 'needs_reconciliation'
          && !['integration_key', 'provider', 'system_job'].includes(current.execution_actor.credentialKind)) {
          throw new CrmOperationsError('not_authorized', 'The provider backend must resubmit this exact event with current authority.')
        }
        await audit(client, workspaceId, 'provider_receipt.retry_requested', 'provider_receipt', current.id, actor,
          { provider: current.provider, target: current.target_kind, previousState: current.state, errorCode: current.last_error_code })
        return current
      })
      if (row.target_kind === 'entitlement') {
        if (row.normalized_payload.target !== 'entitlement') throw new CrmOperationsError('conflict', 'Provider receipt target is inconsistent.')
        if (!options.providerEntitlements) throw new CrmOperationsError('conflict', 'Provider entitlement processing is unavailable.', { reason: 'provider_entitlement_service_unavailable' })
        return options.providerEntitlements.submit(workspaceId, row.normalized_payload.event, row.execution_actor)
      }
      if (row.normalized_payload.target !== 'order') throw new CrmOperationsError('conflict', 'Provider receipt target is inconsistent.')
      return receiveProviderInbox(pool, row.normalized_payload, row.execution_actor, workspaceId, providerHandlers(workspaceId))
    },
    async listProviderReceipts(workspaceId, input, actor) {
      return transact(async client => {
        const scope = await associationOrderReadPredicate(client, workspaceId, actor, 7, 'provider_receipt')
        return queryCrmPage((sql, params) => client.query(sql, params), { workspaceId, resource: 'association.provider-receipts', key: 'items',
          query: { limit: input.limit, cursor: input.cursor ?? undefined, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
          params: [workspaceId, input.orderId ?? null, input.entitlementId ?? null, input.state ?? null, input.allowedEventIds ?? null, input.allowedPlanIds ?? null, ...scope.params],
          sql: `SELECT r.id,r.provider,r.provider_event_id AS "eventId",r.provider_reference AS "providerReference",r.occurred_at AS "occurredAt",
            r.target_kind AS target,r.order_id AS "orderId",r.entitlement_id AS "entitlementId",r.contact_id AS "contactId",r.plan_id AS "planId",
            r.state,r.attempts,r.next_attempt_at AS "nextAttemptAt",r.last_error_code AS "errorCode",r.created_at AS "createdAt",r.applied_at AS "appliedAt"
            FROM association_integration_events r WHERE r.workspace_id=$1 AND ($2::uuid IS NULL OR r.order_id=$2)
            AND ($3::uuid IS NULL OR r.entitlement_id=$3) AND ($4::text IS NULL OR r.state=$4)
            AND ((r.target_kind='order' AND ($5::uuid[] IS NULL OR (
              EXISTS(SELECT 1 FROM association_order_lines l WHERE l.workspace_id=$1 AND l.order_id=r.order_id)
              AND NOT EXISTS(SELECT 1 FROM association_order_lines l JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
                WHERE l.workspace_id=$1 AND l.order_id=r.order_id AND NOT(t.event_id=ANY($5::uuid[]))))))
            OR (r.target_kind='entitlement' AND ($6::uuid[] IS NULL OR r.plan_id=ANY($6::uuid[]))))
            AND ${scope.sql.replaceAll('association_integration_events.', 'r.')}`,
        })
      })
    },

    async listEventRegistrations(workspaceId, eventId, input, actor) {
      return transact(async client => {
        const scope = actor ? await associationOrderReadPredicate(client, workspaceId, actor, 3, 'registration') : { sql: 'TRUE', params: [] }
        const event = await client.query(
          `SELECT 1 FROM association_events WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, eventId],
        )
        if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
        const conditions = ['workspace_id = $1', 'event_id = $2', scope.sql]
        const values: unknown[] = [workspaceId, eventId, ...scope.params]
        if (input.status) {
          values.push(input.status)
          conditions.push(`status = $${values.length}`)
        }
        const result = await page(client, workspaceId, 'association.registrations', input,
          `SELECT ${REGISTRATION_SELECT} FROM association_registrations WHERE ${conditions.join(' AND ')}`, values)
        if (actor) {
          const renewed = await associationOrderReadPredicate(client, workspaceId, actor, 3, 'registration')
          if (JSON.stringify(renewed.params) !== JSON.stringify(scope.params)) throw new CrmOperationsError('not_authorized', 'Registration access changed.')
        }
        return result
      })
    },

    async listOperationalRoster(workspaceId, eventId, input, actor) {
      return transact(async client => {
        const scope = actor ? await associationOrderReadPredicate(client, workspaceId, actor, 3, 'registration') : { sql: 'TRUE', params: [] }
        const event = await client.query('SELECT 1 FROM association_events WHERE workspace_id=$1 AND id=$2', [workspaceId, eventId])
        if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
        const result = await queryCrmPage<'items', AssociationOperationalRosterRow>((sql, params) => client.query(sql, params), {
          workspaceId, resource: 'association.operational-roster', key: 'items',
          query: { limit: input.limit, cursor: input.cursor ?? undefined, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
          params: [workspaceId, eventId, ...scope.params],
          sql: `SELECT association_registrations.id,association_registrations.event_id AS "eventId",association_registrations.order_id AS "orderId",association_registrations.order_line_id AS "orderLineId",
            association_registrations.ticket_id AS "ticketId",t.ticket_key AS "ticketKey",t.name AS "ticketName",o.contact_id AS "buyerContactId",
            association_registrations.attendee_contact_id AS "attendeeContactId",association_registrations.attendee_name AS "attendeeName",association_registrations.attendee_email AS "attendeeEmail",
            CASE WHEN jsonb_typeof(association_registrations.attendee_metadata->'phone')='string' THEN association_registrations.attendee_metadata->>'phone' END AS phone,
            CASE WHEN jsonb_typeof(association_registrations.attendee_metadata->'organisation')='string' THEN association_registrations.attendee_metadata->>'organisation' END AS organisation,
            CASE WHEN jsonb_typeof(COALESCE(association_registrations.attendee_metadata->'jobTitle',association_registrations.attendee_metadata->'job_title'))='string'
              THEN COALESCE(association_registrations.attendee_metadata->>'jobTitle',association_registrations.attendee_metadata->>'job_title') END AS "jobTitle",
            association_registrations.status,association_registrations.checked_in_at AS "checkedInAt",association_registrations.source_kind AS "sourceKind",association_registrations.source_id AS "sourceId",
            association_registrations.historical_import AS "historicalImport",
            CASE WHEN jsonb_typeof(COALESCE(association_registrations.attendee_metadata->'marketingConsent',association_registrations.attendee_metadata->'marketing_consent'))='boolean'
              THEN COALESCE(association_registrations.attendee_metadata->>'marketingConsent',association_registrations.attendee_metadata->>'marketing_consent')::boolean END AS "marketingConsent",
            CASE WHEN jsonb_typeof(COALESCE(o.metadata->'ticketingConsent',o.metadata->'ticketing_consent'))='boolean'
              THEN COALESCE(o.metadata->>'ticketingConsent',o.metadata->>'ticketing_consent')::boolean END AS "ticketingConsent",
            COALESCE(association_registrations.attendee_metadata->>'policyVersion',association_registrations.attendee_metadata->>'policy_version',o.metadata->>'policyVersion',o.metadata->>'policy_version') AS "policyVersion",
            COALESCE(association_registrations.attendee_metadata->>'policyAcceptedAt',association_registrations.attendee_metadata->>'policy_accepted_at',o.metadata->>'policyAcceptedAt',o.metadata->>'policy_accepted_at') AS "policyAcceptedAt",
            COALESCE(association_registrations.attendee_metadata->'questionResponses',association_registrations.attendee_metadata->'question_responses',association_registrations.attendee_metadata->'questions') AS "questionResponses",
            association_registrations.created_at AS "createdAt",association_registrations.updated_at AS "updatedAt"
            FROM association_registrations
            LEFT JOIN association_ticket_types t ON t.workspace_id=association_registrations.workspace_id AND t.id=association_registrations.ticket_id
            LEFT JOIN association_orders o ON o.workspace_id=association_registrations.workspace_id AND o.id=association_registrations.order_id
            WHERE association_registrations.workspace_id=$1 AND association_registrations.event_id=$2 AND ${scope.sql}`,
      })
      if (actor) {
        const renewed = await associationOrderReadPredicate(client, workspaceId, actor, 3, 'registration')
        if (JSON.stringify(renewed.params) !== JSON.stringify(scope.params)) throw new CrmOperationsError('not_authorized', 'Registration access changed.')
      }
      return result
      })
    },

    async getRegistrationManagement(workspaceId, id, actor) {
      return transact(async client => {
        if (actor) await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'registration')
        const result = await client.query<{ sourceKind: string; eventId: string }>(
          `SELECT source_kind AS "sourceKind",event_id AS "eventId" FROM association_registrations
            WHERE workspace_id=$1 AND id=$2`, [workspaceId, id],
        )
        if (actor) await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'registration')
        return result.rows[0] ?? null
      })
    },

    async updateRegistration(workspaceId, id, input, actor) {
      return transact(async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        await lockAssociationModule(client, workspaceId)
        if (actor.integration || actor.credentialKind === 'integration_key') {
          const resource = await client.query<{ event_id: string }>('SELECT event_id FROM association_registrations WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
          authorizeIntegration(actor, 'association.orders.write', { eventIds: resource.rows.map((row) => row.event_id) }, integration)
        }
        const inventoryEvents=await lockAssociationInventory(client,workspaceId,{registrationId:id})
        const current = await client.query<{ status: RegistrationStatus; source_kind: string }>(
          `SELECT status,source_kind FROM association_registrations
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        )
        const registration = current.rows[0]
        if (!registration) throw new AssociationError('not_found', 'registration not found')
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'registration')
        if (!['commerce', 'source_order'].includes(registration.source_kind)) throw new AssociationError('invalid_transition', 'Non-commerce participation uses CRM participation commands.')
        if (!mayTransitionRegistration(registration.status, input.status)) {
          throw new AssociationError(
            'invalid_transition',
            `registration cannot transition from ${registration.status} to ${input.status}`,
          )
        }
        const result = await client.query<DbRow>(
          `UPDATE association_registrations
              SET status = $3,
                  reservation_expires_at = CASE WHEN $3 = 'cancelled' THEN NULL ELSE reservation_expires_at END,
                  checked_in_at = CASE WHEN $3 = 'checked_in' THEN now() ELSE checked_in_at END
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${REGISTRATION_SELECT}`,
          [workspaceId, id, input.status],
        )
        await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
        await audit(client, workspaceId, `registration.${input.status}`, 'registration', id, actor, {
          from: registration.status,
          to: input.status,
        })
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'registration')
        return result.rows[0]
      })
    },

    async correctRegistrationCheckIn(workspaceId, id, input, actor) {
      return transact(async client => {
        await lockAssociationModule(client, workspaceId)
        await lockAssociationInventory(client, workspaceId, { registrationId: id })
        const current = (await client.query<{ status: string; sourceKind: string }>(
          `SELECT status,source_kind AS "sourceKind" FROM association_registrations
            WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, id],
        )).rows[0]
        if (!current) throw new AssociationError('not_found', 'registration not found')
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'registration')
        if (!['commerce', 'source_order'].includes(current.sourceKind)) throw new AssociationError('invalid_transition', 'Non-commerce participation uses CRM participation commands.')
        if (input.expectedStatus !== 'checked_in' || current.status !== input.expectedStatus) {
          throw new AssociationError('conflict', 'Registration status no longer matches the expected check-in state.',
            { expectedStatus: input.expectedStatus, currentStatus: current.status })
        }
        const record = (await client.query<DbRow>(
          `UPDATE association_registrations SET status='confirmed',checked_in_at=NULL,updated_at=now()
            WHERE workspace_id=$1 AND id=$2 RETURNING ${REGISTRATION_SELECT}`, [workspaceId, id],
        )).rows[0]!
        await audit(client, workspaceId, 'registration.check_in_corrected', 'registration', id, actor,
          { from: input.expectedStatus, to: 'confirmed', reason: input.reason })
        await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'registration')
        return record
      })
    },

    async listNotifications(workspaceId, input, actor) {
      return transact(async client => {
        const scope = await associationOrderReadPredicate(client, workspaceId, actor, 2, 'notification')
        const conditions = ['workspace_id = $1', scope.sql]
        const values: unknown[] = [workspaceId, ...scope.params]
        if (input.status) {
          values.push(input.status)
          conditions.push(`status = $${values.length}`)
        }
        if (input.sourceKind) {
          values.push(input.sourceKind)
          conditions.push(`source_kind = $${values.length}`)
        }
        if (input.sourceId) {
          values.push(input.sourceId)
          conditions.push(`source_id = $${values.length}`)
        }
        return page(client, workspaceId, 'association.notifications', input,
          `SELECT ${NOTIFICATION_SELECT} FROM association_notification_outbox WHERE ${conditions.join(' AND ')}`, values)
      })
    },
  }
}
