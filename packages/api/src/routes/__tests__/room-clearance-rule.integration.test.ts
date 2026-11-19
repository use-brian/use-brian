/**
 * [COMP:api/room-mechanics] Clearance at invitation (M5Q-7 variant A) at the
 * real `chatRoutes` boundary with a native device session, both permission
 * models. A Team assistant cleared `internal` cannot read a `confidential`
 * room or a personal chat's `confidential` authored row, so it is refused when
 * it is invited instead of being admitted and failed by a lane:
 *
 *   - a single room mention of it is rejected (`error`, nothing written), and
 *     the cleared member's room turn still completes;
 *   - a room left bound to it by an old rebind refuses its default turns up
 *     front with the rebind copy;
 *   - in a response group it is skipped with a `notice` and `done` (nothing
 *     written, no turn) while the cleared member answers; the authored row
 *     keeps its label;
 *   - a fully cleared group still answers twice and history shows both
 *     replies (the 8280 case).
 *
 * Spec: docs/architecture/context-engine/session-messages.md, "Response groups
 * and the native conversation reader"; chat-app.md, "Several `@` mentions".
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
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { resolveSessionTitleAuthority } = await import('../session-title-authority.js')
const { readAttendedSessionHistory } = await import('../attended-session-context.js')
const { readPrivateChatPresentation } = await import('../../db/chat-presentation.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

afterAll(async () => { await getAppPool().end(); await getPool().end() })

type Row = { role: string; content: unknown; senderAssistantId?: string | null }
type Frame = { event: string; data: Record<string, unknown> }
const CODE = 'assistant_clearance_below_conversation'
const text = (row: Row) => (row.content as Array<{ type: string; text?: string }>)
  .filter(block => block.type === 'text').map(block => block.text).join('')
const frames = (body: unknown): Frame[] => String(body).split(/\r?\n\r?\n/).flatMap((block) => {
  const event = /^event: (.+)$/m.exec(block)?.[1]
  const data = /^data: (.+)$/m.exec(block)?.[1]
  if (!event) return []
  try { return [{ event, data: data ? JSON.parse(data) as Record<string, unknown> : {} }] } catch { return [{ event, data: {} }] }
})

type Variant = 'personal' | 'room'
type Model = 'legacy' | 'department-v2'

async function harness(variant: Variant, model: Model, helperClearance: 'internal' | 'confidential') {
  const f = await persistentContextFixture('confidential')
  await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1', [f.workspaceId, model === 'department-v2'])
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
  const helperId = randomUUID()
  // `internal` is the product default for a Team assistant created through the
  // workspace assistant route; the primary and the room are `confidential`.
  await f.pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional helper',$2,$3,'standard',$4)",
    [helperId, f.ownerId, f.workspaceId, helperClearance])
  const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional clearance browser', userAgent: null, ipAddress: null }))!
  let calls = 0
  const provider: LLMProvider = { name: 'fictional-clearance', models: ['fixture'], stream: async function* () {
    yield { type: 'message_start', model: 'fixture' } as StreamChunk; yield { type: 'text_delta', text: 'Fictional title' } as StreamChunk
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk },
    createSession() { return { send() { const reply = `Fictional member ${++calls} answer.`; return (async function* () {
      yield { type: 'message_start' as const, model: 'fixture' }
      yield { type: 'text_delta' as const, text: reply }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 2, outputTokens: 2 } }
    })() } } } }
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
  })
  app.use('/chat', chatRoutes({ provider, systemPrompt: 'Fictional fixture.', tools: new Map(),
    memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
  let sessionId = variant === 'room' ? f.session.id : ''
  const post = async (body: Record<string, unknown>): Promise<Frame[]> => frames((await request(app).post('/chat')
    .send({ ...(sessionId ? { sessionId } : {}), workspaceId: f.workspaceId, appOrigin: 'chat', mode: 'default', model: 'pro', ...body })
    .buffer(true).parse((res, done) => {
      let chunks = ''; res.on('data', (chunk: Buffer) => { chunks += chunk.toString() }); res.on('end', () => done(null, chunks))
    })).body)
  if (!sessionId) {
    // The personal chat is created by its first send, as in the product.
    const opened = await post({ assistantId: f.assistantId, message: 'Fictional chat opener.' })
    sessionId = String(opened.find(frame => frame.event === 'session')?.data.sessionId ?? '')
    expect(sessionId, JSON.stringify(opened).slice(0, 400)).not.toBe('')
  }
  const claims = { userId: f.ownerId, sessionId: device.id, authVersion: device.authVersion }
  // The user's authenticated history read, exactly as GET /api/sessions/:id/messages selects it.
  const history = async (): Promise<Row[]> => variant === 'room'
    ? (await readAttendedSessionHistory(await resolveSessionTitleAuthority({ claims, sessionId, readOnly: true }), sessionId)).messages
    : (await readPrivateChatPresentation({ claims, sessionId })) as Row[]
  const settledHistory = async (expectedReplies: number): Promise<Row[]> => {
    let rows = await history()
    for (let i = 0; i < 50 && rows.filter(row => row.role === 'assistant').length < expectedReplies; i++) {
      await new Promise(resolve => setTimeout(resolve, 100)); rows = await history()
    }
    return rows
  }
  const rowCount = async () => Number((await f.pool.query<{ n: string }>('SELECT count(*) AS n FROM session_messages WHERE session_id=$1', [sessionId])).rows[0]?.n)
  const savedId = (out: Frame[]) => String(out.find(frame => frame.event === 'user_message_saved')?.data.id ?? '')
  return { f, helperId, post, history, settledHistory, rowCount, savedId, calls: () => calls, sessionId: () => sessionId }
}

const models = ['legacy', 'department-v2'] as const

describe.sequential('[COMP:api/room-mechanics] clearance is checked at invitation (M5Q-7 variant A)', () => {
  it.each(models)('rejects a room mention of an internal assistant into a confidential room; the cleared member still answers (%s)', async (model) => {
    const h = await harness('room', model, 'internal')
    try {
      const rowsBefore = await h.rowCount()
      const refused = await h.post({ assistantId: h.helperId, message: '@Helper summarize the fictional plan.' })
      const error = refused.find(frame => frame.event === 'error')
      expect(error?.data.code, JSON.stringify(refused)).toBe(CODE)
      expect(String(error?.data.error)).toContain('Fictional helper')
      expect(String(error?.data.error)).not.toMatch(/confidential|internal/)
      expect(refused.some(frame => frame.event === 'user_message_saved')).toBe(false)
      expect(await h.rowCount()).toBe(rowsBefore)
      expect(h.calls()).toBe(0)

      const answered = await h.post({ assistantId: h.f.assistantId, message: 'Brian, summarize the fictional plan.' })
      expect(answered.some(frame => frame.event === 'error'), JSON.stringify(answered).slice(0, 400)).toBe(false)
      const rows = await h.settledHistory(1)
      expect(rows.filter(row => row.role === 'user').map(text)).toEqual(['Brian, summarize the fictional plan.'])
      expect(rows.filter(row => row.role === 'assistant').map(row => [row.senderAssistantId, text(row)]))
        .toEqual([[h.f.assistantId, 'Fictional member 1 answer.']])
    } finally { await h.f.cleanup() }
  }, 120_000)

  it.each(models)('refuses a default turn up front when the room is bound below its floor by an old rebind (%s)', async (model) => {
    const h = await harness('room', model, 'internal')
    try {
      // A rebind the old rule admitted, written straight to the store: the
      // room's own default voice is now cleared below the room.
      await h.f.pool.query('UPDATE sessions SET assistant_id=$2 WHERE id=$1', [h.sessionId(), h.helperId])
      const rowsBefore = await h.rowCount()
      const refused = await h.post({ assistantId: h.helperId, message: 'Summarize the fictional plan.' })
      const error = refused.find(frame => frame.event === 'error')
      expect(error?.data.code, JSON.stringify(refused)).toBe(CODE)
      expect(String(error?.data.error)).toContain('Fictional helper is not cleared to read this room')
      expect(String(error?.data.error)).toContain('Choose an assistant cleared for this room')
      expect(refused.some(frame => frame.event === 'user_message_saved' || frame.event === 'session')).toBe(false)
      expect(await h.rowCount()).toBe(rowsBefore)
      expect(h.calls()).toBe(0)
    } finally { await h.f.cleanup() }
  }, 120_000)

  it.each(models)('skips an internal member of a room group with a notice while the cleared member answers; a refused first member rejects the send (%s)', async (model) => {
    const h = await harness('room', model, 'internal')
    try {
      const message = '@Brian @Helper compare the fictional plans.'
      // Refused first member: nothing is saved yet, so the mention is rejected.
      const rowsBefore = await h.rowCount()
      const rejected = await h.post({ assistantId: h.helperId, message, roomResponseGroup: { assistantIds: [h.helperId, h.f.assistantId] } })
      expect(rejected.find(frame => frame.event === 'error')?.data.code, JSON.stringify(rejected)).toBe(CODE)
      expect(await h.rowCount()).toBe(rowsBefore)

      const group = [h.f.assistantId, h.helperId]
      const first = await h.post({ assistantId: h.f.assistantId, message, roomResponseGroup: { assistantIds: group } })
      expect(first.some(frame => frame.event === 'error'), JSON.stringify(first).slice(0, 400)).toBe(false)
      const saved = h.savedId(first)
      expect(saved).not.toBe('')
      await h.settledHistory(1)
      const rowsAfterFirst = await h.rowCount()
      const second = await h.post({ assistantId: h.helperId, message, roomResponseGroup: { assistantIds: group, sourceMessageId: saved } })
      expect(second.map(frame => frame.event)).toEqual(['session', 'notice', 'done'])
      const notice = second[1]!.data
      expect(notice).toMatchObject({ code: CODE, assistantId: h.helperId, assistantName: 'Fictional helper' })
      expect(String(notice.message)).toContain('Fictional helper was skipped')
      expect(await h.rowCount()).toBe(rowsAfterFirst)
      expect(h.calls()).toBe(1)
      const rows = await h.history()
      expect(rows.filter(row => row.role === 'user' && text(row) === message)).toHaveLength(1)
      expect(rows.filter(row => row.role === 'assistant').map(row => row.senderAssistantId)).toEqual([h.f.assistantId])
    } finally { await h.f.cleanup() }
  }, 120_000)

  it.each(models)('skips an under-cleared member of a personal group without lowering the authored row (%s)', async (model) => {
    const h = await harness('personal', model, 'internal')
    try {
      const message = '@Brian @Helper compare the fictional plans.'
      const group = [h.f.assistantId, h.helperId]
      const before = h.calls()
      const first = await h.post({ assistantId: h.f.assistantId, message, roomResponseGroup: { assistantIds: group } })
      expect(first.some(frame => frame.event === 'error'), JSON.stringify(first).slice(0, 400)).toBe(false)
      const saved = h.savedId(first)
      expect(saved).not.toBe('')
      await h.settledHistory(2)
      const label = async () => (await h.f.pool.query<{ sensitivity: string }>('SELECT sensitivity FROM session_messages WHERE id=$1', [saved])).rows[0]?.sensitivity
      expect(await label()).toBe('confidential')
      const rowsAfterFirst = await h.rowCount()
      const second = await h.post({ assistantId: h.helperId, message, roomResponseGroup: { assistantIds: group, sourceMessageId: saved } })
      expect(second.map(frame => frame.event)).toEqual(['session', 'notice', 'done'])
      expect(second[1]!.data).toMatchObject({ code: CODE, assistantId: h.helperId })
      expect(String(second[1]!.data.message)).toContain('not cleared to read this message')
      expect(await h.rowCount()).toBe(rowsAfterFirst)
      expect(await label()).toBe('confidential')
      expect(h.calls()).toBe(before + 1)
      const rows = await h.history()
      expect(rows.filter(row => row.role === 'user' && text(row) === message)).toHaveLength(1)
      expect(rows.filter(row => row.role === 'assistant').slice(-1).map(row => [row.senderAssistantId, text(row)]))
        .toEqual([[h.f.assistantId, `Fictional member ${before + 1} answer.`]])
    } finally { await h.f.cleanup() }
  }, 120_000)

  it.each([['personal', 'legacy'], ['personal', 'department-v2'], ['room', 'legacy'], ['room', 'department-v2']] as const)(
    'a fully cleared group answers twice and history shows both replies (%s, %s)', async (variant, model) => {
      const h = await harness(variant, model, 'confidential')
      try {
        const message = '@Brian @Helper compare the fictional plans.'
        const group = [h.f.assistantId, h.helperId]
        const before = h.calls()
        const first = await h.post({ assistantId: h.f.assistantId, message, roomResponseGroup: { assistantIds: group } })
        expect(first.some(frame => frame.event === 'error'), JSON.stringify(first).slice(0, 400)).toBe(false)
        const saved = h.savedId(first)
        expect(saved).not.toBe('')
        const second = await h.post({ assistantId: h.helperId, message, roomResponseGroup: { assistantIds: group, sourceMessageId: saved } })
        expect(second.some(frame => frame.event === 'error' || frame.event === 'notice' && frame.data.code === CODE),
          JSON.stringify(second).slice(0, 400)).toBe(false)
        const rows = await h.settledHistory(before + 2)
        expect(h.calls()).toBe(before + 2)
        expect(rows.filter(row => row.role === 'user' && text(row) === message)).toHaveLength(1)
        expect(rows.filter(row => row.role === 'assistant').slice(-2).map(row => [row.senderAssistantId, text(row)])).toEqual([
          [h.f.assistantId, `Fictional member ${before + 1} answer.`], [h.helperId, `Fictional member ${before + 2} answer.`]])
      } finally { await h.f.cleanup() }
    }, 120_000)
})
