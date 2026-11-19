/**
 * [COMP:api/chat-route] M5Q-1: a confirmed Stop during admission ends the direct
 * stream as a stopped turn, never as a generic error.
 *
 * Recorded browser sequence (m5-browser-qualification README, M5Q-1): the turn is
 * still preparing (here: inside turn routing, its research classifier pending),
 * `POST /chat/stop` answers `{ stopped: true }`, and the direct `POST /chat`
 * stream then sent `error { "error": "Something went wrong" }` from the server's
 * `TurnStoppedError`. The contract (chat-app.md "Stopping a turn") is that a stop
 * is never reported as a failure: the stream ends with `done { stopped: true }`
 * and the turn settles as `stopped_by_user`. Real route, real disposable
 * ordinary-owner PostgreSQL fixture, deterministic provider.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../chat.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession } = await import('../../db/sessions.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

function frames(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body.split(/\r?\n\r?\n/).flatMap(frame => {
    const event = /^event: (.+)$/m.exec(frame)?.[1]?.trim()
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    return event ? [{ event, data: data ? JSON.parse(data) as Record<string, unknown> : {} }] : []
  })
}

describe.sequential('[COMP:api/chat-route] Stop during admission (M5Q-1)', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('ends the direct stream with the stopped outcome after a confirmed Stop, never an error frame', async () => {
    const f = await persistentContextFixture('confidential')
    try {
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      let classifierEntered!: () => void
      const entered = new Promise<void>(resolve => { classifierEntered = resolve })
      let mainCalls = 0
      const provider: LLMProvider = { name: 'fictional-stop', models: ['fixture'],
        async *stream(options) {
          if ((options.systemPrompt ?? '').startsWith('You are an isolated research-assessment worker')) {
            classifierEntered()
            // Admission is still in progress: wait here until the Stop aborts us.
            await new Promise<void>((_resolve, reject) => {
              if (options.signal?.aborted) { reject(options.signal.reason); return }
              options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
            })
          }
          yield* [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: 'Fictional background' },
            { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }] as StreamChunk[]
        },
        createSession() { return { send() { mainCalls++; return (async function* () {
          yield* [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: 'Unexpected reply' },
            { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }] as StreamChunk[]
        })() } } },
      }
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional stop browser', userAgent: null, ipAddress: null }))!
      const session = await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))

      const direct = request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
        message: 'Compare pricing of three fictional project tools for a ten person team in detail', model: 'standard' })
        .buffer(true).parse((res, done) => {
          let text = ''; res.on('data', (chunk: Buffer) => { text += chunk.toString() }); res.on('end', () => done(null, text)); res.on('error', done)
        }).then(response => response)
      await entered
      const stop = await request(app).post('/chat/stop').send({ sessionId: session.id })
      expect(stop.status).toBe(200)
      expect(stop.body).toMatchObject({ stopped: true })

      const response = await direct
      const received = frames(String(response.body))
      expect(response.status).toBe(200)
      expect(received.filter(frame => frame.event === 'error')).toEqual([])
      expect(received.at(-1)).toMatchObject({ event: 'done', data: { stopped: true, reason: 'stopped_by_user' } })
      expect(mainCalls).toBe(0)
      const settled = (await f.pool.query<{ status: string; reason: string | null }>(
        'SELECT status, turn_end_reason AS reason FROM sessions WHERE id=$1', [session.id])).rows[0]
      expect(settled).toMatchObject({ status: 'idle', reason: 'stopped_by_user' })
    } finally { await f.cleanup() }
  }, 120_000)
})
