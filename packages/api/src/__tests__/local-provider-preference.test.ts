import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
})
