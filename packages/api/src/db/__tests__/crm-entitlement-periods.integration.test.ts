import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { type CrmOperationsContext, type CrmOperationsCommand, CrmOperationsCommandSchema } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../../context-scope/department-resolver.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { crmIntegrationContext } from '../../routes/crm-integration.js'
import { createAssociationStore } from '../association-store.js'
import { MembershipInputSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), service = createCrmOperationsService(createDbCrmOperationsStore()), legacy = createAssociationStore()
type Grant = Extract<CrmOperationsCommand, { kind: 'grant_entitlement' }>
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID(), planId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Period fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional member',$3,'manual')", [contactId, workspaceId, userId])
  await pool.query("INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,$2,'standard','Standard','USD',0,'annual')", [planId, workspaceId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'system_job', job: 'entitlement_reconciliation', runId: randomUUID() }, authority: { role: 'system', canConfigure: false, canWrite: true, trustedIdentitySources: [] } }
  // Capture a real host execution ceiling; the system-job label alone grants nothing.
  const scopeInput = { workspaceId, userId, assistantId: null }
  const { snapshot, principal } = await loadDepartmentSnapshot(
    async <R>(sql: string, values: unknown[]) => ({ rows: (await pool.query(sql, values)).rows as R[] }), scopeInput)
  const departmentRead = resolveDepartmentReadGrant(snapshot, principal, scopeInput, new Date())
  const withAuthority = <T>(run: () => T): T => runWithAgentAccess({ workspaceId, userId,
    clearance: 'internal', compartments: null, departmentRead }, run)
  const execute = (ctx: CrmOperationsContext, command: CrmOperationsCommand) => withAuthority(() => service.execute(ctx, command))
  const actor = { credentialKind: 'system_job' as const, credentialId: `entitlement_reconciliation:${context.actor.kind === 'system_job' ? context.actor.runId : ''}` }
  const input: Grant = { kind: 'grant_entitlement', contactId, planId, idempotencyKey: randomUUID(), status: 'active', startsAt: '2000-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', renewalMode: 'auto', provider: 'fixture', providerEntitlementId: 'fixture-subscription', providerPeriodId: 'period-1' }
  const grant = (patch: Partial<Grant> = {}, ctx = context) => execute(ctx, { ...input, ...patch })
  return { workspaceId, userId, context, input, grant, execute, withAuthority, actor }
}
describe('[COMP:crm/entitlement-periods] Actual provider renewal lineage', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('replays a period once across transport keys, preserves microseconds and rejects changed payloads', async () => {
    const f = await fixture(), patch = { startsAt: '2000-01-01T00:00:00.000001Z' }
    const first = await f.grant(patch), retry = await f.grant({ ...patch, idempotencyKey: randomUUID() })
    expect(first.record).toMatchObject({ providerPeriodId: 'period-1', predecessorId: null })
    expect(retry).toMatchObject({ duplicate: true, record: { id: first.record.id } })
    await expect(f.grant({ startsAt: '2000-01-01T00:00:00.000002Z', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query("SELECT count(*)::int n FROM crm_domain_event_outbox WHERE workspace_id=$1 AND event_type='crm.entitlement.changed'", [f.workspaceId])).rows[0].n).toBe(1)
  })
  it('extends active grants in place and preserves cancel-at-period-end access separately from immediate cancellation', async () => {
    const f = await fixture(), id = String((await f.grant()).record.id)
    await f.execute(f.context, { kind: 'update_entitlement', entitlementId: id, endsAt: '2100-01-01T00:00:00Z', renewalMode: 'none' })
    expect((await legacy.listMemberships(f.workspaceId, f.input.contactId, { activeOnly: true }))).toMatchObject([{ id, renewalMode: 'none', isEffective: true }])
    await expect(f.grant({ providerPeriodId: 'period-2', predecessorId: id, startsAt: '2001-01-01T00:00:00Z', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'provider_period_predecessor_invalid' } })
    await f.execute(f.context, { kind: 'update_entitlement', entitlementId: id, status: 'cancelled' })
    expect(await legacy.listMemberships(f.workspaceId, f.input.contactId, { activeOnly: true })).toEqual([])
    await expect(f.execute(f.context, { kind: 'update_entitlement', entitlementId: id, status: 'active' })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('renews a terminal period into one successor under concurrent delivery without reviving the predecessor', async () => {
    const f = await fixture(), id = String((await f.grant({ status: 'expired', endsAt: '2001-01-01T00:00:00Z' })).record.id)
    const patch = { providerPeriodId: 'period-2', predecessorId: id, startsAt: '2001-01-01T00:00:00Z' }
    const results = await Promise.all([f.grant({ ...patch, idempotencyKey: randomUUID() }), f.grant({ ...patch, idempotencyKey: randomUUID() })])
    expect(results.filter(r => r.created)).toHaveLength(1)
    expect(results[0].record.id).toBe(results[1].record.id)
    expect(results[0].record).toMatchObject({ predecessorId: id, providerPeriodId: 'period-2', status: 'active' })
    expect((await pool.query('SELECT status FROM association_memberships WHERE id=$1', [id])).rows[0].status).toBe('expired')
    await expect(f.grant({ ...patch, providerPeriodId: 'period-3', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('refuses a foreign, mismatched, omitted or stale predecessor and guards direct database resurrection', async () => {
    const f = await fixture(), g = await fixture(), id = String((await f.grant({ status: 'cancelled' })).record.id), foreign = String((await g.grant({ status: 'cancelled' })).record.id)
    for (const predecessorId of [undefined, foreign, randomUUID()]) await expect(f.grant({ providerPeriodId: 'period-2', predecessorId, startsAt: '2001-01-01T00:00:00Z', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    await expect(pool.query("UPDATE association_memberships SET status='active' WHERE id=$1", [id])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query("UPDATE association_memberships SET provider_period_id='changed' WHERE id=$1", [id])).rejects.toMatchObject({ code: '23514' })
  })
  it('refuses human/provider-mismatch mutation while leaving manual membership available', async () => {
    const f = await fixture(), human: CrmOperationsContext = { ...f.context, actor: { kind: 'user', userId: f.userId } }
    await expect(f.grant({}, human)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.grant({}, { ...f.context, actor: { kind: 'provider', provider: 'foreign', eventId: 'fixture-event' } })).rejects.toMatchObject({ code: 'not_authorized' })
    const id = String((await f.grant()).record.id)
    await expect(f.execute(human, { kind: 'update_entitlement', entitlementId: id, status: 'cancelled' })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(legacy.updateMembership(f.workspaceId, id, { status: 'cancelled' }, { credentialKind: 'user', credentialId: f.userId })).rejects.toMatchObject({ code: 'not_authorized' })
    const manual = await f.grant({ provider: undefined, providerEntitlementId: undefined, providerPeriodId: undefined, idempotencyKey: randomUUID() }, human)
    expect(manual.record.provider).toBe(null)
  })
  it('shares replay and lineage with the direct compatibility membership store and keeps legacy rows valid', async () => {
    const f = await fixture(), actor = f.actor
    const input = MembershipInputSchema.parse({ ...f.input, providerMembershipId: f.input.providerEntitlementId })
    const first = await f.withAuthority(() => legacy.createMembership(f.workspaceId, input, actor))
    const replay = await f.grant({ idempotencyKey: randomUUID() })
    expect(replay).toMatchObject({ duplicate: true, record: { id: first.record.id } })
    await f.withAuthority(() => legacy.updateMembership(f.workspaceId, String(first.record.id), { status: 'expired' }, actor))
    await expect(f.withAuthority(() => legacy.updateMembership(f.workspaceId, String(first.record.id), { status: 'active' }, actor))).rejects.toMatchObject({ code: 'invalid_transition' })
    const next = await f.withAuthority(() => legacy.createMembership(f.workspaceId, { ...input, idempotencyKey: randomUUID(), providerPeriodId: 'period-2', predecessorId: String(first.record.id), startsAt: '2001-01-01T00:00:00Z' }, actor))
    expect(next.record).toMatchObject({ predecessorId: first.record.id, providerPeriodId: 'period-2' })
    const g = await fixture(), old = MembershipInputSchema.parse({ ...g.input, providerPeriodId: undefined, providerMembershipId: 'legacy-subscription' })
    const legacyGrant = await g.withAuthority(() => legacy.createMembership(g.workspaceId, old, g.actor))
    expect((await g.withAuthority(() => legacy.createMembership(g.workspaceId, old, g.actor))).created).toBe(false)
    expect(legacyGrant.record.providerPeriodId).toBe(null)
  })
  it('rolls back a successor and its evidence if audit fails, and retries the same period safely', async () => {
    const f = await fixture()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_period_audit CHECK(action<>'crm.entitlement.changed') NOT VALID")
    try {
      await expect(f.grant()).rejects.toThrow()
      expect((await pool.query('SELECT count(*)::int n FROM association_memberships WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    } finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_period_audit') }
    expect((await f.grant()).created).toBe(true)
  })
  it('requires both current plan and provider scopes and rejects a revoked integration on replay', async () => {
    const f = await fixture(), keys = createCrmIntegrationStore()
    const narrow = await keys.create(f.workspaceId, f.userId, { label: 'Period fixture', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.entitlements.write', selectors: { planIds: [f.input.planId] } }] })
    const narrowContext = crmIntegrationContext((await keys.authenticate(narrow.oneTimeSecret))!)
    await expect(f.grant({}, narrowContext)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const granted = await keys.create(f.workspaceId, f.userId, { label: 'Period backend', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.entitlements.write', selectors: { planIds: [f.input.planId] } },
        { operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'] } }] })
    const principal = (await keys.authenticate(granted.oneTimeSecret))!, context = crmIntegrationContext(principal)
    const first = await f.grant({}, context)
    await expect(f.grant({ provider: 'foreign', providerEntitlementId: 'other', idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await keys.revoke(f.workspaceId, f.userId, principal.credentialId)
    await expect(f.grant({}, context)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect(first.created).toBe(true)
  })
  it('keeps microsecond predecessor ordering and allows atomic erasure of a complete same-subject chain', async () => {
    const f = await fixture(), first = await f.grant({ status: 'cancelled', startsAt: '2000-01-01T00:00:00.000001Z' })
    const next = await f.grant({ predecessorId: String(first.record.id), providerPeriodId: 'period-2', idempotencyKey: randomUUID(), startsAt: '2000-01-01T00:00:00.000002Z' })
    expect(next.created).toBe(true)
    await pool.query('DELETE FROM entities WHERE workspace_id=$1 AND id=$2', [f.workspaceId, f.input.contactId])
    expect((await pool.query('SELECT id FROM association_memberships WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  })
  it('denies an unbound job and renews the captured host membership before replay', async () => {
    const f = await fixture()
    await expect(service.execute(f.context, f.input)).rejects.toMatchObject({ code: 'not_authorized' })
    const first = await f.grant()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId,f.userId])
    await expect(f.grant()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT id FROM association_memberships WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{id:first.record.id}])
  })
  it('rejects malformed period requests at the canonical contract boundary', () => {
    const base = { kind: 'grant_entitlement', contactId: randomUUID(), planId: randomUUID(), idempotencyKey: 'fixture', startsAt: '2000-01-01T00:00:00Z' }
    expect(CrmOperationsCommandSchema.safeParse({ ...base, providerPeriodId: 'period-1' }).success).toBe(false)
    expect(CrmOperationsCommandSchema.safeParse({ ...base, predecessorId: randomUUID() }).success).toBe(false)
  })
})
