import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { ProviderEntitlementEventSchema, type AssociationActor } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createProviderEntitlementService } from '../provider-entitlement-service.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const appPool = getAppPool()

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture(v2 = false) {
  const workspaceId = randomUUID()
  const userId = randomUUID()
  const contactId = randomUUID()
  const planId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  // These unbound API-key transaction cases exercise the legacy credential lane.
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Provider entitlement fixture',$2,$3)", [workspaceId, userId, v2])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional member',$3,'manual')", [contactId, workspaceId, userId])
  await pool.query(`INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period)
    VALUES($1,$2,'fixture-plan','Fictional plan','USD',1000,'annual')`, [planId, workspaceId])
  const actor: AssociationActor = { credentialKind: 'api_key', credentialId: randomUUID() }
  const providerReference = `subscription-${randomUUID()}`
  const event = ProviderEntitlementEventSchema.parse({
    provider: 'fixture',
    eventId: randomUUID(),
    providerReference,
    providerPeriodId: 'period-1',
    occurredAt: '2026-09-01T12:00:00.000001Z',
    command: {
      kind: 'grant_entitlement',
      contactId,
      planId,
      idempotencyKey: randomUUID(),
      provider: 'fixture',
      providerEntitlementId: providerReference,
      providerPeriodId: 'period-1',
      status: 'active',
      startsAt: '2026-09-01T00:00:00Z',
      endsAt: '2027-09-01T00:00:00Z',
      renewalMode: 'auto',
    },
  })
  return { workspaceId, contactId, planId, actor, event }
}

function serviceFor(providerPool: Pool, onClient?: (client: PoolClient) => void) {
  return createProviderEntitlementService({
    pool: providerPool,
    operationsForTransaction: (client) => {
      onClient?.(client)
      return createCrmOperationsService(createDbCrmOperationsStore(providerPool, client))
    },
  })
}

async function counts(input: Fixture) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM association_memberships WHERE workspace_id=$1) entitlements,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1 AND action='crm.entitlement.changed') audits,
    (SELECT count(*)::int FROM crm_domain_event_outbox WHERE workspace_id=$1 AND event_type='crm.entitlement.changed') events,
    (SELECT count(*)::int FROM association_integration_events WHERE workspace_id=$1) receipts`, [input.workspaceId])).rows[0]
}

function observedPool() {
  let connects = 0
  const statements = new Map<PoolClient, string[]>()
  const wrapped = {
    query: pool.query.bind(pool),
    async connect() {
      connects++
      const actual = await pool.connect()
      const client = {
        ...actual,
        release: actual.release.bind(actual),
        query: async (sql: string, params?: unknown[]) => {
          statements.get(client as unknown as PoolClient)!.push(sql)
          return actual.query(sql, params)
        },
      } as unknown as PoolClient
      statements.set(client, [])
      return client
    },
  } as unknown as Pool
  return { pool: wrapped, statements, connects: () => connects }
}

function failBeforeReceiptAcknowledgement() {
  let fired = false
  return {
    query: pool.query.bind(pool),
    async connect() {
      const actual = await pool.connect()
      return {
        ...actual,
        release: actual.release.bind(actual),
        query: async (sql: string, params?: unknown[]) => {
          if (!fired && sql.includes("SET state='applied'")) {
            fired = true
            throw Object.assign(new Error('synthetic acknowledgement failure'), { code: '40001' })
          }
          return actual.query(sql, params)
        },
      }
    },
  } as unknown as Pool
}

describe('[COMP:crm/provider-entitlement-service] PostgreSQL transaction ownership', () => {
  afterAll(async () => {
    _resetCoalescerForTests()
    await pool.end()
    await appPool.end()
  })

  it('refuses an unbound provider credential in v2 without creating entitlement effects', async () => {
    const input = await fixture(true)
    await expect(serviceFor(pool).submit(input.workspaceId, input.event, input.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await counts(input)).toEqual({ entitlements: 0, audits: 0, events: 0, receipts: 0 })
  })

  it('uses one application client for entitlement, audit, outbox, and receipt acknowledgement', async () => {
    const input = await fixture()
    const observed = observedPool()
    let applicationClient: PoolClient | undefined
    const result = await serviceFor(observed.pool, (client) => { applicationClient = client })
      .submit(input.workspaceId, input.event, input.actor)

    expect(result).toMatchObject({ created: true, receipt: { state: 'applied' } })
    expect(observed.connects()).toBe(3)
    const sql = observed.statements.get(applicationClient!)?.join('\n') ?? ''
    expect(sql).toContain('INSERT INTO association_memberships')
    expect(sql).toContain('INSERT INTO association_audit_log')
    expect(sql).toContain('INSERT INTO crm_domain_event_outbox')
    expect(sql).toContain("SET state='applied'")
    expect(await counts(input)).toEqual({ entitlements: 1, audits: 1, events: 1, receipts: 1 })
  })

  it('rolls back every domain effect when receipt acknowledgement fails', async () => {
    const input = await fixture()
    await expect(serviceFor(failBeforeReceiptAcknowledgement()).submit(input.workspaceId, input.event, input.actor))
      .rejects.toMatchObject({ details: { receiptState: 'retry' } })
    expect(await counts(input)).toEqual({ entitlements: 0, audits: 0, events: 0, receipts: 1 })
    expect((await pool.query('SELECT state,last_error_code FROM association_integration_events WHERE workspace_id=$1', [input.workspaceId])).rows[0])
      .toMatchObject({ state: 'retry', last_error_code: 'transient_failure' })
  })

  it('serializes concurrent admission, reuses exact receipts, and rejects changed fingerprints', async () => {
    const input = await fixture()
    const service = serviceFor(pool)
    const concurrent = await Promise.allSettled([
      service.submit(input.workspaceId, input.event, input.actor),
      service.submit(input.workspaceId, input.event, input.actor),
    ])
    expect(concurrent.some((result) => result.status === 'fulfilled')).toBe(true)
    const replay = await service.submit(input.workspaceId, input.event, input.actor)
    expect(replay).toMatchObject({ created: false, receipt: { state: 'applied', attempts: 1 } })
    const changed = ProviderEntitlementEventSchema.parse({
      ...input.event,
      command: { ...input.event.command, endsAt: '2028-09-01T00:00:00Z' },
    })
    await expect(service.submit(input.workspaceId, changed, input.actor)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await counts(input)).toEqual({ entitlements: 1, audits: 1, events: 1, receipts: 1 })
  })
})
