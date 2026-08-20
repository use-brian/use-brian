/** [COMP:app/wechat-desktop-bridge] agent-wechat media descriptor + raw stream client. */
import { describe, expect, it, vi } from 'vitest'
import { createAgentWechatClient } from '../agent-wechat-client.js'

describe('[COMP:integrations/agent-wechat-runtime] media descriptor contract', () => {
  it('requests compact descriptors for reads and recovery actions', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({
      type: 'image',
      format: 'jpeg',
      filename: 'photo.jpg',
      status: 'ready',
      kind: 'image',
      sizeBytes: 5,
      sha256: 'a'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } }))
    const client = createAgentWechatClient({
      baseUrl: 'http://agent-wechat.example',
      token: 'test-token',
      fetch: fetchFn,
    })

    await client.getMedia('wxid_example1', 7)
    await client.ensureMedia('wxid_example1', 7)

    expect(fetchFn.mock.calls[0]![0]).toBe(
      'http://agent-wechat.example/api/messages/wxid_example1/media/7?descriptorOnly=true',
    )
    expect(fetchFn.mock.calls[1]![0]).toBe(
      'http://agent-wechat.example/api/messages/wxid_example1/media/7/ensure?descriptorOnly=true',
    )
  })

  it('exposes the raw content stream and integrity metadata', async () => {
    const bytes = Buffer.from('hello')
    const client = createAgentWechatClient({
      baseUrl: 'http://agent-wechat.example',
      token: 'test-token',
      fetch: async () => new Response(bytes, {
        headers: {
          'Content-Length': String(bytes.length),
          'Content-Type': 'image/jpeg',
          'Content-Disposition': 'attachment; filename="photo.jpg"',
          ETag: `"${'b'.repeat(64)}"`,
        },
      }),
    })

    const content = await client.getMediaContent('wxid_example1', 7)
    expect(content).toMatchObject({
      contentLength: 5,
      mime: 'image/jpeg',
      filename: 'photo.jpg',
      etag: 'b'.repeat(64),
    })
    expect(Buffer.from(await new Response(content.body).arrayBuffer())).toEqual(bytes)
  })
})
