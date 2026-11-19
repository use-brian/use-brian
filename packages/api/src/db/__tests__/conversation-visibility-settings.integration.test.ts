/** [COMP:api/conversation-visibility] Native credential-bound settings and receiving. */
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { withTableTriggersSuspended } from '../../__tests__/fixtures/bootstrap-role.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { sessionRoutes } from '../../routes/sessions.js'
import { liveWorkRoutes } from '../../routes/live-work.js'
import { workspaceSearchRoutes } from '../../routes/workspace-search.js'
import { _getSessionSubscriberCount, _shutdownSessionEventBus, getSessionPresence,
  publishSessionEvent, subscribeSessionEvents } from '../../session-event-bus.js'
import { createSearchAdapters, readSearchItem } from '../../workspace-search/adapters.js'
import { createWorkspaceSearchService } from '../../workspace-search/service.js'
import { authSessionStore } from '../auth-session-store.js'
import { getAppPool, getPool, queryWithRLS, rollbackAndRelease } from '../client.js'
import { captureNativeConversationRecord } from '../conversation-record.js'
import { readNativeConversationHistory } from '../chat-presentation.js'
import { isWorkspaceMember } from '../home-store.js'
import { changeConversationVisibility, conversationSettingsActive, initializeConversationVisibility, moveConversationProject, promoteNativeConversationLegacyHistory,
  raiseConversationCap, readConversationVisibility } from '../conversation-visibility.js'
import { addSessionMessage, createPersonalWebSession, createWorkspaceChatSession, findOrCreateSession } from '../sessions.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const settingsInstalled = (await getAppPool().query<{ installed: boolean }>(`SELECT coalesce(has_function_privilege(current_user,
  to_regprocedure('public.conversation_visibility_settings_ready(integer)'),'EXECUTE'),false) AS installed`)).rows[0]?.installed === true
if (process.env.BRIAN_REQUIRE_CONVERSATION_SETTINGS==='1' && !settingsInstalled)
  throw new Error('The exact installed conversation settings readiness contract is required')
const settingsSuite = settingsInstalled ? describe.sequential : describe.skip
type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>
const denied = { code: 'conversation_access_denied', status: 403 }
async function nativeActor(userId: string) {
  const device = (await authSessionStore.create(userId, { deviceLabel: 'Fictional settings device', userAgent: null, ipAddress: null }))!
  return { userId, authSessionId: device.id, authVersion: device.authVersion }
}
async function createImportedPrivateSession(f: Fixture) {
  const sessionId = randomUUID()
  const client = await f.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,
      visibility,app_origin,effective_clearance,context_compartments,context_binding_origin)
      VALUES($1::uuid,$2,$3,'web',$1::text,'personal','chat','internal','{}','legacy')`, [sessionId, f.assistantId, f.ownerId])
    await client.query(`INSERT INTO session_messages(session_id,sequence_num,role,content)
      VALUES($1,1,'assistant','[{"type":"text","text":"Fictional imported answer"}]')`, [sessionId])
    // Reproduce the reviewed descriptor and row receipt of a transferred 8203
    // import. The named guards are suspended only while the fixture seeds it.
    await client.query("SET LOCAL timezone='UTC'")
    await withTableTriggersSuspended(client, ['session_legacy_history', 'session_legacy_history_messages'], async () => {
      await client.query(`INSERT INTO session_legacy_history(session_id,user_id,workspace_id,binding)
        SELECT id,user_id,$2,private_legacy_history_binding(s) FROM sessions s WHERE id=$1`, [sessionId, f.workspaceId])
      await client.query(`INSERT INTO session_legacy_history_messages(session_id,message_id,sequence_num,fingerprint)
        SELECT session_id,id,sequence_num,encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex')
        FROM session_messages m WHERE session_id=$1`, [sessionId])
    })
    await client.query('COMMIT')
    return sessionId
  } finally { await rollbackAndRelease(client) }
}

