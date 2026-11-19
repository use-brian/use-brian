/** Durable completion header (8277) source: reproducible migration, frozen
 * predecessor authenticator and the read-only successor recipe.
 * [COMP:api/native-turn-frame] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/native-turn-frame] durable completion header source', () => {
  it('reproduces 8277 from its pinned predecessors and keeps 8276 reproducible', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-turn-completion.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(() => execFileSync(process.execPath, [directory + 'build-registry-guard-successor.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('keeps the 8276 authenticator as a frozen named predecessor and pins the 8277 recipe', async () => {
    expect(sha(directory + 'installation-authentication-8276.mjs')).toBe('7df592e19728ba99b5db47ca2ade2f296f4639b4c23403ccb2e3e0ac238d19b4')
    // Frozen byte copy since 8278 (page-closure-build.test.ts pins the head).
    const head = await import(directory + 'installation-authentication-8277.mjs')
    expect(head.currentFunctionCount).toBe(315)
    const source = await head.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8277_durable_turn_completions.sql'))
    expect(() => head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    // Every compiled reference is private; no public definition or registry row is written.
    expect(source.sql).not.toMatch(/a8276_/)
    expect(source.sql).toContain('installation_completion_member_changed')
    expect(source.sql).toContain('installation_completion_relation_changed')
  })
  it('enrolls exactly four members, two application ports, and replaces only the exact 8272 classifier', async () => {
    const m = await import(directory + 'turn-completion.mjs')
    expect(m.completionSignatures).toEqual(['native_turn_completion_scope(uuid,uuid)', 'record_native_turn_completion(uuid,uuid,uuid,jsonb)',
      'read_native_turn_completion(uuid,uuid,uuid,jsonb)', 'native_turn_completion_immutable()'])
    expect(m.completionMembers.filter((member: { application: boolean }) => member.application).map((member: { name: string }) => member.name))
      .toEqual(['record_native_turn_completion', 'read_native_turn_completion'])
    expect(m.completionRendererSql('x', 'y')).toContain(m.predecessorOutcomeSha)
    // No cached decision: the header stores identities only and every reader re-checks the audience.
    expect(m.completionSql).not.toMatch(/set_config\(/)
    expect(m.memberCreate('read_native_turn_completion')).toContain('native_turn_completion_scope(w,s)')
    expect(m.memberCreate('native_turn_completion_scope')).toMatch(/session_personal_audience\(r\) OR session_workspace_audience\(r\)\) AND session_project_audience\(r,false\)/)
    expect(m.outcomeBody).toContain('native_turn_completions')
    const migration = readFileSync(migrations + '8277_durable_turn_completions.sql', 'utf8')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
  })
})
