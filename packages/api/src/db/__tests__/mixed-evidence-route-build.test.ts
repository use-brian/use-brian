import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const scripts = new URL('../../../scripts/conversation-store/', import.meta.url)
const { buildMixedEvidenceRouteMigration, mixedEvidenceRouteMigration, routeBodyDigest } =
  await import(new URL('build-mixed-evidence-route.mjs', scripts).href)
const { currentReleaseSource } = await import(new URL('installation-release.mjs', scripts).href)

describe('[COMP:api/caller-scope-evidence] mixed conversation source installation', () => {
  it('renders the numbered migration and pins the same route body in the actual caller', async () => {
    const [applied, generated, digest, caller] = await Promise.all([
      readFile(new URL('../../../migrations/' + mixedEvidenceRouteMigration, import.meta.url), 'utf8'),
      buildMixedEvidenceRouteMigration(),
      routeBodyDigest(),
      readFile(new URL('../../application-platform/conversation-evidence.ts', import.meta.url), 'utf8'),
    ])
    expect(applied).toBe(generated)
    for (const body of Object.values(digest)) expect(caller).toContain(body)
    const profile = await currentReleaseSource(mixedEvidenceRouteMigration)
    expect(profile.functions).toBe(492)
    expect(profile.sql).toContain('installation_mixed_evidence_route_changed')
  })
})
