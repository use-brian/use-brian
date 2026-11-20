import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCampaignTools } from '@use-brian/core/campaigns/tools.js'
import type { CampaignContext } from '@use-brian/core/campaigns/types.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { createCampaignService } from '../../campaigns/service.js'
import { createDbCampaignStore } from '../campaign-store.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })

type Fixture = {
  ownerId: string
  otherOwnerId: string
  workspaceId: string
  otherWorkspaceId: string
  assistantId: string
  otherAssistantId: string
  sessionId: string
  otherSessionId: string
}
let fixture: Fixture

async function seed(): Promise<Fixture> {
  const client = await owner.connect()
  try {
    const users = await client.query<{ id: string }>(`
      INSERT INTO users(id,auth_provider,auth_provider_id)
      VALUES(gen_random_uuid(),'test','campaign-owner-'||gen_random_uuid()),
            (gen_random_uuid(),'test','campaign-other-'||gen_random_uuid()) RETURNING id`)
    const ownerId = users.rows[0]!.id
    const otherOwnerId = users.rows[1]!.id
    const workspaces = await client.query<{ id: string }>(`
      INSERT INTO workspaces(id,name,purpose,owner_user_id)
      VALUES(gen_random_uuid(),'Campaign fixture A','test',$1),
            (gen_random_uuid(),'Campaign fixture B','test',$2) RETURNING id`, [ownerId, otherOwnerId])
    const workspaceId = workspaces.rows[0]!.id
    const otherWorkspaceId = workspaces.rows[1]!.id
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')`, [workspaceId, ownerId, otherWorkspaceId, otherOwnerId])
    const assistants = await client.query<{ id: string }>(`
      INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id)
      VALUES(gen_random_uuid(),'Campaign assistant A',$1,'primary',$2),
            (gen_random_uuid(),'Campaign assistant B',$3,'primary',$4) RETURNING id`, [workspaceId, ownerId, otherWorkspaceId, otherOwnerId])
    const assistantId = assistants.rows[0]!.id
    const otherAssistantId = assistants.rows[1]!.id
    const sessions = await client.query<{ id: string }>(`
      INSERT INTO sessions(id,user_id,assistant_id,channel_type,channel_id,title)
      VALUES(gen_random_uuid(),$1,$2,'web','campaign-a','[linkedin] Example post'),
            (gen_random_uuid(),$3,$4,'web','campaign-b','[linkedin] Other post') RETURNING id`, [ownerId, assistantId, otherOwnerId, otherAssistantId])
    return { ownerId, otherOwnerId, workspaceId, otherWorkspaceId, assistantId, otherAssistantId, sessionId: sessions.rows[0]!.id, otherSessionId: sessions.rows[1]!.id }
  } finally { client.release() }
}

beforeAll(async () => {
  fixture = await seed()
})

afterAll(async () => {
  await app?.end()
  await owner?.end()
})

function serviceContext(): CampaignContext {
  return {
    workspaceId: fixture.workspaceId,
    actor: { kind: 'user', userId: fixture.ownerId },
    authority: { role: 'owner', canRead: true, canWrite: true, canConfigure: true, canSend: false },
  }
}

function toolContext(): ToolContext {
  return {
    userId: fixture.ownerId,
    assistantId: fixture.assistantId,
    sessionId: fixture.sessionId,
    appId: fixture.assistantId,
    channelType: 'web',
    channelId: 'campaign-fixture',
    workspaceId: fixture.workspaceId,
    activeCapabilities: new Set(['feed', 'home_app:feed:read', 'home_app:feed:write']),
    abortSignal: new AbortController().signal,
  }
}

