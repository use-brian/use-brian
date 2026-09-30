import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool } from '../../db/client.js'
import { createDbWorkflowStore } from '../../db/workflow-store.js'
import { createPublicationConsentStore, publicationRevision, type PublicationConsent } from '../publication-consent.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const store = createPublicationConsentStore()
async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), channelId = randomUUID(), integrationId = randomUUID(), assistantId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Publication fixture',$2)", [workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','internal','assigned')", [workspaceId,userId])
  await pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Publication test')", [channelId,workspaceId])
  await pool.query("INSERT INTO channel_integrations(id,channel_type,channel_id,credentials) VALUES($1,'telegram',$2,$3)", [integrationId,channelId,Buffer.from('test-not-a-real-token')])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture primary',$2,$3,'primary','internal',NULL)", [assistantId,workspaceId,userId])
  const workflow = await createDbWorkflowStore().create({ userId,workspaceId,name:'Publication fixture',
    authoringAuthority:{version:1,assistantId,ceiling:{workspaceId,userId,clearance:'internal',
      compartments:[],mutationCompartments:[],projectIds:null,visibilityAssistantIds:null}},
    definition:{startStepId:'remind',steps:[{id:'remind',type:'assistant_call',target:{assistantId:'primary'},prompt:'Prepared update',
      deliver:{channelType:'telegram',channelId:'-100123',channelIntegrationId:integrationId}}]},
  })
  const consent: Omit<PublicationConsent,'id'|'approvedAt'|'revokedAt'> = {
    workflowId:workflow.id,workspaceId,stepId:'remind',approvedByUserId:userId,workflowRevision:publicationRevision(workflow),
    channelType:'telegram',channelId:'-100123',channelIntegrationId:integrationId,
    expiresAt:new Date(Date.now()+86400_000).toISOString(),
  }
  return { workflow,userId,workspaceId,consent }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve=done }); return { promise,resolve } }

describe('[COMP:workflow/publication-consent] PostgreSQL consent ordering', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })
  it('serializes concurrent approvals and rejects stale consent generations', async () => {
    const f = await fixture()
    expect(await store.version(f.workflow.id,f.userId)).toBe('0')
    const results = await Promise.all([store.approve(f.consent,'0'),store.approve(f.consent,'0')])
    expect(results.sort()).toEqual([false,true])
    expect(await store.version(f.workflow.id,f.userId)).toBe('1')
    expect(await store.list(f.workflow.id,f.userId)).toHaveLength(1)
    await store.revoke(f.workflow.id,'remind',f.userId)
    expect(await store.approve(f.consent,'1')).toBe(false)
    expect(await store.list(f.workflow.id,f.userId)).toEqual([])
    expect((await pool.query('SELECT revoked_at FROM workflow_publication_consents WHERE workflow_id=$1',[f.workflow.id])).rows[0].revoked_at).not.toBeNull()
  })
  it('fences an approval dialog even when revoking a destination with no previous consent', async () => {
    const f = await fixture()
    await store.revoke(f.workflow.id,'remind',f.userId)
    expect(await store.approve(f.consent,'0')).toBe(false)
    expect(await store.approve(f.consent,'1')).toBe(true)
  })
  it('completes in-flight dispatch before returning revocation and prevents later use', async () => {
    const f = await fixture(); await store.approve(f.consent,'0')
    const entered = deferred(), finish = deferred(); const order: string[] = []
    const dispatch = store.withPublicationLock(f.workflow.id,f.userId,async () => {
      order.push('dispatch'); entered.resolve(); await finish.promise; order.push('sent')
    })
    await entered.promise
    const revoke = store.revoke(f.workflow.id,'remind',f.userId).then(() => { order.push('revoked') })
    try {
      let waiting = false
      for (let i=0;i<100;i++) {
        waiting = (await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows.length > 0
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      expect(order).toEqual(['dispatch'])
    } finally { finish.resolve(); await Promise.all([dispatch,revoke]) }
    expect(order).toEqual(['dispatch','sent','revoked'])
    expect(await store.list(f.workflow.id,f.userId)).toEqual([])
  })
  it('does not expose or mint publication consent through the member SQL role', async () => {
    const f = await fixture(); await store.approve(f.consent,'0')
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      expect((await client.query('SELECT id FROM workflow_publication_consents WHERE workflow_id=$1',[f.workflow.id])).rows).toEqual([])
      await expect(client.query(`INSERT INTO workflow_publication_consent_states(workflow_id,user_id) VALUES($1,$2)`,[f.workflow.id,f.userId])).rejects.toMatchObject({code:'42501'})
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
