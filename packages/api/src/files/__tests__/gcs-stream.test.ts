import { describe, it, expect, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGcsFilesClient, deferredWritable, streamUrlToGcs, MediaTooLargeError } from '../gcs-client.js'

// The SDK is replaced by an in-memory bucket. `sdk.loads` counts module
// evaluations, which proves the client loads it at first use only.
const sdk = vi.hoisted(() => ({ loads: 0, objects: new Map<string, string>(), committed: [] as string[], failWrite: false }))
vi.mock('@google-cloud/storage', () => {
  sdk.loads++
  class Storage {
    bucket() {
      return {
        file: (key: string) => ({
          save: async (bytes: Buffer) => { sdk.objects.set(key, bytes.toString()) },
          createWriteStream: () => {
            const chunks: Buffer[] = []
            return new Writable({
              write(chunk, _enc, cb) {
                if (sdk.failWrite) { cb(new Error('gcs upload rejected')); return }
                chunks.push(Buffer.from(chunk)); cb()
              },
              // The upload commits after the last byte, asynchronously.
              final(cb) { setTimeout(() => { sdk.objects.set(key, Buffer.concat(chunks).toString()); sdk.committed.push(key); cb() }, 15) },
            })
          },
        }),
      }
    }
  }
  return { Storage }
})

/**
 * [COMP:files/gcs-stream] — the pull-by-URL → GCS streaming ingress. The fetch
 * and the destination are injected, so this asserts the streaming contract
 * (constant-memory chunk forwarding, byte-cap abort via both content-length and
 * a running counter) with an in-memory collector — no GCS, no network.
 */

function fakeResponse(chunks: string[], headers: Record<string, string>) {
  const web = Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c))))
  return {
    ok: true,
    status: 200,
    body: web,
    headers: new Headers(headers),
  } as unknown as Response
}

function collector(): { stream: Writable; get: () => Buffer } {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  return { stream, get: () => Buffer.concat(chunks) }
}

describe('[COMP:files/gcs-stream] streamUrlToGcs', () => {
  it('streams the body into the destination and reports bytes + mime', async () => {
    const sink = collector()
    const res = await streamUrlToGcs({
      url: 'https://cdn.example/file',
      openWrite: () => sink.stream,
      maxBytes: 1024,
      fetchFn: async () => fakeResponse(['hello', ' ', 'world'], { 'content-type': 'video/mp4' }),
    })
    expect(res.bytesWritten).toBe(11)
    expect(res.mime).toBe('video/mp4')
    expect(sink.get().toString()).toBe('hello world')
  })

  it('rejects up front when content-length exceeds the cap', async () => {
    const sink = collector()
    await expect(
      streamUrlToGcs({
        url: 'u',
        openWrite: () => sink.stream,
        maxBytes: 100,
        fetchFn: async () => fakeResponse(['x'], { 'content-length': '2000' }),
      }),
    ).rejects.toBeInstanceOf(MediaTooLargeError)
  })

  it('aborts mid-stream when the running byte counter exceeds the cap (no/lying content-length)', async () => {
    const sink = collector()
    await expect(
      streamUrlToGcs({
        url: 'u',
        openWrite: () => sink.stream,
        maxBytes: 4,
        // 9 bytes, no content-length header — only the running counter catches it.
        fetchFn: async () => fakeResponse(['abc', 'def', 'ghi'], {}),
      }),
    ).rejects.toBeInstanceOf(MediaTooLargeError)
  })

  it('throws on a non-ok fetch', async () => {
    const sink = collector()
    await expect(
      streamUrlToGcs({
        url: 'u',
        openWrite: () => sink.stream,
        maxBytes: 100,
        fetchFn: async () => ({ ok: false, status: 404, body: null, headers: new Headers() }) as unknown as Response,
      }),
    ).rejects.toThrow(/media fetch failed/)
  })
})

describe('[COMP:files/gcs-stream] lazy SDK and deferred write stream', () => {
  it('loads @google-cloud/storage at the first bucket operation, not at import or client construction', async () => {
    expect(sdk.loads).toBe(0)
    const client = createGcsFilesClient({ bucket: 'fixture-bucket' })
    expect(sdk.loads).toBe(0)
    await client.writeBlob('ws/one', Buffer.from('hello'), { workspaceId: 'ws', mime: 'text/plain' })
    expect(sdk.loads).toBe(1)
    expect(sdk.objects.get('ws/one')).toBe('hello')
  })

  it('writeStream is synchronous and a pipeline resolves only after the upload commits', async () => {
    const client = createGcsFilesClient({ bucket: 'fixture-bucket' })
    const sink = client.writeStream('ws/stream', { mime: 'text/plain' })
    expect(sink).toBeInstanceOf(Writable)
    await pipeline(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), sink)
    expect(sdk.committed).toContain('ws/stream')
    expect(sdk.objects.get('ws/stream')).toBe('abcd')
  })

  it('a destination write error fails the pipeline instead of reporting completion', async () => {
    sdk.failWrite = true
    try {
      const client = createGcsFilesClient({ bucket: 'fixture-bucket' })
      await expect(pipeline(Readable.from([Buffer.from('x')]), client.writeStream('ws/fail', { mime: 'text/plain' }))).rejects.toThrow('gcs upload rejected')
      expect(sdk.committed).not.toContain('ws/fail')
    } finally {
      sdk.failWrite = false
    }
  })

  it('a destination that cannot open fails the pipeline with its error', async () => {
    const sink = deferredWritable(async () => { throw new Error('storage backend unavailable') })
    await expect(pipeline(Readable.from([Buffer.from('x')]), sink)).rejects.toThrow('storage backend unavailable')
  })
})
