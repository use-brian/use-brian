import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, vi } from 'vitest'
import { hasTelegramWorkspaceConversationBinding, telegramConfiguredConversation } from '../telegram-conversation-admission.js'
import type { ChannelIntegrationConfig } from '../db/channel-integrations.js'

describe('[COMP:api/telegram-conversation-admission] ambient ownership is workspace scoped', () => {
  const topic = { requireMentionOverrides: [{ chatId: '-100', topicId: 134 }] }
  const binding = { version: 1, channelId: '-100', audienceType: 'group', clearance: 'internal',
    compartments: [], projectIds: [], recipientUserId: null, expiresAt: null,
    approvedByUserId: 'admin', approvedAt: '2026-10-01' } as const
  function deps(configs: ChannelIntegrationConfig[] = [], surfaces: string[] = []) {
    return { query: vi.fn(async () => ({ rows: configs.map(config => ({ config, surfaces })) })) as never,
      getWorkspaceRole: vi.fn(async () => 'admin' as const), now: () => Date.parse('2026-10-21') }
  }
  it('preserves #432 topic ownership, including General and whole-chat overrides', () => {
    expect(telegramConfiguredConversation(topic, '-100', 134)).toBe('owned')
    expect(telegramConfiguredConversation(topic, '-100', 898)).toBe('elsewhere')
    expect(telegramConfiguredConversation(topic, '-100')).toBe('elsewhere')
    expect(telegramConfiguredConversation(topic, '-200', 134)).toBe('unbound')
    expect(telegramConfiguredConversation({ requireMentionOverrides: [{ chatId: '-100' }] }, '-100', 898)).toBe('owned')
  })
  it('shares a configured conversation only among active installations in the requested workspace', async () => {
    const d = deps([topic])
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:134', 134, d)).toBe(true)
    expect(d.query).toHaveBeenCalledWith(expect.stringMatching(/c.workspace_id=\$1.*c.status='active'.*ci.status='active'/s), ['personal'])
    expect(await hasTelegramWorkspaceConversationBinding('foreign', '-100', '-100:topic:134', 134, deps())).toBe(false)
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:898', 898, d)).toBe(false)
  })
  it('ignores inventory, prior rooms and global mention policy as authority', async () => {
    const d = deps([{ requireMention: false, seenChats: [{ chatId: '-100' }] } as never])
    expect(await hasTelegramWorkspaceConversationBinding('foreign', '-100', '-100', undefined, d)).toBe(false)
  })
  it('accepts exact/parent routing but never the default route', async () => {
    for (const surface of ['-100', '-100:topic:898']) {
      expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:898', 898, deps([{}], [surface]))).toBe(true)
    }
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:898', 898, deps([{}]))).toBe(false)
  })
  it('accepts current administrator approval without widening a bot’s narrower topics', async () => {
    const config = { deliveryAudienceBindings: [{ ...binding, compartments: [], projectIds: [] }] }
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:898', 898, deps([config]))).toBe(true)
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:898', 898, deps([{ ...topic, ...config }]))).toBe(false)
    const d = deps([config]); d.getWorkspaceRole.mockResolvedValue('member' as never)
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100', undefined, d)).toBe(false)
    expect(d.getWorkspaceRole).toHaveBeenCalledWith('admin', 'personal')
  })
  it.each(['2026-10-20', 'invalid'])('rejects expired or malformed approval (%s)', async expiresAt => {
    expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100', undefined,
      deps([{ deliveryAudienceBindings: [{ ...binding, compartments: [], projectIds: [], expiresAt }] }]))).toBe(false)
  })
  it('does not convert lookup failure into ambient permission', async () => {
    const d = deps(); d.query = vi.fn(async () => { throw new Error('offline') }) as never
    await expect(hasTelegramWorkspaceConversationBinding('foreign', '-100', '-100', undefined, d)).rejects.toThrow('offline')
  })
  it('executes the real ownership query without crossing workspace or inactive-installation boundaries', async () => {
    const db = new PGlite()
    try {
      await db.exec(`CREATE TABLE channels(id text PRIMARY KEY, workspace_id text, status text);
        CREATE TABLE channel_integrations(id text PRIMARY KEY, channel_id text, channel_type text, status text, config jsonb);
        CREATE TABLE channel_assistants(channel_id text, external_surface_id text);
        INSERT INTO channels VALUES ('p', 'personal', 'active'), ('u', 'foreign', 'active'), ('r', 'revoked', 'active');
        INSERT INTO channel_integrations VALUES
          ('p', 'p', 'telegram', 'active', '{"requireMentionOverrides":[{"chatId":"-100","topicId":898}]}'),
          ('u', 'u', 'telegram', 'active', '{"seenChats":[{"chatId":"-100"}]}'),
          ('r', 'r', 'telegram', 'revoked', '{"requireMentionOverrides":[{"chatId":"-100","topicId":898}]}');`)
      const d = deps(); d.query = ((sql: string, values: unknown[]) => db.query(sql, values)) as never
      expect(await hasTelegramWorkspaceConversationBinding('personal', '-100', '-100:topic:898', 898, d)).toBe(true)
      expect(await hasTelegramWorkspaceConversationBinding('foreign', '-100', '-100:topic:898', 898, d)).toBe(false)
      expect(await hasTelegramWorkspaceConversationBinding('revoked', '-100', '-100:topic:898', 898, d)).toBe(false)
    } finally { await db.close() }
  })

})
