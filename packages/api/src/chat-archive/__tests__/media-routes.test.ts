import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { INGEST_APPEND_SIGNATURE_HEADER } from '@use-brian/shared'
import { signIngestAppendBody } from '../../ingest/append-signing.js'
import { chatArchiveMediaRoutes } from '../media-routes.js'

const secret = 'local-media-secret'
const assetId = '4a1e6bd8-0000-4000-8000-000000000001'
const initBody = {
  workspace_id: '4a1e6bd8-0000-4000-8000-000000000002',
  instance_id: '4a1e6bd8-0000-4000-8000-000000000003',
  owner_user_id: '4a1e6bd8-0000-4000-8000-000000000004',
  source: 'wechat',
  provider_message_id: 'wx-1',
  kind: 'image',
  filename: 'photo.jpg',
  mime: 'image/jpeg',
  size_bytes: 5,
  sha256: 'a'.repeat(64),
}

function makeApp() {
  const asset = {
    id: assetId,
    workspaceId: initBody.workspace_id,
    instanceId: initBody.instance_id,
    ownerUserId: initBody.owner_user_id,
    messageId: null,
    source: 'wechat',
    providerMessageId: 'wx-1',
    kind: 'image',
    filename: 'photo.jpg',
    mime: 'image/jpeg',
    sizeBytes: 5,
    expectedSha256: 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    storageKey: 'workspace/chat-archive-asset',
    storageUri: 'file://workspace/chat-archive-asset',
    uploadStatus: 'stored',
    extractionStatus: 'pending',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const service = {
    init: vi.fn(async () => ({ asset, alreadyStored: false })),
    upload: vi.fn(async () => asset),
    complete: vi.fn(async () => asset),
    storeBuffer: vi.fn(),
  }
  const app = express()
  app.use(express.json({ verify(req, _res, buffer) {
    ;(req as express.Request & { rawBody?: string }).rawBody = buffer.toString('utf8')
  } }))
  app.use('/internal/chat-archive', chatArchiveMediaRoutes({
    service: service as never,
    hmacSecret: secret,
    baseUrl: 'http://127.0.0.1:4000',
    uploadTtlSec: 60,
  }))
  return { app, service }
}

describe('[COMP:api/chat-archive-media] HMAC staging routes', () => {
  it('rejects an unsigned init and accepts the exact signed body', async () => {
    const { app, service } = makeApp()
    await request(app).post('/internal/chat-archive/media/init').send(initBody).expect(401)

    const raw = JSON.stringify(initBody)
    const response = await request(app)
      .post('/internal/chat-archive/media/init')
      .set('content-type', 'application/json')
      .set(INGEST_APPEND_SIGNATURE_HEADER, signIngestAppendBody(raw, secret))
      .send(raw)
      .expect(200)
    expect(response.body.asset_id).toBe(assetId)
    expect(response.body.upload_url).toMatch(/^http:\/\/127\.0\.0\.1:4000\/internal\/chat-archive\/media\//)
    expect(service.init).toHaveBeenCalledOnce()
  })

  it('returns the v2 media reference only after signed completion', async () => {
    const { app } = makeApp()
    const raw = '{}'
    const response = await request(app)
      .post(`/internal/chat-archive/media/${assetId}/complete`)
      .set('content-type', 'application/json')
      .set(INGEST_APPEND_SIGNATURE_HEADER, signIngestAppendBody(raw, secret))
      .send(raw)
      .expect(200)
    expect(response.body.media_ref).toMatchObject({
      asset_id: assetId,
      availability: 'stored',
      sha256: 'a'.repeat(64),
    })
  })

  it('accepts only the signed, unexpired upload URL issued by init', async () => {
    const { app, service } = makeApp()
    const raw = JSON.stringify(initBody)
    const initialized = await request(app)
      .post('/internal/chat-archive/media/init')
      .set('content-type', 'application/json')
      .set(INGEST_APPEND_SIGNATURE_HEADER, signIngestAppendBody(raw, secret))
      .send(raw)
      .expect(200)
    const upload = new URL(initialized.body.upload_url)

    await request(app)
      .put(upload.pathname)
      .query({ expires: upload.searchParams.get('expires'), token: 'modified' })
      .set('content-type', 'image/jpeg')
      .send(Buffer.from('photo'))
      .expect(401)

    await request(app)
      .put(upload.pathname + upload.search)
      .set('content-type', 'image/jpeg')
      .send(Buffer.from('photo'))
      .expect(200)
    expect(service.upload).toHaveBeenCalledOnce()
  })
})
