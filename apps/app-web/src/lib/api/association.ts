/** Authenticated native Association member client. [COMP:app-web/association] */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import type { WorkspaceModule, WorkspaceModuleAction, WorkspaceModuleActionResult } from "@use-brian/shared";
import { authFetch } from "@/lib/auth-fetch";
import { getWorkspaceRole } from "@/lib/api/workspaces";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
export class AssociationApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await authFetch(`${API_URL}${path}`, input === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) throw new AssociationApiError(typeof body?.error === "string" ? body.error : "unavailable", response.status);
  return body as T;
}
export type AssociationModuleSnapshot = { module: WorkspaceModule; canManage: boolean };
export async function getAssociationModuleSnapshot(workspaceId: string): Promise<AssociationModuleSnapshot> {
  const [{ module }, role] = await Promise.all([
    request<{ module: WorkspaceModule }>(`/api/crm/${encodeURIComponent(workspaceId)}/association/module`),
    getWorkspaceRole(workspaceId),
  ]);
  if (module?.workspaceId !== workspaceId || !["enabled", "draining", "disabled"].includes(module.state)
    || !Number.isInteger(module.version)) throw new AssociationApiError("invalid_response", 502);
  return { module, canManage: role === "owner" || role === "admin" };
}
export function changeAssociationModule(workspaceId: string, action: WorkspaceModuleAction, expectedVersion: number): Promise<WorkspaceModuleActionResult> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/modules/association/actions`, { action, expectedVersion });
}

export type AssociationOrder = {
  id: string; contactId: string; status: "pending" | "paid" | "failed" | "cancelled" | "refunded";
  currency: string; subtotalMinor:string;discountMinor:string;totalMinor: string; reservationExpiresAt: string | null;
  refundedMinor: string; refundState: "none" | "pending" | "partial" | "partial_pending" | "partial_failed" | "full" | "failed";
  disputeState: "none" | "open" | "won" | "lost" | "mixed";
  provider: string | null; providerReference: string | null;promotionId:string|null;
  promotionSnapshot:{name:string;discountType:"percentage"|"full"|"buy_x_get_y";discountMinor:number;validTo:string|null}|null;createdAt: string;
};
export type AssociationOrderLine = { id:string;ticketId:string;ticketKey:string;ticketName:string;quantity:number;
  unitPriceMinor:string;discountMinor:string;memberDiscountMinor:string;promotionDiscountMinor:string;sourceDiscountMinor:string;
  lineTotalMinor:string;pricingBasis:"public"|"member";eligibleMembershipId:string|null };
export type AssociationOrderDetail = AssociationOrder & { lines:AssociationOrderLine[];registrations:AssociationRegistration[] };
export type AssociationOrderFinancialSummary = {currency:string;orderCount:number;settledOrderCount:number;subtotalMinor:string;
  discountMinor:string;grossMinor:string;refundedMinor:string;netMinor:string;pendingMinor:string};
export type AssociationOrderFilters = {eventId?:string;contactId?:string;status?:AssociationOrder["status"];
  createdAfter?:string;createdBefore?:string};
export type AssociationOrdersPage = { orders: AssociationOrder[]; nextCursor: string | null; financialSummary?:AssociationOrderFinancialSummary[] };
export async function listAssociationOrders(workspaceId: string, cursor?: string, filters:AssociationOrderFilters={}): Promise<AssociationOrdersPage> {
  const params = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
  for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
  const page = await request<AssociationOrdersPage>(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders?${params}`);
  if (!Array.isArray(page.orders) || (page.nextCursor !== null && typeof page.nextCursor !== "string")
    || (page.financialSummary!==undefined&&!Array.isArray(page.financialSummary))) throw new AssociationApiError("invalid_response", 502);
  return page;
}
export async function getAssociationOrder(workspaceId:string,orderId:string):Promise<AssociationOrderDetail>{
  const body=await request<{order:AssociationOrderDetail}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders/${encodeURIComponent(orderId)}`);
  if(!body.order||!Array.isArray(body.order.lines)||!Array.isArray(body.order.registrations))throw new AssociationApiError("invalid_response",502);
  return body.order;
}
export function changeAssociationOrder(workspaceId: string, orderId: string, action: "cancel" | "confirm-free"): Promise<{ order: AssociationOrder }> {
  return request(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders/${encodeURIComponent(orderId)}/${action}`, {});
}

