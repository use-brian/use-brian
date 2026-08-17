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

  it('does not archive a directly-uploaded asset, but still dispatches the message', async () => {
    const captured: Array<Record<string, unknown>> = []
    const archiveIncoming = vi.fn(async () => {})
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: {
        getByChannelForWebhook: vi.fn(async () => ({ connectorInstanceId: 'instance-1' })),
      } as never,
      ingestor: { isIngestChannel: vi.fn(async () => false) } as never,
      bot: {
        resolveHandler: vi.fn(async (input) => {
          captured.push(input as unknown as Record<string, unknown>)
          return { kind: 'bot' as const, handle: vi.fn(async () => {}) }
        }),
      },
      archiveMedia: {
        resolveBinding: vi.fn(async () => 'instance-1'),
        complete: vi.fn(async () => ({
          id: '4a1e6bd8-0000-4000-8000-000000000001',
          workspaceId: 'workspace-1',
          instanceId: 'instance-1',
          ownerUserId: 'owner-1',
          messageId: null,
          source: 'whatsapp',
          providerMessageId: 'm1',
          kind: 'video',
          filename: 'clip.mp4',
          mime: 'video/mp4',
          sizeBytes: 123,
          expectedSha256: null,
          sha256: 'a'.repeat(64),
          storageKey: 'workspace-1/chat-archive-asset',
          storageUri: 'file://workspace-1/chat-archive-asset',
          uploadStatus: 'stored',
          extractionStatus: 'pending',
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      } as never,
      archiveIncoming,
      getChannel: vi.fn(async () => ({ workspaceId: 'workspace-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
    }))

    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({
        ...payload,
        text: '<media:video>',
        mediaMimeType: 'video/mp4',
        mediaRef: {
          assetId: '4a1e6bd8-0000-4000-8000-000000000001',
          gcsKey: 'workspace-1/chat-archive-asset',
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
          sizeBytes: 123,
        },
      })

    expect(response.status).toBe(200)
    expect(archiveIncoming).toHaveBeenCalledOnce()

    // KNOWN GAP, asserted deliberately. The BYON connector uploads bytes
    // straight to storage through a pre-signed URL, in a two-phase
    // init-then-upload flow. The archive's contract is single-shot — metadata
    // and bytes together, signed with a secret the connector does not hold —
    // so there is nothing to complete against and no archive reference is
    // produced.
    //
    // What must NOT regress is message delivery: the inbound still dispatches
    // and is still persisted, it simply carries no archived attachment. Media
    // that passes through the platform (mediaBase64) is unaffected.
    expect(captured[0]).toMatchObject({
      archiveInboundPersisted: true,
      archiveMediaType: 'video',
    })
    expect(captured[0]!.archiveMediaRef).toBeUndefined()
  })
})
