import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')

describe('[COMP:files/local-client] OSS local storage composition', () => {
  it('keeps launcher-managed blobs beside the durable embedded database', async () => {
    const launcher = await readFile(resolve(root, 'scripts/launch.mjs'), 'utf8')

    expect(launcher).toContain("const FILES_DIR = join(CONFIG_DIR, 'files')")
    expect(launcher).toContain("LOCAL_FILES_DIR: process.env.LOCAL_FILES_DIR?.trim() || FILES_DIR")
  })

  it('imports the legacy ephemeral blob directory before switching paths', async () => {
    const launcher = await readFile(resolve(root, 'scripts/launch.mjs'), 'utf8')

    expect(launcher).toContain("join(tmpdir(), 'sidanclaw-files')")
    expect(launcher).toContain('cpSync(legacyFilesDir, FILES_DIR, { recursive: true })')
  })
})
