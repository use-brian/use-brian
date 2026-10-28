import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionChannelNameResolver } from '../session-channel-names.js'
import type { ChannelIntegration } from '../db/channel-integrations.js'

const integration = (channelType: string, config = {}, fields = {}): ChannelIntegration => ({
  id: channelType, channelType, channelId: `installation-${channelType}`, status: 'active', config,
  teamId: null, botUserId: null, updatedAt: new Date('2026-01-01'), ...fields,
} as ChannelIntegration)
const row = (id: string, channelType: string, channelId: string) => ({ id, channelType, channelId })
const input = (rows: ReturnType<typeof row>[]) => ({ userId: 'viewer', workspaceId: 'workspace', rows })
const store = (rows: ChannelIntegration[]) => ({
  listForWorkspace: vi.fn().mockResolvedValue(rows),
  getForUserWithCredentials: vi.fn().mockResolvedValue({ credentials: { bot_token: 'fictional-token' } }),
})
const response = (body: unknown) => new Response(JSON.stringify(body))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('[COMP:api/session-channel-names] source metadata', () => {
  it('uses observed group/topic names, preserves distinct topics and selects the latest nonempty names', async () => {
    const seen = (chatTitle: string | null, name: string | null, lastSeenAt: string) => ({
      chatId: '-1000000000000', chatTitle, lastSeenAt, isForum: true,
      topics: [{ topicId: 12, name, lastSeenAt }],
    })
    const integrationStore = store([
      integration('telegram', { seenChats: [seen('Old group', 'Old topic', '2026-01-01')] }),
      integration('telegram', { seenChats: [seen('Product team', 'Launch', '2026-01-02')] }, { id: 'second-bot' }),
      integration('telegram', { seenChats: [seen(null, null, '2026-01-03')] }, { id: 'third-bot' }),
    ])
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const resolve = createSessionChannelNameResolver({ integrationStore })
    const result = await resolve(input([
      row('topic', 'telegram', '-1000000000000:topic:12'), row('unknown-topic', 'telegram', '-1000000000000:topic:13'),
      row('group', 'telegram', '-1000000000000'),
    ]))
    expect(Object.fromEntries(result)).toEqual({ topic: 'Product team › Launch', 'unknown-topic': 'Product team › #13', group: 'Product team' })
    expect(fetch).not.toHaveBeenCalled()
    expect(integrationStore.getForUserWithCredentials).not.toHaveBeenCalled()
  })

  it('resolves Slack thread parents and DM participants, without using chat titles', async () => {
    const fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('users.info')) return response({ ok: true, user: { profile: { display_name: 'Alex Example' } } })
      return response({ ok: true, channel: parsed.searchParams.get('channel') === 'D123' ? { is_im: true, user: 'U123' } : { name: 'engineering' } })
    }); vi.stubGlobal('fetch', fetch)
    const resolve = createSessionChannelNameResolver({ integrationStore: store([integration('slack')]) })
    const result = await resolve(input([
      row('thread-1', 'slack', 'C123:thread:1.001'), row('thread-2', 'slack', 'C123:thread:2.001'), row('dm', 'slack', 'D123'),
    ]))
    expect(Object.fromEntries(result)).toEqual({ 'thread-1': '#engineering', 'thread-2': '#engineering', dm: 'Alex Example' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('resolves Telegram base chats once for multiple topics, including hosted bot fallback', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: true, result: { title: 'Research team' } })); vi.stubGlobal('fetch', fetch)
    const resolve = createSessionChannelNameResolver({ telegramBotToken: 'fictional-hosted-token' })
    const result = await resolve(input([row('a', 'telegram', '-1000000000000:topic:7'), row('b', 'telegram', '-1000000000000:topic:8')]))
    expect([...result.values()]).toEqual(['Research team › #7', 'Research team › #8'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ chat_id: '-1000000000000' })
  })

  it('preserves missing names on errors, invalid legacy IDs and unavailable integrations', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('unavailable')); vi.stubGlobal('fetch', fetch)
    const integrationStore = store([integration('slack'), integration('telegram', {}, { status: 'revoked' })])
    const resolve = createSessionChannelNameResolver({ integrationStore })
    const result = await resolve(input([row('bad', 'slack', 'legacy-uuid'), row('numeric', 'slack', '12345'), row('failed', 'slack', 'C123'), row('revoked', 'telegram', '12345')]))
    expect(result.size).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(integrationStore.getForUserWithCredentials).toHaveBeenCalledWith('viewer', 'slack')
  })

  it('isolates cached lookups by viewer/workspace and rechecks integration authority', async () => {
    const fetch = vi.fn(() => Promise.resolve(response({ ok: true, channel: { name: 'general' } }))); vi.stubGlobal('fetch', fetch)
    const integrationStore = store([integration('slack')])
    const resolve = createSessionChannelNameResolver({ integrationStore })
    const request = input([row('a', 'slack', 'C123')])
    await resolve(request); await resolve(request)
    expect(fetch).toHaveBeenCalledTimes(1)
    await resolve({ ...request, userId: 'another-viewer' })
    await resolve({ ...request, workspaceId: 'another-workspace' })
    expect(fetch).toHaveBeenCalledTimes(3)
    integrationStore.listForWorkspace.mockResolvedValue([])
    expect((await resolve(request)).size).toBe(0)
  })

  it('bounds remote work and progressively resolves additional destinations on refresh', async () => {
    const fetch = vi.fn(() => Promise.resolve(response({ ok: true, channel: { name: 'team' } }))); vi.stubGlobal('fetch', fetch)
    const resolve = createSessionChannelNameResolver({ integrationStore: store([integration('slack')]) })
    const request = input(Array.from({ length: 12 }, (_, i) => row(`s${i}`, 'slack', `C${i}`)))
    expect((await resolve(request)).size).toBe(8)
    expect((await resolve(request)).size).toBe(12)
    expect(fetch).toHaveBeenCalledTimes(12)
  })

  it('aborts stalled providers within the shared deadline', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })))
    const resolve = createSessionChannelNameResolver({ integrationStore: store([integration('slack')]) })
    expect((await resolve(input([row('a', 'slack', 'C123')]))).size).toBe(0)
  })
})
