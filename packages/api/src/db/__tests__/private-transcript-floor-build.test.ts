/** Private-transcript floor successor (8281) source: reproducible migration, frozen
 * 8280 authenticator, the read-only successor recipe and the exact floor change.
 * [COMP:api/private-transcript] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const file = (path: string) => sha(readFileSync(path))

describe('[COMP:api/private-transcript] private-transcript floor successor source', () => {
  it('reproduces 8281 from its pinned predecessors and keeps 8280 reproducible', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-private-transcript-floor.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(() => execFileSync(process.execPath, [directory + 'build-query-domain-visibility.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8280 recipe byte for byte and keeps the 8281 recipe at 316 functions', async () => {
    expect(file(directory + 'installation-authentication-8280.mjs')).toBe('eb42e3b3950f711cf3bf6cb61f3beb2db954090d3d29a49d329c212792383747')
    // The 8281 recipe is frozen as installation-authentication-8281.mjs once a later owner succeeds it.
    const head = await import(directory + 'installation-authentication-8281.mjs')
    expect(head.currentFunctionCount).toBe(316)
    const source = await head.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(file(migrations + '8281_private_transcript_floor.sql'))
    expect(() => head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).not.toMatch(/a8280_/)
    expect(source.sql).toContain('installation_private_transcript_floor_changed')
    expect(source.sql).toContain('installation_query_domain_changed')
  })
  it('keys only the personal scope floor to the reading assistant', async () => {
    const m = await import(directory + 'private-transcript-floor.mjs')
    expect(sha(m.floorBody)).not.toBe(m.predecessorFloorSha)
    // The answering assistant is pinned by the host, must be a placement-visible
    // assistant of the workspace, and replaces the bound assistant only in the floor.
    expect(m.floorBody).toContain("acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid")
    expect(m.floorBody).toContain('assistant_placement_visible(actor,acting) IS NOT TRUE')
    expect(m.floorBody).toContain('personal_web_session_scope_allows(w,actor,floor_assistant,')
    expect(m.floorBody).not.toContain('personal_web_session_scope_allows(w,actor,aid,')
    // Every other check of the parent (device, membership, bound assistant, session shape) is unchanged.
    expect(m.floorBody).toContain('assistant_placement_visible(actor,aid) IS NOT TRUE')
    expect(m.floorBody).toContain("RAISE EXCEPTION 'authenticated_session_required'")
    expect(m.floorBody).not.toMatch(/set_config\(|INSERT INTO|UPDATE |DELETE FROM/)
    const migration = readFileSync(migrations + '8281_private_transcript_floor.sql', 'utf8')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
    expect(migration.indexOf('private_transcript_floor_predecessor_changed')).toBeLessThan(migration.indexOf('CREATE OR REPLACE FUNCTION public.private_session_display_parent('))
  })
})
