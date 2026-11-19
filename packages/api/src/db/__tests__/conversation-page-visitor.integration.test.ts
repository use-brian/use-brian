/** [COMP:api/conversation-visibility] A real link grant and per-thread guest
 * token drive the same Page conversation data as native member history. */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { mountGuestCommentRoutes } from '../../routes/_public-guest-comments.js'
import { authSessionStore } from '../auth-session-store.js'
import { readNativeConversationHistory } from '../chat-presentation.js'
import { getAppPool, getPool, queryWithRLS, rollbackAndRelease } from '../client.js'
import { listPublicThreadsForPage } from '../comment-thread-store.js'
import { initializeConversationVisibility, pageVisitorConversationsActive } from '../conversation-visibility.js'
import { createDbPageGrantStore } from '../page-grant-store.js'
import { addSessionMessage, createWorkspaceChatSession } from '../sessions.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { buildReceivingOwnerMigration } = await import(new URL('../../../scripts/conversation-store/build-conversation-receiving-owners.mjs', import.meta.url).href)
const { receivingInstallationSource } = await import(new URL('../../../scripts/conversation-store/installation-authentication-8301.mjs', import.meta.url).href)
const { currentReleaseSource } = await import(new URL('../../../scripts/conversation-store/installation-release.mjs', import.meta.url).href)
let authentication: { sql: string; cleanup: string; functions: number } | null = null
beforeAll(async () => {
  const installed = await getPool().query("SELECT to_regprocedure('public.read_native_page_conversation_rows(uuid,text)') IS NOT NULL installed")
  if (!installed.rows[0].installed) {
    const client = await getPool().connect()
    try {
      const migration = await buildReceivingOwnerMigration()
      await client.query(migration)
      authentication = await receivingInstallationSource(migration)
    }
    catch (error) {
      const sql = error as { message: string; detail?: string; where?: string }
      throw new Error([sql.message, sql.detail, sql.where].filter(Boolean).join(' | '))
    } finally { await rollbackAndRelease(client) }
  }
  const numbered = await getPool().query(`SELECT EXISTS(SELECT 1 FROM public._migrations WHERE name='8301_conversation_receiving_owners.sql') installed,
    (SELECT name FROM public._migrations ORDER BY name COLLATE "C" DESC LIMIT 1) head`)
  if (numbered.rows[0].installed) authentication = await currentReleaseSource(numbered.rows[0].head)
  await initializeConversationVisibility()
  expect(pageVisitorConversationsActive()).toBe(true)
}, 120_000)
afterAll(async () => { await getAppPool().end(); await getPool().end() })

