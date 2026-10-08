import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AssociationCommandSchema, AssociationSourceMembershipImportSchema, AssociationSourceOrderImportSchema, type AssociationContext, type CrmOperationsServicePort } from '@use-brian/core'
import { createAssociationService } from '../service.js'
import type { AssociationStore } from '../../db/association-store.js'
import type { WorkspaceModulesStore } from '../../db/workspace-modules-store.js'

const workspaceId = randomUUID(), userId = randomUUID(), credentialId = randomUUID(), eventId = randomUUID(), orderId = randomUUID()
const member: AssociationContext = { workspaceId, actor: { kind: 'user', userId },
  authority: { role: 'member', canRead: true, canWrite: true, canConfigure: false, canReconcileProvider: false, trustedIdentitySources: [] } }
const command = (raw: unknown) => AssociationCommandSchema.parse(raw)
function fixture(role = "member") {
  const store = {
    createOrder: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true }),
    listOrders: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 7,
      financialSummary: [{ currency: 'USD', orderCount: 7, settledOrderCount: 2, subtotalMinor: '2100', discountMinor: '100', grossMinor: '2000', refundedMinor: '400', netMinor: '1600', pendingMinor: '500' }] }),
    listTickets: vi.fn().mockResolvedValue([]), getOrder: vi.fn().mockResolvedValue({ id: orderId }),
    listOperationalRoster: vi.fn().mockResolvedValue({ items: [{ id: orderId }], nextCursor: null }),
    listWaitlist: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    offerWaitlistPlace: vi.fn().mockResolvedValue({ record: { orderId }, created: true }),
    importSourceOrder: vi.fn().mockResolvedValue({ record: { id: orderId, sourceImport: true }, created: true }),
    importSourceMembership: vi.fn().mockResolvedValue({ record: { id: orderId, sourceImport: true }, created: true }),
    bindOrderProvider: vi.fn().mockResolvedValue({ record: { orderId }, created: true }),
    reconcileProviderEntitlement: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true, receipt: { state: 'applied' } }),
    listProviderReceipts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listNotifications: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    resolveProviderReceipt: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true, receipt: { state: 'applied' } }),
    listMembershipRescues: vi.fn().mockResolvedValue({ items: [{ id: orderId, status: 'outstanding' }], nextCursor: null }),
    createMembershipRescue: vi.fn().mockResolvedValue({ record: { id: orderId, status: 'outstanding' }, created: true }),
    settleMembershipRescue: vi.fn().mockResolvedValue({ record: { id: orderId, status: 'settled' }, created: true }),
    reverseMembershipRescue: vi.fn().mockResolvedValue({ record: { id: orderId, status: 'reversed' }, created: true }),
    cancelMembershipRescue: vi.fn().mockResolvedValue({ record: { id: orderId, status: 'cancelled' }, created: true }),
    listSponsorshipAllocations:vi.fn().mockResolvedValue({items:[],nextCursor:null}),
    createSponsorshipAllocation:vi.fn().mockResolvedValue({record:{id:orderId,status:'active'},created:true}),
    cancelSponsorshipAllocation:vi.fn().mockResolvedValue({record:{id:orderId,status:'cancelled'},created:true}),
    listSponsorshipInvitations:vi.fn().mockResolvedValue({items:[],nextCursor:null}),
    issueSponsorshipInvitation:vi.fn().mockResolvedValue({record:{id:orderId,status:'pending',redemptionToken:'x'.repeat(43)},created:true}),
    revokeSponsorshipInvitation:vi.fn().mockResolvedValue({record:{id:orderId,status:'revoked'},created:true}),
    redeemSponsorshipInvitation:vi.fn().mockResolvedValue({record:{id:orderId,status:'active'},created:true}),
    getRegistrationManagement: vi.fn().mockResolvedValue({ sourceKind: 'manual', eventId }),
    updateRegistration: vi.fn(), correctRegistrationCheckIn: vi.fn().mockResolvedValue({ id: orderId, status: 'confirmed' }),
    reconcileProviderEvent: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true }),
    reconcileProviderFinancialEvent: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true }),
    expireDueOrder: vi.fn(),
    cancelOrder: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true }), confirmFreeOrder: vi.fn(),
  }
  const crm = { execute: vi.fn().mockResolvedValue({ record: { id: orderId, contactId: userId, metadata: {} } }) }
  const modules = { act: vi.fn().mockResolvedValue({ module: { state: 'disabled' }, changed: true,
    blockingWork: [{ key: 'pending_orders', count: 0 }] }),
    get: vi.fn().mockResolvedValue({ state: 'disabled', version: 3 }) }
  return { store, crm, modules, service: createAssociationService({ store: store as unknown as AssociationStore,
    memberRole: async () => role, crmService: crm as CrmOperationsServicePort, modules: modules as unknown as WorkspaceModulesStore }) }
}
function integration(): AssociationContext {
  return { ...member, actor: { kind: 'integration_key', credentialId }, authority: { ...member.authority, role: 'system',
    integration: { credentialId, grants: [{ operation: 'association.read', selectors: { eventIds: [eventId] } }] } } }
}

