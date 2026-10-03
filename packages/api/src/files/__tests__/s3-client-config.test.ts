import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createS3FilesClient } from '../s3-client.js'

const { construct, send } = vi.hoisted(() => ({ construct: vi.fn(), send: vi.fn().mockResolvedValue({}) }))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = send; constructor(options: unknown) { construct(options) } },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class {}, HeadObjectCommand: class {}, DeleteObjectCommand: class {},
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }))
beforeEach(() => vi.clearAllMocks())

describe('S3 SDK authentication and endpoint configuration', () => {
  it('omits credentials for the deployment AWS default chain', async () => {
    const client = createS3FilesClient({ bucket: 'brian-files' })
    await client.writeBlob('key', Buffer.from('test'), { workspaceId: 'test', mime: 'text/plain' })
    expect(construct).toHaveBeenCalledWith({ region: 'us-east-1', forcePathStyle: false })
  })
  it('passes explicit temporary credentials, region and endpoint without ambient fallback', async () => {
    const credentials = { accessKeyId: 'synthetic-id', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-token' }
    const client = createS3FilesClient({ bucket: 'brian-files', region: 'auto', endpoint: 'https://storage.example.com', credentials })
    await client.writeBlob('key', Buffer.from('test'), { workspaceId: 'test', mime: 'text/plain' })
    expect(construct).toHaveBeenCalledWith({ region: 'auto', endpoint: 'https://storage.example.com', forcePathStyle: true, credentials })
    await client.writeBlob('another', Buffer.from('test'), { workspaceId: 'test', mime: 'text/plain' })
    expect(construct).toHaveBeenCalledTimes(1)
  })
  it('honors an explicit virtual-hosted addressing override', async () => {
    await createS3FilesClient({ bucket: 'brian-files', endpoint: 'https://storage.example.com', forcePathStyle: false })
      .writeBlob('key', Buffer.from('test'), { workspaceId: 'test', mime: 'text/plain' })
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ forcePathStyle: false }))
  })
})
