/**
 * [COMP:api/turn-kernel] Turn routing through the real web and channel routes (M3 T6).
 *
 * Drives fixed turns through `chatRoutes` and `processChannelMessage` on the
 * disposable ordinary-owner PostgreSQL fixture and counts the background model
 * calls the turn actually made, by classifier, at the provider boundary (the
 * research, topic and split classifiers each send their own system prompt).
 * Web turns also report the runtime `turnTiming` counters from the turn-end
 * log line (`research_classify_count`, `topic_classify_count`,
 * `split_classify_count`), which the routing cutover times once per routed
 * port invocation. The expected per-turn budget is the one in
 * docs/architecture/features/research.md "Preparation port" (receipt
 * m3-adapter-routing-cutover.md). Nothing about routing is mocked: the
 * provider is deterministic, and its classifier answers are fixed per turn.
 *
 * Output: `BRIAN_TURN_ROUTING_OUTPUT` (JSON; default `$TMPDIR/brian-turn-routing.json`)
 * plus one `turn-routing` console line per fixed turn.
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../../routes/chat.js')
const { readAttendedSessionHistory } = await import('../../routes/attended-session-context.js')
const { resolveSessionTitleAuthority } = await import('../../routes/session-title-authority.js')
const { processChannelMessage } = await import('../../routes/channel-pipeline.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { initializeConversationVisibility } = await import('../../db/conversation-visibility.js')
const { createPersonalWebSession, addSessionMessage } = await import('../../db/sessions.js')
const { findAssistantById } = await import('../../db/users.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

type Lane = 'research' | 'topic' | 'split'
const LANES: Lane[] = ['research', 'topic', 'split']
/** Each core classifier sends its own fixed system prompt. */
function laneOf(options: Parameters<LLMProvider['stream']>[0]): Lane | 'other' {
  const prompt = options.systemPrompt ?? ''
  if (prompt.startsWith('You are an isolated research-assessment worker')) return 'research'
  if (prompt.startsWith('You are a topic classifier')) return 'topic'
  if (prompt.startsWith('You decide if a user message requires parallel independent research')) return 'split'
  return 'other'
}

const LONG = 'Compare pricing of three fictional project tools for a ten person team in detail'
const SHORT = 'what is the latest policy rate?'
const OPERATE = 'browse lu.ma for me and list the fictional events happening this weekend'

type Fixed = {
  turn: string
  surface: 'web' | 'channel'
  message: string
  verdict?: 'research'
  body?: Record<string, unknown>
  reply?: boolean
  /** The split classifier returns two tasks, so preflight or the coordinator takes the routed split. */
  splitTasks?: boolean
  /** A fragment the response must carry (the consumer of the routed split). */
  expectBody?: string
  expected: Record<Lane, number>
}
/** The fixed turns of the receipt table: expected classifier calls per lane. */
const FIXED: Fixed[] = [
  { turn: 'web Standard trivial', surface: 'web', message: 'thanks', body: { model: 'standard' }, expected: { research: 0, topic: 0, split: 0 } },
  { turn: 'web Standard trivial reply', surface: 'web', message: 'thanks', reply: true, body: { model: 'standard' }, expected: { research: 0, topic: 1, split: 0 } },
  { turn: 'web Standard short question', surface: 'web', message: SHORT, body: { model: 'standard' }, expected: { research: 1, topic: 1, split: 0 } },
  { turn: 'web Standard long ordinary', surface: 'web', message: LONG, body: { model: 'standard' }, expected: { research: 1, topic: 1, split: 1 } },
  { turn: 'web Standard long, research verdict', surface: 'web', message: LONG, verdict: 'research', body: { model: 'standard' }, expected: { research: 1, topic: 1, split: 1 } },
  { turn: 'web Standard operate-site', surface: 'web', message: OPERATE, body: { model: 'standard' }, expected: { research: 0, topic: 1, split: 0 } },
  { turn: 'web explicit research', surface: 'web', message: LONG, body: { mode: 'research' }, expected: { research: 0, topic: 1, split: 0 } },
  { turn: 'web Pro/Max long ordinary', surface: 'web', message: LONG, body: { model: 'pro' }, expected: { research: 1, topic: 1, split: 1 } },
  { turn: 'web Pro/Max long, research verdict', surface: 'web', message: LONG, verdict: 'research', body: { model: 'pro' }, expected: { research: 1, topic: 1, split: 0 } },
  { turn: 'web Standard long, routed split to preflight', surface: 'web', message: LONG, splitTasks: true, body: { model: 'standard' },
    expectBody: 'Researching in parallel', expected: { research: 1, topic: 1, split: 1 } },
  { turn: 'web Pro/Max long, routed split to coordinator', surface: 'web', message: LONG, splitTasks: true, body: { model: 'pro' },
    expectBody: 'research_parallel', expected: { research: 1, topic: 1, split: 1 } },
  { turn: 'channel paid long ordinary', surface: 'channel', message: LONG, expected: { research: 1, topic: 1, split: 1 } },
  { turn: 'channel trivial', surface: 'channel', message: 'thanks', expected: { research: 0, topic: 0, split: 0 } },
]

