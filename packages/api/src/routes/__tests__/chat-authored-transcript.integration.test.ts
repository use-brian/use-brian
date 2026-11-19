/**
 * What a web turn stores and shows, at the real boundary (M5 browser
 * qualification, second pass): real `chatRoutes`, `sessionRoutes` and
 * `sessionQuestionRoutes` on a disposable ordinary-owner database.
 *
 * M5Q-13: a suspended askQuestion round is stored with its question text and
 * full question payload, and the live frames, the `/pending` read and the
 * history read all carry the same question and options.
 * Spec: docs/architecture/features/chat-app.md "Durable personal conversation display";
 * docs/architecture/engine/askquestion-suspend-resume.md "Question payload contract".
 *
 * M5Q-15: an attachment-only or voice-note message is stored and shown as what
 * the user sent; the "attached files without instructions" guard reaches the
 * model only as trusted runtime context, and a voice transcript counts as the
 * instruction. Spec: docs/architecture/features/doc.md "File attachments in chat".
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, Message, SessionOptions, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { askQuestionTool } from '@use-brian/agent-runtime/tools/base/ask-question.js'

// The transcription backend is a network call; the route's handling of its result is under test.
vi.mock('@use-brian/core/media/preflight.js', async (original) => ({
  ...(await original<typeof import('@use-brian/core/media/preflight.js')>()),
  transcribeFirstAudio: vi.fn(async () => ({ text: 'Please summarise the fictional plan.', durationMs: 4000, model: 'fixture' })),
}))

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../chat.js')
const { sessionRoutes } = await import('../sessions.js')
const { sessionQuestionRoutes } = await import('../sessions-questions.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession } = await import('../../db/sessions.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createDbFileStore } = await import('../../db/file-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { createDbSessionResumeStore } = await import('../../db/session-resume-store.js')
const { createDbJobStore } = await import('../../db/job-store.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

afterAll(async () => { await getAppPool().end(); await getPool().end() })

const usage = { inputTokens: 3, outputTokens: 3 }
const QUESTION = 'Which colour should the fictional check use?'
const OPTIONS = ['Blue', 'Green']
const GUARD = 'without instructions'

type Calls = Array<{ messages: Message[]; runtime: string }>
function provider(chunks: (call: number) => StreamChunk[], calls: Calls): LLMProvider {
  return { name: 'fictional-transcript', models: ['fixture'], stream() { throw new Error('unexpected') },
    createSession(options: SessionOptions) { return { send(messages: Message[]) {
      calls.push({ messages: structuredClone(messages), runtime: options.runtimeSystemContext ?? '' })
      const turn = chunks(calls.length - 1)
      return (async function* () { yield* turn })()
    } } } }
}
const text = (value: string): StreamChunk[] => [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: value },
  { type: 'message_end', stopReason: 'end_turn', usage }]
const frames = (body: string, event: string) => body.split('\n\n').filter(block => block.includes(`event: ${event}\n`))
  .map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>)

async function harness(chunks: (call: number) => StreamChunk[]) {
  const f = await persistentContextFixture('confidential')
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
  const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional browser', userAgent: null, ipAddress: null }))!
  const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId,
    channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
    { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
  const calls: Calls = []
  const approvalsStore = createPendingApprovalsStore(), sessionResumeStore = createDbSessionResumeStore(), fileStore = createDbFileStore()
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
  })
  app.use('/chat', chatRoutes({ provider: provider(chunks, calls), systemPrompt: 'Fictional fixture.',
    tools: new Map([[askQuestionTool.name, askQuestionTool]]), memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(),
    pendingApprovalsStore: approvalsStore, sessionResumeStore, fileStore,
    voiceTranscription: { enabled: true, apiKey: 'fictional-unused' } }))
  app.use('/sessions', sessionQuestionRoutes({ approvalsStore,
    resumeDeps: { approvalsStore, sessionResumeStore, jobStore: createDbJobStore(), tryResolveLive: () => false } as never }))
  app.use('/sessions', sessionRoutes())
  const send = async (body: object) => {
    let raw = ''
    await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
      mode: 'default', model: 'pro', ...body }).buffer(true).parse((res, done) => {
      res.on('data', (chunk: Buffer) => { raw += chunk.toString() }); res.on('end', () => done(null, raw)); res.on('error', done)
    })
    return raw
  }
  const stored = async () => (await f.pool.query<{ role: string; content: unknown }>(
    'SELECT role, content FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [session.id])).rows
  return { f, app, session, calls, send, stored, fileStore }
}

describe.sequential('[COMP:api/session-display-history] a suspended question survives publication and reload (M5Q-13)', () => {
  it('stores the question round with its text and payload; live frames, /pending and history agree', async () => {
    const h = await harness(() => [{ type: 'message_start', model: 'fixture' },
      { type: 'tool_use_start', id: 'call_fictional_ask', name: 'askQuestion' },
      { type: 'tool_use_delta', id: 'call_fictional_ask', input: JSON.stringify({ question: QUESTION, options: OPTIONS }) },
      { type: 'tool_use_end', id: 'call_fictional_ask' }, { type: 'message_end', stopReason: 'tool_use', usage }])
    try {
      const raw = await h.send({ message: 'Run the fictional colour check.' })
      // Live: the question streams as text and the confirmation frame carries the payload.
      expect(frames(raw, 'text_delta').map(frame => frame.text).join('')).toContain(QUESTION)
      const confirmation = frames(raw, 'tool_confirmation_required').find(frame => frame.toolName === 'askQuestion')
      expect(confirmation?.input).toEqual({ question: QUESTION, options: OPTIONS })

      // Stored: the suspended round keeps its text block and the full tool input.
      const rows = await h.stored()
      const round = rows.find(row => row.role === 'assistant')!.content as Array<Record<string, unknown>>
      expect(round).toEqual(expect.arrayContaining([{ type: 'text', text: QUESTION },
        expect.objectContaining({ type: 'tool_use', id: 'call_fictional_ask', name: 'askQuestion', input: { question: QUESTION, options: OPTIONS } })]))

      // /pending read.
      const pending = (await request(h.app).get(`/sessions/${h.session.id}/pending`).expect(200)).body.pending
      expect(pending).toMatchObject({ question: QUESTION, options: OPTIONS })

      // History read (the private presentation the page reloads after `done`).
      const history = (await request(h.app).get(`/sessions/${h.session.id}/messages`).expect(200)).body as Array<{ role: string; content: Array<Record<string, unknown>> }>
      const shown = history.find(row => row.role === 'assistant')!.content
      expect(shown.filter(block => block.type === 'text').map(block => block.text)).toEqual([QUESTION])
      expect(shown.find(block => block.type === 'tool_use')).toMatchObject({ name: 'askQuestion', input: { question: QUESTION, options: OPTIONS } })
    } finally { await h.f.cleanup() }
  })
})

describe.sequential('[COMP:api/chat-route] attachment-only input is stored as sent (M5Q-15)', () => {
  it('keeps the file-intent guard out of the stored and displayed row and gives it to the model as runtime context', async () => {
    const h = await harness(() => text('What would you like me to do with the fictional notes?'))
    try {
      const file = await h.fileStore.cache({ sessionId: h.session.id, workspaceId: h.f.workspaceId, userId: h.f.ownerId,
        fileName: 'notes.txt', mimeType: 'text/plain', content: 'Fictional notes body.', sizeBytes: 21 })
      await h.send({ message: '', fileIds: [file.id] })
      const user = (await h.stored()).find(row => row.role === 'user')!
      expect(JSON.stringify(user.content)).toContain('<attached_file')
      expect(JSON.stringify(user.content)).not.toContain(GUARD)
      const history = (await request(h.app).get(`/sessions/${h.session.id}/messages`).expect(200)).body as Array<{ role: string; content: unknown }>
      expect(JSON.stringify(history.find(row => row.role === 'user')!.content)).not.toContain(GUARD)
      // The model still receives the guard, as trusted runtime context only.
      expect(h.calls[0]!.runtime).toContain(GUARD)
      expect(JSON.stringify(h.calls[0]!.messages)).not.toContain(GUARD)
    } finally { await h.f.cleanup() }
  })

  it('stores a voice note as its transcript and treats the transcript as the instruction', async () => {
    const h = await harness(() => text('Here is the fictional summary.'))
    try {
      const audio = `data:audio/webm;base64,${Buffer.from('fictional audio').toString('base64')}`
      const file = await h.fileStore.cache({ sessionId: h.session.id, workspaceId: h.f.workspaceId, userId: h.f.ownerId,
        fileName: 'voice-note.webm', mimeType: 'audio/webm', content: audio, sizeBytes: 15 })
      await h.send({ message: '', fileIds: [file.id] })
      const user = (await h.stored()).find(row => row.role === 'user')!
      const words = (user.content as Array<{ type: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text).join('')
      expect(words.trim()).toBe('[voice] Please summarise the fictional plan.')
      const history = (await request(h.app).get(`/sessions/${h.session.id}/messages`).expect(200)).body as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
      expect(history.find(row => row.role === 'user')!.content.map(block => block.text).join('').trim()).toBe('[voice] Please summarise the fictional plan.')
      expect(h.calls[0]!.runtime).not.toContain(GUARD)
      expect(JSON.stringify(h.calls[0]!.messages)).not.toContain(GUARD)
    } finally { await h.f.cleanup() }
  })
})
