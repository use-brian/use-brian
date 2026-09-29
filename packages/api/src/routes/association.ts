/**
 * Credential-scoped association-operations API.
 *
 * The route intentionally has no workspace parameter: the authenticated Brain
 * credential supplies the only workspace the request may address. GET is
 * available to read credentials; every other method requires read_write.
 *
 * [COMP:api/association-route]
 */

import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { WorkspaceModuleError } from '../db/workspace-modules-store.js'
import {
  CrmOperationsError,
  CrmIntegrationScopeError,
  AssociationWaitlistOfferInputSchema,
  AssociationProviderBindingInputSchema,
  ProviderEntitlementEventSchema,
  ProviderReceiptStateSchema,
  type AssociationContext,
  type AssociationServicePort,
  type CrmOperationsActor,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from '@use-brian/core'
import { authenticateBrainRequest, type BrainAuth } from '../brain-mcp/auth.js'
import type { BrainKeyStore } from '../db/brain-keys-store.js'
import type { OAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import {
  AssociationError,
  ConsentInputSchema,
  EnquiryCreateSchema,
  EnquiryNoteInputSchema,
  EnquiryStatusSchema,
  EnquiryUpdateSchema,
  EventInputSchema,
  ExternalIdentityInputSchema,
  ListPageSchema,
  MembershipInputSchema,
  MembershipUpdateSchema,
  OrderCreateSchema,
  OrderStatusSchema,
  PlanInputSchema,
  ProviderEventInputSchema,
  ProviderFinancialEventInputSchema,
  RegistrationStatusSchema,
  RegistrationUpdateSchema,
  TicketInputSchema,
  type AssociationActor,
} from '../association/domain.js'
import { createAssociationService } from '../association/service.js'
import { createAssociationStore, type AssociationStore } from '../db/association-store.js'
import { getPool } from '../db/client.js'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { createCrmOperationsService } from '../crm-operations/service.js'
import { createProviderEntitlementInbox } from '../association/provider-entitlements.js'

type Options = {
  brainKeyStore: BrainKeyStore
  authorizationStore?: OAuthAuthorizationStore
  store?: AssociationStore
  crmService?: CrmOperationsServicePort
  associationService?: AssociationServicePort
  authenticate?: (req: Request) => Promise<BrainAuth | null>
}

const UUID = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const ProviderKey = StableKey
const truthyQuery = z.enum(['true', 'false']).transform((value) => value === 'true')

type AuthedResponse = Response & { locals: { associationAuth: BrainAuth } }

function actorFor(auth: BrainAuth): AssociationActor {
  return {
    credentialKind: auth.authKind,
    credentialId: auth.keyId,
    ...(auth.actingUserId ? { actingUserId: auth.actingUserId } : {}),
  }
}

function crmActorFor(auth: BrainAuth): CrmOperationsActor {
  if (auth.authKind === 'oauth_token') {
    return {
      kind: 'oauth_token', credentialId: auth.keyId,
      ...(auth.actingUserId ? { userId: auth.actingUserId } : {}),
    }
  }
  if (auth.authKind === 'home_app') {
    return {
      kind: 'home_app', credentialId: auth.keyId,
      ...(auth.actingUserId ? { userId: auth.actingUserId } : {}),
    }
  }
  return { kind: 'brain_key', credentialId: auth.keyId }
}

function crmContextFor(auth: BrainAuth): CrmOperationsContext {
  return {
    workspaceId: auth.workspaceId,
    actor: crmActorFor(auth),
    authority: {
      role: 'system',
      canWrite: auth.scope === 'read_write',
      canConfigure: false,
      trustedIdentitySources: [],
    },
  }
}

function associationContextFor(auth: BrainAuth): AssociationContext {
  const context = crmContextFor(auth)
  return { ...context, authority: { ...context.authority, canRead: true, canReconcileProvider: auth.scope === 'read_write' } }
}

/** Preserve the pre-existing catalog authority of these two legacy machine
 * endpoints. Ordinary CRM tools keep crmContextFor's canConfigure=false. */
function crmCatalogContextFor(auth: BrainAuth): CrmOperationsContext {
  const context = crmContextFor(auth)
  return { ...context, authority: { ...context.authority, canConfigure: auth.scope === 'read_write' } }
}

function associationMembership(
  workspaceId: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { providerEntitlementId, ...rest } = record
  return {
    workspaceId,
    ...rest,
    providerMembershipId: providerEntitlementId ?? null,
  }
}

function parsed<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  res: Response,
): z.output<Schema> | null {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  res.status(400).json({
    error: 'invalid_request',
    issues: result.error.issues.slice(0, 10).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  })
  return null
}

function listInput(value: unknown, res: Response) {
  const pagination = parsed(ListPageSchema, value, res)
  if (!pagination) return null
  return { ...pagination, cursor: pagination.cursor ?? null }
}

export function associationErrorResponse(error: unknown, res: Response): void {
  if ((error as { code?: string } | null)?.code === 'scope_operation_denied') {
    res.status(403).json({ error: 'scope_operation_denied',
      message: 'This operation is unavailable in your current scope. Ask a workspace administrator to review access.' })
    return
  }
  if (error instanceof CrmIntegrationScopeError) {
    res.status(403).json({ error: error.code, message: error.message, ...('details' in error ? { details: error.details } : {}) }); return
  }
  if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_input', issues: error.issues.slice(0, 10) }); return }
  if (error instanceof WorkspaceModuleError) {
    const status = error.code === 'not_authorized' ? 403 : error.code === 'not_found' ? 404
      : error.code === 'invalid_input' ? 422 : 409
    res.status(status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  if (error instanceof CrmOperationsError) {
    const status = error.code === 'credential_revoked' ? 401 : error.code === 'not_found' ? 404
      : error.code === 'conflict' || error.code === 'idempotency_conflict' ? 409
        : error.code === 'not_authorized' ? 403 : 422
    res.status(status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  if (error instanceof AssociationError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'conflict' || error.code === 'invalid_transition' ? 409
        : 422
    res.status(status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  console.error('[association] request failed')
  res.status(500).json({ error: 'association_request_failed' })
}

function endpoint(
  fn: (req: Request, res: AuthedResponse) => Promise<void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res as AuthedResponse)
    } catch (error) {
      associationErrorResponse(error, res)
    }
  }
}

export function associationRoutes(opts: Options): Router {
  const router = Router()
  const store = opts.store ?? (() => {
    const pool = getPool()
    return createAssociationStore(pool, undefined, {
      providerEntitlements: createProviderEntitlementInbox(pool),
    })
  })()
  const crmService = opts.crmService ?? createCrmOperationsService(createDbCrmOperationsStore())
  const associationService = opts.associationService ?? createAssociationService({ store, crmService })
  const authenticate = opts.authenticate ?? ((req: Request) =>
    authenticateBrainRequest(req, {
      brainKeyStore: opts.brainKeyStore,
      authorizationStore: opts.authorizationStore,
    }))

  router.use(async (req, res, next) => {
    try {
      const auth = await authenticate(req)
      if (!auth) {
        res.status(401).json({ error: 'invalid_brain_credential' })
        return
      }
      if (req.method !== 'GET' && auth.scope !== 'read_write') {
        res.status(403).json({ error: 'read_write_scope_required' })
        return
      }
      ;(res.locals as { associationAuth: BrainAuth }).associationAuth = auth
      next()
    } catch (error) {
      next(error)
    }
  })

  router.post('/external-identities', endpoint(async (req, res) => {
    const input = parsed(ExternalIdentityInputSchema, req.body, res)
    if (!input) return
    const result = await store.linkExternalIdentity(
      res.locals.associationAuth.workspaceId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ identity: result.record, created: result.created })
  }))

  router.get('/external-identities/resolve', endpoint(async (req, res) => {
    const input = parsed(z.object({
      provider: ProviderKey,
      providerSubject: z.string().trim().min(1).max(500),
    }), req.query, res)
    if (!input) return
    const identity = await store.resolveExternalIdentity(
      res.locals.associationAuth.workspaceId,
      input.provider,
      input.providerSubject,
    )
    if (!identity) {
      res.status(404).json({ error: 'not_found', message: 'external identity not found' })
      return
    }
    res.json({ identity })
  }))

  router.post('/enquiries', endpoint(async (req, res) => {
    const input = parsed(EnquiryCreateSchema, req.body, res)
    if (!input) return
    const result = await store.createEnquiry(
      res.locals.associationAuth.workspaceId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ enquiry: result.record, created: result.created })
  }))

  router.get('/enquiries', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
      createdAfter: z.string().datetime({ offset: true }).optional(),
      createdBefore: z.string().datetime({ offset: true }).optional(),
      status: EnquiryStatusSchema.optional(),
      queueKey: StableKey.optional(),
      ownerUserId: UUID.optional(),
    }), req.query, res)
    if (!query) return
    const pagination = listInput(query, res)
    if (!pagination) return
    const result = await store.listEnquiries(res.locals.associationAuth.workspaceId, {
      ...pagination,
      ...(query.status ? { status: query.status } : {}),
      ...(query.queueKey ? { queueKey: query.queueKey } : {}),
      ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
    })
    res.json({ enquiries: result.items, nextCursor: result.nextCursor })
  }))

  router.patch('/enquiries/:id', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    const input = parsed(EnquiryUpdateSchema, req.body, res)
    if (!id || !input) return
    const enquiry = await store.updateEnquiry(
      res.locals.associationAuth.workspaceId,
      id,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.json({ enquiry })
  }))

  router.post('/enquiries/:id/notes', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    const input = parsed(EnquiryNoteInputSchema, req.body, res)
    if (!id || !input) return
    const note = await store.addEnquiryNote(
      res.locals.associationAuth.workspaceId,
      id,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(201).json({ note })
  }))

  router.get('/enquiries/:id/notes', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    if (!id) return
    const notes = await store.listEnquiryNotes(res.locals.associationAuth.workspaceId, id)
    res.json({ notes })
  }))

  router.post('/consents', endpoint(async (req, res) => {
    const input = parsed(ConsentInputSchema, req.body, res)
    if (!input) return
    const result = await store.appendConsent(
      res.locals.associationAuth.workspaceId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ consent: result.record, created: result.created })
  }))

  router.get('/contacts/:contactId/consents', endpoint(async (req, res) => {
    const contactId = parsed(UUID, req.params.contactId, res)
    if (!contactId) return
    const result = await store.listConsents(res.locals.associationAuth.workspaceId, contactId)
    res.json(result)
  }))

  router.post('/plans', endpoint(async (req, res) => {
    const input = parsed(PlanInputSchema, req.body, res)
    if (!input) return
    const result = await crmService.execute(crmCatalogContextFor(res.locals.associationAuth), {
      kind: 'save_entitlement_plan', ...input,
    })
    res.status(result.created ? 201 : 200).json({ plan: result.record, created: result.created })
  }))

  router.get('/plans', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
      createdAfter: z.string().datetime({ offset: true }).optional(),
      createdBefore: z.string().datetime({ offset: true }).optional(),
      published: truthyQuery.optional(),
    }), req.query, res)
    if (!query) return
    const pagination = listInput(query, res)
    if (!pagination) return
    const result = await store.listPlans(res.locals.associationAuth.workspaceId, {
      ...pagination,
      ...(query.published !== undefined ? { published: query.published } : {}),
    })
    res.json({ plans: result.items, nextCursor: result.nextCursor })
  }))

  router.post('/memberships', endpoint(async (req, res) => {
    const input = parsed(MembershipInputSchema, req.body, res)
    if (!input) return
    const output = await crmService.execute(crmContextFor(res.locals.associationAuth), {
      kind: 'grant_entitlement',
      contactId: input.contactId,
      planId: input.planId,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      renewalMode: input.renewalMode,
      provider: input.provider,
      providerEntitlementId: input.providerMembershipId,
      providerPeriodId: input.providerPeriodId, predecessorId: input.predecessorId,
    })
    res.status(output.created ? 201 : 200).json({
      membership: associationMembership(res.locals.associationAuth.workspaceId, output.record),
      created: output.created,
    })
  }))

  router.get('/contacts/:contactId/memberships', endpoint(async (req, res) => {
    const contactId = parsed(UUID, req.params.contactId, res)
    if (!contactId) return
    const filters = parsed(z.object({
      activeOnly: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
      effectiveAt: z.string().datetime({ offset: true }).optional(),
    }).strict(), req.query, res)
    if (!filters) return
    const memberships = await store.listMemberships(res.locals.associationAuth.workspaceId, contactId, filters)
    res.json({ memberships })
  }))

  router.patch('/memberships/:id', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    const input = parsed(MembershipUpdateSchema, req.body, res)
    if (!id || !input) return
    const output = await crmService.execute(crmContextFor(res.locals.associationAuth), {
      kind: 'update_entitlement', entitlementId: id, ...input,
    })
    res.json({
      membership: associationMembership(res.locals.associationAuth.workspaceId, output.record),
    })
  }))

  router.post('/events', endpoint(async (req, res) => {
    const input = parsed(EventInputSchema, req.body, res)
    if (!input) return
    const result = await crmService.execute(crmCatalogContextFor(res.locals.associationAuth), {
      kind: 'save_event', ...input,
    })
    res.status(result.created ? 201 : 200).json({ event: result.record, created: result.created })
  }))

  router.get('/events', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
      createdAfter: z.string().datetime({ offset: true }).optional(),
      createdBefore: z.string().datetime({ offset: true }).optional(),
      status: z.enum(['draft', 'published', 'cancelled', 'completed']).optional(),
    }), req.query, res)
    if (!query) return
    const pagination = listInput(query, res)
    if (!pagination) return
    const result = await store.listEvents(res.locals.associationAuth.workspaceId, {
      ...pagination,
      ...(query.status ? { status: query.status } : {}),
    })
    res.json({ events: result.items, nextCursor: result.nextCursor })
  }))

  router.post('/events/:eventId/tickets', endpoint(async (req, res) => {
    const eventId = parsed(UUID, req.params.eventId, res)
    const ticket = parsed(TicketInputSchema, req.body, res)
    if (!eventId || !ticket) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'save_ticket', eventId, ticket })
    res.status(result.created ? 201 : 200).json({ ticket: result.record, created: result.created })
  }))

  router.get('/events/:eventId/tickets', endpoint(async (req, res) => {
    const eventId = parsed(UUID, req.params.eventId, res)
    if (!eventId) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'list_tickets', eventId })
    res.json({ tickets: result.items })
  }))

  router.get('/events/:eventId/registrations', endpoint(async (req, res) => {
    const eventId = parsed(UUID, req.params.eventId, res)
    const query = parsed(ListPageSchema.extend({ status: RegistrationStatusSchema.optional() }), req.query, res)
    if (!eventId || !query) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'list_registrations', eventId, ...query })
    res.json({ registrations: result.items, nextCursor: result.nextCursor })
  }))

  router.patch('/registrations/:id', endpoint(async (req, res) => {
    const registrationId = parsed(UUID, req.params.id, res)
    const update = parsed(RegistrationUpdateSchema, req.body, res)
    if (!registrationId || !update) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'update_registration', registrationId, update })
    res.json({ registration: result.record })
  }))

  router.get('/waitlist', endpoint(async (req, res) => {
    const query = parsed(ListPageSchema.extend({ eventId: UUID.optional(), includeClosed: truthyQuery.optional() }), req.query, res)
    if (!query) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'list_waitlist', ...query, includeClosed: query.includeClosed ?? false })
    res.json({ submissions: result.items, nextCursor: result.nextCursor })
  }))

  router.post('/waitlist/:id/offer', endpoint(async (req, res) => {
    const offer = parsed(AssociationWaitlistOfferInputSchema, { ...req.body, submissionId: req.params.id }, res)
    if (!offer) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'offer_waitlist_place', offer })
    res.status(result.created ? 201 : 200).json({ offer: result.record, created: result.created })
  }))

  router.post('/orders', endpoint(async (req, res) => {
    const order = parsed(OrderCreateSchema, req.body, res)
    if (!order) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'create_order', order })
    res.status(result.created ? 201 : 200).json({ order: result.record, created: result.created })
  }))

  router.get('/orders', endpoint(async (req, res) => {
    const query = parsed(ListPageSchema.extend({ eventId: UUID.optional(), contactId: UUID.optional(), status: OrderStatusSchema.optional() }), req.query, res)
    if (!query) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'list_orders', ...query })
    res.json({ orders: result.items, nextCursor: result.nextCursor, financialSummary: result.financialSummary })
  }))

  router.post('/orders/:id/provider-binding', endpoint(async (req, res) => {
    const orderId = parsed(UUID, req.params.id, res)
    const binding = parsed(AssociationProviderBindingInputSchema, req.body, res)
    if (!orderId || !binding) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'bind_order_provider', orderId, binding })
    res.status(result.created ? 201 : 200).json({ order: result.record, created: result.created })
  }))

  router.get('/orders/:id', endpoint(async (req, res) => {
    const orderId = parsed(UUID, req.params.id, res)
    if (!orderId) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'get_order', orderId })
    res.json({ order: result.record })
  }))

  for (const [path, kind] of [['cancel', 'cancel_order'], ['confirm-free', 'confirm_free_order']] as const) {
    router.post(`/orders/:id/${path}`, endpoint(async (req, res) => {
      const orderId = parsed(UUID, req.params.id, res)
      if (!orderId) return
      const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind, orderId })
      res.json({ order: result.record, changed: result.created })
    }))
  }

  router.post('/orders/:id/provider-events', endpoint(async (req, res) => {
    const orderId = parsed(UUID, req.params.id, res)
    const event = parsed(ProviderEventInputSchema, req.body, res)
    if (!orderId || !event) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'reconcile_provider_event', orderId, event })
    res.status(result.created ? 201 : 200).json({ order: result.record, reconciled: result.created, ...(result.receipt ? { receipt: result.receipt } : {}) })
  }))

  router.post('/orders/:id/provider-financial-events', endpoint(async (req, res) => {
    const orderId = parsed(UUID, req.params.id, res)
    const event = parsed(ProviderFinancialEventInputSchema, req.body, res)
    if (!orderId || !event) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'reconcile_provider_financial_event', orderId, event })
    res.status(result.created ? 201 : 200).json({ order: result.record, reconciled: result.created, ...(result.receipt ? { receipt: result.receipt } : {}) })
  }))

  router.post('/provider-entitlement-events', endpoint(async (req, res) => {
    const event = parsed(ProviderEntitlementEventSchema, req.body, res)
    if (!event) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'reconcile_provider_entitlement', event })
    res.status(result.created ? 201 : 200).json({ entitlement: result.record, created: result.created, receipt: result.receipt })
  }))
  router.get('/provider-receipts', endpoint(async (req, res) => {
    const query = parsed(ListPageSchema.extend({ orderId: UUID.optional(), entitlementId: UUID.optional(), state: ProviderReceiptStateSchema.optional() }), req.query, res)
    if (!query) return
    const result = await associationService.execute(associationContextFor(res.locals.associationAuth), { kind: 'list_provider_receipts', ...query })
    res.json({ receipts: result.items, nextCursor: result.nextCursor })
  }))

  router.get('/notifications', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
      createdAfter: z.string().datetime({ offset: true }).optional(),
      createdBefore: z.string().datetime({ offset: true }).optional(),
      status: z.enum(['pending', 'sending', 'sent', 'failed', 'suppressed', 'retired']).optional(),
    }), req.query, res)
    if (!query) return
    const pagination = listInput(query, res)
    if (!pagination) return
    const result = await store.listNotifications(res.locals.associationAuth.workspaceId, {
      ...pagination,
      ...(query.status ? { status: query.status } : {}),
    })
    res.json({ notifications: result.items, nextCursor: result.nextCursor })
  }))

  return router
}
