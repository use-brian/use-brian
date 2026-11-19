/** Page-derived title payload admission (8286) source: reproducible migration,
 * frozen 8281 authenticator and the read-only successor recipe.
 * [COMP:api/page-closure-adapter] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/page-closure-adapter] title payload admission source', () => {
  it('reproduces 8286 from its pinned predecessors', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-title-revision-admission.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8281 recipe byte for byte and keeps 316 functions', async () => {
    expect(sha(directory + 'installation-authentication-8281.mjs')).toBe('b664d546437d2bb09b64773f0270deacadbc7b2c20393e4dce192829071d275f')
    const recipe = await import(directory + 'installation-authentication-8286.mjs').catch(() => import(directory + 'installation-authentication.mjs'))
    expect(recipe.currentFunctionCount).toBe(316)
    const source = await recipe.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8286_title_revision_admission.sql'))
    expect(() => recipe.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).not.toMatch(/a8281_/)
    expect(source.sql).toContain('installation_title_admission_changed')
  })
  it('replaces only the exact predecessor body and asks the Page adapter once, before the generic evaluation', async () => {
    const m = await import(directory + 'title-revision-admission.mjs')
    expect(m.admissionSignature).toBe('session_context_revision_allowed(uuid,uuid)')
    expect(m.admissionRendererSql('x', 'y')).toContain(m.predecessorAdmissionSha)
    const body: string = m.admissionBody
    // Decline-first: the adapter can only admit; every other outcome keeps the original evaluation.
    expect(body.indexOf('capture_page_closure_evidence(')).toBeGreaterThan(body.indexOf('capture_conversation_evidence('))
    expect(body.indexOf('capture_page_closure_evidence(')).toBeLessThan(body.indexOf('application_canonical_ancestry_allowed('))
    expect(body).toContain('workflow_evidence_envelope_visible(w,c) IS NOT TRUE')
    expect(body).not.toMatch(/set_config\(|INSERT INTO|UPDATE |DELETE FROM/)
    const migration = readFileSync(migrations + '8286_title_revision_admission.sql', 'utf8')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
  })
})