const results: unknown[] = []
const usage = { inputTokens: 10, outputTokens: 2 }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function provider(fixed: Fixed, calls: Record<Lane | 'other' | 'main', number>): LLMProvider {
  const reply = 'Fictional routed reply.'
  const text = (value: string): StreamChunk[] => [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: value },
    { type: 'message_end', stopReason: 'end_turn', usage }]
  return {
    name: 'fictional-routing', models: ['fixture'],
    async *stream(options) {
      const lane = laneOf(options)
      calls[lane]++
      if (lane === 'research') {
        // A late verdict lets the speculative split reach the provider first,
        // so a verdict-discarded split is counted deterministically.
        await delay(60)
        yield* text(fixed.verdict === 'research' ? '{"research":true,"effort":"focused","reason":"fictional comparison"}' : '{"research":false}')
        return
      }
      if (lane === 'topic') { yield* text('{"topic_label":"fictional tools","state":"continue","confidence":0.9}'); return }
      if (lane === 'split') {
        yield* text(fixed.splitTasks ? '{"split":true,"tasks":["Search for fictional tool one pricing.","Search for fictional tool two pricing."]}' : '{"split":false}')
        return
      }
      yield* text('Fictional title')
    },
    createSession() {
      return { send() { calls.main++; return (async function* () { yield* text(reply) })() } }
    },
  }
}

