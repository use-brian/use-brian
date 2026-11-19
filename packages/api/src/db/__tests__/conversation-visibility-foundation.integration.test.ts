/** [COMP:api/conversation-visibility] Additive envelope foundation at the real
 * ordinary-owner migration and app-user boundary. Settings are not exposed
 * until the authenticated helper successor activates the canonical rule. */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { getPool, getAppPool, applyRLSGucs, rollbackAndRelease } = await import('../client.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')
const { withTableTriggersSuspended } = await import('../../__tests__/fixtures/bootstrap-role.js')
const { createPersonalWebSession, findOrCreateSession } = await import('../sessions.js')
const { authSessionStore } = await import('../auth-session-store.js')
const { authenticateConversationInstallation } = await import(new URL('../../../scripts/conversation-store/installation-authentication.mjs', import.meta.url).href)
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe.sequential('[COMP:api/conversation-visibility] no-widen envelope foundation', () => {
  it('keeps the complete 8294 installation authenticated with additive tables and trigger', async () => {
    const client = await getPool().connect()
    try {
      const receipt = await authenticateConversationInstallation(client)
      expect(receipt.functions).toBe(392)
      expect(receipt.witnessCurrent).toBe(true)
    } finally { await rollbackAndRelease(client) }
  }, 120_000)

  it('classifies shared rooms and personal member docks without changing legacy identity keys or held rows', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const room = (await f.pool.query('SELECT * FROM conversation_envelopes WHERE session_id=$1', [f.session.id])).rows[0]
      expect(room).toMatchObject({ visibility: 'workspace', classification: 'existing_workspace', cap: 'internal', version: '1' })
      const dock = randomUUID(), guest = randomUUID()
      const tx = await f.pool.connect()
      try {
        await tx.query('BEGIN')
        // Model exactly retained pre-M7 shapes, including an old personal dock
        // and guest session. No historical trigger contract is weakened.
        await withTableTriggersSuspended(tx, ['sessions'], async () => {
          for (const [id, token, origin] of [[dock, null, 'doc'], [guest, randomUUID(), 'chat']]) {
            await tx.query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,
              visibility,app_origin,effective_clearance,context_compartments,context_binding_origin,guest_session_token)
              VALUES($1::uuid,$2,$3,$4,'web',$1::text,'personal',$5,'internal','{}','legacy',$6)`,
            [id, f.assistantId, f.ownerId, f.workspaceId, origin, token])
          }
        })
        await tx.query('COMMIT')
      } finally { await rollbackAndRelease(tx) }
      // Calls bound their own transactions and resume by absent keys.
      await f.pool.query('SELECT backfill_conversation_envelopes(1)')
      await f.pool.query('SELECT backfill_conversation_envelopes(1000)')
      const rows = (await f.pool.query(`SELECT e.session_id,e.visibility,e.classification,s.visibility AS legacy,s.app_origin
        FROM conversation_envelopes e JOIN sessions s ON s.id=e.session_id WHERE e.session_id=ANY($1::uuid[]) ORDER BY e.session_id`, [[dock, guest]])).rows
      expect(rows.find(row => row.session_id === dock)).toMatchObject({ visibility: 'private_by_kind', classification: 'member_direct', legacy: 'personal', app_origin: 'doc' })
      expect(rows.find(row => row.session_id === guest)).toMatchObject({ visibility: 'configured_private', classification: 'legacy_personal', legacy: 'personal' })
      expect((await f.pool.query('SELECT count(*)::int AS n FROM conversation_participants WHERE session_id=ANY($1::uuid[])', [[dock, guest]])).rows[0].n).toBe(0)
      const versions = await f.pool.query('SELECT session_id,version,classified_at FROM conversation_envelopes WHERE session_id=ANY($1::uuid[]) ORDER BY session_id', [[dock, guest]])
      expect((await f.pool.query('SELECT backfill_conversation_envelopes(1000) AS n')).rows[0].n).toBe(0)
      expect((await f.pool.query('SELECT session_id,version,classified_at FROM conversation_envelopes WHERE session_id=ANY($1::uuid[]) ORDER BY session_id', [[dock, guest]])).rows).toEqual(versions.rows)
    } finally { await f.cleanup() }
  }, 120_000)

  it('classifies actual member web/provider and public API creation without turning unattended lanes into guest conversations', async () => {
    const f = await persistentContextFixture('internal')
    const guestId = randomUUID()
    await f.pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [guestId])
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional envelope browser', userAgent: null, ipAddress: null }))!
      const web = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId,
        workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
      { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const created = [web]
      const memberDevice = (await authSessionStore.create(f.firstId, { deviceLabel: 'Fictional member browser', userAgent: null, ipAddress: null }))!
      await expect(createPersonalWebSession({assistantId:f.assistantId,userId:f.firstId,workspaceId:f.workspaceId,
        channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
      {actorUserId:f.firstId,authSessionId:memberDevice.id,authVersion:memberDevice.authVersion})).rejects.toMatchObject({code:'context_not_available'})
      const internalAssistant=randomUUID()
      await f.pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional internal helper',$2,$3,'standard','internal')",
        [internalAssistant,f.ownerId,f.workspaceId])
      const internalWeb = await createPersonalWebSession({ assistantId:internalAssistant,userId:f.firstId,workspaceId:f.workspaceId,
        channelType:'web',channelId:randomUUID(),appOrigin:'chat' },
      { actorUserId:f.firstId,authSessionId:memberDevice.id,authVersion:memberDevice.authVersion })
      expect((await f.pool.query('SELECT cap FROM conversation_envelopes WHERE session_id=$1',[internalWeb.id])).rows[0].cap).toBe('internal')
      await f.pool.query("UPDATE assistants SET clearance='confidential' WHERE id=$1",[internalAssistant])
      expect((await f.pool.query('SELECT cap FROM conversation_envelopes WHERE session_id=$1',[internalWeb.id])).rows[0].cap).toBe('internal')
      for (const [channelType, userId] of [['telegram', f.ownerId], ['telegram', guestId], ['api', f.ownerId], ['workflow', f.ownerId]]) {
        created.push(await findOrCreateSession({ assistantId: f.assistantId, userId, workspaceId: f.workspaceId,
          channelType, channelId: randomUUID() }))
      }
      const rows = (await f.pool.query(`SELECT session_id,visibility,cap FROM conversation_envelopes WHERE session_id=ANY($1::uuid[])`, [created.map(row => row.id)])).rows
      const selected = (index:number) => rows.find(row => row.session_id === created[index].id)
      expect(selected(0)).toMatchObject({ visibility: 'private_by_kind' })
      expect(selected(1)).toMatchObject({ visibility: 'private_by_kind' })
      expect(selected(2)).toMatchObject({ visibility: 'workspace', cap: 'public' })
      expect(selected(3)).toMatchObject({ visibility: 'workspace', cap: 'public' })
      expect(selected(4)).toMatchObject({ visibility: 'configured_private' })
      // No caller can use the owner maintenance functions to reclassify an old
      // session as newly public, even if runtime default ACLs grant functions.
      const app = await getAppPool().connect()
      try {
        await app.query('BEGIN'); await applyRLSGucs(app, f.ownerId)
        await expect(app.query('SELECT classify_conversation_envelope($1,false)', [web.id])).rejects.toMatchObject({ code:'42501' })
      } finally { await rollbackAndRelease(app) }
    } finally { await f.cleanup(); await f.pool.query('DELETE FROM users WHERE id=$1', [guestId]) }
  }, 120_000)

  it('does not make an archived or former-member 1:1 admin-widenable, even when a web response group exists', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const id = randomUUID()
      const foreignMessage = randomUUID()
      const tx = await f.pool.connect()
      try {
        await tx.query('BEGIN')
        await withTableTriggersSuspended(tx, ['sessions'], () => tx.query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,
          channel_type,channel_id,visibility,anchor_kind,effective_clearance,archived_at,context_binding_origin)
          VALUES($1::uuid,$2,$3,$4,'web',$5,'personal','channel',NULL,now(),'legacy')`,
        [id,f.assistantId,f.firstId,f.workspaceId,f.session.channelId]))
        await withTableTriggersSuspended(tx,['session_messages'],()=>tx.query(`INSERT INTO session_messages(
          session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
          VALUES($1,'user','[{"type":"text","text":"Fictional retained member request"}]',1,$2,$3,NULL,'internal','{}','{}',1,false)`,
        [id,f.workspaceId,f.firstId]))
        await withTableTriggersSuspended(tx,['session_messages'],()=>tx.query(`INSERT INTO session_messages(
          id,session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
          VALUES($1,$2,'assistant','[{"type":"text","text":"Fictional unrelated private row"}]',2,$3,$4,NULL,'confidential','{}','{}',1,false)`,
        [foreignMessage,id,f.workspaceId,f.ownerId]))
        await tx.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId,f.firstId])
        await tx.query('SELECT classify_conversation_envelope($1,true)', [id])
        await tx.query('COMMIT')
      } finally { await rollbackAndRelease(tx) }
      expect((await f.pool.query('SELECT visibility,cap FROM conversation_envelopes WHERE session_id=$1',[id])).rows[0])
        .toEqual({visibility:'private_by_kind',cap:'internal'})
      expect((await f.pool.query('SELECT reason FROM conversation_message_quarantine WHERE message_id=$1',[foreignMessage])).rows)
        .toEqual([{reason:'private_owner'}])
    } finally { await f.cleanup() }
  }, 120_000)

  it('keeps invalid existing rows and their holds unchanged while inventorying them for review', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const history = await f.history()
      const client = await f.pool.connect()
      try {
        await client.query('BEGIN')
        await withTableTriggersSuspended(client, ['session_messages'], async () => {
          await client.query("UPDATE session_messages SET sensitivity='confidential',scope_held=true WHERE id=$1", [history[0].id])
          await client.query("UPDATE session_messages SET compartments=ARRAY['team:outside'] WHERE id=$1", [history[1].id])
        })
        // Remove only additive fixture maintenance state to exercise historical
        // enrollment. Transcript rows and their original stamps stay in place.
        await client.query('DELETE FROM conversation_envelopes WHERE session_id=$1', [f.session.id])
        await client.query('SELECT classify_conversation_envelope($1,true)', [f.session.id])
        await client.query('COMMIT')
      } finally { await rollbackAndRelease(client) }
      expect((await f.pool.query('SELECT message_id,reason FROM conversation_message_quarantine WHERE session_id=$1 ORDER BY reason', [f.session.id])).rows)
        .toEqual([{ message_id: history[0].id, reason: 'above_cap' }, { message_id: history[1].id, reason: 'outside_boundary' }])
      expect((await f.pool.query('SELECT sensitivity,scope_held FROM session_messages WHERE id=$1', [history[0].id])).rows[0])
        .toEqual({ sensitivity: 'confidential', scope_held: true })
      const app = await getAppPool().connect()
      try {
        await app.query('BEGIN'); await applyRLSGucs(app, f.firstId)
        // No direct app-user envelope mutation/read surface is installed before
        // the reviewed canonical-authority successor.
        await expect(app.query('SELECT * FROM conversation_envelopes WHERE session_id=$1', [f.session.id]))
          .rejects.toMatchObject({ code: '42501' })
      } finally { await rollbackAndRelease(app) }
      await expect(f.pool.query('SELECT backfill_conversation_envelopes(1001)')).rejects.toThrow('conversation_backfill_batch_invalid')
    } finally { await f.cleanup() }
  }, 120_000)
})