// Portable wire types; no server/core runtime enters the browser bundle.
export type AssociationPlan = { id:string;planKey:string;name:string;currency:string;feeMinor:string;billingPeriod:"one_time"|"monthly"|"annual"|"lifetime"|"manual";benefits:string[];eligibilityNote:string|null;published:boolean;activeFrom:string|null;activeTo:string|null;provider:string|null;providerPlanId:string|null };
export type AssociationEvent = {id:string;slug:string;title:string;description:string;startsAt:string;endsAt:string;timezone:string;mode:"venue"|"online"|"hybrid";venue:string|null;onlineUrl:string|null;registrationOpensAt:string|null;registrationClosesAt:string|null;capacity:number|null;status:"draft"|"published"|"cancelled"|"completed";canonicalUrl:string|null;programmeKey:string|null;metadata:Record<string,unknown>};
export type AssociationTicket = {id:string;key:string;name:string;currency:string;priceMinor:string;memberPriceMinor:string|null;eligiblePlanKeys:string[];eligibilityRequired:boolean;eligibilityScope:"buyer"|"attendees"|"buyer_and_attendees";capacity:number|null;perOrderLimit:number;saleStartsAt:string|null;saleEndsAt:string|null;status:"draft"|"on_sale"|"sold_out"|"closed";reservedCount:number;available:number|null};
export type AssociationPromotion = {id:string;key:string;name:string;discountType:"percentage"|"fixed_amount"|"full"|"buy_x_get_y";
  percentageBasisPoints:number|null;amountMinor:string|null;currency:string|null;buyQuantity:number|null;getQuantity:number|null;targetKind:"event"|"ticket"|"plan";targetIds:string[];
  recurrenceMode:"once"|"forever"|"repeating";recurrenceCycles:number|null;applyMode:"once_per_order"|"each_eligible_item";
  validFrom:string|null;validTo:string|null;maxUses:number|null;maxUsesPerContact:number|null;combinesWithMemberPrice:boolean;
  releaseOnFullRefund:boolean;status:"draft"|"active"|"disabled";hasCode:boolean;reservedUses:number;redeemedUses:number;
  createdAt:string;updatedAt:string};
export type AssociationRegistration = {id:string;eventId:string;ticketId:string|null;orderId:string|null;attendeeContactId:string|null;eligibleMembershipId:string|null;attendeeName:string;attendeeEmail:string|null;status:"reserved"|"confirmed"|"checked_in"|"cancelled"|"refunded"|"registered"|"attended"|"no_show";sourceKind:string;checkedInAt:string|null};
export type AssociationOperationalRosterRow = {id:string;eventId:string;orderId:string|null;orderLineId:string|null;ticketId:string|null;ticketKey:string|null;ticketName:string|null;buyerContactId:string|null;attendeeContactId:string|null;attendeeName:string;attendeeEmail:string|null;phone:string|null;organisation:string|null;jobTitle:string|null;status:AssociationRegistration["status"];checkedInAt:string|null;sourceKind:string;sourceId:string|null;historicalImport:boolean;marketingConsent:boolean|null;ticketingConsent:boolean|null;policyVersion:string|null;policyAcceptedAt:string|null;questionResponses:unknown;createdAt:string;updatedAt:string};
export type AssociationWaitlistRow = {id:string;contactId:string;contactName:string;eventId:string;ticketId:string;waitlistState:"waiting"|"offered"|"converted"|"closed";promotionId:string|null;orderId:string|null;reservationExpiresAt:string|null};
export type AssociationProviderReceipt = {id:string;provider:string;eventId:string;state:"pending"|"processing"|"applied"|"retry"|"needs_reconciliation";errorCode:string|null;attempts:number;nextAttemptAt:string|null;appliedAt:string|null;orderId:string|null;entitlementId:string|null};
export type AssociationMembership = import("./crm").CrmEntitlement;
export type AssociationMembershipRescue = {id:string;contactId:string;contactName:string;planId:string;planKey:string;planName:string;
  status:"outstanding"|"settled"|"reversed"|"cancelled";amountMinor:string;currency:string;startsAt:string;endsAt:string;dueAt:string;
  reason:string;overdue:boolean;membershipId:string|null;membershipStatus:AssociationMembership["status"]|null;
  settlementMethod:"bank_transfer"|"cash"|"cheque"|"other"|null;settlementReference:string|null;settlementOccurredAt:string|null;
  settlementNote:string|null;reversalReference:string|null;reversalOccurredAt:string|null;reversalReason:string|null;cancellationReason:string|null;
  createdAt:string;updatedAt:string};
