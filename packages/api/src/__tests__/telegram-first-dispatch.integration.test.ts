/** [COMP:api/channel-recording] Signed Telegram webhook coverage with retained
 * messages. The model, Telegram transport and public lookup responses are fictional. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configureTelegramTextDeliveryObserver } from '@use-brian/channels'
import { CodexRpcTimeoutError } from '@use-brian/agent-runtime/providers/codex-app-server/rpc.js'
import { createGeminiProvider } from '@use-brian/agent-runtime/providers/gemini.js'
import { createRoutingProvider } from '@use-brian/agent-runtime/providers/routing.js'
import { wrapProvider } from '@use-brian/agent-runtime/providers/wrappers.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { bindScopeSources, boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { AnalyticsLogger } from '@use-brian/core/analytics/logger.js'
import { calculateTool, createUrlReaderTool, createWebSearchTool } from '@use-brian/core/tools/index.js'
import { persistentContextFixture } from '../application-platform/__tests__/fixtures/persistent-context.js'
import { admitTelegramRecording, changeChannelRecording, confirmChannelRecordingOwner, recordDeliveredTelegramMessage } from '../channel-recording.js'
import { createChatArchiveTools } from '../chat-archive/chat-tools.js'
import { MessageStoreClient } from '../chat-archive/message-store-client.js'
import { createDbAnalyticsStore } from '../db/analytics-store.js'
import { createConnectorInstanceStore } from '../db/connector-instance-store.js'
import { createDbAssistantConnectorStore } from '../db/assistant-connector-store.js'
import { createConnectorGrantStore } from '../db/connector-grant-store.js'
import { createDbConnectorStore } from '../db/connector-store.js'
import { createDbMcpSettingsStore } from '../db/mcp-settings-store.js'
import * as conversationAdmission from '../context-scope/conversation-record-admission.js'
import * as deliveryAuthority from '../context-scope/delivery-authority.js'
import * as conversationStore from '../db/conversation-store.js'
import { mailboxSearchAccountKey } from '../mailbox/search-coverage.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { createDbChannelIntegrationStore, encryptCredentials } from '../db/channel-integrations.js'
import { createDbChannelUserStore, resolveChannelUser } from '../db/channel-user-store.js'
import { getAppPool, getPool, queryWithRLS } from '../db/client.js'
import { initializeConversationVisibility } from '../db/conversation-visibility.js'
import { createDbKnowledgeStore, type KnowledgeStore } from '../db/knowledge-store.js'
import { createDbLinkedAccountStore } from '../db/linked-accounts.js'
import { createDbMemoryStore } from '../db/memory-store.js'
import { writeSessionMessageAnnotation } from '../db/session-message-annotations.js'
import { addSessionMessage, findOrCreateSession, readSessionMessageScopeSource } from '../db/sessions.js'
import * as verifiedChannelRecord from '../db/verified-channel-record.js'
import { createDecisionRuntime } from '../decision-runtime.js'
import { telegramByoRoutes } from '../routes/telegram-byo.js'
import { channelQuestions } from '../routes/channel-questions.js'
import * as turnHistory from '../turn/history.js'
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
const mailSubject = 'Fictional spectrometer shipment'
const mailQuestion = 'What emails arrived in the past day?'
const mailReply = 'Your recent mail includes ' + mailSubject + '.'
const lookupQuestion = 'Look up the posted North Star Observatory ticket price and calculate the total for three people.'
const lookupPage = 'General admission is 12.50 credits per person.'
const guestReply = 'I can answer without using the lookup tools.'
const knowledgeQuestion = 'Use our earlier calibration conversation to identify the handbook, then look it up in workspace knowledge.'
const standaloneKnowledgeQuestion = 'Search the workspace knowledge base for the current observatory handbook.'
const knowledgeGuestReply = 'I can reply without accessing workspace knowledge.'
const knowledgeTitle = 'Fictional observatory handbook'
const heldKnowledgeTitle = 'Fictional restricted handbook'
const projectKnowledgeTitle = 'Fictional project-only handbook'
const knowledgeProviderFailure = 'Fictional confidential supplier response usage limit marker'
const historyUnavailableNotice = 'I couldn’t load this conversation’s history. I stopped before taking any action on your request.'
const guardedFailureNotice = 'I could not finish this reply. If you asked me to take an action, check whether it went through before asking again.'
const knowledgeHitReply = 'The current handbook is available.'
const knowledgeMissReply = 'No knowledge entries match that query.'
const denseFullHistory = process.env.BRIAN_TELEGRAM_DENSE_FULL_HISTORY === '1'
const rows = Number(process.env.BRIAN_TELEGRAM_HISTORY_ROWS ?? (denseFullHistory ? 359 : 300))
const mailboxSamples = Number(process.env.BRIAN_TELEGRAM_MAILBOX_SAMPLES ?? 1)
const lookupSamples = Number(process.env.BRIAN_TELEGRAM_LOOKUP_SAMPLES ?? 1)
const paginationQuestion = 'Could you answer my original calibration request now?'
const originalCalibrationRequest = 'Can you confirm the wavelength and sample count for the calibration run?'
const originalCalibrationAnswer = 'Use 532 nm and run three water samples.'
const paginationReply = 'For calibration, use 532 nm and run three water samples.'
const lateRecording = 'A later message proposes a different wavelength and sample count.'
const quoteSequence = Math.max(1, rows - 24)
const retainedQuote = 'Use the orange filter to calibrate the sensor.'
const providerQuotePreview = 'Use the green filter to calibrate the sensor.'
const quoteAnswer = 'The quoted calibration instruction says to use the orange filter.'
const quoteUnavailableReply = 'I could not read the quoted calibration instruction.'
const attachmentFileId = 'fictional-calibration-chart'
const attachmentPath = 'documents/calibration.png'
const attachmentImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLQ0AAAAASUVORK5CYII='
const paginationNewer = [
  'Please answer my earlier calibration request.', 'Sorry, I could not recover that request.',
  'Could you try to answer it again?', 'I still could not retrieve that conversation.',
  'Hello', 'Hi, how can I help?', 'Please retry the same request.', 'I could not retrieve the original request.',
]
const paginationOlder = [
  'The lab doors open at seven.', 'I will meet you there.',
  'The optics cart is ready.', 'I will bring the sample trays.',
  'We have reserved the calibration bench.', 'The blank sample is ready.',
  originalCalibrationRequest, originalCalibrationAnswer,
]

function retainedText(sequence: number) {
  if (sequence === quoteSequence && sequence !== rows - 1) return retainedQuote
  return sequence === rows - 1 ? 'For final calibration we agreed to use ' + historicalAnswer + '.'
    : `Fictional observatory log entry ${sequence}. The crew followed the scheduled calibration procedure, inspected the sampling tray, recorded the temperature and exposure interval, and compared this reading with the observations from the previous shift.`
}

function contextCall(id: string, args: { mode?: 'recent_text' | 'full'; cursor?: string } = {}) {
  return { functionCall: { name: 'readChatHistory', id, args }, thoughtSignature: 'fixture-context-signature' }
}

function parseRecentPage(result: string | undefined) {
  expect(result).toBeDefined()
  type Excerpt = { role: 'user' | 'assistant'; text: string }
  return JSON.parse(result!) as { messages: Excerpt[]; nextCursor?: string;
    quote?: ({ status: 'available' } & Excerpt) | { status: 'unavailable' } }
}

function expectRecentPage(result: ReturnType<typeof parseRecentPage>, texts: string[]) {
  expect(result.messages).toEqual(texts.map((text, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text })))
  expect(result.nextCursor).toEqual(expect.any(String))
}

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
  const { sessionId, stats } = await seedRetainedHistory(fixture, incoming)
  console.info('[Telegram benchmark history]', stats)
  return { fixture, pool, workspaceId, sessionId, channelId, integrationId, config, key, ownerId, secondId, assistantId,
    linkedAccountStore, integrationStore: createDbChannelIntegrationStore(key), stats }
}

async function seedRetainedHistory(fixture: Awaited<ReturnType<typeof persistentContextFixture>>,
  incoming: Pick<Parameters<typeof admitTelegramRecording>[0], 'integrationId' | 'conversationId' | 'assistantId' | 'senderUserId'>,
  messageOffset = 0) {
  const { pool, workspaceId, ownerId } = fixture
  let sessionId = ''
  let firstAnnotation: Awaited<ReturnType<typeof writeSessionMessageAnnotation>> = null
  for (let n = 1; n <= rows; n++) {
    const providerMessageId = String(messageOffset + n + 1000)
    const text = retainedText(n)
    if (n % 2 === 0) {
      await recordDeliveredTelegramMessage({ channelId: incoming.conversationId, providerMessageId, text, botId })
      continue
    }
    const recorded = await admitTelegramRecording({ ...incoming, providerMessageId, text })
    if (!recorded || recorded.session.visibility !== 'workspace') throw new Error('Missing shared recording')
    sessionId = recorded.session.id
    // A genuine actor-authorized topic annotation for every fourth human message.
    // Its synthetic classifier used that one authored field as its evidence.
    const annotate = denseFullHistory ? n % 10 === 7 || n === rows : n % 8 === 7
    if (annotate) {
      const { rows: [message] } = await pool.query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2', [sessionId, providerMessageId])
      const source = await readSessionMessageScopeSource(workspaceId, message.id)
      if (!source) throw new Error('Missing authored evidence')
      const freshExecution = () => fixture.execution(ownerId, recorded.session, {
        kind: 'attended', principal: { kind: 'workspace_member', userId: ownerId, authenticationKind: 'verified_channel' },
      })
      let sources = denseFullHistory && firstAnnotation ? boundScopeSources(firstAnnotation) : [source]
      if (denseFullHistory && n === rows) {
        const captures = []
        for (const throughSequence of [255, 256]) {
          captures.push(await conversationStore.readAdmittedSessionQuery({ sessionId, throughSequence, topicThroughSequence: 0,
            authority: { execution: await freshExecution(), accumulator: new ContextScopeAccumulator() } }))
        }
        sources = [...new Map(captures.flatMap(boundScopeSources).map(item => [item.resourceId, item])).values()]
        expect(sources.every(item => item.resourceKind === 'application_field')).toBe(true)
        const { rows: fields } = await pool.query(`SELECT type_key, selection, cardinality(fields) AS fields,
          selected_version IS NOT NULL AS versioned, count(*)::int AS count
          FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[])
          GROUP BY type_key,selection,cardinality(fields),selected_version IS NOT NULL ORDER BY type_key,selection`,
        [workspaceId, sources.map(item => item.resourceId)])
        expect(fields).toEqual([
          { type_key: 'session_message', selection: 'query', fields: 9, versioned: false, count: 256 },
          { type_key: 'session_message', selection: 'query_domain', fields: 9, versioned: false, count: 2 },
          { type_key: 'session_message_annotation', selection: 'query_domain', fields: 5, versioned: false, count: 1 },
        ])
      }
      const authority = { execution: await freshExecution(), accumulator: new ContextScopeAccumulator({ sources }) }
      const classification = bindScopeSources({ topic_label: 'Calibration', state: 'continue' as const, confidence: 1 }, sources)
      const annotation = await writeSessionMessageAnnotation({ sessionId, messageId: message.id, classification, replyToText: null, authority })
      if (!annotation) throw new Error('Missing fixture annotation')
      firstAnnotation ??= annotation
    }
  }
  const stats = (await pool.query(`SELECT count(*)::int messages, sum(octet_length(content::text))::int bytes,
    (SELECT count(*)::int FROM session_context_scope_revisions WHERE session_id=$1 AND parent_kind='message_annotation') revisions
    FROM session_messages WHERE session_id=$1`, [sessionId])).rows[0]
  expect(stats.messages).toBe(rows)
  expect(stats.revisions).toBe(denseFullHistory ? 37 : Math.floor((rows + 1) / 8))
  if (denseFullHistory) {
    // The current annotation owner materializes inherited revision and message
    // evidence in addition to the fixture's direct source references.
    const { rows: edges } = await pool.query(`SELECT d.resource_kind, src.source_kind, count(*)::int AS edges
      FROM scope_derivations d JOIN scope_derivation_sources src ON src.derivation_id=d.id
      WHERE d.workspace_id=$1 AND (
        d.resource_kind='session_message' AND d.resource_id IN (SELECT id FROM session_messages WHERE session_id=$2)
        OR d.resource_kind='session_context_revision' AND d.resource_id IN (SELECT id FROM session_context_scope_revisions WHERE session_id=$2)
      ) GROUP BY d.resource_kind,src.source_kind ORDER BY d.resource_kind,src.source_kind`,[workspaceId,sessionId])
    expect(edges).toEqual([
      { resource_kind: 'session_context_revision', source_kind: 'application_field', edges: 259 },
      { resource_kind: 'session_context_revision', source_kind: 'session_context_revision', edges: 107 },
      { resource_kind: 'session_context_revision', source_kind: 'session_message', edges: 37 },
    ])
    console.info('[Telegram dense annotation edges]', JSON.stringify(edges))
  }
  return { sessionId, stats }
}

async function seedPagingTopic(recording: Awaited<ReturnType<typeof seedConversation>>, topicId: number) {
  const { fixture, integrationId, ownerId, assistantId } = recording
  const messageOffset = topicId * 10_000
  const incoming = { integrationId, conversationId: `${chat}:topic:${topicId}`, assistantId, senderUserId: ownerId }
  const first = await admitTelegramRecording({ ...incoming, providerMessageId: String(messageOffset + 1), text: privateMarker })
  if (!first) throw new Error('Missing initial recording')
  await changeChannelRecording({ integrationId, actorId: ownerId, id: first.policy.id,
    revision: first.policy.revision, enabled: true, destination: 'workspace', projectId: null })
  const { sessionId } = await seedRetainedHistory(fixture, incoming, messageOffset)
  return { topicId, sessionId }
}

async function seedCoveredMailbox(recording: Awaited<ReturnType<typeof seedConversation>>) {
  const { workspaceId, ownerId, key, pool } = recording
  const instances = createConnectorInstanceStore(key)
  const settings = { email: 'observatory@example.invalid', appPassword: 'fictional-test-password',
    imapHost: 'imap.example.invalid', imapPort: 993, smtpHost: 'smtp.example.invalid', smtpPort: 465 }
  const assistantConnectorStore = createDbAssistantConnectorStore()
  await assistantConnectorStore.setEnabled(recording.assistantId, 'imap', true)
  const grants = createConnectorGrantStore()
  const instance = await instances.createUserInstance({ userId: ownerId, createdBy: ownerId, provider: 'imap',
    label: 'Observatory mail', connectedEmail: settings.email, connected: true,
    credentials: { type: 'imap', ...settings }, sensitivity: 'internal' })
  await grants.create({ actingUserId: ownerId, connectorInstanceId: instance.id, targetType: 'workspace',
    targetId: workspaceId, compartments: [], projectIds: [] })
  await pool.query(`INSERT INTO email_archive_messages
    (workspace_id, instance_id, owner_user_id, folder, provider_message_id, from_addr, subject, body_text, sent_at)
    VALUES ($1,$2,$3,'INBOX','INBOX:1','shipping@example.invalid',$4,'The instrument is in transit.',now())`,
    [workspaceId, instance.id, ownerId, mailSubject])
  await pool.query(`INSERT INTO email_archive_messages
    (workspace_id, instance_id, owner_user_id, folder, provider_message_id, from_addr, subject, body_text, sent_at)
    SELECT $1,$2,$3,'INBOX','INBOX:' || n,'shipping@example.invalid','Previous shipment','','2020-01-01'
    FROM generate_series(2,20001) n`, [workspaceId, instance.id, ownerId])
  await pool.query('ANALYZE email_archive_messages')
  async function refresh() {
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    const coverage = {
      version: 1, ownerUserId: ownerId, accountKey: mailboxSearchAccountKey(settings),
      archivedAfter: '2000-01-01T00:00:00.000Z', completeRoster: true, listedFolders: ['INBOX'],
      folders: { INBOX: { uidValidity: '1', verifiedAt: today.toISOString(), futureUids: [],
        days: { [yesterday.toISOString().slice(0, 10)]: [], [today.toISOString().slice(0, 10)]: [1] } } },
    }
    const searchCoverageSeal = instances.mailboxArchiveProofSystem!(instance.id, 'coverage', coverage)
    await pool.query(`UPDATE connector_instance SET ingestion_enabled=true, ingest_workspace_id=$3, config=$2 WHERE id=$1`,
      [instance.id, { mailboxSync: { searchCoverage: coverage, searchCoverageSeal } }, workspaceId])
  }
  return { id: instance.id, refresh, stores: { assistantConnectorStore, connectorInstanceStore: instances, connectorStore: createDbConnectorStore(key),
    mcpSettingsStore: createDbMcpSettingsStore(), connectorGrantStore: grants } }
}

async function seedChannelKnowledge(recording: Awaited<ReturnType<typeof seedConversation>>, fullCohort: boolean) {
  const { pool, workspaceId, ownerId } = recording
  await pool.query(`INSERT INTO knowledge_entries(workspace_id,path,title,content,sensitivity,created_by,scope_held)
    SELECT $1,'fictional-handbook/'||n,CASE n WHEN 916 THEN $3 WHEN 917 THEN $4 ELSE 'Fictional reference '||n END,
      repeat('Synthetic observatory reference material. ',100)||CASE n WHEN 916 THEN 'amberneedle' WHEN 917 THEN 'amberneedle violetneedle' ELSE '' END,
      'public',$2,n=917 FROM generate_series(1,917) n WHERE n>=916 OR $5 ON CONFLICT DO NOTHING`,
  [workspaceId, ownerId, knowledgeTitle, heldKnowledgeTitle, fullCohort])
  const { rows: [cohort] } = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM knowledge_entries WHERE workspace_id=$1', [workspaceId])
  expect(cohort.count).toBe(fullCohort ? 917 : 2)
  return { knowledgeStore: createDbKnowledgeStore(), connectorStore: createDbConnectorStore(recording.key), mcpSettingsStore: createDbMcpSettingsStore() }
}

async function scopeKnowledgeEntryToProject(recording: Awaited<ReturnType<typeof seedConversation>>) {
  const { pool, workspaceId, ownerId } = recording
  const { rows: [project] } = await pool.query<{ id: string }>(`INSERT INTO workspace_projects(workspace_id,name,normalized_name,created_by)
    VALUES($1,'Fictional handbook project','fictional handbook project',$2) RETURNING id`, [workspaceId, ownerId])
  const update = await pool.query(`UPDATE knowledge_entries SET title=$2,content='amberneedle violetneedle',project_ids=ARRAY[$3]::uuid[]
    WHERE workspace_id=$1 AND path='fictional-handbook/915'`, [workspaceId, projectKnowledgeTitle, project.id])
  expect(update.rowCount).toBe(1)
}

type ModelRequest = {
  systemInstruction?: unknown
  contents?: Array<{
    role: string, parts: Array<{
      text?: string
      inlineData?: { mimeType: string; data: string }
      functionCall?: { name: string, id: string, args?: Record<string, unknown> }
      functionResponse?: { name: string, id: string, response: { result: string } }
    }>
  }>
  tools?: unknown[]
  generationConfig?: { responseMimeType?: string, responseJsonSchema?: { properties?: { answers?: { properties?: Record<string, { properties: { value: { enum?: string[] } } }> } } } }
}

describe.runIf(process.env.BRIAN_TELEGRAM_DISPATCH_BENCHMARK === '1')('[COMP:api/channel-recording] Telegram first model dispatch', () => {
  let recording: Awaited<ReturnType<typeof seedConversation>>
  let mailbox: Awaited<ReturnType<typeof seedCoveredMailbox>> | undefined
  let knowledge: Awaited<ReturnType<typeof seedChannelKnowledge>> | undefined
  let knowledgeScaleSeeded = false
  let knowledgeProjectSeeded = false
  const mailboxMs: number[] = []
  beforeAll(async () => {
    expect(Number.isSafeInteger(rows) && rows > 0).toBe(true)
    if (denseFullHistory) expect(rows).toBe(359)
    expect(Number.isSafeInteger(mailboxSamples) && mailboxSamples >= 1 && mailboxSamples <= 100).toBe(true)
    expect(Number.isSafeInteger(lookupSamples) && lookupSamples >= 1 && lookupSamples <= 100).toBe(true)
    await assertLocalFixture()
    recording = await seedConversation()
  }, 180_000)
  afterAll(async () => {
    await getAppPool().end()
    await getPool().end()
    if (mailboxMs.length) {
      const samples = [...mailboxMs].sort((a, b) => a - b)
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
      console.info('[Telegram indexed mailbox]', { samples: samples.length, historyRows: rows, p95Ms: Math.round(p95) })
      expect(p95).toBeLessThan(1_000)
    }
  })
  it.each([
    ...Array.from({ length: mailboxSamples }, (_, sample) => ({
      title: 'answers recent mail without conversation discovery, sample ' + (sample + 1),
      phase: 'mailbox' as const, incomingId: 3000 + sample,
    })),
    { title: 'withholds mailbox contents when the connection is disabled before the first tool call',
      phase: 'mail-revoked', incomingId: 4001 },
    { title: 'withholds the mail result from the provider after revocation at the next dispatch',
      phase: 'mail-dispatch', incomingId: 4003 },
    { title: 'withholds a mail-derived reply if the connection is revoked before delivery',
      phase: 'mail-release', incomingId: 4002 },
    ...Array.from({ length: lookupSamples }, (_, sample) => ({
      title: 'executes a public lookup and sends its answer across three tool rounds without retained history, sample ' + (sample + 1),
      phase: 'lookup' as const, incomingId: 5001 + sample,
    })),
    { title: 'keeps the public lookup tools unavailable to an explicitly allowed conversation-only guest',
      phase: 'lookup-guest', incomingId: 5200 },
    { title: 'receives the main request within ten seconds and delivers the retained answer', phase: 'ordinary', incomingId: 2000 },
    { title: 'delivers the retained answer on explicit full history from a signed Telegram reply', phase: 'full-reply', incomingId: 5433 },
    { title: 'reads an older retained quote on a default signed Telegram history call', phase: 'recent-quote', incomingId: 5434 },
    { title: 'reports a held quote unavailable on a default signed Telegram history call', phase: 'recent-quote-held', incomingId: 5435 },
    { title: 'withholds a reply when its older quote is held after model dispatch', phase: 'recent-quote-revoked', incomingId: 5436 },
    { title: 'uses bounded history for a reply to the Telegram forum creation marker', phase: 'recent-forum-anchor', incomingId: 5437 },
    { title: 'uses bounded history with an addressed Telegram attachment', phase: 'recent-attachment', incomingId: 5438 },
    { title: 'preserves a Telegram attachment when explicitly loading full history', phase: 'full-attachment', incomingId: 5439 },
    ...Array.from({length:3},(_,sample)=>({title:`delivers bounded recent Telegram text, sample ${sample+1}`,
      phase:'recent-text' as const,incomingId:5400+sample})),
    { title: 'escalates from recent text to full discovery in the same turn', phase: 'recent-then-full', incomingId: 5403 },
    { title: 'withholds the recent result when its exact selection changes before provider write', phase: 'recent-selection', incomingId: 5410 },
    { title: 'withholds a recent-text reply when selected evidence is held after provider dispatch', phase: 'recent-delivery', incomingId: 5411 },
    { title: 'rechecks recent text before a physical Telegram delivery retry', phase: 'recent-delivery-retry', incomingId: 5412 },
    { title: 'pages past failed retry exchanges and delivers the original calibration answer', phase: 'recent-page', incomingId: 5420 },
    { title: 'rejects a recent-text cursor issued to another turn', phase: 'recent-page-foreign', incomingId: 5421 },
    { title: 'moves past an empty recent-text window without filling from older slots', phase: 'recent-page-empty', incomingId: 5422 },
    { title: 'withholds page two from Gemini when page one changes before provider write', phase: 'recent-page-provider', incomingId: 5423 },
    { title: 'withholds a physical Telegram delivery retry when page one changes after page two', phase: 'recent-page-delivery', incomingId: 5424 },
    { title: 'withholds newly changed page-one membership before Gemini sees page two', phase: 'recent-page-provider-witness', incomingId: 5425 },
    { title: 'withholds page two when its Telegram sender unlinks after seeing page one', phase: 'recent-page-unlink', incomingId: 5426 },
    { title: 'recording channel lock release permits a waiting recent-text request', phase: 'recording-lock-release', incomingId: 5430 },
    { title: 'recording channel lock timeout withholds recent text', phase: 'recording-lock-timeout', incomingId: 5431 },
    { title: 'recording channel lock wait preserves audience withdrawal', phase: 'recording-lock-audience', incomingId: 5432 },
    { title: 'reports that no action ran on history failure', phase: 'history-failure', incomingId: 2010 },
    { title: 'reports that no action ran on topic failure', phase: 'history-topic-failure', incomingId: 2013 },
    { title: 'keeps action-check guidance for sibling tool', phase: 'history-sibling-tool', incomingId: 2011 },
    { title: 'keeps action-check guidance after prior tool', phase: 'history-after-tool', incomingId: 2012 },
    { title: 'withholds the physical request when the current Telegram input is held after admission', phase: 'headers', incomingId: 2001 },
    { title: 'withholds the answer when the current Telegram input is held after model dispatch', phase: 'response', incomingId: 2002 },
    { title: 'resolves an unquoted numeric question choice through authenticated context discovery', phase: 'choice', incomingId: 2003 },
    { title: 'loses workspace membership before the public tool can run or reply', phase: 'member', incomingId: 2004 },
    { title: 'withholds the answer after the audience binding moves to another group', phase: 'audience', incomingId: 2005 },
    { title: 'denies an unlinked sender on an owner-only bot', phase: 'unlinked', incomingId: 2006 },
    { title: 'compact Knowledge preserves the legacy Telegram group reply hold', phase: 'knowledge-group-control', incomingId: 4300 },
    { title: 'compact Knowledge delivers a hit to the linked member in a verified Telegram DM', phase: 'knowledge-dm', incomingId: 4304 },
    { title: 'direct Knowledge hit reaches the approved Telegram topic without history', phase: 'knowledge-initial-hit', incomingId: 4310 },
    { title: 'direct Knowledge miss reaches the approved Telegram topic without history', phase: 'knowledge-initial-miss', incomingId: 4311 },
    { title: 'direct Knowledge is absent for an allowlisted Telegram guest', phase: 'knowledge-initial-guest', incomingId: 4312 },
    { title: 'compact Knowledge group hit reaches the approved Telegram topic', phase: 'knowledge-hit', incomingId: 4301 },
    { title: 'compact Knowledge group miss reaches the approved Telegram topic', phase: 'knowledge-miss', incomingId: 4302 },
    { title: 'compact Knowledge obeys a live Telegram group binding move after search', phase: 'knowledge-group-revoked', incomingId: 4303 },
    { title: 'compact Knowledge refuses an unbound Telegram group before search', phase: 'knowledge-unbound', incomingId: 4305 },
    { title: 'compact Knowledge records provider failure and sends a safe notice', phase: 'knowledge-provider-error', incomingId: 4308 },
    { title: 'releases the turn when its failure notice is rejected', phase: 'knowledge-notice-error', incomingId: 4309 },
    { title: 'records Codex timeout phases without copying provider text', phase: 'knowledge-codex-timeout', incomingId: 4313 },
    { title: 'compact Knowledge refuses a Telegram parent-chat retry when the approved topic disappears', phase: 'knowledge-topic-missing', incomingId: 4307 },
    { title: 'compact Knowledge withholds a Telegram group reply if the hit is held after admission', phase: 'knowledge-source-held', incomingId: 4306 },
  ] as const)('$title', async ({ phase, incomingId }) => {
    const { pool, workspaceId, sessionId, channelId, integrationId, config, ownerId, secondId, assistantId,
      linkedAccountStore, integrationStore, stats } = recording
    const isFullReply = phase === 'full-reply'
    const isFullHistory = isFullReply || phase === 'full-attachment'
    const hasAttachment = phase === 'recent-attachment' || phase === 'full-attachment'
    const isRecentQuote = phase === 'recent-quote' || phase === 'recent-quote-held' || phase === 'recent-quote-revoked'
    const isForumAnchor = phase === 'recent-forum-anchor'
    const boundedReference = isRecentQuote || isForumAnchor
    const recentThenFull = phase === 'recent-then-full'
    const isPagination = phase.startsWith('recent-page')
    const isRecordingLock = phase.startsWith('recording-lock')
    const isRecent = boundedReference || phase === 'recent-attachment' || isPagination || isRecordingLock || phase === 'recent-text' || recentThenFull || phase === 'recent-selection'
      || phase === 'recent-delivery' || phase === 'recent-delivery-retry'
    const retryDelivery = phase === 'recent-delivery-retry' || phase === 'recent-page-delivery'
    const revokeBeforeProvider = phase === 'recent-page-provider' || phase === 'recent-page-provider-witness'
    const unlinkBeforeNextPage = phase === 'recent-page-unlink'
    const recentMarker = `Fictional nearby observing decision ${incomingId}`
    const withheldRecentMarker = `Fictional withheld observing decision ${incomingId}`
    const recentReply = `The latest observing decision is ${recentMarker}.`
    const recentIds: string[] = []
    const pageOneIds: string[] = []
    const contextResults = new Map<string, string>()
    let firstPageCursor: string | undefined
    let foreignWarmup = phase === 'recent-page-foreign'
    const holdRecent = async (id: string) => {
      const held = await pool.query('UPDATE session_messages SET scope_held=true WHERE session_id=$1 AND id=$2 AND NOT scope_held', [sessionId, id])
      expect(held.rowCount).toBe(1)
    }
    let quotedRowId: string | undefined
    let quotedRowHeld = false
    if (isRecentQuote) {
      const { rows: [quoted] } = await pool.query<{ id: string; sequence_num: number }>(`SELECT id,sequence_num
        FROM session_messages WHERE session_id=$1 AND channel_message_id=$2`, [sessionId, String(quoteSequence + 1000)])
      expect(quoted.sequence_num).toBeLessThan(rows - 8)
      quotedRowId = quoted.id
    }
    if (isRecent) {
      const recentRows = isPagination ? [...paginationOlder, ...paginationNewer] : recentThenFull
        ? [...Array.from({length:8},(_,index)=>`Fictional intervening observatory note ${index+1}.`),recentMarker]
        : [recentMarker,withheldRecentMarker]
      for (const [index,text] of recentRows.entries()) {
        const providerMessageId = String(incomingId*100+index)
        if (isPagination && index % 2 === 1) await recordDeliveredTelegramMessage({ channelId: conversationId, botId, providerMessageId, text })
        else await admitTelegramRecording({ integrationId, conversationId, assistantId, senderUserId: ownerId, providerMessageId, text })
        const {rows:[row]} = await pool.query<{id:string}>(`SELECT id FROM session_messages
          WHERE session_id=$1 AND channel_message_id=$2`,[sessionId,providerMessageId])
        recentIds.push(row.id)
      }
      if (isPagination) {
        pageOneIds.push(...recentIds.slice(paginationOlder.length))
        if (phase === 'recent-page-empty') for (const id of pageOneIds) await holdRecent(id)
        if (phase === 'recent-page-provider-witness') await holdRecent(pageOneIds.at(-1)!)
      } else if (!recentThenFull) await holdRecent(recentIds[1])
    }
    const isMail = phase === 'mailbox' || phase === 'mail-revoked' || phase === 'mail-release' || phase === 'mail-dispatch'
    const isLookup = phase === 'lookup' || phase === 'lookup-guest'
    const historyBeforeAction = phase === 'history-failure' || phase === 'history-topic-failure'
    const historyFailure = historyBeforeAction || phase === 'history-sibling-tool' || phase === 'history-after-tool'
    const standaloneLookup = phase === 'knowledge-initial-hit' || phase === 'knowledge-initial-miss'
    const standaloneGuest = phase === 'knowledge-initial-guest'
    const rejectedFailureNotice = phase === 'knowledge-notice-error'
    const codexTimeout = phase === 'knowledge-codex-timeout'
    const untrustedKnowledgeError = phase === 'knowledge-provider-error' || rejectedFailureNotice || codexTimeout
    const isKnowledge = phase === 'knowledge-hit' || phase === 'knowledge-miss' || phase === 'knowledge-dm'
      || phase === 'knowledge-group-revoked' || phase === 'knowledge-group-control' || phase === 'knowledge-unbound'
      || phase === 'knowledge-source-held' || phase === 'knowledge-topic-missing'
      || untrustedKnowledgeError || standaloneLookup || standaloneGuest
    const knowledgeModelResultRound = standaloneLookup ? 1 : 3
    const knowledgeDm = phase === 'knowledge-dm'
    const knowledgeRevoked = phase === 'knowledge-group-revoked'
    const knowledgeControl = phase === 'knowledge-group-control'
    const knowledgeUnbound = phase === 'knowledge-unbound'
    const holdKnowledgeSource = phase === 'knowledge-source-held'
    const knowledgeTopicMissing = phase === 'knowledge-topic-missing'
    const knowledgeMiss = phase === 'knowledge-miss' || phase === 'knowledge-initial-miss'
    const knowledgeQuery = knowledgeMiss ? 'violetneedle' : 'amberneedle'
    const knowledgeExpected = knowledgeMiss ? 'No knowledge entries found for this query.' : knowledgeTitle
    // Unique target per sample so URL cache hits cannot stand in for tool execution.
    const lookupUrl = 'https://observatory.example.invalid/admission?receipt=' + incomingId
    const lookupReply = 'Three tickets cost 37.50 credits. ' + lookupUrl
    const lookupSteps = [
      { name: 'webSearch', id: 'fixture-web-search', args: { query: 'North Star Observatory admission ' + incomingId, provider: 'duckduckgo' } },
      { name: 'urlReader', id: 'fixture-url-reader', args: { url: lookupUrl } },
      { name: 'calculate', id: 'fixture-calculator', args: { expression: '12.50 * 3' } },
    ]
    const lookupEvidence = [lookupUrl, lookupPage, '"result":"37.5"']
    const analytics = phase === 'lookup' || isKnowledge || isRecent || isFullHistory ? new AnalyticsLogger(createDbAnalyticsStore()) : undefined
    const lookupTools = isLookup || phase === 'member'
      ? new Map([createWebSearchTool(), createUrlReaderTool(), calculateTool].map(tool => [tool.name, tool]))
      : historyFailure ? new Map([[calculateTool.name, calculateTool]]) : new Map()
    if (isMail) {
      mailbox ??= await seedCoveredMailbox(recording)
      await mailbox.refresh()
    }
    if (isKnowledge && (!knowledge || !knowledgeScaleSeeded && !knowledgeControl)) {
      knowledge = await seedChannelKnowledge(recording, !knowledgeControl)
      knowledgeScaleSeeded ||= !knowledgeControl
    }
    if (isKnowledge && !knowledgeControl && !knowledgeDm && !knowledgeUnbound && !knowledgeProjectSeeded) {
      await scopeKnowledgeEntryToProject(recording)
      knowledgeProjectSeeded = true
    }
    const knowledgeFieldIds: string[] = []
    let knowledgeStoreStartedAt: number | undefined
    let knowledgeStoreCompletedAt: number | undefined
    const knowledgeStores = isKnowledge && knowledge ? { ...knowledge, knowledgeStore: {
      ...knowledge.knowledgeStore,
      searchForTool: async (...args: Parameters<KnowledgeStore['searchForTool']>) => {
        const reader = knowledgeControl ? knowledge!.knowledgeStore.search : knowledge!.knowledgeStore.searchForTool
        knowledgeStoreStartedAt = performance.now()
        const results = await reader(...args)
        knowledgeStoreCompletedAt = performance.now()
        knowledgeFieldIds.push(...boundScopeSources(results).filter(source => source.resourceKind === 'application_field').map(source => source.resourceId))
        return results
      },
    } } : undefined
    const unavailableReply = 'I could not access that mailbox.'
    const cursorRefused = 'That conversation page was unavailable.'
    const expectedReply = phase === 'mail-revoked' ? unavailableReply : isMail ? mailReply
      : standaloneGuest ? knowledgeGuestReply : isKnowledge ? knowledgeMiss ? knowledgeMissReply : knowledgeHitReply
      : phase === 'lookup' ? lookupReply : phase === 'lookup-guest' ? guestReply
      : phase === 'recent-quote-held' ? quoteUnavailableReply : isRecentQuote ? quoteAnswer
      : phase === 'recent-page-foreign' ? cursorRefused : isPagination ? paginationReply : isRecent ? recentReply : reply
    const hold = phase === 'headers' || phase === 'response' || phase === 'member' || phase === 'audience'
    const telegramSender = phase === 'member' || unlinkBeforeNextPage ? otherMember
      : phase === 'unlinked' || phase === 'lookup-guest' || standaloneGuest ? unlinkedSender : sender
    const choice = 'Use our earlier calibration decision'
    const authored = phase === 'choice' ? '1' : isMail ? mailQuestion : isLookup ? lookupQuestion
      : standaloneLookup || standaloneGuest ? standaloneKnowledgeQuestion : isKnowledge ? knowledgeQuestion
      : isRecentQuote || isFullReply ? 'Can you confirm that decision?' : isPagination ? paginationQuestion : isRecent ? 'What was our latest observing decision?' : question
    const pendingQuestion = {
      integrationId: channelId, assistantId, userId: ownerId, incoming: {
        userId: String(sender), channelId: conversationId, text: 'Select the next step', isGroupChat: true, timestamp: Date.now(), raw: {},
      }
    }
    if (phase === 'choice') channelQuestions.create(pendingQuestion, [choice, 'Run a new calibration'])
    const heldAnswer = 'Protected fictional sensor result ' + incomingId
    let heldInputId: string | undefined
    let revokedAtDispatch = false
    let recentSelectionChanged = false
    let paginationLinkRemoved = false
    let channelHolder: pg.PoolClient | undefined
    let observedChannelWait: Promise<void> | undefined
    const recentDeliveryAttempts: Array<{chatId:string;topicId?:number;parseMode?:string}> = []
    const paginationReplyTargets: Array<{ chatId: string; topicId?: number }> = []
    let historyReplyTarget: { chatId: string; topicId?: number } | undefined
    let historyToolRequestedAt: number | undefined
    let historyContinuationMs: number | undefined
    const pageRequestedAt = new Map<string, number>()
    const pageContinuationMs = new Map<string, number>()
    let memberRevoked = false
    let configChanged = false
    let heldKnowledgeId: string | undefined
    async function changeConfig(next: typeof config & { userAccessMode?: 'allowlist', allowedUserIds?: string[] }) {
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
    async function holdRecordingChannel() {
      const holder = channelHolder = await pool.connect()
      await holder.query('BEGIN')
      const { rows: [identity] } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      expect((await holder.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [channelId])).rowCount).toBe(1)
      observedChannelWait = (async () => {
        await vi.waitFor(async () => {
          const { rows: [lock] } = await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE usename='app_user' AND $1::int=ANY(pg_blocking_pids(pid))
          ) AS blocked`, [identity.pid])
          expect(lock.blocked).toBe(true)
        }, { timeout: 2_000, interval: 5 })
        if (phase === 'recording-lock-timeout') return
        if (phase === 'recording-lock-audience') {
          const changed = await holder.query(`UPDATE channel_integrations SET config=jsonb_set(config,'{deliveryAudienceBindings}','[]'::jsonb)
            WHERE id=$1`, [integrationId])
          expect(changed.rowCount).toBe(1)
          configChanged = true
        }
        await holder.query('COMMIT')
        holder.release()
        channelHolder = undefined
      })()
      // The model response must publish its tool call while this observes the database.
      void observedChannelWait.catch(() => {})
    }
    const app = express()
    let ingress = 0
    const credentialRead = isMail ? vi.spyOn(mailbox!.stores.connectorInstanceStore, 'getAuthCredentialsSystem') : undefined
    let readsAtFirstRequest: number | undefined
    let mailCallAt: number | undefined
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
    const lookupNetwork: string[] = []
    app.post('/model/:model', async (req, res) => {
      const body = req.body as ModelRequest
      const receivedAt = performance.now()
      const elapsedMs = receivedAt - ingress
      const isMain = req.params.model === standardGemini.apiModelId && body.generationConfig?.responseMimeType !== 'application/json'
      let parts: unknown[]
      if (isMain) {
        const response = (id: string) => body.contents?.at(-1)?.parts.find(part => part.functionResponse?.id === id)?.functionResponse?.response.result
        const current = await sqlCounts()
        const sqlCalls = current && before ? { top: current.top - before.top, nested: current.nested - before.nested } : undefined
        modelCalls.push({ body, elapsedMs, sqlCalls })
        if ((isFullHistory || boundedReference) && modelCalls.length === 2) historyContinuationMs = receivedAt - historyToolRequestedAt!
        console.info('[Telegram main model HTTP ingress]', { round: modelCalls.length, elapsedMs: Math.round(elapsedMs) })
        if (isRecordingLock && modelCalls.length === 1) await holdRecordingChannel()
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
          parts = phase === 'member'
            ? [{ functionCall: lookupSteps[0], thoughtSignature: 'fixture-revoked-sender-signature' }]
            : [{ text: heldAnswer }]
        } else if (isMail) {
          if (modelCalls.length === 1) {
            readsAtFirstRequest = credentialRead?.mock.calls.length
            parts = [{ functionCall: { name: 'imapSearchMessages', id: 'fixture-search',
              args: { since: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) } }, thoughtSignature: 'fixture-mail-signature' }]
            if (phase === 'mail-revoked') {
              await pool.query('UPDATE connector_instance SET connected=false WHERE id=$1', [mailbox!.id])
            }
            mailCallAt = performance.now()
          } else {
            parts = [{ text: JSON.stringify(body.contents).includes(mailSubject) ? mailReply : unavailableReply }]
            if (phase === 'mail-release') {
              expect(JSON.stringify(body.contents)).toContain(mailSubject)
              await pool.query('UPDATE connector_instance SET connected=false WHERE id=$1', [mailbox!.id])
            }
            if (phase === 'mailbox') mailboxMs.push(ingress + elapsedMs - mailCallAt!)
          }
        } else if (isPagination) {
          for (const { functionResponse } of body.contents?.at(-1)?.parts ?? []) {
            if (!functionResponse || functionResponse.name !== 'readChatHistory') continue
            contextResults.set(functionResponse.id, functionResponse.response.result)
            pageContinuationMs.set(functionResponse.id, receivedAt - pageRequestedAt.get(functionResponse.id)!)
          }
          const round = modelCalls.length
          if (phase === 'recent-page-foreign') {
            if (foreignWarmup) {
              if (round === 2) firstPageCursor = parseRecentPage(response('warmup')).nextCursor
              parts = round === 1 ? [contextCall('warmup')] : [{ text: 'Calibration notes are available.' }]
            } else parts = round === 1 ? [contextCall('foreign', { cursor: firstPageCursor! })] : [{ text: cursorRefused }]
          } else if (round === 1) {
            if (phase === 'recent-page') expect(await admitTelegramRecording({ integrationId, conversationId, assistantId,
              senderUserId: ownerId, providerMessageId: String(incomingId * 100 + 16), text: lateRecording })).toBeTruthy()
            parts = [contextCall('page-one')]
          } else if (round === 2 && phase === 'recent-page') {
            const first = parseRecentPage(response('page-one'))
            firstPageCursor = first.nextCursor
            parts = [contextCall('retry-page-one', { mode: 'recent_text' })]
          } else if (round === (phase === 'recent-page' ? 3 : 2)) {
            const first = parseRecentPage(response(phase === 'recent-page' ? 'retry-page-one' : 'page-one'))
            if (unlinkBeforeNextPage) {
              const linked = await linkedAccountStore.findByProvider('telegram', String(telegramSender))
              expect(linked?.userId).toBe(secondId)
              expect(await linkedAccountStore.deleteForUser(secondId, linked!.id)).toBe(true)
              paginationLinkRemoved = true
            }
            parts = [contextCall('page-two', { cursor: first.nextCursor })]
          } else if (round === 4 && phase === 'recent-page') {
            parts = [contextCall('retry-page-two', { mode: 'recent_text', cursor: firstPageCursor! })]
          } else if (round === 5 && phase === 'recent-page') {
            parts = [contextCall('invalid', { cursor: randomUUID() })]
          } else {
            const earlierContext = JSON.stringify(body.contents)
            const admitted = earlierContext.includes(originalCalibrationRequest) && earlierContext.includes(originalCalibrationAnswer)
            parts = [{ text: admitted ? paginationReply : 'I still need the original calibration request.' }]
          }
          for (const part of parts) {
            const id = (part as ReturnType<typeof contextCall>).functionCall?.id
            if (id) pageRequestedAt.set(id, performance.now())
          }
        } else if (boundedReference) {
          if (modelCalls.length === 1) {
            parts = [contextCall('bounded-reference')]
            historyToolRequestedAt = performance.now()
          } else {
            const page = parseRecentPage(response('bounded-reference'))
            const admitted = isForumAnchor ? !page.quote && page.messages.some(item => item.text === recentMarker)
              : page.quote?.status === 'available' && page.quote.text === retainedQuote
            if (phase === 'recent-quote-revoked' && admitted) {
              await holdRecent(quotedRowId!)
              quotedRowHeld = true
            }
            parts = [{ text: admitted ? expectedReply : quoteUnavailableReply }]
          }
        } else if (isRecent) {
          if (modelCalls.length === 1) {
            parts = [{functionCall:{name:'readChatHistory',id:'fixture-recent-text',
              args:incomingId===5402?{mode:'recent_text'}:{}},thoughtSignature:'fixture-recent-text-signature'}]
          } else if (recentThenFull && modelCalls.length === 2 && response('fixture-recent-text')?.includes(recentMarker)) {
            parts = [{functionCall:{name:'readChatHistory',id:'fixture-full-after-recent',args:{mode:'full'}},
              thoughtSignature:'fixture-full-after-recent-signature'}]
          } else {
            const admitted = recentThenFull
              ? Boolean(response('fixture-full-after-recent') && JSON.stringify(body.contents).includes(historicalAnswer))
              : response('fixture-recent-text')?.includes(recentMarker) === true
            if (phase === 'recent-delivery' && admitted) {
              await pool.query('UPDATE session_messages SET scope_held=true WHERE session_id=$1 AND id=$2',[sessionId,recentIds[0]])
              recentSelectionChanged = true
            }
            parts = [{text:admitted ? recentReply : 'Recent text unavailable.'}]
          }
        } else if (standaloneGuest) {
          parts = [{ text: knowledgeGuestReply }]
        } else if (standaloneLookup) {
          parts = modelCalls.length === 1
            ? [{ functionCall: { name: 'searchKnowledge', id: 'fixture-knowledge-query', args: { query: knowledgeQuery } },
              thoughtSignature: 'fixture-direct-knowledge-signature' }]
            : [{ text: response('fixture-knowledge-query')?.includes(knowledgeExpected) ? expectedReply : 'Knowledge evidence unavailable.' }]
        } else if (isKnowledge) {
          if (modelCalls.length === 1) {
            parts = [{ functionCall: { name: 'readChatHistory', id: 'fixture-knowledge-context', args: { mode: 'full' } },
              thoughtSignature: 'fixture-knowledge-context-signature' }]
          } else if (modelCalls.length === 2) {
            parts = [{ functionCall: { name: 'mcp_search', id: 'fixture-knowledge-discover', args: { query: 'search workspace knowledge base' } },
              thoughtSignature: 'fixture-knowledge-discovery-signature' }]
          } else if (modelCalls.length === 3 && /\[knowledge\]\s+searchKnowledge:/.test(response('fixture-knowledge-discover') ?? '')) {
            parts = [{ functionCall: { name: 'mcp_call', id: 'fixture-knowledge-query',
              args: { server: 'knowledge', tool: 'searchKnowledge', args: { query: knowledgeQuery } } }, thoughtSignature: 'fixture-knowledge-query-signature' }]
          } else {
            const admitted = response('fixture-knowledge-query')?.includes(knowledgeExpected) === true
            if (untrustedKnowledgeError && admitted) {
              res.status(400).json({ error: { status: 'INVALID_ARGUMENT', message: knowledgeProviderFailure } })
              return
            }
            if (knowledgeRevoked && admitted) await changeConfig({ ...config,
              deliveryAudienceBindings: config.deliveryAudienceBindings.map(binding => ({ ...binding, channelId: String(chat - 1) })),
            })
            if (holdKnowledgeSource && admitted) {
              const held = await pool.query<{ id: string }>(`UPDATE knowledge_entries SET scope_held=true
                WHERE workspace_id=$1 AND path='fictional-handbook/916' AND NOT scope_held RETURNING id`, [workspaceId])
              expect(held.rowCount).toBe(1)
              heldKnowledgeId = held.rows[0].id
            }
            parts = [{ text: admitted ? expectedReply : 'Knowledge evidence unavailable.' }]
          }
        } else if (phase === 'lookup') {
          const step = modelCalls.length - 1
          const previousResult = body.contents?.at(-1)?.parts
            .find(part => part.functionResponse?.id === lookupSteps[step - 1]?.id)?.functionResponse?.response.result
          // Demand evidence from each real tool result before issuing the
          // next call or composing a successful answer.
          const admitted = step === 0 || previousResult?.includes(lookupEvidence[step - 1])
          if (!admitted) parts = [{ text: 'The public lookup did not return the requested evidence.' }]
          else if (step < lookupSteps.length) {
            parts = [{ functionCall: lookupSteps[step], thoughtSignature: 'fixture-lookup-signature' }]
          } else parts = [{ text: lookupReply }]
        } else if (historyFailure) {
          const discovery = contextCall('fixture-context', { mode: 'full' })
          const unrelated = { functionCall: { name: 'calculate', args: { expression: 'not a calculation' }, id: 'fixture-other-call' }, thoughtSignature: 'fixture-other-signature' }
          if (phase === 'history-sibling-tool') parts = [unrelated, discovery]
          else if (phase === 'history-after-tool' && modelCalls.length === 1) parts = [unrelated]
          else parts = [discovery]
        } else if (phase === 'lookup-guest') {
          parts = [{ text: guestReply }]
        } else if (isFullHistory && modelCalls.length === 1) {
          parts = [contextCall('fixture-context', { mode: 'full' })]
          historyToolRequestedAt = performance.now()
        } else if (modelCalls.length === 1 && JSON.stringify(body.tools ?? []).includes('readChatHistory')) {
          parts = [contextCall('fixture-context', { mode: 'full' })]
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
          if (phase === 'mail-dispatch' && modelCalls.length === 1 && !revokedAtDispatch) {
            await pool.query('UPDATE connector_instance SET connected=false WHERE id=$1', [mailbox!.id])
            revokedAtDispatch = true
          }
          if (phase === 'recent-selection' && modelCalls.length === 1 && !recentSelectionChanged) {
            await pool.query('UPDATE session_messages SET scope_held=false WHERE session_id=$1 AND id=$2',[sessionId,recentIds[1]])
            recentSelectionChanged = true
          }
          if (revokeBeforeProvider && modelCalls.length === 2 && !recentSelectionChanged) {
            expect(pageRequestedAt.has('page-two')).toBe(true)
            if (phase === 'recent-page-provider-witness') {
              // Existing sources still qualify. Only the earlier page's exact selection changes.
              const restored = await pool.query('UPDATE session_messages SET scope_held=false WHERE session_id=$1 AND id=$2 AND scope_held',
                [sessionId, pageOneIds.at(-1)])
              expect(restored.rowCount).toBe(1)
            } else await holdRecent(pageOneIds[0])
            recentSelectionChanged = true
          }
          if (phase === 'headers' && !heldInputId) await holdPersistedInput()
          return { 'Content-Type': 'application/json' }
        }
      }))
    })
    app.use('/webhook/telegram', telegramByoRoutes({
      provider, configuredProviders: new Set(['gemini']),
      decisionRuntime: createDecisionRuntime({ llmProvider: provider, defaultLlmModel: standardGemini.alias }),
      systemPrompt: 'Answer the speaker using admitted evidence.', tools: lookupTools, memoryStore: createDbMemoryStore(),
      capabilityStore: createDbCapabilityStore(), integrationStore, linkedAccountStore, analytics,
      channelUserStore: createDbChannelUserStore(), apiUrl: origin, ...(isMail ? mailbox?.stores : {}), ...knowledgeStores,
    }))
    const delivered: string[] = []
    const knowledgeReplyTargets: { chatId: string; topicId?: number }[] = []
    const protectedReplyAttempts: { chatId: string; topicId?: number }[] = []
    const vanishedTopicAttempts: { chatId: string; topicId?: number }[] = []
    const guardedSendTargets: { chatId: string; topicId?: number }[] = []
    let failureNoticeAttempts = 0
    let attachmentDownloads = 0
    let messageId = incomingId * 10
    let replyReceiptId: string | undefined
    const network = globalThis.fetch
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === origin) {
        const response = await network(input, init)
        if (codexTimeout && url.pathname.startsWith('/model/') && response.status === 400) {
          await response.body?.cancel()
          const error = new CodexRpcTimeoutError('thread/start', { phase: 'input_authority',
            elapsedMs: { write_queue: 20000, input_authority: 10000, stdin_write: 0, awaiting_response: 0 } })
          error.name = knowledgeProviderFailure
          throw error
        }
        return response
      }
      if (url.origin === 'https://html.duckduckgo.com' && url.pathname === '/html/') {
        lookupNetwork.push('webSearch')
        expect(url.searchParams.get('q')).toBe(lookupSteps[0].args.query)
        return new Response(`<div class="result__body"><a class="result__a" href="${lookupUrl}">North Star Observatory admission</a></div>`)
      }
      if (url.href === lookupUrl) {
        lookupNetwork.push('urlReader')
        return new Response(`<html><head><title>North Star Observatory admission</title></head><body><article>
          <h1>North Star Observatory admission</h1><p>${lookupPage} Tickets include the telescope demonstration and guided visit.
          Admission is open to the public every Saturday, with the last visitor group entering one hour before closing.</p>
          </article></body></html>`, { headers: { 'Content-Type': 'text/html' } })
      }
      if (hasAttachment && url.origin === 'https://api.telegram.org' && url.pathname === `/file/bot${token}/${attachmentPath}`) {
        attachmentDownloads++
        return new Response(Buffer.from(attachmentImage, 'base64'), { headers: { 'content-type': 'image/png' } })
      }
      if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith('/bot' + token + '/')) throw new Error('Unexpected benchmark network destination')
      if (hasAttachment && url.pathname.endsWith('/getFile')) {
        expect(JSON.parse(String(init?.body))).toEqual({ file_id: attachmentFileId })
        return Response.json({ ok: true, result: { file_id: attachmentFileId, file_unique_id: attachmentFileId, file_path: attachmentPath } })
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = JSON.parse(String(init?.body))
        const target = { chatId: String(body.chat_id), topicId: body.message_thread_id }
        if (retryDelivery && body.text === expectedReply) {
          recentDeliveryAttempts.push({...target,parseMode:body.parse_mode})
          if (recentDeliveryAttempts.length === 1) {
            await holdRecent(isPagination ? pageOneIds[0] : recentIds[0])
            recentSelectionChanged = true
            return Response.json({ok:false,error_code:400,description:'Bad Request: can’t parse entities'},{status:400})
          }
        }
        if (knowledgeTopicMissing && body.text === expectedReply) {
          protectedReplyAttempts.push(target)
        }
        if (knowledgeTopicMissing && protectedReplyAttempts.length) {
          vanishedTopicAttempts.push(target)
          if (target.topicId === topic) return Response.json({
            ok: false, error_code: 400, description: 'Bad Request: message thread not found',
          }, { status: 400 })
        }
        if (isKnowledge || historyFailure) guardedSendTargets.push(target)
        if (untrustedKnowledgeError && body.text === guardedFailureNotice) {
          failureNoticeAttempts++
          if (rejectedFailureNotice) return Response.json({
            ok: false, error_code: 403, description: 'Forbidden: fictional Telegram refusal',
          }, { status: 403 })
        }
        delivered.push(body.text)
        messageId++
        if (body.text === expectedReply) {
          if (isKnowledge) knowledgeReplyTargets.push(target)
          if (isPagination) paginationReplyTargets.push(target)
          if (isFullHistory || boundedReference || hasAttachment) historyReplyTarget = target
          replyReceiptId = String(messageId)
          deliveredMs = performance.now() - ingress
        }
        return Response.json({ ok: true, result: { message_id: messageId, text: body.text } })
      }
      return Response.json({ ok: true, result: true })
    })
    const historyRead = isMail || phase === 'lookup' || standaloneLookup || standaloneGuest || isRecent ? vi.spyOn(conversationStore, 'readAdmittedSessionQuery') : undefined
    const pageRead = isPagination || isRecordingLock ? vi.spyOn(turnHistory, 'readRecentChannelText') : undefined
    const pageSelect = unlinkBeforeNextPage ? vi.spyOn(verifiedChannelRecord, 'selectVerifiedChannelRecentText') : undefined
    const recordRead = isMail || phase === 'lookup' || standaloneLookup || standaloneGuest || historyFailure || isRecent
      ? vi.spyOn(conversationAdmission, 'tryReadTurnConversationRecord') : undefined
    const originalQuery = pg.Client.prototype.query
    const rejectedCaptures: unknown[][] = []
    const captureStatement = phase === 'history-topic-failure'
      ? 'SELECT capture_conversation_query($1,$2,NULL,$3) AS value'
      : 'SELECT capture_conversation_query($1,$2,$3,$4) AS value'
    const captureSpy = historyFailure ? vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: unknown[]) {
      if (modelCalls.length && args[0] === captureStatement && Array.isArray(args[1]) && args[1][1] === sessionId) {
        rejectedCaptures.push(args[1])
        return Reflect.apply(originalQuery, this, [`DO $$BEGIN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END$$`])
      }
      return Reflect.apply(originalQuery, this, args)
    } as typeof originalQuery) : undefined
    if (historyFailure) recordRead!.mockResolvedValue(null)
    const linkRead = vi.spyOn(linkedAccountStore, 'findByProvider')
    configureTelegramTextDeliveryObserver(recordDeliveredTelegramMessage)
    try {
      if (phase === 'recent-quote-held') {
        await holdRecent(quotedRowId!)
        quotedRowHeld = true
      }
      if (phase === 'unlinked') await changeConfig({ ...config, userAccessMode: 'allowlist' })
      if (phase === 'lookup-guest' || standaloneGuest) await changeConfig({ ...config, userAccessMode: 'allowlist', allowedUserIds: [String(unlinkedSender)] })
      if (knowledgeUnbound) await changeConfig({ ...config, deliveryAudienceBindings: [] })
      const postTelegram = (id: number, text: string) => network(origin + '/webhook/telegram/' + channelId, {
        method: 'POST', headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'fictional-hook'
        }, body: JSON.stringify({
          update_id: 7000 + id, message: {
            message_id: id,
            ...(knowledgeDm ? { chat: { id: telegramSender, type: 'private', first_name: 'Observer' } } : {
              message_thread_id: topic, is_topic_message: true, chat: { id: chat, type: 'supergroup', is_forum: true, title: 'Fictional observatory' },
            }),
            ...(isFullReply || boundedReference ? { reply_to_message: {
              message_id: isForumAnchor ? topic : (isFullReply ? rows - 1 : quoteSequence) + 1000,
              message_thread_id: topic, is_topic_message: true,
              chat: { id: chat, type: 'supergroup', is_forum: true, title: 'Fictional observatory' },
              from: (isFullReply ? rows - 1 : quoteSequence) % 2 === 0 ? { id: Number(botId), first_name: 'Observatory bot', is_bot: true }
                : { id: sender, first_name: 'Observer', is_bot: false },
              date: Math.floor(Date.now() / 1000) - 60,
              ...(isForumAnchor ? { forum_topic_created: { name: 'Fictional calibration' } }
                : { text: isFullReply ? retainedText(rows - 1) : providerQuotePreview }),
            } } : {}),
            from: { id: telegramSender, first_name: 'Observer', is_bot: false }, date: Math.floor(Date.now() / 1000),
            ...(hasAttachment ? { caption: text, document: { file_id: attachmentFileId, mime_type: 'image/png', file_name: 'calibration.png' } } : { text }),
          }
        })
      })
      if (foreignWarmup) {
        const warmup = await postTelegram(incomingId + 100, 'What did we just discuss about calibration?')
        expect(warmup.status).toBe(200)
        await vi.waitFor(async () => {
          expect(firstPageCursor).toEqual(expect.any(String))
          expect(delivered).toContain('Calibration notes are available.')
          const { rows: [active] } = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          expect(active).toEqual({ status: 'idle', turn_lease_token: null })
        }, { timeout: 15_000, interval: 100 })
        modelCalls.length = 0
        delivered.length = 0
        foreignWarmup = false
      }
      const result = await postTelegram(incomingId, authored)
      expect(result.status).toBe(200)
      await vi.waitFor(() => expect(linkRead).toHaveBeenCalledWith('telegram', String(telegramSender)))
      if (isFullHistory) {
        const terminal = await vi.waitFor(async () => {
          expect(modelCalls.length).toBeGreaterThan(0)
          const { rows: [session] } = await pool.query<{ status: string; turn_lease_token: string | null }>(
            'SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          expect(session.turn_lease_token).toBeNull()
          expect(session.status).not.toBe('running')
          return session
        }, { timeout: 120_000, interval: 100 })
        await analytics!.flush()
        const { rows: [event] } = await pool.query<{ event_name: string; metadata: Record<string, number | string> }>(`SELECT event_name,metadata
          FROM analytics_events WHERE session_id=$1 AND event_name IN ('turn_completed','chat_route_error')
          AND created_at >= (SELECT created_at FROM session_messages WHERE session_id=$1 AND channel_message_id=$2)
          ORDER BY created_at DESC LIMIT 1`, [sessionId, String(incomingId)])
        expect(event).toBeDefined()
        const metrics = event.metadata
        console.info('[Telegram signed full history]', JSON.stringify({ stats, status: terminal.status, modelRequests: modelCalls.length,
          contextDiscoveryMs: metrics.context_discovery_ms, classificationCaptureMs: metrics.classification_capture_ms,
          topicPublishMs: metrics.context_topic_publish_ms, historyReadMs: metrics.context_history_ms, compactionMs: metrics.context_compaction_ms,
          continuationMs: historyContinuationMs, errorType: metrics.error_type, receipt: replyReceiptId !== undefined }))
        expect(metrics.context_discovery_count).toBe(1)
        expect(metrics.classification_capture_count).toBe(1)
        expect(metrics.context_recent_text_count ?? 0).toBe(0)
        if (isFullReply) expect(JSON.stringify(modelCalls[0].body.systemInstruction)).toContain('This message has a conversation reference')
        expect(JSON.stringify(modelCalls[0].body.tools)).toContain('recent_text')
        expect(terminal.status).toBe('idle')
        expect(event.event_name).toBe('turn_completed')
        expect(modelCalls[1].body.contents?.flatMap(message => message.parts)).toContainEqual(
          expect.objectContaining({ functionCall: expect.objectContaining({ id: 'fixture-context', args: { mode: 'full' } }) }))
        expect(historyReplyTarget).toEqual({ chatId: String(chat), topicId: topic })
      }
      if (phase === 'recent-quote-revoked') {
        await vi.waitFor(async () => {
          expect(quotedRowHeld).toBe(true)
          const { rows: [active] } = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          expect(active).toEqual({ status: 'failed', turn_lease_token: null })
        }, { interval: 100, timeout: 15_000 })
        expect(modelCalls).toHaveLength(2)
        expect(JSON.stringify(modelCalls[1].body)).toContain(retainedQuote)
        expect(JSON.stringify(modelCalls)).not.toContain(providerQuotePreview)
        expect(delivered.join('\n')).not.toContain(retainedQuote)
        expect(delivered).not.toContain(quoteAnswer)
        expect(replyReceiptId).toBeUndefined()
        return
      }
      if (historyFailure) {
        const notice = historyBeforeAction ? historyUnavailableNotice : guardedFailureNotice
        // The topic failure follows full discovery. Wait for this turn to release
        // its lock before restoring the shared transport and capture fakes.
        const terminal = await vi.waitFor(async () => {
          expect(modelCalls.length).toBeGreaterThan(0)
          const { rows: [session] } = await pool.query(`SELECT status,turn_lease_token,
            EXISTS(SELECT 1 FROM chat_turn_locks WHERE chat_key=$2) AS locked FROM sessions WHERE id=$1`,
          [sessionId, `tg-byo:${conversationId}`])
          expect(session).toMatchObject({ turn_lease_token: null, locked: false })
          return session
        }, { interval: 100, timeout: 180_000 })
        expect(terminal).toEqual({ status: 'failed', turn_lease_token: null, locked: false })
        expect(delivered).toContain(notice)
        expect(rejectedCaptures).toHaveLength(1)
        expect(modelCalls).toHaveLength(phase === 'history-after-tool' ? 2 : 1)
        if (phase !== 'history-topic-failure') expect(backgroundCalls).toEqual([])
        expect(delivered.filter(text => text.includes('I could not finish') || text.includes('I couldn’t load'))).toEqual([notice])
        expect(delivered.join('\n')).not.toContain('scope_ancestry_unavailable')
        expect(delivered.join('\n')).not.toContain(historicalAnswer)
        expect(guardedSendTargets.every(target => target.chatId === String(chat) && target.topicId === topic)).toBe(true)
        return
      }
      if (knowledgeUnbound) {
        await vi.waitFor(() => expect(delivered.join('\n')).toMatch(/can't show the result in this chat|group is not approved for workspace replies/i),
          { timeout: 15_000 })
        expect(modelCalls).toHaveLength(0)
        expect(knowledgeFieldIds).toHaveLength(0)
        expect(knowledgeReplyTargets).toEqual([])
        return
      }
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
      if (phase === 'lookup-guest') {
        await vi.waitFor(() => expect(delivered).toContain(guestReply), { interval: 100, timeout: 15_000 })
        expect(await linkRead.mock.results[0].value).toBeNull()
        expect(modelCalls).toHaveLength(1)
        for (const { name } of lookupSteps) expect(JSON.stringify(modelCalls[0].body.tools ?? [])).not.toContain(name)
        expect(JSON.stringify(modelCalls[0].body.contents)).not.toContain(historicalAnswer)
        expect(lookupNetwork).toEqual([])
        return
      }
      if (standaloneGuest) {
        await vi.waitFor(async () => {
          expect(delivered).toContain(knowledgeGuestReply)
          const { rows: [active] } = await pool.query<{ count: number; locked: boolean }>(`SELECT count(*)::int AS count,
            EXISTS(SELECT 1 FROM chat_turn_locks WHERE chat_key=$2) AS locked FROM sessions
            WHERE assistant_id=$1 AND channel_type='telegram' AND (status='running' OR turn_lease_token IS NOT NULL)`,
          [assistantId, `tg-byo:${conversationId}`])
          expect(active).toEqual({ count: 0, locked: false })
        }, { interval: 100, timeout: 15_000 })
        expect(await linkRead.mock.results[0].value).toBeNull()
        expect(modelCalls).toHaveLength(1)
        expect(JSON.stringify(modelCalls[0].body.tools ?? [])).not.toContain('searchKnowledge')
        expect(JSON.stringify(modelCalls[0].body)).not.toContain(knowledgeTitle)
        expect(knowledgeFieldIds).toHaveLength(0)
        expect(historyRead).not.toHaveBeenCalled()
        expect(recordRead).not.toHaveBeenCalled()
        return
      }
      if (phase === 'mail-release' || phase === 'mail-dispatch') {
        await vi.waitFor(async () => {
          if (phase === 'mail-dispatch') expect(revokedAtDispatch).toBe(true)
          expect(modelCalls).toHaveLength(phase === 'mail-dispatch' ? 1 : 2)
          const session = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          expect(session.rows[0].turn_lease_token).toBeNull()
          expect(session.rows[0].status).not.toBe('running')
        }, { interval: 50, timeout: 15_000 })
        expect(replyReceiptId).toBeUndefined()
        expect(JSON.stringify(delivered)).not.toContain(mailSubject)
        return
      }
      if (phase === 'recording-lock-timeout' || phase === 'recording-lock-audience') {
        await vi.waitFor(() => {
          expect(observedChannelWait).toBeDefined()
          expect(pageRead).toHaveBeenCalledTimes(1)
        }, { interval: 50, timeout: 15_000 })
        await observedChannelWait
        const read = pageRead!.mock.results[0]
        if (read.type !== 'return') throw new Error('The retained-text read did not execute.')
        if (phase === 'recording-lock-timeout') {
          await expect(read.value).rejects.toMatchObject({ code: 'context_verification_unavailable', verificationFailure: 'lock_timeout' })
          // The failure-notice path still needs to check the destination's live authority.
          await channelHolder!.query('ROLLBACK')
          channelHolder!.release()
          channelHolder = undefined
        } else await expect(read.value).rejects.toThrow()
        await vi.waitFor(async () => {
          const { rows: [active] } = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          expect(active).toEqual({ status: 'failed', turn_lease_token: null })
        }, { interval: 50, timeout: 15_000 })
        expect(modelCalls).toHaveLength(1)
        expect(delivered.join('\n')).not.toContain(recentMarker)
        expect(replyReceiptId).toBeUndefined()
        return
      }
      if (phase === 'recent-selection' || phase === 'recent-delivery' || phase === 'recent-delivery-retry'
        || revokeBeforeProvider || phase === 'recent-page-delivery' || unlinkBeforeNextPage) {
        await vi.waitFor(async () => {
          expect(recentSelectionChanged || paginationLinkRemoved).toBe(true)
          const active = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[sessionId])
          expect(active.rows[0]).toEqual({status:'failed',turn_lease_token:null})
        },{interval:100,timeout:15_000})
        expect(modelCalls).toHaveLength(phase === 'recent-selection' ? 1 : phase === 'recent-page-delivery' ? 3 : 2)
        if (retryDelivery) expect(recentDeliveryAttempts).toEqual([{chatId:String(chat),topicId:topic,parseMode:'HTML'}])
        if (isPagination) {
          expectRecentPage(parseRecentPage(contextResults.get('page-one')),
            phase === 'recent-page-provider-witness' ? paginationNewer.slice(0, -1) : paginationNewer)
          if (phase === 'recent-page-delivery') expectRecentPage(parseRecentPage(contextResults.get('page-two')), paginationOlder)
          else if (unlinkBeforeNextPage) {
            expect(contextResults.has('page-two')).toBe(false)
            expect(await linkedAccountStore.findByProvider('telegram', String(telegramSender))).toBeNull()
            expect((await pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, secondId])).rowCount).toBe(1)
            expect((await pool.query('SELECT config FROM channel_integrations WHERE id=$1', [integrationId])).rows[0].config).toMatchObject(config)
            const firstBoundary = pageSelect!.mock.calls[0]?.[1].beforeSequence
            expect(firstBoundary).toEqual(expect.any(Number))
            for (const [index, [, window]] of pageSelect!.mock.calls.entries()) {
              if (window.beforeSequence === firstBoundary) continue
              const selection = pageSelect!.mock.results[index]
              if (selection.type !== 'return') throw new Error('The continuation selector did not resolve normally.')
              await expect(selection.value).rejects.toMatchObject({ code: 'scope_source_changed' })
            }
          } else {
            expect(contextResults.has('page-two')).toBe(false)
            const read = pageRead!.mock.results[1]
            if (read.type !== 'return') throw new Error('Page two did not finish reading.')
            const secondPage = await read.value
            expect(secondPage.messages?.map(({ text }) => text)).toEqual(paginationOlder)
          }
          if (!unlinkBeforeNextPage) expect(pageRead).toHaveBeenCalledTimes(2)
          expect(delivered.join('\n')).not.toContain(originalCalibrationAnswer)
          expect(paginationReplyTargets).toEqual([])
          expect(historyRead).not.toHaveBeenCalled()
          expect(recordRead).not.toHaveBeenCalled()
        }
        expect(JSON.stringify(modelCalls)).not.toContain(withheldRecentMarker)
        expect(JSON.stringify(delivered)).not.toContain(recentMarker)
        expect(replyReceiptId).toBeUndefined()
        const withheldReply = await pool.query(`SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant'
          AND content=$2::jsonb AND sequence_num>(SELECT sequence_num FROM session_messages WHERE session_id=$1 AND channel_message_id=$3)`,
        [sessionId,JSON.stringify([{type:'text',text:expectedReply}]),String(incomingId)])
        expect(withheldReply.rows).toEqual([])
        expect(backgroundCalls).toEqual([])
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
        if (phase === 'member') {
          expect(JSON.stringify(modelCalls[0].body.tools)).toContain('webSearch')
          expect(lookupNetwork).toEqual([])
        }
        expect(JSON.stringify(delivered)).not.toContain(heldAnswer)
        const leaked = await pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant' AND content::text LIKE $2", [sessionId, '%' + heldAnswer + '%'])
        expect(leaked.rows).toHaveLength(0)
        return
      }
      async function expectKnowledgeQueryProof() {
        const domains = await pool.query<{ kind: string; digest: string }>(`SELECT d.domain->>'kind' AS kind,d.domain->>'digest' AS digest
          FROM application_field_resources r JOIN application_query_domains d ON d.workspace_id=r.workspace_id AND d.id=r.resource_id
          WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.selection='query_domain'`, [workspaceId, knowledgeFieldIds])
        expect(domains.rows).toEqual(knowledgeControl ? [{ kind: 'knowledge_query_domain_v1', digest: null }]
          : [{ kind: 'knowledge_search_domain_v1', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }])
      }
      function expectKnowledgeModelResult() {
        expect(JSON.stringify(modelCalls)).not.toContain(heldKnowledgeTitle)
        if (!knowledgeDm) expect(JSON.stringify(modelCalls)).not.toContain(projectKnowledgeTitle)
        const admittedResult = modelCalls[knowledgeModelResultRound].body.contents?.at(-1)?.parts
          .find(part => part.functionResponse?.id === 'fixture-knowledge-query')
        expect(admittedResult?.functionResponse?.name).toBe(standaloneLookup ? 'searchKnowledge' : 'mcp_call')
        expect(admittedResult?.functionResponse?.response.result).toContain(knowledgeExpected)
        expect(knowledgeStoreStartedAt).toBeDefined()
        expect(knowledgeStoreCompletedAt).toBeDefined()
        console.info('[Telegram Knowledge model admission]', {
          phase,
          storeMs: Math.round(knowledgeStoreCompletedAt! - knowledgeStoreStartedAt!),
          storeStartToModelAdmissionMs: Math.round(ingress + modelCalls[knowledgeModelResultRound].elapsedMs - knowledgeStoreStartedAt!),
          toolAndAdmissionMs: Math.round(modelCalls[knowledgeModelResultRound].elapsedMs - modelCalls[knowledgeModelResultRound - 1].elapsedMs),
        })
      }
      if (knowledgeControl || knowledgeRevoked || holdKnowledgeSource || knowledgeTopicMissing || untrustedKnowledgeError) {
        await vi.waitFor(async () => {
          if (knowledgeRevoked) expect(configChanged).toBe(true)
          if (holdKnowledgeSource) expect(heldKnowledgeId).toBeDefined()
          if (knowledgeTopicMissing) expect(protectedReplyAttempts.length).toBeGreaterThan(0)
          const session = await pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [sessionId])
          if (untrustedKnowledgeError) {
            expect(failureNoticeAttempts).toBeGreaterThan(0)
            expect(['idle', 'failed']).toContain(session.rows[0].status)
            expect(session.rows[0].turn_lease_token).toBeNull()
          } else expect(session.rows[0]).toEqual({ status: 'failed', turn_lease_token: null })
        }, { interval: 100, timeout: 180_000 })
        await expectKnowledgeQueryProof()
        if (!knowledgeControl) expect(modelCalls).toHaveLength(4)
        else expect([3, 4]).toContain(modelCalls.length)
        if (modelCalls.length === 4) expectKnowledgeModelResult()
        expect(delivered).not.toContain(expectedReply)
        expect(replyReceiptId).toBeUndefined()
        expect(knowledgeReplyTargets).toEqual([])
        if (knowledgeRevoked) expect(guardedSendTargets.map(target => target.chatId)).not.toContain(String(chat - 1))
        if (knowledgeTopicMissing) {
          expect(protectedReplyAttempts).toEqual([{ chatId: String(chat), topicId: topic }])
          expect(vanishedTopicAttempts.every(target => target.chatId === String(chat) && target.topicId === topic)).toBe(true)
        }
        if (untrustedKnowledgeError) {
          const terminal = await vi.waitFor(async () => {
            const { rows: [state] } = await pool.query(`SELECT status,turn_end_reason,
              turn_lease_token IS NULL AS lease_released,
              NOT EXISTS(SELECT 1 FROM chat_turn_locks WHERE chat_key=$2) AS lock_released
              FROM sessions WHERE id=$1`, [sessionId, `tg-byo:${conversationId}`])
            expect(state.lease_released).toBe(true)
            expect(state.lock_released).toBe(true)
            return state
          }, { interval: 50, timeout: 5_000 })
          expect(terminal).toEqual({ status: 'failed', turn_end_reason: 'failed', lease_released: true, lock_released: true })
          expect(failureNoticeAttempts).toBe(1)
          expect(delivered.filter(text => text === guardedFailureNotice)).toHaveLength(rejectedFailureNotice ? 0 : 1)
          expect(delivered.join('\n')).not.toContain(knowledgeProviderFailure)
          expect(guardedSendTargets.every(target => target.chatId === String(chat) && target.topicId === topic)).toBe(true)
          const { rows: recordedReplies } = await pool.query(`SELECT content FROM session_messages
            WHERE session_id=$1 AND role='assistant'
              AND sequence_num > (SELECT sequence_num FROM session_messages WHERE session_id=$1 AND channel_message_id=$2)`,
          [sessionId, String(incomingId)])
          expect(recordedReplies).toEqual(rejectedFailureNotice ? [] : [{ content: [{ type: 'text', text: guardedFailureNotice }] }])
          await analytics!.flush()
          const { rows: events } = await pool.query(`SELECT event_name,metadata FROM analytics_events
            WHERE session_id=$1 AND event_name IN ('turn_completed','chat_route_error')
              AND created_at >= (SELECT created_at FROM session_messages WHERE session_id=$1 AND channel_message_id=$2)`,
          [sessionId, String(incomingId)])
          expect(events).toEqual([{
            event_name: 'chat_route_error',
            metadata: expect.objectContaining({
              stage: 'query_loop', error_source: 'yielded', context_discovery_count: 1,
              ...(codexTimeout ? {
                error_type: 'CodexRpcTimeoutError', provider_error_category: 'codex_rpc_timeout',
                codex_rpc_method: 'thread/start', codex_rpc_phase: 'input_authority', codex_rpc_write_queue_ms: 20000,
                codex_rpc_input_authority_ms: 10000, codex_rpc_stdin_write_ms: 0, codex_rpc_awaiting_response_ms: 0,
              } : { error_type: 'ProviderError', provider_error_category: 'invalid_argument', provider_http_status: 400 }),
            }),
          }])
          if (codexTimeout) expect(events[0].metadata).not.toHaveProperty('provider_http_status')
          expect(events[0].metadata.total_ms).toBeGreaterThan(0)
          expect(events[0].metadata.audience_check_count).toBeGreaterThan(0)
          expect(events[0].metadata.context_discovery_ms).toBeGreaterThan(0)
          expect(events[0].metadata).not.toHaveProperty('channel_reply_receipt_at_ms')
          expect(JSON.stringify(events)).not.toContain(knowledgeProviderFailure)
        }
        return
      }
      let receivingSessionId = sessionId
      let receivingFailed = false
      await vi.waitFor(async () => {
        if (knowledgeDm) {
          const { rows: [direct] } = await pool.query<{ id: string }>(`SELECT id FROM sessions
            WHERE workspace_id=$1 AND assistant_id=$2 AND channel_type='telegram' AND channel_id=$3`,
          [workspaceId, assistantId, String(telegramSender)])
          expect(direct?.id).toBeDefined()
          receivingSessionId = direct.id
        }
        const row = (await pool.query(`SELECT s.status, (SELECT count(*)::int FROM session_messages m WHERE m.session_id=s.id AND m.sequence_num>$2) added
           FROM sessions s WHERE s.id=$1`, [receivingSessionId, knowledgeDm ? 0 : rows])).rows[0]
        if (row.status === 'failed') {
          receivingFailed = true
          return
        }
        expect(delivered.length).toBeGreaterThan(0)
        expect(row.status).toBe('idle')
        expect(row.added).toBeGreaterThanOrEqual(2)
      }, { interval: 250, timeout: 180_000 })
      if (receivingFailed) {
        if (!isKnowledge) throw new Error(`Telegram ${phase} turn failed after ${modelCalls.length} main model requests.`)
        const latest = modelCalls.at(-1)?.body.contents?.at(-1)?.parts.find(part => part.functionResponse?.id === 'fixture-knowledge-query')
        await analytics?.flush()
        const { rows: [latestError] } = await pool.query(`SELECT metadata FROM analytics_events
          WHERE session_id=$1 AND event_name='chat_route_error' ORDER BY created_at DESC LIMIT 1`, [receivingSessionId])
        throw new Error(`Telegram Knowledge turn failed after ${modelCalls.length} model requests. ${latest?.functionResponse?.response.result ?? ''}
          ${JSON.stringify(latestError?.metadata ?? {})}`)
      }
      expect(modelCalls, isKnowledge ? JSON.stringify({ tools: modelCalls[1]?.body.tools,
        response: modelCalls[2]?.body.contents?.at(-1)?.parts }) : undefined)
        .toHaveLength(phase === 'lookup' ? lookupSteps.length + 1 : isKnowledge ? knowledgeModelResultRound + 1
          : phase === 'recent-page' ? 6 : recentThenFull || phase === 'recent-page-empty' ? 3 : 2)
      expect(deliveredMs, JSON.stringify({ delivered, toolResponse: modelCalls.at(-1)?.body.contents?.at(-1)?.parts })).toBeDefined()
      console.info('[Telegram first dispatch]', JSON.stringify({
        phase, incomingId, stats, mainMs: modelCalls.map(row => Math.round(row.elapsedMs)),
        betweenMainMs: Math.round(modelCalls[1].elapsedMs - modelCalls[0].elapsedMs),
        sqlCallsSinceBaseline: before ? modelCalls.map(row => row.sqlCalls) : undefined,
        deliveredMs: Math.round(deliveredMs!),
        ...(standaloneLookup ? { retainedHistoryReads: historyRead?.mock.calls.length, retainedRecordReads: recordRead?.mock.calls.length } : {}),
        backgroundMs: backgroundCalls.map(Math.round), delivered: delivered.includes(expectedReply)
      }))
      expect(modelCalls[0].elapsedMs).toBeLessThan(10_000)
      expect(backgroundCalls.every(time => time > modelCalls[0].elapsedMs)).toBe(true)
      expect(JSON.stringify(modelCalls[0].body.contents)).toContain(phase === 'choice' ? choice : authored)
      expect(JSON.stringify(modelCalls)).not.toContain(privateMarker)
      expect(delivered).toContain(expectedReply)
      expect(replyReceiptId).toBeDefined()
      const stored = await pool.query("SELECT content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2 AND role='assistant'", [receivingSessionId, replyReceiptId])
      expect(stored.rows).toEqual([{ content: [{ type: 'text', text: expectedReply }] }])
      if (hasAttachment) {
        expect(attachmentDownloads).toBe(1)
        for (const call of modelCalls) {
          expect(call.body.contents?.flatMap(message => message.parts)).toContainEqual({
            inlineData: { mimeType: 'image/png', data: attachmentImage },
          })
        }
        expect(historyReplyTarget).toEqual({ chatId: String(chat), topicId: topic })
      }
      if (boundedReference) {
        const reply = modelCalls[1].body.contents?.at(-1)?.parts
          .find(part => part.functionResponse?.id === 'bounded-reference')?.functionResponse
        const page = parseRecentPage(reply?.response.result)
        expect(reply?.name).toBe('readChatHistory')
        expect(page.messages).toHaveLength(7)
        expect(page.messages.map(message => message.text)).toContain(recentMarker)
        expect(page.messages.map(message => message.text)).not.toContain(retainedQuote)
        expect(page.quote).toEqual(isForumAnchor ? undefined : phase === 'recent-quote-held'
          ? { status: 'unavailable' }
          : { status: 'available', role: quoteSequence % 2 === 0 ? 'assistant' : 'user', text: retainedQuote })
        expect(JSON.stringify(modelCalls[0].body)).not.toContain(retainedQuote)
        expect(JSON.stringify(modelCalls)).not.toContain(providerQuotePreview)
        expect(historyReplyTarget).toEqual({ chatId: String(chat), topicId: topic })
        expect(historyRead).not.toHaveBeenCalled()
        expect(recordRead).not.toHaveBeenCalled()
        expect(backgroundCalls).toEqual([])
        await analytics!.flush()
        const { rows: [completion] } = await pool.query<{ metadata: Record<string, number> }>(`SELECT metadata FROM analytics_events
          WHERE session_id=$1 AND event_name='turn_completed'
          AND created_at >= (SELECT created_at FROM session_messages WHERE session_id=$1 AND channel_message_id=$2)`, [sessionId, String(incomingId)])
        expect(completion.metadata.context_recent_text_count).toBe(1)
        expect(completion.metadata.context_discovery_count ?? 0).toBe(0)
        console.info('[Telegram signed bounded history]', {
          phase, contextRecentTextMs: completion.metadata.context_recent_text_ms, continuationMs: historyContinuationMs,
          receiptMs: Math.round(deliveredMs!),
        })
        if (denseFullHistory) expect(historyContinuationMs).toBeLessThan(1000)
        return
      }
      if (isPagination) {
        expect(historyRead).not.toHaveBeenCalled()
        expect(recordRead).not.toHaveBeenCalled()
        expect(backgroundCalls).toEqual([])
        expect(pageRead).toHaveBeenCalledTimes(phase === 'recent-page-foreign' ? 1 : 2)
        expect(paginationReplyTargets).toEqual([{ chatId: String(chat), topicId: topic }])
        const firstRequest = JSON.stringify(modelCalls[0].body)
        expect(firstRequest).not.toContain(originalCalibrationRequest)
        expect(firstRequest).not.toContain(paginationNewer[0])
        expect(JSON.stringify(modelCalls[0].body.tools)).toContain('cursor')
        if (phase === 'recent-page-foreign') {
          expect(firstPageCursor).toEqual(expect.any(String))
          expect(contextResults.get('foreign')).toMatch(/cursor/i)
          expect(contextResults.get('foreign')).not.toContain('"messages"')
          expect(JSON.stringify(modelCalls)).not.toContain(originalCalibrationAnswer)
          return
        }
        const first = parseRecentPage(contextResults.get('page-one'))
        if (phase === 'recent-page-empty') {
          expect(first.messages).toEqual([])
          expect(first.nextCursor).toEqual(expect.any(String))
        } else expectRecentPage(first, paginationNewer)
        const second = parseRecentPage(contextResults.get('page-two'))
        expectRecentPage(second, paginationOlder)
        expect(second.nextCursor).not.toEqual(first.nextCursor)
        expect(JSON.stringify(modelCalls.slice(0, phase === 'recent-page' ? 3 : 2))).not.toContain(originalCalibrationRequest)
        if (phase === 'recent-page') {
          const { rows: [bounds] } = await pool.query<{ authored: number; later: number }>(`SELECT
            max(sequence_num) FILTER (WHERE channel_message_id=$2) AS authored,
            max(sequence_num) FILTER (WHERE channel_message_id=$3) AS later FROM session_messages WHERE session_id=$1`,
          [sessionId, String(incomingId), String(incomingId * 100 + 16)])
          expect(bounds.later).toBeGreaterThan(bounds.authored)
          expect(JSON.stringify(modelCalls)).not.toContain(lateRecording)
          expect(parseRecentPage(contextResults.get('retry-page-one'))).toEqual(first)
          expect(parseRecentPage(contextResults.get('retry-page-two'))).toEqual(second)
          expect(contextResults.get('invalid')).toMatch(/cursor/i)
          expect(contextResults.get('invalid')).not.toContain('"messages"')
        }
        console.info('[Telegram paged context readiness]', {
          phase, pageOneMs: Math.round(pageContinuationMs.get('page-one')!), pageTwoMs: Math.round(pageContinuationMs.get('page-two')!),
        })
        return
      }
      if (phase === 'recent-text' || phase === 'recent-attachment' || recentThenFull || phase === 'recording-lock-release') {
        if (phase === 'recording-lock-release') {
          expect(observedChannelWait).toBeDefined()
          await observedChannelWait
          expect(pageRead).toHaveBeenCalledTimes(1)
        }
        const result = modelCalls[1].body.contents?.at(-1)?.parts.find(part=>part.functionResponse?.id==='fixture-recent-text')?.functionResponse
        expect(result).toMatchObject({name:'readChatHistory',response:{result:expect.stringContaining(recentMarker)}})
        expect(JSON.stringify(modelCalls[0].body.tools)).toContain('recent_text')
        expect(JSON.stringify(modelCalls[1].body.tools)).toContain('full')
        expect(JSON.stringify(modelCalls[0].body)).not.toContain(recentMarker)
        expect(JSON.stringify(modelCalls)).not.toContain(withheldRecentMarker)
        expect(JSON.stringify(modelCalls.slice(0,2))).not.toContain('Fictional observatory log entry 1.')
        expect(modelCalls[1].elapsedMs-modelCalls[0].elapsedMs).toBeLessThan(10_000)
        await analytics!.flush()
        const {rows:[completion]} = await pool.query<{metadata:Record<string,number>}>(`SELECT metadata FROM analytics_events
          WHERE session_id=$1 AND event_name='turn_completed'
            AND created_at >= (SELECT created_at FROM session_messages WHERE session_id=$1 AND channel_message_id=$2)`,[sessionId,String(incomingId)])
        expect(completion.metadata.context_recent_text_count).toBe(1)
        expect(completion.metadata.context_recent_text_ms).toBeGreaterThan(0)
        expect(completion.metadata.context_discovery_count ?? 0).toBe(recentThenFull ? 1 : 0)
        console.info('[Telegram context capture timing]', {
          phase, recentMs: completion.metadata.context_recent_text_ms, fullMs: completion.metadata.context_discovery_ms,
        })
        if (recentThenFull) {
          expect(JSON.stringify(modelCalls.slice(0,2))).not.toContain(historicalAnswer)
          const continuation = modelCalls[2].body.contents ?? []
          expect(JSON.stringify(continuation)).toContain(historicalAnswer)
          for (const id of ['fixture-recent-text','fixture-full-after-recent']) {
            const index = continuation.findIndex(message=>message.parts.some(part=>part.functionCall?.id===id))
            expect(index).toBeGreaterThanOrEqual(0)
            expect(continuation[index+1]?.parts.map(part=>part.functionResponse?.id)).toContain(id)
          }
        } else {
          expect(historyRead).not.toHaveBeenCalled()
          expect(recordRead).not.toHaveBeenCalled()
          expect(backgroundCalls).toEqual([])
        }
        return
      }
      if (isKnowledge) {
        await expectKnowledgeQueryProof()
        expectKnowledgeModelResult()
        expect(knowledgeReplyTargets).toEqual([knowledgeDm ? { chatId: String(telegramSender) } : { chatId: String(chat), topicId: topic }])
        if (standaloneLookup) {
          expect(deliveredMs).toBeLessThan(60_000)
          expect(historyRead).not.toHaveBeenCalled()
          expect(recordRead).not.toHaveBeenCalled()
          expect(JSON.stringify(modelCalls[0].body.tools)).toContain('searchKnowledge')
          expect(JSON.stringify(modelCalls[0].body.tools)).not.toContain('mcp_search')
          expect(JSON.stringify(modelCalls.map(call => call.body.contents))).not.toContain(historicalAnswer)
        }
        return
      }
      if (phase === 'lookup') {
        expect(deliveredMs).toBeLessThan(60_000)
        expect(historyRead).not.toHaveBeenCalled()
        expect(recordRead).not.toHaveBeenCalled()
        expect(lookupNetwork).toEqual(['webSearch', 'urlReader'])
        expect(JSON.stringify(modelCalls)).not.toContain(historicalAnswer)
        await analytics!.flush()
        const { rows: [completion] } = await pool.query<{ metadata: {
          context_discovery_count?: number, channel_reply_receipt_at_ms?: number
        } }>("SELECT metadata FROM analytics_events WHERE session_id=$1 AND event_name='turn_completed' ORDER BY created_at DESC LIMIT 1", [sessionId])
        expect(completion.metadata.context_discovery_count ?? 0).toBe(0)
        expect(completion.metadata.channel_reply_receipt_at_ms).toBeGreaterThan(0)
        for (const [index, { name, id }] of lookupSteps.entries()) {
          expect(JSON.stringify(modelCalls[index].body.tools)).toContain(name)
          expect(modelCalls[index + 1].body.contents?.at(-2)).toMatchObject({
            role: 'model', parts: expect.arrayContaining([expect.objectContaining({ functionCall: expect.objectContaining({ name, id }) })]),
          })
          expect(modelCalls[index + 1].body.contents?.at(-1)).toMatchObject({
            role: 'user', parts: expect.arrayContaining([expect.objectContaining({ functionResponse: expect.objectContaining({ name, id }) })]),
          })
        }
        return
      }
      if (phase === 'choice') {
        expect(channelQuestions.has(pendingQuestion)).toBe(false)
        expect(JSON.stringify(modelCalls[0].body.systemInstruction)).toContain('Call readChatHistory')
        const input = await pool.query('SELECT content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2', [sessionId, String(incomingId)])
        expect(input.rows[0].content).toEqual([{ type: 'text', text: '1' }])
      }
      expect(JSON.stringify(modelCalls[0].body)).not.toContain(historicalAnswer)
      expect(JSON.stringify(modelCalls[0].body.tools)).toContain('readChatHistory')
      const continuation = modelCalls[1].body.contents ?? []
      if (isMail) {
        expect(readsAtFirstRequest).toBe(0)
        if (phase === 'mailbox') expect(credentialRead).toHaveBeenCalledWith(mailbox!.id)
        expect(historyRead).not.toHaveBeenCalled()
        expect(recordRead).not.toHaveBeenCalled()
        expect(JSON.stringify(modelCalls[0].body.tools)).toContain('imapSearchMessages')
        expect(JSON.stringify(modelCalls[0].body)).not.toContain(mailSubject)
        expect(JSON.stringify(continuation)).not.toContain(historicalAnswer)
      }
      if (phase === 'mail-revoked') expect(JSON.stringify(continuation)).not.toContain(mailSubject)
      else expect(JSON.stringify(continuation)).toContain(isMail ? mailSubject : historicalAnswer)
      const call = isMail ? { name: 'imapSearchMessages', id: 'fixture-search' }
        : { name: 'readChatHistory', id: 'fixture-context' }
      const callIndex = continuation.findIndex(message => message.role === 'model' && message.parts.some(part => part.functionCall?.id === call.id))
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(continuation[callIndex].parts).toContainEqual(expect.objectContaining({ functionCall: expect.objectContaining(call) }))
      expect(continuation[callIndex + 1]).toMatchObject({
        role: 'user', parts: expect.arrayContaining([
          expect.objectContaining({ functionResponse: expect.objectContaining(call) }),
        ])
      })
    } finally {
      if (observedChannelWait) await observedChannelWait.catch(() => {})
      if (channelHolder) {
        await channelHolder.query('ROLLBACK')
        channelHolder.release()
      }
      if (phase === 'choice') channelQuestions.invalidate(channelId, pendingQuestion.incoming)
      configureTelegramTextDeliveryObserver()
      await analytics?.shutdown()
      if (phase === 'mail-revoked' || phase === 'mail-release' || phase === 'mail-dispatch') await pool.query('UPDATE connector_instance SET connected=true WHERE id=$1', [mailbox!.id])
      credentialRead?.mockRestore()
      recordRead?.mockRestore()
      captureSpy?.mockRestore()
      historyRead?.mockRestore()
      pageRead?.mockRestore()
      pageSelect?.mockRestore()
      linkRead.mockRestore()
      stub.mockRestore()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (heldInputId) await pool.query('UPDATE session_messages SET scope_held=false WHERE session_id=$1 AND id=$2', [sessionId, heldInputId])
      if (quotedRowHeld) await pool.query('UPDATE session_messages SET scope_held=false WHERE session_id=$1 AND id=$2', [sessionId, quotedRowId])
      if (isRecent) await pool.query('UPDATE session_messages SET scope_held=false WHERE session_id=$1 AND id=ANY($2::uuid[]) AND scope_held',[sessionId,recentIds])
      if (heldKnowledgeId) await pool.query('UPDATE knowledge_entries SET scope_held=false WHERE workspace_id=$1 AND id=$2', [workspaceId, heldKnowledgeId])
      if (paginationLinkRemoved) await linkedAccountStore.upsert({ userId: secondId, assistantId, provider: 'telegram', providerId: String(telegramSender) })
      if (memberRevoked) await pool.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",
        [workspaceId, secondId])
      if (configChanged) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, config])
    }
  }, 600_000)

  it.runIf(process.env.BRIAN_TELEGRAM_PAGING_BENCHMARK === '1')('measures recent-text readiness across concurrent Telegram topics', async () => {
    const { pool, channelId, integrationId, integrationStore, linkedAccountStore, config } = recording
    const concurrency = 4
    const samples = 100
    const topicIds = Array.from({ length: concurrency }, (_, index) => topic + index + 1)
    const nextConfig = { ...config, requireMentionOverrides: [topic, ...topicIds].map(topicId => ({ chatId: String(chat), topicId })) }
    await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, nextConfig])
    const topics: Awaited<ReturnType<typeof seedPagingTopic>>[] = []
    for (const topicId of topicIds) topics.push(await seedPagingTopic(recording, topicId))

    type Sample = { id: number; topicId: number; sessionId: string; text: string; firstRequestAt?: number;
      secondRequestAt?: number; pageOneMs?: number; pageTwoMs?: number; receipt?: string; failureNotice?: string }
    const byQuestion = new Map<string, Sample>()
    const byTopic = new Map<number, Sample>()
    const firstPage: number[] = []
    const secondPage: number[] = []
    const batches: Array<{ batch: number; maxPageOneMs: number; maxPageTwoMs: number }> = []
    let attempts = 0
    let initialRequests = 0
    let releaseInitial!: () => void
    let allInitialReady: Promise<void>
    let telegramMessageId: number
    const fetcher = globalThis.fetch
    const benchmarkReply = 'The calibration notes are ready.'
    const analytics = new AnalyticsLogger(createDbAnalyticsStore())
    let recordingFailures = 0
    const app = express()
    app.use(express.json({ limit: '8mb' }))
    app.post('/model/:model', async (req, res) => {
      const receivedAt = performance.now()
      const body = req.body as ModelRequest
      const sample = body.contents?.[0]?.parts.map(part => part.text && byQuestion.get(part.text)).find(Boolean)
      if (!sample || req.params.model !== standardGemini.apiModelId || body.generationConfig?.responseMimeType === 'application/json') {
        throw new Error('Unexpected provider request during Telegram paging measurement')
      }
      const response = body.contents?.at(-1)?.parts[0]?.functionResponse
      let part: ReturnType<typeof contextCall> | { text: string }
      if (!response) {
        // Start the four tool reads together after each turn has reached Gemini.
        initialRequests++
        if (initialRequests === concurrency) releaseInitial()
        await allInitialReady
        part = contextCall('page-one')
        sample.firstRequestAt = performance.now()
      } else {
        const page = parseRecentPage(response.response.result)
        expect(page.messages).toHaveLength(8)
        expect(page.messages.every(({ text }) => text !== sample.text)).toBe(true)
        if (response.id === 'page-one') {
          sample.pageOneMs = receivedAt - sample.firstRequestAt!
          expect(page.nextCursor).toEqual(expect.any(String))
          part = contextCall('page-two', { cursor: page.nextCursor })
          sample.secondRequestAt = performance.now()
        } else {
          expect(response.id).toBe('page-two')
          sample.pageTwoMs = receivedAt - sample.secondRequestAt!
          part = { text: benchmarkReply }
        }
      }
      res.type('text/event-stream').send('data: ' + JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
      }) + '\n\n')
    })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const provider = createRoutingProvider({ gemini: wrapProvider(createGeminiProvider({ kind: 'ai-studio',
      endpoint: model => origin + '/model/' + model, headers: async () => ({ 'Content-Type': 'application/json' }),
    })) })
    app.use('/webhook/telegram', telegramByoRoutes({ provider, configuredProviders: new Set(['gemini']),
      decisionRuntime: createDecisionRuntime({ llmProvider: provider, defaultLlmModel: standardGemini.alias }),
      systemPrompt: 'Answer the speaker using admitted evidence.', tools: new Map(), memoryStore: createDbMemoryStore(),
      capabilityStore: createDbCapabilityStore(), integrationStore, linkedAccountStore,
      channelUserStore: createDbChannelUserStore(), apiUrl: origin, analytics,
    }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === origin) return fetcher(input, init)
      if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith('/bot' + token + '/')) {
        throw new Error('Unexpected paging benchmark network destination')
      }
      if (!url.pathname.endsWith('/sendMessage')) return Response.json({ ok: true, result: true })
      const sent = JSON.parse(String(init?.body))
      expect(String(sent.chat_id)).toBe(String(chat))
      const sample = byTopic.get(sent.message_thread_id)
      expect(sample).toBeDefined()
      const messageId = ++telegramMessageId
      if (sent.text === benchmarkReply) sample!.receipt = String(messageId)
      else if (!/^[⏳✓] Checking chat history\b/u.test(sent.text)) {
        sample!.failureNotice = sent.text === historyUnavailableNotice ? 'history unavailable'
          : sent.text === guardedFailureNotice ? 'turn failed' : 'unexpected Telegram reply'
      }
      return Response.json({ ok: true, result: { message_id: messageId, text: sent.text } })
    })
    configureTelegramTextDeliveryObserver(async delivery => {
      try { await recordDeliveredTelegramMessage(delivery) }
      catch (error) {
        recordingFailures++
        throw error
      }
    })
    const startedAt = performance.now()
    try {
      for (let start = 0; start < samples; start += concurrency) {
        initialRequests = 0
        allInitialReady = new Promise<void>(resolve => { releaseInitial = resolve })
        const batchMessageId = 1_000_000 + start * 100
        telegramMessageId = batchMessageId + concurrency
        const batch = topics.map(({ topicId, sessionId }, index): Sample => {
          const id = batchMessageId + index
          return { id, topicId, sessionId, text: `Could you check the calibration notes for run ${id}?` }
        })
        for (const sample of batch) {
          byQuestion.set(sample.text, sample)
          byTopic.set(sample.topicId, sample)
        }
        attempts += batch.length
        const posts = await Promise.all(batch.map(sample => fetcher(origin + '/webhook/telegram/' + channelId, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'fictional-hook' },
          body: JSON.stringify({ update_id: 7000 + sample.id, message: { message_id: sample.id, message_thread_id: sample.topicId,
            is_topic_message: true, chat: { id: chat, type: 'supergroup', is_forum: true, title: 'Fictional observatory' },
            from: { id: sender, first_name: 'Observer', is_bot: false }, date: Math.floor(Date.now() / 1000), text: sample.text } }),
        })))
        expect(posts.map(post => post.status)).toEqual(batch.map(() => 200))
        await vi.waitFor(() => expect(batch.every(sample => sample.receipt || sample.failureNotice)).toBe(true), { timeout: 15_000, interval: 50 })
        expect(batch.map(sample => sample.failureNotice).filter(Boolean)).toEqual([])
        await vi.waitFor(async () => {
          const { rows: [terminal] } = await pool.query<{ completed: number }>(`SELECT count(*)::int AS completed
            FROM unnest($1::uuid[],$2::text[]) AS expected(session_id,receipt) JOIN sessions s ON s.id=expected.session_id
            JOIN session_messages m ON m.session_id=s.id AND m.channel_message_id=expected.receipt
            WHERE s.status='idle' AND s.turn_lease_token IS NULL AND m.role='assistant' AND m.content=$3::jsonb`,
          [batch.map(sample => sample.sessionId), batch.map(sample => sample.receipt), JSON.stringify([{ type: 'text', text: benchmarkReply }])])
          expect(terminal.completed).toBe(concurrency)
        }, { timeout: 15_000, interval: 100 })
        for (const sample of batch) {
          firstPage.push(sample.pageOneMs!)
          secondPage.push(sample.pageTwoMs!)
          byQuestion.delete(sample.text)
          byTopic.delete(sample.topicId)
        }
        batches.push({ batch: batches.length + 1, maxPageOneMs: Math.max(...batch.map(sample => sample.pageOneMs!)),
          maxPageTwoMs: Math.max(...batch.map(sample => sample.pageTwoMs!)) })
      }
      expect(recordingFailures).toBe(0)
      function timing(values: number[]) {
        expect(values).toHaveLength(samples)
        expect(values.every(Number.isFinite)).toBe(true)
        const sorted = [...values].sort((a, b) => a - b)
        const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]
        return { p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1)! }
      }
      const pageOne = timing(firstPage)
      const pageTwo = timing(secondPage)
      console.info('[Telegram recent-text readiness benchmark]', {
        samples, failures: 0, concurrency, initialRowsPerTopic: rows, annotationsPerTopic: Math.floor((rows + 1) / 8), pageOne, pageTwo,
        receipts: secondPage.length, elapsedMs: Math.round(performance.now() - startedAt),
        firstBatch: batches[0], lastBatch: batches.at(-1),
      })
      expect(pageOne.p99Ms).toBeLessThan(1_000)
      expect(pageTwo.p99Ms).toBeLessThan(1_000)
    } catch (error) {
      await analytics.flush()
      const { rows: failureEvents } = await pool.query(`SELECT metadata->>'error_type' AS "errorType", metadata->>'stage' AS stage,
        metadata->>'denial_diagnostic' AS diagnostic, metadata->>'verification_phase' AS phase,
        metadata->>'verification_sqlstate_class' AS "sqlstateClass"
        FROM analytics_events WHERE session_id=ANY($1::uuid[]) AND event_name='chat_route_error' ORDER BY created_at`,
       [topics.map(item => item.sessionId)])
      const pending = [...byTopic.values()]
      console.info('[Telegram recent-text benchmark failures]', JSON.stringify({
        attempts, replies: secondPage.length + pending.filter(sample => sample.receipt).length,
        pageOneReady: firstPage.length + pending.filter(sample => Number.isFinite(sample.pageOneMs)).length,
        pageTwoReady: secondPage.length + pending.filter(sample => Number.isFinite(sample.pageTwoMs)).length,
        receipts: secondPage.length, lastCompletedBatch: batches.at(-1), elapsedMs: Math.round(performance.now() - startedAt),
        failureEvents, recordingFailures,
      }))
      throw error
    } finally {
      releaseInitial?.()
      await vi.waitFor(async () => {
        const { rows: [active] } = await pool.query<{ count: number }>(`SELECT count(*)::int FROM sessions
          WHERE id=ANY($1::uuid[]) AND (status='running' OR turn_lease_token IS NOT NULL)`, [topics.map(item => item.sessionId)])
        expect(active.count).toBe(0)
      }, { timeout: 15_000, interval: 100 }).catch(() => console.warn('[Telegram paging benchmark turns did not drain]'))
      await analytics.shutdown()
      configureTelegramTextDeliveryObserver()
      fetchSpy.mockRestore()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, config])
    }
  }, 600_000)

  it.each([
    { destination: 'linked direct chat', phase: 'direct', incomingId: 5301 },
    { destination: 'linked direct chat that answers without archive', phase: 'idle', incomingId: 5307 },
    { destination: 'approved shared topic', phase: 'shared', incomingId: 5302 },
    { destination: 'allowlisted unlinked chat', phase: 'guest', incomingId: 5303 },
    { destination: 'direct chat after workspace membership withdrawal', phase: 'nonmember', incomingId: 5304 },
    { destination: 'direct chat after account unlink', phase: 'unlink', incomingId: 5305 },
    { destination: 'direct Telegram delivery retry after account unlink', phase: 'retry', incomingId: 5306 },
    { destination: 'direct chat after the same account is routed to another assistant', phase: 'reroute', incomingId: 5308 },
  ] as const)('limits initial personal archive reads in a $destination', async ({ phase, incomingId }) => {
    const { pool, workspaceId, assistantId, ownerId, secondId, config, channelId, integrationId, integrationStore, linkedAccountStore } = recording
    const revoked = phase === 'nonmember' || phase === 'unlink' || phase === 'retry' || phase === 'reroute'
    const useArchive = phase === 'direct' || revoked
    const privateRead = useArchive || phase === 'idle'
    const speaker = phase === 'guest' ? unlinkedSender : otherMember
    const target = phase === 'shared' ? chat : speaker
    const replyText = useArchive ? 'I found the recent archive note.'
      : phase === 'idle' ? 'I can answer without an archive lookup.' : 'The archive is unavailable here.'
    const historicalMarker = 'Fictional earlier direct-chat observation'
    const archiveMarker = 'Fictional archive instrument arrival'
    const archiveHandle = 'fixture-archive:fictional-observatory'
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const archivedAt = new Date().toISOString()
    const query = 'observatory instrument arrival'
    const secret = 'fictional-archive-secret'
    const requests: { method: string; path: string; owner: string | null; ms: number }[] = []
    const replacementAssistantId = phase === 'reroute' ? randomUUID() : undefined
    if (replacementAssistantId) await pool.query(`INSERT INTO assistants (id,name,owner_user_id,workspace_id,kind)
      VALUES($1,'Fictional alternate assistant',$2,$3,'standard')`, [replacementAssistantId, ownerId, workspaceId])
    async function withdrawLink() {
      const linked = await linkedAccountStore.findByProvider('telegram', String(speaker))
      expect(linked?.userId).toBe(secondId)
      expect(await linkedAccountStore.deleteForUser(secondId, linked!.id)).toBe(true)
    }
    const client = new MessageStoreClient({ baseUrl: 'https://archive.example.invalid', secret, fetchImpl: async (raw, init) => {
      const started = performance.now()
      const url = new URL(String(raw))
      const method = init?.method ?? 'GET'
      const wire = method === 'POST' ? String(init?.body) : `${method}\n${url.pathname}${url.search}`
      expect(new Headers(init?.headers).get('X-UB-Signature')).toBe(`sha256=${createHmac('sha256', secret).update(wire).digest('hex')}`)
      const body = method === 'POST' ? JSON.parse(wire) : null
      const owner = body?.owner_user_id ?? url.searchParams.get('owner_user_id')
      expect(owner).toBe(secondId)
      expect(owner).not.toBe(ownerId)
      expect(body?.since ?? url.searchParams.get('since')).toBe(since)
      if (method === 'POST') expect(body).toMatchObject({ channel: archiveHandle, query })
      const hit = { instance_id: 'fixture-archive', conversation_id: 'fictional-observatory', source: 'whatsapp' }
      const response = method === 'GET'
        ? Response.json({ channels: [{ ...hit, channel: archiveHandle, last_sent_at: archivedAt, last_message_preview: archiveMarker }] })
        : Response.json({ hits: [{ ...hit, sent_at: archivedAt, segment_text: archiveMarker }],
          embedding_coverage: { partial: false, pending: 0, capped: false, note: 'complete' } })
      requests.push({ method, path: url.pathname, owner, ms: performance.now() - started })
      if (phase === 'unlink' && method === 'POST') await withdrawLink()
      if (replacementAssistantId && method === 'POST') {
        const linked = await linkedAccountStore.findByProvider('telegram', String(speaker))
        expect(linked).toMatchObject({ userId: secondId, assistantId })
        const current = await linkedAccountStore.upsert({ userId: secondId, assistantId: replacementAssistantId,
          provider: 'telegram', providerId: String(speaker) })
        expect(current).toMatchObject({ id: linked!.id, userId: secondId, assistantId: replacementAssistantId })
      }
      return response
    } })

    const dm = privateRead ? await findOrCreateSession({ assistantId, userId: secondId, channelType: 'telegram', channelId: String(speaker) }) : null
    if (dm && !(await pool.query('SELECT 1 FROM session_messages WHERE session_id=$1 LIMIT 1', [dm.id])).rowCount) {
      for (let n = 0; n < rows; n++) {
        await addSessionMessage({ sessionId: dm.id, role: 'user', channelMessageId: String(60_000 + n),
          content: [{ type: 'text', text: `${historicalMarker} ${n}` }], senderUserId: secondId,
          scope: { workspaceId, userId: secondId, assistantId: null, sensitivity: 'confidential', compartments: [], projectIds: [] } })
      }
      expect((await pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [dm.id])).rows[0].count).toBe(rows)
    }

    const app = express()
    app.use(express.json())
    const modelCalls: { body: ModelRequest; at: number }[] = []
    const backgroundCalls: number[] = []
    const steps = [
      { name: 'listChatChannels', id: 'fixture-archive-channels', args: { since } },
      { name: 'searchChatHistory', id: 'fixture-archive-search', args: { query, since, channel: archiveHandle } },
    ]
    app.post('/model/:model', async (req, res) => {
      const body = req.body as ModelRequest
      let parts: unknown[]
      if (req.params.model !== standardGemini.apiModelId || body.generationConfig?.responseMimeType === 'application/json') {
        backgroundCalls.push(performance.now())
        parts = [{ text: '{}' }]
      } else {
        const index = modelCalls.length
        modelCalls.push({ body, at: performance.now() })
        if (phase === 'nonmember' && index === 0) {
          const change = await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, secondId])
          expect(change.rowCount).toBe(1)
        }
        const previous = index && body.contents?.at(-1)?.parts.find(part =>
          part.functionResponse?.id === steps[index - 1]?.id)?.functionResponse?.response.result
        const allowed = !index || Boolean(previous && previous.includes(archiveMarker))
        parts = useArchive && allowed && steps[index] ? [{ functionCall: steps[index], thoughtSignature: 'fictional-archive-lookup' }]
          : [{ text: !useArchive || allowed ? replyText : 'The archive lookup failed.' }]
      }
      res.type('text/event-stream').send(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
      })}\n\n`)
    })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const provider = createRoutingProvider({ gemini: wrapProvider(createGeminiProvider({ kind: 'ai-studio',
      endpoint: model => `${origin}/model/${model}`, headers: async () => ({ 'Content-Type': 'application/json' }),
    })) })
    app.use('/webhook/telegram', telegramByoRoutes({
      provider, configuredProviders: new Set(['gemini']),
      decisionRuntime: createDecisionRuntime({ llmProvider: provider, defaultLlmModel: standardGemini.alias }),
      systemPrompt: 'Answer the speaker using admitted evidence.', tools: new Map(createChatArchiveTools({ client }).map(tool => [tool.name, tool])),
      memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), integrationStore, linkedAccountStore,
      channelUserStore: createDbChannelUserStore(), apiUrl: origin,
    }))
    const network = globalThis.fetch
    const deliveries: { target: string; text: string; receipt: string; at: number }[] = []
    const finalAttempts: string[] = []
    let nextReceipt = incomingId * 10
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === origin) return network(input, init)
      if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith(`/bot${token}/`)) throw new Error('Unexpected archive benchmark network destination')
      if (!url.pathname.endsWith('/sendMessage')) return Response.json({ ok: true, result: true })
      const body = JSON.parse(String(init?.body))
      if (body.text === replyText) {
        finalAttempts.push(String(body.chat_id))
        if (phase === 'retry' && finalAttempts.length === 1) {
          await withdrawLink()
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('Fictional Telegram connection reset'), { code: 'ECONNRESET' }) })
        }
      }
      const receipt = ++nextReceipt
      deliveries.push({ target: String(body.chat_id), text: body.text, receipt: String(receipt), at: performance.now() })
      return Response.json({ ok: true, result: { message_id: receipt, text: body.text } })
    })
    const historyRead = vi.spyOn(conversationStore, 'readAdmittedSessionQuery')
    const recordRead = vi.spyOn(conversationAdmission, 'tryReadTurnConversationRecord')
    const linkRead = vi.spyOn(linkedAccountStore, 'findByProvider')
    configureTelegramTextDeliveryObserver(recordDeliveredTelegramMessage)
    const configureAccess = phase === 'guest'
    try {
      if (configureAccess) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, {
        ...config, userAccessMode: 'allowlist', allowedUserIds: [String(speaker)],
      }])
      const ingress = performance.now()
      const response = await network(`${origin}/webhook/telegram/${channelId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'fictional-hook' },
        body: JSON.stringify({ update_id: incomingId, message: {
          message_id: incomingId, date: Math.floor(Date.now() / 1000), text: 'Find recent archive notes about the fictional observatory.',
          from: { id: speaker, first_name: 'Observer', is_bot: false },
          ...(phase === 'shared' ? { message_thread_id: topic, is_topic_message: true,
            chat: { id: target, type: 'supergroup', is_forum: true, title: 'Fictional observatory' } }
            : { chat: { id: target, type: 'private', first_name: 'Observer' } }),
        } }),
      })
      expect(response.status).toBe(200)
      const final = revoked ? null : await vi.waitFor(() => {
        const delivered = deliveries.find(delivery => delivery.text === replyText)
        expect(delivered?.target).toBe(String(target))
        return delivered!
      }, { timeout: 15_000 })
      if (revoked) await vi.waitFor(async () => {
        const { rows: [state] } = await pool.query(`SELECT status,turn_lease_token,
          EXISTS (SELECT 1 FROM session_messages WHERE session_id=$1 AND channel_message_id=$2) AS turn_seen,
          EXISTS (SELECT 1 FROM chat_turn_locks WHERE chat_key=$3) AS locked FROM sessions WHERE id=$1`,
        [dm!.id, String(incomingId), `tg-byo:${speaker}`])
        expect(state).toEqual({ status: 'failed', turn_lease_token: null, turn_seen: true, locked: false })
      }, { timeout: 15_000 })
      expect(modelCalls).toHaveLength(phase === 'direct' || phase === 'retry' ? 3 : phase === 'unlink' || phase === 'reroute' ? 2 : 1)
      const firstTools = JSON.stringify(modelCalls[0].body.tools)
      expect(firstTools).toContain('readChatHistory')
      for (const step of steps) {
        if (privateRead) expect(firstTools).toContain(step.name)
        else expect(firstTools).not.toContain(step.name)
      }
      expect(backgroundCalls).toHaveLength(0)
      // Current authored-input admission may probe the exact new row. Prior
      // rows and annotations must never enter any of these turns.
      for (const [, from, through, topicThrough] of recordRead.mock.calls) {
        expect(from).toBe(through)
        expect(through).toBeGreaterThan(rows)
        expect(topicThrough).toBe(0)
      }
      expect(historyRead).not.toHaveBeenCalled()
      expect(JSON.stringify(modelCalls)).not.toContain(historicalMarker)
      expect(requests.map(({ method, path, owner }) => ({ method, path, owner }))).toEqual(useArchive && phase !== 'nonmember'
        ? [{ method: 'GET', path: '/channels', owner: secondId }, { method: 'POST', path: '/search', owner: secondId }] : [])
      if (phase === 'idle') expect(linkRead.mock.calls).toEqual([['telegram', String(speaker)]])
      if (revoked) {
        expect(deliveries.map(delivery => delivery.text)).not.toContain(replyText)
        expect(finalAttempts).toEqual(phase === 'retry' ? [String(speaker)] : [])
        if (phase !== 'retry') expect(JSON.stringify(modelCalls)).not.toContain('"segment_text"')
      }
      if (dm && final && phase === 'direct') {
        await vi.waitFor(async () => {
          const result = await pool.query(`SELECT m.content,m.user_id,m.workspace_id,s.visibility FROM session_messages m
            JOIN sessions s ON s.id=m.session_id WHERE m.session_id=$1 AND m.channel_message_id=$2 AND m.role='assistant'`, [dm.id, final.receipt])
          expect(result.rows).toEqual([{ content: [{ type: 'text', text: replyText }], user_id: secondId, workspace_id: workspaceId, visibility: 'personal' }])
        }, { timeout: 5_000 })
        const receiptLookup = `SELECT content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2
          AND session_recording_read_allowed(session_id)`
        const ownedReceipt = [dm.id, final.receipt]
        expect((await queryWithRLS(secondId, receiptLookup, ownedReceipt)).rows).toEqual([{ content: [{ type: 'text', text: replyText }] }])
        expect((await queryWithRLS(ownerId, receiptLookup, ownedReceipt)).rows).toEqual([])
        const lookupMs = modelCalls.slice(1).map((call, index) => call.at - modelCalls[index].at)
        expect(Math.max(...lookupMs)).toBeLessThan(5_000)
        console.info('[Telegram direct chat archive lookup]', { rows, initialMs: Math.round(modelCalls[0].at - ingress),
          toolAndAdmissionMs: lookupMs.map(Math.round), storeMs: requests.map(request => Math.round(request.ms)), deliveryMs: Math.round(final.at - ingress) })
      }
    } finally {
      if (phase === 'nonmember') await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance)
        VALUES($1,$2,'member','confidential') ON CONFLICT DO NOTHING`, [workspaceId, secondId])
      if (phase === 'unlink' || phase === 'retry' || phase === 'reroute') {
        await linkedAccountStore.upsert({ userId: secondId, assistantId, provider: 'telegram', providerId: String(speaker) })
      }
      if (configureAccess) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, config])
      configureTelegramTextDeliveryObserver()
      historyRead.mockRestore()
      recordRead.mockRestore()
      linkRead.mockRestore()
      fetchSpy.mockRestore()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 30_000)

  it.each([{ actor: 'linked member in a direct chat', speaker: otherMember, incomingId: 5460 },
    { actor: 'allowlisted guest in a direct chat', speaker: 9100000312, incomingId: 5461 },
    { actor: 'personal recorder in a group', speaker: sender, incomingId: 5462 }] as const)(
    'limits signed history to the Telegram audience for the $actor', async ({ actor, speaker, incomingId }) => {
      const { pool, workspaceId, assistantId, ownerId, secondId, config, channelId, integrationId, integrationStore, linkedAccountStore } = recording
      const channelUserStore = createDbChannelUserStore()
      const guest = actor === 'allowlisted guest in a direct chat'
        ? await resolveChannelUser(channelUserStore, 'telegram', String(speaker), assistantId,
            async () => ({ email: null, displayName: 'Fictional guest' }))
        : null
      if (guest) expect(guest.isIdentified).toBe(false)
      const privateRecording = actor === 'personal recorder in a group'
      const nativeDirect = !guest && !privateRecording
      const readerId = privateRecording ? ownerId : guest?.user.id ?? secondId
      const personalTopic = topic + 30
      const personalConversationId = `${chat}:topic:${personalTopic}`
      const note = (index: number) => `Fictional ${actor} calibration record ${index}.`
      const reply = privateRecording ? 'The personal recording is unavailable in this group.' : 'I recovered the earlier direct-chat calibration record.'
      const seedPersonalRecording = async () => {
        const input = { integrationId, conversationId: personalConversationId, assistantId, senderUserId: readerId }
        const original = await admitTelegramRecording({ ...input, providerMessageId: String(incomingId * 100), text: note(0) })
        expect(original).toBeDefined()
        await changeChannelRecording({ integrationId, actorId: readerId, id: original!.policy.id, revision: original!.policy.revision,
          enabled: true, destination: 'personal', projectId: null })
        for (let index = 1; index <= 16; index++) {
          const recording = await admitTelegramRecording({ ...input, providerMessageId: String(incomingId * 100 + index), text: note(index) })
          expect(recording?.policy.destination).toBe('personal')
          if (index === 16) return recording!.session
        }
        throw new Error('The private recording was not seeded.')
      }
      const session = privateRecording ? await seedPersonalRecording()
        : await findOrCreateSession({ assistantId, userId: readerId, channelType: 'telegram', channelId: String(speaker) })
      const firstPageIds = new Set<string>()
      if (!privateRecording) {
        // Verified Telegram guest input is stored under its public provider envelope.
        for (let index = 1; index <= 16; index++) {
          const message = await addSessionMessage({ sessionId: session.id, role: 'user', senderUserId: readerId,
            ...(index % 3 === 0 ? {} : { channelMessageId: String(incomingId * 100 + index) }),
            content: [{ type: 'text', text: note(index) }],
            scope: { workspaceId, userId: guest ? null : readerId, assistantId: null, sensitivity: guest ? 'public' : 'confidential',
              compartments: [], projectIds: [] } })
          if (index >= 9) firstPageIds.add(message.id)
        }
      }
      const modelCalls: ModelRequest[] = []
      const analytics = new AnalyticsLogger(createDbAnalyticsStore())
      const app = express()
      app.use(express.json())
      app.post('/model/:model', (req, res) => {
        const body = req.body as ModelRequest
        const round = modelCalls.push(body)
        const result = (id: string) => body.contents?.at(-1)?.parts.find(part => part.functionResponse?.id === id)?.functionResponse?.response.result
        const parts = round === 1 ? [contextCall('dm-page-one')]
          : privateRecording ? [{ text: parseRecentPage(result('dm-page-one')).messages.length === 0
            ? reply : 'The personal recording contains messages.' }]
          : round === 2 ? [contextCall('dm-page-two', { cursor: parseRecentPage(result('dm-page-one')).nextCursor })]
          : [{ text: parseRecentPage(result('dm-page-two')).messages.some(item => item.text === note(5))
            ? reply : 'The earlier direct-chat calibration record is unavailable.' }]
        res.type('text/event-stream').send(`data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        })}\n\n`)
      })
      const server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const provider = createRoutingProvider({ gemini: wrapProvider(createGeminiProvider({ kind: 'ai-studio',
        endpoint: model => `${origin}/model/${model}`, headers: async () => ({ 'Content-Type': 'application/json' }),
      })) })
      app.use('/webhook/telegram', telegramByoRoutes({
        provider, configuredProviders: new Set(['gemini']),
        decisionRuntime: createDecisionRuntime({ llmProvider: provider, defaultLlmModel: standardGemini.alias }),
        systemPrompt: 'Answer the speaker using admitted evidence.', tools: new Map(), memoryStore: createDbMemoryStore(),
        capabilityStore: createDbCapabilityStore(), integrationStore, linkedAccountStore, channelUserStore, analytics, apiUrl: origin,
      }))
      const network = globalThis.fetch
      let nextReceipt = incomingId * 10
      let telegramReceipt: string | undefined
      let firstPageEnrolled = false
      let freshProof = false
      let unprovedProgressWrites = 0
      const telegramTargets: Array<{ chatId: string; topicId: number | undefined }> = []
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.origin === origin) return network(input, init)
        if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith(`/bot${token}/`)) throw new Error('Unexpected direct history network destination')
        const writesStatus = url.pathname.endsWith('/sendMessage') || url.pathname.endsWith('/editMessageText')
        if (firstPageEnrolled && modelCalls.length === 1 && writesStatus && !freshProof) unprovedProgressWrites++
        if (!url.pathname.endsWith('/sendMessage')) return Response.json({ ok: true, result: true })
        const body = JSON.parse(String(init?.body))
        const messageId = ++nextReceipt
        if (body.text === reply) {
          telegramTargets.push({ chatId: String(body.chat_id), topicId: body.message_thread_id })
          telegramReceipt = String(messageId)
        }
        return Response.json({ ok: true, result: { message_id: messageId, text: body.text } })
      })
      const fullHistory = vi.spyOn(conversationStore, 'readAdmittedSessionQuery')
      const includesFirstPage = (sources: readonly { resourceId: string }[] | undefined) =>
        sources?.some(source => firstPageIds.has(source.resourceId)) === true
      let readingFirstPage = false
      let heldOlderProof = false
      let olderProofAllowed: boolean | undefined
      let firstPageRootCount: number | undefined
      const ordinaryHistory = turnHistory.readRecentChannelText
      const historyRead = guest ? vi.spyOn(turnHistory, 'readRecentChannelText').mockImplementation(async (...args) => {
        if (modelCalls.length === 1) {
          readingFirstPage = true
          await vi.waitFor(() => expect(heldOlderProof).toBe(true), { timeout: 2000, interval: 5 })
        }
        const result = await ordinaryHistory(...args)
        if (modelCalls.length === 1 && result.available) firstPageRootCount = result.sources.length
        return result
      }) : undefined
      const originalNote = ContextScopeAccumulator.prototype.note
      const observeEnrollment = guest ? vi.spyOn(ContextScopeAccumulator.prototype, 'note').mockImplementation(function (this: ContextScopeAccumulator, evidence) {
        originalNote.call(this, evidence)
        if (readingFirstPage && includesFirstPage(evidence?.sources)) firstPageEnrolled = true
      }) : undefined
      const holdProgressProof = (authorize: deliveryAuthority.AuthorizeDeliveryAudience): deliveryAuthority.AuthorizeDeliveryAudience => {
        return async input => {
          const olderPageProof = input.userId === readerId && modelCalls.length === 1 && readingFirstPage
            && !firstPageEnrolled && !heldOlderProof && !includesFirstPage(input.scopeEvidence?.sources)
          if (olderPageProof) heldOlderProof = true
          const decision = await authorize(input)
          if (olderPageProof) olderProofAllowed = decision.allowed
          // Hold an authentic progress proof while the eager tool adds the bounded page.
          if (olderPageProof) await vi.waitFor(() => expect(firstPageEnrolled).toBe(true), { timeout: 2000, interval: 5 })
          if (firstPageEnrolled && modelCalls.length === 1 && decision.allowed
            && [...firstPageIds].every(id => input.scopeEvidence?.sources?.some(source => source.resourceId === id))) {
            freshProof = true
          }
          return decision
        }
      }
      const ordinaryAuthorizer = deliveryAuthority.createDeliveryAudienceAuthorizer
      const audienceProof = guest ? vi.spyOn(deliveryAuthority, 'createDeliveryAudienceAuthorizer')
        .mockImplementation(deps => holdProgressProof(ordinaryAuthorizer(deps))) : undefined
      configureTelegramTextDeliveryObserver(recordDeliveredTelegramMessage)
      try {
        if (guest) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, {
          ...config, userAccessMode: 'allowlist', allowedUserIds: [String(speaker)],
        }])
        if (privateRecording) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, {
          ...config, requireMentionOverrides: [...config.requireMentionOverrides, { chatId: String(chat), topicId: personalTopic }],
        }])
        const response = await network(`${origin}/webhook/telegram/${channelId}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'fictional-hook' },
          body: JSON.stringify({ update_id: incomingId, message: {
            message_id: incomingId, date: Math.floor(Date.now() / 1000), text: 'What calibration decision did we make earlier?',
            from: { id: speaker, first_name: 'Observer', is_bot: false },
            ...(privateRecording ? { message_thread_id: personalTopic, is_topic_message: true,
              chat: { id: chat, type: 'supergroup', is_forum: true, title: 'Fictional observatory' } }
              : { chat: { id: speaker, type: 'private', first_name: 'Observer' } }),
            ...(nativeDirect ? { reply_to_message: { message_id: incomingId * 100 + 1,
              from: { id: speaker, first_name: 'Observer', is_bot: false },
              date: Math.floor(Date.now() / 1000) - 60, chat: { id: speaker, type: 'private' }, text: providerQuotePreview,
            } } : {}),
          } }),
        })
        expect(response.status).toBe(200)
        const terminal = await vi.waitFor(async () => {
          const { rows: [active] } = await pool.query(`SELECT status,turn_lease_token,
            EXISTS(SELECT 1 FROM session_messages WHERE session_id=$1 AND channel_message_id=$2) AS seen
            FROM sessions WHERE id=$1`, [session.id, String(incomingId)])
          expect(active).toMatchObject({ turn_lease_token: null, seen: true })
          expect(active.status).not.toBe('running')
          return active
        }, { timeout: 15_000, interval: 100 })
        if (terminal.status !== 'idle') {
          await analytics.flush()
          const { rows: failures } = await pool.query(`SELECT metadata->>'error_type' AS "errorType",metadata->>'stage' AS stage,
            metadata->>'denial_diagnostic' AS diagnostic,metadata->>'verification_phase' AS phase,
            metadata->>'verification_sqlstate_class' AS "sqlstateClass" FROM analytics_events
            WHERE session_id=$1 AND event_name='chat_route_error' ORDER BY created_at`, [session.id])
          throw new Error(`Signed Telegram history failed after ${modelCalls.length} model requests. ${JSON.stringify({ failures,
            readingFirstPage, olderProofAllowed, firstPageRootCount,
            heldOlderProof, firstPageEnrolled, freshProof, authorizerFactories: audienceProof?.mock.calls.length })}`)
        }
        expect(modelCalls).toHaveLength(privateRecording ? 2 : 3)
        const extractPage = (index: number, id: string) => {
          const result = modelCalls[index].contents?.at(-1)?.parts.find(part => part.functionResponse?.id === id)?.functionResponse
          expect(result?.name).toBe('readChatHistory')
          return parseRecentPage(result?.response.result)
        }
        const first = extractPage(1, 'dm-page-one')
        if (privateRecording) {
          expect(first).toEqual({ messages: [], scope: expect.stringContaining('unavailable') })
          expect(JSON.stringify(modelCalls)).not.toContain(note(16))
        } else {
          const expectedPage = (from: number) => Array.from({ length: 8 }, (_, offset) => ({ role: 'user', text: note(from + offset) }))
          expect(first.messages).toEqual(expectedPage(9))
          expect(first.quote).toEqual(nativeDirect ? { status: 'available', role: 'user', text: note(1) } : undefined)
          expect(first.nextCursor).toEqual(expect.any(String))
          expect(extractPage(2, 'dm-page-two').messages).toEqual(expectedPage(1))
          if (guest) {
            expect(heldOlderProof).toBe(true)
            expect(freshProof).toBe(true)
            expect(unprovedProgressWrites).toBe(0)
          }
        }
        expect(JSON.stringify(modelCalls[0])).not.toContain(note(16))
        expect(JSON.stringify(modelCalls)).not.toContain(privateMarker)
        expect(JSON.stringify(modelCalls)).not.toContain(historicalAnswer)
        expect(JSON.stringify(modelCalls)).not.toContain(providerQuotePreview)
        expect(fullHistory).not.toHaveBeenCalled()
        expect(telegramTargets).toEqual([privateRecording ? { chatId: String(chat), topicId: personalTopic }
          : { chatId: String(speaker), topicId: undefined }])
        expect(telegramReceipt).toEqual(expect.any(String))
        const recordedReply = [{ content: [{ type: 'text', text: reply }] }]
        const receiptArgs = [session.id, telegramReceipt]
        const receiptQuery = `SELECT content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2 AND role='assistant'`
        expect((await pool.query(receiptQuery, receiptArgs)).rows).toEqual(recordedReply)
        if (guest) {
          const { rows: [ownership] } = await pool.query(`SELECT s.user_id,
            EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$2 AND user_id=s.user_id) AS member
            FROM sessions s WHERE s.id=$1`, [session.id, workspaceId])
          expect(ownership).toEqual({ user_id: readerId, member: false })
          expect(await linkedAccountStore.findByProvider('telegram', String(speaker))).toBeNull()
        } else {
          const readerQuery = `${receiptQuery} AND session_recording_read_allowed(session_id)`
          expect((await queryWithRLS(readerId, readerQuery, receiptArgs)).rows).toEqual(recordedReply)
          expect((await queryWithRLS(privateRecording ? secondId : ownerId, readerQuery, receiptArgs)).rows).toEqual([])
        }
      } finally {
        if (guest || privateRecording) await pool.query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [integrationId, config])
        await analytics.shutdown()
        configureTelegramTextDeliveryObserver()
        fullHistory.mockRestore()
        if (historyRead) historyRead.mockRestore()
        if (observeEnrollment) observeEnrollment.mockRestore()
        if (audienceProof) audienceProof.mockRestore()
        fetchSpy.mockRestore()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    }, 30_000)
})
