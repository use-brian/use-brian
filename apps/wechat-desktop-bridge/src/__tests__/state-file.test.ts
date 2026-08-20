/**
 * [COMP:app/wechat-desktop-bridge] state file: round trip + atomic write.
 */
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadStateFile, saveStateFile } from '../state-file.js'

describe('[COMP:app/wechat-desktop-bridge] state file', () => {
  it('round-trips cursors and reports fresh on a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-state-'))
    const path = join(dir, 'nested', 'state.json')
    const first = await loadStateFile(path)
    expect(first).toEqual({ state: { version: 1, cursors: {} }, fresh: true })
    await saveStateFile(path, { version: 1, cursors: { wxid_example1: 42, '1@chatroom': 7 } })
    const second = await loadStateFile(path)
    expect(second).toEqual({ state: { version: 1, cursors: { wxid_example1: 42, '1@chatroom': 7 } }, fresh: false })
  })

  it('writes through a temp file and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-state-'))
    const path = join(dir, 'state.json')
    await saveStateFile(path, { version: 1, cursors: { a: 1 } })
    await saveStateFile(path, { version: 1, cursors: { a: 2 } })
    expect(await readdir(dir)).toEqual(['state.json'])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, cursors: { a: 2 } })
  })

  it('round-trips an undelivered media recovery entry across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-state-'))
    const path = join(dir, 'state.json')
    await saveStateFile(path, {
      version: 1,
      cursors: { wxid_example1: 10 },
      pendingMediaUpgrades: {
        wxid_example1: [{
          localId: 11,
          message: {
            peerId: 'wxid_example1', senderId: 'wxid_example1', messageId: '1011', text: 'plan.docx',
            timestamp: 1_700_000_000_000, isGroupChat: false,
          },
          kind: 'file',
          delivered: false,
          variant: undefined,
          forwardedSha256: null,
          stagedMedia: {
            kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            name: 'plan.docx', sizeBytes: 123,
            stored: { assetId: '11111111-1111-1111-1111-111111111111', sha256: 'a'.repeat(64) },
          },
          attempts: 3,
          firstSeenAt: 1_700_000_000_000,
          nextAttemptAt: 1_700_000_060_000,
        }],
      },
    })
    const loaded = await loadStateFile(path)
    expect(loaded.state.pendingMediaUpgrades?.wxid_example1?.[0]).toMatchObject({
      localId: 11, kind: 'file', delivered: false, attempts: 3, nextAttemptAt: 1_700_000_060_000,
      stagedMedia: { name: 'plan.docx', stored: { sha256: 'a'.repeat(64) } },
    })
    expect(loaded.state.cursors.wxid_example1).toBe(10)
  })

  it('treats a corrupt file as fresh and drops non-numeric cursors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-state-'))
    const path = join(dir, 'state.json')
    await writeFile(path, '{not json', 'utf8')
    expect((await loadStateFile(path)).fresh).toBe(true)
    await writeFile(path, JSON.stringify({ version: 1, cursors: { ok: 3, bad: 'x' } }), 'utf8')
    expect((await loadStateFile(path)).state.cursors).toEqual({ ok: 3 })
  })
})