export type AssociationSponsorshipAllocation={id:string;sponsorContactId:string;sponsorContactName:string;sponsorMembershipId:string;
  beneficiaryPlanId:string;beneficiaryPlanKey:string;beneficiaryPlanName:string;seatLimit:number;allocatedSeats:number;startsAt:string;endsAt:string;
  invitationTtlHours:number;status:"active"|"cancelled";cancellationReason:string|null;cancelledAt:string|null;createdAt:string;updatedAt:string};
export type AssociationSponsorshipInvitation={id:string;allocationId:string;nomineeContactId:string;nomineeContactName:string;
  status:"pending"|"redeemed"|"revoked";expired:boolean;expiresAt:string;redeemedContactId:string|null;membershipId:string|null;
  redeemedAt:string|null;revocationReason:string|null;revokedAt:string|null;redemptionToken?:string|null;createdAt:string;updatedAt:string};
type Rows = {retentionRuns:Record<string,unknown>&{id:string;status:string;createdAt:string};credentials:import("./crm-administration").CrmManagedCredential;plans:AssociationPlan;memberships:AssociationMembership;rescues:AssociationMembershipRescue;allocations:AssociationSponsorshipAllocation;invitations:AssociationSponsorshipInvitation;events:AssociationEvent;tickets:AssociationTicket;promotions:AssociationPromotion;registrations:AssociationRegistration;waitlist:AssociationWaitlistRow;receipts:AssociationProviderReceipt;audit:import("./crm").CrmOperationsAuditEntry;deliveries:import("./crm").CrmEventDeliveryEntry};
export type AssociationResource = keyof Rows;
export type AssociationListQuery = {cursor?:string;eventId?:string;planId?:string;contactId?:string;sponsorContactId?:string;allocationId?:string;nomineeContactId?:string;status?:string;includeClosed?:boolean;activeOnly?:boolean;when?:"upcoming"|"past";id?:string;slug?:string};
export async function listAssociationPage<K extends keyof Rows>(workspaceId:string,resource:K,query:AssociationListQuery={}):Promise<{items:Rows[K][];nextCursor:string|null}> {
  const base=`/api/crm/${encodeURIComponent(workspaceId)}`;
  const event=encodeURIComponent(query.eventId ?? "");
  const catalog={retentionRuns:["operations/retention/runs","runs"],credentials:["operations/integration-credentials","credentials"],plans:["operations/entitlement-plans","plans"],memberships:["operations/entitlements","entitlements"],rescues:["association/membership-rescues","rescues"],allocations:["association/sponsorship-allocations","allocations"],invitations:["association/sponsorship-invitations","invitations"],events:["operations/events","events"],tickets:[`association/events/${event}/tickets`,"tickets"],promotions:["association/promotions","promotions"],registrations:[`association/events/${event}/registrations`,"registrations"],waitlist:["association/waitlist","submissions"],receipts:["association/provider-receipts","receipts"],audit:["operations/audit","entries"],deliveries:["operations/event-delivery","events"]} as const;
  const [path,key]=catalog[resource];
  const params=new URLSearchParams(resource==="tickets"?{}:{limit:"50"});
  for(const [name,value] of Object.entries(query)) if(value!==undefined && !(name==="eventId" && ["tickets","registrations"].includes(resource))) params.set(name,String(value));
  const response=await request<Record<string,unknown>>(`${base}/${path}?${params}`);
  const items=response[key],cursor=resource==="tickets"?null:response.nextCursor;
  if(!Array.isArray(items) || (cursor!==null && typeof cursor!=="string")) throw new AssociationApiError("invalid_response",502);
  return {items:items as Rows[K][],nextCursor:cursor};
}
export function retryAssociationProviderReceipt(workspaceId:string,receiptId:string) {
  return request<{result:Record<string,unknown>;receipt:AssociationProviderReceipt}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/provider-receipts/${encodeURIComponent(receiptId)}/retry`,{});
}
export type AssociationPlanSave = Omit<AssociationPlan,"id"|"planKey"|"feeMinor"|"provider"|"providerPlanId"> & {key:string;feeMinor:number;provider?:string;providerPlanId?:string};
export function saveAssociationPlan(workspaceId:string,input:AssociationPlanSave) {
  return request<{record:AssociationPlan}>(`/api/crm/${encodeURIComponent(workspaceId)}/operations/entitlement-plans`,input);
}
export type AssociationMembershipRescueCreate = {contactId:string;planId:string;idempotencyKey:string;startsAt:string;endsAt:string;dueAt:string;reason:string};
export function createAssociationMembershipRescue(workspaceId:string,input:AssociationMembershipRescueCreate) {
  return request<{rescue:AssociationMembershipRescue;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-rescues`,input);
}
export function settleAssociationMembershipRescue(workspaceId:string,rescueId:string,input:{requestId:string;method:"bank_transfer"|"cash"|"cheque"|"other";evidenceReference:string;amountMinor:number;currency:string;occurredAt:string;note?:string|null}) {
  return request<{rescue:AssociationMembershipRescue;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-rescues/${encodeURIComponent(rescueId)}/settle`,input);
}
export function reverseAssociationMembershipRescue(workspaceId:string,rescueId:string,input:{requestId:string;evidenceReference:string;amountMinor:number;currency:string;occurredAt:string;reason:string}) {
  return request<{rescue:AssociationMembershipRescue;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-rescues/${encodeURIComponent(rescueId)}/reverse`,input);
}
export function cancelAssociationMembershipRescue(workspaceId:string,rescueId:string,input:{requestId:string;reason:string}) {
  return request<{rescue:AssociationMembershipRescue;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-rescues/${encodeURIComponent(rescueId)}/cancel`,input);
}
export function createAssociationSponsorshipAllocation(workspaceId:string,input:{sponsorContactId:string;sponsorMembershipId:string;
  beneficiaryPlanId:string;idempotencyKey:string;seatLimit:number;startsAt:string;endsAt:string;invitationTtlHours:number}){
  return request<{allocation:AssociationSponsorshipAllocation;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/sponsorship-allocations`,input);
}
export function cancelAssociationSponsorshipAllocation(workspaceId:string,id:string,input:{requestId:string;reason:string}){
  return request<{allocation:AssociationSponsorshipAllocation;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/sponsorship-allocations/${encodeURIComponent(id)}/cancel`,input);
}
export function issueAssociationSponsorshipInvitation(workspaceId:string,input:{allocationId:string;nomineeContactId:string;idempotencyKey:string}){
  return request<{invitation:AssociationSponsorshipInvitation;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/sponsorship-invitations`,input);
}
export function revokeAssociationSponsorshipInvitation(workspaceId:string,id:string,input:{requestId:string;reason:string}){
  return request<{invitation:AssociationSponsorshipInvitation;created:boolean}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/sponsorship-invitations/${encodeURIComponent(id)}/revoke`,input);
}
export function saveAssociationEvent(workspaceId:string,input:Omit<AssociationEvent,"id">) {
  return request<{record:AssociationEvent}>(`/api/crm/${encodeURIComponent(workspaceId)}/operations/events`,input);
}
export function saveAssociationTicket(workspaceId:string,eventId:string,input:Omit<AssociationTicket,"id"|"priceMinor"|"memberPriceMinor"|"reservedCount"|"available"> & {priceMinor:number;memberPriceMinor:number|null}) {
  return request<{ticket:AssociationTicket}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/events/${encodeURIComponent(eventId)}/tickets`,input);
}
export type AssociationPromotionSave = Omit<AssociationPromotion,"id"|"hasCode"|"reservedUses"|"redeemedUses"|"createdAt"|"updatedAt"|"percentageBasisPoints"|"amountMinor"|"buyQuantity"|"getQuantity"|"maxUses"|"maxUsesPerContact"> & {
  code?:string;percentageBasisPoints:number|null;amountMinor:number|null;buyQuantity:number|null;getQuantity:number|null;maxUses:number|null;maxUsesPerContact:number|null;
};
export function saveAssociationPromotion(workspaceId:string,input:AssociationPromotionSave) {
  return request<{promotion:AssociationPromotion}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/promotions`,input);
}
export type AssociationReservation = {contactId:string;idempotencyKey:string;reservationMinutes:number;lines:Array<{ticketId:string;quantity:number;useMemberPrice:boolean;attendees:Array<{contactId?:string;name:string;email?:string}>}>};
export function reserveAssociationOrder(workspaceId:string,input:AssociationReservation) {
  return request<{order:AssociationOrder}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders`,input);
}
export async function checkInAssociationAttendee(workspaceId:string,registrationId:string) {
  const response=await authFetch(`${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/association/registrations/${encodeURIComponent(registrationId)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"checked_in"})});
  if(!response.ok) throw new AssociationApiError("save_failed",response.status);
}
export function correctAssociationCheckIn(workspaceId:string,registrationId:string,expectedStatus:"checked_in"|"attended",reason:string) {
  return request<{registration:AssociationRegistration}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/registrations/${encodeURIComponent(registrationId)}/check-in-correction`,{expectedStatus,reason});
}
export function offerAssociationPlace(workspaceId:string,submissionId:string,input:{promotionId:string;reservationMinutes:number;useMemberPrice:boolean}) {
  return request<{offer:{orderId:string}}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/waitlist/${encodeURIComponent(submissionId)}/offer`,input);
}

const associationCsvCell=(value:string)=>`"${(/^[\s]*[=+@-]/.test(value)?"'":"")+value.replace(/"/g,'""')}"`;
const associationRosterCell=(value:unknown)=>associationCsvCell(value===null||value===undefined?"":typeof value==="string"?value:typeof value==="object"?(JSON.stringify(value)??""):String(value));

/** Complete, fail-closed export from the existing authorized member read plane. */
export async function exportAssociationAttendees(workspaceId:string,eventId:string,purposeKey:string):Promise<string> {
  const {fetchCrmRecord,checkCrmSendability}=await import("./crm");
  const contacts=new Map<string,Promise<string|null>>();
  const lines=[["registrationId","contactId","name","email","status"].join(",")];
  const seen=new Set<string>();let cursor:string|undefined;
  do {
    const page=await listAssociationPage(workspaceId,"registrations",{eventId,cursor});
    // Bound request concurrency and retain each current contact assessment once.
    for(let offset=0;offset<page.items.length;offset+=8) {
      const rows=await Promise.all(page.items.slice(offset,offset+8).map(async row=>{
        if(!row.attendeeContactId || !["confirmed","checked_in","registered","attended"].includes(row.status)) return null;
        const id=row.attendeeContactId;
        if(!contacts.has(id)) contacts.set(id,(async()=>{
          const [person,verdict]=await Promise.all([fetchCrmRecord(workspaceId,id),checkCrmSendability(workspaceId,id,"email",purposeKey)]);
          return person?.record.kind==="contact" && !person.record.archivedAt && verdict.verdict==="allowed" ? person.record.email : null;
        })());
        const email=await contacts.get(id)!;
        if(!email || email.trim().toLowerCase()!==row.attendeeEmail?.trim().toLowerCase()) return null;
        return [row.id,id,row.attendeeName,email,row.status].map(associationCsvCell).join(",");
      }));
      lines.push(...rows.filter((row):row is string=>row!==null));
    }
    if(page.nextCursor && seen.has(page.nextCursor)) throw new AssociationApiError("invalid_cursor",502);
    if(page.nextCursor) seen.add(page.nextCursor);
    cursor=page.nextCursor ?? undefined;
  } while(cursor);
  return lines.join("\r\n")+"\r\n";
}

/** Owner/admin event-operations roster. Marketing consent is evidence, never an inclusion filter. */
export async function exportAssociationOperationalRoster(workspaceId:string,eventId:string):Promise<string> {
  const columns:Array<[string,keyof AssociationOperationalRosterRow]>=[
    ["registrationId","id"],["eventId","eventId"],["orderId","orderId"],["orderLineId","orderLineId"],
    ["ticketId","ticketId"],["ticketKey","ticketKey"],["ticketName","ticketName"],["buyerContactId","buyerContactId"],
    ["attendeeContactId","attendeeContactId"],["attendeeName","attendeeName"],["attendeeEmail","attendeeEmail"],
    ["phone","phone"],["organisation","organisation"],["jobTitle","jobTitle"],["registrationStatus","status"],
    ["checkedInAt","checkedInAt"],["sourceKind","sourceKind"],["sourceId","sourceId"],["historicalImport","historicalImport"],
    ["marketingConsent","marketingConsent"],["ticketingConsent","ticketingConsent"],["policyVersion","policyVersion"],
    ["policyAcceptedAt","policyAcceptedAt"],["questionResponses","questionResponses"],["createdAt","createdAt"],["updatedAt","updatedAt"],
  ];
  const lines=[columns.map(([label])=>associationCsvCell(label)).join(",")],seen=new Set<string>();let cursor:string|undefined;
  do {
    const params=new URLSearchParams({limit:"100",...(cursor?{cursor}:{})});
    const page=await request<{registrations:AssociationOperationalRosterRow[];nextCursor:string|null}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/events/${encodeURIComponent(eventId)}/operational-roster?${params}`);
    if(!Array.isArray(page.registrations)||(page.nextCursor!==null&&typeof page.nextCursor!=="string")
      ||page.registrations.some(row=>!row||typeof row.id!=="string"||typeof row.eventId!=="string"))throw new AssociationApiError("invalid_response",502);
    lines.push(...page.registrations.map(row=>columns.map(([,key])=>associationRosterCell(row[key])).join(",")));
    if(page.nextCursor&&seen.has(page.nextCursor))throw new AssociationApiError("invalid_cursor",502);
    if(page.nextCursor)seen.add(page.nextCursor);
    cursor=page.nextCursor??undefined;
  }while(cursor);
  return lines.join("\r\n")+"\r\n";
}

export type MembershipLocale = "en"|"zh-Hant"|"zh-Hans";
export type MembershipSite = "oasa"|"sea";
export type MembershipCopy = { name:string;summary:string;audience:string;badge:string;description:string;eligibility:string;benefits:string[];actionLabel:string;billingLabel:string;documents:{label:string;href:string}[] };
export type WebsiteMembershipPlan = { key:string;planId?:string;currency:"HKD";feeMinor:number;billingPeriod:"one_time"|"annual"|"lifetime"|"manual";activeFrom:string|null;activeTo:string|null;
  availability:"public"|"invitation"|"enquiry"|"closed";application:{type:"application"|"enquiry";proposerRequired:boolean;codeOfConduct:true;reviewPipeline?:"charter-review"};
  sites:MembershipSite[];group:string;order:number;i18n:Record<MembershipLocale,MembershipCopy>;overrides:Partial<Record<MembershipSite,Partial<Record<MembershipLocale,Partial<MembershipCopy>>>>>;promotionId:string|null };
export type MembershipPageCopy = {title:string;intro:string;groups:{id:string;title:string;intro:string}[];sections:{id:string;title:string;image?:{src:string;alt:string};paragraphs:string[];bullets:string[];documents:{label:string;href:string}[]}[];newsletter?:{name:string;summary:string;benefits:string[];actionLabel:string}};
export type MembershipCatalogueDocument = {schemaVersion:1;plans:WebsiteMembershipPlan[];pages:Record<MembershipSite,Record<MembershipLocale,MembershipPageCopy>>};
export type MembershipCatalogueDraft = { version:number;document:MembershipCatalogueDocument|null;publishedRevision:number;
  published:MembershipCatalogueDocument|null;issues:string[];observations:Record<string,{revision:number;observedAt:string}> };
export async function getMembershipCatalogueDraft(workspaceId:string):Promise<MembershipCatalogueDraft> {
  return (await request<{catalogue:MembershipCatalogueDraft}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-catalogue/draft`)).catalogue;
}
export function saveMembershipCatalogueDraft(workspaceId:string,expectedVersion:number,document:MembershipCatalogueDocument) {
  return request(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-catalogue/draft`,{expectedVersion,document});
}
export function publishMembershipCatalogue(workspaceId:string,expectedVersion:number) {
  return request(`/api/crm/${encodeURIComponent(workspaceId)}/association/membership-catalogue/publish`,{expectedVersion});
}

export type ProgrammeAudience = "corporates"|"schools"|"students";
export type ProgrammeGallery = "spacebiz-dialogues"|"young-marco-polo"|"internship"|"space-exchange-tour"|"newspace-101"|"annual-conference";
export const PROGRAMME_AUDIENCES:readonly ProgrammeAudience[] = ["corporates","schools","students"];
export const PROGRAMME_GALLERIES:readonly ProgrammeGallery[] = ["spacebiz-dialogues","young-marco-polo","internship","space-exchange-tour","newspace-101","annual-conference"];
export type ProgrammeSubsection = { id:string;heading:string;paragraphs:string[];bullets:string[];numbered:string[];quote?:{text:string;cite:string} };
export type ProgrammeSection = ProgrammeSubsection & { subsections:ProgrammeSubsection[] };
export type ProgrammeCopy = { name:string;tagline:string;kicker:string;summary:string;audienceBlurbs:Partial<Record<ProgrammeAudience,string>>;sections:ProgrammeSection[];
  facts:{value:string;label:string}[];steps:{title:string;items:{title:string;text:string}[]}|null;feeUnit:string;feeNotes:string[];
  eligibility:{label:string;value:string}[];contacts:{label:string;name?:string;email:string}[];links:{label:string;href:string}[];
  cta:{heading:string;text:string;href:string;label:string;secondary?:{label:string;href:string}}|null;
  /** Describes a media library cover in this language. */
  coverAlt?:string };
export type WebsiteProgramme = { slug:string;audiences:ProgrammeAudience[];order:number;sites:MembershipSite[];status:"live"|"coming-soon"|"retired";
  fee:{currency:"HKD";amountMinor:number}|null;gallery:ProgrammeGallery|null;cover:string|null;coverMediaId?:string|null;href:string|null;
  i18n:{en:ProgrammeCopy;"zh-Hant"?:ProgrammeCopy;"zh-Hans"?:ProgrammeCopy} };
export type ProgrammeCatalogueDocument = { schemaVersion:1;audiences:Record<ProgrammeAudience,{gallery:ProgrammeGallery;order:string[]}>;programmes:WebsiteProgramme[] };
export type ProgrammeCatalogueDraft = { version:number;document:ProgrammeCatalogueDocument|null;publishedRevision:number;
  published:ProgrammeCatalogueDocument|null;issues:string[];observations:Record<string,{revision:number;observedAt:string}> };
export async function getProgrammeCatalogueDraft(workspaceId:string):Promise<ProgrammeCatalogueDraft> {
  return (await request<{catalogue:ProgrammeCatalogueDraft}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/programme-catalogue/draft`)).catalogue;
}
export function saveProgrammeCatalogueDraft(workspaceId:string,expectedVersion:number,document:ProgrammeCatalogueDocument) {
  return request(`/api/crm/${encodeURIComponent(workspaceId)}/association/programme-catalogue/draft`,{expectedVersion,document});
}
export function publishProgrammeCatalogue(workspaceId:string,expectedVersion:number) {
  return request(`/api/crm/${encodeURIComponent(workspaceId)}/association/programme-catalogue/publish`,{expectedVersion});
}

