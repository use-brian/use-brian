/**
 * Persist the OSS preferred model provider without touching OAuth state.
 *
 * The launcher owns ~/.usebrian/config.json. This helper performs a narrow,
 * atomic merge of `preferredProvider`; it never reads Codex credentials and
 * never returns or logs the rest of the config.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { OssPreferredProvider } from './codex-provider-manager.js'

const ConfigSchema = z.record(z.unknown())
const DEFAULT_CONFIG_PATH = join(homedir(), '.usebrian', 'config.json')

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