beforeAll(async () => {
  await initializeConversationVisibility()
  expect(conversationSettingsActive()).toBe(true)
}, 120_000)
afterAll(async () => { await _shutdownSessionEventBus(); await getAppPool().end(); await getPool().end() })

settingsSuite('[COMP:api/conversation-visibility] native settings and legacy promotion', () => {
  it('activates only the installed protocol on the ordinary app connection during a rolling update', async () => {
    const capability = await getAppPool().query(`SELECT current_user AS role,
      public.conversation_visibility_settings_ready(1) AS current_protocol,
      public.conversation_visibility_settings_ready(0) AS older_protocol,
      public.conversation_visibility_settings_ready(2) AS unknown_protocol`)
    expect(capability.rows).toEqual([{ role: 'app_user', current_protocol: true, older_protocol: false, unknown_protocol: false }])
    await expect(getAppPool().query('SELECT public.conversation_visibility_settings_ready()')).rejects.toMatchObject({ code: '42883' })
  })

  it('classifies newly created native member, workspace and guest sessions before their first receiving read', async () => {
    const f = await persistentContextFixture('internal')
    const guestId = randomUUID()
    try {
      await f.pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [guestId])
      const member = await nativeActor(f.ownerId), other = await nativeActor(f.secondId)
      const addressing = { assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId,
        channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' }
      const principal = { actorUserId: member.userId, authSessionId: member.authSessionId, authVersion: member.authVersion }
      const original = await createPersonalWebSession(addressing, principal)
      expect(await createPersonalWebSession(addressing, principal)).toMatchObject({ id: original.id })
      await addSessionMessage({ sessionId: original.id, role: 'user', senderUserId: member.userId,
        content: [{ type: 'text', text: 'Fictional first private input' }], scope: { ...f.envelope, userId: member.userId } })
      expect(await readConversationVisibility(member, original.id)).toMatchObject({ conversationVisibility: 'private_by_kind' })
      expect(JSON.stringify(await readNativeConversationHistory(member, original.id))).toContain('Fictional first private input')
      await expect(readNativeConversationHistory(other, original.id)).rejects.toMatchObject(denied)
      expect(await readConversationVisibility(other, f.session.id)).toMatchObject({ conversationVisibility: 'workspace' })

      const guest = await findOrCreateSession({ assistantId: f.assistantId, userId: guestId, workspaceId: f.workspaceId,
        channelType: 'telegram', channelId: randomUUID() })
      expect(await readConversationVisibility(member, guest.id)).toMatchObject({ conversationVisibility: 'workspace', conversationCap: 'public' })
      await addSessionMessage({ sessionId: guest.id, role: 'user', senderUserId: guestId,
        content: [{ type: 'text', text: 'Fictional guest input' }], scope: { ...f.envelope, sensitivity: 'public' } })
      expect(JSON.stringify(await readNativeConversationHistory(member, guest.id))).toContain('Fictional guest input')
    } finally {
      await f.cleanup()
      await f.pool.query('DELETE FROM users WHERE id=$1', [guestId])
    }
  })

  it('opens committed settings and sanitized history through the ordinary HTTP, Live and direct RLS readers', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const admin = await nativeActor(f.ownerId), starter = await nativeActor(f.firstId), recipient = await nativeActor(f.secondId)
      const room = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.firstId,
        workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
      const slimImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQIHQEBAP7/AAABAAEY3WUAAAAASUVORK5CYII='
      const rows = [
        { role: 'user', senderUserId: f.firstId, content: [
          { type: 'text', text: `Fictional upload question <attached_file id="${randomUUID()}" name="photo.png" type="image/png">RAW_ATTACHMENT_BODY</attached_file>` },
          { type: 'image', mimeType: 'image/png', data: slimImage, name: 'photo.png' },
        ] },
        { role: 'assistant', content: [
          { type: 'text', text: 'RAW_TOOL_NARRATION' },
          { type: 'tool_use', id: 'fixture-call', name: 'lookupMemory', input: { marker: 'RAW_TOOL_INPUT' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fixture-call', name: 'lookupMemory', content: 'RAW_TOOL_RESULT' }] },
        { role: 'assistant', content: [{ type: 'host_observation', version: 1, id: 'fixture-host', name: 'readSomething',
          input: { marker: 'RAW_HOST_INPUT' }, content: 'RAW_HOST_RESULT', isError: false }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Fictional displayed answer' }] },
      ] as const
      for (const [index, row] of rows.entries()) {
        if (row.content[0].type === 'host_observation') {
          // Seed the native publisher's retained carrier shape for the reader
          // fixture. The executor-only publisher is verified separately.
          await f.pool.query(`INSERT INTO session_messages(session_id,role,content,sequence_num,workspace_id,
            sensitivity,compartments,project_ids,scope_version,scope_held)
            VALUES($1,'assistant',$2,$3,$4,'internal','{}','{}',1,false)`, [room.id, JSON.stringify(row.content), index + 1, f.workspaceId])
        } else {
          await addSessionMessage({ ...row, content: structuredClone([...row.content]), sessionId: room.id, scope: f.envelope })
        }
      }

      const secret = 'fictional-m7-settings-test-secret'
      const app = express(); app.use(express.json())
      app.use('/api/sessions', requireAuth(secret), sessionRoutes())
      app.use('/api', requireAuth(secret), liveWorkRoutes())
      app.use('/api', requireAuth(secret), workspaceSearchRoutes({ isMember: isWorkspaceMember, readItem: readSearchItem,
        search: createWorkspaceSearchService(createSearchAdapters(), { key: Buffer.from(secret) }) }))
      const bearer = (actor: Awaited<ReturnType<typeof nativeActor>>) => `Bearer ${createTokens(actor.userId, secret,
        { id: actor.authSessionId, authVersion: actor.authVersion }).accessToken}`
      const path = `/api/sessions/${room.id}`
      const searchPath = `/api/workspace-search/${f.workspaceId}`
      const search = () => request(app).get(searchPath).set('Authorization', bearer(recipient))
        .query({ q: 'Fictional displayed answer', kind: 'conversations' }).expect(200)
      const ownerHistory = await request(app).get(`${path}/messages`).set('Authorization', bearer(starter)).expect(200)
      expect(ownerHistory.text).toContain(slimImage)
      expect(ownerHistory.text).not.toContain('RAW_')
      const publicHistory = await request(app).get(`${path}/messages`).set('Authorization', bearer(recipient)).expect(200)
      expect(publicHistory.text).toContain('Fictional displayed answer')
      expect(publicHistory.text).toContain('photo.png')
      expect(publicHistory.text).toContain('lookupMemory')
      expect(publicHistory.text).toContain('readSomething')
      expect(publicHistory.text).not.toContain('RAW_')
      expect(publicHistory.text).not.toContain(slimImage)
      expect((await search()).body).toMatchObject({ completeness: 'complete', items: [{ key: room.id }] })

      const update = await request(app).patch(`${path}/visibility`).set('Authorization', bearer(admin))
        .send({ expectedVersion: 1, visibility: 'configured_private' }).expect(200)
      expect(update.body).toEqual({ committed: true, readable: false, sessionId: room.id, version: 2, code: 'conversation_access_denied' })
      expect((await request(app).get(`${path}/messages`).set('Authorization', bearer(recipient)).expect(403)).body.code).toBe('conversation_access_denied')
      await request(app).get(path).set('Authorization', bearer(recipient)).expect(404)
      const actorList = await request(app).get(`/api/sessions/workspace?workspaceId=${f.workspaceId}`)
        .set('Authorization', bearer(recipient)).expect(200)
      expect(actorList.body).not.toContainEqual(expect.objectContaining({ id: room.id }))
      expect((await search()).body).toMatchObject({ completeness: 'complete', items: [] })
      await request(app).get(`${searchPath}/items/conversations/${room.id}`).set('Authorization', bearer(recipient)).expect(404)
      const roster = await request(app).get(`/api/workspaces/${f.workspaceId}/live`).set('Authorization', bearer(recipient)).expect(200)
      expect(roster.body.items.find((item: { id: string }) => item.id === room.id)).toMatchObject({ tier: 'presence' })
      expect(roster.body.items.find((item: { id: string }) => item.id === room.id)).not.toHaveProperty('title')
      expect((await queryWithRLS(recipient.userId, 'SELECT id FROM sessions WHERE id=$1', [room.id])).rows).toEqual([])
      expect((await queryWithRLS(recipient.userId, 'SELECT content FROM session_messages WHERE session_id=$1', [room.id])).rows).toEqual([])

      await request(app).patch(`${path}/visibility`).set('Authorization', bearer(admin))
        .send({ expectedVersion: 2, visibility: 'configured_private', participantUserIds: [recipient.userId] }).expect(200)
      const participant = await request(app).get(path).set('Authorization', bearer(recipient)).expect(200)
      expect(participant.body).toMatchObject({ conversationVisibility: 'configured_private', participantUserIds: [recipient.userId],
        conversationVisibilityVersion: 3, title: 'Fictional upload question' })
      const participantHistory = await request(app).get(`${path}/messages`).set('Authorization', bearer(recipient)).expect(200)
      expect(participantHistory.body).toEqual(publicHistory.body)
      expect((await search()).body).toMatchObject({ completeness: 'complete', items: [{ key: room.id }] })
      const safeRows = (await queryWithRLS(recipient.userId, 'SELECT role FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [room.id])).rows
      expect(safeRows).toEqual([{ role: 'assistant' }])
      expect((await queryWithRLS(recipient.userId, 'SELECT read_conversation_search_text_current($1) AS body', [room.id])).rows)
        .toEqual([{ body: 'Fictional upload question Fictional displayed answer' }])
    } finally { await f.cleanup() }
  })

  it('withdraws an open authenticated follow after settings commit and reopens it for a restored participant', async () => {
    const f = await persistentContextFixture('internal')
    const controller = new AbortController()
    const secret = 'fictional-m7-follow-secret'
    const app = express()
    app.use(express.json())
    app.use('/api/sessions', requireAuth(secret), sessionRoutes({ subscribeSessionEvents, publishSessionEvent, getSessionPresence }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      const owner = await nativeActor(f.ownerId), viewer = await nativeActor(f.secondId)
      const room = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.ownerId,
        workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
      const bearer = (actor: typeof owner) => `Bearer ${createTokens(actor.userId, secret,
        { id: actor.authSessionId, authVersion: actor.authVersion }).accessToken}`
      const path = `/api/sessions/${room.id}`
      const follow = () => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}/stream`,
        { headers: { Authorization: bearer(viewer) }, signal: controller.signal })
      const current = await follow()
      expect(current.status).toBe(200)
      const stream = current.body!.getReader()
      const decoder = new TextDecoder()
      let received = ''
      const closed = (async () => {
        for (let frame = await stream.read(); !frame.done; frame = await stream.read())
          received += decoder.decode(frame.value, { stream: true })
      })()
      void closed.catch(() => {})
      await vi.waitFor(() => expect(_getSessionSubscriberCount()).toBe(1))
      publishSessionEvent({ kind: 'turn_stream', sessionId: room.id, payload: { text: 'Visible follow payload', activity: null } })
      await vi.waitFor(() => expect(received).toContain('Visible follow payload'))
      await request(server).patch(`${path}/visibility`).set('Authorization', bearer(owner))
        .send({ expectedVersion: 1, visibility: 'configured_private' }).expect(200)
      publishSessionEvent({ kind: 'turn_stream', sessionId: room.id, payload: { text: 'Withdrawn follow payload', activity: null } })
      await vi.waitFor(() => expect(_getSessionSubscriberCount()).toBe(0))
      await closed
      expect(received).toContain('event: access_denied')
      expect(received).toContain('conversation_access_denied')
      expect(received).not.toContain('Withdrawn follow payload')
      const refused = await follow()
      expect(refused.status).toBe(403)
      await refused.body?.cancel()
      await request(server).patch(`${path}/visibility`).set('Authorization', bearer(owner))
        .send({ expectedVersion: 2, visibility: 'configured_private', participantUserIds: [viewer.userId] }).expect(200)
      const reopened = await follow()
      expect(reopened.status).toBe(200)
      await reopened.body?.cancel()
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await f.cleanup()
    }
  })

  it('narrows atomically, validates an added reader, and emits a minimal receipt for an admin who loses access', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const admin = await nativeActor(f.ownerId), starter = await nativeActor(f.firstId), recipient = await nativeActor(f.secondId)
      const room = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.firstId,
        workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
      await addSessionMessage({ sessionId: room.id, role: 'assistant', content: [{ type: 'text', text: 'Fictional delivered reply' }], scope: f.envelope })
      const readHistory = (actor: Awaited<ReturnType<typeof nativeActor>>) => readNativeConversationHistory(actor, room.id)
      const readTier = async (actor: Awaited<ReturnType<typeof nativeActor>>) => (await queryWithRLS<{ tier: string }>(actor.userId,
        'SELECT tier FROM read_conversation_member_tiers($1,true)', [[room.id]])).rows[0]?.tier
      expect(await readTier(recipient)).toBe('full')
      expect(await readHistory(recipient)).toMatchObject([{ content: [{ type: 'text', text: 'Fictional delivered reply' }] }])
      await expect(queryWithRLS(recipient.userId, 'SELECT read_native_conversation_history($1,$2,$3)',
        [room.id, recipient.authSessionId, recipient.authVersion])).rejects.toMatchObject({ code: '42501' })
      expect(await readConversationVisibility(recipient, room.id)).toMatchObject({ conversationVisibilityVersion: 1 })
      await expect(changeConversationVisibility(recipient, room.id, { expectedVersion: 1, visibility: 'configured_private' }))
        .rejects.toMatchObject(denied)
      await expect(changeConversationVisibility(admin, room.id, { expectedVersion: 1, visibility: 'configured_private' }))
        .resolves.toEqual({ committed: true, readable: false, sessionId: room.id, version: 2, code: 'conversation_access_denied' })
      expect(await readConversationVisibility(admin, room.id)).toBeNull()
      expect(await readConversationVisibility(recipient, room.id)).toBeNull()
      expect(await readTier(recipient)).toBe('presence')
      await expect(readHistory(recipient)).rejects.toMatchObject(denied)
      const addRecipient = { expectedVersion: 2, visibility: 'configured_private', participantUserIds: [f.secondId] } as const
      await expect(changeConversationVisibility(starter, room.id, { ...addRecipient, participantUserIds: [f.secondId] }))
        .rejects.toMatchObject(denied)
      await expect(changeConversationVisibility(admin, room.id, { ...addRecipient, participantUserIds: [randomUUID()] }))
        .rejects.toMatchObject(denied)
      expect(await readConversationVisibility(starter, room.id)).toMatchObject({ conversationVisibilityVersion: 2, participantUserIds: [] })
      await expect(changeConversationVisibility(admin, room.id, { ...addRecipient, participantUserIds: [f.secondId] }))
        .resolves.toMatchObject({ committed: true, readable: false, version: 3 })
      expect(await readConversationVisibility(recipient, room.id)).toMatchObject({ conversationVisibilityVersion: 3, participantUserIds: [f.secondId] })
      expect(await readTier(recipient)).toBe('full')
      expect(await readHistory(recipient)).toMatchObject([{ content: [{ type: 'text', text: 'Fictional delivered reply' }] }])
      await expect(changeConversationVisibility(admin, room.id, { expectedVersion: 2, visibility: 'workspace' }))
        .rejects.toMatchObject({ code: 'conversation_visibility_conflict', status: 409 })
      await expect(changeConversationVisibility(admin, room.id, { expectedVersion: 3, visibility: 'workspace' }))
        .resolves.toMatchObject({ committed: true, readable: true, version: 4 })
      const notices = await f.pool.query(`SELECT n.kind,n.recipient_user_id,a.next_version FROM conversation_visibility_notices n
        JOIN conversation_visibility_audit a ON a.id=n.audit_id WHERE n.session_id=$1 ORDER BY a.next_version,n.kind`, [room.id])
      expect(notices.rows).toContainEqual({ kind: 'participant_added', recipient_user_id: f.secondId, next_version: '3' })
      expect(notices.rows).toContainEqual({ kind: 'widened', recipient_user_id: f.secondId, next_version: '4' })
      expect((await f.pool.query('SELECT next_version FROM conversation_visibility_audit WHERE session_id=$1 ORDER BY next_version', [room.id])).rows)
        .toEqual([{ next_version: '2' }, { next_version: '3' }, { next_version: '4' }])
    } finally { await f.cleanup() }
  })

  it('preserves the original private receipt through promotion, Project association and native appends', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const actor = await nativeActor(f.ownerId), outsider = await nativeActor(f.secondId)
      const sessionId = await createImportedPrivateSession(f)
      const originalReceipt = (await f.pool.query('SELECT * FROM session_legacy_history WHERE session_id=$1', [sessionId])).rows[0]
      const projectIds = [randomUUID(), randomUUID()]
      for (const [id, name] of [[projectIds[0], 'Fictional Apollo'], [projectIds[1], 'Fictional Beacon']]) {
        await f.pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)',
          [id, f.workspaceId, name, f.ownerId])
      }
      expect((await f.pool.query('SELECT workspace_id FROM sessions WHERE id=$1', [sessionId])).rows[0].workspace_id).toBeNull()
      const capture = (throughSequence: number) => captureNativeConversationRecord(actor,
        { workspaceId: f.workspaceId, sessionId, afterSequence: 0, throughSequence, topicThroughSequence: throughSequence })
      const original = await capture(1)
      expect(original.rows.map(row => row.content)).toEqual([[{ type: 'text', text: 'Fictional imported answer' }]])
      expect((await f.pool.query('SELECT workspace_id FROM sessions WHERE id=$1', [sessionId])).rows[0].workspace_id).toBeNull()
      await expect(promoteNativeConversationLegacyHistory(outsider, sessionId, 1)).rejects.toMatchObject(denied)
      await expect(promoteNativeConversationLegacyHistory(actor, sessionId, 1)).resolves.toMatchObject({ readable: true, version: 2 })
      expect(await promoteNativeConversationLegacyHistory(actor, sessionId, 2)).toMatchObject({ readable: true, version: 2 })
      expect((await f.pool.query('SELECT workspace_id FROM sessions WHERE id=$1', [sessionId])).rows[0].workspace_id).toBe(f.workspaceId)
      for (const [index, projectId] of projectIds.entries()) {
        await expect(f.pool.query('UPDATE sessions SET context_project_id=$2 WHERE id=$1', [sessionId, projectId]))
          .rejects.toMatchObject({ message: 'context_locked' })
        const move = await moveConversationProject(actor, sessionId, { expectedVersion: 2 + index, projectId })
        expect(move).toMatchObject({ readable: true, version: 3 + index, metadata: {
          conversationVisibility: 'private_by_kind', conversationProjectIds: [], conversationCap: 'internal', participantUserIds: [],
        } })
        await addSessionMessage({ sessionId, role: 'user', content: [{ type: 'text', text: `Fictional continued question ${index}` }],
          scope: { ...f.envelope, userId: f.ownerId } })
      }
      const continued = await capture(3)
      expect(continued.rows.map(row => row.content)).toEqual([original.rows[0].content,
        [{ type: 'text', text: 'Fictional continued question 0' }], [{ type: 'text', text: 'Fictional continued question 1' }]])
      expect(continued.source.projectIds).toEqual([])
      expect((await f.pool.query('SELECT * FROM session_legacy_history WHERE session_id=$1', [sessionId])).rows[0]).toEqual(originalReceipt)
      expect(await readConversationVisibility(outsider, sessionId)).toBeNull()
      await expect(changeConversationVisibility(actor, sessionId, { expectedVersion: 4, visibility: 'workspace' })).rejects.toMatchObject(denied)
      await expect(raiseConversationCap(actor, sessionId, { expectedVersion: 4, cap: 'public' }))
        .rejects.toMatchObject({ code: 'conversation_cap_cannot_lower', status: 409 })
      expect((await f.pool.query('SELECT count(*)::int AS count FROM conversation_settings_transitions')).rows[0].count).toBe(0)
    } finally { await f.cleanup() }
  })

  it('continues an imported private session over ordinary HTTP through two Project associations', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const actor = await nativeActor(f.ownerId), outsider = await nativeActor(f.secondId)
      const sessionId = await createImportedPrivateSession(f)
      const originalReceipt = (await f.pool.query('SELECT * FROM session_legacy_history WHERE session_id=$1', [sessionId])).rows[0]
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const [{chatRoutes},{createDbMemoryStore},{createDbCapabilityStore},{createPendingApprovalsStore}] = await Promise.all([
        import('../../routes/chat.js'),import('../memory-store.js'),import('../capability-store.js'),import('../pending-approvals-store.js'),
      ])
      const local = async function* () {
        yield { type: 'message_start', model: 'fictional-project' }
        yield { type: 'text_delta', text: 'Fictional Project reply.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } }
      } satisfies LLMProvider['stream']
      const provider: LLMProvider = { name: 'fictional-project', models: ['fictional-project'], stream: local, createSession: () => ({ send: local }) }
      const app = express(), secret = 'fictional-conversation-project-route'
      app.use(express.json()); app.use(requireAuth(secret))
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Fictional Project response.', tools: new Map(), memoryStore: createDbMemoryStore(),
        capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      const token = createTokens(actor.userId, secret, { id: actor.authSessionId, authVersion: actor.authVersion }).accessToken
      const send = async (message: string) => {
        const reply = await request(app).post('/chat').auth(token, { type: 'bearer' }).send({ sessionId, assistantId: f.assistantId,
          workspaceId: f.workspaceId, message, model: 'pro', mode: 'default' }).buffer(true).parse((response, done) => {
          let body = ''; response.on('data', (chunk: Buffer) => { body += chunk.toString() }); response.on('end', () => done(null, body))
        })
        expect(reply.status).toBe(200)
        expect(reply.body).toContain('Fictional Project reply.')
        expect(reply.body).not.toContain('event: error')
      }
      await send('Fictional continuation of the imported conversation')
      expect((await f.pool.query('SELECT workspace_id FROM sessions WHERE id=$1', [sessionId])).rows[0].workspace_id).toBe(f.workspaceId)
      for (const name of ['Fictional Apollo', 'Fictional Beacon']) {
        const projectId = randomUUID()
        await f.pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)',
          [projectId, f.workspaceId, name, f.ownerId])
        const metadata = await readConversationVisibility(actor, sessionId)
        await expect(moveConversationProject(actor, sessionId, { expectedVersion: metadata!.conversationVisibilityVersion, projectId }))
          .resolves.toMatchObject({ readable: true, metadata: { conversationVisibility: 'private_by_kind', conversationProjectIds: [] } })
        await send(`Continue privately in ${name}`)
        const tagged = await addSessionMessage({
          sessionId, role: 'assistant', content: [{ type: 'text', text: 'Fictional tagged material must stay quarantined.' }],
          scope: { ...f.envelope, userId: f.ownerId, compartments: [`project:${projectId}`], projectIds: [projectId] },
        })
        expect((await f.pool.query('SELECT reason FROM conversation_message_quarantine WHERE message_id=$1', [tagged.id])).rows[0])
          .toEqual({ reason: 'outside_boundary' })
      }
      const history = JSON.stringify(await readNativeConversationHistory(actor, sessionId))
      expect(history).toContain('Fictional imported answer')
      expect(history).toContain('Continue privately in Fictional Apollo')
      expect(history).toContain('Continue privately in Fictional Beacon')
      expect(history).not.toContain('Fictional tagged material must stay quarantined.')
      expect((await f.pool.query('SELECT * FROM session_legacy_history WHERE session_id=$1', [sessionId])).rows[0]).toEqual(originalReceipt)
      await expect(readNativeConversationHistory(outsider, sessionId)).rejects.toMatchObject(denied)
      const delivered = await f.pool.query(`UPDATE session_messages SET scope_held=true WHERE session_id=$1 AND role='user'
        AND content @> '[{"type":"text","text":"Continue privately in Fictional Apollo"}]' RETURNING id`, [sessionId])
      expect(delivered.rowCount).toBe(1)
      const afterHold = JSON.stringify(await readNativeConversationHistory(actor, sessionId))
      expect(afterHold).not.toContain('Continue privately in Fictional Apollo')
      expect(afterHold).toContain('Fictional imported answer')
      expect(afterHold).toContain('Continue privately in Fictional Beacon')
    } finally { await f.cleanup() }
  }, 60_000)

  it('enrolls the original receipt as part of the first explicit promotion', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const actor = await nativeActor(f.ownerId)
      const sessionId = await createImportedPrivateSession(f)
      const before = (await f.pool.query('SELECT * FROM session_legacy_history WHERE session_id=$1', [sessionId])).rows[0]
      expect((await f.pool.query('SELECT 1 FROM conversation_legacy_history_enrollments WHERE session_id=$1', [sessionId])).rowCount).toBe(0)
      await expect(promoteNativeConversationLegacyHistory(actor, sessionId, 1)).resolves.toMatchObject({ readable: true, version: 2 })
      expect((await f.pool.query('SELECT 1 FROM conversation_legacy_history_enrollments WHERE session_id=$1', [sessionId])).rowCount).toBe(1)
      expect((await f.pool.query('SELECT * FROM session_legacy_history WHERE session_id=$1', [sessionId])).rows[0]).toEqual(before)
    } finally { await f.cleanup() }
  })

  it('withholds a changed original assistant after enrollment and rolls back held, revoked and mismatching promotions', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const actor = await nativeActor(f.ownerId)
      const [changed, held, revoked] = await Promise.all([0, 1, 2].map(() => createImportedPrivateSession(f)))
      const selection = { workspaceId: f.workspaceId, sessionId: changed, afterSequence: 0, throughSequence: 1, topicThroughSequence: 1 }
      const captured = await captureNativeConversationRecord(actor, selection)
      expect(captured.rows).toHaveLength(1)
      const alternate = randomUUID()
      await f.pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional alternate assistant',$2,$3,'standard','confidential')",
        [alternate, f.ownerId, f.workspaceId])
      await f.pool.query('UPDATE sessions SET assistant_id=$2 WHERE id=$1', [changed, alternate])
      expect((await captureNativeConversationRecord(actor, selection)).rows).toHaveLength(0)
      expect((await f.pool.query('SELECT read_conversation_record_source($1,$2) AS value',
        [f.workspaceId, captured.source.resourceId])).rows[0].value).toEqual({ held: true })
      await expect(promoteNativeConversationLegacyHistory(actor, changed, 1)).rejects.toMatchObject(denied)
      await f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1', [held])
      await expect(promoteNativeConversationLegacyHistory(actor, held, 1)).rejects.toMatchObject(denied)
      await authSessionStore.revokeForUser(f.ownerId, actor.authSessionId)
      await expect(promoteNativeConversationLegacyHistory(actor, revoked, 1)).rejects.toMatchObject(denied)
      const states = await f.pool.query(`SELECT workspace_id,(SELECT count(*)::int FROM conversation_visibility_audit WHERE session_id=s.id) AS audits
        FROM sessions s WHERE id=ANY($1::uuid[])`, [[changed, held, revoked]])
      expect(states.rows).toEqual(Array.from({ length: 3 }, () => ({ workspace_id: null, audits: 0 })))
    } finally { await f.cleanup() }
  })
})
