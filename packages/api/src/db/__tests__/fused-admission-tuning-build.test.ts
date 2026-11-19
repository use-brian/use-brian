/** Fused admission plan-size successor (8294) source: reproducible migration, frozen
 * 8290 authenticator, the read-only successor recipe and the tuned helper set.
 * [COMP:api/fused-admission] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/fused-admission] fused admission plan-size successor source', () => {
  it('reproduces 8294 from its pinned predecessors', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-fused-admission-tuning.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8290 recipe byte for byte and keeps 392 functions', async () => {
    expect(sha(directory + 'installation-authentication-8290.mjs')).toBe('42991313d28697d9a5ea9e059dd6e821cd504caaee8511d8f1386189552e0ed6')
    const head = await import(directory + 'installation-authentication-8294.mjs').catch(() => import(directory + 'installation-authentication.mjs'))
    expect(head.currentFunctionCount).toBe(392)
    const source = await head.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8294_fused_admission_plan_size.sql'))
    expect(() => head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).toContain('installation_fused_tuning_changed')
  })
  it('changes only the function-level setting of 17 compiled helpers', async () => {
    const m = await import(directory + 'fused-admission-tuning.mjs')
    expect(m.tunedSignatures).toHaveLength(17)
    expect(m.tunedSignatures.every((s: string) => s.startsWith('fused_c_'))).toBe(true)
    const migration = readFileSync(migrations + '8294_fused_admission_plan_size.sql', 'utf8')
    expect(migration.match(/^ALTER FUNCTION public\.fused_c_\w+\([^)]*\) SET search_path=pg_catalog,public,pg_temp;$/gm)).toHaveLength(17)
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\./)
    expect(migration.indexOf('fused_tuning_predecessor_changed')).toBeLessThan(migration.indexOf('ALTER FUNCTION public.fused_c_'))
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
  })
})
