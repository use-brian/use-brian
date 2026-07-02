import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import { validateS3ByoBinding, S3_BYO_HEALTHCHECK_KEY } from '../s3-byo-validate.js'
import type { GcsFilesClient } from '../gcs-client.js'

const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }

function fakeClient(overrides: Partial<GcsFilesClient> = {}): GcsFilesClient {
  const blobs = new Map<string, Buffer>()
  return {
    async writeBlob(key, bytes) { blobs.set(key, Buffer.from(bytes)) },
    async appendBlob() {},
    async readBlob(key) {
      const b = blobs.get(key)
      return b ? { bytes: b, mime: 'text/plain', metadata: { workspaceId: '', mime: 'text/plain' } } : null
    },
    async deleteBlob(key) { blobs.delete(key) },
    async signedReadUrl(key) { return `https://x/${key}` },
    async signedWriteUrl(key) { return `https://x/${key}` },
    writeStream() { return new Writable({ write(_c, _e, cb) { cb() } }) },
    ...overrides,
  }
}

describe('[COMP:files/s3-byo-validate] validateS3ByoBinding', () => {
  it('succeeds when write/read/delete round-trips and cleans up the probe', async () => {
    const client = fakeClient()
    const result = await validateS3ByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(true)
    // Probe must not be left behind.
    expect(await client.readBlob(S3_BYO_HEALTHCHECK_KEY)).toBeNull()
  })

  it('classifies AccessDenied as permission_denied', async () => {
    const client = fakeClient({
      async writeBlob() { throw Object.assign(new Error('forbidden'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }) },
    })
    const result = await validateS3ByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('permission_denied')
  })

  it('classifies NoSuchBucket as bucket_unreachable', async () => {
    const client = fakeClient({
      async writeBlob() { throw Object.assign(new Error('no such bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }) },
    })
    const result = await validateS3ByoBinding(
      { credentials: creds, bucket: 'missing' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('bucket_unreachable')
  })

  it('classifies a bad DNS endpoint as bucket_unreachable', async () => {
    const client = fakeClient({
      async writeBlob() { throw Object.assign(new Error('getaddrinfo ENOTFOUND minio.local'), { code: 'ENOTFOUND' }) },
    })
    const result = await validateS3ByoBinding(
      { credentials: creds, bucket: 'cust-bucket', endpoint: 'https://minio.local' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('bucket_unreachable')
  })

  it('classifies a bad signature as invalid_key', async () => {
    const client = fakeClient({
      async writeBlob() { throw Object.assign(new Error('The request signature we calculated does not match'), { name: 'SignatureDoesNotMatch', $metadata: { httpStatusCode: 403 } }) },
    })
    const result = await validateS3ByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_key')
  })

  it('fails when the probe is not readable after write', async () => {
    const client = fakeClient({ async readBlob() { return null } })
    const result = await validateS3ByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
  })
})
