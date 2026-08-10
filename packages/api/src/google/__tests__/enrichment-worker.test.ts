import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GDriveEnrichmentJob } from '../../db/gdrive-enrichment-store.js'
import { createGDriveEnrichmentWorker } from '../enrichment-worker.js'

const getGDriveCatalogReadPolicy = vi.fn<(input: unknown) => Promise<{ allowed: boolean }>>(async () => ({ allowed: true }))
vi.mock('../../db/gdrive-catalog-store.js', () => ({
  getGDriveCatalogReadPolicy: (input: unknown) => getGDriveCatalogReadPolicy(input),
}))

function job(overrides: Partial<GDriveEnrichmentJob> = {}): GDriveEnrichmentJob {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    connectorInstanceId: 'ci-1',
    actingUserId: 'user-1',
    assistantId: 'assistant-1',
    externalFileId: 'drive-1',
    sourceVersion: '128',
    fileName: 'Renewal playbook',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: new Date('2026-08-10T08:30:00.000Z'),
    webViewLink: 'https://drive.google.com/file/drive-1',
    mode: 'lazy_fetch',
    status: 'processing',
    prefilledPayload: null,
    artifactFileId: null,
    sourceEpisodeId: null,
    attempts: 1,
    lastError: null,
    ...overrides,
  }
}

function filesApi() {
  return {
    write: vi.fn(async () => ({
      ok: true as const,
      value: { id: 'artifact-1' },
    })),
    read: vi.fn(),
  }
}

