import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { PdfSessionServiceError } from '../../office/pdf-session-service.js'
import { officePdfSessionRoutes } from '../office-pdf-sessions.js'

const USER = '20000000-0000-4000-8000-000000000001'
const WORKSPACE = '20000000-0000-4000-8000-000000000002'
const ARTIFACT = '20000000-0000-4000-8000-000000000003'
const FILE = '20000000-0000-4000-8000-000000000004'

function server(service: Record<string, unknown>) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
  app.use('/api/office', officePdfSessionRoutes({ service: service as never }))
  return app
}

describe('[COMP:api/office-pdf-sessions] PDF session routes', () => {
  it('returns a ready session only after synchronous intake completes', async () => {
    const create = vi.fn(async () => ({ artifactId: ARTIFACT, version: 0, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), editorUrl: `/w/${WORKSPACE}/office/${ARTIFACT}`, targets: [], sourceHash: 'a'.repeat(64) }))
    const response = await request(server({ create })).post('/api/office/pdf-sessions').send({
      workspaceId: WORKSPACE,
      source: { kind: 'workspace_file', id: FILE },
      title: 'Fictional form',
      sensitivity: 'internal',
      idempotencyKey: 'route-key-0001',
    }).expect(201)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.body).toMatchObject({ artifactId: ARTIFACT, version: 0, editorUrl: `/w/${WORKSPACE}/office/${ARTIFACT}` })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, workspaceId: WORKSPACE }))
  })

  it('does not reveal whether an inaccessible source exists', async () => {
    const create = vi.fn(async () => { throw new PdfSessionServiceError('source_unavailable', 'The selected source is unavailable.', 404) })
    const response = await request(server({ create })).post('/api/office/pdf-sessions').send({
      workspaceId: WORKSPACE,
      source: { kind: 'workspace_file', id: FILE },
      title: 'Fictional form',
      idempotencyKey: 'route-key-0002',
    }).expect(404)
    expect(response.body).toEqual({ error: 'source_unavailable', message: 'The selected source is unavailable.' })
  })

  it('serves protected source bytes with no-store and no browser execution context', async () => {
    const readSource = vi.fn(async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), file: {} }))
    const get = vi.fn(async () => ({ session: { expiresAt: new Date(Date.now() + 20_000) } }))
    const response = await request(server({ readSource, get })).get(`/api/office/artifacts/${ARTIFACT}/pdf/source`).expect(200)
    expect(response.headers['content-type']).toMatch(/^application\/pdf/)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(Number(response.headers['x-brian-media-valid-for-ms'])).toBeGreaterThan(0)
    expect(Number(response.headers['x-brian-media-valid-for-ms'])).toBeLessThanOrEqual(20_000)
  })
})
