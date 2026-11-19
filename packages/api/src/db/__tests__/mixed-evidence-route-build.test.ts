import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scripts = new URL('../../../scripts/conversation-store/', import.meta.url)
const { mixedEvidenceRouteMigration, routeBodyDigest } =
  await import(new URL('build-mixed-evidence-route.mjs', scripts).href)
const { currentReleaseSource } = await import(new URL('installation-release.mjs', scripts).href)

describe('[COMP:api/caller-scope-evidence] mixed conversation source installation', () => {
  it('renders the numbered migration and pins the same route body in the actual caller', async () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('build-mixed-evidence-route.mjs', scripts)), '--check'])
    const [digest, caller] = await Promise.all([
      routeBodyDigest(),
      readFile(new URL('../../application-platform/conversation-evidence.ts', import.meta.url), 'utf8'),
    ])
    for (const body of Object.values(digest)) expect(caller).toContain(body)
    const profile = await currentReleaseSource(mixedEvidenceRouteMigration)
    expect(profile.functions).toBe(492)
    expect(profile.sql).toContain('installation_mixed_evidence_route_changed')
  })
})
