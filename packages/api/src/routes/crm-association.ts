/** Member and scoped integration adapters for the canonical vertical service.
 * [COMP:crm/association-service]
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AssociationCommandSchema, type AssociationContext, type AssociationServicePort } from '@use-brian/core'
import {
  WORKSPACE_MODULES,
  WORKSPACE_MODULE_ACTIONS,
  WorkspaceModuleError,
  isWorkspaceModuleKey,
  type WorkspaceModuleActionResult,
  type WorkspaceModuleDefinition,
  type WorkspaceModuleRegistry,
} from '@use-brian/shared'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { associationErrorResponse } from './association.js'
import type { WorkspaceModulesStore } from '../db/workspace-modules-store.js'

export type AssociationContextResolver = (req: Request, res: Response) => Promise<AssociationContext | null>
export function associationMemberContext(workspaces: WorkspaceStore): AssociationContextResolver {
  return async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    const workspaceId = z.string().uuid().safeParse(req.params.workspaceId)
    if (!workspaceId.success) { res.status(400).json({ error: 'invalid_workspace' }); return null }
    const role = await workspaces.getRole(req.userId, workspaceId.data)
    if (!role) { res.status(404).json({ error: 'workspace_not_found' }); return null }
    return { workspaceId: workspaceId.data, actor: { kind: 'user', userId: req.userId },
      authority: { role, canRead: true, canWrite: true, canConfigure: role === 'owner' || role === 'admin',
        canReconcileProvider: false, trustedIdentitySources: [] } }
  }
}

export function crmAssociationRoutes(options: { service: AssociationServicePort; context: AssociationContextResolver }): Router {
  const router = Router({ mergeParams: true })
  const route = (method: 'get' | 'post' | 'patch', path: string,
    command: (req: Request) => unknown, key: string) => {
    router[method](path, async (req, res) => {
      try {
        const context = await options.context(req, res)
        if (!context) return
        const input = AssociationCommandSchema.parse(command(req))
        const result = await options.service.execute(context, input)
        const createsResource = ['save_ticket', 'save_promotion', 'create_order', 'reserve_membership_checkout', 'reconcile_provider_event', 'reconcile_provider_financial_event', 'reconcile_provider_entitlement', 'bind_order_provider', 'bind_membership_checkout_provider', 'offer_waitlist_place', 'create_membership_rescue', 'create_sponsorship_allocation', 'issue_sponsorship_invitation', 'redeem_sponsorship_invitation'].includes(input.kind)
        res.status(result.created && createsResource ? 201 : 200).json({
          [key]: result.items ?? result.record, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
          ...(result.created !== undefined ? { created: result.created } : {}),
          ...(result.pendingOrders !== undefined ? { pendingOrders: result.pendingOrders } : {}),
          ...(result.financialSummary !== undefined ? { financialSummary: result.financialSummary } : {}),
          ...(result.receipt ? { receipt: result.receipt } : {}),
        })
      } catch (error) { associationErrorResponse(error, res) }
    })
  }
  route('get', '/membership-catalogue/draft', () => ({ kind: 'membership_catalogue_draft' }), 'catalogue')
  route('post', '/membership-catalogue/draft', req => ({ ...req.body, kind: 'save_membership_catalogue' }), 'catalogue')
  route('post', '/membership-catalogue/publish', req => ({ ...req.body, kind: 'publish_membership_catalogue' }), 'catalogue')
  route('get', '/membership-catalogue/:site', req => ({ kind: 'published_membership_catalogue', site: req.params.site }), 'catalogue')
  route('post', '/membership-catalogue/:site/observed', req => ({ ...req.body, kind: 'observe_membership_catalogue', site: req.params.site }), 'catalogue')
  route('get', '/programme-catalogue/draft', () => ({ kind: 'programme_catalogue_draft' }), 'catalogue')
  route('post', '/programme-catalogue/draft', req => ({ ...req.body, kind: 'save_programme_catalogue' }), 'catalogue')
  route('post', '/programme-catalogue/publish', req => ({ ...req.body, kind: 'publish_programme_catalogue' }), 'catalogue')
  route('get', '/programme-catalogue/:site', req => ({ kind: 'published_programme_catalogue', site: req.params.site }), 'catalogue')
  route('post', '/programme-catalogue/:site/observed', req => ({ ...req.body, kind: 'observe_programme_catalogue', site: req.params.site }), 'catalogue')
  route('get', '/site-content/:collection/draft', req => ({ kind: 'site_content_draft', collection: req.params.collection }), 'content')
  route('post', '/site-content/:collection/draft', req => ({ ...req.body, kind: 'save_site_content', collection: req.params.collection }), 'content')
  route('post', '/site-content/:collection/publish', req => ({ ...req.body, kind: 'publish_site_content', collection: req.params.collection }), 'content')
  route('get', '/site-content/:collection/:site', req => ({ kind: 'published_site_content', collection: req.params.collection, site: req.params.site }), 'content')
  route('post', '/site-content/:collection/:site/observed', req => ({ ...req.body, kind: 'observe_site_content', collection: req.params.collection, site: req.params.site }), 'content')
  route('get', '/website-status', () => ({ kind: 'website_status' }), 'status')
  route('get', '/module', () => ({ kind: 'module_status' }), 'module')
  route('get', '/module-blockers', (req) => ({ ...req.query, kind: 'module_blockers' }), 'orders')
  route('get', '/events/:eventId/tickets', (req) => ({ kind: 'list_tickets', eventId: req.params.eventId }), 'tickets')
  route('post', '/events/:eventId/tickets', (req) => ({ kind: 'save_ticket', eventId: req.params.eventId, ticket: req.body }), 'ticket')
  route('get', '/promotions', (req) => ({ ...req.query, kind: 'list_promotions' }), 'promotions')
  route('post', '/promotions', (req) => ({ kind: 'save_promotion', promotion: req.body }), 'promotion')
  route('get', '/events/:eventId/registrations', (req) => ({ ...req.query, kind: 'list_registrations', eventId: req.params.eventId }), 'registrations')
  route('get', '/events/:eventId/operational-roster', (req) => ({ ...req.query, kind: 'list_operational_roster', eventId: req.params.eventId }), 'registrations')
  route('patch', '/registrations/:id', (req) => ({ kind: 'update_registration', registrationId: req.params.id, update: req.body }), 'registration')
  route('post', '/registrations/:id/check-in-correction', (req) => ({ kind: 'correct_check_in', registrationId: req.params.id, correction: req.body }), 'registration')
  route('get', '/waitlist', req => ({ ...req.query, kind: 'list_waitlist',
    includeClosed: req.query.includeClosed === undefined ? false : z.enum(['true', 'false']).parse(req.query.includeClosed) === 'true' }), 'submissions')
  route('post', '/waitlist/:id/offer', req => ({ kind: 'offer_waitlist_place', offer: { ...req.body, submissionId: req.params.id } }), 'offer')
  route('get', '/orders', (req) => ({ ...req.query, kind: 'list_orders' }), 'orders')
  route('post', '/orders', (req) => ({ kind: 'create_order', order: req.body }), 'order')
  route('post', '/membership-checkouts', (req) => ({ kind: 'reserve_membership_checkout', checkout: req.body }), 'checkout')
  route('post', '/membership-checkouts/:id/provider-binding', (req) => ({ kind: 'bind_membership_checkout_provider', checkoutId: req.params.id, binding: req.body }), 'checkout')
  route('get', '/orders/:id', (req) => ({ kind: 'get_order', orderId: req.params.id }), 'order')
  route('get', '/orders/:id/notifications', (req) => ({ ...req.query, kind: 'list_order_notifications', orderId: req.params.id }), 'notifications')
  for (const [path, kind] of [['cancel', 'cancel_order'], ['confirm-free', 'confirm_free_order']] as const) {
    route('post', `/orders/:id/${path}`, (req) => {
      z.object({}).strict().parse(req.body ?? {})
      return { kind, orderId: req.params.id }
    }, 'order')
  }
  route('post', '/orders/:id/provider-events', (req) => ({ kind: 'reconcile_provider_event', orderId: req.params.id, event: req.body }), 'order')
  route('post', '/orders/:id/provider-financial-events', (req) => ({ kind: 'reconcile_provider_financial_event', orderId: req.params.id, event: req.body }), 'order')
  route('post', '/orders/:id/provider-binding', req => ({ kind: 'bind_order_provider', orderId: req.params.id, binding: req.body }), 'order')
  route('post', '/provider-entitlement-events', req => ({ kind: 'reconcile_provider_entitlement', event: req.body }), 'entitlement')
  route('get', '/provider-receipts', req => ({ ...req.query, kind: 'list_provider_receipts' }), 'receipts')
  route('post', '/provider-receipts/:id/retry', req => {
    z.object({}).strict().parse(req.body ?? {})
    return { kind: 'retry_provider_receipt', receiptId: req.params.id }
  }, 'result')
  route('get', '/membership-rescues', req => ({ ...req.query, kind: 'list_membership_rescues' }), 'rescues')
  route('post', '/membership-rescues', req => ({ kind: 'create_membership_rescue', rescue: req.body }), 'rescue')
  route('post', '/membership-rescues/:id/settle', req => ({ kind: 'settle_membership_rescue', rescueId: req.params.id, settlement: req.body }), 'rescue')
  route('post', '/membership-rescues/:id/reverse', req => ({ kind: 'reverse_membership_rescue', rescueId: req.params.id, reversal: req.body }), 'rescue')
  route('post', '/membership-rescues/:id/cancel', req => ({ kind: 'cancel_membership_rescue', rescueId: req.params.id, cancellation: req.body }), 'rescue')
  route('get', '/sponsorship-allocations', req => ({ ...req.query, kind: 'list_sponsorship_allocations' }), 'allocations')
  route('post', '/sponsorship-allocations', req => ({ kind: 'create_sponsorship_allocation', allocation: req.body }), 'allocation')
  route('post', '/sponsorship-allocations/:id/cancel', req => ({ kind: 'cancel_sponsorship_allocation', allocationId: req.params.id, cancellation: req.body }), 'allocation')
  route('get', '/sponsorship-invitations', req => ({ ...req.query, kind: 'list_sponsorship_invitations' }), 'invitations')
  route('post', '/sponsorship-invitations', req => ({ kind: 'issue_sponsorship_invitation', invitation: req.body }), 'invitation')
  route('post', '/sponsorship-invitations/:id/revoke', req => ({ kind: 'revoke_sponsorship_invitation', invitationId: req.params.id, revocation: req.body }), 'invitation')
  route('post', '/sponsorship-invitations/redeem', req => ({ kind: 'redeem_sponsorship_invitation', redemption: req.body }), 'membership')
  return router
}

function moduleWireProjection(definition: WorkspaceModuleDefinition,
  result: WorkspaceModuleActionResult): Record<string, number> {
  const compatibility = definition.blockingCountCompatibility
  if (!compatibility) return {}
  return { [compatibility.field]: result.blockingWork.find((row) => row.key === compatibility.blockerKey)?.count ?? 0 }
}

export function workspaceModuleRoutes(options: {
  workspaceStore: WorkspaceStore
  modules: WorkspaceModulesStore
  registry?: WorkspaceModuleRegistry
}): Router {
  const router = Router()
  const registry: WorkspaceModuleRegistry = options.registry ?? WORKSPACE_MODULES
  const context = associationMemberContext(options.workspaceStore)
  router.get('/:workspaceId/modules', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx || ctx.actor.kind !== 'user') return
      res.json({ registry, modules: await options.modules.listForMember(ctx.workspaceId, ctx.actor.userId) })
    } catch (error) { associationErrorResponse(error, res) }
  })
  router.post('/:workspaceId/modules/:moduleKey/actions', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx || ctx.actor.kind !== 'user') return
      if (!ctx.authority.canConfigure || !['owner', 'admin'].includes(ctx.authority.role)) {
        throw new WorkspaceModuleError('not_authorized', 'An owner or admin member is required')
      }
      const moduleKey = req.params.moduleKey
      if (!isWorkspaceModuleKey(moduleKey, registry)) {
        throw new WorkspaceModuleError('invalid_input', 'A registered workspace module is required.', { moduleKey })
      }
      const body = z.object({ action: z.enum(WORKSPACE_MODULE_ACTIONS), expectedVersion: z.number().int().nonnegative() }).strict().parse(req.body)
      const result = await options.modules.act(ctx.workspaceId, ctx.actor.userId, moduleKey, body)
      res.json({ ...moduleWireProjection(registry[moduleKey], result), module: result.module,
        changed: result.changed, blockingWork: result.blockingWork })
    } catch (error) { associationErrorResponse(error, res) }
  })
  return router
}
