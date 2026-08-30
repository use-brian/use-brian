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
import {
  CrmOperationsError,
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
  decodeAssociationCursor,
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
  PlanInputSchema,
  ProviderEventInputSchema,
  RegistrationStatusSchema,
  RegistrationUpdateSchema,
  TicketInputSchema,
  type AssociationActor,
} from '../association/domain.js'
import { createAssociationStore, type AssociationStore } from '../db/association-store.js'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { createCrmOperationsService } from '../crm-operations/service.js'

type Options = {
  brainKeyStore: BrainKeyStore
  authorizationStore?: OAuthAuthorizationStore
  store?: AssociationStore
  crmService?: CrmOperationsServicePort
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

function associationRegistration(
  workspaceId: string,
  record: Record<string, unknown>,
  status: 'cancelled' | 'checked_in',
): Record<string, unknown> {
  const { contactId, metadata, ...rest } = record
  return {
    workspaceId,
    ...rest,
    attendeeContactId: contactId ?? null,
    attendeeMetadata: metadata ?? {},
    orderId: null,
    orderLineId: null,
    ticketId: null,
    reservationExpiresAt: null,
    status,
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
  const cursor = decodeAssociationCursor(pagination.cursor)
  if (pagination.cursor && !cursor) {
    res.status(400).json({ error: 'invalid_cursor' })
    return null
  }
  return { limit: pagination.limit, cursor }
}

function errorResponse(error: unknown, res: Response): void {
  if (error instanceof CrmOperationsError) {
    const status = error.code === 'not_found' ? 404
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
  console.error('[association] request failed:', error)
  res.status(500).json({ error: 'association_request_failed' })
}

function endpoint(
  fn: (req: Request, res: AuthedResponse) => Promise<void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res as AuthedResponse)
    } catch (error) {
      errorResponse(error, res)
    }
  }
}

export function associationRoutes(opts: Options): Router {
  const router = Router()
  const store = opts.store ?? createAssociationStore()
  const crmService = opts.crmService ?? createCrmOperationsService(createDbCrmOperationsStore())
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
    const result = await store.upsertPlan(
      res.locals.associationAuth.workspaceId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ plan: result.record, created: result.created })
  }))

  router.get('/plans', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
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
    })
    res.status(output.created ? 201 : 200).json({
      membership: associationMembership(res.locals.associationAuth.workspaceId, output.record),
      created: output.created,
    })
  }))

  router.get('/contacts/:contactId/memberships', endpoint(async (req, res) => {
    const contactId = parsed(UUID, req.params.contactId, res)
    if (!contactId) return
    const memberships = await store.listMemberships(res.locals.associationAuth.workspaceId, contactId)
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
    const result = await store.upsertEvent(
      res.locals.associationAuth.workspaceId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ event: result.record, created: result.created })
  }))

  router.get('/events', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
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
    const input = parsed(TicketInputSchema, req.body, res)
    if (!eventId || !input) return
    const result = await store.upsertTicket(
      res.locals.associationAuth.workspaceId,
      eventId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ ticket: result.record, created: result.created })
  }))

  router.get('/events/:eventId/tickets', endpoint(async (req, res) => {
    const eventId = parsed(UUID, req.params.eventId, res)
    if (!eventId) return
    const tickets = await store.listTickets(res.locals.associationAuth.workspaceId, eventId)
    res.json({ tickets })
  }))

  router.get('/events/:eventId/registrations', endpoint(async (req, res) => {
    const eventId = parsed(UUID, req.params.eventId, res)
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
      status: RegistrationStatusSchema.optional(),
    }), req.query, res)
    if (!eventId || !query) return
    const pagination = listInput(query, res)
    if (!pagination) return
    const result = await store.listEventRegistrations(
      res.locals.associationAuth.workspaceId,
      eventId,
      { ...pagination, ...(query.status ? { status: query.status } : {}) },
    )
    res.json({ registrations: result.items, nextCursor: result.nextCursor })
  }))

  router.patch('/registrations/:id', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    const input = parsed(RegistrationUpdateSchema, req.body, res)
    if (!id || !input) return
    const management = await store.getRegistrationManagement(
      res.locals.associationAuth.workspaceId,
      id,
    )
    if (!management) throw new AssociationError('not_found', 'registration not found')
    const registration = management.sourceKind === 'commerce'
      ? await store.updateRegistration(
        res.locals.associationAuth.workspaceId,
        id,
        input,
        actorFor(res.locals.associationAuth),
      )
      : associationRegistration(
        res.locals.associationAuth.workspaceId,
        (await crmService.execute(crmContextFor(res.locals.associationAuth), {
          kind: 'update_participation',
          participationId: id,
          status: input.status === 'checked_in' ? 'attended' : 'cancelled',
        })).record,
        input.status,
      )
    res.json({ registration })
  }))

  router.post('/orders', endpoint(async (req, res) => {
    const input = parsed(OrderCreateSchema, req.body, res)
    if (!input) return
    const result = await store.createOrder(
      res.locals.associationAuth.workspaceId,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ order: result.record, created: result.created })
  }))

  router.get('/orders/:id', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    if (!id) return
    const order = await store.getOrder(res.locals.associationAuth.workspaceId, id)
    if (!order) {
      res.status(404).json({ error: 'not_found', message: 'order not found' })
      return
    }
    res.json({ order })
  }))

  router.post('/orders/:id/provider-events', endpoint(async (req, res) => {
    const id = parsed(UUID, req.params.id, res)
    const input = parsed(ProviderEventInputSchema, req.body, res)
    if (!id || !input) return
    const result = await store.reconcileProviderEvent(
      res.locals.associationAuth.workspaceId,
      id,
      input,
      actorFor(res.locals.associationAuth),
    )
    res.status(result.created ? 201 : 200).json({ order: result.record, reconciled: result.created })
  }))

  router.get('/notifications', endpoint(async (req, res) => {
    const query = parsed(z.object({
      limit: z.string().optional(),
      cursor: z.string().optional(),
      status: z.enum(['pending', 'sending', 'sent', 'failed', 'suppressed']).optional(),
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
