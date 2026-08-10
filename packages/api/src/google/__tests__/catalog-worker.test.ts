import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GDriveCatalogSyncJob } from '../../db/gdrive-catalog-store.js'
import { createGDriveCatalogWorker } from '../catalog-worker.js'

function job(): GDriveCatalogSyncJob {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    connectorInstanceId: 'ci-1',
    actingUserId: 'user-1',
    syncScope: 'selected_folders',
    selectedFolders: [{ id: 'folder-1', name: 'Company' }],
    generation: 'generation-1',
    status: 'processing',
    estimatedFiles: 1,
    filesSeen: 0,
    filesIndexed: 0,
    attempts: 1,
    lastError: null,
  }
}

describe('[COMP:integrations/gdrive-enrichment] Drive catalog worker', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('writes only metadata descriptors and completes the generation', async () => {
    const driveJob = job()
    const claim = vi.fn().mockResolvedValueOnce(driveJob).mockResolvedValueOnce(null)
    const write = vi.fn(async () => ({ ok: true as const, value: { id: 'artifact-1' } }))
    const setArtifact = vi.fn()
    const complete = vi.fn()
    const upsertEntry = vi.fn().mockResolvedValue(null)
    const worker = createGDriveCatalogWorker({
      filesApi: { write, read: vi.fn(), delete: vi.fn() } as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim,
      scan: vi.fn(async () => ({
        fileCount: 1,
        totalItems: 2,
        entries: [
          {
            externalFileId: 'folder-1', name: 'Company', mimeType: 'application/vnd.google-apps.folder',
            sourceVersion: 'metadata-folder', modifiedTime: null, sizeBytes: null, webViewLink: null,
            parentIds: [], folderPath: [], isFolder: true,
          },
          {
            externalFileId: 'file-1', name: 'Renewal playbook', mimeType: 'application/vnd.google-apps.document',
            sourceVersion: '7', modifiedTime: '2026-08-10T00:00:00.000Z', sizeBytes: null,
            webViewLink: 'https://drive.google.com/file/file-1', parentIds: ['folder-1'],
            folderPath: ['Company'], isFolder: false,
          },
        ],
      })),
      isCurrent: vi.fn(async () => true),
      upsertEntry,
      setArtifact,
      updateProgress: vi.fn(),
      listStaleArtifacts: vi.fn(async () => []),
      complete,
      markFailed: vi.fn(),
    })

    await worker.tick()

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', userId: 'user-1' },
      expect.objectContaining({
        content: expect.stringContaining('File content has not been downloaded'),
        tags: ['google-drive', 'drive-catalog'],
        sensitivity: 'confidential',
      }),
    )
    expect(setArtifact).toHaveBeenCalledWith(expect.objectContaining({ artifactFileId: 'artifact-1' }))
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ filesSeen: 2, filesIndexed: 1 }))
  })

  it('removes a replaced descriptor before writing its new metadata', async () => {
    const remove = vi.fn(async () => ({ ok: true as const, value: { id: 'old-artifact', path: '/old' } }))
    const write = vi.fn(async () => ({ ok: true as const, value: { id: 'new-artifact' } }))
    const setArtifact = vi.fn()
    const worker = createGDriveCatalogWorker({
      filesApi: { write, read: vi.fn(), delete: remove } as never,
      connectorInstanceStore: { getCredentialsSystem: vi.fn() } as never,
      claim: vi.fn().mockResolvedValueOnce(job()).mockResolvedValueOnce(null),
      scan: vi.fn(async () => ({
        fileCount: 1,
        totalItems: 1,
        entries: [{
          externalFileId: 'file-1', name: 'Renamed playbook', mimeType: 'text/plain',
          sourceVersion: '8', modifiedTime: null, sizeBytes: 10, webViewLink: null,
          parentIds: ['folder-1'], folderPath: ['Company'], isFolder: false,
        }],
      })),
      isCurrent: vi.fn(async () => true),
      upsertEntry: vi.fn(async () => ({
        externalFileId: 'file-1', name: 'Old playbook', mimeType: 'text/plain',
        sourceVersion: '7', modifiedTime: null, sizeBytes: 10, webViewLink: null,
        parentIds: ['folder-1'], folderPath: ['Company'], isFolder: false,
        artifactFileId: 'old-artifact', lastSeenGeneration: 'old-generation',
      })),
      setArtifact,
      updateProgress: vi.fn(),
      listStaleArtifacts: vi.fn(async () => []),
      complete: vi.fn(),
      markFailed: vi.fn(),
    })

    await worker.tick()

    expect(remove).toHaveBeenCalledWith(expect.anything(), 'old-artifact')
    expect(setArtifact).toHaveBeenNthCalledWith(1, expect.objectContaining({ artifactFileId: null }))
    expect(setArtifact).toHaveBeenLastCalledWith(expect.objectContaining({ artifactFileId: 'new-artifact' }))
  })
})
