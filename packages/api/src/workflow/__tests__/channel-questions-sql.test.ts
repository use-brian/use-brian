import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChannelQuestionStore, handleChannelQuestionReply, type ChannelQuestion } from '../channel-questions.js'
import type { query } from '../../db/client.js'

const address = {
  integrationId: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002',
  assistantId: '00000000-0000-4000-8000-000000000003', userId: '00000000-0000-4000-8000-000000000004', channelId: 'C1',
}
let db: PGlite
const store = createChannelQuestionStore((async (sql, args) => db.query(sql, args)) as typeof query)
const dispatch = vi.fn(async (_binding: ChannelQuestion, _answer: string, claim: () => Promise<boolean>) =>
  await claim() ? 'sent' : 'already answered')
const reply = (overrides: Partial<Parameters<typeof handleChannelQuestionReply>[0]> = {}) => handleChannelQuestionReply({
  store, address, text: 'prod', threadId: 'root', answerMessageId: 'answer-2',
  authorized: async () => true, dispatch, ...overrides,
})
async function question(messageId: string, threadRef: string | null = 'root') {
  const token = await store.create({ ...address, threadRef: threadRef ?? undefined, question: { question: 'Where?', options: ['dev', 'prod'] },
    response: { toolName: 'answer', arguments: {}, answerField: 'answer' } })
  await store.attach(token, messageId)
  return (await store.find(address, { token }))[0]!
}

beforeAll(async () => {
  db = new PGlite()
  // Use the real migration and UUID/JSONB schema, with minimal FK parents.
  for (const [table, id] of [['channel_integrations', address.integrationId], ['workspaces', address.workspaceId],
    ['assistants', address.assistantId], ['users', address.userId]]) {
    await db.exec(`CREATE TABLE ${table} (id uuid PRIMARY KEY)`)
    await db.query(`INSERT INTO ${table} VALUES ($1)`, [id])
  }
  await db.exec(readFileSync(new URL('../../../migrations/561_workflow_channel_questions.sql', import.meta.url), 'utf8'))
}, 30_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await db.exec('TRUNCATE workflow_channel_questions'); dispatch.mockClear() })

describe('workflow question SQL thread selection', () => {
  it.each(['consumed', 'expired'])('answers Q2 in the same Slack thread after Q1 is %s', async status => {
    const first = await question('prompt-1')
    if (status === 'consumed') expect(await store.consume(first, 'answer-1')).toBe(true)
    else await db.query("UPDATE workflow_channel_questions SET expires_at=now()-interval '1 second' WHERE token=$1", [first.token])
    const second = await question('prompt-2')
    // Shared ingress separates Slack thread_ts from exact source-message replies.
    expect(await reply()).toBe('sent')
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ token: second.token }), 'prod', expect.any(Function))
    expect((await store.find(address, { token: second.token }))[0]?.available).toBe(false)
  })

  it.each(['consumed', 'expired'])('answers Q2 when the %s Q1 is the thread root itself', async status => {
    const first = await question('root', null)
    if (status === 'consumed') await store.consume(first, 'answer-1')
    else await db.query("UPDATE workflow_channel_questions SET expires_at=now()-interval '1 second' WHERE token=$1", [first.token])
    const second = await question('prompt-2')
    expect(await reply()).toBe('sent')
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ token: second.token }), 'prod', expect.any(Function))
  })

  it('never chooses a live root question over another live question in that thread', async () => {
    await question('root', null); await question('prompt-2')
    expect(await reply()).toContain('ambiguous')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not let a replay of a root question answer consume its successor', async () => {
    await store.consume(await question('root', null), 'answer-1')
    await question('prompt-2')
    expect(await reply({ answerMessageId: 'answer-1' })).toContain('ambiguous')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps multiple genuinely active questions ambiguous', async () => {
    await question('prompt-1'); await question('prompt-2')
    expect(await reply()).toContain('ambiguous')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each(['consumed', 'expired'])('preserves exact-message and token tombstones for %s questions ahead of thread matches', async status => {
    const first = await question('prompt-1')
    if (status === 'consumed') await store.consume(first, 'answer-1')
    else await db.query("UPDATE workflow_channel_questions SET expires_at=now()-interval '1 second' WHERE token=$1", [first.token])
    await question('prompt-2', 'prompt-1')
    expect(await reply({ replyToMessageId: 'prompt-1', threadId: 'prompt-1' })).toContain('expired or was already answered')
    expect(await reply({ text: `wq:${first.token} prod`, replyToMessageId: undefined })).toContain('expired or was already answered')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not use a replay of Q1\'s answer to consume active Q2', async () => {
    await store.consume(await question('prompt-1'), 'answer-1')
    const second = await question('prompt-2')
    expect(await reply({ answerMessageId: 'answer-1' })).toContain('ambiguous')
    expect(dispatch).not.toHaveBeenCalled()
    expect((await store.find(address, { token: second.token }))[0]?.available).toBe(true)
  })

  it('keeps an exhausted thread fail-closed and legacy questions without thread metadata readable', async () => {
    await store.consume(await question('prompt-1'), 'answer-1')
    expect(await reply()).toContain('unavailable')
    expect(dispatch).not.toHaveBeenCalled()
    const legacy = await question('legacy', undefined)
    // Simulate pre-thread-provenance JSON from the original schema.
    await db.query("UPDATE workflow_channel_questions SET question=question-'__channelThreadRef' WHERE token=$1", [legacy.token])
    expect(await reply({ replyToMessageId: 'legacy', threadId: undefined })).toBe('sent')
  })
})
