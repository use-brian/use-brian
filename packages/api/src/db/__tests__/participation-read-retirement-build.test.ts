/** Project participation retirement and unmovable-child successor (8290) source:
 * reproducible migration, frozen 8289 authenticator and the read-only successor recipe.
 * [COMP:api/task-mutation-scope] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/task-mutation-scope] Project participation retirement source', () => {
  it('reproduces 8290 from its pinned predecessors', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-participation-read-retirement.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8289 recipe byte for byte and keeps 392 functions', async () => {
    expect(sha(directory + 'installation-authentication-8289.mjs')).toBe('6ba340467bed84b2b2551f9a151579ca8433ac92c42c30c9d1d99feb8e52040d')
    const frozen = await import(directory + 'installation-authentication-8289.mjs')
    expect(frozen.currentFunctionCount).toBe(392)
    const recipe = await import(directory + 'installation-authentication-8290.mjs').catch(() => import(directory + 'installation-authentication.mjs'))
    expect(recipe.currentFunctionCount).toBe(392)
    const source = await recipe.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8290_participation_read_retirement.sql'))
    expect(() => recipe.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).toContain('installation_participation_retirement_changed')
  })
  it('removes only the participation gate and moves only children the editor could move', async () => {
    const m = await import(directory + 'participation-read-retirement.mjs')
    const before: string = m.predecessorReadBody, after: string = m.readBody
    expect(before).toContain('workspace_project_members')
    expect(after).not.toContain('workspace_project_members')
    expect(after).not.toContain("wm.role IN('owner','admin')")
    // Everything before the Project clause (membership, visibility, Team and clearance) is byte-identical.
    const head = (body: string) => body.slice(0, body.indexOf("pr.status='active'"))
    expect(head(after)).toBe(head(before))
    expect(after).toContain("pr.status='active')) THEN RETURN NULL; END IF;")
    for (const item of m.ordinaryReplacements.slice(0, 2)) expect(item.body).not.toContain('workspace_project_members')
    const patch = m.ordinaryReplacements[2].body as string
    expect(patch).toContain("AND application_task_patch_state(w,child.id,ARRAY['parentId']) IS NOT NULL;")
    const migration = readFileSync(migrations + '8290_participation_read_retirement.sql', 'utf8')
    expect(migration.indexOf('participation_retirement_predecessor_changed')).toBeLessThan(migration.indexOf('$participation_ordinary$'))
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
  })
})
