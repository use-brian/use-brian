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

  it('treats a corrupt file as fresh and drops non-numeric cursors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-state-'))
    const path = join(dir, 'state.json')
    await writeFile(path, '{not json', 'utf8')
    expect((await loadStateFile(path)).fresh).toBe(true)
    await writeFile(path, JSON.stringify({ version: 1, cursors: { ok: 3, bad: 'x' } }), 'utf8')
    expect((await loadStateFile(path)).state.cursors).toEqual({ ok: 3 })
  })
})
