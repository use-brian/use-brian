import express from 'express'
import request from 'supertest'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalFilesClient, type LocalFilesClient } from '../../files/local-files-client.js'
import { localFilesTransferRoutes } from '../local-files-transfer.js'

const SECRET = 'local-transfer-test-secret'
let baseDir: string

beforeAll(async () => {
  baseDir = await fs.mkdtemp(join(tmpdir(), 'local-transfer-test-'))
})

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true })
})

function setup() {
  const client = createLocalFilesClient({
    baseDir,
    apiUrl: 'http://localhost',
    signingSecret: SECRET,
  })
  const app = express()
  app.use('/api/local-files', localFilesTransferRoutes({ client, signingSecret: SECRET }))
  return { app, client }
}

function pathOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

describe('[COMP:files/local-transfer] Signed local file transfers', () => {
  it('allows the browser Content-Range header through the API CORS preflight', () => {
    const bootSource = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
    expect(bootSource).toContain(
      "Access-Control-Allow-Headers', 'Content-Type, Content-Range, Authorization, X-Client-Timezone'",
    )
  })

  it('streams a signed PUT to disk and serves the signed read back', async () => {
    const { app, client } = setup()
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255])
    const writeUrl = await client.signedWriteUrl('ws-upload/recordings/clip', {
      contentType: 'audio/mp4',
    })

    await request(app)
      .put(pathOf(writeUrl))
      .set('Content-Type', 'audio/mp4')
      .send(bytes)
      .expect(204)

    const readUrl = await client.signedReadUrl('ws-upload/recordings/clip')
    const response = await request(app).get(pathOf(readUrl)).expect(200)
    expect(response.headers['content-type']).toMatch(/^audio\/mp4/)
    expect(Buffer.from(response.body).equals(bytes)).toBe(true)
  })

  it('assembles sequential Content-Range PUTs for proxy-bounded recording uploads', async () => {
    const { app, client } = setup()
    const writeUrl = await client.signedWriteUrl('ws-ranged/recordings/meeting', {
      contentType: 'audio/x-m4a',
    })
    const path = pathOf(writeUrl)

    await request(app)
      .put(path)
      .set('Content-Type', 'audio/x-m4a')
      .set('Content-Range', 'bytes 0-3/10')
      .send(Buffer.from('0123'))
      .expect('Upload-Offset', '4')
      .expect(204)
    await request(app)
      .put(path)
      .set('Content-Type', 'audio/x-m4a')
      .set('Content-Range', 'bytes 4-9/10')
      .send(Buffer.from('456789'))
      .expect('Upload-Offset', '10')
      .expect(204)

    const stored = await client.readBlob('ws-ranged/recordings/meeting')
    expect(stored?.bytes.toString()).toBe('0123456789')
    expect(stored?.mime).toBe('audio/x-m4a')
  })

  it('refuses a ranged PUT that skips past the durable offset', async () => {
    const { app, client } = setup()
    const writeUrl = await client.signedWriteUrl('ws-ranged/recordings/gap', {
      contentType: 'audio/mp4',
    })
    await request(app)
      .put(pathOf(writeUrl))
      .set('Content-Type', 'audio/mp4')
      .set('Content-Range', 'bytes 4-7/8')
      .send(Buffer.from('4567'))
      .expect(409)
    expect(await client.readBlob('ws-ranged/recordings/gap')).toBeNull()
  })

  it('acknowledges an exact replay when the prior range was already durable', async () => {
    const { app, client } = setup()
    const writeUrl = await client.signedWriteUrl('ws-ranged/recordings/replay', {
      contentType: 'audio/mp4',
    })
    const path = pathOf(writeUrl)

    await request(app)
      .put(path)
      .set('Content-Type', 'audio/mp4')
      .set('Content-Range', 'bytes 0-3/8')
      .send(Buffer.from('0123'))
      .expect(204)
    await request(app)
      .put(path)
      .set('Content-Type', 'audio/mp4')
      .set('Content-Range', 'bytes 4-7/8')
      .send(Buffer.from('4567'))
      .expect(204)
    await request(app)
      .put(path)
      .set('Content-Type', 'audio/mp4')
      .set('Content-Range', 'bytes 4-7/8')
      .send(Buffer.from('4567'))
      .expect('Upload-Offset', '8')
      .expect(204)

    const stored = await client.readBlob('ws-ranged/recordings/replay')
    expect(stored?.bytes.toString()).toBe('01234567')
  })

  it('finishes rollback before admitting an overlapping retry for the same key', async () => {
    const realClient = createLocalFilesClient({
      baseDir,
      apiUrl: 'http://localhost',
      signingSecret: SECRET,
    })
    const key = 'ws-ranged/recordings/overlap'
    await realClient.writeBlob(key, Buffer.from('0123'), {
      workspaceId: 'ws-ranged',
      mime: 'audio/mp4',
    })

    let failNextWrite = true
    let signalRollbackStarted!: () => void
    const rollbackStarted = new Promise<void>((resolve) => {
      signalRollbackStarted = resolve
    })
    const originalWriteRange = realClient.writeRangeStream.bind(realClient)
    const originalTruncate = realClient.truncateBlob.bind(realClient)
    const client: LocalFilesClient = {
      ...realClient,
      writeRangeStream(rangeKey, start, opts) {
        if (!failNextWrite) return originalWriteRange(rangeKey, start, opts)
        failNextWrite = false
        return new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('forced overlapping upload failure'))
          },
        })
      },
      async truncateBlob(rangeKey, sizeBytes) {
        signalRollbackStarted()
        await new Promise((resolve) => setTimeout(resolve, 50))
        await originalTruncate(rangeKey, sizeBytes)
      },
    }
    const app = express()
    app.use('/api/local-files', localFilesTransferRoutes({ client, signingSecret: SECRET }))
    const writeUrl = await client.signedWriteUrl(key, { contentType: 'audio/mp4' })
    const path = pathOf(writeUrl)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const failedRequest = request(app)
        .put(path)
        .set('Content-Type', 'audio/mp4')
        .set('Content-Range', 'bytes 4-7/8')
        .send(Buffer.from('xxxx'))
        .expect(500)
        .then(() => undefined)
      await rollbackStarted
      const retryRequest = request(app)
        .put(path)
        .set('Content-Type', 'audio/mp4')
        .set('Content-Range', 'bytes 4-7/8')
        .send(Buffer.from('4567'))
        .expect(204)
        .then(() => undefined)
      await Promise.all([failedRequest, retryRequest])
    } finally {
      consoleError.mockRestore()
    }

    const stored = await client.readBlob(key)
    expect(stored?.bytes.toString()).toBe('01234567')
  })

  it('supports byte ranges for local audio and video seeking', async () => {
    const { app, client } = setup()
    await client.writeBlob('ws-range/video', Buffer.from('0123456789'), {
      workspaceId: 'ws-range',
      mime: 'video/mp4',
    })
    const readUrl = await client.signedReadUrl('ws-range/video')

    const response = await request(app)
      .get(pathOf(readUrl))
      .set('Range', 'bytes=3-6')
      .expect(206)

    expect(response.headers['accept-ranges']).toBe('bytes')
    expect(response.headers['content-range']).toBe('bytes 3-6/10')
    expect(Buffer.from(response.body).toString()).toBe('3456')
  })

  it('rejects a modified key and a mismatched signed content type', async () => {
    const { app, client } = setup()
    const writeUrl = new URL(await client.signedWriteUrl('ws-secure/file', {
      contentType: 'audio/mpeg',
    }))
    writeUrl.searchParams.set('key', 'ws-secure/other-file')
    await request(app).put(`${writeUrl.pathname}${writeUrl.search}`).set('Content-Type', 'audio/mpeg').send('x').expect(403)

    const originalUrl = await client.signedWriteUrl('ws-secure/file', { contentType: 'audio/mpeg' })
    await request(app).put(pathOf(originalUrl)).set('Content-Type', 'video/mp4').send('x').expect(400)
  })

  it('rejects expired signed URLs', async () => {
    const { app, client } = setup()
    const readUrl = await client.signedReadUrl('ws-expired/file', -1)
    await request(app).get(pathOf(readUrl)).expect(403)
  })
})
