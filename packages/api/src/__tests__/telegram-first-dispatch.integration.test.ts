/** [COMP:api/channel-recording] A signed Telegram webhook with 300 retained
 * messages. Only the Telegram transport and the model's answers are fictional. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configureTelegramTextDeliveryObserver } from '@use-brian/channels'
import { createGeminiProvider } from '@use-brian/agent-runtime/providers/gemini.js'
import { createRoutingProvider } from '@use-brian/agent-runtime/providers/routing.js'
import { wrapProvider } from '@use-brian/agent-runtime/providers/wrappers.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { bindScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { persistentContextFixture } from '../application-platform/__tests__/fixtures/persistent-context.js'
import { admitTelegramRecording, changeChannelRecording, confirmChannelRecordingOwner, recordDeliveredTelegramMessage } from '../channel-recording.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { createDbChannelIntegrationStore, encryptCredentials } from '../db/channel-integrations.js'
import { createDbChannelUserStore } from '../db/channel-user-store.js'
import { getAppPool, getPool } from '../db/client.js'
import { initializeConversationVisibility } from '../db/conversation-visibility.js'
import { createDbLinkedAccountStore } from '../db/linked-accounts.js'
import { createDbMemoryStore } from '../db/memory-store.js'
import { writeSessionMessageAnnotation } from '../db/session-message-annotations.js'
import { readSessionMessageScopeSource } from '../db/sessions.js'
import { createDecisionRuntime } from '../decision-runtime.js'
import { telegramByoRoutes } from '../routes/telegram-byo.js'
import { channelQuestions } from '../routes/channel-questions.js'
import { standardGemini } from './fixtures/standard-gemini.js'

const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
const chat = -1000000300
const topic = 27
const conversationId = `${chat}:topic:${topic}`
const botId = '987650300'
const token = botId + ':fictional-dispatch-bot'
const sender = 9100000300
const otherMember = 9100000301
const unlinkedSender = 9100000302
const question = 'Which instrument did we agree to use during the final calibration?'
const historicalAnswer = 'the violet spectrometer'
const reply = 'We agreed to use ' + historicalAnswer + '.'
const privateMarker = 'PERSONAL_DISPATCH_FIXTURE'
const rows = 300

async function seedConversation() {
  await initializeConversationVisibility()
  const fixture = await persistentContextFixture()
  const { pool, workspaceId, ownerId, secondId, assistantId } = fixture
  const integrationId = randomUUID(), channelId = randomUUID(), key = randomBytes(32)
  const linkedAccountStore = createDbLinkedAccountStore()
  await linkedAccountStore.upsert({ userId: ownerId, assistantId, provider: 'telegram', providerId: String(sender) })
  await linkedAccountStore.upsert({ userId: secondId, assistantId, provider: 'telegram', providerId: String(otherMember) })
  await pool.query("UPDATE workspaces SET department_read_v2=true,plan='pro' WHERE id=$1", [workspaceId])
  await pool.query("INSERT INTO channels(id,workspace_id,channel_type,enabled_capabilities,display_name) VALUES($1,$2,'telegram','{chat}','Fictional dispatch bot')", [channelId, workspaceId])
  await pool.query("INSERT INTO channel_assistants(channel_id,assistant_id,model_alias) VALUES($1,$2,'standard')", [channelId, assistantId])
  const config = {
    requireMentionOverrides: [{ chatId: String(chat), topicId: topic }], deliveryAudienceBindings: [{
      version: 1, channelId: String(chat), audienceType: 'group', clearance: 'confidential', companyWide: true,
      compartments: [], projectIds: [], recipientUserId: null, approvedByUserId: ownerId, approvedAt: new Date().toISOString(), expiresAt: null,
    }]
  }
  await pool.query(`INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,bot_username,config)
    VALUES($1,$2,'telegram',$3,$4,'fictional_dispatch_bot',$5)`,
    [integrationId, channelId, encryptCredentials({ bot_token: token, webhook_secret: 'fictional-hook' }, key), botId, config])
  await confirmChannelRecordingOwner(integrationId, ownerId)
  const incoming = { integrationId, conversationId, assistantId, senderUserId: ownerId }
  const first = await admitTelegramRecording({ ...incoming, providerMessageId: '1', text: privateMarker })
  if (!first) throw new Error('Missing initial recording')
  await changeChannelRecording({
    integrationId, actorId: ownerId, id: first.policy.id, revision: first.policy.revision,
    enabled: true, destination: 'workspace', projectId: null
  })
  let sessionId = ''
  for (let n = 1; n <= rows; n++) {
    const providerMessageId = String(n + 1000)
    const text = n === rows - 1 ? 'For final calibration we agreed to use ' + historicalAnswer + '.'
      : `Fictional observatory log entry ${n}. The crew followed the scheduled calibration procedure, inspected the sampling tray, recorded the temperature and exposure interval, and compared this reading with the observations from the previous shift.`
    if (n % 2 === 0) {
      await recordDeliveredTelegramMessage({ channelId: conversationId, providerMessageId, text, botId })
      continue
    }
    const recorded = await admitTelegramRecording({ ...incoming, providerMessageId, text })
    if (!recorded || recorded.session.visibility !== 'workspace') throw new Error('Missing shared recording')
    sessionId = recorded.session.id
    // A genuine actor-authorized topic annotation for every fourth human message.
    // Its synthetic classifier used that one authored field as its evidence.
    if (n % 8 === 7) {
      const { rows: [message] } = await pool.query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2', [sessionId, providerMessageId])
      const source = await readSessionMessageScopeSource(workspaceId, message.id)
      if (!source) throw new Error('Missing authored evidence')
      const execution = await fixture.execution(ownerId, recorded.session, {
        kind: 'attended', principal: { kind: 'workspace_member', userId: ownerId, authenticationKind: 'verified_channel' },
      })
      const authority = { execution, accumulator: new ContextScopeAccumulator({ sources: [source] }) }
      const classification = bindScopeSources({ topic_label: 'Calibration', state: 'continue' as const, confidence: 1 }, [source])
      await writeSessionMessageAnnotation({ sessionId, messageId: message.id, classification, replyToText: null, authority })
    }
  }
  const stats = (await pool.query(`SELECT count(*)::int messages, sum(octet_length(content::text))::int bytes,
    (SELECT count(*)::int FROM session_context_scope_revisions WHERE session_id=$1 AND parent_kind='message_annotation') revisions
    FROM session_messages WHERE session_id=$1`, [sessionId])).rows[0]
  expect(stats.messages).toBe(rows)
  expect(stats.revisions).toBe(37)
  console.info('[Telegram benchmark history]', stats)
  return { pool, workspaceId, sessionId, channelId, integrationId, config, ownerId, secondId, assistantId,
    linkedAccountStore, integrationStore: createDbChannelIntegrationStore(key), stats }
}

type ModelRequest = {
  systemInstruction?: unknown
  contents?: Array<{
    role: string, parts: Array<{
      text?: string
      functionCall?: { name: string, id: string }
      functionResponse?: { name: string, id: string }
    }>
  }>
  tools?: unknown[]
  generationConfig?: { responseMimeType?: string, responseJsonSchema?: { properties?: { answers?: { properties?: Record<string, { properties: { value: { enum?: string[] } } }> } } } }
}

describe.runIf(process.env.BRIAN_TELEGRAM_DISPATCH_BENCHMARK === '1')('[COMP:api/channel-recording] Telegram first model dispatch', () => {
  let recording: Awaited<ReturnType<typeof seedConversation>>
  beforeAll(async () => {
    await assertLocalFixture()
    recording = await seedConversation()
  }, 180_000)
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  it.each([
    { title: 'receives the main request within ten seconds and delivers the retained answer', phase: 'ordinary', incomingId: 2000 },
    { title: 'withholds the physical request when the current Telegram input is held after admission', phase: 'headers', incomingId: 2001 },
    { title: 'withholds the answer when the current Telegram input is held after model dispatch', phase: 'response', incomingId: 2002 },
    { title: 'resolves an unquoted numeric question choice through authenticated context discovery', phase: 'choice', incomingId: 2003 },
    { title: 'withholds the answer after the recorded sender loses workspace membership', phase: 'member', incomingId: 2004 },
    { title: 'withholds the answer after the audience binding moves to another group', phase: 'audience', incomingId: 2005 },
    { title: 'denies an unlinked sender on an owner-only bot', phase: 'unlinked', incomingId: 2006 },
  ] as const)('$title', async ({ phase, incomingId }) => {
    const { pool, workspaceId, sessionId, channelId, integrationId, config, ownerId, secondId, assistantId,
      linkedAccountStore, integrationStore, stats } = recording
    const hold = phase === 'headers' || phase === 'response' || phase === 'member' || phase === 'audience'
    const telegramSender = phase === 'member' ? otherMember : phase === 'unlinked' ? unlinkedSender : sender
    const choice = 'Use our earlier calibration decision'
    const authored = phase === 'choice' ? '1' : question
    const pendingQuestion = {
      integrationId: channelId, assistantId, userId: ownerId, incoming: {
        userId: String(sender), channelId: conversationId, text: 'Select the next step', isGroupChat: true, timestamp: Date.now(), raw: {},
      }
    }
    if (phase === 'choice') channelQuestions.create(pendingQuestion, [choice, 'Run a new calibration'])
    const heldAnswer = 'Protected fictional sensor result ' + incomingId
    let heldInputId: string | undefined
    let memberRevoked = false
    let configChanged = false
    async function changeConfig(next: typeof config | (typeof config & { userAccessMode: 'allowlist' })) {
      const changed = await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, next])
      expect(changed.rowCount).toBe(1)
      configChanged = true
    }
    async function holdPersistedInput() {
      const outcome = await pool.query<{ id: string }>(`UPDATE session_messages SET scope_held=true WHERE session_id=$1
        AND role='user' AND channel_message_id=$2 AND NOT scope_held RETURNING id`, [sessionId, String(incomingId)])
      expect(outcome.rowCount).toBe(1)
      heldInputId = outcome.rows[0].id
    }
    const app = express()
    let ingress = 0
    let deliveredMs: number | undefined
    // Collect on the disposable database only. The first request is timed before
    // sampling, and SQL observation is excluded from the statement counts.
    const sqlCounts = async () => {
      if (process.env.BRIAN_ASSURANCE_STATEMENT_STATS !== 'true') return undefined
      return (await pool.query<{ top: number, nested: number }>(`SELECT
        coalesce(sum(calls) FILTER (WHERE toplevel),0)::float8 AS top,
        coalesce(sum(calls) FILTER (WHERE NOT toplevel),0)::float8 AS nested
        FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND coalesce(query,'') NOT ILIKE '%pg_stat_statements%'`)).rows[0]
    }
    const before = await sqlCounts()
    app.use((req, _res, next) => {
      if (req.path.startsWith('/webhook/')) ingress = performance.now()
      next()
    })
    app.use(express.json({ limit: '8mb' }))
    const modelCalls: Array<{ body: ModelRequest, elapsedMs: number, sqlCalls?: { top: number, nested: number } }> = []
    const backgroundCalls: number[] = []
    app.post('/model/:model', async (req, res) => {
      const body = req.body as ModelRequest
      const elapsedMs = performance.now() - ingress
      const isMain = req.params.model === standardGemini.apiModelId && body.generationConfig?.responseMimeType !== 'application/json'
      let parts: unknown[]
      if (isMain) {
        const current = await sqlCounts()
        const sqlCalls = current && before ? { top: current.top - before.top, nested: current.nested - before.nested } : undefined
        modelCalls.push({ body, elapsedMs, sqlCalls })
        console.info('[Telegram main model HTTP ingress]', { round: modelCalls.length, elapsedMs: Math.round(elapsedMs) })
        if (hold) {
          if (phase === 'response' && !heldInputId) await holdPersistedInput()
          if (phase === 'member' && !memberRevoked) {
            const input = await pool.query<{sender_user_id: string}>(
              "SELECT sender_user_id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2 AND role='user'",
              [sessionId, String(incomingId)])
            expect(input.rows).toEqual([{ sender_user_id: secondId }])
            const revoked = await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, secondId])
            expect(revoked.rowCount).toBe(1)
            memberRevoked = true
          }
          if (phase === 'audience' && !configChanged) await changeConfig({
            ...config,
            deliveryAudienceBindings: config.deliveryAudienceBindings.map(binding => ({ ...binding, channelId: String(chat - 1) })),
          })
          parts = [{ text: heldAnswer }]
        } else if (modelCalls.length === 1 && JSON.stringify(body.tools ?? []).includes('requestConversationContext')) {
          parts = [{ functionCall: { name: 'requestConversationContext', args: {}, id: 'fixture-context' }, thoughtSignature: 'fixture-context-signature' }]
        } else {
          parts = [{ text: JSON.stringify(body.contents).includes(historicalAnswer) ? reply : 'I could not find the calibration decision.' }]
        }
      } else {
        backgroundCalls.push(elapsedMs)
        const properties = body.generationConfig?.responseJsonSchema?.properties?.answers?.properties
        const classification = properties ? {
          answers: Object.fromEntries(Object.entries(properties).map(([name, field]) => {
            const values = field.properties.value.enum ?? []
            return [name, { value: ['ordinary', 'continue', '__new_topic__', 'none'].find(value => values.includes(value)) ?? values[0] }]
          }))
        } : { topic_label: 'Calibration', state: 'continue', confidence: 1, research: false, operate_site: false, reason: null }
        parts = [{ text: JSON.stringify(classification) }]
      }
      res.type('text/event-stream').send('data: ' + JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 }
      }) + '\n\n')
    })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const provider = createRoutingProvider({
      gemini: wrapProvider(createGeminiProvider({
        kind: 'ai-studio',
        endpoint: model => origin + '/model/' + model, headers: async () => {
          // Gemini's actual HTTP retry callback rechecks input authority after credentials resolve.
          if (phase === 'headers' && !heldInputId) await holdPersistedInput()
          return { 'Content-Type': 'application/json' }
        }
      }))
    })
    app.use('/webhook/telegram', telegramByoRoutes({
      provider, configuredProviders: new Set(['gemini']),
      decisionRuntime: createDecisionRuntime({ llmProvider: provider, defaultLlmModel: standardGemini.alias }),
      systemPrompt: 'Answer the speaker using admitted evidence.', tools: new Map(), memoryStore: createDbMemoryStore(),
      capabilityStore: createDbCapabilityStore(), integrationStore, linkedAccountStore,
      channelUserStore: createDbChannelUserStore(), apiUrl: origin,
    }))
    const delivered: string[] = []
    let messageId = incomingId * 10
    let replyReceiptId: string | undefined
    const network = globalThis.fetch
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === origin) return network(input, init)
      if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith('/bot' + token + '/')) throw new Error('Unexpected benchmark network destination')
      if (url.pathname.endsWith('/sendMessage')) {
        const body = JSON.parse(String(init?.body))
        delivered.push(body.text)
        messageId++
        if (body.text === reply) {
          replyReceiptId = String(messageId)
          deliveredMs = performance.now() - ingress
        }
        return Response.json({ ok: true, result: { message_id: messageId, text: body.text } })
      }
      return Response.json({ ok: true, result: true })
    })
    const linkRead = vi.spyOn(linkedAccountStore, 'findByProvider')
    configureTelegramTextDeliveryObserver(recordDeliveredTelegramMessage)
    try {
      if (phase === 'unlinked') await changeConfig({ ...config, userAccessMode: 'allowlist' })
      const result = await network(origin + '/webhook/telegram/' + channelId, {
        method: 'POST', headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'fictional-hook'
        }, body: JSON.stringify({
          update_id: 7000 + incomingId, message: {
            message_id: incomingId,
            message_thread_id: topic, is_topic_message: true, chat: { id: chat, type: 'supergroup', is_forum: true, title: 'Fictional observatory' },
            from: { id: telegramSender, first_name: 'Observer', is_bot: false }, date: Math.floor(Date.now() / 1000), text: authored
          }
        })
      })
      expect(result.status).toBe(200)
      await vi.waitFor(() => expect(linkRead).toHaveBeenCalledWith('telegram', String(telegramSender)))
      if (phase === 'unlinked') {
        const link = await linkRead.mock.results[0].value
        expect(link).toBeNull()
        const posted = await pool.query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',
          [sessionId, String(incomingId)])
        expect(posted.rows).toHaveLength(0)
        expect(modelCalls).toHaveLength(0)
        expect(backgroundCalls).toHaveLength(0)
        expect(delivered).toHaveLength(0)
        return
      }
      if (hold) {
        await vi.waitFor(async () => {
          if (phase === 'member') expect(memberRevoked).toBe(true)
          else if (phase === 'audience') expect(configChanged).toBe(true)
          else expect(heldInputId).toBeDefined()
          const session = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          expect(session.rows[0]).toEqual({ status: 'failed', turn_lease_token: null })
        }, { interval: 100, timeout: 15_000 })
        expect(modelCalls).toHaveLength(phase === 'headers' ? 0 : 1)
        expect(backgroundCalls).toHaveLength(0)
        expect(JSON.stringify(delivered)).not.toContain(heldAnswer)
        const leaked = await pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant' AND content::text LIKE $2", [sessionId, '%' + heldAnswer + '%'])
        expect(leaked.rows).toHaveLength(0)
        return
      }
      await vi.waitFor(async () => {
        const row = (await pool.query(`SELECT s.status, (SELECT count(*)::int FROM session_messages m WHERE m.session_id=s.id AND m.sequence_num>300) added
           FROM sessions s WHERE s.id=$1`, [sessionId])).rows[0]
        expect(delivered.length).toBeGreaterThan(0)
        if (row.status === 'failed') throw new Error('Telegram turn failed after ' + modelCalls.length + ' main model requests')
        expect(row.status).toBe('idle')
        expect(row.added).toBeGreaterThanOrEqual(2)
      }, { interval: 250, timeout: 180_000 })
      expect(modelCalls).toHaveLength(2)
      expect(deliveredMs).toBeDefined()
      console.info('[Telegram first dispatch]', JSON.stringify({
        stats, mainMs: modelCalls.map(row => Math.round(row.elapsedMs)),
        betweenMainMs: Math.round(modelCalls[1].elapsedMs - modelCalls[0].elapsedMs),
        sqlCallsSinceBaseline: before ? modelCalls.map(row => row.sqlCalls) : undefined,
        deliveredMs: Math.round(deliveredMs!),
        backgroundMs: backgroundCalls.map(Math.round), delivered: delivered.includes(reply)
      }))
      expect(modelCalls[0].elapsedMs).toBeLessThan(10_000)
      expect(backgroundCalls.every(time => time > modelCalls[0].elapsedMs)).toBe(true)
      expect(JSON.stringify(modelCalls[0].body.contents)).toContain(phase === 'choice' ? choice : question)
      if (phase === 'choice') {
        expect(channelQuestions.has(pendingQuestion)).toBe(false)
        expect(JSON.stringify(modelCalls[0].body.systemInstruction)).toContain('Request conversation context to resolve it')
        const input = await pool.query('SELECT content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2', [sessionId, String(incomingId)])
        expect(input.rows[0].content).toEqual([{ type: 'text', text: '1' }])
      }
      expect(JSON.stringify(modelCalls[0].body)).not.toContain(historicalAnswer)
      expect(JSON.stringify(modelCalls[0].body.tools)).toContain('requestConversationContext')
      const continuation = modelCalls[1].body.contents ?? []
      expect(JSON.stringify(continuation)).toContain(historicalAnswer)
      const call = { name: 'requestConversationContext', id: 'fixture-context' }
      const callIndex = continuation.findIndex(message => message.role === 'model' && message.parts.some(part => part.functionCall?.id === call.id))
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(continuation[callIndex].parts).toContainEqual(expect.objectContaining({ functionCall: expect.objectContaining(call) }))
      expect(continuation[callIndex + 1]).toMatchObject({
        role: 'user', parts: expect.arrayContaining([
          expect.objectContaining({ functionResponse: expect.objectContaining(call) }),
        ])
      })
      expect(JSON.stringify(modelCalls)).not.toContain(privateMarker)
      expect(delivered).toContain(reply)
      expect(replyReceiptId).toBeDefined()
      const stored = await pool.query("SELECT content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2 AND role='assistant'", [sessionId, replyReceiptId])
      expect(stored.rows).toEqual([{ content: [{ type: 'text', text: reply }] }])
    } finally {
      if (phase === 'choice') channelQuestions.invalidate(channelId, pendingQuestion.incoming)
      configureTelegramTextDeliveryObserver()
      linkRead.mockRestore()
      stub.mockRestore()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (heldInputId) await pool.query('UPDATE session_messages SET scope_held=false WHERE session_id=$1 AND id=$2', [sessionId, heldInputId])
      if (memberRevoked) await pool.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",
        [workspaceId, secondId])
      if (configChanged) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, config])
    }
  }, 600_000)
})