describe.sequential('[COMP:api/turn-kernel] turn routing through the real routes', () => {
  afterAll(async () => {
    await writeFile(process.env.BRIAN_TURN_ROUTING_OUTPUT ?? join(tmpdir(), 'brian-turn-routing.json'), JSON.stringify({
      node: process.version, provider: 'deterministic classifier answers, zero network latency',
      measurement: 'Classifier calls counted at the provider boundary by system prompt; web turnTiming counters from the turn-end log line.',
      results,
    }, null, 2))
    await getAppPool().end(); await getPool().end()
  })

  it.each(FIXED)('$turn', async (fixed) => {
    const f = await persistentContextFixture('confidential')
    try {
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const calls = { research: 0, topic: 0, split: 0, other: 0, main: 0 }
      const llm = provider(fixed, calls)
      const turnTimings: Record<string, number> = {}
      let status = 0, body = ''
      if (fixed.surface === 'web') {
        const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional routing browser', userAgent: null, ipAddress: null }))!
        const session = await createPersonalWebSession({
          assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
        }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
        const earlier = await addSessionMessage({ sessionId: session.id, role: 'user', content: [{ type: 'text', text: 'Earlier fictional question about tools.' }],
          senderUserId: f.ownerId, scope: { ...f.envelope, userId: f.ownerId } })
        const app = express(); app.use(express.json()); app.use((req, _res, next) => {
          req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
        })
        app.use('/chat', chatRoutes({ provider: llm, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
          memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
        const originalLog = console.log.bind(console)
        const timingSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
          for (const value of values) if (typeof value === 'string' && value.startsWith(`[chat] turn timings session ${session.id} `)) {
            for (const match of value.matchAll(/\b([a-z_]+)=(\d+(?:\.\d+)?)/g)) turnTimings[match[1]!] = Number(match[2])
          } else originalLog(value)
        })
        try {
          const response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
            message: fixed.message, ...(fixed.reply ? { replyTo: { id: earlier.id, text: 'Earlier fictional question about tools.' } } : {}), ...fixed.body })
            .buffer(true).parse((res, done) => {
              let text = ''; res.on('data', (chunk: Buffer) => { text += chunk.toString() }); res.on('end', () => done(null, text)); res.on('error', done)
            })
          status = response.status; body = String(response.body)
        } finally { timingSpy.mockRestore() }
      } else {
        const assistant = await findAssistantById(f.assistantId)
        if (!assistant) throw new Error('Missing fixture assistant')
        const responses: string[] = [], errors: Error[] = []
        await processChannelMessage({ userId: f.ownerId, ownerId: f.ownerId, assistant, isIdentified: true, channelType: 'telegram', channelId: `1555${Date.now()}`,
          isGroupChat: false, senderUserId: f.ownerId, messageText: fixed.message, userContentBlocks: [{ type: 'text', text: fixed.message }],
          modelAlias: undefined, adaptiveResearchEnabled: true, abortController: new AbortController(), provider: llm,
          systemPrompt: 'Fictional local channel fixture', tools: new Map(), memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(),
          hooks: { async onConfirmationRequired() { throw new Error('Unexpected fixture confirmation') },
            async sendResponse(text) { responses.push(text) }, async sendError(error) { errors.push(error) } } })
        status = errors.length ? 500 : 200; body = responses.join(' ')
        if (errors.length) throw errors[0]
      }
      const timed = { research: turnTimings.research_classify_count ?? 0, topic: turnTimings.topic_classify_count ?? 0, split: turnTimings.split_classify_count ?? 0 }
      const modelCalls = LANES.reduce((n, lane) => n + calls[lane], 0)
      const metrics = { turn: fixed.turn, surface: fixed.surface, status, calls, modelCalls,
        expected: LANES.reduce((n, lane) => n + fixed.expected[lane], 0), ...(fixed.surface === 'web' ? { timed } : {}) }
      results.push(metrics)
      console.info('turn-routing', JSON.stringify(metrics))
      expect(status).toBe(200)
      expect(body).not.toContain('event: error')
      expect(calls.main).toBeGreaterThan(0)
      if (fixed.expectBody) expect(body).toContain(fixed.expectBody)
      expect({ research: calls.research, topic: calls.topic, split: calls.split }).toEqual(fixed.expected)
      // Runtime counters time each routed classifier invocation exactly once.
      if (fixed.surface === 'web') expect(timed).toEqual(fixed.expected)
    } finally { await f.cleanup() }
  }, 120_000)

  it('defers ambient indexes for a bare Pro greeting while the charter can retrieve Memory', async () => {
    await initializeConversationVisibility()
    const f = await persistentContextFixture('internal')
    try {
      const memoryStore = createDbMemoryStore()
      const createMemory = (summary: string) => memoryStore.create({ workspaceId: f.workspaceId, assistantId: f.assistantId,
        userId: f.ownerId, createdByUserId: f.ownerId, sensitivity: 'internal', summary, confidence: 0.9 })
      const requested = await createMemory('Fictional charter retrieval fact')
      const ambient = await createMemory('Fictional ambient index fact')
      const charter = `When I say hi, use getMemory with id ${requested.id} before replying.`
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      await f.pool.query('UPDATE assistants SET charter=$2::jsonb WHERE id=$1', [f.assistantId, JSON.stringify({ instructions: charter })])
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional greeting browser', userAgent: null, ipAddress: null }))!
      const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId,
        channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
      { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const earlier = await addSessionMessage({ sessionId: session.id, role: 'user',
        content: [{ type: 'text', text: 'Fictional retained conversation input.' }], senderUserId: f.ownerId,
        scope: { ...f.envelope, userId: f.ownerId } })
      const main: Array<{ system: string; messages: string; tools: string[] }> = []
      const llm = provider(FIXED[0]!, { research: 0, topic: 0, split: 0, other: 0, main: 0 })
      llm.createSession = options => ({ send(messages) {
        main.push({ system: `${options.systemPrompt}\n${options.runtimeSystemContext ?? ''}`, messages: JSON.stringify(messages),
          tools: (options.tools ?? []).map(tool => tool.name) })
        return (async function* () {
          yield { type: 'message_start', model: 'fixture' }
          if (main.length === 1) {
            yield { type: 'tool_use_start', id: 'fictional-memory-call', name: 'getMemory' }
            yield { type: 'tool_use_delta', id: 'fictional-memory-call', input: JSON.stringify({ id: requested.id }) }
            yield { type: 'tool_use_end', id: 'fictional-memory-call' }
            yield { type: 'message_end', stopReason: 'tool_use', usage }
          } else {
            yield { type: 'text_delta', text: 'Fictional greeting reply.' }
            yield { type: 'message_end', stopReason: 'end_turn', usage }
          }
        })()
      } })
      const app = express()
      app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider: llm, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
        memoryStore, capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      const post = async (body: object) => String((await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId,
        workspaceId: f.workspaceId, appOrigin: 'chat', model: 'pro', ...body }).buffer(true).parse((response, done) => {
        let text = ''; response.on('data', chunk => { text += String(chunk) }); response.on('end', () => done(null, text)); response.on('error', done)
      }).expect(200)).body)
      const directFloor = async () => (await f.pool.query<{ source_kind: string; source_id: string; type_key: string | null; field_resource_id: string | null; selection: string | null }>(`
        SELECT ds.source_kind,ds.source_id,f.type_key,f.resource_id AS field_resource_id,f.selection
        FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id
         AND d.resource_kind='session_context_revision' AND d.resource_id=r.id
        JOIN scope_derivation_sources ds ON ds.workspace_id=d.workspace_id AND ds.derivation_id=d.id
        LEFT JOIN application_field_resources f ON f.workspace_id=d.workspace_id AND ds.source_kind='application_field' AND f.id=ds.source_id
        WHERE r.workspace_id=$1 AND r.session_id=$2 AND d.producer='turn:web'`, [f.workspaceId, session.id])).rows
      const greeting = await post({ message: 'hi' })
      expect(greeting).not.toContain('event: error')
      expect(greeting).toContain('Fictional greeting reply.')
      expect(main[0]?.system).toContain(charter)
      expect(main[0]?.system).toContain('Use getMemory to read a known memory ID')
      expect(main[0]?.tools).toContain('getMemory')
      expect(main[0]?.messages).toContain('Fictional retained conversation input.')
      expect(main[0]?.system).not.toContain(ambient.summary)
      expect(main[1]?.messages).toContain(requested.summary)
      const greetingFloor = await directFloor()
      expect(greetingFloor.some(row => row.source_kind === 'conversation_record')).toBe(true)
      expect(greetingFloor.some(row => row.type_key === 'memory' && row.selection === 'query_domain')).toBe(false)
      expect(greetingFloor.some(row => row.source_kind === 'memory' && row.source_id === requested.id
        || row.type_key === 'memory' && row.field_resource_id === requested.id)).toBe(true)

      expect(await post({ message: 'hi', replyTo: { id: earlier.id } })).not.toContain('event: error')
      expect(main.at(-1)?.system).toContain(ambient.summary)
      expect((await directFloor()).some(row => row.type_key === 'memory' && row.selection === 'query_domain')).toBe(true)
    } finally { await f.cleanup() }
  })

  it('blocks authored input on the current question, then accepts one replacement on retry', async () => {
    await initializeConversationVisibility()
    const f = await persistentContextFixture('internal')
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional question browser', userAgent: null, ipAddress: null }))!
      const channelId = randomUUID()
      const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId,
        workspaceId: f.workspaceId, channelType: 'web', channelId, appOrigin: 'chat' },
      { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const approvals = createPendingApprovalsStore()
      const question = await approvals.createQuestion({ workspaceId: f.workspaceId, blockingSessionId: session.id,
        originatingAssistantId: f.assistantId, approverUserId: f.ownerId, deliveryChannelType: 'web',
        question: 'Which fictional color?', toolUseId: 'fixture-blocks-input' })
      const calls = { research: 0, topic: 0, split: 0, other: 0, main: 0 }
      const app = express()
      app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider: provider(FIXED[0]!, calls), systemPrompt: 'Continue the fictional conversation.',
        tools: new Map(), memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: approvals }))
      const send = async (message: string, replay?: string) => String((await request(app).post('/chat').send({
        sessionId: replay ? session.id : channelId, assistantId: f.assistantId, workspaceId: f.workspaceId,
        appOrigin: 'chat', model: 'standard', message, ...(replay ? { truncateFromMessageId: replay } : {}),
      }).buffer(true).parse((response, done) => {
        let body = ''; response.on('data', chunk => { body += String(chunk) }); response.on('end', () => done(null, body)); response.on('error', done)
      }).expect(200)).body)
      const history = async () => (await f.pool.query(`SELECT id,role,content FROM session_messages
        WHERE session_id=$1 ORDER BY sequence_num`, [session.id])).rows
      const blocked = await send('This fictional input must remain unsaved.')
      expect(blocked).toContain('pending_question_exists')
      expect(blocked).toContain(question.id)
      expect(blocked).toContain(question.approvalPayload.question)
      expect(await history()).toEqual([])
      expect(calls.main).toBe(0)
      expect((await approvals.recordAnswer(question.id, 'Blue', f.ownerId))?.status).toBe('approved')
      const firstReply = await send('thanks')
      expect(firstReply).toContain('Fictional routed reply.')
      expect(firstReply).toContain('event: assistant_message_saved')
      const original = (await history()).find(row => row.role === 'user')
      expect(original?.content).toEqual([{ type: 'text', text: 'thanks' }])
      const retried = await send('thank you', original!.id)
      expect(retried).not.toContain('event: error')
      expect(retried).toContain('Fictional routed reply.')
      expect(retried).toContain('event: assistant_message_saved')
      const final = await history()
      expect(final.filter(row => row.role === 'user')).toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'thank you' }] })])
      expect(final.filter(row => row.role === 'assistant')).toEqual([
        expect.objectContaining({ content: [{ type: 'text', text: 'Fictional routed reply.' }] }),
      ])
      expect(final.some(row => row.id === original!.id)).toBe(false)
      const reopened = await readAttendedSessionHistory(await resolveSessionTitleAuthority({
        claims: { userId: f.ownerId, sessionId: device.id, authVersion: device.authVersion },
        sessionId: session.id, readOnly: true,
      }), session.id)
      expect(reopened.messages.map(row => ({ role: row.role, content: row.content }))).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'thank you' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Fictional routed reply.' }] },
      ])
      expect(calls.main).toBe(2)
    } finally { await f.cleanup() }
  }, 120_000)
})
