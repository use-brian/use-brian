import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CampaignError } from '@use-brian/core/campaigns/types.js'
import type { CrmOperationsContext } from '@use-brian/core/crm/operations-types.js'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import { createCampaignTrackingStore } from '../campaign-tracking-store.js'
import { getCrmR2Record, listCrmRecordRelationships } from '../crm-r2.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCampaignConversionOutboxWorker } from '../../campaigns/conversion-outbox.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const tracking = createCampaignTrackingStore()
const conversions = createCampaignConversionOutboxWorker()

type Fixture = {
  userId: string; workspaceId: string; assistantId: string; siteId: string; sitePublicId: string
  campaignId: string; linkId: string; linkPublicId: string
}
let fixture: Fixture

async function seed(): Promise<Fixture> {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  await pool.query(`INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)`, [userId])
  await pool.query(`INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Tracking fixture','test',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Tracking assistant',$2,'primary',$3)`, [assistantId, workspaceId, userId])
  await pool.query(`INSERT INTO sessions(id,user_id,assistant_id,channel_type,channel_id,title) VALUES($1,$2,$3,'web','tracking','[linkedin] Tracking fixture')`, [sessionId, userId, assistantId])
  const campaign = await pool.query<{ id: string }>(`INSERT INTO campaigns(workspace_id,owner_user_id,name,objective,timezone,primary_conversion_kind)
    VALUES($1,$2,'Tracking campaign','Verify attribution','UTC','enquiry_submitted') RETURNING id`, [workspaceId, userId])
  const placement = await pool.query<{ id: string }>(`INSERT INTO campaign_placements(workspace_id,campaign_id,session_id,channel,placement_kind,placement_key,created_by)
    VALUES($1,$2,$3,'linkedin','body','fixture_body',$4) RETURNING id`, [workspaceId, campaign.rows[0]!.id, sessionId, userId])
  const linkPublicId = '0123456789abcdef0123456789abcdef'
  const link = await pool.query<{ id: string }>(`INSERT INTO campaign_links(workspace_id,campaign_id,placement_id,public_id,destination_url,destination_hash,utm_snapshot,created_by)
    VALUES($1,$2,$3,$4,'https://example.com/offer','${'a'.repeat(64)}','{"source":"linkedin","medium":"organic_social","campaign":"fixture","content":"body"}',$5) RETURNING id`,
  [workspaceId, campaign.rows[0]!.id, placement.rows[0]!.id, linkPublicId, userId])
  const sitePublicId = 'abcdef0123456789abcdef0123456789'
  const site = await pool.query<{ id: string }>(`INSERT INTO campaign_sites(workspace_id,public_id,name,allowed_origins,conversion_definitions,storage_mode,cookie_domain,site_group_key,created_by)
    VALUES($1,$2,'Example sites','["https://example.com","https://studio.example.com"]','[{"key":"enquiry_submitted","label":"Enquiry","enabled":true}]','first_party','.example.com','example_sites',$3) RETURNING id`,
  [workspaceId, sitePublicId, userId])
  return { userId, workspaceId, assistantId, siteId: site.rows[0]!.id, sitePublicId, campaignId: campaign.rows[0]!.id,
    linkId: link.rows[0]!.id, linkPublicId }
}

beforeAll(async () => { fixture = await seed() })
afterAll(async () => { conversions.stop(); await pool.end() })

