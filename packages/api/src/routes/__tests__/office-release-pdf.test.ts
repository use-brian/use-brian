import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { completePresentationSnapshot, resolveFixtureResource } from '../../../../core/src/office/__tests__/fixtures.js'
import { officeReleaseRoutes, type OfficeReleaseRouteDeps } from '../office-releases.js'

const USER = '20000000-0000-4000-8000-000000000001'
const ARTIFACT = '20000000-0000-4000-8000-000000000002'
const WORKSPACE = '20000000-0000-4000-8000-000000000003'
const VERSION = '20000000-0000-4000-8000-000000000004'

function releaseServer(overrides: Partial<OfficeReleaseRouteDeps> = {}) {
  const snapshot = completePresentationSnapshot()
  const deps: OfficeReleaseRouteDeps = {
    load: vi.fn(async () => ({
      artifact: { id: ARTIFACT, workspaceId: WORKSPACE, headVersion: 3, headVersionId: VERSION, lifecycleState: 'active', sensitivity: 'internal' },
      access: { canEdit: true },
      snapshot,
      claims: [],
      media: [],
    } as never)),
    resolveResource: vi.fn(() => resolveFixtureResource),
    revalidate: vi.fn(async () => ({ scope: { sensitivity: 'internal' as const, compartments: ['team:product'], projectIds: [] }, validForMs: 30_000 })),
    saveReleasedFile: vi.fn(async () => 'file-1'),
    createRecord: vi.fn(async () => ({ id: 'release-1' })),
    createDerivative: vi.fn(),
    presentationPdfPort: { convert: vi.fn(async () => new Uint8Array([37, 80, 68, 70])), pageCount: vi.fn(async () => snapshot.slides.length) },
    ...overrides,
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = USER; next() })
  app.use('/api/office', officeReleaseRoutes(deps))
  return { app, deps, snapshot }
}

const input = { expectedVersion: 3, action: 'export', destination: { sensitivity: 'internal', external: false } }

describe('[COMP:api/office-release] Presentation PDF route', () => {
  it('preflights Presentation PDF without a spreadsheet print request', async () => {
    const test = releaseServer()
    const response = await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/releases/preflight`).send({ ...input, format: 'pdf' }).expect(200)
    expect(response.body.receipt).toMatchObject({ status: 'ready', blocks: [] })
    expect(response.headers['x-brian-media-valid-for-ms']).toBe('30000')
  })

  it('persists canonical PDF bytes with the owned MIME and extension', async () => {
    const test = releaseServer()
    const response = await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/releases`).send({ ...input, format: 'pdf' }).expect(201)

    expect(response.body).toMatchObject({ releaseId: 'release-1', fileId: 'file-1', receipt: { status: 'ready', presentationPdf: { expectedPageCount: 2, actualPageCount: 2 } } })
    expect(response.headers['x-brian-media-valid-for-ms']).toBe('30000')
    expect(test.deps.saveReleasedFile).toHaveBeenCalledWith(expect.objectContaining({ extension: 'pdf', mime: 'application/pdf', bytes: expect.any(Uint8Array), scope: { sensitivity: 'internal', compartments: ['team:product'], projectIds: [] } }))
    expect(test.deps.createRecord).toHaveBeenCalledOnce()
  })

  it('returns the typed blocking receipt and persists nothing on page mismatch', async () => {
    const saveReleasedFile = vi.fn()
    const test = releaseServer({ saveReleasedFile, presentationPdfPort: { convert: vi.fn(async () => new Uint8Array([37, 80, 68, 70])), pageCount: vi.fn(async () => 1) } })
    const response = await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/releases`).send({ ...input, format: 'pdf' }).expect(409)

    expect(response.body.receipt).toMatchObject({ status: 'blocked', blocks: [{ code: 'presentation.page_count_mismatch' }] })
    expect(saveReleasedFile).not.toHaveBeenCalled()
  })

  it('keeps native Presentation release on PPTX without invoking PDF conversion', async () => {
    const convert = vi.fn()
    const test = releaseServer({ presentationPdfPort: { convert, pageCount: vi.fn() } })
    await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/releases`).send({ ...input, format: 'native' }).expect(201)

    expect(convert).not.toHaveBeenCalled()
    expect(test.deps.saveReleasedFile).toHaveBeenCalledWith(expect.objectContaining({ extension: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }))
  })

  it('publishes nothing when authority changes after conversion', async () => {
    const saveReleasedFile = vi.fn()
    const test = releaseServer({ revalidate: vi.fn(async () => null), saveReleasedFile })
    await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/releases`).send({ ...input, format: 'native' }).expect(409, { error: 'office_projection_changed' })
    expect(saveReleasedFile).not.toHaveBeenCalled()
    expect(test.deps.createRecord).not.toHaveBeenCalled()
  })

  it('does not create a release record when authority changes while the classified file is written', async () => {
    const revalidate = vi.fn()
      .mockResolvedValueOnce({ scope: { sensitivity: 'internal', compartments: [], projectIds: [] }, validForMs: 30_000 })
      .mockResolvedValueOnce(null)
    const test = releaseServer({ revalidate })
    await request(test.app).post(`/api/office/artifacts/${ARTIFACT}/releases`).send({ ...input, format: 'native' }).expect(409, { error: 'office_projection_changed' })
    expect(test.deps.saveReleasedFile).toHaveBeenCalledOnce()
    expect(test.deps.createRecord).not.toHaveBeenCalled()
  })
})
