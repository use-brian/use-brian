import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { LLMProvider } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { findAssistantById } from '../../db/users.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbChannelIntegrationStore, encryptCredentials } from '../../db/channel-integrations.js'
import { processChannelMessage, type ChannelHooks } from '../../routes/channel-pipeline.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/channel-room] approved Slack group research admission', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  async function setup(withdrawDuringAssessment = false) {
    fixture = await persistentContextFixture()
    const f = fixture
    await f.pool.query("UPDATE workspaces SET department_read_v2=true,plan='pro' WHERE id=$1", [f.workspaceId])
    const channelId = randomUUID(), integrationId = randomUUID()
    const providerChannel = 'C_FICTIONAL', root = '1790000000.000001'
    const binding = {
      version: 1, channelId: providerChannel, audienceType: 'group', clearance: 'internal',
      compartments: [], projectIds: [], recipientUserId: null, expiresAt: null,
      approvedByUserId: f.ownerId, approvedAt: '2026-10-01T00:00:00Z',
    }
    const key = Buffer.alloc(32, 7)
    const credentials = encryptCredentials({ bot_token: 'fictional-token', signing_secret: 'fictional-secret' }, key)
    await f.pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'slack','Fictional group channel')", [channelId, f.workspaceId])
    await f.pool.query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)', [channelId, f.assistantId])
    await f.pool.query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,config) VALUES($1,$2,'slack',$3,$4)",
      [integrationId, channelId, credentials, JSON.stringify({ deliveryAudienceBindings: [binding] })])
    const assistant = await findAssistantById(f.assistantId)
    if (!assistant) throw new Error('Missing actual fixture assistant')
    const responses: string[] = [], errors: Error[] = [], notices: string[] = []
    let assessments = 0, mainSends = 0, authoredAtAssessment = false
    const sessionRef: { id?: string } = {}
    const usage = { inputTokens: 3, outputTokens: 2 }
    const provider: LLMProvider = {
      name: 'fictional-slack-group', models: ['fixture'],
      async *stream(options) {
        const research = options.maxTokens === 128 && JSON.stringify(options.messages).includes('recentConversation')
        if (research) {
          assessments++
          authoredAtAssessment = (await f.pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='user'", [sessionRef.id])).rows.length === 1
          if (withdrawDuringAssessment) {
            await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.ownerId])
          }
        }
        yield { type: 'message_start', model: 'fixture' }
        yield { type: 'text_delta', text: research ? '{"research":false}' : '{"topic_label":"Fictional topic","state":"continue","confidence":0.9}' }
        yield { type: 'message_end', stopReason: 'end_turn', usage }
      },
      createSession() {
        return { send() { return (async function* () {
          mainSends++
          yield { type: 'message_start' as const, model: 'fixture' }
          yield { type: 'text_delta' as const, text: 'Fictional admitted group response' }
          yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage }
        })() } }
      },
    }
    const hooks: ChannelHooks = {
      async onConfirmationRequired() { throw new Error('Unexpected fixture confirmation') },
      async sendResponse(text) { responses.push(text) },
      async sendError(error) { errors.push(error) },
      async postNotice(text) { notices.push(text) },
    }
    const message = 'Compare the fictional options using several independent sources and explain their current differences.'
    const run = () => processChannelMessage({
      userId: f.ownerId, ownerId: f.ownerId, assistant, isIdentified: true,
      channelType: 'slack', channelId: providerChannel, channelIntegrationId: integrationId,
      channelIntegrationStore: createDbChannelIntegrationStore(key),
      sessionChannelId: `${providerChannel}:thread:${root}`, isGroupChat: true,
      actorChannelId: 'U_FICTIONAL', incomingChannelMessageId: root,
      messageText: message, userContentBlocks: [{ type: 'text', text: message }],
      modelAlias: 'standard', adaptiveResearchEnabled: true,
      abortController: new AbortController(), provider, systemPrompt: 'Fictional group fixture',
      tools: new Map(), memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), hooks, sessionRef,
    })
    return { f, run, responses, errors, notices, sessionRef, assessments: () => assessments, mainSends: () => mainSends,
      authoredAtAssessment: () => authoredAtAssessment }
  }

  it('admits current authored input and replies without automatic room notices', async () => {
    const current = await setup()
    await current.run()
    expect(current.errors).toEqual([])
    expect(current.assessments()).toBe(1)
    expect(current.authoredAtAssessment()).toBe(true)
    expect(current.mainSends()).toBe(1)
    expect(current.responses).toEqual(['Fictional admitted group response'])
    expect(current.notices).toEqual([])
    const room = (await current.f.pool.query('SELECT visibility,anchor_kind,effective_clearance FROM sessions WHERE id=$1', [current.sessionRef.id])).rows[0]
    expect(room).toMatchObject({ visibility: 'workspace', anchor_kind: 'channel', effective_clearance: 'internal' })
  })

  it('refuses a revoked original member before entering the main provider', async () => {
    const current = await setup(true)
    await expect(current.run()).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(current.assessments()).toBe(1)
    expect(current.authoredAtAssessment()).toBe(true)
    expect(current.mainSends()).toBe(0)
    expect(current.responses).toEqual([])
    expect(current.notices).toEqual([])
    const replies = await current.f.pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant'", [current.sessionRef.id])
    expect(replies.rows).toEqual([])
  })
})
