/**
 * [COMP:brain/session-resume-worker] Durable question resume at the real
 * boundary (M5Q-6): a web chat turn runs through `chatRoutes`, its human answers
 * a suspended question, and the resume worker continues on the disposable
 * ordinary-owner database with the production kernel, source admission and
 * publication. The resumed reply must be admitted, published and reopenable;
 * a resume that cannot continue must leave a user-visible outcome.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { pinAccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../chat.js')
const { createSessionResumeReplay, RESUME_FAILED_TEXT } = await import('../session-resume-replay.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession, getSessionMessages, readSessionById } = await import('../../db/sessions.js')
const { findAssistantById } = await import('../../db/users.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { resolveExecutionContextSystem } = await import('../../context-scope/execution-context.js')
const { createDbConnectorStore } = await import('../../db/connector-store.js')
const { createDbMcpSettingsStore } = await import('../../db/mcp-settings-store.js')
const { createDbAssistantConnectorStore } = await import('../../db/assistant-connector-store.js')
const { committedTurnCompletion } = await import('../../db/conversation-publication-recovery.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

afterAll(async () => { await getAppPool().end(); await getPool().end() })

function provider(text: string): LLMProvider {
  const chunks: StreamChunk[] = [{ type: 'message_start', model: 'fixture' },
    ...text.split(' ').map((word, i) => ({ type: 'text_delta' as const, text: (i ? ' ' : '') + word })),
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } }]
  return { name: 'fictional-resume', models: ['fixture'], stream: async function* () { yield* chunks },
    createSession() { return { send() { return (async function* () { yield* chunks })() } } } }
}
const text = (row: { content: unknown }) => (row.content as Array<{ type: string; text?: string }>)
  .filter(block => block.type === 'text').map(block => block.text).join('')

describe.sequential('[COMP:brain/session-resume-worker] question resume on the canonical owner', () => {
  it.each([['personal', false], ['shared-room', false], ['shared-room-revoked', false], ['personal', true]] as const)('resumes a %s web chat after the answer (provider failure: %s)', async (scenario, providerFails) => {
    const f = await persistentContextFixture('confidential')
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional resume browser', userAgent: null, ipAddress: null }))!
      const session = scenario !== 'personal' ? f.session : await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      // The suspended turn: a real native web turn leaves the transcript the resume reads.
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider: provider('Which colour do you prefer, blue or green?'), systemPrompt: 'Fictional fixture.',
        tools: new Map(), memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      const first = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
        message: 'Help me pick a fictional colour.', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
        let body = ''; res.on('data', (chunk: Buffer) => { body += chunk.toString() }); res.on('end', () => done(null, body)) })
      expect(first.status).toBe(200); expect(String(first.body)).not.toContain('event: error')
      // The saved starting ceiling, exactly as the web turn pins it at suspension.
      const stored = (await readSessionById(session.id))!
      const { turnScope } = await resolveExecutionContextSystem({ userId: f.ownerId, workspaceId: f.workspaceId,
        assistant: (await findAssistantById(f.assistantId))!, session: stored, sessionAuthority: stored,
        sharedAudience: scenario !== 'personal', memberMode: 'member',
        identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: f.ownerId, authenticationKind: 'native_session' } },
        ownership: { kind: 'workspace', workspaceId: f.workspaceId },
        lifecycle: { sessionId: session.id, channelType: 'web', channelId: stored.channelId, abortSignal: new AbortController().signal } })
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      // Production parity: the composition root passes connector stores, so the
      // owner prepares the `resume` capability profile for the suspended tool.
      let providerRequests = 0
      const resumed = providerFails ? { ...provider(''), createSession() { return { send() { return (async function* () {
        throw new Error('Fictional provider outage') })() } } } } as LLMProvider : provider('Blue it is, a calm fictional choice.')
      const observedProvider: LLMProvider = { ...resumed,
        createSession(options) {
          const modelSession = resumed.createSession!(options)
          return { ...modelSession, send(...args) { providerRequests++; return modelSession.send(...args) } }
        },
      }
      const replay = createSessionResumeReplay({ provider: observedProvider, tools: new Map(),
        capabilityStores: { connectorStore: createDbConnectorStore(null), settingsStore: createDbMcpSettingsStore(),
          assistantConnectorStore: createDbAssistantConnectorStore() },
        systemPrompt: 'Fictional fixture.', resolveWorkspaceCustomLlm: null, resolveWorkspaceByoGeminiKey: null, buildWorkspaceProvider: null,
        publishSessionEvent: event => { events.push(structuredClone(event) as never) } })
      // The real suspension: the answered question and its resume point.
      const approvalId = randomUUID()
      await f.pool.query("INSERT INTO pending_approvals(id,workspace_id,approver_user_id,kind,status,blocking_session_id,tool_name) VALUES($1,$2,$3,'question','approved',$4,'askQuestion')",
        [approvalId, f.workspaceId, f.ownerId, session.id])
      await f.pool.query("INSERT INTO session_resume_points(session_id,approval_id,suspended_tool_name,suspended_tool_input,loop_step_index) VALUES($1,$2,'askQuestion','{}',1)",
        [session.id, approvalId])
      const resumeParams = { sessionId: session.id, approvalId, suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which colour?', options: ['Blue', 'Green'] }, loopStepIndex: 1,
        startingAccessCeiling: pinAccessCeiling(turnScope.access), approvalStatus: 'approved', rejectReason: null,
        answerText: 'Blue', approvalKind: 'question' } as const
      if (scenario === 'shared-room-revoked') {
        const before = await getSessionMessages(session.id, { excludeHeld: true })
        await f.pool.query("UPDATE assistants SET clearance='internal' WHERE id=$1", [f.assistantId])
        await expect(replay(resumeParams)).rejects.toMatchObject({ code: 'session_resume_authority_unavailable' })
        expect(providerRequests).toBe(0)
        expect((await getSessionMessages(session.id, { excludeHeld: true })).map(row => row.id)).toEqual(before.map(row => row.id))
        expect(await committedTurnCompletion({ workspaceId: f.workspaceId, sessionId: session.id,
          input: { kind: 'approval', ref: approvalId } })).toBeNull()
        return
      }
      const outcome = replay(resumeParams)
      if (providerFails) {
        // The job is terminal: the conversation records that no reply follows, and it reopens.
        await expect(outcome).rejects.toThrow('Fictional provider outage')
        const rows = await getSessionMessages(session.id, { excludeHeld: true })
        expect(rows.at(-1)).toMatchObject({ role: 'assistant', senderAssistantId: f.assistantId })
        expect(text(rows.at(-1)!)).toBe(RESUME_FAILED_TEXT)
        expect(events.at(-1)).toMatchObject({ kind: 'turn_completed', payload: { reason: 'failed' } })
        return
      }
      await expect(outcome).resolves.toBe('completed')
      expect(providerRequests).toBe(1)
      const rows = await getSessionMessages(session.id, { excludeHeld: true })
      expect(rows.map(text).at(-1)).toBe('Blue it is, a calm fictional choice.')
      expect(events.map(event => event.kind)).toContain('turn_started')
      expect(events.at(-1)).toMatchObject({ kind: 'turn_completed' })
      expect(events.at(-1)?.payload.reason).toBeUndefined()
      // The reply's completion header committed with it (8277), bound to the approval.
      const committed = await committedTurnCompletion({ workspaceId: f.workspaceId, sessionId: session.id, input: { kind: 'approval', ref: approvalId } })
      expect(committed).toMatchObject({ lane: 'resume', publishedReply: true, input: { kind: 'approval', ref: approvalId } })
      // Restart after a lost acknowledgement or a lost resume-point delete (m2-completion step 3):
      // the replayed job finds the committed continuation and writes nothing.
      const before = (await getSessionMessages(session.id, { excludeHeld: true })).length
      await expect(replay(resumeParams)).resolves.toBe('completed')
      expect(providerRequests).toBe(1)
      expect((await getSessionMessages(session.id, { excludeHeld: true })).length).toBe(before)
    } finally { await f.cleanup() }
  }, 120_000)
})
