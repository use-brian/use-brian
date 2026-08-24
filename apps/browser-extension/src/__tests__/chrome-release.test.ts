import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const scriptPath = join(repoRoot, 'scripts/publish-browser-extension.sh')
const script = readFileSync(scriptPath, 'utf8')
const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'apps/browser-extension/static/manifest.json'), 'utf8'),
) as { version: string }
const bridge = readFileSync(
  join(repoRoot, 'apps/app-web/src/lib/browser-extension-bridge.ts'),
  'utf8',
)

describe('[COMP:ext/chrome-release] Chrome Web Store release command', () => {
  it('is valid Bash with a discoverable artifact-only default', () => {
    expect(() => execFileSync('bash', ['-n', scriptPath])).not.toThrow()
    const help = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' })
    expect(help).toContain('artifact-only unless --publish is present')
    expect(help).toContain('--auto-publish')
    expect(help).toContain('CHROME_WEB_STORE_PUBLISHER_ID')
    expect(script).toContain('PUBLISH=0')
    expect(script.indexOf('if [[ "$PUBLISH" != "1" ]]')).toBeLessThan(
      script.indexOf('PUBLISHER_ID="${CHROME_WEB_STORE_PUBLISHER_ID:-}"'),
    )
  })

  it('rejects unsafe flag combinations before doing release work', () => {
    const offlinePublish = spawnSync(
      'bash',
      [scriptPath, '--publish', '--offline', '--yes'],
      { encoding: 'utf8' },
    )
    expect(offlinePublish.status).toBe(1)
    expect(offlinePublish.stderr).toContain('--offline cannot be combined with --publish')

    const implicitPublish = spawnSync('bash', [scriptPath, '--auto-publish'], {
      encoding: 'utf8',
    })
    expect(implicitPublish.status).toBe(1)
    expect(implicitPublish.stderr).toContain('--auto-publish requires --publish')
  })

  it('uses Chrome Web Store API v2 with staged, warning-blocking publication', () => {
    expect(script).toContain('chromewebstore.googleapis.com/upload/v2/')
    expect(script).toContain(':fetchStatus')
    expect(script).toContain(':publish')
    expect(script).toContain('PUBLISH_TYPE="STAGED_PUBLISH"')
    expect(script).toContain('\\"blockOnWarnings\\":true')
    expect(script).not.toContain('chromewebstore/v1.1')
  })

  it('packages a new version for the canonical Store listing', () => {
    expect(manifest.version).toBe('1.0.1')
    expect(script).toContain('nnmbbacnkekaoccmkmlfaghjaamgdpjn')
    expect(bridge).toContain(
      'chromewebstore.google.com/detail/use-brian-browser-agent/nnmbbacnkekaoccmkmlfaghjaamgdpjn',
    )
    expect(bridge).not.toContain('chromewebstore.google.com/search')
  })

  it('pins build metadata and ZIP timestamps to the source commit', () => {
    const assemble = readFileSync(
      join(repoRoot, 'apps/browser-extension/scripts/assemble.mjs'),
      'utf8',
    )
    expect(assemble).toContain('process.env.SOURCE_DATE_EPOCH')
    expect(script).toContain('SOURCE_DATE_EPOCH=')
    expect(script).toContain('TZ=UTC zip -X')
  })
})