describe('[COMP:campaigns/tracking] actual event, conversion, and CRM projection storage', () => {
  it('deduplicates exact browser observations, conflicts changed replay, and enforces origin', async () => {
    const site = await tracking.getSiteByPublicId(fixture.sitePublicId)
    expect(site).not.toBeNull()
    const event = { version: 1 as const, eventId: 'event_0123456789abcdef012345', siteId: fixture.sitePublicId,
      type: 'page_view' as const, occurredAt: new Date().toISOString(), linkId: fixture.linkPublicId,
      sessionId: 'session_0123456789abcdef0123', visitorId: 'visitor_0123456789abcdef0123', pagePath: '/offer',
      referrerOrigin: 'https://social.example', metadata: {}, test: false }
    expect(await tracking.collectBrowserEvent(site!, 'https://example.com', event, 'Mozilla/5.0')).toMatchObject({ duplicate: false })
    expect(await tracking.collectBrowserEvent(site!, 'https://example.com', event, 'Mozilla/5.0')).toMatchObject({ duplicate: true })
    await expect(tracking.collectBrowserEvent(site!, 'https://example.com', { ...event, pagePath: '/changed' }, 'Mozilla/5.0'))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(tracking.collectBrowserEvent(site!, 'https://evil.example', event, 'Mozilla/5.0'))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_events WHERE site_id=$1`, [fixture.siteId])).rows[0].count).toBe(1)
  })

  it('keeps committed intake durable through projection failure and replays into one linked conversion', async () => {
    const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
    const context: CrmOperationsContext = { workspaceId: fixture.workspaceId, actor: { kind: 'user', userId: fixture.userId },
      authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
    await service.execute(context, { kind: 'save_intake_definition', definitionKey: 'campaign_enquiry', label: 'Campaign enquiry', active: true,
      definition: { identityPolicy: 'new_or_review', queueKey: 'general', consentMappings: [], maxPayloadBytes: 65_536, fields: [
        { key: 'name', label: 'Name', type: 'text', required: true, mapping: { kind: 'base_field', field: 'name' } },
        { key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } },
      ] } })
    const command = { kind: 'record_submission' as const, definitionKey: 'campaign_enquiry', idempotencyKey: 'tracking-intake-001',
      fields: { name: 'Fixture Person', email: 'person@example.com' },
      campaignAttribution: { version: 1 as const, siteId: fixture.sitePublicId, linkId: fixture.linkPublicId,
        sessionId: 'session_0123456789abcdef0123' } }
    const created = await service.execute(context, command)
    const replay = await service.execute(context, command)
    expect(replay).toMatchObject({ duplicate: true, record: created.record })
    expect((await pool.query(`SELECT count(*)::int AS count FROM association_enquiries WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_conversion_outbox WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(1)

    await pool.query(`UPDATE campaign_sites SET enabled=false WHERE id=$1`, [fixture.siteId])
    expect(await conversions.tick()).toBe(1)
    expect((await pool.query(`SELECT state FROM campaign_conversion_outbox WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].state).toBe('failed')
    expect((await pool.query(`SELECT count(*)::int AS count FROM association_enquiries WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(1)

    await pool.query(`UPDATE campaign_sites SET enabled=true WHERE id=$1`, [fixture.siteId])
    await pool.query(`UPDATE campaign_conversion_outbox SET available_at=clock_timestamp() WHERE workspace_id=$1`, [fixture.workspaceId])
    expect(await conversions.tick()).toBe(1)
    expect(await conversions.tick()).toBe(0)
    const conversion = await pool.query(`SELECT contact_id,evidence_level,attribution_snapshot FROM campaign_conversions WHERE workspace_id=$1`, [fixture.workspaceId])
    expect(conversion.rows).toHaveLength(1)
    expect(conversion.rows[0]).toMatchObject({ contact_id: created.record.contactId, evidence_level: 'crm_committed',
      attribution_snapshot: { state: 'attributed', firstTouch: { linkId: fixture.linkId }, lastTouch: { linkId: fixture.linkId } } })
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_subject_links WHERE workspace_id=$1 AND contact_id=$2`,
      [fixture.workspaceId, created.record.contactId])).rows[0].count).toBe(1)
    if (typeof created.record.contactId !== 'string') throw new Error('Expected committed intake contact id')
    const access: AccessContext = { workspaceId: fixture.workspaceId, userId: fixture.userId,
      assistantId: fixture.assistantId, assistantKind: 'primary' }
    const crmRecord = await getCrmR2Record(access, created.record.contactId)
    expect(crmRecord).not.toBeNull()
    await expect(listCrmRecordRelationships(access, crmRecord!)).resolves.toEqual({ contacts: [], companies: [], deals: [] })
  })

  it('reports raw and filtered traffic, verified outcomes, and test exclusion honestly', async () => {
    const result = await tracking.results(fixture.workspaceId, fixture.campaignId)
    expect(result).toMatchObject({ state: 'available', pageViews: 1, sessions: 1, visitors: 1, verifiedConversions: 1, denominator: 'sessions' })
    expect(result.limitations).toEqual(expect.arrayContaining([expect.stringContaining('not proof of causal credit')]))
    const attribution = await tracking.attribution(fixture.workspaceId, fixture.campaignId, { model: 'first_touch' })
    expect(attribution).toMatchObject({ state: 'available', model: 'first_touch' })
    expect((attribution.conversions as unknown[])).toHaveLength(1)
  })

  it('prevents a scoped site credential from asserting a guessed CRM identity', async () => {
    const credential = await tracking.issueCredential(fixture.workspaceId, fixture.siteId, fixture.userId)
    const principal = await tracking.authenticateCredential(credential.secret)
    expect(principal?.siteId).toBe(fixture.siteId)
    await expect(tracking.recordTrustedConversion(principal!, { version: 1, siteId: fixture.sitePublicId,
      conversionKind: 'enquiry_submitted', externalOutcomeId: 'forged-contact', occurredAt: new Date().toISOString(),
      subject: { kind: 'contact', id: createdContactIdPlaceholder() }, metadata: {}, test: true }))
      .rejects.toBeInstanceOf(CampaignError)
  })
})

function createdContactIdPlaceholder(): string {
  return randomUUID()
}
