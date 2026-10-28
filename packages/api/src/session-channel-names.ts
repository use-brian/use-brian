/** Provider metadata for admitted personal-history rows; never a conversation title.
 * Spec: docs/architecture/features/chat-app.md → Sidebar panel.
 * [COMP:api/session-channel-names]
 */
import type { ChannelIntegrationStore, SeenChat } from './db/channel-integrations.js'

type ChannelRow = { id: string; channelType: string; channelId: string }
export type ResolveSessionChannelNames = (input: {
  userId: string; workspaceId: string; rows: ChannelRow[]
}) => Promise<Map<string, string>>

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

export function createSessionChannelNameResolver(options: {
  integrationStore?: Pick<ChannelIntegrationStore, 'listForWorkspace' | 'getForUserWithCredentials'>
  telegramBotToken?: string
}): ResolveSessionChannelNames {
  const cache = new Map<string, { expires: number; value: Promise<string | null> }>()
  return async ({ userId, workspaceId, rows }) => {
    const names = new Map<string, string>()
    const channelRows = rows.filter(row => row.channelType !== 'web')
    if (!channelRows.length) return names
    // Recheck RLS/current integration access on every request, before cache reuse.
    const integrations = options.integrationStore
      ? (await options.integrationStore.listForWorkspace(userId, workspaceId)).filter(row => row.status === 'active')
      : []
    const signal = AbortSignal.timeout(1500)
    let remaining = 8
    const pending = new Map<string, Promise<string | null>>()
    const credentials = new Map<string, Promise<string | null>>()
    const tokenFor = (id: string) => {
      let token = credentials.get(id)
      if (!token) {
        token = options.integrationStore!.getForUserWithCredentials(userId, id)
          .then(row => row && 'bot_token' in row.credentials ? text(row.credentials.bot_token) : null)
          .catch(() => null)
        credentials.set(id, token)
      }
      return token
    }
    const lookup = (type: string, id: string): Promise<string | null> => {
      const destination = JSON.stringify([type, id])
      const existing = pending.get(destination)
      if (existing) return existing
      const sources = integrations.filter(row => row.channelType === type)
      const key = JSON.stringify([userId, workspaceId, type, id,
        sources.map(row => [row.id, row.teamId, row.botUserId, row.updatedAt]),
        type === 'telegram' && Boolean(options.telegramBotToken)])
      const hit = cache.get(key)
      if (hit && hit.expires > Date.now()) return hit.value
      if (!remaining || signal.aborted) return Promise.resolve(null)
      remaining--
      const value = (async () => {
        const tokens = (await Promise.all(sources.map(row => tokenFor(row.id)))).filter((v): v is string => Boolean(v))
        if (type === 'telegram' && options.telegramBotToken) tokens.push(options.telegramBotToken)
        for (const token of new Set(tokens)) {
          if (signal.aborted) break
          try {
            if (type === 'telegram') {
              const response = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: id }), signal,
              })
              const data = await response.json() as { ok: boolean; result?: { title?: string; first_name?: string; last_name?: string; username?: string } }
              if (!response.ok || !data.ok || !data.result) continue
              const chat = data.result
              const name = text(chat.title) ?? text([chat.first_name, chat.last_name].filter(Boolean).join(' '))
                ?? (text(chat.username) ? `@${chat.username}` : null)
              if (name) return name
            } else if (type === 'slack') {
              const read = async (method: string, params: Record<string, string>) => {
                const response = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
                  headers: { Authorization: `Bearer ${token}` }, signal,
                })
                if (!response.ok) throw new Error('Provider metadata unavailable')
                const data = await response.json() as {
                  ok: boolean; channel?: { name?: string; user?: string; is_im?: boolean };
                  user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } }
                }
                if (!data.ok) throw new Error('Provider metadata unavailable')
                return data
              }
              const { channel } = await read('conversations.info', { channel: id })
              if (text(channel?.name)) return channel!.is_im ? text(channel!.name) : `#${channel!.name!.trim()}`
              if (channel?.user) {
                const { user } = await read('users.info', { user: channel.user })
                const name = text(user?.profile?.display_name) ?? text(user?.profile?.real_name) ?? text(user?.real_name) ?? text(user?.name)
                if (name) return name
              }
            }
          } catch {
            // Missing scopes, revoked tokens and provider outages preserve the ID fallback.
          }
        }
        return null
      })()
      pending.set(destination, value)
      if (cache.size >= 1000) cache.delete(cache.keys().next().value!)
      const entry = { expires: Date.now() + 300_000, value }
      cache.set(key, entry)
      void value.then(name => { entry.expires = Date.now() + (name ? 300_000 : 30_000) })
      return value
    }
    await Promise.all(channelRows.map(async row => {
      const channelId = row.channelType === 'slack' || row.channelType === 'feishu'
        ? row.channelId.split(':thread:')[0] : row.channelId
      const telegram = row.channelType === 'telegram' ? /^(-?\d+)(?::(topic|discussion):(\d+))?$/.exec(channelId) : null
      const chatId = telegram?.[1] ?? channelId
      const observed = integrations.filter(integration => integration.channelType === row.channelType)
        .flatMap(integration => integration.config.seenChats ?? [])
        .filter(chat => chat.chatId === chatId).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      const topics = observed.flatMap((chat: SeenChat) => chat.topics)
        .filter(topic => String(topic.topicId) === telegram?.[3]).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      let name = observed.map(chat => text(chat.chatTitle)).find(Boolean) ?? null
      if (!name && ((row.channelType === 'telegram' && telegram) || (row.channelType === 'slack' && /^[CDG][A-Z0-9]+$/.test(channelId)))) {
        name = await lookup(row.channelType, chatId)
      }
      if (telegram?.[3]) {
        const topic = topics.map(topic => text(topic.name)).find(Boolean)
        if (name || topic) name = `${name ?? chatId} › ${telegram[2] === 'discussion' ? `#${telegram[3]}` : topic ?? `#${telegram[3]}`}`
      }
      if (name) names.set(row.id, name)
    }))
    return names
  }
}
