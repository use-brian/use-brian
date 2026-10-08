import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createAssociationStore } from '../association-store.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { EventInputSchema, MembershipCheckoutCreateSchema, MembershipCheckoutProviderBindingSchema, MembershipInputSchema, OrderCreateSchema, PlanInputSchema, PromotionImportSchema, PromotionInputSchema, TicketInputSchema } from '../../association/domain.js'
import { ProviderEntitlementEventSchema, type CrmOperationsContext } from '@use-brian/core'
import { createProviderEntitlementInbox } from '../../association/provider-entitlements.js'
import { assertCrmPrivacySubjectAuthority } from '../../crm-operations/privacy-subject-authority.js'
import { createCrmPrivacyService } from '../../crm-operations/privacy-previews.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createAssociationWorkspaceModulesStore()
const promotionHmacKey = 'fictional-promotion-key-for-tests-only'
const commerce = createAssociationStore(pool, undefined, {
  promotionHmacKey,
  providerEntitlements: createProviderEntitlementInbox(pool),
})

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), buyerId = randomUUID(), secondBuyerId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [userId, secondBuyerId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Promotion fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  for (const [id, name] of [[buyerId, 'Fictional buyer'], [secondBuyerId, 'Fictional second buyer']] as const) {
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person',$3,$4,'manual')",
      [id, workspaceId, name, userId])
  }
  await modules.act(workspaceId, userId, 'association', { action: 'enable', expectedVersion: 1 })
  const actor = { credentialKind: 'user' as const, credentialId: userId, actingUserId: userId }
  const event = await commerce.upsertEvent(workspaceId, EventInputSchema.parse({
    slug: `promotion-${workspaceId.slice(0, 8)}`, title: 'Promotion fixture', startsAt: '2099-01-01T12:00:00Z',
    endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 100,
  }), actor)
  const eventId = String(event.record.id)
  const ticket = await commerce.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({
    key: 'standard', name: 'Standard', currency: 'HKD', priceMinor: 1_000, memberPriceMinor: 800,
    status: 'on_sale', capacity: 100, perOrderLimit: 10,
  }), actor)
  const ticketId = String(ticket.record.id)
  const savePromotion = (patch: Record<string, unknown> = {}) => commerce.upsertPromotion(workspaceId, PromotionInputSchema.parse({
    key: 'example', name: 'Example promotion', code: 'Example-10', discountType: 'percentage',
    percentageBasisPoints: 1_000, targetKind: 'event', targetIds: [eventId], status: 'active', ...patch,
  }), actor)
  const order = (contactId = buyerId, key = randomUUID(), patch: Record<string, unknown> = {}) => commerce.createOrder(
    workspaceId,
    OrderCreateSchema.parse({ contactId, idempotencyKey: key, promotionCode: ' example-10 ', lines: [{
      ticketId, quantity: 1, attendees: [{ contactId, name: 'Fictional attendee' }],
    }], ...patch }),
    actor,
  )
  return { workspaceId, userId, buyerId, secondBuyerId, actor, eventId, ticketId, savePromotion, order }
}

