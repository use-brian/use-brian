/** [COMP:api/conversation-visibility] Actual public history through both HTTP
 * credentials and the ordinary PostgreSQL roles. */
import { chatTierDefaults } from '@use-brian/shared/model-registry'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LLMProvider, StreamFn } from '@use-brian/agent-runtime/providers/types.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { publicChatRoutes, type PublicChatRouteOptions } from '../../routes/public-chat.js'
import { publicApiRoutes, type PublicApiRouteOptions } from '../../routes/public-api.js'
import { createDbApiKeyStore } from '../api-key-store.js'
import { createChatLinkStore } from '../chat-link-store.js'
import { createDbCapabilityStore } from '../capability-store.js'
import { getAppPool, getPool } from '../client.js'
import { initializeConversationVisibility, publicConversationHistoryActive } from '../conversation-visibility.js'
import { createDbMemoryStore } from '../memory-store.js'
import { addSessionMessage, findOrCreateSession } from '../sessions.js'

const proModel = chatTierDefaults().pro

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { currentReleaseSource } = await import(new URL(
  '../../../scripts/conversation-store/installation-release.mjs', import.meta.url).href)
const signature = 'public.read_public_conversation_history(uuid,jsonb,uuid,text,text,integer)'
let installedHead: string

beforeAll(async () => {
  const { rows } = await getPool().query<{ name: string; installed: boolean }>(`SELECT name,
    to_regprocedure($1) IS NOT NULL AS installed FROM public._migrations ORDER BY name COLLATE "C" DESC LIMIT 1`, [signature])
  expect(rows[0]?.installed).toBe(true)
  installedHead = rows[0].name
  await initializeConversationVisibility()
  expect(publicConversationHistoryActive()).toBe(true)
}, 120_000)
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:api/conversation-visibility] public history receiving', () => {
  it('authenticates the exact installed public record owners and refuses a changed executable contract', async () => {
    const profile = await currentReleaseSource(installedHead)
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(profile.sql)
      const receipt = (Array.isArray(result) ? result.at(-1) : result)?.rows[0]
      expect(profile.functions).toBeGreaterThanOrEqual(484)
      expect(receipt).toMatchObject({ functions: profile.functions, witness_current: true })
      await client.query(profile.cleanup)
      await client.query('COMMIT')
      await client.query('BEGIN')
      await client.query(`ALTER FUNCTION ${signature} COST 901`)
      await expect(client.query(profile.sql)).rejects.toThrow('public_receiving_function_changed: read_public_conversation_history')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('hydrates the exact link visitor and withholds held rows, unsafe text and a link revoked after authentication', async () => {
    const f = await persistentContextFixture()
    const links = createChatLinkStore()
    const primary = randomUUID(), other = randomUUID()
    const address = { assistantId: f.assistantId, channelType: 'api', channelId: 'fictional-shared-address' }
    try {
      await f.pool.query('UPDATE workspaces SET external_sharing_enabled=true WHERE id=$1', [f.workspaceId])
      const link = await links.create({ assistantId: f.assistantId, createdBy: f.ownerId })
      for (const [actor, visitor] of [[primary, 'visitor-one'], [other, 'visitor-two']]) {
        await f.pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1,'channel',$2)",
          [actor, `chatlink:${link.id}:${visitor}`])
      }
      const session = await findOrCreateSession({ ...address, userId: primary })
      const otherSession = await findOrCreateSession({ ...address, userId: other })
      const scope = { ...f.envelope, sensitivity: 'public' as const }
      const visible = await addSessionMessage({ sessionId: session.id, role: 'user', scope,
        content: [{ type: 'text', text: 'Fictional first public paragraph' },
          { type: 'text', text: 'Fictional second paragraph <attached_file name="private.txt">private payload</attached_file>' }] })
      await addSessionMessage({ sessionId: session.id, role: 'assistant', scope,
        content: [{ type: 'text', text: 'tool carrier secret' }, { type: 'tool_use', id: 'tool-1', name: 'fictional', input: {} }] })
      await addSessionMessage({ sessionId: otherSession.id, role: 'user', scope,
        content: [{ type: 'text', text: 'Fictional other visitor text' }] })
      const app = express().use('/api', publicChatRoutes({ chatLinkStore: links } as PublicChatRouteOptions))
      const path = `/api/public/chat/${link.token}/messages?sessionId=${address.channelId}`
      const first = await request(app).get(path + '&visitorId=visitor-one').expect(200)
      expect(first.body).toMatchObject({ messages: [{ id: visible.id, content: 'Fictional first public paragraph\n\nFictional second paragraph' }] })
      expect(JSON.stringify(first.body)).not.toContain('tool carrier secret')
      expect(JSON.stringify(first.body)).not.toContain('private payload')
      expect((await request(app).get(path + '&visitorId=visitor-two').expect(200)).body.messages)
        .toMatchObject([{ content: 'Fictional other visitor text' }])
      expect((await request(app).get(path + '&visitorId=unknown-visitor').expect(200)).body.messages).toEqual([])

      await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [visible.id])
      expect((await request(app).get(path + '&visitorId=visitor-one').expect(200)).body.messages).toEqual([])
      const racingStore = { ...links, async resolveToken(token: string) {
        const resolved = await links.resolveToken(token)
        await links.revoke(link.id, f.assistantId)
        return resolved
      } }
      const race = express().use('/api', publicChatRoutes({ chatLinkStore: racingStore } as PublicChatRouteOptions))
      expect((await request(race).get(path + '&visitorId=visitor-two').expect(409)).body).toEqual({ error: 'authority_changed' })
      await expect(getAppPool().query(`SELECT ${signature.replace(/\(.*/, '(NULL,NULL,NULL,NULL,NULL,NULL)')}`))
        .rejects.toMatchObject({ code: '42501' })
    } finally {
      await f.cleanup()
      await f.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[primary, other]])
    }
  })

  it('uses the exact keyed visitor and the current attributed member in their separate credential purposes', async () => {
    const f = await persistentContextFixture()
    const keys = createDbApiKeyStore()
    const shadow = randomUUID(), channelId = 'fictional-keyed-session'
    try {
      await f.pool.query('UPDATE workspaces SET external_sharing_enabled=true WHERE id=$1', [f.workspaceId])
      const identity = { actingUserId: f.ownerId, assistantId: f.assistantId }
      const external = await keys.create({ ...identity, name: 'Fictional external history key' })
      const internal = await keys.create({ ...identity, name: 'Fictional member history key', audience: 'internal' })
      await f.pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1,'channel',$2)",
        [shadow, `api:${external.id}:visitor-one`])
      const input = { assistantId: f.assistantId, channelType: 'api', channelId }
      const scope = { ...f.envelope, sensitivity: 'public' as const }
      for (const [actor, text] of [[shadow, 'Fictional exact external session'], [f.ownerId, 'Fictional exact member session']]) {
        const session = await findOrCreateSession({ ...input, userId: actor })
        await addSessionMessage({ sessionId: session.id, role: 'user', scope, content: [{ type: 'text', text }] })
      }
      const app = express().use('/api/v1', publicApiRoutes({ apiKeyStore: keys } as PublicApiRouteOptions))
      const path = `/api/v1/assistants/${f.assistantId}/messages?externalUserId=visitor-one&sessionId=${channelId}`
      const read = (plaintext: string) => request(app).get(path).set('Authorization', `Bearer ${plaintext}`)
      expect((await read(external.plaintext).expect(200)).body.messages).toMatchObject([{ content: 'Fictional exact external session' }])
      expect((await read(internal.plaintext).expect(200)).body.messages).toMatchObject([{ content: 'Fictional exact member session' }])
      const stale = { ...keys, async getByIdSystem(keyId: string) {
        const key = await keys.getByIdSystem(keyId)
        await keys.revokeForUser(f.ownerId, keyId)
        return key
      } }
      const race = express().use('/api/v1', publicApiRoutes({ apiKeyStore: stale } as PublicApiRouteOptions))
      expect((await request(race).get(path).set('Authorization', `Bearer ${external.plaintext}`).expect(409)).body)
        .toEqual({ error: 'authority_changed' })
    } finally {
      await f.cleanup()
      await f.pool.query('DELETE FROM users WHERE id=$1', [shadow])
    }
  })

  it.each(['external', 'internal'] as const)('commits an ordinary %s keyed turn and addressed retry inside the conversation floor', async audience => {
    const f = await persistentContextFixture()
    const keys = createDbApiKeyStore()
    const visitor = 'fictional-public-turn-visitor'
    let credentialId: string | undefined
    let revokeDuringReply = false
    try {
      await f.pool.query('UPDATE workspaces SET external_sharing_enabled=true WHERE id=$1', [f.workspaceId])
      const key = await keys.create({ actingUserId: f.ownerId, assistantId: f.assistantId, name: 'Fictional turn key', audience })
      credentialId = key.id
      const answer: StreamFn = async function* () {
        yield { type: 'message_start', model: proModel }
        yield { type: 'text_delta', text: 'Fictional public answer' }
        if (revokeDuringReply) await keys.revokeForUser(f.ownerId, key.id)
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      }
      const provider: LLMProvider = { name: 'fixture', models: [proModel], stream: answer,
        createSession(options) { return { send: () => answer({ model: options.model, systemPrompt: options.systemPrompt, messages: [] }) } } }
      const app = express().use(express.json()).use('/api/v1', publicApiRoutes({
        apiKeyStore: keys, provider, tools: new Map(), systemPrompt: 'Fictional public turn',
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(),
      }))
      const path = `/api/v1/assistants/${f.assistantId}/messages`
      const credential = `Bearer ${key.plaintext}`
      const send = (message: string, truncateFromMessageId?: string) => request(app).post(path).set('Authorization', credential)
        .send({ externalUserId: visitor, message, ...(truncateFromMessageId ? { truncateFromMessageId } : {}) })
      const read = () => request(app).get(`${path}?externalUserId=${visitor}`).set('Authorization', credential)
      const first = await send('Fictional first visitor request')
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(first.body.reply).toBe('Fictional public answer')
      const firstHistory = await read().expect(200)
      expect(firstHistory.body.messages.map((message: { content: string }) => message.content))
        .toEqual(['Fictional first visitor request', 'Fictional public answer'])
      const retry = await send('Fictional replacement visitor request', firstHistory.body.messages[0].id)
      expect(retry.status, JSON.stringify(retry.body)).toBe(200)
      expect((await read().expect(200)).body.messages.map((message: { content: string }) => message.content))
        .toEqual(['Fictional replacement visitor request', 'Fictional public answer'])
      const persisted = await f.pool.query(`SELECT m.user_id,m.sensitivity,e.visibility
        FROM public.session_messages m JOIN public.sessions s ON s.id=m.session_id
        JOIN public.conversation_envelopes e ON e.session_id=s.id
        WHERE s.assistant_id=$1 AND s.channel_type='api' AND s.channel_id=$2 ORDER BY m.sequence_num`, [f.assistantId, visitor])
      const scope = audience === 'external'
        ? { user_id: null, sensitivity: 'public', visibility: 'workspace' }
        : { user_id: f.ownerId, sensitivity: 'confidential', visibility: 'private_by_kind' }
      expect(persisted.rows).toEqual([scope, scope])
      revokeDuringReply = true
      expect((await send('Fictional revoked reply request').expect(409)).body).toEqual({ error: 'authority_changed' })
      const afterRevocation = await f.pool.query(`SELECT m.role FROM session_messages m JOIN sessions s ON s.id=m.session_id
        WHERE s.assistant_id=$1 AND s.channel_type='api' AND s.channel_id=$2 ORDER BY m.sequence_num`, [f.assistantId, visitor])
      expect(afterRevocation.rows).toEqual([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }])
      expect((await read().expect(403)).body).toEqual({ error: 'key_revoked' })
    } finally {
      await f.cleanup()
      if (credentialId) await f.pool.query('DELETE FROM users WHERE auth_provider=$1 AND auth_provider_id=$2', ['channel', `api:${credentialId}:${visitor}`])
    }
  })
})
