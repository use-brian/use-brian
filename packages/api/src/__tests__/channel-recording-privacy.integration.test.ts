/** Seed fixtures/channel-recording-upgrade.sql through createLocalFixture's
 * beforeApply boundary at 8135, then run against that genuine owned fixture.
 * [COMP:api/channel-recording]
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, query } from '../db/client.js'
import { confirmChannelRecordingOwner, admitTelegramRecording } from '../channel-recording.js'
import { findOrCreateChannelRoom } from '../channel-room/room.js'
import { getSessionMessages, getSessionMessageById, getSessionTranscriptForWorkspaceSystem,
  listSessionsForWorkspaceSystem, readSessionById } from '../db/sessions.js'
import { gateSessionRead } from '../session-read-authority.js'
const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const fixture = {
  owner: 'f8135000-0000-4000-8000-000000000001', admin: 'f8135000-0000-4000-8000-000000000002',
  creator: 'f8135000-0000-4000-8000-000000000003', workspace: 'f8135000-0000-4000-8000-000000000010',
  assistant: 'f8135000-0000-4000-8000-000000000020', channel: 'f8135000-0000-4000-8000-000000000030',
  integration: 'f8135000-0000-4000-8000-000000000040', session: 'f8135000-0000-4000-8000-000000000050',
  message: 'f8135000-0000-4000-8000-000000000060',
}
async function asViewer<T>(userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId])
    return await run(client)
  } finally { await client.query('ROLLBACK'); client.release() }
}

describe.sequential('[COMP:api/channel-recording] durable legacy privacy quarantine', () => {
  beforeAll(async () => {
    const seeded = (await query('SELECT id FROM sessions WHERE id=$1', [fixture.session])).rows
    expect(seeded, 'Run with the genuine pre-8135 upgrade fixture').toHaveLength(1)
    await query(`INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id)
      VALUES($1,$2,'telegram','\\x00'::bytea,'987654350') ON CONFLICT(id) DO NOTHING`, [fixture.integration,fixture.channel])
  })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('backfills the hold without changing creator, audience, classification or body', async () => {
    const stored = (await query(`SELECT user_id,visibility,effective_clearance,context_compartments,
      recording_privacy_held,recording_revision FROM sessions WHERE id=$1`, [fixture.session])).rows[0]
    expect(stored).toMatchObject({ user_id: fixture.creator, visibility: 'workspace', effective_clearance: 'internal',
      context_compartments: [], recording_privacy_held: true, recording_revision: null })
    expect((await query('SELECT content FROM session_messages WHERE id=$1', [fixture.message])).rows[0]?.content)
      .toEqual([{ type: 'text', text: 'Fictional protected legacy body' }])
  })

  it('withholds parent and message rows from the creator, owner, administrator and teammate', async () => {
    for (const userId of [fixture.creator, fixture.owner, fixture.admin]) {
      await asViewer(userId, async client => {
        expect((await client.query('SELECT id,title FROM sessions WHERE id=$1', [fixture.session])).rows).toEqual([])
        expect((await client.query('SELECT id,content FROM session_messages WHERE id=$1', [fixture.message])).rows).toEqual([])
      })
      expect(await gateSessionRead(userId, { id: fixture.session, assistantId: fixture.assistant, userId: fixture.creator,
        channelType: 'telegram', anchorKind: 'channel', visibility: 'workspace', mode: null, effectiveClearance: 'internal',
        contextCompartments: [], contextProjectId: null })).toMatchObject({ status: 404 })
    }
    expect(await readSessionById(fixture.session)).toBeNull()
    expect(await getSessionMessages(fixture.session)).toEqual([])
    expect(await getSessionMessageById(fixture.message)).toBeNull()
    expect(await getSessionTranscriptForWorkspaceSystem(fixture.session, fixture.workspace, { limit: 10 })).toBeNull()
    expect((await listSessionsForWorkspaceSystem(fixture.workspace, { limit: 50 })).some(row => row.id === fixture.session)).toBe(false)
  })

  it('refuses native source, history and CRM source content before selecting its body', async () => {
    await asViewer(fixture.owner, async client => {
      for (const name of ['read_scope_source', 'read_scope_review_source', 'read_scope_review_content',
        'read_admitted_native_scope_snapshot', 'read_entity_derivation_source', 'crm_delivery_source_snapshot']) {
        // Some raw scope facades are deliberately owner-only. The owner pool
        // assertion below covers those; app-facing admitted ports stay callable.
        const permission = (await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [`${name}(uuid,text,uuid)`])).rows[0].allowed
        if (permission) expect((await client.query(`SELECT ${name}($1,'session_message',$2) AS value`, [fixture.workspace, fixture.message])).rows[0].value).toBeNull()
      }
    })
    for (const name of ['read_scope_source', 'read_scope_review_source', 'read_scope_review_content',
      'read_admitted_native_scope_snapshot', 'read_entity_derivation_source', 'crm_delivery_source_snapshot']) {
      expect((await query(`SELECT ${name}($1,'session_message',$2) AS value`, [fixture.workspace, fixture.message])).rows[0].value).toBeNull()
    }
    expect((await query("SELECT application_session_field_state($1,'session_message',$2,ARRAY['content']) AS value",
      [fixture.workspace,fixture.message])).rows[0]?.value).toBeNull()
    expect((await query('SELECT session_context_parent_snapshot($1,$2) AS value', [fixture.workspace, fixture.session])).rows[0].value).toBeNull()
    expect((await query('SELECT application_session_query_parent($1,$2) AS value', [fixture.workspace, fixture.session])).rows[0].value).toBeNull()
    // The owner pool cannot turn a denied native history request into values.
    await expect(query("SELECT read_native_application_session_projection($1,$2,100,'history') AS value",
      [fixture.workspace, fixture.session])).rejects.toThrow('access_unavailable')
  })

  it('preserves an unrelated event with no session while excluding a held-session event', async () => {
    const unbound = randomUUID(), held = randomUUID()
    // turn_events normally has no member policy. A fixture-only permissive
    // rule isolates this restrictive policy's null-link behavior.
    await query(`CREATE POLICY fictional_recording_event_read ON turn_events FOR SELECT
      USING(workspace_id='${fixture.workspace}'::uuid)`)
    try {
      await query(`INSERT INTO turn_events(id,workspace_id,session_id,assistant_message_id,step_ordinal,actor,kind)
        VALUES($1::uuid,$3::uuid,NULL,$1::text,0,'consolidation_run','retrieval'),
              ($2::uuid,$3::uuid,$4::uuid,$2::text,0,'assistant_turn','retrieval')`, [unbound, held, fixture.workspace, fixture.session])
      await asViewer(fixture.owner, async client => {
        expect((await client.query('SELECT id FROM turn_events WHERE id=ANY($1::uuid[])', [[unbound, held]])).rows)
          .toEqual([{ id: unbound }])
      })
    } finally {
      await query('DROP POLICY fictional_recording_event_read ON turn_events')
      await query('DELETE FROM turn_events WHERE id=ANY($1::uuid[])', [[unbound, held]])
    }
  })

  it('holds old-writer inserts immediately and refuses further transcript writes', async () => {
    const conversationId = `-1000000351:topic:35`
    await expect(findOrCreateChannelRoom({ workspaceId: fixture.workspace, channelIntegrationId: fixture.integration,
      assistantId: fixture.assistant, channelType: 'telegram', channelId: conversationId, starterUserId: fixture.creator }))
      .rejects.toThrow('channel_room_unavailable')
    const fresh = (await query('SELECT id,recording_privacy_held FROM sessions WHERE workspace_id=$1 AND channel_id=$2',
      [fixture.workspace, conversationId])).rows[0]
    expect(fresh?.recording_privacy_held).toBe(true)
    await expect(query("INSERT INTO session_messages(session_id,role,content,sequence_num) VALUES($1,'user','[]',1)", [fresh.id]))
      .rejects.toThrow('recording_privacy_review_required')
  })

  it('owner confirmation cannot release a historical hold while a new policy epoch stays usable', async () => {
    await confirmChannelRecordingOwner(fixture.integration, fixture.owner)
    expect((await query('SELECT session_recording_read_allowed($1) AS allowed', [fixture.session])).rows[0]?.allowed).toBe(false)
    await expect(query('UPDATE sessions SET recording_privacy_held=false WHERE id=$1', [fixture.session]))
      .rejects.toThrow('recording_privacy_review_required')
    const current = await admitTelegramRecording({ integrationId: fixture.integration, assistantId: fixture.assistant,
      conversationId: '-1000000350:topic:35', providerMessageId: 'fictional-new-epoch-' + randomUUID(),
      text: 'Fictional new owner recording', senderUserId: fixture.creator })
    expect(current?.session.visibility).toBe('personal')
    expect(current?.session.id).not.toBe(fixture.session)
    expect(await readSessionById(current!.session.id)).not.toBeNull()
    await asViewer(fixture.owner, async client => {
      expect((await client.query('SELECT id FROM sessions WHERE id=$1', [current!.session.id])).rows).toHaveLength(1)
      expect((await client.query('SELECT id FROM session_messages WHERE session_id=$1', [current!.session.id])).rows.length).toBeGreaterThan(0)
    })
    await query('DELETE FROM channel_integrations WHERE id=$1', [fixture.integration])
    expect((await query('SELECT session_recording_read_allowed($1) AS allowed', [fixture.session])).rows[0]?.allowed).toBe(false)
    expect(await getSessionMessages(fixture.session)).toEqual([])
  })
})
