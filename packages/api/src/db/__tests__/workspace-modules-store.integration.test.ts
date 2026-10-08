import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineWorkspaceModuleRegistry } from '@use-brian/shared'
import { createWorkspaceModulesStore } from '../workspace-modules-store.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createAssociationStore } from '../association-store.js'
import { EventInputSchema, OrderCreateSchema, PlanInputSchema, TicketInputSchema } from '../../association/domain.js'

const fixtureScript = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { assertLocalFixture } = await import(fixtureScript)
// Never let the general integration config's fallback target reach this suite.
await assertLocalFixture()
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, application_name: 'assurance-owner' })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, max: 8, application_name: 'assurance-member' })
const modules = createAssociationWorkspaceModulesStore(owner, app)
const commerce = createAssociationStore(owner)
const actor = { credentialKind: 'api_key' as const, credentialId: 'fixture-key' }
/** Provider settlement is a verified backend provider path, not a member action. */
const providerActor = { credentialKind: 'provider' as const, credentialId: 'fixture-provider' }
const testRegistry = defineWorkspaceModuleRegistry({ test_module: { key: 'test_module', defaultState: 'disabled' } } as const)

async function workspace(v2 = true) {
  const userId = randomUUID()
  const memberId = randomUUID()
  const workspaceId = randomUUID()
  await owner.query(`INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)`, [userId, memberId])
  await owner.query(`INSERT INTO workspaces (id,name,owner_user_id,department_read_v2) VALUES ($1,'Fixture association',$2,$3)`, [workspaceId, userId, v2])
  await owner.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [workspaceId, userId, memberId])
  return { workspaceId, userId, memberId, actor: { credentialKind: 'user' as const, credentialId: userId } }
}

async function enabledCommerce(v2 = true) {
  const fixture = await workspace(v2)
  const { workspaceId, userId } = fixture
  // Act as the workspace user: under department read v2 an anonymous key has no
  // department authority (association-operations.md), so the fixture uses a user actor.
  const userActor = { credentialKind: 'user' as const, credentialId: userId }
  const enabled = await modules.act(workspaceId, userId, 'association', { action: 'enable', expectedVersion: 1 })
  const contactId = randomUUID()
  await owner.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source)
    VALUES ($1,$2,'person','Fixture Attendee',$3,'manual')`, [contactId, workspaceId, userId])
  const event = await commerce.upsertEvent(workspaceId, EventInputSchema.parse({
    slug: 'fixture-event', title: 'Fixture event', startsAt: '2099-01-01T12:00:00Z',
    endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10,
  }), userActor)
  const eventId = String(event.record.id)
  const ticket = await commerce.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({
    key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 100, status: 'on_sale', capacity: 10,
  }), userActor)
  const input = OrderCreateSchema.parse({ contactId, idempotencyKey: randomUUID(),
    lines: [{ ticketId: ticket.record.id, quantity: 1, attendees: [{ name: 'Fixture Attendee' }] }] })
  return { ...fixture, contactId, eventId, ticketId: String(ticket.record.id), input, enabled, actor: userActor }
}

/** Observe PostgreSQL's lock wait rather than assuming a sleep means blocked. */
async function blocked(fragment: string, application: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await owner.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND application_name=$1 AND wait_event_type='Lock' AND position($2 in query)>0`, [application, fragment])
    if (result.rowCount) return
    await setTimeout(10)
  }
  throw new Error(`No observed lock wait for ${application}: ${fragment}`)
}

