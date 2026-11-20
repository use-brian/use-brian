/** Owned disposable fixture only. No candidate bridge or observed-root enrollment. */
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, rollbackAndRelease } from '../../db/client.js'
import { projectHarnessCandidateBoundarySql, projectHarnessSuccessorFiles } from '../project-harness-candidate-boundary.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { authenticateConversationInstallation } = await import(new URL('../../../scripts/conversation-store/installation-authentication-8328.mjs', import.meta.url).href)
afterAll(async () => { await getPool().end() })
describe.sequential('[COMP:api/harness-migration-upgrade] harness successors against the published develop native contract', () => {
  it('retains all successor receipts and the source-owned 8328 installation proof', async () => {
    const client = await getPool().connect()
    try {
      expect((await client.query('SELECT name FROM _migrations WHERE name=ANY($1::text[]) ORDER BY name', [projectHarnessSuccessorFiles])).rows.map(r => r.name)).toEqual([...projectHarnessSuccessorFiles])
      const receipt = await authenticateConversationInstallation({ getTransactionStatus: () => 'I', query: client.query.bind(client) })
      expect(receipt.witnessCurrent).toBe(true)
      await client.query(projectHarnessCandidateBoundarySql)
      const registry = (await client.query(`SELECT bool_and(to_jsonb(p) IS NOT DISTINCT FROM to_jsonb(h.contract)) exact
        FROM native_turn_contract_helpers h LEFT JOIN pg_proc p ON p.oid=(h.contract).oid`)).rows[0]
      expect(registry.exact).toBe(true)
      expect((await client.query("SELECT to_regclass('public.native_turn_helper_attestations') absent")).rows[0].absent).toBeNull()
    } finally { await rollbackAndRelease(client) }
  })
  it('keeps the chat admission successor private and its insert trigger bound to the same owner', async () => {
    const client = await getPool().connect()
    try {
      const result = await client.query(`SELECT p.oid=t.tgfoid bound,
        p.proowner=c.relowner owner_matches,p.prosecdef,p.proconfig,
        t.tgtype,t.tgenabled,t.tgisinternal,
        (SELECT count(*)=1 AND bool_and(a.grantee=p.proowner AND a.grantor=p.proowner
          AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
          FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) private_acl,
        position('-- D24: an explicitly shared Project room' IN p.prosrc)>0 successor
        FROM pg_proc p JOIN pg_class c ON c.oid='public.sessions'::regclass
        JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname='zzzz_session_creation_admission'
        WHERE p.oid='public.require_session_creation_admission()'::regprocedure`)
      expect(result.rows).toEqual([{ bound: true, owner_matches: true, prosecdef: true,
        proconfig: ['search_path=pg_catalog, public, pg_temp'], tgtype: 7, tgenabled: 'O',
        tgisinternal: false, private_acl: true, successor: true }])
    } finally { await rollbackAndRelease(client) }
  })
  it.each(['8269_project_harnesses.sql','8270_project_harness_verification.sql','8271_project_chat_creation_admission.sql','8272_native_helper_attestation_cost.sql'])('refuses historical candidate receipt %s without erasing it', async name => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO _migrations(name) VALUES($1)', [name])
      await client.query('SAVEPOINT boundary')
      await expect(client.query(projectHarnessCandidateBoundarySql)).rejects.toThrow('project_harness_candidate_upgrade_unsupported')
      await client.query('ROLLBACK TO boundary')
      expect((await client.query('SELECT name FROM _migrations WHERE name=$1', [name])).rows).toEqual([{ name }])
    } finally { await rollbackAndRelease(client) }
  })
  it('refuses historical compiler effects even with no compiler receipt', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TABLE public.native_turn_helper_attestations(signature text)')
      await client.query("INSERT INTO public.native_turn_helper_attestations VALUES('synthetic-preservation-marker')")
      await client.query('SAVEPOINT boundary')
      await expect(client.query(projectHarnessCandidateBoundarySql)).rejects.toThrow('historical compiler effects')
      await client.query('ROLLBACK TO boundary')
      expect((await client.query('SELECT signature FROM native_turn_helper_attestations')).rows).toEqual([{ signature: 'synthetic-preservation-marker' }])
    } finally { await rollbackAndRelease(client) }
  })
})