describe('[COMP:crm/association-promotions] canonical discount authority', () => {
  afterAll(async () => { await pool.end(); await appPool.end() })
  it('captures complete imported usage without letting contact declassification lower its floor', async () => {
    const f = await fixture(), department = randomUUID(), custodian = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [department, f.workspaceId, custodian, `team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [f.workspaceId, `team:${department}`, department])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.buyerId, [`team:${department}`]])
    const input = PromotionImportSchema.parse({ importJobId: randomUUID(), importRow: 1, source: 'fixture', sourceSite: 'events.example', sourcePromotionId: 'archive-offer',
      codeDigest: createHmac('sha256', promotionHmacKey).update('ARCHIVE').digest('hex'),
      promotion: { key: 'archive', name: 'Archived offer', discountType: 'percentage', percentageBasisPoints: 1000, targetKind: 'event', targetIds: [f.eventId], status: 'active' },
      sourceRedeemedUses: 2, sourceContactUses: [{ contactId: f.buyerId, uses: 2 }],
    })
    const actor = { credentialKind: 'import' as const, credentialId: input.importJobId, actingUserId: f.userId }
    await expect(commerce.importPromotion(f.workspaceId, input, actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_promotions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    const grant = () => pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, department, f.userId])
    await grant()
    const saved = await commerce.importPromotion(f.workspaceId, input, actor)
    expect(saved.record).toMatchObject({ sourceRedeemedUses: 2, redeemedUses: 2 })
    await expect(pool.query("UPDATE association_promotions SET scope_snapshot=jsonb_set(scope_snapshot,'{compartments}','[]') WHERE id=$1", [saved.record.id])).rejects.toThrow('immutable')
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1", [f.buyerId])
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [department, f.userId])
    expect((await commerce.importPromotion(f.workspaceId, input, actor)).record).toMatchObject({ id: saved.record.id, sourceRedeemedUses: null, redeemedUses: null })
    const privacyClient = await pool.connect()
    try {
      await privacyClient.query('BEGIN')
      await expect(assertCrmPrivacySubjectAuthority(privacyClient, {
        workspaceId: f.workspaceId, actor: { kind: 'user', userId: f.userId },
        authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
      }, f.buyerId)).rejects.toMatchObject({ code: 'not_authorized' })
    } finally { await privacyClient.query('ROLLBACK'); privacyClient.release() }
    await grant()
    expect((await commerce.importPromotion(f.workspaceId, input, actor)).record).toMatchObject({ id: saved.record.id, sourceRedeemedUses: 2, redeemedUses: 2 })
    expect((await pool.query('SELECT count(*)::int n FROM association_promotion_source_contact_uses WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
    await expect(pool.query("UPDATE association_promotions SET scope_sources='[]',scope_sources_minimized=true WHERE id=$1", [saved.record.id])).rejects.toThrow('attribution erasure')
    const privacy = createCrmPrivacyService(), context: CrmOperationsContext = {
      workspaceId: f.workspaceId, actor: { kind: 'user', userId: f.userId },
      authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
    }
    const review = await privacy.preview(context, { kind: 'preview_contact_erasure', contactId: f.buyerId })
    await privacy.erase(context, { kind: 'erase_contact_with_preview', contactId: f.buyerId, previewId: review.id, previewHash: review.previewHash, confirmed: true })
    const minimized = (await pool.query('SELECT scope_snapshot,scope_sources,scope_sources_minimized FROM association_promotions WHERE id=$1', [saved.record.id])).rows[0]
    expect(minimized).toMatchObject({ scope_snapshot: { compartments: [`team:${department}`] }, scope_sources: [], scope_sources_minimized: true })
    expect(JSON.stringify(minimized)).not.toContain(f.buyerId)
    expect((await commerce.importPromotion(f.workspaceId, input, actor)).record).toMatchObject({ sourceRedeemedUses: 2, redeemedUses: 2 })
    expect((await pool.query('SELECT contact_id FROM association_promotion_source_contact_uses WHERE promotion_id=$1', [saved.record.id])).rows).toEqual([{ contact_id: null }])
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [department, f.userId])
    expect((await commerce.importPromotion(f.workspaceId, input, actor)).record).toMatchObject({ sourceRedeemedUses: null, redeemedUses: null })
    await grant()
    expect((await commerce.importPromotion(f.workspaceId, input, actor)).record).toMatchObject({ sourceRedeemedUses: 2, redeemedUses: 2 })
    const partialJobId = randomUUID()
    const partial = await commerce.importPromotion(f.workspaceId, PromotionImportSchema.parse({
      ...input, importJobId: partialJobId, sourcePromotionId: 'partial-offer',
      codeDigest: createHmac('sha256', promotionHmacKey).update('PARTIAL').digest('hex'),
      promotion: { ...input.promotion, key: 'partial' }, sourceContactUses: [{ contactId: f.secondBuyerId, uses: 1 }],
    }), { ...actor, credentialId: partialJobId })
    expect(partial.record).toMatchObject({ sourceRedeemedUses: null, redeemedUses: null })
    expect((await pool.query('SELECT scope_snapshot,scope_sources FROM association_promotions WHERE id=$1', [partial.record.id])).rows[0])
      .toEqual({ scope_snapshot: null, scope_sources: null })
  })
  it('withholds totals without hiding promotion settings when a contributing order becomes inaccessible', async () => {
    const f = await fixture(), promotion = await f.savePromotion(), order = await f.order(), department = randomUUID(), custodian = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [department, f.workspaceId, custodian, `team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [f.workspaceId, `team:${department}`, department])
    const list = () => commerce.listPromotions(f.workspaceId, { limit: 100, cursor: null }, f.actor)
    expect((await list()).items).toMatchObject([{ id: promotion.record.id, reservedUses: 1, redeemedUses: 0 }])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.buyerId, [`team:${department}`]])
    expect((await list()).items).toMatchObject([{ id: promotion.record.id, name: 'Example promotion', reservedUses: null, redeemedUses: null, sourceRedeemedUses: null }])
    expect((await f.savePromotion({ name: 'Updated promotion' })).record).toMatchObject({ id: promotion.record.id, name: 'Updated promotion', reservedUses: null, redeemedUses: null })
    await expect(f.savePromotion({ maxUses: 1 })).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, department, f.userId])
    expect((await list()).items).toMatchObject([{ id: promotion.record.id, reservedUses: 1, redeemedUses: 0 }])
    expect((await f.savePromotion({ maxUses: 1 })).record).toMatchObject({ maxUses: 1, reservedUses: 1 })
    expect((await pool.query('SELECT state FROM association_promotion_uses WHERE order_id=$1', [order.record.id])).rows[0].state).toBe('reserved')
  })

  it('prices a percentage code once, stores no plaintext and replays by normalized code identity', async () => {
    const f = await fixture(), promotion = await f.savePromotion(), key = randomUUID()
    const first = await f.order(f.buyerId, key)
    const replay = await f.order(f.buyerId, key, { promotionCode: 'EXAMPLE-10' })
    expect(first.record).toMatchObject({ subtotalMinor: '1000', discountMinor: '100', totalMinor: '900',
      promotionId: promotion.record.id, promotionSnapshot: { key: 'example', discountMinor: 100,
        applicableLines: [{ ticketId: f.ticketId, discountMinor: 100 }] } })
    expect(first.record).not.toHaveProperty('promotionCode')
    expect(replay.created).toBe(false)
    const stored = (await pool.query('SELECT code_digest FROM association_promotions WHERE workspace_id=$1', [f.workspaceId])).rows[0]
    expect(stored.code_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(first.record)).not.toContain('EXAMPLE-10')
    expect((await pool.query('SELECT state FROM association_promotion_uses WHERE workspace_id=$1', [f.workspaceId])).rows)
      .toEqual([{ state: 'reserved' }])
  })

  it('confirms a fully discounted order canonically and enforces the per-contact cap', async () => {
    const f = await fixture()
    await f.savePromotion({ discountType: 'full', percentageBasisPoints: undefined, maxUsesPerContact: 1 })
    const first = await f.order()
    expect(first.record).toMatchObject({ totalMinor: '0', discountMinor: '1000' })
    await commerce.confirmFreeOrder(f.workspaceId, String(first.record.id), f.actor)
    expect((await pool.query('SELECT state FROM association_promotion_uses WHERE order_id=$1', [first.record.id])).rows[0].state)
      .toBe('redeemed')
    await expect(f.order()).rejects.toMatchObject({ code: 'promotion_exhausted' })
  })

  it('reserves a legacy recurring plan discount, binds exact provider evidence and redeems it with the entitlement grant', async () => {
    const f = await fixture()
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [f.workspaceId])
    const plan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({
      key: 'student-recurring', name: 'Student recurring', currency: 'HKD', feeMinor: 78_000,
      billingPeriod: 'annual', published: true, provider: 'stripe', providerPlanId: 'price_fixture_student',
    }), f.actor)
    const promotion = await commerce.upsertPromotion(f.workspaceId, PromotionInputSchema.parse({
      key: 'student-support', name: 'Student support', code: 'STUDENT-FIXTURE', discountType: 'fixed_amount',
      amountMinor: 39_000, currency: 'HKD', targetKind: 'plan', targetIds: [String(plan.record.id)],
      recurrenceMode: 'repeating', recurrenceCycles: 2, applyMode: 'once_per_order',
      maxUses: 2, maxUsesPerContact: 1, status: 'active',
    }), f.actor)
    const idempotencyKey = randomUUID()
    const reserved = await commerce.reserveMembershipCheckout(f.workspaceId, MembershipCheckoutCreateSchema.parse({
      contactId: f.buyerId, planId: String(plan.record.id), idempotencyKey, reservationMinutes: 35,
      promotionCode: ' student-fixture ',
    }), f.actor)
    expect(reserved.record).toMatchObject({
      contactId: f.buyerId, planId: plan.record.id, status: 'reserved', currency: 'HKD',
      subtotalMinor: '78000', discountMinor: '39000', totalMinor: '39000', promotionId: promotion.record.id,
      promotionSnapshot: { recurrenceMode: 'repeating', recurrenceCycles: 2, durationMonths: 24 },
    })
    expect(JSON.stringify(reserved.record)).not.toContain('STUDENT-FIXTURE')
    const replay = await commerce.reserveMembershipCheckout(f.workspaceId, MembershipCheckoutCreateSchema.parse({
      contactId: f.buyerId, planId: String(plan.record.id), idempotencyKey, reservationMinutes: 35,
      promotionCode: 'STUDENT-FIXTURE',
    }), f.actor)
    expect(replay.created).toBe(false)

    const backend = { credentialKind: 'brain_key' as const, credentialId: randomUUID() }
    const checkoutId = String(reserved.record.id)
    const binding = MembershipCheckoutProviderBindingSchema.parse({ provider: 'stripe',
      providerReference: 'cs_fixture_student', providerCouponReference: 'coupon_fixture_student',
      amountMinor: 39_000, currency: 'HKD' })
    await commerce.bindMembershipCheckoutProvider(f.workspaceId, checkoutId, binding, backend)
    const now = new Date()
    const startsAt = now.toISOString(), endsAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString()
    const granted = await commerce.reconcileProviderEntitlement(f.workspaceId, ProviderEntitlementEventSchema.parse({
      provider: 'stripe', eventId: randomUUID(), providerReference: 'sub_fixture_student',
      providerPeriodId: 'checkout:cs_fixture_student', occurredAt: now.toISOString(),
      membershipCheckout: { id: checkoutId, providerCheckoutReference: 'cs_fixture_student',
        providerCouponReference: 'coupon_fixture_student', amountMinor: 39_000, currency: 'HKD' },
      command: { kind: 'grant_entitlement', contactId: f.buyerId, planId: String(plan.record.id),
        idempotencyKey: 'stripe:cs_fixture_student', status: 'active', startsAt, endsAt,
        renewalMode: 'auto', provider: 'stripe', providerEntitlementId: 'sub_fixture_student',
        providerPeriodId: 'checkout:cs_fixture_student' },
    }), backend)
    expect(granted.record).toMatchObject({ contactId: f.buyerId, planId: plan.record.id, status: 'active' })
    expect((await pool.query('SELECT status FROM association_membership_checkouts WHERE id=$1', [checkoutId])).rows[0].status).toBe('paid')
    expect((await pool.query('SELECT state FROM association_promotion_uses WHERE membership_checkout_id=$1', [checkoutId])).rows[0].state).toBe('redeemed')
  })

  it('[COMP:crm/association-source-scope] protects checkout creation, replay, binding and the settled membership floor under v2', async () => {
    const f = await fixture(), departmentId = randomUUID()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, f.secondBuyerId])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional checkout department',$3,'team',$1::text,$4)", [departmentId, f.workspaceId, f.secondBuyerId, `team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional checkout department','team',$3)", [f.workspaceId, `team:${departmentId}`, departmentId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1", [f.buyerId, [`team:${departmentId}`]])
    const plan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({ key: 'protected-recurring', name: 'Fictional recurring', currency: 'USD', feeMinor: 1000,
      billingPeriod: 'annual', published: true, provider: 'stripe', providerPlanId: 'price_fictional_scope' }), f.actor)
    await commerce.upsertPromotion(f.workspaceId, PromotionInputSchema.parse({ key: 'protected-discount', name: 'Fictional discount', code: 'FICTIONAL-SCOPE',
      discountType: 'fixed_amount', amountMinor: 100, currency: 'USD', targetKind: 'plan', targetIds: [String(plan.record.id)], status: 'active' }), f.actor)
    const input = MembershipCheckoutCreateSchema.parse({ contactId: f.buyerId, planId: plan.record.id, idempotencyKey: randomUUID(), promotionCode: 'FICTIONAL-SCOPE' })
    const reserve = () => commerce.reserveMembershipCheckout(f.workspaceId, input, f.actor)
    await expect(reserve()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_membership_checkouts WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM association_promotion_uses WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [f.workspaceId, departmentId, f.userId])
    const reserved = await reserve(), checkoutId = String(reserved.record.id)
    expect((await reserve()).created).toBe(false)
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1", [f.buyerId])
    const backend = { credentialKind: 'brain_key' as const, credentialId: randomUUID(), actingUserId: f.userId }
    const run = <T>(operation: () => T) => runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'confidential', compartments: null, projectIds: null, visibilityAssistantIds: null,
      departmentRead: { workspaceId: f.workspaceId, userId: f.userId, assistantId: null, base: 'confidential', departments: { [departmentId]: 'confidential' }, contextDepartment: null, binding: null, cap: null } }, operation)
    const binding = MembershipCheckoutProviderBindingSchema.parse({ provider: 'stripe', providerReference: 'cs_fictional_scope', providerCouponReference: 'coupon_fictional_scope', amountMinor: 900, currency: 'USD' })
    await expect(commerce.bindMembershipCheckoutProvider(f.workspaceId, checkoutId, binding, backend)).rejects.toMatchObject({ code: 'not_authorized' })
    await run(() => commerce.bindMembershipCheckoutProvider(f.workspaceId, checkoutId, binding, backend))
    const now = new Date(), event = ProviderEntitlementEventSchema.parse({ provider: 'stripe', eventId: randomUUID(), providerReference: 'sub_fictional_scope',
      providerPeriodId: 'checkout:cs_fictional_scope', occurredAt: now.toISOString(),
      membershipCheckout: { id: checkoutId, providerCheckoutReference: binding.providerReference, providerCouponReference: binding.providerCouponReference, amountMinor: 900, currency: 'USD' },
      command: { kind: 'grant_entitlement', contactId: f.buyerId, planId: plan.record.id, idempotencyKey: randomUUID(), status: 'active', startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 86400000).toISOString(), renewalMode: 'auto', provider: 'stripe', providerEntitlementId: 'sub_fictional_scope', providerPeriodId: 'checkout:cs_fictional_scope' } })
    const granted = await run(() => commerce.reconcileProviderEntitlement(f.workspaceId, event, backend))
    const membership = (await pool.query('SELECT scope_snapshot,membership_checkout_id FROM association_memberships WHERE id=$1', [granted.record.id])).rows[0]
    expect(membership).toMatchObject({ membership_checkout_id: checkoutId, scope_snapshot: { sensitivity: 'confidential', compartments: [`team:${departmentId}`] } })
    expect(await run(() => commerce.reconcileProviderEntitlement(f.workspaceId, event, backend))).toMatchObject({ created: false })
    const another = await commerce.reserveMembershipCheckout(f.workspaceId, { ...input, idempotencyKey: randomUUID() }, f.actor)
    const secondBinding = { ...binding, providerReference: 'cs_fictional_other', providerCouponReference: 'coupon_fictional_other' }
    await run(() => commerce.bindMembershipCheckoutProvider(f.workspaceId, String(another.record.id), secondBinding, backend))
    const rebound = ProviderEntitlementEventSchema.parse({ ...event, eventId: randomUUID(), membershipCheckout: {
      ...event.membershipCheckout, id: another.record.id, providerCheckoutReference: secondBinding.providerReference, providerCouponReference: secondBinding.providerCouponReference } })
    await expect(run(() => commerce.reconcileProviderEntitlement(f.workspaceId, rebound, backend))).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query('SELECT status FROM association_membership_checkouts WHERE id=$1', [another.record.id])).rows[0].status).toBe('provider_bound')
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3', [f.workspaceId, departmentId, f.userId])
    await expect(reserve()).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(run(() => commerce.bindMembershipCheckoutProvider(f.workspaceId, checkoutId, binding, backend))).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(run(() => commerce.reconcileProviderEntitlement(f.workspaceId, event, backend))).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await commerce.listMemberships(f.workspaceId, f.buyerId, {}, f.actor)).toEqual([])
    expect((await pool.query('SELECT count(*)::int n FROM association_memberships WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
    // Even an independently weaker child envelope cannot bypass its saved parent.
    await pool.query(`UPDATE association_memberships SET scope_snapshot=scope_snapshot || '{"sensitivity":"internal","compartments":[]}'::jsonb,
      scope_sources=(SELECT jsonb_agg(s || '{"sensitivity":"internal","compartments":[]}'::jsonb) FROM jsonb_array_elements(scope_sources) s) WHERE id=$1`, [granted.record.id])
    expect(await commerce.listMemberships(f.workspaceId, f.buyerId, {}, f.actor)).toEqual([])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [f.workspaceId, departmentId, f.userId])
    await pool.query('UPDATE association_membership_checkouts SET scope_snapshot=NULL,scope_sources=NULL WHERE id=$1', [checkoutId])
    await expect(reserve()).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await commerce.listMemberships(f.workspaceId, f.buyerId, {}, f.actor)).toEqual([])
  })

  it('applies approved buy-one-get-one terms only when quantity qualifies', async () => {
    const f = await fixture()
    await f.savePromotion({ discountType: 'buy_x_get_y', percentageBasisPoints: undefined, buyQuantity: 1, getQuantity: 1 })
    await expect(f.order()).rejects.toMatchObject({ code: 'promotion_not_applicable' })
    const order = await f.order(f.buyerId, randomUUID(), { lines: [{ ticketId: f.ticketId, quantity: 2,
      attendees: [{ contactId: f.buyerId, name: 'First' }, { contactId: f.secondBuyerId, name: 'Second' }] }] })
    expect(order.record).toMatchObject({ subtotalMinor: '2000', discountMinor: '1000', totalMinor: '1000' })
  })

  it('serializes the last global use and releases a cancelled reservation', async () => {
    const f = await fixture()
    await f.savePromotion({ maxUses: 1, maxUsesPerContact: null })
    const attempts = await Promise.allSettled([f.order(f.buyerId), f.order(f.secondBuyerId)])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected'))
      .toMatchObject([{ reason: { code: 'promotion_exhausted' } }])
    const accepted = attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof f.order>>>
    await commerce.cancelOrder(f.workspaceId, String(accepted.value.record.id), f.actor)
    const replacement = await f.order(f.secondBuyerId)
    expect(replacement.created).toBe(true)
  })

  it('keeps member pricing separate and requires explicit combination', async () => {
    const f = await fixture()
    await f.savePromotion()
    const plan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({
      key: 'member', name: 'Member', currency: 'HKD', feeMinor: 1_000, billingPeriod: 'annual', published: true,
    }), f.actor)
    await commerce.createMembership(f.workspaceId, MembershipInputSchema.parse({
      contactId: f.buyerId, planId: String(plan.record.id), idempotencyKey: randomUUID(), status: 'active',
      startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', renewalMode: 'none',
    }), f.actor)
    await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({
      key: 'standard', name: 'Standard', currency: 'HKD', priceMinor: 1_000, memberPriceMinor: 800,
      eligiblePlanKeys: ['member'], eligibilityRequired: false, status: 'on_sale', capacity: 100, perOrderLimit: 10,
    }), f.actor)
    await expect(f.order(f.buyerId, randomUUID(), { lines: [{ ticketId: f.ticketId, quantity: 1,
      useMemberPrice: true, attendees: [{ contactId: f.buyerId, name: 'Fictional buyer' }] }] }))
      .rejects.toMatchObject({ code: 'promotion_not_applicable' })
    await f.savePromotion({ combinesWithMemberPrice: true })
    const combined = await f.order(f.buyerId, randomUUID(), { lines: [{ ticketId: f.ticketId, quantity: 1,
      useMemberPrice: true, attendees: [{ contactId: f.buyerId, name: 'Fictional buyer' }] }] })
    expect(combined.record).toMatchObject({ subtotalMinor: '1000', discountMinor: '280', totalMinor: '720' })
    const other = await commerce.upsertPromotion(f.workspaceId, PromotionInputSchema.parse({
      key: 'wrong-event', name: 'Wrong event', code: 'WRONG-EVENT', discountType: 'full', targetKind: 'event',
      targetIds: [randomUUID()], status: 'active',
    }), f.actor).catch(error => error)
    expect(other).toMatchObject({ code: 'not_found' })
  })

  it('imports immutable Wix usage by digest and combines source and live caps', async () => {
    const f = await fixture(), code = ' Wix-Legacy-20 '
    const codeDigest = createHmac('sha256', promotionHmacKey)
      .update(code.trim().normalize('NFKC').toUpperCase(), 'utf8').digest('hex')
    const input = PromotionImportSchema.parse({
      importJobId: randomUUID(), importRow: 2,
      source: 'wix', sourceSite: 'oasahk.org', sourcePromotionId: 'coupon-legacy-20', codeDigest,
      promotion: {
        key: 'legacy-twenty', name: 'Legacy 20%', discountType: 'percentage', percentageBasisPoints: 2_000,
        targetKind: 'event', targetIds: [f.eventId], maxUses: 3, maxUsesPerContact: 2, status: 'active',
      },
      sourceRedeemedUses: 2,
      sourceContactUses: [{ contactId: f.buyerId, uses: 2 }],
    })
    const importActor = { credentialKind: 'import' as const, credentialId: input.importJobId, actingUserId: f.userId }
    const imported = await commerce.importPromotion(f.workspaceId, input, importActor)
    expect(imported).toMatchObject({ created: true, record: {
      sourceSystem: 'wix', sourceSite: 'oasahk.org', sourcePromotionId: 'coupon-legacy-20',
      sourceRedeemedUses: 2, redeemedUses: 2,
    } })
    const replayJobId = randomUUID()
    const replay = await commerce.importPromotion(f.workspaceId, {
      ...input, importJobId: replayJobId, importRow: 7,
    }, { ...importActor, credentialId: replayJobId })
    expect(replay).toMatchObject({ created: false, record: { id: imported.record.id } })
    await expect(commerce.importPromotion(f.workspaceId, input,
      { ...importActor, credentialId: randomUUID() })).rejects.toMatchObject({ code: 'not_authorized' })
    const changedJobId = randomUUID()
    await expect(commerce.importPromotion(f.workspaceId, {
      ...input, importJobId: changedJobId, importRow: 8,
      promotion: { ...input.promotion, name: 'Changed evidence' },
    }, { ...importActor, credentialId: changedJobId })).rejects.toMatchObject({ code: 'conflict' })

    const stored = (await pool.query(`SELECT code_digest,source_import::text
      FROM association_promotions WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, imported.record.id])).rows[0]
    expect(stored.code_digest).toBe(codeDigest)
    expect(JSON.stringify(stored)).not.toContain(code.trim())
    await expect(pool.query(`UPDATE association_promotions SET source_promotion_id='changed'
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, imported.record.id])).rejects.toMatchObject({ code: '23514' })

    await expect(f.order(f.buyerId, randomUUID(), { promotionCode: code })).rejects
      .toMatchObject({ code: 'promotion_exhausted' })
    const remaining = await f.order(f.secondBuyerId, randomUUID(), { promotionCode: code })
    expect(remaining.record).toMatchObject({ subtotalMinor: '1000', discountMinor: '200', totalMinor: '800' })
    await expect(f.order(f.secondBuyerId, randomUUID(), { promotionCode: code })).rejects
      .toMatchObject({ code: 'promotion_exhausted' })
    await expect(commerce.upsertPromotion(f.workspaceId, PromotionInputSchema.parse({
      ...input.promotion, maxUses: 2,
    }), f.actor)).rejects.toMatchObject({ code: 'promotion_invalid' })
  })
})
