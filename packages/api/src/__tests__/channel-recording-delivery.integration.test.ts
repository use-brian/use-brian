import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPool, getAppPool, query } from '../db/client.js'
import { admitTelegramRecording, changeChannelRecording, confirmChannelRecordingOwner, recordDeliveredTelegramMessage } from '../channel-recording.js'
import { getSessionMessages } from '../db/sessions.js'
import { processChannelMessage, type ChannelPipelineParams } from '../routes/channel-pipeline.js'
import { createPublicationConsentStore } from '../workflow/publication-consent.js'
const { runTurn } = vi.hoisted(() => ({ runTurn: vi.fn() }))
vi.mock('../turn/kernel.js', async original => ({ ...await original<typeof import('../turn/kernel.js')>(),runAssistantTurn: runTurn }))
vi.mock('../turn/prepare.js', () => ({ prepareAssistantRun: vi.fn(async input => ({ model: input.model,
  tools: input.candidateTools,trustedContext: '',userVisibleContext: '' })) }))
const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const owner = randomUUID(), speaker = randomUUID()
const targets = Array.from({ length: 2 }, () => ({ workspace: randomUUID(), assistant: randomUUID(), channel: randomUUID(), integration: randomUUID() }))
const conversationId = '-1000000001:topic:21'
const config = { requireMentionOverrides: [{ chatId: '-1000000001', topicId: 21 }] }
const incoming = (target: typeof targets[number], id: string) => ({ integrationId: target.integration, conversationId,
  assistantId: target.assistant, providerMessageId: id, text: 'Fictional human message', senderUserId: speaker })
const delivered = (id: string) => ({ channelId: conversationId, providerMessageId: id, text: `Published reply ${id}`, botId: '12345', botUsername: 'fictional_public_bot' })
const assistantRows = async (id: string) => (await query('SELECT role,content,sender_assistant_id,published_sender_name FROM session_messages WHERE session_id=$1 AND role=\'assistant\' ORDER BY sequence_num', [id])).rows
let recordings: Array<NonNullable<Awaited<ReturnType<typeof admitTelegramRecording>>>>

