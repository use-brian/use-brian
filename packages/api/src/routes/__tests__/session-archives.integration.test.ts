/** [COMP:api/sessions-list] Authenticated archive routes across both database roles. */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { initializeConversationVisibility } from '../../db/conversation-visibility.js'
import { sessionRoutes } from '../sessions.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const secret = 'fictional-session-archive-integration-secret'
const app = express()
app.use(express.json())
app.use('/api/sessions', requireAuth(secret), sessionRoutes())

beforeAll(async () => {
  await initializeConversationVisibility()
})
afterAll(async () => {
  await getAppPool().end()
  await getPool().end()
})

async function signIn(userId: string) {
  const device = await authSessionStore.create(userId, {
    deviceLabel: 'Fictional archive test browser', userAgent: null, ipAddress: null,
  })
  if (!device) throw new Error('Failed to create fixture auth session')
  return `Bearer ${createTokens(userId, secret, device).accessToken}`
}

async function list(path: string, authorization: string, archived = false): Promise<string[]> {
  const result = await request(app).get(`${path}&archived=${archived}`).set('Authorization', authorization).expect(200)
  return result.body.map((session: { id: string }) => session.id)
}

function archive(id: string, authorization: string, archived: boolean) {
  return request(app).patch(`/api/sessions/${id}/archive`).set('Authorization', authorization).send({ archived })
}

describe('[COMP:api/sessions-list] per-viewer archive lifecycle on PostgreSQL', () => {
  it('reads existing markers in both lists and updates only the signed-in viewer’s marker', async () => {
    const f = await persistentContextFixture()
    try {
      await f.pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='departments' WHERE workspace_id=$1", [f.workspaceId])
      const owner = await signIn(f.ownerId), peer = await signIn(f.firstId)
      const personalResponse = await request(app).post('/api/sessions/personal').set('Authorization', owner)
        .send({ assistantId: f.assistantId, workspaceId: f.workspaceId, channelId: randomUUID() }).expect(201)
      const personal: string = personalResponse.body.session.id
      const room = f.session.id
      const personalList = `/api/sessions?workspaceId=${f.workspaceId}&appOrigin=chat`
      const roomList = `/api/sessions/workspace?workspaceId=${f.workspaceId}`
      const initial = await f.pool.query(`SELECT id,last_active_at,status FROM sessions
        WHERE id=ANY($1::uuid[]) ORDER BY id`, [[personal, room]])

      // Seed existing preferences through the application role. The list
      // assertions exercise database visibility even if the PATCH is broken.
      await queryWithRLS(f.ownerId, `INSERT INTO session_archives(user_id,session_id)
        VALUES($1,$2),($1,$3)`, [f.ownerId, personal, room])
      expect(await list(personalList, owner)).toEqual([])
      expect(await list(personalList, owner, true)).toEqual([personal])
      expect(await list(roomList, owner)).toEqual([])
      expect(await list(roomList, owner, true)).toEqual([room])
      expect(await list(roomList, peer)).toEqual([room])
      expect(await list(roomList, peer, true)).toEqual([])
      await archive(personal, peer, true).expect(404, { error: 'Session not found' })
      await archive(randomUUID(), peer, true).expect(404, { error: 'Session not found' })
      await request(app).get(`/api/sessions/${personal}/messages`).set('Authorization', owner).expect(200)

      await archive(room, peer, true).expect(200, { archived: true })
      await archive(room, peer, true).expect(200, { archived: true })
      expect(await list(roomList, peer, true)).toEqual([room])
      await archive(room, owner, false).expect(200, { archived: false })
      await archive(room, owner, false).expect(200, { archived: false })
      expect(await list(roomList, owner)).toEqual([room])
      expect(await list(roomList, owner, true)).toEqual([])
      expect(await list(roomList, peer)).toEqual([])
      expect(await list(roomList, peer, true)).toEqual([room])

      await archive(personal, owner, false).expect(200, { archived: false })
      expect(await list(personalList, owner)).toEqual([personal])
      expect(await list(personalList, owner, true)).toEqual([])
      await archive(personal, owner, true).expect(200, { archived: true })
      expect(await list(personalList, owner, true)).toEqual([personal])
      expect(await list(personalList, peer, true)).toEqual([])
      expect((await f.pool.query(`SELECT id,last_active_at,status FROM sessions
        WHERE id=ANY($1::uuid[]) ORDER BY id`, [[personal, room]])).rows).toEqual(initial.rows)
    } finally {
      await f.cleanup()
    }
  })
})
