/** Actual evidence ordering shared by sendability and segment SQL. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createDbCrmSegmentStore } from '../crm-segment-store.js'
import { createAssociationStore } from '../association-store.js'
import { loadAssociationOrderScope } from '../../association/source-scope.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const reads = createDbCrmIntakeReadStore()

describe('[COMP:crm/sendability] Actual evidence evaluation', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })
  it('keeps delayed evidence, microsecond ties, channel policy and segment results consistent', async () => {
    const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID(), purposeId = randomUUID(), segmentId = randomUUID()
    await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
    await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Evidence fixture',$2)`, [workspaceId, userId])
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES ($1,$2,'person','Fixture person','{"email":"evidence@example.com"}',$3,'manual')`, [contactId, workspaceId, userId])
    await pool.query(`INSERT INTO crm_consent_purposes (id,workspace_id,purpose_key,label,active_wording_version,wording_snapshot,wording_hash)
      VALUES ($1,$2,'updates','Updates','1','Fixture wording',repeat('a',64))`, [purposeId, workspaceId])
    await pool.query(`INSERT INTO crm_segments (id,workspace_id,segment_key,name,entity_kind,predicate)
      VALUES ($1,$2,'withdrawn','Withdrawn','person',$3)`, [segmentId, workspaceId, JSON.stringify({ type: 'group', combinator: 'and', items: [
      { type: 'rule', family: 'consent', field: 'updates', operator: 'eq', value: 'withdrawn' },
    ] })])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
    const evidence=await loadAssociationOrderScope(pool,workspaceId,[contactId])
    const scope=JSON.stringify(evidence.scope),sources=JSON.stringify(evidence.sources)
    // Many old grants arrive after the withdrawal. Receipt order is not consent authority.
    await pool.query(`INSERT INTO association_consent_events (workspace_id,contact_id,purpose,purpose_id,action,wording_version,source,occurred_at,created_at,scope_snapshot,scope_sources)
      SELECT $1,$2,'updates',$3,'granted','1','fixture','2026-01-01T00:00:00.123456Z','2026-03-01T00:00:00Z',$4::jsonb,$5::jsonb FROM generate_series(1,505)`, [workspaceId, contactId, purposeId,scope,sources])
    const withdrawnId = `${randomUUID().slice(0, -1)}0`
    await pool.query(`INSERT INTO association_consent_events (id,workspace_id,contact_id,purpose,purpose_id,action,wording_version,source,occurred_at,created_at,scope_snapshot,scope_sources)
      VALUES ($1,$2,$3,'updates',$4,'withdrawn','1','fixture','2026-01-01T00:00:00.123457Z','2026-01-01T00:00:00.123458Z',$5::jsonb,$6::jsonb)`, [withdrawnId, workspaceId, contactId, purposeId,scope,sources])
    const check = () => reads.checkSendability(workspaceId, contactId, 'email', 'updates',{kind:'user',userId})
    const segment = () => createDbCrmSegmentStore().previewSegment(workspaceId, segmentId)
    const legacy = () => createAssociationStore(pool).listConsents(workspaceId, contactId,{credentialKind:'user',credentialId:userId,actingUserId:userId})
    expect(await check()).toMatchObject({ verdict: 'blocked', effectiveConsentEventId: withdrawnId })
    expect((await legacy()).effective).toEqual({ updates: 'withdrawn' })
    expect((await segment()).snapshotIds).toEqual([contactId])
    const grantId = `${withdrawnId.slice(0, -1)}f`
    await pool.query(`INSERT INTO association_consent_events (id,workspace_id,contact_id,purpose,purpose_id,action,wording_version,source,occurred_at,created_at,scope_snapshot,scope_sources)
      VALUES ($1,$2,$3,'updates',$4,'granted','1','fixture','2025-12-31T19:00:00.123457-05:00','2026-01-01T00:00:00.123457Z',$5::jsonb,$6::jsonb)`, [grantId, workspaceId, contactId, purposeId,scope,sources])
    expect(await check()).toMatchObject({ verdict: 'blocked', effectiveConsentEventId: withdrawnId })
    expect((await legacy()).effective).toEqual({ updates: 'withdrawn' })
    await pool.query(`UPDATE association_consent_events SET created_at='2026-01-01T00:00:00.123458Z' WHERE workspace_id=$1 AND id=$2`, [workspaceId, grantId])
    const tieWinner = grantId > withdrawnId ? grantId : withdrawnId
    expect((await check()).effectiveConsentEventId).toBe(tieWinner)
    expect((await segment()).count).toBe(tieWinner === withdrawnId ? 1 : 0)
    expect((await legacy()).effective).toEqual({ updates: tieWinner === withdrawnId ? 'withdrawn' : 'granted' })
    await pool.query(`UPDATE association_consent_events SET occurred_at='2026-02-01T00:00:00Z' WHERE workspace_id=$1 AND id=$2`, [workspaceId, grantId])
    expect((await check()).verdict).toBe('allowed')

    await pool.query(`INSERT INTO crm_suppression_events (workspace_id,contact_id,channel,action,reason_code,source,actor_kind,occurred_at,created_at,scope_snapshot,scope_sources)
      VALUES ($1,$2,'email','released','manual_do_not_contact','fixture','user','2026-02-01T00:00:00.123457Z','2026-02-01T00:00:00Z',$3::jsonb,$4::jsonb),
             ($1,$2,'email','suppressed','manual_do_not_contact','fixture','user','2026-02-01T00:00:00.123456Z','2026-03-01T00:00:00Z',$3::jsonb,$4::jsonb)`, [workspaceId, contactId,scope,sources])
    expect((await check()).verdict).toBe('allowed')
    await pool.query(`INSERT INTO crm_suppression_events (workspace_id,contact_id,channel,action,reason_code,source,actor_kind,scope_snapshot,scope_sources)
      VALUES ($1,$2,'all','suppressed','manual_do_not_contact','fixture','user',$3::jsonb,$4::jsonb)`, [workspaceId, contactId,scope,sources])
    expect(await check()).toMatchObject({ verdict: 'blocked', reasons: ['global_suppression'] })
    await pool.query('DELETE FROM crm_suppression_events WHERE workspace_id=$1', [workspaceId])
    await pool.query(`UPDATE crm_consent_purposes SET applicable_channels=ARRAY['sms'],requires_consent=false WHERE workspace_id=$1 AND id=$2`, [workspaceId, purposeId])
    expect(await check()).toMatchObject({ verdict: 'blocked', reasons: ['purpose_channel_inapplicable'] })
    await pool.query(`UPDATE crm_consent_purposes SET applicable_channels='{}',archived_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, purposeId])
    expect(await check()).toMatchObject({ verdict: 'blocked', reasons: ['purpose_archived'] })
    await pool.query(`UPDATE crm_consent_purposes SET archived_at=NULL WHERE workspace_id=$1 AND id=$2`, [workspaceId, purposeId])
    await pool.query('DELETE FROM association_consent_events WHERE workspace_id=$1', [workspaceId])
    expect((await check()).verdict).toBe('allowed')
    await pool.query(`UPDATE crm_consent_purposes SET requires_consent=true WHERE workspace_id=$1 AND id=$2`, [workspaceId, purposeId])
    expect(await check()).toMatchObject({ verdict: 'unknown', reasons: ['consent_not_recorded'] })
  })
})
