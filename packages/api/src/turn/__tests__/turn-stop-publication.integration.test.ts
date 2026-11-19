/**
 * [COMP:api/turn-kernel] Stop during output keeps the streamed text (M5Q-2):
 * a real web chat turn through `chatRoutes` on the disposable ordinary-owner
 * database streams part of its reply, the user presses Stop (`POST /chat/stop`),
 * and the partial reply is published as the stopped reply and reopens.
 * Spec: docs/architecture/features/chat-app.md "Stopping a turn" ("Text already
 * streamed is persisted by the loop's own exit").
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../../routes/chat.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession, readSessionById } = await import('../../db/sessions.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { resolveSessionTitleAuthority } = await import('../../routes/session-title-authority.js')
const { readAttendedSessionHistory } = await import('../../routes/attended-session-context.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

afterAll(async () => { await getAppPool().end(); await getPool().end() })
const text = (row: { content: unknown }) => (row.content as Array<{ type: string; text?: string }>)
  .filter(block => block.type === 'text').map(block => block.text).join('')

describe.sequential('[COMP:api/turn-kernel] Stop during output', () => {
  it.each(['personal', 'shared-room'] as const)('publishes the streamed partial reply of a stopped %s web turn', async scenario => {
    const f = await persistentContextFixture('confidential')
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional stop browser', userAgent: null, ipAddress: null }))!
      const session = scenario === 'shared-room' ? f.session : await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      // 40 words, one every 40 ms; Stop arrives after the client has received several.
      const words = Array.from({ length: 40 }, (_, i) => `w${i + 1}`)
      const provider: LLMProvider = { name: 'fictional-stop', models: ['fixture'], stream() { throw new Error('unexpected') },
        createSession() { return { send(_messages, options) { return (async function* () {
          yield { type: 'message_start' as const, model: 'fixture' }
          for (const [i, word] of words.entries()) {
            if (options?.signal?.aborted) return
            yield { type: 'text_delta' as const, text: (i ? ' ' : '') + word }
            await new Promise(resolve => setTimeout(resolve, 40))
          }
          yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 5, outputTokens: 40 } }
        })() } } } }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Fictional fixture.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      let body = '', stopped: Promise<unknown> | undefined
      const response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
        message: 'Count for me slowly.', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
          if (!stopped && (body.match(/event: text_delta/g) ?? []).length >= 6) {
            const turnId = /"turnId":"([a-f0-9]{64})"/.exec(body)?.[1]
            stopped = request(app).post('/chat/stop').send({ sessionId: session.id, ...(turnId ? { turnId } : {}) }).then(r => r.body)
          }
        })
        res.on('end', () => done(null, body)); res.on('error', done)
      })
      expect(response.status).toBe(200)
      expect(await stopped).toMatchObject({ stopped: true })
      expect(String(response.body)).not.toContain('event: error')
      expect(String(response.body)).toContain('"reason":"stopped_by_user"')
      const received = String(response.body).split(/\r?\n\r?\n/).filter(frame => /^event: text_delta\r?$/m.test(frame))
        .map(frame => JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).text).join('')
      expect(received.length).toBeGreaterThan(0)
      // The stopped reply is the text the user saw (it may include a few
      // deltas dispatched while Stop was in flight), never the whole answer.
      // Reopen through the user's own authenticated history read (the page's
      // GET /messages owner). The stopped owner may finish after the stream closes.
      const claims = { userId: f.ownerId, sessionId: device.id, authVersion: device.authVersion }
      const reopen = async () => (await readAttendedSessionHistory(await resolveSessionTitleAuthority({ claims, sessionId: session.id, readOnly: true }), session.id)).messages
      let rows = await reopen()
      for (let i = 0; i < 50 && !rows.some(row => row.role === 'assistant'); i++) {
        await new Promise(resolve => setTimeout(resolve, 100)); rows = await reopen()
      }
      const raw = (await f.pool.query('SELECT role FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [session.id])).rows
      const reply = rows.filter(row => row.role === 'assistant').at(-1)
      expect(reply, `rows: ${JSON.stringify(rows.map(row => [row.role, text(row)]))} raw: ${JSON.stringify(raw.map(row => row.role))}`).toBeDefined()
      expect(text(reply!)).toBe(received)
      expect(text(reply!)).not.toBe(words.join(' '))
      expect((await readSessionById(session.id))?.status).not.toBe('running')
    } finally { await f.cleanup() }
  }, 120_000)
})
