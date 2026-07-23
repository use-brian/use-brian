/**
 * [COMP:files/local-client] Local-disk GcsFilesClient implementation.
 *
 * The file primitive needs a blob store; without GCS_FILES_BUCKET the boot
 * wiring uses this so `fileWrite`/`saveFileToBrain` work locally. We verify the
 * round-trip preserves bytes + mime (the whole point — a binary upload must
 * survive verbatim) and that the GcsFilesClient contract holds (404 → null,
 * idempotent delete, append).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createLocalFilesClient, resolveLocalFilesBaseDir } from '../local-files-client.js'

let baseDir: string
const client = () => createLocalFilesClient({ baseDir })

beforeAll(async () => {
  baseDir = await fs.mkdtemp(join(tmpdir(), 'sidanclaw-files-test-'))
})
afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {})
})

describe('[COMP:files/local-client] createLocalFilesClient', () => {
  it('resolves LOCAL_FILES_DIR to an absolute configured directory', () => {
    expect(resolveLocalFilesBaseDir(' ./durable-files ')).toBe(join(process.cwd(), 'durable-files'))
    expect(resolveLocalFilesBaseDir()).toBe(join(tmpdir(), 'sidanclaw-files'))
  })

  it('round-trips raw binary bytes + mime verbatim', async () => {
    const c = client()
    // Non-UTF-8 bytes — a utf-8 round-trip would corrupt these.
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    await c.writeBlob('ws1/file-a', bytes, { workspaceId: 'ws1', mime: 'image/jpeg' })

    const blob = await c.readBlob('ws1/file-a')
    expect(blob).not.toBeNull()
    expect([...blob!.bytes]).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(blob!.mime).toBe('image/jpeg')
    expect(blob!.metadata.workspaceId).toBe('ws1')
  })

  it('returns null for a missing key (404 contract)', async () => {
    expect(await client().readBlob('ws1/does-not-exist')).toBeNull()
  })

  it('appends to an existing blob, preserving metadata', async () => {
    const c = client()
    await c.writeBlob('ws1/log', Buffer.from('one\n'), { workspaceId: 'ws1', mime: 'text/plain' })
    await c.appendBlob('ws1/log', Buffer.from('two\n'))
    const blob = await c.readBlob('ws1/log')
    expect(blob!.bytes.toString('utf-8')).toBe('one\ntwo\n')
    expect(blob!.mime).toBe('text/plain')
  })

  it('delete is idempotent (no throw on a missing key)', async () => {
    const c = client()
    await c.writeBlob('ws1/del', Buffer.from('x'), { workspaceId: 'ws1', mime: 'text/plain' })
    await c.deleteBlob('ws1/del')
    expect(await c.readBlob('ws1/del')).toBeNull()
    await expect(c.deleteBlob('ws1/del')).resolves.toBeUndefined(); // second delete: no-op
  })

  it('does not finish a stream write before bytes are durable', async () => {
    const c = client()
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
    await pipeline(
      Readable.from([bytes]),
      c.writeStream('ws1/streamed', {
        mime: 'application/octet-stream',
        metadata: { workspaceId: 'ws1', mime: 'application/octet-stream' },
      }),
    )
    const blob = await c.readBlob('ws1/streamed')
    expect(blob?.bytes.length).toBe(bytes.length)
    expect(blob?.bytes.equals(bytes)).toBe(true)
  })

  it('mints signed HTTP transfer URLs when the API signing context is configured', async () => {
    const c = createLocalFilesClient({
      baseDir,
      apiUrl: 'http://127.0.0.1:4000',
      signingSecret: 'test-secret',
    })
    const read = new URL(await c.signedReadUrl('ws1/recording', 60))
    const write = new URL(await c.signedWriteUrl('ws1/recording', { contentType: 'audio/mp4', ttlSec: 60 }))

    expect(read.origin + read.pathname).toBe('http://127.0.0.1:4000/api/local-files')
    expect(read.searchParams.get('action')).toBe('read')
    expect(read.searchParams.get('signature')).toBeTruthy()
    expect(write.searchParams.get('action')).toBe('write')
    expect(write.searchParams.get('mime')).toBe('audio/mp4')
    expect(write.searchParams.get('signature')).toBeTruthy()
  })

  it('rejects keys that escape the configured storage directory', async () => {
    await expect(client().writeBlob('../escape', Buffer.from('no'), {
      workspaceId: 'ws1',
      mime: 'text/plain',
    })).rejects.toThrow('key escapes storage directory')
  })
})
