import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalFilesClient } from '../../files/local-files-client.js'
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