/** Website media library: staff-uploaded images and PDFs the public sites render by id. */
export type WebsiteMedia = { id: string; name: string; mime: string; sizeBytes: number; updatedAt: string };
export const WEBSITE_MEDIA_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif,application/pdf";
export const WEBSITE_MEDIA_MAX_BYTES = 15 * 1024 * 1024;
const mediaBase = (workspaceId: string) => `/api/crm/${encodeURIComponent(workspaceId)}/association/media`;
export async function listWebsiteMedia(workspaceId: string): Promise<WebsiteMedia[]> {
  return (await request<{ media: WebsiteMedia[] }>(mediaBase(workspaceId))).media;
}
export async function uploadWebsiteMedia(workspaceId: string, files: File[]): Promise<Array<{ name: string; media?: WebsiteMedia; error?: string }>> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const response = await authFetch(`${API_URL}${mediaBase(workspaceId)}`, { method: "POST", body: form });
  const body = await response.json().catch(() => null);
  if (!response.ok && !Array.isArray(body?.results)) throw new AssociationApiError(typeof body?.error === "string" ? body.error : "upload_failed", response.status);
  return body.results;
}
export async function websiteMediaPreviewUrl(workspaceId: string, id: string): Promise<string> {
  return (await request<{ url: string }>(`${mediaBase(workspaceId)}/${encodeURIComponent(id)}/url`)).url;
}
export async function deleteWebsiteMedia(workspaceId: string, id: string): Promise<void> {
  const response = await authFetch(`${API_URL}${mediaBase(workspaceId)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new AssociationApiError(typeof body?.error === "string" ? body.error : "delete_failed", response.status);
  }
}

/** Website content collections (people, partners, settings, news, home pages): draft → preview → publish. */
export const SITE_CONTENT_COLLECTIONS = ["people", "partners", "settings", "news", "home-oasa", "home-sea", "event-pages"] as const;
export type SiteContentCollection = (typeof SITE_CONTENT_COLLECTIONS)[number];
export type SiteContentDocument = Record<string, unknown>;
export type SiteContentDraft = {
  collection: SiteContentCollection; version: number; document: SiteContentDocument | null; publishedRevision: number;
  published: SiteContentDocument | null; observations: Partial<Record<MembershipSite, { revision: number; observedAt: string }>>;
  readers: MembershipSite[]; issues: string[]; issueDetails?: WebsiteIssue[];
};
/** A coded publication issue the console translates; `message` is the English fallback. */
export type WebsiteIssue = { code: string; params: Record<string, string>; message: string };
const contentBase = (workspaceId: string, collection: SiteContentCollection) =>
  `/api/crm/${encodeURIComponent(workspaceId)}/association/site-content/${collection}`;
/**
 * Request bodies are NFKC-normalized server-side, which would rewrite compatibility characters staff mean to keep
 * (full-width CJK punctuation, non-breaking hyphens). Such characters travel as `\u{hex}` escapes (and `\` as `\\`);
 * website readers restore them. The console restores on read and escapes on save so staff only ever see the real text.
 */
export function restoreCompatText<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\\(\\|u\{([0-9a-fA-F]{1,6})\})/g, (_match, kind: string, hex?: string) => kind === "\\" ? "\\" : String.fromCodePoint(Number.parseInt(hex ?? "0", 16))) as T;
  if (Array.isArray(value)) return value.map(restoreCompatText) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreCompatText(entry)])) as T;
  return value;
}
export function preserveCompatText<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\\/g, "\\\\").replace(/[\s\S]/gu, char => char.normalize("NFKC") === char ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`) as T;
  if (Array.isArray(value)) return value.map(preserveCompatText) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preserveCompatText(entry)])) as T;
  return value;
}
export async function getSiteContentDraft(workspaceId: string, collection: SiteContentCollection): Promise<SiteContentDraft> {
  const content = (await request<{ content: SiteContentDraft }>(`${contentBase(workspaceId, collection)}/draft`)).content;
  return { ...content, document: restoreCompatText(content.document), published: restoreCompatText(content.published) };
}
export function saveSiteContentDraft(workspaceId: string, collection: SiteContentCollection, expectedVersion: number, document: SiteContentDocument) {
  return request(`${contentBase(workspaceId, collection)}/draft`, { expectedVersion, document: preserveCompatText(document) });
}
export function publishSiteContent(workspaceId: string, collection: SiteContentCollection, expectedVersion: number) {
  return request(`${contentBase(workspaceId, collection)}/publish`, { expectedVersion });
}

