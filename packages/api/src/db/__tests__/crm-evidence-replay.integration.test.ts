import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createAssociationStore } from '../association-store.js'
import { ConsentInputSchema } from '../../association/domain.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const contender = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: 'assurance_evidence_contender' })
const store = createDbCrmOperationsStore(pool)
const service = createCrmOperationsService(store)
const competing = createCrmOperationsService(createDbCrmOperationsStore(contender))
type Kind = 'consent' | 'suppression'
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID(), otherContactId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Evidence replay fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source)
    VALUES ($1,$2,'person','Fixture person',$3,'manual'),($4,$2,'person','Other fixture person',$3,'manual')`, [contactId, workspaceId, userId, otherContactId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId },
    authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  await service.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose',
    purposeKey: 'updates', label: 'Updates', wordingVersion: '1', wording: 'Original fixture wording' }))
  return { workspaceId, userId, contactId, otherContactId, context }
}
function command(kind: Kind, contactId: string, change: Record<string, unknown> = {}) {
  return CrmOperationsCommandSchema.parse({
    ...(kind === 'consent' ? { kind: 'record_consent', purposeKey: 'updates', action: 'granted' }
      : { kind: 'record_suppression', channel: 'email', action: 'suppressed', reasonCode: 'hard_bounce' }),
    contactId, source: 'fixture', provider: 'fixture', providerEventId: 'event_1',
    metadata: { status: 'original', nested: { a: 1, b: 2 } }, ...change,
  })
}
async function counts(workspaceId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
    (SELECT count(*) FROM crm_suppression_events WHERE workspace_id=$1)::int AS suppression,
    (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
    (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`, [workspaceId])).rows[0]
}

