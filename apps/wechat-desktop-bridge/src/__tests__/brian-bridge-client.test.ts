/** [COMP:app/wechat-desktop-bridge] Use Brian raw media upload client. */
import { describe, expect, it, vi } from 'vitest'
import { createBrianBridgeClient } from '../brian-bridge-client.js'

describe('[COMP:app/wechat-desktop-bridge] Brian bridge media client', () => {
  it('streams bytes with conversation identity and integrity metadata', async () => {
    const bytes = Buffer.from('document bytes')
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(bytes)
      return new Response(JSON.stringify({
        assetId: '11111111-1111-1111-1111-111111111111',
        sha256: 'a'.repeat(64),
        filename: 'plan.docx',
        mime: 'application/octet-stream',
        sizeBytes: bytes.length,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    })
    const client = createBrianBridgeClient({
      apiUrl: 'https://app.usebrian.example',
      channelId: 'chan-example',
      token: 'bridge-token',
      fetch: fetchFn,
    })

    const result = await client.uploadMedia({
      messageId: 'provider/message-1',
      peerId: 'wxid_example1',
      kind: 'file',
      mime: 'application/octet-stream',
      filename: 'plan.docx',
      sha256: 'a'.repeat(64),
      sizeBytes: bytes.length,
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); controller.close() },
      }),
    })

    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toContain('/media/provider%2Fmessage-1?')
    expect(url).toContain('peerId=wxid_example1')
    expect(url).toContain('filename=plan.docx')
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer bridge-token',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
    })
    expect(result).toMatchObject({ filename: 'plan.docx', sizeBytes: bytes.length })
  })
})
