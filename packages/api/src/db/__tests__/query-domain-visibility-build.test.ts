/** Query-domain visibility successor (8280) source: reproducible migration, frozen
 * 8278 authenticator, the read-only successor recipe and the exact one-clause body change.
 * [COMP:api/native-turn-frame] */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const file = (path: string) => sha(readFileSync(path))

describe('[COMP:api/native-turn-frame] query-domain visibility successor source', () => {
  it('reproduces 8280 from its pinned predecessors and keeps 8278 reproducible', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-query-domain-visibility.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(() => execFileSync(process.execPath, [directory + 'build-page-closure.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('freezes the 8278 recipe byte for byte and keeps the 8280 recipe at 316 functions', async () => {
    expect(file(directory + 'installation-authentication-8278.mjs')).toBe('266a934c8e5cad3f86a0fb3c9a01a141abc2e1c731a60147964e6f7f42074d15')
    // The 8280 recipe is frozen as installation-authentication-8280.mjs since 8281.
    const head = await import(directory + 'installation-authentication-8280.mjs')
    expect(head.currentFunctionCount).toBe(316)
    const source = await head.currentInstallationAuthenticationSource()
    expect(source.sourceDigest).toBe(file(migrations + '8280_query_domain_visibility.sql'))
    expect(() => head.assertAuthenticationReadOnly(source.sql)).not.toThrow()
    expect(source.sql).not.toMatch(/a8278_/)
    expect(source.sql).toContain('installation_query_domain_changed')
    expect(source.sql).toContain('installation_page_closure_member_changed')
  })
  it('changes only the frozen-visibility clause of the exact 8269 body', async () => {
    const m = await import(directory + 'query-domain-visibility.mjs')
    const graph = readFileSync(directory + 'graph.sql', 'utf8')
    const start = graph.indexOf('AS $function$', graph.indexOf('CREATE OR REPLACE FUNCTION public.conversation_dag_domain(')) + 'AS $function$'.length
    const predecessor = graph.slice(start, graph.indexOf('$function$', start))
    expect(sha(predecessor)).toBe(m.predecessorDomainSha)
    const clause = (body: string) => body.slice(body.indexOf(" IF frozen.domain#>>'{visibility,userId}'"), body.indexOf(' result:=conversation_dag_scan('))
    const strip = (body: string) => body.replace(clause(body), '').replace(/ -- [^\n]*\n/g, '')
    expect(strip(m.domainBody)).toBe(strip(predecessor))
    // Containment still admits directly; otherwise every frozen point must be
    // unscoped or visible to the current reader, before the unchanged rescan.
    expect(clause(m.domainBody)).toContain("point#>>'{source,assistantId}' IS NOT NULL")
    expect(clause(m.domainBody)).toContain("visibility->'assistants' ? (point#>>'{source,assistantId}')")
    expect(m.domainBody).toContain("scanned->'points' IS DISTINCT FROM frozen.domain->'points'")
    expect(m.domainBody).not.toMatch(/set_config\(|INSERT INTO|UPDATE |DELETE FROM/)
    const migration = readFileSync(migrations + '8280_query_domain_visibility.sql', 'utf8')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('public.native_turn_contract_witness_refresh() IS NOT TRUE')
    expect(migration.indexOf('query_domain_predecessor_changed')).toBeLessThan(migration.indexOf('$query_domain_propagate$'))
  })
})
