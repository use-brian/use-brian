import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadLocalProviderPreference,
  saveLocalProviderPreference,
} from '../local-provider-preference.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('[COMP:api/codex-provider] local provider preference persistence', () => {
  it('atomically preserves unrelated launcher configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brian-provider-preference-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'nested', 'config.json')
    await saveLocalProviderPreference('openai-codex', path)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      preferredProvider: 'openai-codex',
    })

    await writeFile(
      path,
      JSON.stringify({
        preferredProvider: 'openai-codex',
        port: 5173,
        credentialMode: 'chatgpt',
      }),
      'utf8',
    )
    await saveLocalProviderPreference('gemini', path)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      preferredProvider: 'gemini',
      port: 5173,
      credentialMode: 'chatgpt',
    })
  })

  it('restores the saved preference after an API process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brian-provider-preference-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'config.json')

    expect(await loadLocalProviderPreference(path)).toBeNull()

    await saveLocalProviderPreference('dashscope-intl', path)

    expect(await loadLocalProviderPreference(path)).toBe('dashscope-intl')
  })

  it('ignores an inaccessible legacy launcher preference at service boot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brian-provider-preference-'))
    temporaryDirectories.push(directory)
    const protectedDirectory = join(directory, 'launcher-home')
    const path = join(protectedDirectory, 'config.json')
    await mkdir(protectedDirectory)
    await writeFile(path, JSON.stringify({ preferredProvider: 'openai-codex' }), 'utf8')
    await chmod(protectedDirectory, 0o000)

    try {
      expect(await loadLocalProviderPreference(path)).toBeNull()
    } finally {
      await chmod(protectedDirectory, 0o700)
    }
  })

  it('still rejects malformed readable launcher configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brian-provider-preference-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'config.json')
    await writeFile(path, '{malformed', 'utf8')

    await expect(loadLocalProviderPreference(path)).rejects.toThrow()
  })
})
