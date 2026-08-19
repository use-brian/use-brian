/**
 * Build stamp. The Dockerfile writes `dist/build-info.json` beside the compiled
 * entry; a source checkout (tsx / vitest) has none and reports 'dev'. Reported
 * as `bridgeVersion` in every PUT /state (CLAUDE.md build-stamp rule).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type BuildInfo = { gitSha: string; buildTime: string }

function readBuildInfo(dir: string = dirname(fileURLToPath(import.meta.url))): BuildInfo | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8')) as Partial<BuildInfo>
    return {
      gitSha: typeof raw.gitSha === 'string' && raw.gitSha ? raw.gitSha : 'unknown',
      buildTime: typeof raw.buildTime === 'string' && raw.buildTime ? raw.buildTime : 'unknown',
    }
  } catch {
    return null
  }
}

/** "abc1234 (2026-08-19T10:00:00Z)" in a container, "dev" from source. */
export function bridgeVersionString(info: BuildInfo | null = readBuildInfo()): string {
  if (!info) return 'dev'
  const sha = info.gitSha === 'unknown' ? 'unknown' : info.gitSha.slice(0, 12)
  return `${sha} (${info.buildTime})`
}