/** Publication summaries (no document bodies) for Home and Website → Pages & sections; readable by every workspace member. */
export type WebsitePublicationSummary = { version: number; publishedRevision: number; publishedAt: string | null; updatedAt: string | null;
  observations: Partial<Record<string, { revision: number; observedAt: string }>>; issueCount: number };
export type WebsiteStatus = {
  collections: Array<WebsitePublicationSummary & { collection: SiteContentCollection; readers: MembershipSite[] }>;
  programmes: WebsitePublicationSummary; membership: WebsitePublicationSummary;
};
export async function getWebsiteStatus(workspaceId: string): Promise<WebsiteStatus> {
  return (await request<{ status: WebsiteStatus }>(`/api/crm/${encodeURIComponent(workspaceId)}/association/website-status`)).status;
}
/** The site name staff see: the published settings name when present, else the site key upper-cased (never a name written in code). */
export function websiteSiteLabel(site: string, names?: Partial<Record<string, string>>): string {
  return names?.[site]?.trim() || site.toUpperCase();
}

/** Event pages (website content collection `event-pages`): one page per event slug, sections in display order. */
export type LocalizedCopy = { en: string; "zh-Hant"?: string; "zh-Hans"?: string };
export type WebsiteImage = { mediaId?: string; src?: string; alt: LocalizedCopy };
export type EventSection = { id: string; hidden: boolean } & (
  | { kind: "text"; heading?: LocalizedCopy; body: LocalizedCopy }
  | { kind: "image"; image: WebsiteImage; caption?: LocalizedCopy }
  | { kind: "gallery"; heading?: LocalizedCopy; images: WebsiteImage[] }
  | { kind: "speakers"; heading?: LocalizedCopy; people: { name: string; title?: LocalizedCopy; bio?: LocalizedCopy; photo?: WebsiteImage }[] }
  | { kind: "partners"; heading?: LocalizedCopy; partners: { name: string; logo?: WebsiteImage; href?: string }[] }
  | { kind: "agenda"; heading?: LocalizedCopy; items: { time: string; title: LocalizedCopy; detail?: LocalizedCopy }[] }
  | { kind: "faq"; heading?: LocalizedCopy; items: { question: LocalizedCopy; answer: LocalizedCopy }[] });
export type EventSectionKind = EventSection["kind"];
export const EVENT_SECTION_KINDS: readonly EventSectionKind[] = ["text", "image", "gallery", "speakers", "partners", "agenda", "faq"];
export type EventPageContent = { event: string; cover?: WebsiteImage; summary?: LocalizedCopy; sections: EventSection[] };
export type EventPagesDocument = { schemaVersion: 1; pages: EventPageContent[] };
