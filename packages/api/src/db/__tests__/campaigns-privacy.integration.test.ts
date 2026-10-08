import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCampaignTrackingStore, pruneCampaignTracking } from '../campaign-tracking-store.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { streamCrmPrivacyExport } from '../../crm-operations/privacy-export.js'
import { createCampaignConversionOutboxWorker } from '../../campaigns/conversion-outbox.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const tracking = createCampaignTrackingStore()
const projector = createCampaignConversionOutboxWorker()

type Fixture = { workspaceId: string; userId: string; contactId: string; siteId: string; sitePublicId: string; campaignId: string; linkId: string; dispatchId: string; recipientId: string; deliveryId: string }
let fixture: Fixture

async function seed(): Promise<Fixture> {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  await pool.query(`INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)`, [userId])
  // Legacy model (flag off): these receipts predate saved floors, which under
  // v2 fail closed until reviewed recovery (crm-operations.md, privacy export).
  await pool.query(`INSERT INTO workspaces(id,name,purpose,owner_user_id,department_read_v2) VALUES($1,'Campaign privacy fixture','test',$2,false)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Privacy assistant',$2,'primary',$3)`, [assistantId, workspaceId, userId])
  await pool.query(`INSERT INTO sessions(id,user_id,assistant_id,channel_type,channel_id,title) VALUES($1,$2,$3,'web','privacy','[linkedin] Privacy fixture')`, [sessionId, userId, assistantId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,attributes,created_by_user_id,source)
    VALUES($1,$2,'person','Privacy Person','privacy@example.com','{"email":"privacy@example.com"}',$3,'manual')`, [contactId, workspaceId, userId])
  const campaign = await pool.query<{ id: string }>(`INSERT INTO campaigns(workspace_id,owner_user_id,name,objective,timezone,primary_conversion_kind)
    VALUES($1,$2,'Privacy campaign','Prove erasure','UTC','enquiry_submitted') RETURNING id`, [workspaceId, userId])
  const placement = await pool.query<{ id: string }>(`INSERT INTO campaign_placements(workspace_id,campaign_id,session_id,channel,placement_kind,placement_key,created_by)
    VALUES($1,$2,$3,'linkedin','body','privacy_body',$4) RETURNING id`, [workspaceId, campaign.rows[0]!.id, sessionId, userId])
  const link = await pool.query<{ id: string }>(`INSERT INTO campaign_links(workspace_id,campaign_id,placement_id,destination_url,destination_hash,utm_snapshot,created_by)
    VALUES($1,$2,$3,'https://example.com/privacy',$4,'{"source":"linkedin","medium":"organic_social","campaign":"privacy","content":"body"}',$5) RETURNING id`,
  [workspaceId, campaign.rows[0]!.id, placement.rows[0]!.id, 'b'.repeat(64), userId])
  const sitePublicId = 'privacy0123456789abcdef0123456789'
  const site = await pool.query<{ id: string }>(`INSERT INTO campaign_sites(workspace_id,public_id,name,allowed_origins,conversion_definitions,storage_mode,created_by)
    VALUES($1,$2,'Privacy site','["https://example.com"]','[{"key":"enquiry_submitted","label":"Enquiry","enabled":true}]','first_party',$3) RETURNING id`,
  [workspaceId, sitePublicId, userId])
  const sessionKey = createHash('sha256').update(`${site.rows[0]!.id}:privacy-session`).digest('hex')
  await pool.query(`INSERT INTO campaign_events(workspace_id,site_id,event_id,request_fingerprint,event_type,evidence_level,link_id,session_key,visitor_key,occurred_at,page_path,metadata,is_test,bot_class,classification_version,expires_at)
    VALUES($1,$2,'privacy_event_0123456789',$3,'page_view','browser_observed',$4,$5,$6,clock_timestamp(),'/privacy','{}',false,'observed_browser',1,clock_timestamp()+interval '90 days')`,
  [workspaceId, site.rows[0]!.id, 'c'.repeat(64), link.rows[0]!.id, sessionKey, sessionKey])
  const subject = await pool.query<{ id: string }>(`INSERT INTO campaign_subject_links(workspace_id,site_id,session_key,contact_id,source,purpose_key,evidence)
    VALUES($1,$2,$3,$4,'committed_crm_intake','campaign_attribution','{"fixture":true}') RETURNING id`,
  [workspaceId, site.rows[0]!.id, sessionKey, contactId])
  await pool.query(`INSERT INTO campaign_conversions(workspace_id,site_id,conversion_kind,external_outcome_id,request_fingerprint,occurred_at,evidence_level,subject_link_id,contact_id,attribution_snapshot,metadata)
    VALUES($1,$2,'enquiry_submitted','privacy-conversion',$3,clock_timestamp(),'crm_committed',$4,$5,'{"state":"attributed"}','{}')`,
  [workspaceId, site.rows[0]!.id, 'd'.repeat(64), subject.rows[0]!.id, contactId])
  await pool.query(`INSERT INTO campaign_conversion_outbox(workspace_id,site_id,outcome_kind,external_outcome_id,payload,payload_hash)
    VALUES($1,$2,'enquiry_submitted','queued-after-erasure',$3,$4)`, [workspaceId, site.rows[0]!.id,
    JSON.stringify({ version: 1, siteId: sitePublicId, conversionKind: 'enquiry_submitted', externalOutcomeId: 'queued-after-erasure',
      occurredAt: new Date().toISOString(), contactId, test: false }), 'e'.repeat(64)])
  const senderId = randomUUID(), segmentId = randomUUID(), deliveryId = randomUUID()
  const dispatch = await pool.query<{ id: string }>(`INSERT INTO campaign_email_dispatches
    (workspace_id,campaign_id,placement_id,approved_revision,sender_ref,purpose_key,segment_id,segment_version,
     audience_snapshot,content_snapshot,tracking_options,authority_snapshot,request_fingerprint,state,scheduled_at,approved_by)
    VALUES($1,$2,$3,1,$4,'updates',$5,1,'{"matched":1,"eligible":1}','{"body":"private"}','{}',$6::jsonb,$7,'scheduled',clock_timestamp(),$8) RETURNING id`,
  [workspaceId, campaign.rows[0]!.id, placement.rows[0]!.id, senderId, segmentId, JSON.stringify({ approvedBy: userId }), '1'.repeat(64), userId])
  const recipient = await pool.query<{ id: string }>(`INSERT INTO campaign_email_recipients
    (workspace_id,dispatch_id,contact_id,email_address,address_hash,personalization_snapshot,eligibility_snapshot,delivery_id)
    VALUES($1,$2,$3,'privacy@example.com',$4,'{"first_name":"Privacy"}','{"sendable":true}',$5) RETURNING id`,
  [workspaceId, dispatch.rows[0]!.id, contactId, '2'.repeat(64), deliveryId])
  await pool.query(`INSERT INTO campaign_email_jobs(workspace_id,dispatch_id,recipient_id) VALUES($1,$2,$3)`,
    [workspaceId, dispatch.rows[0]!.id, recipient.rows[0]!.id])
  await pool.query(`INSERT INTO campaign_unsubscribe_tokens(workspace_id,recipient_id,purpose_key,token_hash,all_marketing,expires_at)
    VALUES($1,$2,'updates',$3,true,clock_timestamp()+interval '1 day')`, [workspaceId, recipient.rows[0]!.id, '3'.repeat(64)])
  await pool.query(`INSERT INTO campaign_email_link_tokens(workspace_id,recipient_id,link_id,token_hash,expires_at)
    VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 day')`, [workspaceId, recipient.rows[0]!.id, link.rows[0]!.id, '4'.repeat(64)])
  await pool.query(`INSERT INTO crm_delivery_receipts
    (workspace_id,delivery_id,request_hash,connector_instance_id,provider_key,purpose_key,actor_kind,actor_credential_id,
     acting_user_id,envelope,status,claim_token,claim_deadline,provider_receipt)
    VALUES($1,$2,$3,$4,'outreach','updates','user',$5,$6,'{"to":["privacy@example.com"]}','needs_reconciliation',$7,clock_timestamp(),'{"smtp":"unknown"}')`,
  [workspaceId, deliveryId, '5'.repeat(64), senderId, userId, userId, randomUUID()])
  await pool.query(`INSERT INTO crm_delivery_receipt_contacts(workspace_id,delivery_id,contact_id) VALUES($1,$2,$3)`,
    [workspaceId, deliveryId, contactId])
  return { workspaceId, userId, contactId, siteId: site.rows[0]!.id, sitePublicId, campaignId: campaign.rows[0]!.id,
    linkId: link.rows[0]!.id, dispatchId: dispatch.rows[0]!.id, recipientId: recipient.rows[0]!.id, deliveryId }
}

beforeAll(async () => { fixture = await seed() })
afterAll(async () => { projector.stop(); await pool.end() })

async function collectContactExport(): Promise<Array<Record<string, unknown>>> {
  const context = { workspaceId: fixture.workspaceId, actor: { kind: 'user' as const, userId: fixture.userId },
    authority: { role: 'owner' as const, canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  const records: Array<Record<string, unknown>> = []
  for await (const line of streamCrmPrivacyExport(context, { contactId: fixture.contactId })) records.push(JSON.parse(line))
  return records
}

describe('[COMP:campaigns/privacy] campaign export, erasure, retention, and credential lifecycle', () => {
  it('exports subject-linked campaign evidence without credential secrets or replay fingerprints', async () => {
    const records = await collectContactExport()
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'record', domain: 'campaign_subject_links' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_conversions' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_events' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_conversion_outbox' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_email_recipients' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_email_jobs' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_unsubscribe_tokens' }),
      expect.objectContaining({ type: 'record', domain: 'campaign_email_link_tokens' }),
    ]))
    const campaignPayloads = records.filter(record => record.type === 'record' && String(record.domain).startsWith('campaign_'))
      .map(record => record.record)
    expect(JSON.stringify(campaignPayloads)).not.toContain('request_fingerprint')
    expect(JSON.stringify(campaignPayloads)).not.toContain('lease_token')
  })

  it('revokes site credentials and prunes expired raw observations with site policy', async () => {
    const credential = await tracking.issueCredential(fixture.workspaceId, fixture.siteId, fixture.userId)
    expect(await tracking.authenticateCredential(credential.secret)).not.toBeNull()
    expect(await tracking.revokeCredential(fixture.workspaceId, fixture.siteId, credential.credentialId)).toBe(true)
    expect(await tracking.authenticateCredential(credential.secret)).toBeNull()
    await pool.query(`INSERT INTO campaign_events(workspace_id,site_id,event_id,request_fingerprint,event_type,evidence_level,occurred_at,page_path,metadata,is_test,bot_class,classification_version,expires_at)
      VALUES($1,$2,'expired_event_012345678',$3,'page_view','browser_observed',clock_timestamp()-interval '91 days','/expired','{}',false,'unknown',1,clock_timestamp()-interval '1 second')`,
    [fixture.workspaceId, fixture.siteId, 'f'.repeat(64)])
    expect((await pruneCampaignTracking()).events).toBeGreaterThanOrEqual(1)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_events WHERE event_id='expired_event_012345678'`)).rows[0].count).toBe(0)
  })

  it('erases identity copies and cancels a queued projector so it cannot resurrect the contact', async () => {
    const softDelete = createSoftDeleteStore()
    const snapshot = await softDelete.readForSoftDelete('contact', fixture.workspaceId, fixture.contactId)
    await softDelete.applyHardPurge({ primitive: 'contact', workspaceId: fixture.workspaceId, rowId: fixture.contactId,
      actorUserId: fixture.userId, reason: 'Synthetic privacy request', ticketReference: null, snapshot: snapshot!, now: new Date() })
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_subject_links WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_conversions WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_events WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_email_recipients WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_email_jobs WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_unsubscribe_tokens WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM campaign_email_link_tokens WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0)
    const receipt = (await pool.query(`SELECT envelope,provider_receipt,redacted_at FROM crm_delivery_receipts
      WHERE workspace_id=$1 AND delivery_id=$2`, [fixture.workspaceId, fixture.deliveryId])).rows[0]
    expect(receipt).toMatchObject({ envelope: null, provider_receipt: null })
    expect(receipt.redacted_at).toBeInstanceOf(Date)
    const queued = (await pool.query(`SELECT state,payload,lease_token FROM campaign_conversion_outbox WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0]
    expect(queued).toMatchObject({ state: 'cancelled', payload: { erased: true }, lease_token: null })
    expect(await projector.tick()).toBe(0)
    expect((await pool.query(`SELECT count(*)::int AS count FROM entities WHERE id=$1`, [fixture.contactId])).rows[0].count).toBe(0)
  })
})
