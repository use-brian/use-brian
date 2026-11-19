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
import { boundScopeSource } from '@use-brian/agent-runtime/security/source-evidence.js'
import { pinAccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes, runSessionResume, tryResolveLiveToolApproval } = await import('../chat.js')
const { createSessionResumeReplay, RESUME_FAILED_TEXT } = await import('../session-resume-replay.js')
const { sessionQuestionRoutes } = await import('../sessions-questions.js')
const { sessionRoutes } = await import('../sessions.js')
const { createDbSessionResumeStore } = await import('../../db/session-resume-store.js')
const { createDbJobStore } = await import('../../db/job-store.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { addSessionMessage, createPersonalWebSession, createWorkspaceChatSession, getSessionMessages, readSessionById } = await import('../../db/sessions.js')
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
  it.each([
    ['personal', false], ['shared-room', false], ['shared-room-revoked', false],
    ['shared-room-held', false], ['shared-room-hold-during-provider', false],
    ['shared-room-approval-withdrawn', false], ['shared-room-wrong-assistant', false], ['shared-room-cross-room', false], ['personal', true],
  ] as const)('resumes a %s web chat after the answer (provider failure: %s)', async (scenario, providerFails) => {
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
      const approvalsStore = createPendingApprovalsStore()
      const sessionResumeStore = createDbSessionResumeStore()
      const jobStore = createDbJobStore()
      app.use('/sessions', sessionQuestionRoutes({ approvalsStore,
        resumeDeps: { approvalsStore, sessionResumeStore, jobStore, tryResolveLive: tryResolveLiveToolApproval } }))
      app.use('/sessions', sessionRoutes())
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
      const providerInputs: string[] = []
      const holdInput = async () => {
        const result = await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          SELECT m.workspace_id,'session_message',m.id,m.scope_version::text,'held',1,'Fictional room source review'
          FROM session_messages m WHERE m.session_id=$1 AND m.role='user' RETURNING resource_id`, [session.id])
        expect(result.rows).toHaveLength(1)
      }
      const resumed = providerFails ? { ...provider(''), createSession() { return { send() { return (async function* () {
        throw new Error('Fictional provider outage') })() } } } } as LLMProvider : provider('Blue it is, a calm fictional choice.')
      const observedProvider: LLMProvider = { ...resumed,
        createSession(options) {
          const modelSession = resumed.createSession!(options)
          return { ...modelSession, async *send(...args) {
            providerRequests++
            providerInputs.push(JSON.stringify(args[0]))
            if (scenario === 'shared-room-hold-during-provider') await holdInput()
            if (scenario === 'shared-room-approval-withdrawn') expect(await sessionResumeStore.deleteByApprovalId(approvalId)).toBe(true)
            yield* modelSession.send(...args)
          } }
        },
      }
      const replay = createSessionResumeReplay({ provider: observedProvider, tools: new Map(),
        capabilityStores: { connectorStore: createDbConnectorStore(null), settingsStore: createDbMcpSettingsStore(),
          assistantConnectorStore: createDbAssistantConnectorStore() },
        systemPrompt: 'Fictional fixture.', resolveWorkspaceCustomLlm: null, resolveWorkspaceByoGeminiKey: null, buildWorkspaceProvider: null,
        publishSessionEvent: event => { events.push(structuredClone(event) as never) } })
      // The real suspension: the answered question and its resume point.
      const otherAssistant = scenario === 'shared-room-wrong-assistant' ? randomUUID() : undefined
      if (otherAssistant) {
        await f.pool.query(`INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance)
          VALUES($1,'Other fictional assistant',$2,$3,'standard','confidential')`, [otherAssistant, f.ownerId, f.workspaceId])
      }
      const question = await approvalsStore.createQuestion({ workspaceId: f.workspaceId, blockingSessionId: session.id,
        originatingAssistantId: otherAssistant ?? f.assistantId, approverUserId: f.ownerId, deliveryChannelType: 'web',
        question: 'Which colour?', options: ['Blue', 'Green'], toolUseId: 'fictional-room-resume-question' })
      const approvalId = question.id
      await sessionResumeStore.create({ sessionId: session.id, approvalId, suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which colour?', options: ['Blue', 'Green'] }, loopStepIndex: 1,
        workerRunIds: [], startingAccessCeiling: pinAccessCeiling(turnScope.access) })
      const answer = await request(app).post(`/sessions/${session.id}/answer/${approvalId}`).send({ answer: 'Blue' }).expect(200)
      expect(answer.body).toMatchObject({ status: 'approved', resume: { kind: 'enqueued' } })
      const job = await jobStore.get(answer.body.resume.jobId)
      const resumeParams = { sessionId: session.id, approvalId, suspendedToolName: 'askQuestion',
        suspendedToolInput: { question: 'Which colour?', options: ['Blue', 'Green'] }, loopStepIndex: 1,
        startingAccessCeiling: pinAccessCeiling(turnScope.access), approvalStatus: 'approved', rejectReason: null,
        answerText: 'Blue', approvalKind: 'question' } as const
      expect(job?.state?.resume).toEqual({ sessionId: session.id, approvalId })
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
      if (scenario === 'shared-room-held') await holdInput()
      if (scenario === 'shared-room-cross-room') {
        const other = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.ownerId,
          workspaceId: f.workspaceId, effectiveClearance: 'confidential', authenticatedHuman: true })
        const origin = await addSessionMessage({ sessionId: other.id, role: 'user', senderUserId: f.ownerId, scope: f.envelope,
          content: [{ type: 'text', text: 'A fictional turn in another room.' }] })
        await request(app).get(`/sessions/${other.id}/messages`).expect(200)
        await addSessionMessage({ sessionId: session.id, role: 'system',
          derivation: { producer: 'fixture:other-room', sources: [boundScopeSource(origin)!] }, derivationTarget: f.envelope,
          content: [{ type: 'text', text: 'Fictional derived row from the other room.' }] })
      }
      const storedIds = async () => (await f.pool.query<{ id: string }>(
        'SELECT id FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [session.id])).rows.map(row => row.id)
      const withdrewDuringProvider = scenario === 'shared-room-hold-during-provider' || scenario === 'shared-room-approval-withdrawn'
      if (scenario === 'shared-room-held' || scenario === 'shared-room-cross-room' || scenario === 'shared-room-wrong-assistant' || withdrewDuringProvider) {
        const before = await storedIds()
        await expect(replay(resumeParams)).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(providerRequests).toBe(withdrewDuringProvider ? 1 : 0)
        expect(events.filter(event => event.kind === 'turn_stream')).toEqual([])
        expect(await storedIds()).toEqual(before)
        expect(await committedTurnCompletion({ workspaceId: f.workspaceId, sessionId: session.id,
          input: { kind: 'approval', ref: approvalId } })).toBeNull()
        return
      }
      const outcome = scenario === 'shared-room'
        ? runSessionResume({ sessionResumeStore, pendingApprovalsStore: approvalsStore, replay }, job!.state!.resume!)
        : replay(resumeParams)
      if (providerFails) {
        // The job is terminal: the conversation records that no reply follows, and it reopens.
        await expect(outcome).rejects.toThrow('Fictional provider outage')
        const rows = await getSessionMessages(session.id, { excludeHeld: true })
        expect(rows.at(-1)).toMatchObject({ role: 'assistant', senderAssistantId: f.assistantId })
        expect(text(rows.at(-1)!)).toBe(RESUME_FAILED_TEXT)
        expect(events.at(-1)).toMatchObject({ kind: 'turn_completed', payload: { reason: 'failed' } })
        return
      }
      if (scenario === 'shared-room') await expect(outcome).resolves.toEqual({ status: 'completed' })
      else await expect(outcome).resolves.toBe('completed')
      expect(providerRequests).toBe(1)
      expect(providerInputs[0]).toContain('Help me pick a fictional colour.')
      expect(providerInputs[0]).toContain('The user answered: Blue')
      const rows = await getSessionMessages(session.id, { excludeHeld: true })
      expect(rows.map(text).at(-1)).toBe('Blue it is, a calm fictional choice.')
      expect(rows.at(-1)).toMatchObject({ sessionId: session.id, role: 'assistant', senderAssistantId: f.assistantId })
      if (scenario === 'shared-room') {
        const reopened = await request(app).get(`/sessions/${session.id}/messages`).expect(200)
        const reply = reopened.body.at(-1)
        expect(reply).toMatchObject({ role: 'assistant', senderAssistantId: f.assistantId })
        expect(text(reply)).toBe('Blue it is, a calm fictional choice.')
        const reader = express(); reader.use('/sessions', sessionRoutes())
        const peer = (await authSessionStore.create(f.secondId, { deviceLabel: 'Fictional second browser', userAgent: null, ipAddress: null }))!
        const peerApp = express(); peerApp.use((req, _res, next) => {
          req.userId = f.secondId; req.authSessionId = peer.id; req.authVersion = peer.authVersion; next()
        })
        peerApp.use(reader)
        const shared = await request(peerApp).get(`/sessions/${session.id}/messages`).expect(200)
        expect(shared.body.at(-1)).toMatchObject({ id: reply.id, senderAssistantId: f.assistantId })
        const lineage = await f.pool.query<{ conversation_record: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM application_scope_lineage($1,ARRAY['session_message'],ARRAY[$2::uuid],ARRAY['1'])
          WHERE kind='conversation_record') AS conversation_record`, [f.workspaceId, rows.at(-1)!.id])
        expect(lineage.rows[0]?.conversation_record).toBe(true)
      }
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
