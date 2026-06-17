/**
 * [COMP:files/local-client] Local-disk GcsFilesClient fallback (dev/test).
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
import { createLocalFilesClient } from '../local-files-client.js'

let baseDir: string
const client = () => createLocalFilesClient({ baseDir })

beforeAll(async () => {
  baseDir = await fs.mkdtemp(join(tmpdir(), 'sidanclaw-files-test-'))
})
afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {})
})

describe('[COMP:files/local-client] createLocalFilesClient', () => {
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
})
