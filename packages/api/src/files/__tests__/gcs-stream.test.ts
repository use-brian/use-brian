import { describe, it, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { streamUrlToGcs, MediaTooLargeError } from '../gcs-client.js'

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
