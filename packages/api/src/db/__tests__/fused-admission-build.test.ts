/** Fused admission owner (8289) source: reproducible migration, frozen 8287
 * authenticator, the read-only successor recipe and the compiled-path contract.
 * [COMP:api/fused-admission] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/fused-admission] fused admission owner source', () => {
  it('reproduces 8289 from its pinned predecessors', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-fused-admission.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8287 recipe byte for byte and adds 76 functions to its 316', async () => {
    expect(sha(directory + 'installation-authentication-8287.mjs')).toBe('5f785dce4017e846fce886807a2253189fd825ac730067395adb7fa265570a32')
    const frozen = await import(directory + 'installation-authentication-8287.mjs')
    expect(frozen.currentFunctionCount).toBe(316)
    // After 8290 the 8289 recipe is frozen beside its successor.
    const head = await import(directory + 'installation-authentication-8289.mjs').catch(() => import(directory + 'installation-authentication.mjs'))
    expect(head.currentFunctionCount).toBe(392)
    const source = await head.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(sha(migrations + '8289_fused_admission.sql'))
    expect(() => head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    for (const check of ['installation_fused_admission_member_changed', 'installation_fused_admission_generic_changed',
      'installation_fused_admission_capture_changed', 'installation_fused_admission_canonical_changed', 'installation_fused_admission_type_changed'])
      expect(source.sql).toContain(check)
  })
  it('keeps the compiled path only: no derived fallback, no test switch, no stored requirement', async () => {
    const m = await import(directory + 'fused-admission.mjs')
    const sql: string = m.fusedSql
    expect(m.fusedMemberSignatures).toHaveLength(75)
    expect(m.fusedSignatures).toContain('capture_conversation_evidence_generic(uuid,jsonb,jsonb,jsonb)')
    expect(sql).not.toMatch(/fa\.strict|current_setting\('fa\.|_release_requirements|_shadow_|closure_current|INSERT INTO|UPDATE |DELETE FROM|set_config\(/)
    // The two routes of the prototype owner become the sentinel the wrapper answers with the generic owner.
    expect(sql.split(`RETURN '{"fusedRoute":"generic"}'::jsonb;`)).toHaveLength(3)
    expect(sql).not.toContain('capture_conversation_evidence(')
    // The guard fingerprint is the wrapper's: the owner and the fence take it as a parameter.
    expect(sql).toContain('IS NOT DISTINCT FROM guard_pin pin_ok) fa_c')
    expect(sql).toContain('CREATE FUNCTION fused_f_fence(guard_pin text) RETURNS void')
    // The 8280 frozen-visibility rule of conversation_dag_domain is in the compiled domain leaf.
    expect(sql).toContain("point#>>'{source,assistantId}' IS NOT NULL")
    // The prefetch type holds jsonb, never table row types.
    expect(sql).toMatch(/CREATE TYPE fused_node_pre AS \(resource jsonb, observation jsonb, review_held boolean,\n obs_sources jsonb, domain_resource jsonb, message_exists boolean,\n derivations jsonb, deriv_entities jsonb, fields text\[\]\);/)
  })
  it('routes every shape the compiled path does not complete to the generic owner, and nothing else', async () => {
    const m = await import(directory + 'fused-admission.mjs')
    const body: string = m.wrapperBody
    expect(body).toContain("result:=fused_f_capture(w,roots,authority,cohorts,'__CAPTURE_GUARD_FINGERPRINT__');")
    expect(body).toContain('RETURN capture_conversation_evidence_generic(w,roots,authority,cohorts);')
    // Availability failures propagate; they never select another evaluator.
    expect(body).toMatch(/EXCEPTION WHEN transaction_rollback OR insufficient_resources OR program_limit_exceeded OR object_not_in_prerequisite_state\n  OR operator_intervention OR system_error OR internal_error THEN RAISE;/)
    const migration = readFileSync(migrations + '8289_fused_admission.sql', 'utf8')
    // Original pin consumers are classified before the generic owner exists; the witness is refreshed last.
    expect(migration.indexOf('$fused_admission_original_consumers$')).toBeLessThan(migration.indexOf('DO $fused_generic$'))
    expect(migration.indexOf('DO $fused_generic$')).toBeLessThan(migration.indexOf('DO $fused_admission_propagate$'))
    expect(migration.lastIndexOf('public.native_turn_contract_witness_refresh() IS NOT TRUE')).toBeGreaterThan(migration.indexOf('DO $fused_admission_propagate$'))
  })
})
