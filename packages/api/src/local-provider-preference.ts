/**
 * Load and persist the OSS preferred model provider without touching OAuth state.
 *
 * The launcher owns the full ~/.usebrian/config.json shape. These helpers read
 * only the validated `preferredProvider` value and perform a narrow, atomic
 * merge when it changes; they never read Codex credentials or return/log the
 * rest of the config.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { OssPreferredProvider } from './codex-provider-manager.js'

const ConfigSchema = z.record(z.unknown())
const PreferredProviderSchema = z.enum([
  'auto',
  'gemini',
  'openai-codex',
  'dashscope-intl',
])
const DEFAULT_CONFIG_PATH = join(homedir(), '.usebrian', 'config.json')

export async function loadLocalProviderPreference(
  path = DEFAULT_CONFIG_PATH,
): Promise<OssPreferredProvider | null> {
  try {
    const config = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const parsed = PreferredProviderSchema.safeParse(config.preferredProvider)
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

export async function saveLocalProviderPreference(
  preferredProvider: OssPreferredProvider,
  path = DEFAULT_CONFIG_PATH,
): Promise<void> {
  let config: Record<string, unknown> = {}
  try {
    config = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  const next = { ...config, preferredProvider }
  const tempPath = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(tempPath, path)
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
