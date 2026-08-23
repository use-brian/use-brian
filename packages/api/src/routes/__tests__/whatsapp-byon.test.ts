import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../chat-archive/live-writer.js', () => ({
  appendOutboundChatArchive: vi.fn(async () => {}),
  resolveChatArchiveInstanceId: vi.fn(async () => 'inst-1'),
}))

import { appendOutboundChatArchive } from '../../chat-archive/live-writer.js'
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

  it('archives the owner\'s own (fromMe) message as outbound and never runs a turn', async () => {
    const handle = vi.fn(async () => {})
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: { getByChannelForWebhook: vi.fn(async () => null), setStatusByChannelSystem: vi.fn() } as never,
      ingestor: { isIngestChannel: vi.fn(async () => true), ingest: vi.fn() } as never,
      bot: { resolveHandler: vi.fn(async () => ({ kind: 'bot' as const, handle })) },
      archiveIncoming: vi.fn(async () => {}),
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
    }))
    app.post('/internal/whatsapp/inbound', (_req, res) => res.status(418).json({ official: true }))
    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({ ...payload, messageId: 'self-1', fromMe: true, text: 'note to self' })
    expect(response.status).toBe(200)
    // The assistant must never answer the user's own outgoing message.
    expect(handle).not.toHaveBeenCalled()
  })

  it("archives the owner's own (fromMe) IMAGE with the staged asset ref, not text-only", async () => {
    vi.mocked(appendOutboundChatArchive).mockClear()
    const storeBuffer = vi.fn(async () => ({
      assetId: '22222222-2222-2222-2222-222222222222',
      sha256: 'b'.repeat(64),
      filename: 'sent.jpg',
      mime: 'image/jpeg',
      sizeBytes: 12,
    }))
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: { getByChannelForWebhook: vi.fn(async () => null), setStatusByChannelSystem: vi.fn() } as never,
      ingestor: { isIngestChannel: vi.fn(async () => true), ingest: vi.fn() } as never,
      bot: { resolveHandler: vi.fn(async () => null) },
      archiveIncoming: vi.fn(async () => {}),
      archiveMedia: { storeBuffer, uploadTarget: vi.fn() } as never,
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
    }))
    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({
        ...payload,
        messageId: 'self-img-1',
        fromMe: true,
        text: '<media:image>',
        mediaBase64: Buffer.from('sent-bytes').toString('base64'),
        mediaMimeType: 'image/jpeg',
        mediaFileName: 'sent.jpg',
      })
    expect(response.status).toBe(200)
    expect(storeBuffer).toHaveBeenCalledTimes(1)
    expect(appendOutboundChatArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendOutboundChatArchive).mock.calls[0][0]).toMatchObject({
      providerMessageId: 'self-img-1',
      text: '',
      archiveMedia: {
        kind: 'image',
        ref: { assetId: '22222222-2222-2222-2222-222222222222', filename: 'sent.jpg' },
      },
    })
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

  /**
   * A streamed attachment must reach the archive.
   *
   * The connector streams video and audio files straight to workspace storage
   * regardless of size and relays only a reference, so for a long time these
   * were archived as a message row with no asset and no segments — a video was
   * recorded as having happened but nothing about its contents was searchable.
   * The bytes are durably written by the time /inbound runs, so the platform
   * reads them back and forwards them under its own signature.
   */
  function streamedApp(overrides: {
    statBytes?: number
    fallback?: boolean
    captured?: Array<Record<string, unknown>>
    storeBuffer?: ReturnType<typeof vi.fn>
    readBlob?: ReturnType<typeof vi.fn>
  } = {}) {
    const captured = overrides.captured ?? []
    const readBlob = overrides.readBlob
      ?? vi.fn(async () => ({ bytes: Buffer.from('mp4 bytes'), mime: 'video/mp4', metadata: {} }))
    const storeBuffer = overrides.storeBuffer ?? vi.fn(async () => ({
      assetId: '4a1e6bd8-0000-4000-8000-000000000001',
      sha256: 'a'.repeat(64),
      filename: 'clip.mp4',
      mime: 'video/mp4',
      sizeBytes: 9,
    }))
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
      filesResolver: {
        forWorkspace: vi.fn(async () => ({
          gcs: {
            statBlob: vi.fn(async () => ({
              sizeBytes: overrides.statBytes ?? 9,
              mime: 'video/mp4',
              updatedAt: null,
            })),
            readBlob,
          },
          bucket: '/data/files',
          uriScheme: 'file' as const,
        })),
      } as never,
      archiveMedia: { storeBuffer } as never,
      archiveIncoming: vi.fn(async () => {}),
      getChannel: vi.fn(async () => ({ workspaceId: 'workspace-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
      passUnknownToFallback: overrides.fallback ?? false,
    }))
    app.post('/internal/whatsapp/inbound', (_req, res) => res.status(418).json({ official: true }))
    return { app, captured, storeBuffer, readBlob }
  }

  const streamedBody = {
    ...payload,
    text: '<media:video>',
    mediaMimeType: 'video/mp4',
    mediaRef: {
      gcsKey: 'workspace-1/channel-media/abc',
      mimeType: 'video/mp4',
      sizeBytes: 9,
    },
  }

  it('records an attachment the connector already uploaded to the archive', async () => {
    // On-premise the connector uploads straight to the store under a signature
    // this process minted, so the bytes are stored before /inbound is called.
    // Re-fetching or re-uploading them would be pure waste.
    const { app, captured, storeBuffer, readBlob } = streamedApp()

    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send({
        ...payload,
        text: '<media:video>',
        mediaMimeType: 'video/mp4',
        mediaRef: {
          archiveAssetId: '4a1e6bd8-0000-4000-8000-000000000009',
          sha256: 'b'.repeat(64),
          mimeType: 'video/mp4',
          sizeBytes: 9,
        },
      })

    expect(response.status).toBe(200)
    expect(readBlob).not.toHaveBeenCalled()
    expect(storeBuffer).not.toHaveBeenCalled()
    expect(captured[0]!.archiveMediaRef).toMatchObject({
      assetId: '4a1e6bd8-0000-4000-8000-000000000009',
      sha256: 'b'.repeat(64),
    })
    expect(captured[0]).toMatchObject({ archiveMediaType: 'video' })
  })

  it('mints a signed archive upload target once the digest is known', async () => {
    const uploadTarget = vi.fn(() => ({
      url: 'http://store.test/media?sha256=' + 'c'.repeat(64),
      headers: { 'X-UB-Signature': 'sha256=abc' },
    }))
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: {
        getByChannelForWebhook: vi.fn(async () => ({ connectorInstanceId: 'instance-1' })),
      } as never,
      ingestor: {} as never,
      bot: {} as never,
      archiveMedia: { storeBuffer: vi.fn(), uploadTarget } as never,
      filesResolver: { forWorkspace: vi.fn() } as never,
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
    }))

    const response = await request(app)
      .post('/internal/whatsapp/media-upload-url')
      .set('X-Connector-Secret', 'secret')
      .send({
        channelId: 'byon-channel',
        providerMessageId: 'm1',
        kind: 'video',
        mime: 'video/mp4',
        sha256: 'c'.repeat(64),
      })

    expect(response.status).toBe(200)
    expect(response.body.target).toBe('archive')
    expect(response.body.headers['X-UB-Signature']).toBe('sha256=abc')
    // No workspace object is minted at all on this path.
    expect(response.body.gcsKey).toBeUndefined()
    // The signature commits to the owner and the digest, which is what makes it
    // safe to hand to a process that must not hold the archive's secret.
    expect(uploadTarget).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'owner-1', sha256: 'c'.repeat(64), kind: 'video' }),
    )
    // The connector's upload is what creates the asset row, so the name has to
    // be decided here. Baileys sends none for video; leaving it blank would
    // strip the extension the extractor falls back on when a MIME is generic.
    expect(uploadTarget).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'video-m1.mp4' }),
    )
  })

  it('names the archive before a digest exists, without issuing a URL yet', async () => {
    // The connector's first call asks only where the bytes belong; it cannot
    // know the digest until it has read the attachment. Answering with a
    // workspace URL here would silently send it down the read-back path and
    // keep the duplicate copy — which is exactly what happened in testing.
    const uploadTarget = vi.fn()
    const signedWriteUrl = vi.fn()
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: {
        getByChannelForWebhook: vi.fn(async () => ({ connectorInstanceId: 'instance-1' })),
      } as never,
      ingestor: {} as never,
      bot: {} as never,
      archiveMedia: { storeBuffer: vi.fn(), uploadTarget } as never,
      filesResolver: {
        forWorkspace: vi.fn(async () => ({
          gcs: { signedWriteUrl }, bucket: '/data/files', uriScheme: 'file' as const,
        })),
      } as never,
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
    }))

    const response = await request(app)
      .post('/internal/whatsapp/media-upload-url')
      .set('X-Connector-Secret', 'secret')
      .send({ channelId: 'byon-channel', providerMessageId: 'm1', kind: 'video', mime: 'video/mp4' })

    expect(response.status).toBe(200)
    expect(response.body.target).toBe('archive')
    expect(response.body.uploadUrl).toBeUndefined()
    expect(uploadTarget).not.toHaveBeenCalled()
    // No workspace object is minted, so nothing is left behind if the connector
    // never comes back with a digest.
    expect(signedWriteUrl).not.toHaveBeenCalled()
  })

  it('falls back to workspace storage when the archive owner cannot be resolved', async () => {
    // Without an owner there is nothing to scope a signature to, so the older
    // upload-then-read-back path must still carry the attachment.
    const signedWriteUrl = vi.fn(async () => 'http://localhost:4000/api/local-files?signed=1')
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: {
        getByChannelForWebhook: vi.fn(async () => ({ connectorInstanceId: 'instance-1' })),
      } as never,
      ingestor: {} as never,
      bot: {} as never,
      archiveMedia: { storeBuffer: vi.fn(), uploadTarget: vi.fn() } as never,
      filesResolver: {
        forWorkspace: vi.fn(async () => ({
          gcs: { signedWriteUrl }, bucket: '/data/files', uriScheme: 'file' as const,
        })),
      } as never,
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => null),
    }))

    const response = await request(app)
      .post('/internal/whatsapp/media-upload-url')
      .set('X-Connector-Secret', 'secret')
      .send({ channelId: 'byon-channel', providerMessageId: 'm1', mime: 'video/mp4' })

    expect(response.status).toBe(200)
    expect(response.body.target).toBe('workspace')
    expect(response.body.gcsKey).toMatch(/^ws-1\/channel-media\//)
  })

  it('archives a streamed attachment by reading the uploaded bytes back', async () => {
    const { app, captured, storeBuffer } = streamedApp()

    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send(streamedBody)

    expect(response.status).toBe(200)
    expect(storeBuffer).toHaveBeenCalledOnce()
    expect(captured[0]).toMatchObject({ archiveMediaType: 'video', archiveInboundPersisted: true })
    expect(captured[0]!.archiveMediaRef).toMatchObject({ sha256: 'a'.repeat(64) })
    // Baileys reports no filename for video, so one is synthesized rather than
    // archiving the attachment under '' — which would leave it with no
    // segment 0 and unfindable until extraction produced frame text.
    expect(storeBuffer.mock.calls[0]![0].filename).toBe('video-m1.mp4')
  })

  it('still hands a streamed reference to the hosted intake after archiving', async () => {
    // Archiving must not consume the reference: the closed router still owns
    // turning it into a recording episode.
    const { app, storeBuffer } = streamedApp({ fallback: true })

    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send(streamedBody)

    expect(storeBuffer).toHaveBeenCalledOnce()
    expect(response.status).toBe(418)
    expect(response.body).toEqual({ official: true })
  })

  it('skips an oversized streamed attachment rather than buffering it', async () => {
    // storeBuffer takes a Buffer, so the size is checked with statBlob first —
    // reading before looking would let one attachment set the memory ceiling.
    const { app, captured, storeBuffer, readBlob } = streamedApp({ statBytes: 5 * 1024 * 1024 * 1024 })

    const response = await request(app)
      .post('/internal/whatsapp/inbound')
      .set('X-Connector-Secret', 'secret')
      .send(streamedBody)

    expect(response.status).toBe(200)
    expect(readBlob).not.toHaveBeenCalled()
    expect(storeBuffer).not.toHaveBeenCalled()
    // The message itself is still archived and dispatched; only its attachment
    // is unavailable.
    expect(captured[0]).toMatchObject({ archiveMediaAvailability: 'failed' })
  })
})