describe('[COMP:api/workspace-modules] Actual lifecycle and admission transactions', () => {
  beforeAll(async () => { await owner.query('SELECT 1') })
  afterAll(async () => { await Promise.all([owner.end(), app.end()]) })

  it('backfills existing workspaces without changing Home or assistant grants (M1)', async () => {
    const f = await workspace()
    const client = await owner.connect()
    try {
      await client.query('BEGIN')
      const before = await client.query('SELECT home_apps FROM workspaces WHERE id=$1', [f.workspaceId])
      const grants = await client.query('SELECT count(*) FROM assistant_capabilities')
      // Rehearse the actual additive migration on its pre-migration schema
      // inside a rollback-only transaction owned exclusively by this fixture.
      await client.query(`DROP TRIGGER workspaces_provision_modules ON workspaces;
        DROP FUNCTION public.provision_workspace_modules(); DROP TABLE workspace_modules`)
      const migration = await readFile(new URL('../../../migrations/497_workspace_modules.sql', import.meta.url), 'utf8')
      await client.query(migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''))
      expect((await client.query('SELECT state,version,updated_by_user_id FROM workspace_modules WHERE workspace_id=$1', [f.workspaceId])).rows)
        .toEqual([{ state: 'enabled', version: 1, updated_by_user_id: null }])
      expect((await client.query('SELECT home_apps FROM workspaces WHERE id=$1', [f.workspaceId])).rows).toEqual(before.rows)
      expect((await client.query('SELECT count(*) FROM assistant_capabilities')).rows).toEqual(grants.rows)
      expect((await client.query(`SELECT 1 FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'`, [f.workspaceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it('starts disabled, requires admin, preserves generic CRM, and audits only versioned changes (M1/M2)', async () => {
    const f = await workspace()
    const initial = await modules.listForMember(f.workspaceId, f.memberId)
    expect(initial[0]).toMatchObject({ state: 'disabled', version: 1 })
    await expect(modules.act(f.workspaceId, f.memberId, 'association', { action: 'enable', expectedVersion: 1 })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(modules.listForMember(f.workspaceId, randomUUID())).rejects.toMatchObject({ code: 'not_authorized' })
    await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({ key: 'general', name: 'General', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' }), f.actor)
    expect((await commerce.listPlans(f.workspaceId, { limit: 100, cursor: null })).items).toHaveLength(1)
    const enabled = await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 1 })
    expect(enabled).toMatchObject({ changed: true, module: { state: 'enabled', version: 2 } })
    expect(await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 2 })).toMatchObject({ changed: false })
    await expect(modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'stale_module_version' })
    expect((await owner.query(`SELECT details FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'`, [f.workspaceId])).rows)
      .toEqual([{ details: { moduleKey: 'association', action: 'enable', from: 'disabled', to: 'enabled', version: 2 } }])
  })

  it('runs a second test module through the same registry, store and blocker seam', async () => {
    const f = await workspace()
    let blockingCount = 2
    const testModules = createWorkspaceModulesStore(owner, app, {
      registry: testRegistry,
      lifecycles: { test_module: { readBlockingWork: async () => [{ key: 'pending_jobs', count: blockingCount }] } },
    })
    expect(await testModules.listForMember(f.workspaceId, f.memberId))
      .toEqual([expect.objectContaining({ moduleKey: 'test_module', state: 'disabled', version: 0 })])
    expect(await testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'enable', expectedVersion: 0 }))
      .toMatchObject({ changed: true, module: { moduleKey: 'test_module', state: 'enabled', version: 2 } })
    expect(await testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'request_disable', expectedVersion: 2 }))
      .toMatchObject({ changed: true, module: { state: 'draining', version: 3 },
        blockingWork: [{ key: 'pending_jobs', count: 2 }] })
    await expect(testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'finish_disable', expectedVersion: 3 }))
      .rejects.toMatchObject({ code: 'module_drain_pending', details: {
        moduleKey: 'test_module', blockingWork: [{ key: 'pending_jobs', count: 2 }],
      } })
    blockingCount = 0
    expect(await testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'finish_disable', expectedVersion: 3 }))
      .toMatchObject({ changed: true, module: { state: 'disabled', version: 4 } })
  })

  it('fails closed on missing rows and provisions only under owner lifecycle authority', async () => {
    const f = await workspace()
    await owner.query('DELETE FROM workspace_modules WHERE workspace_id=$1', [f.workspaceId])
    expect(await modules.get(f.workspaceId, 'association')).toMatchObject({ state: 'disabled', version: 0 })
    await expect(commerce.upsertTicket(f.workspaceId, randomUUID(), TicketInputSchema.parse({
      key: 'blocked', name: 'Blocked', currency: 'USD', priceMinor: 0,
    }), f.actor)).rejects.toMatchObject({ code: 'module_disabled' })
    expect(await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 0 }))
      .toMatchObject({ changed: true, module: { state: 'enabled', version: 2 } })
  })

  it('waits for admitted orders before returning draining, then refuses new commerce (M3)', async () => {
    const f = await enabledCommerce()
    const held = await owner.connect()
    await held.query('BEGIN')
    await held.query('SELECT id FROM association_events WHERE id=$1 FOR UPDATE', [f.eventId])
    const order = commerce.createOrder(f.workspaceId, f.input, f.actor)
    // Handle any rejection while observing locks, so a broken assertion is not
    // masked by a later unhandled rejection or a leaked test connection.
    void order.catch(() => undefined)
    let shutdown: ReturnType<typeof modules.act> | undefined
    try {
      await blocked('FROM association_events WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', 'assurance-owner')
      shutdown = modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 2 })
      void shutdown.catch(() => undefined)
      await blocked('module_key=$2 FOR UPDATE', 'assurance-member')
    } finally { await held.query('ROLLBACK'); held.release() }
    const created = await order
    expect(await shutdown).toMatchObject({ changed: true, pendingOrders: 1, module: { state: 'draining', version: 3 } })
    await expect(commerce.createOrder(f.workspaceId, { ...f.input, idempotencyKey: randomUUID() }, f.actor))
      .rejects.toMatchObject({ code: 'module_draining' })
    expect((await commerce.createOrder(f.workspaceId, f.input, f.actor)).record.id).toBe(created.record.id)
    await expect(modules.act(f.workspaceId, f.userId, 'association', { action: 'finish_disable', expectedVersion: 3 }))
      .rejects.toMatchObject({ code: 'module_drain_pending', details: {
        moduleKey: 'association', blockingWork: [{ key: 'pending_orders', count: 1 }],
      } })
  })

  it('refuses admission when shutdown wins, and does not lock another workspace (M3)', async () => {
    const f = await enabledCommerce()
    const other = await workspace()
    let pauseReached!: () => void
    let releasePause!: () => void
    const reached = new Promise<void>((resolve) => { pauseReached = resolve })
    const pause = new Promise<void>((resolve) => { releasePause = resolve })
    // Pause only scheduling, after the actual UPDATE on an actual pg client.
    // Both state change and audit still execute through the lifecycle store.
    const pausedPool = { connect: async () => {
      const client = await app.connect()
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params)
          if (sql.startsWith('UPDATE workspace_modules')) { pauseReached(); await pause }
          return result
        },
        release: () => client.release(),
      }
    } } as unknown as pg.Pool
    const shutdown = createAssociationWorkspaceModulesStore(owner, pausedPool).act(f.workspaceId, f.userId,
      'association', { action: 'request_disable', expectedVersion: 2 })
    void shutdown.catch(() => undefined)
    await Promise.race([reached, shutdown.then(() => { throw new Error('Expected an uncommitted transition') })])
    const order = commerce.createOrder(f.workspaceId, f.input, f.actor)
    const rejected = expect(order).rejects.toMatchObject({ code: 'module_disabled' })
    try {
      await blocked('module_key=$2 FOR SHARE', 'assurance-owner')
      expect(await modules.act(other.workspaceId, other.userId, 'association', { action: 'enable', expectedVersion: 1 }))
        .toMatchObject({ changed: true })
    } finally { releasePause() }
    expect(await shutdown).toMatchObject({ changed: true, module: { state: 'disabled', version: 3 } })
    await rejected
    expect((await owner.query('SELECT 1 FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
  })

  it('supports provider recovery, exact replay and check-in/refund after disable (M4)', async () => {
    // Legacy model: under v2 provider settlement runs through a bound integration
    // credential (provider-inbox suite); a bare provider actor has no department authority.
    const f = await enabledCommerce(false)
    const created = await commerce.createOrder(f.workspaceId, f.input, f.actor)
    const id = String(created.record.id)
    const paid = { provider: 'fixture', providerReference: randomUUID(), amountMinor: Number(created.record.totalMinor), currency: String(created.record.currency), eventId: randomUUID(), targetStatus: 'paid' as const, occurredAt: new Date().toISOString(), metadata: {} }
    await commerce.bindOrderProvider(f.workspaceId, id, { provider: paid.provider, providerReference: paid.providerReference, amountMinor: paid.amountMinor, currency: paid.currency }, providerActor)
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 2 })
    await commerce.reconcileProviderEvent(f.workspaceId, id, paid, providerActor)
    expect(await modules.act(f.workspaceId, f.userId, 'association', { action: 'finish_disable', expectedVersion: 3 }))
      .toMatchObject({ module: { state: 'disabled', version: 4 }, pendingOrders: 0 })
    const replay = await commerce.createOrder(f.workspaceId, f.input, f.actor)
    expect(replay).toMatchObject({ created: false, record: { id, status: 'paid' } })
    await expect(commerce.createOrder(f.workspaceId, { ...f.input, reservationMinutes: 10 }, f.actor)).rejects.toMatchObject({ code: 'conflict' })
    expect(await commerce.reconcileProviderEvent(f.workspaceId, id, paid, providerActor)).toMatchObject({ created: false })
    const registration = (await owner.query('SELECT id FROM association_registrations WHERE order_id=$1', [id])).rows[0]
    expect(await commerce.updateRegistration(f.workspaceId, registration.id, { status: 'checked_in' }, f.actor)).toMatchObject({ status: 'checked_in' })
    expect(await commerce.reconcileProviderEvent(f.workspaceId, id, { ...paid, eventId: randomUUID(), targetStatus: 'refunded' }, providerActor))
      .toMatchObject({ record: { status: 'refunded' } })
    expect(await commerce.getOrder(f.workspaceId, id)).toMatchObject({ id, status: 'refunded' })
  })

  it('enforces module RLS for app-role read/write and prevents member escalation', async () => {
    const f = await workspace()
    const other = await workspace()
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.memberId])
      expect((await client.query('SELECT workspace_id FROM workspace_modules')).rows).toEqual([{ workspace_id: f.workspaceId }])
      expect((await client.query(`UPDATE workspace_modules SET state='enabled' WHERE workspace_id=$1`, [f.workspaceId])).rowCount).toBe(0)
      expect((await client.query(`UPDATE workspace_modules SET state='enabled' WHERE workspace_id=$1`, [other.workspaceId])).rowCount).toBe(0)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.userId])
      await expect(client.query(`INSERT INTO workspace_modules (workspace_id,module_key) VALUES ($1,'association')`, [other.workspaceId])).rejects.toThrow(/row-level security/)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