it('receives only bound guest comments, hides withdrawn bytes and checks the live Page share', async () => {
  const f = await persistentContextFixture('internal')
  try {
    const pageId = randomUUID()
    await f.pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,clearance,state,page)
      VALUES($1,$2,$3,'Fictional guests','tasks','table','public','saved','{"type":"doc","content":[]}')`, [pageId, f.workspaceId, f.ownerId])
    const grants = createDbPageGrantStore(), { token, grant } = await grants.createLinkGrant({ userId: f.ownerId, pageId, role: 'comment' })
    const app = express(), router = express.Router()
    app.use(express.json())
    mountGuestCommentRoutes(router, '/public/pages/:token', req => grants.resolveLinkToken(req.params.token))
    app.use(router)
    const base = `/public/pages/${token}`
    const opened = await request(app).post(base + '/comment-threads').send({ body: 'Fictional first guest comment', guestName: 'Guest One' })
    expect(opened.status, JSON.stringify(opened.body)).toBe(201)
    const guest = opened.body.guestSessionToken as string
    const other = await request(app).post(base + '/comment-threads').send({ body: 'Fictional second visitor only', guestName: 'Guest Two' })
    expect(other.status).toBe(201)
    const added = await request(app).post(base + `/comment-threads/${opened.body.threadId}/messages`).send({ body: 'Fictional guest follow-up', guestSessionToken: guest })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    const denied = await request(app).post(base + `/comment-threads/${other.body.threadId}/messages`).send({ body: 'Disallowed cross-visitor append', guestSessionToken: guest })
    expect(denied.status).toBe(403)
    const receiving = await request(app).get(base + '/comments').query({ guestSessionToken: guest })
    expect(receiving.body.threads).toHaveLength(1)
    expect(receiving.body.threads[0].comments.map((comment: { body: string }) => comment.body)).toEqual(['Fictional first guest comment', 'Fictional guest follow-up'])
    const sessionId = (await f.pool.query('SELECT session_id FROM comment_threads WHERE id=$1', [opened.body.threadId])).rows[0].session_id
    const credential = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional Page reader', userAgent: null, ipAddress: null }))!
    const actor = { userId: f.ownerId, authSessionId: credential.id, authVersion: credential.authVersion }
    expect(JSON.stringify(await readNativeConversationHistory(actor, sessionId))).toContain('Fictional guest follow-up')
    await expect(queryWithRLS(f.ownerId, 'SELECT * FROM public.read_native_page_conversation_rows($1,$2)', [pageId, guest])).rejects.toMatchObject({ code: '42501' })
    await f.pool.query('UPDATE session_messages SET scope_held=true WHERE session_id=$1 AND sequence_num=1', [sessionId])
    expect(JSON.stringify(await listPublicThreadsForPage(pageId))).not.toContain('Fictional first guest comment')
    expect(JSON.stringify((await request(app).get(base + '/comments').query({ guestSessionToken: guest })).body)).not.toContain('Fictional first guest comment')
    expect(await grants.revokeGrant(f.ownerId, grant.id)).toBe(true)
    expect((await request(app).get(base + '/comments').query({ guestSessionToken: guest })).status).toBe(404)
  } finally { await f.cleanup() }
}, 30_000)


it('quarantines an initially wider append and keeps an already delivered row after upstream relabeling', async () => {
  const f = await persistentContextFixture('internal')
  try {
    const delivered = await addSessionMessage({ sessionId: f.session.id, role: 'user', content: 'Fictional originally admitted bytes',
      senderUserId: f.ownerId, scope: f.envelope })
    const tooWide = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Confidential body from an unreviewed append',
      senderAssistantId: f.assistantId, scope: { ...f.envelope, sensitivity: 'confidential' } })
    await f.pool.query("UPDATE session_messages SET sensitivity='confidential' WHERE id=$1", [delivered.id])
    const quarantined = await f.pool.query('SELECT message_id,reason FROM conversation_message_quarantine WHERE session_id=$1', [f.session.id])
    expect(quarantined.rows).toEqual([{ message_id: tooWide.id, reason: 'above_cap' }])
    const device = (await authSessionStore.create(f.firstId, { deviceLabel: 'Fictional record cap reader', userAgent: null, ipAddress: null }))!
    const actor = { userId: f.firstId, authSessionId: device.id, authVersion: device.authVersion }
    const rows = JSON.stringify(await readNativeConversationHistory(actor, f.session.id))
    expect(rows).toContain('Fictional originally admitted bytes')
    expect(rows).not.toContain('Confidential body from an unreviewed append')
  } finally { await f.cleanup() }
}, 30_000)

it('repairs one requested historical envelope and resumes bounded background inventory from a committed cursor', async () => {
  const f = await persistentContextFixture('internal')
  try {
    const other = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.ownerId,
      workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
    await f.pool.query('DELETE FROM conversation_envelopes WHERE session_id=ANY($1::uuid[])', [[f.session.id, other.id]])
    const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional partial inventory reader', userAgent: null, ipAddress: null }))!
    const actor = { userId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion }
    expect((await readNativeConversationHistory(actor, f.session.id))).toEqual([])
    expect((await f.pool.query('SELECT session_id FROM conversation_envelopes WHERE session_id=ANY($1::uuid[])', [[f.session.id, other.id]])).rows)
      .toEqual([{ session_id: f.session.id }])
    const advance = async () => (await f.pool.query('SELECT advance_conversation_envelope_backfill(1) AS value')).rows[0].value
    const initial = await advance()
    expect(initial.scanned).toBeLessThanOrEqual(1)
    const initialCursor = (await f.pool.query('SELECT after_session_id FROM conversation_envelope_backfill_checkpoint')).rows[0].after_session_id
    expect(initialCursor).toBeTruthy()
    let done = initial.done === true
    for (let attempt=0; !done && attempt<8; attempt++) {
      const result = await advance()
      expect(result.scanned).toBeLessThanOrEqual(1)
      done = result.done === true
    }
    expect(done).toBe(true)
    expect((await f.pool.query('SELECT session_id FROM conversation_envelopes WHERE session_id=$1', [other.id])).rows).toEqual([{ session_id: other.id }])
    expect(await advance()).toEqual({ done: true, scanned: 0, classified: 0 })
  } finally { await f.cleanup() }
}, 30_000)


it('authenticates the receiving owner on the unchanged predecessor chain and refuses a direct grant', async test => {
  if (!authentication) return test.skip()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const result = await client.query(authentication.sql)
    expect((Array.isArray(result) ? result.at(-1) : result)?.rows[0]).toMatchObject({ functions: authentication.functions, witness_current: true })
    await client.query(authentication.cleanup)
    await client.query('COMMIT')
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query('GRANT EXECUTE ON FUNCTION public.read_native_page_conversation_rows(uuid,text) TO app_user')
    await expect(client.query(authentication.sql)).rejects.toThrow('conversation_receiving_helper_changed: read_native_page_conversation_rows')
  } finally { await rollbackAndRelease(client) }
}, 120_000)
