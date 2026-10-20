import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(async () => ({ id: 'synthetic-session' })),
  addSessionMessage: vi.fn(async () => ({ id: 'synthetic-message' })),
  setSessionMessageChannelId: vi.fn(async () => {}),
}))
vi.mock('../../db/client.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }))

import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

// Actual adapter, chunking and Slack response decoding; only HTTP and DB edges
// are mocked. Real workflow persistence is covered by the companion DB suite.
describe('[COMP:workflow/channel-delivery] Slack delivery uncertainty', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function attempt(replies: Array<object | Error>, options: { long?: boolean; attachFailure?: boolean } = {}) {
    let posts = 0
    const accepted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split('/').at(-1)
      if (method === 'users.list') return Response.json({ ok: true, members: [] })
      if (method !== 'chat.postMessage') throw new Error('Unexpected synthetic HTTP method')
      const reply = replies[posts++]
      if (!reply) throw new Error('Unexpected duplicate delivery')
      if (reply instanceof Error) throw reply
      if ('ts' in reply && typeof reply.ts === 'string') accepted.push(reply.ts)
      return Response.json(reply)
    }))
    const integrationStore = {
      getCredentialsForAssistantSystem: async () => ({
        id: 'synthetic-integration', credentials: { bot_token: 'synthetic-receipt-token' },
      }),
    } as unknown as ChannelIntegrationStore
    const outcome = await createWorkflowChannelDelivery({
      integrationStore,
      ...(options.attachFailure ? { questionStore: {
        create: async () => 'synthetic-question',
        attach: async () => { throw new Error('Synthetic local bookkeeping failure') },
      } as never } : {}),
    })({
      workspaceId: 'synthetic-workspace', assistantId: 'synthetic-assistant', userId: 'synthetic-user',
      channelType: 'slack', channelId: 'C00000001', threadRef: '1700000000.000000',
      text: options.long ? 'Synthetic chunk. '.repeat(300) : 'Synthetic message',
      ...(options.attachFailure ? { question: { question: 'Synthetic choice?', options: ['A', 'B'] } } : {}),
    })
    return { outcome, posts, accepted }
  }

  it('retains an accepted chunk when the next chunk is explicitly rejected', async () => {
    const { outcome, posts } = await attempt([
      { ok: true, ts: '1700000000.000001' }, { ok: false, error: 'channel_not_found' },
    ], { long: true })
    expect(posts).toBe(2)
    expect(outcome).toMatchObject({ status: 'failed', receipt: {
      channelId: 'C00000001', attemptedMessages: 2, messageIds: ['1700000000.000001'],
      effect: 'partial', retrySafe: false,
    } })
    expect((outcome as { error: string }).error).not.toMatch(/NOT posted|nobody was notified|retry once|nothing was posted/)
    expect((outcome as { error: string }).error).toMatch(/check|inspect/i)
    expect(JSON.stringify((outcome as { receipt: unknown }).receipt)).not.toContain('Synthetic chunk')
  })

  it.each(['internal_error', 'fatal_error', 'synthetic_unknown_code'])('requires reconciliation for %s on the first request', async code => {
    const { outcome, posts } = await attempt([{ ok: false, error: code }])
    expect(posts).toBe(1)
    expect(outcome).toMatchObject({ status: 'failed', receipt: { effect: 'unknown', retrySafe: false, messageIds: [], attemptedMessages: 1 } })
    expect((outcome as { error: string }).error).toMatch(/may already/)
    expect((outcome as { error: string }).error).not.toMatch(/retry once|NOT posted|nobody/)
  })

  it('treats a lost response as uncertain and keeps raw transport error text out of the receipt and outcome', async () => {
    const { outcome, posts } = await attempt([new Error('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL')])
    expect(posts).toBe(1)
    expect(outcome).toMatchObject({ status: 'failed', receipt: { effect: 'unknown', retrySafe: false } })
    expect(JSON.stringify(outcome)).not.toContain('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL')
  })

  it('keeps a known first-chunk rejection retry-safe after correcting its cause', async () => {
    const { outcome, posts } = await attempt([{ ok: false, error: 'channel_not_found' }])
    expect(posts).toBe(1)
    expect(outcome).toMatchObject({ status: 'failed', receipt: { effect: 'none', retrySafe: true, messageIds: [], attemptedMessages: 1 } })
    expect((outcome as { error: string }).error).toContain('listSlackChannels')
  })

  it('does not report success when Slack omits the message acknowledgement', async () => {
    const { outcome, posts } = await attempt([{ ok: true }], { long: true })
    expect(posts).toBe(1)
    expect(outcome).toMatchObject({ status: 'failed', receipt: { effect: 'unknown', retrySafe: false } })
  })

  it('retains complete acknowledgements when local question attachment fails without resending', async () => {
    const { outcome, posts } = await attempt([{ ok: true, ts: '1700000000.000002' }], { attachFailure: true })
    expect(posts).toBe(1)
    expect(outcome).toMatchObject({ status: 'failed', receipt: { effect: 'complete', retrySafe: false, messageIds: ['1700000000.000002'] } })
    expect((outcome as { error: string }).error).toMatch(/acknowledged/)
  })

  it('preserves every successful chunk acknowledgement', async () => {
    const { outcome, posts, accepted } = await attempt([
      { ok: true, ts: '1700000000.000003' }, { ok: true, ts: '1700000000.000004' },
    ], { long: true })
    expect(posts).toBe(2)
    expect(outcome).toMatchObject({ status: 'delivered', messageId: accepted.at(-1), receipt: {
      effect: 'complete', retrySafe: false, attemptedMessages: 2, messageIds: accepted,
    } })
  })
})
