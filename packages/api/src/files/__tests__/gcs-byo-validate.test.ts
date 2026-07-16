import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import { validateGcsByoBinding, BYO_HEALTHCHECK_KEY } from '../gcs-byo-validate.js'
import type { GcsFilesClient } from '../gcs-client.js'

const creds = { client_email: 'sa@proj.iam.gserviceaccount.com' }

function fakeClient(overrides: Partial<GcsFilesClient> = {}): GcsFilesClient {
  const blobs = new Map<string, Buffer>()
  return {
    async writeBlob(key, bytes) { blobs.set(key, Buffer.from(bytes)) },
    async appendBlob() {},
    async readBlob(key) {
      const b = blobs.get(key)
      return b ? { bytes: b, mime: 'text/plain', metadata: { workspaceId: '', mime: 'text/plain' } } : null
    },
    async statBlob(key) {
      const b = blobs.get(key)
      return b ? { sizeBytes: b.length, mime: 'text/plain', updatedAt: null } : null
    },
    async deleteBlob(key) { blobs.delete(key) },
    async signedReadUrl(key) { return `https://x/${key}` },
    async signedWriteUrl(key) { return `https://x/${key}` },
    writeStream() { return new Writable({ write(_c, _e, cb) { cb() } }) },
    ...overrides,
  }
}

describe('[COMP:files/gcs-byo-validate] validateGcsByoBinding', () => {
  it('succeeds when write/read/delete round-trips and cleans up the probe', async () => {
    const client = fakeClient()
    const result = await validateGcsByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(true)
    // Probe must not be left behind.
    expect(await client.readBlob(BYO_HEALTHCHECK_KEY)).toBeNull()
  })

  it('classifies a 403 as permission_denied', async () => {
    const client = fakeClient({
      async writeBlob() { throw Object.assign(new Error('forbidden'), { code: 403 }) },
    })
    const result = await validateGcsByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('permission_denied')
  })

  it('classifies a 404 as bucket_unreachable', async () => {
    const client = fakeClient({
      async writeBlob() { throw Object.assign(new Error('no such bucket'), { code: 404 }) },
    })
    const result = await validateGcsByoBinding(
      { credentials: creds, bucket: 'missing' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('bucket_unreachable')
  })

  it('classifies a bad signing key as invalid_key', async () => {
    const client = fakeClient({
      async writeBlob() { throw new Error('error:1E08010C:DECODER routines::unsupported') },
    })
    const result = await validateGcsByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_key')
  })

  it('fails when the probe is not readable after write', async () => {
    const client = fakeClient({ async readBlob() { return null } })
    const result = await validateGcsByoBinding(
      { credentials: creds, bucket: 'cust-bucket' },
      { createClient: () => client },
    )
    expect(result.ok).toBe(false)
  })
})