describe('[COMP:api/channel-recording] public provider reply capture', () => {
  beforeAll(async () => {
    await query(`INSERT INTO users(id,auth_provider,auth_provider_id,name) SELECT id,'test',id::text,'Fictional person' FROM unnest($1::uuid[]) id`, [[owner,speaker]])
    for (const [index,target] of targets.entries()) {
      await query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Recording delivery test',$2)", [target.workspace,owner])
      await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [target.workspace,owner])
      await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Private recorder name',$2,'internal')", [target.assistant,target.workspace])
      await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional bot')", [target.channel,target.workspace])
      await query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,config) VALUES($1,$2,'telegram','\\x00'::bytea,$3,$4)", [target.integration,target.channel,String(900001+index),config])
      await query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)', [target.channel,target.assistant])
      await confirmChannelRecordingOwner(target.integration,owner)
    }
    recordings = await Promise.all(targets.map(target => admitTelegramRecording(incoming(target,'human-1')))).then(rows => rows.map(row => row!))
  })
  afterAll(async () => {
    await query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [targets.map(target => target.workspace)])
    await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner,speaker]])
    await getPool().end(); await getAppPool().end()
  })
  it('independently admits public text into two private recorders without private assistant attribution', async () => {
    await recordDeliveredTelegramMessage(delivered('reply-1'))
    for (const recording of recordings) {
      expect(await assistantRows(recording.session.id)).toEqual([{ role: 'assistant',content: [{ type: 'text',text: 'Published reply reply-1' }],
        sender_assistant_id: null,published_sender_name: '@fictional_public_bot' }])
      const read = await getSessionMessages(recording.session.id)
      expect(read.at(-1)).toMatchObject({ publishedSenderName: '@fictional_public_bot',senderAssistantId: null })
    }
  })
  it('makes concurrent provider receipts idempotent and excludes another topic', async () => {
    await Promise.all([recordDeliveredTelegramMessage(delivered('reply-1')),recordDeliveredTelegramMessage(delivered('reply-1'))])
    // The source publication transaction holds only its consent advisory
    // lock. A synchronous independent recorder must complete inside it.
    await createPublicationConsentStore().withPublicationLock(randomUUID(), owner,
      () => recordDeliveredTelegramMessage(delivered('reply-1')))
    await recordDeliveredTelegramMessage({ ...delivered('wrong-topic'),channelId: '-1000000001:topic:22' })
    for (const recording of recordings) expect(await assistantRows(recording.session.id)).toHaveLength(1)
  })
  it('keeps model/tool rounds out of recording and saves only one successful published final', async () => {
    const recording = recordings[0], target = targets[0]
    const before = (await assistantRows(recording.session.id)).length
    const privateTurn = { content: [{ type: 'text',text: 'Private execution narration' },
      { type: 'tool_use',id: 'fixture-tool',name: 'privateLookup',input: { secret: 'Fictional private tool input' } }],
      stopReason: 'tool_use',usage: { inputTokens: 1,outputTokens: 1 },model: 'fixture' }
    const finalTurn = { ...privateTurn,content: [{ type: 'text',text: 'Public final answer' }],stopReason: 'end_turn' }
    runTurn.mockImplementationOnce(async ({ sink }) => {
      await sink.onEvent({ type: 'text_delta',text: 'Private execution narration' })
      await sink.onEvent({ type: 'thinking_delta',text: 'Fictional private reasoning' })
      await sink.onEvent({ type: 'tool_input',id: 'fixture-tool',name: 'privateLookup',input: { secret: 'Fictional private tool input' } })
      await sink.onEvent({ type: 'assistant_turn',response: privateTurn,toolResults: [{ type: 'tool_result',toolUseId: 'fixture-tool',content: 'Fictional private result' }] })
      await sink.onEvent({ type: 'assistant_turn',response: finalTurn,toolResults: [] })
      await sink.onEvent({ type: 'turn_complete',response: finalTurn })
      return { finalText: 'Public final answer' }
    })
    let sends = 0
    const publishSessionEvent = vi.fn()
    const provider = { name: 'fixture',models: [],async *stream() { yield { type: 'text_delta',text: '{"topic_label":"fictional","confidence":1}' } } }
    await processChannelMessage({ recording,publishSessionEvent,admittedAnswerContext: { kind: 'continue' },
      assistant: { id: target.assistant,name: 'Private recorder name',workspaceId: target.workspace,ownerUserId: null,
        systemPrompt: null,clearance: 'internal' },userId: owner,ownerId: owner,isIdentified: false,
      channelType: 'telegram',channelId: conversationId,isGroupChat: true,channelIntegrationId: target.integration,
      incomingChannelMessageId: 'human-1',messageText: 'Hi',userContentBlocks: [{ type: 'text',text: 'Hi' }],
      abortController: new AbortController(),modelAlias: 'standard',provider,systemPrompt: 'Fixture prompt',tools: new Map(),
      memoryStore: {},capabilityStore: {},hooks: { onConfirmationRequired: async () => {},
        sendError: async (error: Error) => { throw error },sendResponse: async (text: string) => {
          // The callback fires after flush: no unpublished/tool turn may exist.
          expect(await assistantRows(recording.session.id)).toHaveLength(before)
          sends++
          await recordDeliveredTelegramMessage({ ...delivered('pipeline-final'),text })
          return { channelMessageId: 'pipeline-final' }
        } },
    } as unknown as ChannelPipelineParams)
    expect(runTurn).toHaveBeenCalledOnce()
    expect(sends).toBe(1)
    expect(publishSessionEvent.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'turn_completed',sessionId: recording.session.id,payload: { senderUserId: owner } },
    ])
    expect(await assistantRows(recording.session.id)).toHaveLength(before+1)
    expect((await assistantRows(recording.session.id)).at(-1)?.content).toEqual([{ type: 'text',text: 'Public final answer' }])
  })
  it('rechecks exact conversation ownership and connector ownership at every delivery', async () => {
    const target = targets[0]
    await query('UPDATE channel_integrations SET config=$2 WHERE id=$1', [target.integration,{ requireMentionOverrides: [{ chatId: '-1000000001',topicId: 22 }] }])
    await recordDeliveredTelegramMessage(delivered('unrelated'))
    expect(await assistantRows(recordings[0].session.id)).toHaveLength(2)
    await query('UPDATE channel_integrations SET config=$2,recording_owner_user_id=NULL WHERE id=$1', [target.integration,config])
    await recordDeliveredTelegramMessage(delivered('unowned'))
    expect(await assistantRows(recordings[0].session.id)).toHaveLength(2)
    await confirmChannelRecordingOwner(target.integration,owner)
    await query("UPDATE channels SET status='revoked' WHERE id=$1", [target.channel])
    await recordDeliveredTelegramMessage(delivered('revoked'))
    expect(await assistantRows(recordings[0].session.id)).toHaveLength(2)
    await query("UPDATE channels SET status='active' WHERE id=$1", [target.channel])
  })
  it('stops future copies and keeps receipt tombstones across destination epochs', async () => {
    const target = targets[0], policy = recordings[0].policy
    const stopped = await changeChannelRecording({ integrationId: target.integration,actorId: owner,id: policy.id,
      revision: policy.revision,enabled: false,destination: 'personal',projectId: null })
    await recordDeliveredTelegramMessage(delivered('stopped'))
    expect(await assistantRows(recordings[0].session.id)).toHaveLength(2)
    await changeChannelRecording({ integrationId: target.integration,actorId: owner,id: policy.id,
      revision: stopped.revision,enabled: true,destination: 'personal',projectId: null })
    await recordDeliveredTelegramMessage(delivered('reply-1'))
    expect((await query('SELECT session_id FROM channel_recording_policies WHERE id=$1', [policy.id])).rows[0].session_id).toBeNull()
    await recordDeliveredTelegramMessage({ ...delivered('new-epoch'),botUsername: undefined })
    const next = (await query('SELECT session_id FROM channel_recording_policies WHERE id=$1', [policy.id])).rows[0].session_id
    expect(next).not.toBe(recordings[0].session.id)
    expect(await assistantRows(next)).toMatchObject([{ published_sender_name: '',sender_assistant_id: null }])
    expect(await assistantRows(recordings[0].session.id)).toHaveLength(2)
  })
  it('refuses a departed connector owner while another recorder remains live', async () => {
    await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [targets[1].workspace,owner])
    const before = await assistantRows(recordings[1].session.id)
    await recordDeliveredTelegramMessage(delivered('departed'))
    expect(await assistantRows(recordings[1].session.id)).toHaveLength(before.length)
  })
})
