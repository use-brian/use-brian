import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { sockets } = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }))
vi.mock('ws', () => ({ WebSocket: class extends EventEmitter {
  constructor() { super(); sockets.push(this) }
  close() {}
  removeAllListeners() { return super.removeAllListeners() }
} }))
import { createGatewayManager } from '../gateway-manager.js'

afterEach(() => { vi.unstubAllGlobals(); sockets.length = 0 })
describe('Gateway workflow message forwarding', () => {
  it('forwards passive text/media once, preserves addressing, and excludes echoes/callbacks', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const manager = createGatewayManager({ apiUrl: 'https://api.example', connectorSecret: 'secret' })
    manager.connect('integration-channel', { botToken: 'token', botUserId: 'bot' })
    const send = (id: string, fields = {}, type = 'MESSAGE_CREATE') => sockets[0].emit('message', Buffer.from(JSON.stringify({
      op: 0, t: type, d: { id, channel_id: 'room', guild_id: 'guild', author: { id: 'user' }, content: 'passive', timestamp: '2026-01-01T00:00:00Z', ...fields },
    })))
    try {
      send('text')
      send('text') // RESUME replay
      send('media', { content: '', attachments: [{ id: 'file', url: 'https://cdn.example/file', filename: 'file.mp3', content_type: 'audio/mpeg' }] })
      send('mention', { content: '<@bot> hello', mentions: [{ id: 'bot' }] })
      send('reply', { referenced_message: { author: { id: 'bot' } } })
      send('mention-only', { content: '<@bot>', mentions: [{ id: 'bot' }] })
      send('echo', { author: { id: 'bot', bot: true } })
      send('webhook', { webhook_id: 'webhook' })
      send('text', { content: 'edited' }, 'MESSAGE_UPDATE')
      send('callback', { type: 3, token: 'token', user: { id: 'user' }, data: { component_type: 2, custom_id: 'ask:choice' } }, 'INTERACTION_CREATE')
      await new Promise(r => setImmediate(r))
      const posts = fetchMock.mock.calls.map(call => call as unknown as [string, RequestInit])
      const messages = posts.filter(([url]) => url.endsWith('/inbound')).map(([, init]) => JSON.parse(String(init.body)))
      expect(messages).toHaveLength(5)
      expect(messages.map(m => m.message.isMentioned)).toEqual([false, false, true, true, true])
      expect(messages[0]).toMatchObject({ channelId: 'integration-channel', message: { messageId: 'text', timestamp: Date.parse('2026-01-01T00:00:00Z') } })
      expect(messages[1].message.files).toHaveLength(1)
      expect(messages[4].message).toMatchObject({ messageId: 'mention-only', text: '', raw: { mentions: [{ id: 'bot' }] } })
      // The API needs provider mention IDs even after normalized text strips @bot.
      expect(messages[2].message.raw.mentions).toEqual([{ id: 'bot' }])
      expect(posts.filter(([url]) => url.endsWith('/interaction'))).toHaveLength(1)
    } finally { manager.disconnectAll() }
  })
})
