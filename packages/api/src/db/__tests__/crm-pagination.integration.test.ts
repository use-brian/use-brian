import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { listCrmOperationsAudit, listCrmEventDelivery } from '../../crm-operations/privacy.js'
import { createAssociationStore } from '../association-store.js'
import { createDbCrmSegmentStore } from '../crm-segment-store.js'
import { getPool, getAppPool } from '../client.js'
import { loadAssociationOrderScope } from '../../association/source-scope.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const reads = createDbCrmIntakeReadStore()

describe('[COMP:crm/operations-pagination] Complete collections in real PostgreSQL', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end(), getAppPool().end()]) })
  it('traverses every collection beyond 100 with immutable tuple order and correct named envelopes', async () => {
    const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
    await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
    await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Pagination fixture',$2)`, [workspaceId, userId])
    await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source) VALUES ($1,$2,'person','Fixture person',$3,'manual')`, [contactId, workspaceId, userId])
    await pool.query(`INSERT INTO crm_intake_definitions (workspace_id,definition_key,label)
      SELECT $1,'fixture_'||n,'Fixture '||n FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO crm_intake_definition_versions (workspace_id,definition_id,version,field_catalog,identity_policy,schema_hash,schema_snapshot)
      SELECT workspace_id,id,1,'[]'::jsonb,'new_or_review',repeat('a',64),'{}'::jsonb FROM crm_intake_definitions WHERE workspace_id=$1`, [workspaceId])
    await pool.query(`INSERT INTO crm_consent_purposes (workspace_id,purpose_key,label,active_wording_version,wording_snapshot,wording_hash)
      SELECT $1,'fixture_'||n,'Fixture '||n,'1','Fixture wording',repeat('a',64) FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      SELECT $1,'fixture_'||n,'Fixture '||n,'USD',0,'manual' FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO association_events (workspace_id,slug,title,starts_at,ends_at,timezone,mode)
      SELECT $1,'fixture-'||n,'Fixture '||n,'2099-01-01T00:00:00Z','2099-01-01T01:00:00Z','UTC','venue' FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO association_memberships (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,starts_at)
      SELECT workspace_id,$2,id,id::text,repeat('a',64),'2026-01-01T00:00:00Z' FROM association_membership_plans WHERE workspace_id=$1`, [workspaceId, contactId])
    await pool.query(`INSERT INTO association_registrations (workspace_id,event_id,attendee_contact_id,attendee_name,status,source_kind,source_id,request_fingerprint)
      SELECT workspace_id,id,$2,'Fixture person','registered','manual',id::text,repeat('a',64) FROM association_events WHERE workspace_id=$1`, [workspaceId, contactId])
    const submissionEvidence=await loadAssociationOrderScope(pool,workspaceId,[contactId])
    await pool.query(`INSERT INTO association_enquiries (workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message,definition_id,scope_snapshot,scope_sources)
      SELECT workspace_id,$2,'fixture',id::text,repeat('a',64),'Fixture subject','Fixture message',id,$3::jsonb,$4::jsonb FROM crm_intake_definitions WHERE workspace_id=$1`,
      [workspaceId, contactId,JSON.stringify(submissionEvidence.scope),JSON.stringify(submissionEvidence.sources)])
    await pool.query(`INSERT INTO crm_pipelines (workspace_id,name,position) SELECT $1,'Fixture '||n,n FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO crm_intake_credentials (workspace_id,label,secret_prefix,secret_hash)
      SELECT $1,'Fixture '||n,'sk_intake_'||gen_random_uuid()::text,'scrypt$fixture' FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO association_audit_log (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id)
      SELECT $1,'crm.fixture','contact',$2,'user',$3::text FROM generate_series(1,105) n`, [workspaceId, contactId, userId])
    // The outbox is normalized committed CRM evidence, not an actual provider call.
    await pool.query(`INSERT INTO crm_domain_event_outbox (workspace_id,event_type,subject_kind,subject_id,actor_kind,payload,event_key)
      SELECT $1,'crm.submission.received','contact',$2,'user','{}'::jsonb,'fixture-'||n FROM generate_series(1,105) n`, [workspaceId, contactId])
    const cases: Array<[string, (cursor?: string) => Promise<{ nextCursor: string | null } & Record<string, unknown>>]> = [
      ['definitions', (cursor) => reads.listDefinitions(workspaceId, { limit: 17, cursor })],
      ['purposes', (cursor) => reads.listConsentPurposes(workspaceId, false, { limit: 17, cursor })],
      ['submissions', (cursor) => reads.listSubmissions(workspaceId, { limit: 17, cursor }, {kind:'user',userId})],
      ['plans', (cursor) => reads.listEntitlementPlans(workspaceId, { limit: 17, cursor })],
      ['entitlements', (cursor) => reads.listEntitlements(workspaceId, { limit: 17, cursor })],
      ['events', (cursor) => reads.listEvents(workspaceId, { limit: 17, cursor })],
      ['participation', (cursor) => reads.listParticipation(workspaceId, { limit: 17, cursor })],
      ['pipelines', (cursor) => reads.listPipelines(workspaceId, { limit: 17, cursor })],
      ['credentials', (cursor) => reads.listCredentials(workspaceId, { limit: 17, cursor })],
      ['entries', (cursor) => listCrmOperationsAudit({workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}, { limit: 17, cursor })],
      ['events', (cursor) => listCrmEventDelivery({workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}, { limit: 17, cursor })],
    ]
    for (const [key, read] of cases) {
      const ids: unknown[] = []
      let cursor: string | undefined
      do {
        const page = await read(cursor)
        ids.push(...(page[key] as Array<{ id: string }>).map((row) => row.id))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      expect(ids, key).toHaveLength(105)
      expect(new Set(ids).size, key).toBe(105)
    }
    await pool.query(`INSERT INTO association_consent_events (workspace_id,contact_id,purpose,action,wording_version,source,occurred_at,scope_snapshot,scope_sources)
      SELECT $1,$2,'fixture_1','granted','1','fixture','2026-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond',$3::jsonb,$4::jsonb
      FROM generate_series(1,505) n`, [workspaceId, contactId,JSON.stringify(submissionEvidence.scope),JSON.stringify(submissionEvidence.sources)])
    await pool.query(`INSERT INTO crm_suppression_events (workspace_id,contact_id,channel,action,reason_code,source,actor_kind,occurred_at,scope_snapshot,scope_sources)
      SELECT $1,$2,'email','suppressed','manual_do_not_contact','fixture','user','2026-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond',$3::jsonb,$4::jsonb
      FROM generate_series(1,505) n`, [workspaceId, contactId,JSON.stringify(submissionEvidence.scope),JSON.stringify(submissionEvidence.sources)])
    const consent = await reads.getConsent(workspaceId, contactId,{kind:'user',userId})
    expect(consent.purposes).toHaveLength(105)
    expect(consent.events).toHaveLength(505)
    expect(consent.suppressions).toHaveLength(505)
    expect(consent.events[0].occurredAt).toBe('2026-01-01T00:00:00.000505Z')
    expect(consent.suppressions[504].occurredAt).toBe('2026-01-01T00:00:00.000001Z')
    expect(consent.events[0]).not.toHaveProperty('__recordedAt')
    await expect(reads.checkSendability(workspaceId, contactId, 'email', 'unknown_fixture',{kind:'user',userId})).rejects.toMatchObject({
      code: 'catalog_key_invalid', details: { validValues: expect.arrayContaining(['fixture_105']) },
    })
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type,options)
      SELECT $1,'person','fixture_'||n,'Fixture '||n,'single_select',
        (SELECT jsonb_agg('choice_'||i) FROM generate_series(1,105) i)
      FROM generate_series(1,105) n`, [workspaceId])
    await pool.query(`INSERT INTO entity_link_types (edge_type,description)
      SELECT 'assurance_fixture_'||n,'Fixture relationship' FROM generate_series(1,105) n`)
    const segments = createDbCrmSegmentStore()
    const catalog = await segments.listSegmentCatalog(workspaceId, 'person')
    expect(catalog.filter((entry) => entry.family === 'custom')).toHaveLength(105)
    expect(catalog.find((entry) => entry.family === 'custom')?.validValues).toHaveLength(105)
    expect(catalog.filter((entry) => entry.family === 'relationship' && entry.field.startsWith('assurance_fixture_'))).toHaveLength(105)
    expect(catalog.filter((entry) => entry.family === 'consent')).toHaveLength(105)
    expect(catalog.filter((entry) => entry.family === 'entitlement' && entry.valueType === 'enum')).toHaveLength(105)
    expect(catalog.filter((entry) => entry.family === 'participation' && entry.valueType === 'enum')).toHaveLength(105)
    await pool.query(`INSERT INTO crm_pipeline_stages (workspace_id,pipeline_id,name,category,position,legacy_key)
      SELECT workspace_id,id,'Fixture stage','open',1,'lead' FROM crm_pipelines WHERE workspace_id=$1`, [workspaceId])
    const eventCatalog = await segments.listCrmEventFilterCatalog(workspaceId)
    expect(eventCatalog.stableKeys).toHaveLength(525)
    expect(Object.keys(eventCatalog.stableKeys[0]).sort()).toEqual(['key','kind','label'])
    const predicate = { type: 'group', combinator: 'and', items: [
      { type: 'rule', family: 'base', field: 'name', operator: 'contains', value: 'Snapshot fixture' },
    ] }
    await pool.query(`INSERT INTO crm_segments (workspace_id,segment_key,name,entity_kind,predicate)
      SELECT $1,'fixture_'||n,'Fixture '||n,'person',$2::jsonb FROM generate_series(1,105) n`, [workspaceId, JSON.stringify(predicate)])
    const segmentIds: string[] = []
    let cursor: string | undefined
    do {
      const page = await segments.listSegments(workspaceId, { limit: 21, cursor })
      segmentIds.push(...page.segments.map((row) => String(row.id)))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(segmentIds).size).toBe(105)
    await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source)
      SELECT $1,'person','Snapshot fixture '||n,$2,'manual' FROM generate_series(1,1005) n`, [workspaceId, userId])
    const first = await segments.previewSegment(workspaceId, segmentIds[0])
    expect(first.rows).toHaveLength(25)
    expect(first.count).toBe(1005)
    expect(first.snapshotIds).toHaveLength(1000)
    expect(first.snapshotNextCursor).toBeTypeOf('string')
    const last = await segments.previewSegment(workspaceId, segmentIds[0], {
      cursor: first.nextCursor!, snapshotCursor: first.snapshotNextCursor!, snapshotLimit: 27,
    })
    expect(last.rows).toHaveLength(25)
    expect(last.rows.every((row) => !first.rows.some((previous) => previous.id === row.id))).toBe(true)
    expect(last.snapshotIds).toHaveLength(5)
    expect(new Set([...first.snapshotIds, ...last.snapshotIds]).size).toBe(1005)
    expect(last.snapshotNextCursor).toBeNull()
    expect(last.count).toBe(1005)
    await expect(segments.previewSegment(workspaceId, segmentIds[1], { snapshotCursor: first.snapshotNextCursor! })).rejects.toMatchObject({ code: 'invalid_input' })
    await pool.query('UPDATE crm_segments SET version=version+1 WHERE id=$1', [segmentIds[0]])
    await expect(segments.previewSegment(workspaceId, segmentIds[0], { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' })
    const legacy = createAssociationStore(pool)
    const eventId = String((await pool.query('SELECT id FROM association_events WHERE workspace_id=$1 LIMIT 1', [workspaceId])).rows[0].id)
    await pool.query(`INSERT INTO association_registrations (workspace_id,event_id,attendee_contact_id,attendee_name,status,source_kind,source_id,request_fingerprint)
      SELECT $1,$2,$3,'Fixture person','registered','manual','legacy_fixture_'||n,repeat('a',64)
      FROM generate_series(1,104) n`, [workspaceId, eventId, contactId])
    await pool.query(`INSERT INTO association_orders (workspace_id,contact_id,idempotency_key,request_fingerprint,currency,subtotal_minor,total_minor)
      SELECT $1,$2,'legacy_fixture_'||n,repeat('a',64),'USD',0,0 FROM generate_series(1,105) n`, [workspaceId, contactId])
    await pool.query(`INSERT INTO association_notification_outbox (workspace_id,source_kind,source_id,template_key,recipient_kind,recipient_ref)
      SELECT workspace_id,'enquiry',id,'fixture','contact',contact_id::text FROM association_enquiries WHERE workspace_id=$1`, [workspaceId])
    const legacyCases = [
      (cursor: string | null) => legacy.listEnquiries(workspaceId, { limit: 17, cursor }, {credentialKind:'user',credentialId:userId,actingUserId:userId}),
      (cursor: string | null) => legacy.listPlans(workspaceId, { limit: 17, cursor }),
      (cursor: string | null) => legacy.listEvents(workspaceId, { limit: 17, cursor }),
      (cursor: string | null) => legacy.listOrders(workspaceId, { limit: 17, cursor }),
      (cursor: string | null) => legacy.listEventRegistrations(workspaceId, eventId, { limit: 17, cursor }),
      (cursor: string | null) => legacy.listNotifications(workspaceId, { limit: 17, cursor }, { credentialKind: 'user', credentialId: userId, actingUserId: userId }),
    ]
    for (const read of legacyCases) {
      const ids: unknown[] = []
      let next: string | null = null
      do {
        const page = await read(next)
        ids.push(...page.items.map((row) => row.id))
        next = page.nextCursor
      } while (next)
      expect(ids).toHaveLength(105)
      expect(new Set(ids).size).toBe(105)
    }
    const legacyFirst = await legacy.listPlans(workspaceId, { limit: 7, cursor: null })
    await expect(legacy.listPlans(workspaceId, { limit: 7, cursor: legacyFirst.nextCursor, published: true })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(legacy.listEvents(workspaceId, { limit: 7, cursor: legacyFirst.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(legacy.listPlans(randomUUID(), { limit: 7, cursor: legacyFirst.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    const obsolete = Buffer.from(JSON.stringify({ id: legacyFirst.items[0].id, createdAt: legacyFirst.items[0].createdAt })).toString('base64url')
    await expect(legacy.listPlans(workspaceId, { limit: 7, cursor: obsolete })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
