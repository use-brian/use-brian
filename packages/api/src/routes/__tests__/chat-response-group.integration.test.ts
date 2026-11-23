/**
 * [COMP:api/room-mechanics] Multi-assistant response group at the real boundary
 * (M5Q-7): `@A @B` is two serialized turns on one authored row. The second
 * member is admitted after the first member published its reply, reads that
 * reply (the huddle), answers, and the authenticated history shows both replies.
 * The primary captures its conversation queries with unrestricted assistant
 * visibility and the helper with its own; the native reader admits either
 * frozen query domain only from the current reader's own admission (8280).
 * A member cleared below the group's authored row is still refused, and a
 * single under-cleared answerer in a personal chat reads only what its own
 * ceiling admits, under both permission models (8281: the private-transcript
 * floor is the reading assistant's).
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
const text = (row: Row) => (row.content as Array<{ type: string; text?: string }>)
  .filter(block => block.type === 'text').map(block => block.text).join('')

type Variant = 'personal web chat created by the first send' | 'workspace room'
type Model = 'legacy' | 'department-v2'
const variants: Variant[] = ['personal web chat created by the first send', 'workspace room']
const models: Model[] = ['legacy', 'department-v2']
const cases = variants.flatMap(variant => models.map(model => [variant, model] as const))

/** One conversation driven through chatRoutes with a real device session. */
async function conversation(variant: Variant, permissionModel: Model, helperClearance: 'confidential' | 'internal') {
  const f = await persistentContextFixture('confidential')
  await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1', [f.workspaceId, permissionModel === 'department-v2'])
  const helperId = randomUUID()
  await f.pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional helper',$2,$3,'standard',$4)",
    [helperId, f.ownerId, f.workspaceId, helperClearance])
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
  const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional group browser', userAgent: null, ipAddress: null }))!
  const state = { calls: 0, sent: [] as string[], first: [] as string[] }
  const provider: LLMProvider = { name: 'fictional-group', models: ['fixture'], stream: async function* () {
    yield { type: 'message_start', model: 'fixture' } as StreamChunk; yield { type: 'text_delta', text: 'Fictional title' } as StreamChunk
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk },
    createSession(options) { return { async *send(messages) {
      const input = JSON.stringify(messages)
      state.sent.push(input)
      yield { type: 'message_start', model: 'fixture' }
      if (options.tools?.some(tool => tool.name === 'requestConversationContext')) {
        state.first.push(input)
        if (options.runtimeSystemContext?.includes('Another assistant has already responded')) {
          const id = 'fictional-group-history'
          yield { type: 'tool_use_start', id, name: 'requestConversationContext' }
          yield { type: 'tool_use_delta', id, input: '{}' }
          yield { type: 'tool_use_end', id }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 2 } }
          return
        }
      }
      yield { type: 'text_delta', text: `Fictional member ${++state.calls} answer.` }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } }
    } } } }
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
  })
  app.use('/chat', chatRoutes({ provider, systemPrompt: 'Fictional fixture.', tools: new Map(),
    memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
  let sessionId = variant === 'workspace room' ? f.session.id : ''
  const post = async (body: Record<string, unknown>) => String((await request(app).post('/chat').send({ ...(sessionId ? { sessionId } : {}), workspaceId: f.workspaceId,
    appOrigin: 'chat', mode: 'default', model: 'pro', ...body }).buffer(true).parse((res, done) => {
    let chunks = ''; res.on('data', (chunk: Buffer) => { chunks += chunk.toString() }); res.on('end', () => done(null, chunks)) })).body)
  if (!sessionId) {
    // The personal chat is created by its first send, as in the product.
    const opened = await post({ assistantId: f.assistantId, message: 'Fictional chat opener.' })
    sessionId = /"sessionId":"([0-9a-f-]{36})"/.exec(opened)?.[1] ?? ''
    expect(sessionId, opened.slice(0, 400)).not.toBe('')
  }
  const stored = (await f.pool.query<{ visibility: string }>('SELECT visibility FROM sessions WHERE id=$1', [sessionId])).rows[0]
  expect(stored?.visibility).toBe(variant === 'workspace room' ? 'workspace' : 'personal')
  const claims = { userId: f.ownerId, sessionId: device.id, authVersion: device.authVersion }
  // The user's authenticated history read, exactly as GET /api/sessions/:id/messages selects it.
  const history = async (): Promise<Row[]> => variant === 'workspace room'
    ? (await readAttendedSessionHistory(await resolveSessionTitleAuthority({ claims, sessionId, readOnly: true }), sessionId)).messages
    : (await readPrivateChatPresentation({ claims, sessionId })) as Row[]
  const settled = async (assistants: number) => {
    let rows = await history()
    for (let i = 0; i < 50 && rows.filter(row => row.role === 'assistant').length < assistants; i++) {
      await new Promise(resolve => setTimeout(resolve, 100)); rows = await history()
    }
    return rows
  }
  /** The client's serialized group: the first member persists the row, the second reuses it.
   * With `admittedFirst: false` a route that refuses the group at invitation may end it there. */
  const group = async ({ admittedFirst = true } = {}) => {
    const ids = [f.assistantId, helperId]
    const first = await post({ assistantId: f.assistantId, message: '@Brian @Helper compare the fictional plans.', roomResponseGroup: { assistantIds: ids } })
    if (!admittedFirst && first.includes('event: error')) return first
    expect(first).not.toContain('event: error')
    const saved = /event: user_message_saved\r?\ndata: \{[^\n]*"id":"([0-9a-f-]{36})"/.exec(first)?.[1]
      ?? (await f.pool.query<{ id: string }>("SELECT id FROM session_messages WHERE session_id=$1 AND role='user' ORDER BY sequence_num DESC LIMIT 1", [sessionId])).rows[0]?.id
    expect(saved).toBeTruthy()
    return post({ assistantId: helperId, message: 'Fictional substitution sent on the follow-up POST.', roomResponseGroup: { assistantIds: ids, sourceMessageId: saved } })
  }
  return { f, helperId, state, post, group, settled }
}

describe.sequential('[COMP:api/room-mechanics] response group', () => {
  it.each(cases)('lets the second member of an @A @B group answer after the first member published (%s, %s)', async (variant, permissionModel) => {
    // Cleared to the room, so every row of this conversation is readable by both
    // members; only their assistant visibility differs (primary: all, helper: itself).
    const c = await conversation(variant, permissionModel, 'confidential')
    try {
      const before = c.state.calls
      expect(await c.group()).not.toContain('event: error')
      const rows = await c.settled(before + 2)
      expect(rows.filter(row => row.role === 'user' && text(row) === '@Brian @Helper compare the fictional plans.')).toHaveLength(1)
      expect(c.state.calls).toBe(before + 2)
      expect(rows.filter(row => row.role === 'assistant' && text(row)).slice(-2).map(row => [row.senderAssistantId, text(row)])).toEqual([
        [c.f.assistantId, `Fictional member ${before + 1} answer.`], [c.helperId, `Fictional member ${before + 2} answer.`]])
      expect(c.state.first.at(-1)).toContain('@Brian @Helper compare the fictional plans.')
      expect(c.state.first.at(-1)).not.toContain(`Fictional member ${before + 1} answer.`)
      expect(c.state.sent.join(' ')).not.toContain('Fictional substitution')
      // The second member built on the first member's persisted reply.
      expect(c.state.sent.at(-1)).toContain(`Fictional member ${before + 1} answer.`)
    } finally { await c.f.cleanup() }
  }, 120_000)

  it.each(cases)('still refuses a second member cleared below the group\'s authored row (%s, %s)', async (variant, permissionModel) => {
    const c = await conversation(variant, permissionModel, 'internal')
    try {
      const before = c.state.calls
      // Refused in the reader, or at invitation by the route (the whole room group,
      // or the later member skipped with its notice code).
      expect(await c.group({ admittedFirst: false })).toMatch(/event: error|assistant_clearance_below_conversation/)
      // The under-cleared member never reached the model, and nothing was published for it.
      expect(c.state.calls).toBeLessThanOrEqual(before + 1)
      const rows = await c.settled(c.state.calls)
      expect(rows.filter(row => row.role === 'assistant' && row.senderAssistantId === c.helperId)).toEqual([])
    } finally { await c.f.cleanup() }
  }, 120_000)

  it.each(models)('lets a single under-cleared answerer in a personal chat read only what its own ceiling admits (%s)', async permissionModel => {
    const c = await conversation('personal web chat created by the first send', permissionModel, 'internal')
    try {
      const before = c.state.calls
      // The opener and its reply are labelled at the bound primary's confidential ceiling.
      const reply = await c.post({ assistantId: c.helperId, message: '@Helper add your view.' })
      expect(reply).not.toContain('event: error')
      expect(c.state.calls).toBe(before + 1)
      expect(c.state.sent.at(-1)).toContain('@Helper add your view.')
      expect(c.state.sent.at(-1)).not.toContain('Fictional chat opener.')
      expect(c.state.sent.at(-1)).not.toContain(`Fictional member ${before} answer.`)
      const rows = await c.settled(before + 1)
      expect(rows.filter(row => row.role === 'assistant').at(-1)).toMatchObject({ senderAssistantId: c.helperId })
    } finally { await c.f.cleanup() }
  }, 120_000)
})
