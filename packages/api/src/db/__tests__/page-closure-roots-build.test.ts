/** Page-root successor of the Page adapter (8287) source: reproducible migration,
 * frozen 8286 authenticator and the read-only successor recipe.
 * [COMP:api/page-closure-adapter] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/page-closure-adapter] Page-root adapter successor source', () => {
  it('reproduces 8287 from its pinned predecessors', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-page-closure-roots.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8286 recipe byte for byte and keeps 316 functions', async () => {
    expect(sha(directory + 'installation-authentication-8286.mjs')).toBe('00bb159c6d4ebee17f345a4c82471f977fc6709e2441b75ee01a92434ea41ad2')
    const recipe = await import(directory + 'installation-authentication-8287.mjs').catch(() => import(directory + 'installation-authentication.mjs'))
    expect(recipe.currentFunctionCount).toBe(316)
    const source = await recipe.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8287_page_closure_roots.sql'))
    expect(() => recipe.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).toContain('installation_page_roots_changed')
  })
  it('changes only the root rule, the lineage batching and the two-role decline of the 8278 member', async () => {
    const m = await import(directory + 'page-closure-roots.mjs')
    const before: string = m.predecessorRootsBody, after: string = m.rootsBody
    expect(after).toContain("AND NOT root->>'kind'=ANY(page_kinds)) THEN RETURN NULL;END IF;")
    // At most 100 roots per lineage call, as the canonical reader requires.
    expect(after).toContain('GROUP BY (x.ord-1)/100')
    // Everything after the lineage comparison (Page admission, labels, fences) is byte-identical.
    const tail = (body: string) => body.slice(body.indexOf(" IF lineage IS DISTINCT FROM"))
    expect(tail(after)).toBe(tail(before))
    // A login outside the two-role model declines instead of raising; it still never admits.
    expect(before).toContain("'access_unavailable'")
    expect(after).not.toContain("'access_unavailable'")
    expect(after).toContain("pg_has_role(r.oid,c.relowner,'USAGE'))) THEN")
    expect(after).not.toMatch(/set_config\(|INSERT INTO|UPDATE |DELETE FROM/)
    const migration = readFileSync(migrations + '8287_page_closure_roots.sql', 'utf8')
    expect(migration.indexOf('page_roots_predecessor_changed')).toBeLessThan(migration.indexOf('CREATE OR REPLACE FUNCTION public.capture_page_closure_evidence('))
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
  })
})
