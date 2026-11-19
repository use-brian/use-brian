/**
 * [COMP:api/session-display-history] History read concurrent with Stop settlement
 * (M5D-2): after a confirmed Stop the client immediately reloads
 * `GET /sessions/:id/messages` while the stopped turn is still settling on the
 * session row. The read must return the committed-or-stopping transcript (200),
 * never a 500 from a serialization conflict, and the stopped partial reply lands.
 * Real `chatRoutes` and `sessionRoutes` on the disposable ordinary-owner database.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../chat.js')
const { sessionRoutes } = await import('../sessions.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession } = await import('../../db/sessions.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe.sequential('[COMP:api/session-display-history] Stop then immediate history read', () => {
  it('answers every read racing the Stop settlement with the transcript, and the stopped reply lands', async () => {
    const f = await persistentContextFixture('confidential')
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional desktop', userAgent: null, ipAddress: null }))!
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const words = Array.from({ length: 60 }, (_, i) => `w${i + 1}`)
      const provider: LLMProvider = { name: 'fictional-stop-read', models: ['fixture'], stream() { throw new Error('unexpected') },
        createSession() { return { send(_messages, options) { return (async function* () {
          yield { type: 'message_start' as const, model: 'fixture' }
          for (const [i, word] of words.entries()) {
            if (options?.signal?.aborted) return
            yield { type: 'text_delta' as const, text: (i ? ' ' : '') + word }
            await new Promise(resolve => setTimeout(resolve, 30))
          }
          yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 5, outputTokens: 60 } }
        })() } } } }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Fictional fixture.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      app.use('/sessions', sessionRoutes())
      // Several rounds widen the race window between Stop and its settlement.
      for (let round = 0; round < 3; round++) {
        const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId,
          channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
          { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
        const reads: Array<Promise<{ status: number; body: unknown }>> = []
        let body = '', stopped: Promise<unknown> | undefined
        await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
          message: 'Count for me slowly.', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString()
            if (!stopped && (body.match(/event: text_delta/g) ?? []).length >= 5) {
              const turnId = /"turnId":"([a-f0-9]{64})"/.exec(body)?.[1]
              // The client's sequence: confirmed Stop, then an immediate history reload (and a few more).
              stopped = request(app).post('/chat/stop').send({ sessionId: session.id, ...(turnId ? { turnId } : {}) }).then(stop => {
                for (let i = 0; i < 6; i++) reads.push(new Promise(resolve => setTimeout(resolve, i * 15))
                  .then(() => request(app).get(`/sessions/${session.id}/messages`)).then(r => ({ status: r.status, body: r.body })))
                return stop.body
              })
            }
          })
          res.on('end', () => done(null, body)); res.on('error', done)
        })
        expect(await stopped).toMatchObject({ stopped: true })
        const results = await Promise.all(reads)
        expect(results.map(r => r.status), JSON.stringify(results.filter(r => r.status !== 200))).toEqual(results.map(() => 200))
        let last = (await request(app).get(`/sessions/${session.id}/messages`)).body as Array<{ role: string }>
        for (let i = 0; i < 50 && !last.some(row => row.role === 'assistant'); i++) {
          await new Promise(resolve => setTimeout(resolve, 100)); last = (await request(app).get(`/sessions/${session.id}/messages`)).body
        }
        expect(last.some(row => row.role === 'assistant')).toBe(true)
      }
    } finally { await f.cleanup() }
  }, 180_000)
})
