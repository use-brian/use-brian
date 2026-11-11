/** [COMP:api/native-chat-read-cost] Complete canonical parent policy at the real SQL boundary. */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { admitTelegramRecording, changeChannelRecording, confirmChannelRecordingOwner } from '../../channel-recording.js'
import { createDbCommentThreadStore } from '../../db/comment-thread-store.js'
import { readSessionById, type Session } from '../../db/sessions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/native-chat-read-cost] canonical session parent audience', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>>
  let reader: string

  beforeEach(async () => {
    fixture = await persistentContextFixture()
    reader = `fixture_parent_audience_${randomUUID().replaceAll('-', '')}`
    // This disposable test entrypoint reaches the private canonical helper as
    // app_user. It cannot read another workspace or change production grants.
    await fixture.pool.query(`CREATE FUNCTION public.${reader}(w uuid,i uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
      BEGIN IF w<>'${fixture.workspaceId}'::uuid THEN RAISE EXCEPTION 'wrong fixture';END IF;
      RETURN native_turn_parent_scope(w,i);END $body$;
      REVOKE ALL ON FUNCTION public.${reader}(uuid,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.${reader}(uuid,uuid) TO app_user`)
  })
  afterEach(async () => {
    try { await fixture?.pool.query(`DROP FUNCTION IF EXISTS public.${reader}(uuid,uuid)`) }
    finally { await fixture?.cleanup() }
  })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  async function parent(session: Session, actor = fixture.ownerId) {
    const execution = await fixture.execution(actor, session)
    const client = await getAppPool().connect()
    try {
      return await runWithAgentAccess(execution.security.access, async () => {
        await client.query('BEGIN')
        await applyRLSGucs(client, actor)
        return (await client.query<{ value: unknown }>(`SELECT public.${reader}($1,$2) AS value`,
          [fixture.workspaceId, session.id])).rows[0].value
      })
    } finally { await rollbackAndRelease(client) }
  }

  async function workRecording() {
    const channel = randomUUID(), integration = randomUUID(), conversation = '-1000008259:topic:31'
    await fixture.pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional parent bot')",
      [channel, fixture.workspaceId])
    await fixture.pool.query(`INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id)
      VALUES($1,$2,'telegram',decode('00','hex'),'987658259')`, [integration, channel])
    await confirmChannelRecordingOwner(integration, fixture.ownerId)
    const incoming = (id: string) => ({ integrationId: integration, conversationId: conversation,
      assistantId: fixture.assistantId, providerMessageId: id, text: 'Fictional retained conversation.', senderUserId: fixture.ownerId })
    const personal = await admitTelegramRecording(incoming('personal-1'))
    expect(personal).not.toBeNull()
    await changeChannelRecording({ integrationId: integration, actorId: fixture.ownerId,
      id: personal!.policy.id, revision: personal!.policy.revision, enabled: true, destination: 'workspace', projectId: null })
    const recorded = await admitTelegramRecording(incoming('work-1'))
    expect(recorded).not.toBeNull()
    expect(recorded!.session).toMatchObject({ visibility: 'workspace', anchorKind: 'channel' })
    return recorded!.session
  }

  async function pageThread() {
    const page = (await fixture.pool.query<{ id: string }>(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance)
      VALUES($1,$2,'Fictional parent Page','tasks','table','{"blocks":[]}','saved','internal') RETURNING id`,
    [fixture.workspaceId, fixture.ownerId])).rows[0]
    const thread = await createDbCommentThreadStore().createThread({ userId: fixture.ownerId, workspaceId: fixture.workspaceId,
      assistantId: fixture.assistantId, pageId: page.id, anchorKind: 'human_range' })
    return { thread, session: (await readSessionById(thread.sessionId))! }
  }

  it('admits a valid recorded Telegram topic without selecting retained body fields into the result', async () => {
    const session = await workRecording()
    const result = await parent(session)
    expect(result).toMatchObject({ workspaceId: fixture.workspaceId, userId: null, assistantId: null,
      assistant: fixture.assistantId, sensitivity: session.effectiveClearance, compartments: [], projectIds: [] })
    expect(Object.keys(result as object).sort()).toEqual(['assistant', 'assistantId', 'compartments', 'createdBy',
      'projectIds', 'sensitivity', 'userId', 'workspaceId'])
  })

  it('admits the real Page thread while retaining its canonical Page association gate', async () => {
    const { session } = await pageThread()
    expect(session.anchorKind).toBe('doc_thread')
    expect(await parent(session)).toMatchObject({ workspaceId: fixture.workspaceId, userId: null })
  })

  it('refuses an orphaned Page thread even for the workspace owner', async () => {
    const { thread, session } = await pageThread()
    await fixture.pool.query('DELETE FROM comment_threads WHERE id=$1', [thread.id])
    expect(await parent(session)).toBeNull()
  })
})
