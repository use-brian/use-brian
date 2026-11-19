/** Page source-family adapter (8278) source: reproducible migration, frozen
 * 8277 authenticator and the read-only successor recipe.
 * [COMP:api/page-closure-adapter] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/page-closure-adapter] Page closure adapter source', () => {
  it('reproduces 8278 from its pinned predecessors and keeps 8277 reproducible', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-page-closure.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(() => execFileSync(process.execPath, [directory + 'build-turn-completion.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8277 recipe byte for byte and keeps the 8278 recipe at 316 functions', async () => {
    expect(sha(directory + 'installation-authentication-8277.mjs')).toBe('6b060db97621991a4b6c4df4e6029775f18b2409fa51a915c20d862e281748fe')
    // The 8278 recipe is a frozen named predecessor since 8280.
    expect(sha(directory + 'installation-authentication-8278.mjs')).toBe('266a934c8e5cad3f86a0fb3c9a01a141abc2e1c731a60147964e6f7f42074d15')
    const head = await import(directory + 'installation-authentication-8278.mjs')
    expect(head.currentFunctionCount).toBe(316)
    const source = await head.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8278_page_closure_adapter.sql'))
    expect(() => head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).not.toMatch(/a8277_/)
    expect(source.sql).toContain('installation_page_closure_member_changed')
    expect(source.sql).toContain('installation_page_authority_changed')
  })
  it('enrolls one application port and replaces only the exact 725 Page principal reader', async () => {
    const m = await import(directory + 'page-closure.mjs')
    expect(m.pageClosureSignatures).toEqual(['capture_page_closure_evidence(uuid,jsonb,uuid)'])
    const member = m.memberCreate('capture_page_closure_evidence')
    // Two-role model and decline-first contract: no stored decision, no setting, no write of its own.
    expect(member).toContain('native_turn_helpers_current() IS NOT TRUE')
    expect(member).toContain("actor::text IS DISTINCT FROM current_setting('app.current_user_id',true)")
    expect(member).not.toMatch(/set_config\(|INSERT INTO|UPDATE |DELETE FROM/)
    const parts = m.pageClosureParts()
    expect(parts.successor).not.toContain('LOCK TABLE')
    expect((parts.successor.match(/FOR KEY SHARE/g) ?? []).length).toBe(2)
    expect(m.pageAuthorityPredecessorSql).toContain(m.predecessorPageAuthoritySha)
    const migration = readFileSync(migrations + '8278_page_closure_adapter.sql', 'utf8')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
    expect(migration.indexOf('page_authority_predecessor_changed')).toBeLessThan(migration.indexOf('CREATE OR REPLACE FUNCTION public.read_page_event_authority('))
  })
})
