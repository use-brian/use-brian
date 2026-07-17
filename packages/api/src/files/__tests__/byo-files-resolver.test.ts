import { describe, it, expect, vi } from 'vitest'
import { Writable } from 'node:stream'
import { createCachedByoFilesResolver, type WorkspaceStorageBinding } from '../byo-files-resolver.js'
import { createSingletonFilesClientResolver, type FilesClientResolver } from '../files-api.js'
import type { GcsFilesClient } from '../gcs-client.js'

function fakeGcs(tag: string): GcsFilesClient & { tag: string } {
  return {
    tag,
    async writeBlob() {}, async appendBlob() {}, async deleteBlob() {},
    async readBlob() { return null },
    async signedReadUrl(k) { return `https://${tag}/${k}` },
    async signedWriteUrl(k) { return `https://${tag}/${k}` },
    writeStream() { return new Writable({ write(_c, _e, cb) { cb() } }) },
  }
}

const creds = { client_email: 'sa@p.iam.gserviceaccount.com' }
const s3creds = { accessKeyId: 'AKIA', secretAccessKey: 'secret' }
const ws = 'workspace_1'

function gcsBinding(bucket: string): WorkspaceStorageBinding {
  return { kind: 'gcs', credentials: creds, bucket }
}

function harness(binding: WorkspaceStorageBinding | null) {
  const appGcs = fakeGcs('app')
  const fallback: FilesClientResolver = createSingletonFilesClientResolver(appGcs, 'app-bucket')
  const byoClients = new Map<string, GcsFilesClient & { tag: string }>()
  const createGcsClient = vi.fn((opts: { bucket: string }) => {
    const c = fakeGcs(`byo:${opts.bucket}`)
    byoClients.set(opts.bucket, c)
    return c
  })
  const createS3Client = vi.fn((opts: { bucket: string }) => {
    const c = fakeGcs(`s3:${opts.bucket}`)
    byoClients.set(opts.bucket, c)
    return c
  })
  const lookup = vi.fn(async () => binding)
  const resolver = createCachedByoFilesResolver({ lookup, fallback, createGcsClient, createS3Client })
  return { appGcs, resolver, createGcsClient, createS3Client, lookup, byoClients }
}

describe('[COMP:files/byo-resolver] createCachedByoFilesResolver', () => {
  it('routes writes to the BYO bucket and marks byo=true', async () => {
    const { resolver, createGcsClient } = harness(gcsBinding('cust-bucket'))
    const r = await resolver.forWorkspace(ws)
    expect(r.bucket).toBe('cust-bucket')
    expect(r.byo).toBe(true)
    expect(r.uriScheme).toBe('gs')
    expect(createGcsClient).toHaveBeenCalledWith({ bucket: 'cust-bucket', projectId: undefined, credentials: creds })
  })

  it('routes an S3 binding to the S3 client and tags uriScheme=s3', async () => {
    const { resolver, createS3Client } = harness({
      kind: 's3', credentials: s3creds, bucket: 's3-bucket', region: 'auto', endpoint: 'https://minio.local',
    })
    const r = await resolver.forWorkspace(ws)
    expect(r.bucket).toBe('s3-bucket')
    expect(r.byo).toBe(true)
    expect(r.uriScheme).toBe('s3')
    expect(createS3Client).toHaveBeenCalledWith({
      bucket: 's3-bucket', region: 'auto', endpoint: 'https://minio.local', forcePathStyle: undefined, credentials: s3creds,
    })
  })

  it('routes an s3:// storage_uri read through the S3 client', async () => {
    const { resolver, byoClients } = harness({ kind: 's3', credentials: s3creds, bucket: 's3-bucket' })
    const c = await resolver.forUri(ws, 's3://s3-bucket/x/y')
    expect(c).toBe(byoClients.get('s3-bucket'))
  })

  it('falls back to the app resolver when the workspace has no binding', async () => {
    const { appGcs, resolver, createGcsClient } = harness(null)
    const r = await resolver.forWorkspace(ws)
    expect(r.bucket).toBe('app-bucket')
    expect(r.byo).toBe(false)
    expect(r.gcs).toBe(appGcs)
    expect(createGcsClient).not.toHaveBeenCalled()
  })

  it('caches the per-bucket client across calls', async () => {
    const { resolver, createGcsClient } = harness(gcsBinding('cust-bucket'))
    await resolver.forWorkspace(ws)
    await resolver.forWorkspace(ws)
    await resolver.forUri(ws, 'gs://cust-bucket/x/y')
    expect(createGcsClient).toHaveBeenCalledTimes(1) // built once, reused
  })

  it('forUri uses BYO creds for files in the current BYO bucket', async () => {
    const { resolver, byoClients } = harness(gcsBinding('cust-bucket'))
    const c = await resolver.forUri(ws, 'gs://cust-bucket/x/y')
    expect(c).toBe(byoClients.get('cust-bucket'))
  })

  it('forUri uses the app client for pre-BYO default-bucket files', async () => {
    const { appGcs, resolver } = harness(gcsBinding('cust-bucket'))
    const c = await resolver.forUri(ws, 'gs://app-bucket/x/y')
    expect(c).toBe(appGcs)
  })

  it('after disconnect (no binding) both reads and writes fall back to the app client', async () => {
    // Disconnect wipes the key → lookup returns null → dormant BYO files read
    // via the app client (which lacks access → not_found at the byte layer).
    const { appGcs, resolver } = harness(null)
    const w = await resolver.forWorkspace(ws)
    expect(w.gcs).toBe(appGcs)
    const r = await resolver.forUri(ws, 'gs://cust-bucket/x/y')
    expect(r).toBe(appGcs)
  })
})
