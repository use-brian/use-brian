import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { whatsappByonRoutes } from '../whatsapp-byon.js'

const payload = {
  channelId: 'byon-channel',
  chatJid: '15551234567@s.whatsapp.net',
  senderJid: '15551234567@s.whatsapp.net',
  messageId: 'm1',
  text: 'hello',
  timestamp: 1,
  isGroup: false,
}

function appFor(listenerActive: boolean, botHandler: { handle(): Promise<void> } | null, fallback = false) {
  const app = express()
  app.use(express.json())
  app.use('/internal/whatsapp', whatsappByonRoutes({
    connectorSecret: 'secret',
    integrationStore: { getByChannelForWebhook: vi.fn(), setStatusByChannelSystem: vi.fn() } as never,
    ingestor: { isIngestChannel: vi.fn(async () => listenerActive), ingest: vi.fn() } as never,
    bot: { resolveHandler: vi.fn(async () => botHandler && ({ kind: 'bot' as const, ...botHandler })) },
    passUnknownToFallback: fallback,
  }))
  app.post('/internal/whatsapp/inbound', (_req, res) => res.status(418).json({ official: true }))
  return app
}

describe('[COMP:api/whatsapp-byon-route] internal routing', () => {
  it('mints a signed local-storage PUT URL for large media', async () => {
    const storage = { signedWriteUrl: vi.fn(async () => 'http://localhost:4000/api/local-files?signed=1') }
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: {} as never,
      ingestor: {} as never,
      bot: {} as never,
      filesResolver: {
        forWorkspace: vi.fn(async () => ({ gcs: storage, bucket: '/data/files', uriScheme: 'file' as const })),
      } as never,
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
    }))

    const response = await request(app)
      .post('/internal/whatsapp/media-upload-url')
      .set('X-Connector-Secret', 'secret')
      .send({ channelId: 'byon-channel', mime: 'video/mp4', fileName: 'clip.mp4' })

    expect(response.status).toBe(200)
    expect(response.body.uploadUrl).toBe('http://localhost:4000/api/local-files?signed=1')
    expect(response.body.gcsKey).toMatch(/^ws-1\/channel-media\//)
    expect(response.body.storageUri).toMatch(/^file:\/\/\/data\/files\/ws-1\/channel-media\//)
  })

  it('handles a BYON inbound instead of returning 404', async () => {
    const handle = vi.fn(async () => {})
    const response = await request(appFor(false, { handle }))
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send(payload)
    expect(response.status).toBe(200)
    expect(handle).toHaveBeenCalledOnce()
  })

  it('passes an unknown channel to the closed official fallback', async () => {
    const response = await request(appFor(false, null, true))
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({ ...payload, channelId: 'system' })
    expect(response.status).toBe(418)
    expect(response.body).toEqual({ official: true })
  })

  it('passes a streamed media reference to the hosted media-ingest fallback', async () => {
    const handle = vi.fn(async () => {})
    const response = await request(appFor(true, { handle }, true))
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({
        ...payload,
        text: '<media:video>',
        mediaRef: { gcsKey: 'ws/channel-media/video', mimeType: 'video/mp4' },
      })
    expect(response.status).toBe(418)
    expect(response.body).toEqual({ official: true })
    expect(handle).not.toHaveBeenCalled()
  })

  it('acks and drops an unknown channel in OSS', async () => {
    const response = await request(appFor(false, null))
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({ ...payload, channelId: 'unknown' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })
})
