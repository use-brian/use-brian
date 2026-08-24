import { describe, expect, it, vi } from 'vitest'
import { createFeishuConnectorClient } from '../connector-client.js'

describe('[COMP:channels/feishu-connector-client] lifecycle client', () => {
  it('authenticates and encodes connect requests', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      channelId: 'channel/1',
      brand: 'lark',
      status: 'connected',
      reconnectCount: 0,
      rejectCount: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createFeishuConnectorClient({
      connectorUrl: 'http://connector.test/',
      connectorSecret: 'shared',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.connect('channel/1', {
      appId: 'cli', appSecret: 'secret', brand: 'lark',
    })).resolves.toMatchObject({ status: 'connected', brand: 'lark' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://connector.test/connect/channel%2F1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Connector-Secret': 'shared' }),
        body: JSON.stringify({ appId: 'cli', appSecret: 'secret', brand: 'lark' }),
      }),
    )
  })

  it('disconnects and treats a missing status as null', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
    const client = createFeishuConnectorClient({
      connectorUrl: 'http://connector.test',
      connectorSecret: 'shared',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.disconnect('channel')).resolves.toBeUndefined()
    await expect(client.status('channel')).resolves.toBeNull()
  })

  it('surfaces non-404 connector failures without exposing the secret', async () => {
    const client = createFeishuConnectorClient({
      connectorUrl: 'http://connector.test',
      connectorSecret: 'shared-secret',
      fetchImpl: vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(client.status('channel')).rejects.toThrow('503 down')
    await expect(client.status('channel')).rejects.not.toThrow('shared-secret')
  })
})