describe('[COMP:crm/operations-store] Actual provider evidence replay', () => {
  afterAll(async () => { await Promise.all([pool.end(), contender.end()]) })
  it.each(['consent', 'suppression'] as const)('binds %s business inputs while keeping identical omitted-time retries stable', async (kind) => {
    const f = await fixture(), input = command(kind, f.contactId)
    const first = await service.execute(f.context, input)
    const before = await counts(f.workspaceId)
    // Deliberately different service clock: omitted occurrence time belongs to the first write.
    const later = createCrmOperationsService(store, { now: () => new Date('2099-01-01T00:00:00Z') })
    const duplicate = await later.execute(f.context, command(kind, f.contactId, { metadata: { nested: { b: 2, a: 1 }, status: 'original' } }))
    expect(duplicate).toMatchObject({ duplicate: true, record: { id: first.record.id }, emittedEventIds: [] })
    expect(duplicate.record).not.toHaveProperty('__requestHash')
    expect(duplicate.record).not.toHaveProperty('__occurredAt')
    for (const change of [{ metadata: { status: 'changed' } }, { source: 'other' }, { contactId: f.otherContactId }, { occurredAt: '2026-01-01T00:00:00Z' },
      kind === 'consent' ? { action: 'withdrawn' } : { reasonCode: 'complaint' },
      kind === 'consent' ? { purposeKey: 'other' } : { channel: 'all', action: 'released' }]) {
      await expect(service.execute(f.context, command(kind, f.contactId, change))).rejects.toMatchObject({ code: 'idempotency_conflict' })
    }
    if (kind === 'consent') {
      await pool.query(`UPDATE crm_consent_purposes SET wording_snapshot='Changed fixture wording',active_wording_version='2',archived_at=now() WHERE workspace_id=$1`, [f.workspaceId])
      expect(await later.execute(f.context, input)).toMatchObject({ duplicate: true, record: { wording: 'Original fixture wording', wordingVersion: '1' } })
      await expect(service.execute(f.context, command(kind, f.contactId, { providerEventId: 'new_event' }))).rejects.toMatchObject({ code: 'catalog_key_invalid' })
    }
    expect(await counts(f.workspaceId)).toEqual(before)
    const other = await fixture()
    expect((await service.execute(other.context, command(kind, other.contactId))).created).toBe(true)
  })

  it.each(['consent', 'suppression'] as const)('checks both equal and changed %s payloads after waiting for a concurrent insert', async (kind) => {
    const f = await fixture(), input = command(kind, f.contactId)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const held = createCrmOperationsService({ transaction: (context, run) => store.transaction(context, async (tx) => {
      const value = await run(tx)
      entered()
      await gate
      return value
    }) })
    const first = held.execute(f.context, input)
    let same: ReturnType<typeof competing.execute> | undefined
    let changed: Promise<unknown> | undefined
    try {
      await Promise.race([ready, first.then(() => { throw new Error('Held evidence transaction ended early.') })])
      same = competing.execute(f.context, input)
      changed = competing.execute(f.context, command(kind, f.contactId, { metadata: { changed: true } }))
        .then(() => ({ unexpectedSuccess: true }), (error: unknown) => error)
      const deadline = Date.now() + 5_000
      let locked = false
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE application_name='assurance_evidence_contender' AND datname=current_database()
            AND wait_event_type='Lock' AND (position('INSERT INTO' IN query)>0
              OR (position('workspaces' IN query)>0 AND position('FOR UPDATE' IN query)>0))`)
        if (result.rows[0].count === 2) { locked = true; break }
        await setTimeout(10)
      }
      expect(locked).toBe(true)
    } finally {
      release()
      await Promise.allSettled([first, ...(same ? [same] : []), ...(changed ? [changed] : [])])
    }
    expect(await same).toMatchObject({ duplicate: true, record: { id: (await first).record.id }, emittedEventIds: [] })
    expect(await changed).toMatchObject({ code: 'idempotency_conflict' })
    expect(await counts(f.workspaceId)).toMatchObject({ [kind]: 1, audit: 2, outbox: 1 })
  })

  it('normalizes explicit occurrence time and requires complete evidence for legacy rows', async () => {
    const f = await fixture(), at = '2026-01-01T00:00:00.123456Z'
    for (const kind of ['consent', 'suppression'] as const) {
      const input = command(kind, f.contactId, { occurredAt: at })
      const first = await service.execute(f.context, input)
      expect((await service.execute(f.context, command(kind, f.contactId, { occurredAt: '2025-12-31T19:00:00.123456-05:00' }))).duplicate).toBe(true)
      const table = kind === 'consent' ? 'association_consent_events' : 'crm_suppression_events'
      await pool.query(`UPDATE ${table} SET request_fingerprint=NULL WHERE workspace_id=$1`, [f.workspaceId])
      await expect(service.execute(f.context, command(kind, f.contactId))).rejects.toMatchObject({ code: 'idempotency_conflict', details: { reason: 'legacy_evidence_requires_occurred_at' } })
      expect(await service.execute(f.context, input)).toMatchObject({ duplicate: true, record: { id: first.record.id } })
      await expect(service.execute(f.context, command(kind, f.contactId, { occurredAt: '2026-01-01T00:00:00.123457Z' }))).rejects.toMatchObject({ code: 'idempotency_conflict' })
    }
  })

  it('uses the same full-payload comparison for the legacy consent adapter', async () => {
    const f = await fixture(), legacy = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const input = ConsentInputSchema.parse({ contactId: f.contactId, purpose: 'updates', action: 'granted', wordingVersion: '1', source: 'fixture', provider: 'fixture', providerEventId: 'legacy_1', metadata: { original: true } })
    const first = await legacy.appendConsent(f.workspaceId, input, actor)
    const before = await counts(f.workspaceId)
    expect(await legacy.appendConsent(f.workspaceId, input, actor)).toMatchObject({ created: false, record: { id: first.record.id } })
    for (const change of [{ metadata: { original: false } }, { wordingVersion: '2' }, { occurredAt: '2026-01-01T00:00:00Z' }]) {
      await expect(legacy.appendConsent(f.workspaceId, { ...input, ...change }, actor)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    }
    expect(await counts(f.workspaceId)).toEqual(before)
    const originalAt = '2026-01-01T00:00:00.123456Z'
    await pool.query(`UPDATE association_consent_events SET request_fingerprint=NULL,occurred_at=$2 WHERE workspace_id=$1`, [f.workspaceId, originalAt])
    await expect(legacy.appendConsent(f.workspaceId, input, actor)).rejects.toMatchObject({ code: 'idempotency_conflict', details: { reason: 'legacy_evidence_requires_occurred_at' } })
    expect(await legacy.appendConsent(f.workspaceId, { ...input, occurredAt: originalAt }, actor)).toMatchObject({ created: false, record: { id: first.record.id } })
    await expect(legacy.appendConsent(f.workspaceId, { ...input, wordingVersion: '2', occurredAt: originalAt }, actor)).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})