describe('[COMP:crm/association-service] Canonical authority and adapters', () => {
  it('requires current human management role for direct and delegated staff reservation creation', async () => {
    const order = { contactId: userId, idempotencyKey: 'fictional-reservation', lines: [{ ticketId: eventId, quantity: 1, attendees: [{ name: 'Fictional guest' }] }] }
    const input = command({ kind: 'create_order', order })
    const delegated = { ...member, actor: { kind: 'assistant' as const, userId, assistantId: credentialId, sessionId: randomUUID() } }
    const denied = fixture()
    for (const actor of [member, delegated]) await expect(denied.service.execute(actor, input)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(denied.store.createOrder).not.toHaveBeenCalled()
    const allowed = fixture('owner')
    await allowed.service.execute({ ...member, authority: { ...member.authority, role: 'owner' } }, input)
    await allowed.service.execute(delegated, input)
    expect(allowed.store.createOrder).toHaveBeenCalledTimes(2)
  })
  it('keeps the website status summary a workspace member read', async () => {
    const f=fixture();
    await expect(f.service.execute(integration(),command({kind:'website_status'}))).rejects.toMatchObject({code:'not_authorized'});
  })
  it('restricts catalogue drafts and publication to configuration authority', async () => {
    const f=fixture();
    for(const context of [member,{...member,authority:{...member.authority,canConfigure:true}},integration()]) {
      await expect(f.service.execute(context,command({kind:'membership_catalogue_draft'}))).rejects.toMatchObject({code:'not_authorized'});
      await expect(f.service.execute(context,command({kind:'publish_membership_catalogue',expectedVersion:1}))).rejects.toBeDefined();
      await expect(f.service.execute(context,command({kind:'programme_catalogue_draft'}))).rejects.toMatchObject({code:'not_authorized'});
      await expect(f.service.execute(context,command({kind:'publish_programme_catalogue',expectedVersion:1}))).rejects.toBeDefined();
      await expect(f.service.execute(context,command({kind:'site_content_draft',collection:'people'}))).rejects.toMatchObject({code:'not_authorized'});
      await expect(f.service.execute(context,command({kind:'publish_site_content',collection:'people',expectedVersion:1}))).rejects.toBeDefined();
    }
  })

  it('serves published website content to association.read keys, and lets only a website reader acknowledge it', async () => {
    const siteContent = { draft: vi.fn(), save: vi.fn(), publish: vi.fn(),
      read: vi.fn().mockResolvedValue({ collection: 'partners', revision: 2, document: { schemaVersion: 1, partners: [] } }),
      observe: vi.fn().mockResolvedValue({ collection: 'partners', revision: 2, site: 'sea' }) }
    const f = fixture()
    const service = createAssociationService({ store: f.store as unknown as AssociationStore, crmService: f.crm as CrmOperationsServicePort,
      modules: f.modules as unknown as WorkspaceModulesStore, siteContent: siteContent as never })
    await expect(service.execute(integration(), command({ kind: 'published_site_content', collection: 'partners', site: 'sea' }))).resolves.toMatchObject({ record: { revision: 2 } })
    expect(siteContent.read).toHaveBeenCalledWith(workspaceId, 'partners', 'sea')
    const noGrant = { ...integration(), authority: { ...integration().authority, integration: { credentialId, grants: [] } } }
    await expect(service.execute(noGrant, command({ kind: 'published_site_content', collection: 'partners', site: 'sea' }))).rejects.toBeDefined()
    await expect(service.execute(member, command({ kind: 'observe_site_content', collection: 'partners', site: 'sea', revision: 2 }))).rejects.toMatchObject({ code: 'not_authorized' })
    await service.execute(integration(), command({ kind: 'observe_site_content', collection: 'partners', site: 'sea', revision: 2 }))
    expect(siteContent.observe).toHaveBeenCalledWith(workspaceId, 'partners', 'sea', 2)
    const owner: AssociationContext = { ...member, authority: { ...member.authority, role: 'owner', canConfigure: true } }
    siteContent.save.mockResolvedValue({ version: 1, issues: [] })
    await service.execute(owner, command({ kind: 'save_site_content', collection: 'news', expectedVersion: 0, document: { schemaVersion: 1, items: [] } }))
    expect(siteContent.save).toHaveBeenCalledWith(workspaceId, 'news', 0, { schemaVersion: 1, items: [] }, expect.anything())
  })

  it('lets an assistant edit website content only for an owner or admin, and never over an integration key', async () => {
    const siteContent = { draft: vi.fn().mockResolvedValue({ version: 1 }), save: vi.fn(), update: vi.fn().mockResolvedValue({ version: 2, changed: ['set x'] }), publish: vi.fn(),
      status: vi.fn().mockResolvedValue([]), read: vi.fn(), observe: vi.fn() }
    const roles: Record<string, string> = {}
    const f = fixture()
    const service = createAssociationService({ store: f.store as unknown as AssociationStore, crmService: f.crm as CrmOperationsServicePort,
      modules: f.modules as unknown as WorkspaceModulesStore, siteContent: siteContent as never,
      programmeCatalogue: { status: vi.fn().mockResolvedValue({}) } as never, membershipCatalogue: { status: vi.fn().mockResolvedValue({}) } as never,
      memberRole: async user => roles[user] ?? null })
    const assistantFor = (person: string): AssociationContext => ({ workspaceId, actor: { kind: 'assistant', assistantId: credentialId, userId: person, sessionId: eventId },
      authority: { ...member.authority, canConfigure: true } })
    const update = command({ kind: 'update_site_content', collection: 'partners', expectedVersion: 1, operations: [{ op: 'set', path: 'partners/acme/href', value: 'https://example.org' }] })
    const memberId = randomUUID(), adminId = randomUUID()
    roles[memberId] = 'member'; roles[adminId] = 'admin'
    // A member chatting with an assistant that holds the configure grant is refused, even for a draft read.
    await expect(service.execute(assistantFor(memberId), command({ kind: 'site_content_draft', collection: 'partners' }))).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(service.execute(assistantFor(memberId), update)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(service.execute(assistantFor(memberId), command({ kind: 'publish_membership_catalogue', expectedVersion: 1 }))).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(service.execute(assistantFor(randomUUID()), update)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(siteContent.update).not.toHaveBeenCalled()
    await expect(service.execute(assistantFor(adminId), update)).resolves.toMatchObject({ record: { version: 2 } })
    expect(siteContent.update).toHaveBeenCalledWith(workspaceId, 'partners', 1, update.kind === 'update_site_content' ? update.operations : [], expect.objectContaining({ credentialKind: 'assistant', actingUserId: adminId }))
    await expect(service.execute(integration(), update)).rejects.toBeDefined()
    // Status summaries are a plain read for assistants too.
    await expect(service.execute({ ...assistantFor(memberId), authority: { ...member.authority } }, command({ kind: 'website_status' }))).resolves.toMatchObject({ record: { collections: [] } })
  })

  it('adds a chat upload to the website media library as the person, with an audit entry', async () => {
    const f = fixture(), adminId = randomUUID(), fileId = randomUUID(), mediaId = randomUUID()
    const media = { list: vi.fn().mockResolvedValue([{ id: mediaId, name: 'x-stage.png', title: 'Stage', mime: 'image/png', sizeBytes: 3, updatedAt: 'now' }]),
      importUpload: vi.fn().mockResolvedValue({ id: mediaId, name: 'Stage', mime: 'image/png', sizeBytes: 3 }), audit: vi.fn() }
    const context: AssociationContext = { workspaceId, actor: { kind: 'assistant', assistantId: credentialId, userId: adminId, sessionId: eventId },
      authority: { ...member.authority, canConfigure: true } }
    const bare = createAssociationService({ store: f.store as unknown as AssociationStore, crmService: f.crm as CrmOperationsServicePort, memberRole: async () => 'owner' })
    await expect(bare.execute(context, command({ kind: 'list_website_media' }))).rejects.toMatchObject({ code: 'not_available' })
    const service = createAssociationService({ store: f.store as unknown as AssociationStore, crmService: f.crm as CrmOperationsServicePort,
      memberRole: async () => 'owner', websiteMedia: () => media })
    await expect(service.execute(context, command({ kind: 'list_website_media', query: 'stage' }))).resolves.toMatchObject({ items: [{ mediaId, name: 'Stage' }] })
    await expect(service.execute(context, command({ kind: 'list_website_media', query: 'nothing' }))).resolves.toMatchObject({ items: [] })
    await expect(service.execute(context, command({ kind: 'add_website_media', fileId }))).resolves.toMatchObject({ record: { mediaId } })
    expect(media.importUpload).toHaveBeenCalledWith({ workspaceId, userId: adminId, assistantId: credentialId, fileId, name: undefined })
    expect(media.audit).toHaveBeenCalledWith(workspaceId, mediaId, expect.objectContaining({ credentialKind: 'assistant', actingUserId: adminId }))
    media.importUpload.mockResolvedValueOnce({ error: 'upload_not_found' })
    await expect(service.execute(context, command({ kind: 'add_website_media', fileId }))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps source membership assertions inside the matching owner/admin import job', async () => {
    const f = fixture(), jobId = randomUUID()
    const input = AssociationSourceMembershipImportSchema.parse({
      importJobId: jobId, importRow: 1, contactId: userId, planId: eventId,
      idempotencyKey: 'wix-membership:source-1', status: 'active',
      startsAt: '2026-08-01T00:00:00Z', endsAt: '2027-08-01T00:00:00Z',
      source: 'wix', sourceSite: 'oasahk_org', sourceMembershipId: 'source-1',
      sourcePlanId: 'wix-plan-1', sourceSubscriptionId: 'wix-subscription-1',
      sourceStatus: 'ACTIVE', sourceRenewalStatus: 'AUTO_RENEWING',
      purchasedAt: '2026-08-01T00:00:00Z',
    })
    const ownerImport: AssociationContext = { ...member,
      actor: { kind: 'import', jobId, userId },
      authority: { ...member.authority, role: 'owner', canConfigure: true } }
    expect(await f.service.importSourceMembership(ownerImport, input)).toMatchObject({ created: true, duplicate: false })
    expect(f.store.importSourceMembership).toHaveBeenCalledWith(workspaceId, input,
      expect.objectContaining({ credentialKind: 'import', actingUserId: userId }))
    for (const context of [
      { ...ownerImport, actor: { kind: 'import' as const, jobId: randomUUID(), userId } },
      { ...ownerImport, authority: { ...ownerImport.authority, role: 'member' as const, canConfigure: false } },
      { ...ownerImport, actor: { kind: 'user' as const, userId } },
    ]) await expect(f.service.importSourceMembership(context, input)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.importSourceMembership).toHaveBeenCalledTimes(1)
  })
  it('keeps source order assertions inside the matching owner/admin import job', async () => {
    const f = fixture(), jobId = randomUUID()
    const input = AssociationSourceOrderImportSchema.parse({
      importJobId: jobId, importRow: 1, contactId: userId, source: 'wix',
      sourceSite: 'oasahk_org', sourceOrderId: 'source-1', occurredAt: '2026-08-01T00:00:00Z',
      status: 'paid', currency: 'HKD', subtotalMinor: 100, discountMinor: 0, totalMinor: 100,
      lines: [{ ticketId: eventId, quantity: 1, unitPriceMinor: 100, discountMinor: 0,
        lineTotalMinor: 100, attendees: [{ sourceRegistrationId: 'booking-1', name: 'Example', status: 'confirmed' }] }],
    })
    const ownerImport: AssociationContext = { ...member,
      actor: { kind: 'import', jobId, userId },
      authority: { ...member.authority, role: 'owner', canConfigure: true } }
    expect(await f.service.importSourceOrder(ownerImport, input)).toMatchObject({ created: true, duplicate: false })
    expect(f.store.importSourceOrder).toHaveBeenCalledWith(workspaceId, input,
      expect.objectContaining({ credentialKind: 'import', actingUserId: userId }))
    for (const context of [
      { ...ownerImport, actor: { kind: 'import' as const, jobId: randomUUID(), userId } },
      { ...ownerImport, authority: { ...ownerImport.authority, role: 'member' as const, canConfigure: false } },
      { ...ownerImport, actor: { kind: 'user' as const, userId } },
    ]) await expect(f.service.importSourceOrder(context, input)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.importSourceOrder).toHaveBeenCalledTimes(1)
  })
  it('intersects receipt read scope with entitlement plan ceilings and never upgrades members to payment authority', async () => {
    const f = fixture(), context = integration(), planId = randomUUID()
    await f.service.execute(context, command({ kind: 'list_provider_receipts' }))
    expect(f.store.listProviderReceipts).toHaveBeenLastCalledWith(workspaceId, expect.objectContaining({ allowedEventIds: [eventId], allowedPlanIds: [] }), expect.objectContaining({ credentialKind: 'integration_key', credentialId: context.authority.integration!.credentialId, integration: context.authority.integration }))
    context.authority.integration!.grants.push({ operation: 'crm.entitlements.read', selectors: { planIds: [planId] } })
    await f.service.execute(context, command({ kind: 'list_provider_receipts', state: 'needs_reconciliation' }))
    expect(f.store.listProviderReceipts).toHaveBeenLastCalledWith(workspaceId, expect.objectContaining({ state: 'needs_reconciliation', allowedEventIds: [eventId], allowedPlanIds: [planId] }), expect.objectContaining({ credentialKind: 'integration_key', credentialId: context.authority.integration!.credentialId, integration: context.authority.integration }))
    const event = { provider: 'fixture', providerReference: 'fictional-subscription', providerPeriodId: 'period-1', eventId: 'event-1', occurredAt: '2026-09-09T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: orderId, status: 'cancelled' } }
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canReconcileProvider: true } }, command({ kind: 'reconcile_provider_entitlement', event }))).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.reconcileProviderEntitlement).not.toHaveBeenCalled()
  })
  it('limits exact receipt retries to owners and admins without granting them payment evidence authority', async () => {
    const f = fixture(), retry = command({ kind: 'retry_provider_receipt', receiptId: credentialId })
    await expect(f.service.execute(member, retry)).rejects.toMatchObject({ code: 'not_authorized' })
    const machine = integration()
    machine.authority.integration!.grants.push({ operation: 'association.orders.write', selectors: {} })
    await expect(f.service.execute({ ...machine, authority: { ...machine.authority, role: 'admin', canConfigure: true } }, retry)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.resolveProviderReceipt).not.toHaveBeenCalled()
    await f.service.execute({ ...member, authority: { ...member.authority, role: 'owner', canConfigure: true } }, retry)
    expect(f.store.resolveProviderReceipt).toHaveBeenCalledWith(workspaceId, credentialId,
      { credentialKind: 'user', credentialId: userId, actingUserId: userId })
  })
  it('intersects waitlist event and definition read authority before pagination', async () => {
    const f = fixture(), context = integration(), definitionId = randomUUID()
    await expect(f.service.execute(context, command({ kind: 'list_waitlist' }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    context.authority.integration!.grants.push({ operation: 'crm.submissions.read', selectors: { definitionIds: [definitionId] } })
    await f.service.execute(context, command({ kind: 'list_waitlist', limit: 10 }))
    expect(f.store.listWaitlist).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ limit: 10, allowedEventIds: [eventId], allowedDefinitionIds: [definitionId] }), expect.objectContaining({ credentialKind: 'integration_key' }))
  })
  it('keeps history/recovery usable without an admission precheck that could hide disabled history', async () => {
    const f = fixture()
    expect((await f.service.execute(member, { kind: 'get_order', orderId })).record?.id).toBe(orderId)
    await f.service.execute(member, { kind: 'cancel_order', orderId })
    expect(f.modules.get).not.toHaveBeenCalled()
    expect(f.store.cancelOrder).toHaveBeenCalledWith(workspaceId, orderId, { credentialKind: 'user', credentialId: userId, actingUserId: userId })
  })
  it('denies read/write independently, including direct invocation', async () => {
    const f = fixture()
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canRead: false } }, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canWrite: false } }, { kind: 'cancel_order', orderId })).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.getOrder).not.toHaveBeenCalled()
    expect(f.store.cancelOrder).not.toHaveBeenCalled()
  })
  it('confines module changes to owner/admin users, even if a machine claims configuration authority', async () => {
    const f = fixture(), change = command({ kind: 'module_action', action: 'enable', expectedVersion: 1 })
    for (const context of [member, { ...integration(), authority: { ...integration().authority, canConfigure: true } }]) {
      await expect(f.service.execute(context, change)).rejects.toMatchObject({ code: 'not_authorized' })
    }
    await f.service.execute({ ...member, authority: { ...member.authority, role: 'admin', canConfigure: true } }, change)
    expect(f.modules.act).toHaveBeenCalledTimes(1)
    expect(f.modules.act).toHaveBeenCalledWith(workspaceId, userId, 'association', expect.objectContaining({ expectedVersion: 1 }))
  })
  it('passes the event ceiling into SQL list inputs before pagination and scopes blocker counts', async () => {
    const f = fixture()
    const result = await f.service.execute(integration(), command({ kind: 'module_blockers', limit: 2 }))
    expect(f.store.listOrders).toHaveBeenCalledWith(workspaceId, { limit: 2, cursor: null, status: 'pending', allowedEventIds: [eventId] }, expect.objectContaining({ credentialKind: 'integration_key', credentialId }))
    expect(result.pendingOrders).toBe(7)
    await expect(f.service.execute(integration(), command({ kind: 'list_orders', eventId: randomUUID() }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    expect(f.store.listOrders).toHaveBeenCalledTimes(1)
  })
  it('returns server-computed order finance totals for the exact list filters', async () => {
    const f = fixture()
    const result = await f.service.execute(member, command({ kind: 'list_orders', eventId, status: 'paid' }))
    expect(result.financialSummary).toEqual([expect.objectContaining({ currency: 'USD', grossMinor: '2000', refundedMinor: '400' })])
    expect(f.store.listOrders).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ eventId, status: 'paid' }), { credentialKind: 'user', credentialId: userId, actingUserId: userId })
  })
  it('confines the complete operational roster to owner/admin user sessions', async () => {
    const f = fixture(), roster = command({ kind: 'list_operational_roster', eventId, limit: 25 })
    await expect(f.service.execute(member, roster)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.service.execute({ ...integration(), authority: { ...integration().authority, role: 'admin', canConfigure: true } }, roster))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.listOperationalRoster).not.toHaveBeenCalled()
    const result = await f.service.execute({ ...member, authority: { ...member.authority, role: 'owner', canConfigure: true } }, roster)
    expect(result.items).toEqual([{ id: orderId }])
    expect(f.store.listOperationalRoster).toHaveBeenCalledWith(workspaceId, eventId, expect.objectContaining({ limit: 25, cursor: null }), expect.objectContaining({ credentialKind: 'user' }))
  })
  it('carries the original grant ceiling to by-id reads and refuses mismatched credentials', async () => {
    const f = fixture(), context = integration()
    await f.service.execute(context, { kind: 'get_order', orderId })
    expect(f.store.getOrder).toHaveBeenCalledWith(workspaceId, orderId, expect.objectContaining({ integration: context.authority.integration }))
    await expect(f.service.execute({ ...context, actor: { kind: 'integration_key', credentialId: randomUUID() } }, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
  })
  it('limits notification evidence to an exact readable order', async () => {
    const f = fixture(), context = integration()
    const result = await f.service.execute(context, command({ kind: 'list_order_notifications', orderId, limit: 10 }))
    expect(result.items).toEqual([])
    expect(f.store.getOrder).toHaveBeenCalledWith(workspaceId, orderId,
      expect.objectContaining({ integration: context.authority.integration }))
    expect(f.store.listNotifications).toHaveBeenCalledWith(workspaceId, expect.objectContaining({
      limit: 10, cursor: null, sourceKind: 'order', sourceId: orderId,
    }), expect.objectContaining({ credentialKind: 'integration_key', integration: context.authority.integration }))
    f.store.getOrder.mockResolvedValueOnce(null)
    await expect(f.service.execute(context, command({ kind: 'list_order_notifications', orderId })))
      .rejects.toMatchObject({ code: 'not_found' })
    expect(f.store.listNotifications).toHaveBeenCalledTimes(1)
  })
  it('does not let read scope or intake credentials perform commerce writes', async () => {
    const f = fixture()
    await expect(f.service.execute(integration(), { kind: 'cancel_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(f.service.execute({ ...member, actor: { kind: 'intake_key', credentialId, definitionId: eventId } }, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'not_authorized' })
  })
  it('denies fabricated paid evidence from humans and assistants even with a forged backend boolean', async () => {
    const f = fixture(), input = command({ kind: 'reconcile_provider_event', orderId,
      event: { provider: 'fixture', providerReference: 'fixture-object', eventId: 'event-1', targetStatus: 'paid', occurredAt: '2026-09-08T00:00:00Z', amountMinor: 100, currency: 'USD' } })
    for (const actor of [member.actor, { kind: 'assistant' as const, assistantId: userId, sessionId: randomUUID() },
      { kind: 'home_app' as const, credentialId }, { kind: 'provider' as const, provider: 'other', eventId: 'event-1' }]) {
      await expect(f.service.execute({ ...member, actor, authority: { ...member.authority, canReconcileProvider: true } }, input)).rejects.toMatchObject({ code: 'not_authorized' })
    }
    expect(f.store.reconcileProviderEvent).not.toHaveBeenCalled()
    await f.service.execute({ ...member, actor: { kind: 'brain_key', credentialId }, authority: { ...member.authority, canReconcileProvider: true } }, input)
    expect(f.store.reconcileProviderEvent).toHaveBeenCalledTimes(1)
  })
  it('keeps refund and dispute evidence behind the same verified backend authority', async () => {
    const f = fixture(), event = { provider: 'fixture', providerReference: 'fixture-object', adjustmentReference: 'refund-1',
      eventId: 'event-2', kind: 'refund' as const, status: 'succeeded' as const, amountMinor: 400, currency: 'USD',
      occurredAt: '2026-09-08T01:00:00Z', metadata: {} }
    const input = command({ kind: 'reconcile_provider_financial_event', orderId, event })
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canReconcileProvider: true } }, input)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.reconcileProviderFinancialEvent).not.toHaveBeenCalled()
    await f.service.execute({ ...member, actor: { kind: 'brain_key', credentialId }, authority: { ...member.authority, canReconcileProvider: true } }, input)
    expect(f.store.reconcileProviderFinancialEvent).toHaveBeenCalledWith(workspaceId, orderId, event,
      { credentialKind: 'brain_key', credentialId })
  })
  it('restricts provider bindings to backend payment authority', async () => {
    const f = fixture(), input = command({ kind: 'bind_order_provider', orderId, binding: { provider: 'fixture', providerReference: 'fictional-object', amountMinor: 1000, currency: 'USD' } })
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canReconcileProvider: true } }, input)).rejects.toMatchObject({ code: 'not_authorized' })
    await f.service.execute({ ...member, actor: { kind: 'brain_key', credentialId }, authority: { ...member.authority, canReconcileProvider: true } }, input)
    expect(f.store.bindOrderProvider).toHaveBeenCalledTimes(1)
  })
  it('confines offline rescue reads and evidence actions to owner/admin users', async () => {
    const f=fixture(),owner={...member,authority:{...member.authority,role:'owner' as const,canConfigure:true}}
    const rescue={contactId:userId,planId:eventId,idempotencyKey:randomUUID(),startsAt:'2026-09-01T00:00:00Z',
      endsAt:'2027-09-01T00:00:00Z',dueAt:'2026-09-30T00:00:00Z',reason:'Reviewed bank transfer exception'}
    await expect(f.service.execute(member,command({kind:'list_membership_rescues',limit:10}))).rejects.toMatchObject({code:'not_authorized'})
    const machine=integration();machine.authority.integration!.grants.push({operation:'association.orders.write',selectors:{eventIds:[eventId]}})
    await expect(f.service.execute({...machine,authority:{...machine.authority,role:'admin',canConfigure:true}},command({kind:'create_membership_rescue',rescue}))).rejects.toMatchObject({code:'not_authorized'})
    expect(f.store.createMembershipRescue).not.toHaveBeenCalled()
    expect((await f.service.execute(owner,command({kind:'create_membership_rescue',rescue}))).record).toMatchObject({status:'outstanding'})
    await f.service.execute(owner,command({kind:'list_membership_rescues',limit:10,status:'outstanding'}))
    expect(f.store.listMembershipRescues).toHaveBeenCalledWith(workspaceId,expect.objectContaining({limit:10,status:'outstanding'}),expect.objectContaining({credentialKind:'user'}))
    const settlement={requestId:randomUUID(),method:'bank_transfer' as const,evidenceReference:'bank-fixture-1',amountMinor:100,
      currency:'USD',occurredAt:'2026-09-08T00:00:00Z'}
    expect((await f.service.execute(owner,command({kind:'settle_membership_rescue',rescueId:orderId,settlement}))).record).toMatchObject({status:'settled'})
    expect(f.store.settleMembershipRescue).toHaveBeenCalledWith(workspaceId,orderId,settlement,expect.objectContaining({credentialKind:'user'}))
  })
  it('keeps sponsorship management with owner/admin staff and redemption with the scoped member backend',async()=>{
    const f=fixture(),owner={...member,authority:{...member.authority,role:'owner' as const,canConfigure:true}}
    const allocation={sponsorContactId:userId,sponsorMembershipId:orderId,beneficiaryPlanId:eventId,idempotencyKey:randomUUID(),
      seatLimit:1,startsAt:'2026-09-01T00:00:00Z',endsAt:'2027-09-01T00:00:00Z',invitationTtlHours:168}
    await expect(f.service.execute(member,command({kind:'create_sponsorship_allocation',allocation}))).rejects.toMatchObject({code:'not_authorized'})
    await f.service.execute(owner,command({kind:'create_sponsorship_allocation',allocation}))
    expect(f.store.createSponsorshipAllocation).toHaveBeenCalledWith(workspaceId,allocation,expect.objectContaining({credentialKind:'user'}))
    await f.service.execute(owner,command({kind:'list_sponsorship_allocations',limit:10,sponsorContactId:userId}))
    expect(f.store.listSponsorshipAllocations).toHaveBeenCalledWith(workspaceId,expect.objectContaining({limit:10,sponsorContactId:userId}),expect.objectContaining({credentialKind:'user'}))
    const redemption={token:'x'.repeat(43),contactId:userId}
    await expect(f.service.execute(owner,command({kind:'redeem_sponsorship_invitation',redemption}))).rejects.toMatchObject({code:'not_authorized'})
    const backend=integration();backend.authority.integration!.grants.push({operation:'crm.entitlements.write',selectors:{planIds:[eventId]}})
    await f.service.execute(backend,command({kind:'redeem_sponsorship_invitation',redemption}))
    expect(f.store.redeemSponsorshipInvitation).toHaveBeenCalledWith(workspaceId,redemption,
      expect.objectContaining({credentialKind:'integration_key',integration:backend.authority.integration}))
  })
  it('routes generic participation through CRM and preserves the legacy registration envelope', async () => {
    const f = fixture()
    const result = await f.service.execute(member, { kind: 'update_registration', registrationId: orderId, update: { status: 'checked_in' } })
    expect(f.crm.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), { kind: 'update_participation', participationId: orderId, status: 'attended' })
    expect(result.record).toMatchObject({ attendeeContactId: userId, status: 'checked_in', orderId: null })
    expect(f.store.updateRegistration).not.toHaveBeenCalled()
  })
  it('restricts reasoned check-in correction to owners/admins and preserves each writer boundary', async () => {
    const f = fixture(), correction = command({ kind: 'correct_check_in', registrationId: orderId,
      correction: { expectedStatus: 'checked_in', reason: 'Duplicate scanner tap' } })
    await expect(f.service.execute(member, correction)).rejects.toMatchObject({ code: 'not_authorized' })
    const machine = integration()
    machine.authority.integration!.grants.push({ operation: 'association.orders.write', selectors: { eventIds: [eventId] } })
    await expect(f.service.execute({ ...machine, authority: { ...machine.authority, role: 'admin', canConfigure: true } }, correction))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.getRegistrationManagement).not.toHaveBeenCalled()
    f.store.getRegistrationManagement.mockResolvedValueOnce({ sourceKind: 'commerce', eventId })
    const owner = { ...member, authority: { ...member.authority, role: 'owner' as const, canConfigure: true } }
    expect((await f.service.execute(owner, correction)).record).toMatchObject({ status: 'confirmed' })
    expect(f.store.correctRegistrationCheckIn).toHaveBeenCalledWith(workspaceId, orderId,
      { expectedStatus: 'checked_in', reason: 'Duplicate scanner tap' }, expect.objectContaining({ credentialKind: 'user' }))
    f.store.getRegistrationManagement.mockResolvedValueOnce({ sourceKind: 'manual', eventId })
    const generic = await f.service.execute(owner, command({ kind: 'correct_check_in', registrationId: orderId,
      correction: { expectedStatus: 'attended', reason: 'Marked the wrong person' } }))
    expect(f.crm.execute).toHaveBeenLastCalledWith(owner, { kind: 'correct_participation_check_in', participationId: orderId,
      expectedStatus: 'attended', reason: 'Marked the wrong person' })
    expect(generic.record).toMatchObject({ status: 'registered', attendeeContactId: userId })
  })
})