describe('[COMP:api/whatsapp-contact-directory] contact directory relay', () => {
  function contactsApp(over: {
    archiveContacts?: ReturnType<typeof vi.fn>
    connectorInstanceId?: string | null
  } = {}) {
    const archiveContacts = over.archiveContacts
    const app = express()
    app.use(express.json())
    app.use('/internal/whatsapp', whatsappByonRoutes({
      connectorSecret: 'secret',
      integrationStore: {
        getByChannelForWebhook: vi.fn(async () => ({ connectorInstanceId: over.connectorInstanceId ?? 'inst-1' })),
      } as never,
      ingestor: {} as never,
      bot: {} as never,
      getChannel: vi.fn(async () => ({ workspaceId: 'ws-1' })) as never,
      getWorkspaceOwnerUserId: vi.fn(async () => 'owner-1'),
      archiveContacts: archiveContacts as never,
    }))
    return app
  }

  it('rejects a bad secret and a bad payload', async () => {
    const app = contactsApp({ archiveContacts: vi.fn() })
    expect((await request(app).post('/internal/whatsapp/contacts').set('X-Connector-Secret', 'wrong')
      .send({ channelId: 'c', contacts: [{ contactId: 'x' }] })).status).toBe(401)
    expect((await request(app).post('/internal/whatsapp/contacts').set('X-Connector-Secret', 'secret')
      .send({ channelId: 'c', contacts: [] })).status).toBe(400)
  })

  it('202-skips when no archive is deployed, instead of erroring the connector', async () => {
    const app = contactsApp({ archiveContacts: undefined })
    const res = await request(app).post('/internal/whatsapp/contacts').set('X-Connector-Secret', 'secret')
      .send({ channelId: 'byon-channel', contacts: [{ contactId: '852@s.whatsapp.net', savedName: 'Ken' }] })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ ok: true, skipped: true })
  })

  it('upserts named contacts under the channel workspace/owner/instance and drops nameless ones', async () => {
    const archiveContacts = vi.fn(async () => ({ upserted: 2 }))
    const app = contactsApp({ archiveContacts })
    const res = await request(app).post('/internal/whatsapp/contacts').set('X-Connector-Secret', 'secret')
      .send({
        channelId: 'byon-channel',
        contacts: [
          { contactId: '85266986281@s.whatsapp.net', savedName: 'Jack Chan', pushName: 'jackie' },
          { contactId: '15551234567@s.whatsapp.net', pushName: 'Sam' },
          { contactId: 'nameless@s.whatsapp.net' },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, upserted: 2 })
    expect(archiveContacts).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      instanceId: 'inst-1',
      ownerUserId: 'owner-1',
      source: 'whatsapp',
      contacts: [
        { contactId: '85266986281@s.whatsapp.net', savedName: 'Jack Chan', pushName: 'jackie' },
        { contactId: '15551234567@s.whatsapp.net', pushName: 'Sam' },
      ],
    })
  })

  it('reports an archive failure as 502, never a silent success', async () => {
    const archiveContacts = vi.fn(async () => { throw new Error('store down') })
    const app = contactsApp({ archiveContacts })
    const res = await request(app).post('/internal/whatsapp/contacts').set('X-Connector-Secret', 'secret')
      .send({ channelId: 'byon-channel', contacts: [{ contactId: 'x@s.whatsapp.net', savedName: 'X' }] })
    expect(res.status).toBe(502)
  })
})
