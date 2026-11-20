/** [COMP:api/migration-owner-role] Executed bypass retirement through the deployment roles. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { readAdmissionPolicy } from '../../workspace-access/admission-policy-read.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
afterAll(async () => { await Promise.all([ownerPool.end(), appPool.end()]) })

const connectorRelations = [
  'connector_pending_setups', 'connector_rotation_attempts', 'connector_setup_auth_material',
  'connector_setup_identity', 'connector_setup_rotation_receipts', 'connector_setup_staged_credentials',
]
const forcedRelations = [
  ...connectorRelations, 'session_archives', 'structured_document_fill_proposals',
  'workspace_mcp_contexts', 'workspace_mcp_operations', 'workspace_mcp_runs',
]

describe('[COMP:api/migration-owner-role] Legacy connection setting retirement', () => {
  it('removes all executable references, leaves FORCE enabled and admits the deployment owner on forced connector tables', async () => {
    expect((await ownerPool.query(`SELECT session_user=current_user AS "directOwner",
      NOT r.rolsuper AND NOT r.rolbypassrls AS ordinary,r.oid=c.relowner AS owns
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.workspaces'::regclass`)).rows)
      .toEqual([{ directOwner: true, ordinary: true, owns: true }])
    expect((await ownerPool.query(`SELECT count(*)::int AS n FROM pg_policy
      WHERE strpos(concat(pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)),$1)>0`, ['app.system_bypass'])).rows[0].n).toBe(0)
    expect((await ownerPool.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_' AND strpos(p.prosrc,$1)>0`, ['app.system_bypass'])).rows[0].n).toBe(0)
    expect((await ownerPool.query('SELECT relname FROM pg_class WHERE relforcerowsecurity ORDER BY relname')).rows.map(row => row.relname)).toEqual(forcedRelations)
    const connector = (await ownerPool.query(`SELECT c.relname, p.polroles=ARRAY[c.relowner] AS "ownerOnly",
        NOT pg_has_role('app_user', c.relowner, 'MEMBER') AS "roleSeparate"
      FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid
      WHERE c.relname=ANY($1) AND p.polpermissive AND p.polcmd='*'
        AND pg_get_expr(p.polqual,c.oid)='true' AND pg_get_expr(p.polwithcheck,c.oid)='true' ORDER BY c.relname`, [connectorRelations])).rows
    expect(connector).toEqual(connectorRelations.map(relname => ({ relname, ownerOnly: true, roleSeparate: true })))
    expect((await ownerPool.query(`SELECT public.native_turn_helpers_current() AS "native",public.native_turn_publication_contract() AS publication,
      public.native_retained_helpers_current() AS retained`)).rows).toEqual([{ native: true, publication: true, retained: true }])
  })

  it('serves canonical admission facts to current members while preserving forced connector actor checks', async () => {
    const actor = randomUUID(), outside = randomUUID(), workspace = randomUUID(), setup = randomUUID()
    const owner = await ownerPool.connect(), app = await appPool.connect()
    try {
      await owner.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,$3),($2::uuid,$2::text,$3)',
        [actor, outside, 'Fictional bypass fixture'])
      await owner.query('INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,$2,$3)', [workspace, 'Fictional bypass workspace', actor])
      await owner.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`, [workspace, actor])
      await owner.query(`INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [workspace])
      const expected = await readAdmissionPolicy(owner, workspace)
      expect(expected).toMatchObject({ workspaceId: workspace })
      await owner.query(`INSERT INTO connector_pending_setups(id,actor_user_id,workspace_id,policy_revision,provider,intent,expires_at)
        VALUES($1,$2,$3,1,'fixture','{}',now()+interval '1 hour')`, [setup, actor, workspace])
      expect((await owner.query('SELECT id FROM connector_pending_setups WHERE id=$1',[setup])).rows).toEqual([{ id: setup }])
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','true',true)", [actor])
      expect(await readAdmissionPolicy(app, workspace)).toEqual(expected)
      expect((await app.query("UPDATE connector_pending_setups SET status='cancelled' WHERE id=$1", [setup])).rowCount).toBe(0)
      await app.query("SELECT set_config('app.current_user_id',$1,true)", [outside])
      expect(await readAdmissionPolicy(app, workspace)).toBeUndefined()
      expect((await app.query('SELECT id FROM connector_pending_setups WHERE id=$1', [setup])).rowCount).toBe(0)
      await app.query('ROLLBACK')
      expect((await owner.query("UPDATE connector_pending_setups SET status='cancelled' WHERE id=$1 RETURNING id",[setup])).rows).toEqual([{ id: setup }])
    } finally {
      await app.query('ROLLBACK')
      await owner.query('DELETE FROM workspaces WHERE id=$1', [workspace])
      await owner.query('DELETE FROM users WHERE id=ANY($1)', [[actor,outside]])
      app.release(); owner.release()
    }
  })
})