describe('[COMP:integrations/gdrive-enrichment] Drive enrichment worker', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getGDriveCatalogReadPolicy.mockReset()
    getGDriveCatalogReadPolicy.mockResolvedValue({ allowed: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('deep-enriches one native Drive version and records its provenance', async () => {
    const driveJob = job()
    const claim = vi.fn()
      .mockResolvedValueOnce(driveJob)
      .mockResolvedValueOnce(null)
    const api = filesApi()
    const index = vi.fn(async () => ({ segmentsInserted: 1, segmentCount: 1, truncated: false }))
    const brainIngest = vi.fn(async () => ({ episodeId: 'episode-1' }) as never)
    const markDone = vi.fn()
    const worker = createGDriveEnrichmentWorker({
      filesApi: api as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim,
      index,
      brainIngest,
      markDone,
      markFailed: vi.fn(),
      fetchDriveContent: vi.fn(async () => ({
        file: {
          id: 'drive-1', name: 'Renewal playbook',
          mimeType: 'application/vnd.google-apps.document', version: '128',
          modifiedTime: '2026-08-10T08:30:00.000Z',
        },
        content: 'Renewals require finance approval.',
      })),
    })

    await worker.tick()

    expect(index).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'artifact-1' }))
    expect(brainIngest).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'gdrive_file',
      sourceRef: expect.objectContaining({ drive_file_id: 'drive-1', source_version: '128' }),
    }))
    expect(markDone).toHaveBeenCalledWith({
      id: 'job-1', artifactFileId: 'artifact-1', sourceEpisodeId: 'episode-1',
    })
  })

  it('indexes an offline bundle without calling Pipeline B', async () => {
    const offline = job({
      mode: 'offline_bundle',
      prefilledPayload: {
        fileId: 'drive-1', version: '128', name: 'Renewal playbook',
        mimeType: 'application/vnd.google-apps.document',
        summary: 'Renewal operating procedure.', keywords: ['renewal'],
      },
    })
    const claim = vi.fn().mockResolvedValueOnce(offline).mockResolvedValueOnce(null)
    const api = filesApi()
    const brainIngest = vi.fn()
    const markDone = vi.fn()
    const worker = createGDriveEnrichmentWorker({
      filesApi: api as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim,
      index: vi.fn(async () => ({ segmentsInserted: 1, segmentCount: 1, truncated: false })),
      brainIngest,
      markDone,
      markFailed: vi.fn(),
    })

    await worker.tick()

    expect(api.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: expect.stringContaining('Renewal operating procedure.') }),
    )
    expect(brainIngest).not.toHaveBeenCalled()
    expect(markDone).toHaveBeenCalledWith({ id: 'job-1', artifactFileId: 'artifact-1' })
  })

  it('supersedes a stale queued revision and enqueues the current version', async () => {
    const claim = vi.fn().mockResolvedValueOnce(job()).mockResolvedValueOnce(null)
    const enqueueLazy = vi.fn()
    const markSuperseded = vi.fn()
    const api = filesApi()
    const worker = createGDriveEnrichmentWorker({
      filesApi: api as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim,
      enqueueLazy,
      markSuperseded,
      markFailed: vi.fn(),
      markDone: vi.fn(),
      fetchDriveContent: vi.fn(async () => ({
        file: {
          id: 'drive-1', name: 'Renewal playbook',
          mimeType: 'application/vnd.google-apps.document', version: '129',
        },
        content: 'New version.',
      })),
    })

    await worker.tick()

    expect(enqueueLazy).toHaveBeenCalledWith(expect.objectContaining({ sourceVersion: '129' }))
    expect(markSuperseded).toHaveBeenCalledWith('job-1')
    expect(api.write).not.toHaveBeenCalled()
  })

  it('does not download content after a selected-folder scope removes the file', async () => {
    getGDriveCatalogReadPolicy.mockResolvedValue({ allowed: false })
    const claim = vi.fn().mockResolvedValueOnce(job()).mockResolvedValueOnce(null)
    const markSuperseded = vi.fn()
    const fetchDriveContent = vi.fn()
    const worker = createGDriveEnrichmentWorker({
      filesApi: filesApi() as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim,
      markSuperseded,
      markFailed: vi.fn(),
      markDone: vi.fn(),
      fetchDriveContent,
    })

    await worker.tick()

    expect(markSuperseded).toHaveBeenCalledWith('job-1')
    expect(fetchDriveContent).not.toHaveBeenCalled()
  })

  it('does not materialize a queued offline bundle after the scope removes it', async () => {
    getGDriveCatalogReadPolicy.mockResolvedValue({ allowed: false })
    const offline = job({
      mode: 'offline_bundle',
      prefilledPayload: {
        fileId: 'drive-1', version: '128', name: 'Renewal playbook',
        mimeType: 'text/plain', summary: 'Renewal instructions.', keywords: [],
      },
    })
    const api = filesApi()
    const markSuperseded = vi.fn()
    const worker = createGDriveEnrichmentWorker({
      filesApi: api as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim: vi.fn().mockResolvedValueOnce(offline).mockResolvedValueOnce(null),
      markSuperseded,
      markFailed: vi.fn(),
      markDone: vi.fn(),
    })

    await worker.tick()

    expect(markSuperseded).toHaveBeenCalledWith('job-1')
    expect(api.write).not.toHaveBeenCalled()
  })

  it('preserves PDF bytes for the normal media distiller', async () => {
    const pdfJob = job({
      fileName: 'Renewal playbook.pdf',
      mimeType: 'application/pdf',
    })
    const claim = vi.fn().mockResolvedValueOnce(pdfJob).mockResolvedValueOnce(null)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'access-1' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'drive-1',
          name: 'Renewal playbook.pdf',
          mimeType: 'application/pdf',
          version: '128',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
      })
    vi.stubGlobal('fetch', fetchMock)
    const distill = vi.fn(async () => 'Distilled renewal evidence.')
    const api = filesApi()
    const worker = createGDriveEnrichmentWorker({
      filesApi: api as never,
      connectorInstanceStore: {
        getCredentialsSystem: vi.fn(async () => ({
          client_secret: JSON.stringify({
            version: 1,
            refreshToken: 'refresh-1',
            appClientId: 'customer-client',
            appClientSecret: 'customer-secret',
          }),
        })),
      } as never,
      claim,
      distill,
      index: vi.fn(async () => ({ segmentsInserted: 1, segmentCount: 1, truncated: false })),
      markDone: vi.fn(),
      markFailed: vi.fn(),
    })

    await worker.tick()

    expect(distill).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      mime: 'application/pdf',
    })
    expect(api.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: expect.stringContaining('Distilled renewal evidence.') }),
    )
  })
})
