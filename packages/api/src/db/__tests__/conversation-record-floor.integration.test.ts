/** [COMP:api/conversation-visibility] Exact successor profile and capture epochs. */
import { afterAll, describe, expect, it } from 'vitest'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { authSessionStore } from '../auth-session-store.js'
import { getAppPool, getPool, rollbackAndRelease } from '../client.js'
import { captureNativeConversationRecord } from '../conversation-record.js'
import { addSessionMessage, truncateMessagesFrom } from '../sessions.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { buildRecordFloorCandidate } = await import(new URL('../../../scripts/conversation-store/build-conversation-record-floor.mjs', import.meta.url).href)
const { recordFloorInstallationSource } = await import(new URL('../../../scripts/conversation-store/installation-authentication-8307.mjs', import.meta.url).href)

afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe.sequential('[COMP:api/conversation-visibility] publication floor and capture epoch', () => {
  it('authenticates the reviewed successor and refuses changed fused admission metadata', async () => {
    const client = await getPool().connect()
    try {
      const reviewed = await recordFloorInstallationSource(await buildRecordFloorCandidate())
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const proof = await client.query(reviewed.sql)
      expect((Array.isArray(proof) ? proof.at(-1) : proof)?.rows[0]).toMatchObject({ functions: 472, witness_current: true })
      await client.query(reviewed.cleanup)
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query('ALTER FUNCTION fused_l_message_snapshot(jsonb,uuid,uuid,jsonb) COST 101')
      await expect(client.query(reviewed.sql)).rejects.toThrow('installation_current_guard_changed')
    } finally { await rollbackAndRelease(client) }
  }, 60_000)

  it('withdraws both overlapping captures and preserves the new capture across reused reply positions', async () => {
    const f = await persistentContextFixture('internal')
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional retry fixture', userAgent: null, ipAddress: null }))!
      const actor = { userId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion }
      const append = (role: 'user' | 'assistant', text: string) => addSessionMessage({
        sessionId: f.session.id, role, content: [{ type: 'text', text }], scope: f.envelope,
        ...(role==='user' ? { senderUserId:f.ownerId } : { senderAssistantId:f.assistantId }),
      })
      const capture = (afterSequence: number, throughSequence: number) => captureNativeConversationRecord(actor, {
        workspaceId: f.workspaceId, sessionId: f.session.id, afterSequence, throughSequence, topicThroughSequence: throughSequence,
      })
      await append('assistant','Fictional previous conversation.')
      const initialInput = await append('user','Fictional replaced question.')
      await append('assistant','Fictional replaced answer.')
      const first = await capture(0,3)
      const overlap = await capture(1,3)
      expect(first.generation).toBe(overlap.generation)
      expect(first.source.resourceId).not.toBe(overlap.source.resourceId)
      expect((await truncateMessagesFrom(initialInput.id,f.session.id)).deleted).toBe(2)
      const newInput = await append('user','Fictional new question.')
      expect(newInput.sequenceNum).toBe(2)
      const replacement = await capture(0,2)
      expect(replacement.generation).not.toBe(first.generation)
      expect((await append('assistant','Fictional replacement answer.')).sequenceNum).toBe(3)
      const reopened = await capture(0,3)
      expect(reopened.generation).toBe(replacement.generation)
      expect(reopened.rows.map(row=>row.content)).toEqual([
        [{type:'text',text:'Fictional previous conversation.'}],
        [{type:'text',text:'Fictional new question.'}],
        [{type:'text',text:'Fictional replacement answer.'}],
      ])
      const originalSources = (await f.pool.query<{held:boolean}>(`SELECT
        (public.read_conversation_record_source($1,capture_id)->>'held')::boolean held
        FROM unnest($2::uuid[]) capture_id`,
        [f.workspaceId,[first.source.resourceId,overlap.source.resourceId,replacement.source.resourceId]])).rows
      expect(originalSources.map(row=>row.held)).toEqual([true,true,false])
    } finally { await f.cleanup() }
  })
})