describe('[COMP:campaigns/store] migration, isolation, idempotency, and authority', () => {
  it('executes the complete migration and exposes every owned table', async () => {
    const expected = [
      'campaigns', 'campaign_placements', 'campaign_links', 'campaign_sites', 'campaign_site_credentials',
      'campaign_events', 'campaign_subject_links', 'campaign_conversions', 'campaign_conversion_outbox',
      'campaign_email_dispatches', 'campaign_email_recipients', 'campaign_email_jobs',
      'campaign_unsubscribe_tokens', 'campaign_email_link_tokens', 'campaign_daily_metrics', 'campaign_command_receipts',
    ]
    const result = await owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, [expected],
    )
    expect(result.rows.map(row => row.table_name).sort()).toEqual([...expected].sort())
  })

  it('enforces non-owner RLS and rejects cross-workspace Feed references', async () => {
    const created = await owner.query<{ id: string }>(
      `INSERT INTO campaigns(workspace_id,owner_user_id,name,objective,timezone,primary_conversion_kind)
       VALUES($1,$2,'RLS campaign','Prove isolation','UTC','enquiry_submitted') RETURNING id`,
      [fixture.workspaceId, fixture.ownerId],
    )
    await owner.query(
      `INSERT INTO campaigns(workspace_id,owner_user_id,name,objective,timezone,primary_conversion_kind)
       VALUES($1,$2,'Other campaign','Remain hidden','UTC','enquiry_submitted')`,
      [fixture.otherWorkspaceId, fixture.otherOwnerId],
    )
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [fixture.ownerId])
      const visible = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM campaigns ORDER BY name')
      expect(visible.rows).toEqual([{ workspace_id: fixture.workspaceId }])
      await client.query('ROLLBACK')
    } finally { client.release() }

    await expect(owner.query(
      `INSERT INTO campaign_placements(workspace_id,campaign_id,session_id,channel,placement_kind,placement_key,created_by)
       VALUES($1,$2,$3,'linkedin','body','post_body',$4)`,
      [fixture.workspaceId, created.rows[0]!.id, fixture.otherSessionId, fixture.ownerId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('replays exact commands, conflicts changed reuse, and keeps distributed links immutable', async () => {
    const service = createCampaignService()
    const context = serviceContext()
    const create = {
      kind: 'save_campaign' as const,
      name: 'Example launch', objective: 'Collect verified enquiries', timezone: 'UTC', primaryConversion: 'enquiry_submitted',
    }
    const first = await service.execute(context, { idempotencyKey: 'campaign-create-001', command: create })
    const replay = await service.execute(context, { idempotencyKey: 'campaign-create-001', command: create })
    expect(replay.replayed).toBe(true)
    expect(replay.result).toEqual(first.result)
    await expect(service.execute(context, { idempotencyKey: 'campaign-create-001', command: { ...create, name: 'Changed' } }))
      .rejects.toMatchObject({ code: 'conflict' })

    const campaignId = (first.result.campaign as { id: string }).id
    const placement = await service.execute(context, { idempotencyKey: 'campaign-place-001', command: {
      kind: 'attach_content', campaignId, sessionId: fixture.sessionId, channel: 'linkedin', placementKind: 'body', placementKey: 'post_body',
    } })
    const placementId = (placement.result.placement as { id: string }).id
    const linked = await service.execute(context, { idempotencyKey: 'campaign-link-001', command: {
      kind: 'create_link', campaignId, placementId, destination: 'https://example.com/pricing?ref=kept#plans',
      utm: { source: 'linkedin', medium: 'organic_social', campaign: 'example_launch', content: 'post_body' }, existingAttribution: 'reject',
    } })
    const linkId = (linked.result.link as { id: string }).id
    await expect(owner.query(`UPDATE campaign_links SET destination_url='https://example.com/changed' WHERE id=$1`, [linkId]))
      .rejects.toMatchObject({ code: '23514' })
    await owner.query(`UPDATE campaign_links SET enabled=false,disabled_at=clock_timestamp() WHERE id=$1`, [linkId])
    expect((await owner.query<{ enabled: boolean }>('SELECT enabled FROM campaign_links WHERE id=$1', [linkId])).rows[0]?.enabled).toBe(false)
  })

  it('routes Brian and UI through the same authorized semantic service', async () => {
    const store = createDbCampaignStore()
    const service = createCampaignService(store)
    const context = serviceContext()
    const tools = createCampaignTools({
      service,
      reads: {
        listCampaigns: (workspaceId, filters) => store.listCampaigns(workspaceId, filters),
        getCampaign: (workspaceId, campaignId) => store.getCampaign(workspaceId, campaignId),
        listLinks: (workspaceId, campaignId) => store.listLinks(workspaceId, campaignId),
        getTrackingSetup: async () => ({ state: 'not_installed' }),
        getResults: async () => ({ state: 'empty' }),
        getAttribution: async () => ({ conversions: [] }),
        previewAudience: async () => ({ eligible: 0, excluded: 0 }),
        previewEmail: async () => ({ html: '', text: '' }),
      },
      resolveContext: async () => context,
    })
    const toolResult = await tools.saveCampaign.execute({
      idempotency_key: 'campaign-tool-001', name: 'Shared command', objective: 'Prove parity', timezone: 'UTC', primaryConversion: 'signup_completed',
    }, toolContext())
    const campaignId = ((toolResult.data as { campaign: { id: string } }).campaign.id)
    const direct = await service.execute(context, { idempotencyKey: 'campaign-ui-001', command: {
      kind: 'save_campaign', campaignId, expectedVersion: 1, name: 'Shared command updated', objective: 'Prove parity', timezone: 'UTC', primaryConversion: 'signup_completed',
    } })
    expect((direct.result.campaign as { version: number }).version).toBe(2)
    expect((await store.getCampaign(fixture.workspaceId, campaignId))?.name).toBe('Shared command updated')
  })
})
