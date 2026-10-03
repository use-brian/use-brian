import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createS3FilesClient } from '../../files/s3-client.js'
import { createGcsFilesClient } from '../../files/gcs-client.js'
import { createAzureBlobFilesClient } from '../../files/azure-blob-client.js'
import { createLocalFilesClient } from '../../files/local-files-client.js'
import { createLedgerPayloadStore } from '../payload-store.js'
import { getLedgerPayloadStore, initLedgerRuntime, resetLedgerRuntimeForTests } from '../runtime.js'

// Exercise real env parsers and runtime selection, without SDK/network/database IO.
vi.mock('../../files/s3-client.js', () => ({ createS3FilesClient: vi.fn(() => ({ backend: 's3' })) }))
vi.mock('../../files/gcs-client.js', () => ({ createGcsFilesClient: vi.fn(() => ({ backend: 'gcs' })) }))
vi.mock('../../files/azure-blob-client.js', async (original) => ({
  ...await original<typeof import('../../files/azure-blob-client.js')>(),
  createAzureBlobFilesClient: vi.fn(() => ({ backend: 'azure' })),
}))
vi.mock('../../files/local-files-client.js', () => ({
  resolveLocalFilesBaseDir: (dir?: string) => dir || '/tmp/sidanclaw-files',
  createLocalFilesClient: vi.fn(() => ({ backend: 'local' })),
}))
vi.mock('../payload-store.js', () => ({
  createLedgerPayloadStore: vi.fn(() => ({ put: vi.fn(), get: vi.fn(), erase: vi.fn() })),
}))

const envKeys = [
  'GCS_FILES_BUCKET', 'AZURE_BLOB_CONTAINER', 'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_ACCOUNT', 'AZURE_STORAGE_ACCOUNT_KEY', 'AZURE_BLOB_ENDPOINT',
  'S3_FILES_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_FORCE_PATH_STYLE',
  'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN',
  'LOCAL_FILES_DIR', 'LOCAL_FILES_PUBLIC_URL', 'K_SERVICE',
] as const

beforeEach(() => {
  resetLedgerRuntimeForTests()
  vi.clearAllMocks()
  for (const key of envKeys) vi.stubEnv(key, undefined)
})
afterEach(() => {
  resetLedgerRuntimeForTests()
  vi.unstubAllEnvs()
})

describe('deployment-default ledger storage', () => {
  it('selects S3 with default-chain credentials on Cloud Run and caches the store', () => {
    vi.stubEnv('S3_FILES_BUCKET', 'deployment-files')
    vi.stubEnv('K_SERVICE', 'workers')
    const store = getLedgerPayloadStore()
    expect(createS3FilesClient).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'deployment-files' }))
    expect(vi.mocked(createS3FilesClient).mock.calls[0][0].credentials).toBeUndefined()
    expect(createLedgerPayloadStore).toHaveBeenCalledWith({ backend: 's3' })
    expect(getLedgerPayloadStore()).toBe(store)
    expect(createS3FilesClient).toHaveBeenCalledTimes(1)
    expect(createLocalFilesClient).not.toHaveBeenCalled()
  })

  it('forwards S3-compatible endpoint and explicit temporary credentials', () => {
    vi.stubEnv('S3_FILES_BUCKET', 'deployment-files')
    vi.stubEnv('S3_REGION', 'auto')
    vi.stubEnv('S3_ENDPOINT', 'https://storage.example.com')
    vi.stubEnv('S3_FORCE_PATH_STYLE', 'true')
    vi.stubEnv('S3_ACCESS_KEY_ID', 'test-access')
    vi.stubEnv('S3_SECRET_ACCESS_KEY', 'test-secret')
    vi.stubEnv('S3_SESSION_TOKEN', 'test-session')
    getLedgerPayloadStore()
    expect(createS3FilesClient).toHaveBeenCalledWith({
      bucket: 'deployment-files', region: 'auto', endpoint: 'https://storage.example.com', forcePathStyle: true,
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret', sessionToken: 'test-session' },
    })
  })

  it.each([
    ['GCS_FILES_BUCKET', 'AZURE_BLOB_CONTAINER'],
    ['GCS_FILES_BUCKET', 'S3_FILES_BUCKET'],
    ['AZURE_BLOB_CONTAINER', 'S3_FILES_BUCKET'],
    ['GCS_FILES_BUCKET', 'AZURE_BLOB_CONTAINER', 'S3_FILES_BUCKET'],
  ])('rejects conflicting defaults %s / %s before constructing clients', (...keys) => {
    for (const key of keys) vi.stubEnv(key, 'bucket')
    expect(() => getLedgerPayloadStore()).toThrow('mutually exclusive')
    expect(createGcsFilesClient).not.toHaveBeenCalled()
    expect(createAzureBlobFilesClient).not.toHaveBeenCalled()
    expect(createS3FilesClient).not.toHaveBeenCalled()
    expect(createLocalFilesClient).not.toHaveBeenCalled()
  })

  it('preserves the local fallback when no cloud default is selected', () => {
    vi.stubEnv('LOCAL_FILES_DIR', '/srv/files')
    getLedgerPayloadStore()
    expect(createLocalFilesClient).toHaveBeenCalledWith(expect.objectContaining({ baseDir: '/srv/files' }))
    expect(createS3FilesClient).not.toHaveBeenCalled()
  })

  it('keeps Cloud Run without storage explicitly degraded', async () => {
    vi.stubEnv('K_SERVICE', 'workers')
    await expect(getLedgerPayloadStore().put({ content: 'payload' })).rejects.toThrow('no ledger storage backend')
    expect(createLocalFilesClient).not.toHaveBeenCalled()
  })

  it('uses the injected boot client without re-deriving env configuration', () => {
    const files = createS3FilesClient({ bucket: 'injected' })
    vi.stubEnv('GCS_FILES_BUCKET', 'conflicting')
    vi.stubEnv('S3_FILES_BUCKET', 'ignored')
    initLedgerRuntime(files)
    getLedgerPayloadStore()
    expect(createLedgerPayloadStore).toHaveBeenCalledExactlyOnceWith(files)
    expect(createGcsFilesClient).not.toHaveBeenCalled()
  })
})
