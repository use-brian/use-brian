import { describe, it, expect, afterAll } from 'vitest'

/**
 * Integration test for the two-role RLS model (migration 269), via the actual
 * `query()` / `queryWithRLS()` client functions.
 *
 * - `query()` runs on the SYSTEM pool (owner role) and bypasses RLS — it sees
 *   every row.
 * - `queryWithRLS(userId, …)` runs on the APP pool (non-owner `app_user` role)
 *   and is confined by the `app.current_user_id` policy — it sees only the acting
 *   user's rows, and `WITH CHECK` rejects writes for another user.
 *
 * This replaces the retired `rls-bypass-contamination` test: the
 * `app.system_bypass=''` pool-poison class no longer exists — enforcement is the
 * role, not a connection GUC.
 *
 * Requires the local `Use Brian` DB (DATABASE_URL) AND the `app_user` role wired
 * via DATABASE_URL_APP. Skips silently when either is missing (without the app
 * role, `queryWithRLS` falls back to the owner and isolation is meaningless).
 *
 * Spec: docs/architecture/platform/database-schema.md → "RLS bypass + connection
 * state" / "Two-role rollout". Component-map tag: [COMP:api/db-client].
 */

// Force a single backend per pool so assertions are deterministic.
process.env.PG_POOL_MAX = '1'

const { query, queryWithRLS, getPool, getAppPool, runWithAgentAccess } = await import('../client.js')

const UID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const UID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

async function preconditionsMet(): Promise<boolean> {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL_APP) return false
  try {
    // app pool must connect as a NON-owner role (else the fallback-to-owner
    // path is active and there is nothing to test).
    const r = await queryWithRLS<{ u: string }>(UID_A, 'SELECT current_user AS u')
    const owner = await query<{ u: string }>('SELECT current_user AS u')
    return r.rows[0]?.u !== owner.rows[0]?.u
  } catch {
    return false
  }
}

const ok = await preconditionsMet()
const describeIf = ok ? describe : describe.skip
if (!ok) {
  console.log(
    '[two-role-rls integration] skipped — needs DATABASE_URL + DATABASE_URL_APP (a distinct app_user role).',
  )
}

afterAll(async () => {
  try {
    await query('DROP TABLE IF EXISTS _tworole_probe')
  } catch {
    /* nothing to clean up */
  }
  try {
    await getPool().end()
    await getAppPool().end()
  } catch {
    /* pools already closed */
  }
})

describe('[COMP:api/db-client] Two-role RLS isolation', () => {
  describeIf('query() (owner) bypasses RLS; queryWithRLS() (app_user) is confined', () => {
    it('isolates reads by acting user and rejects cross-user writes', async () => {
      // Setup via the owner pool. A throwaway table with ENABLE (not FORCE) RLS
      // and a current_user_id policy. app_user is granted DML explicitly.
      await query('DROP TABLE IF EXISTS _tworole_probe')
      await query(
        'CREATE TABLE _tworole_probe (id int primary key, owner_uid uuid, body text)',
      )
      await query('ALTER TABLE _tworole_probe ENABLE ROW LEVEL SECURITY')
      await query(
        "CREATE POLICY p_own ON _tworole_probe USING (owner_uid = current_setting('app.current_user_id', true)::uuid)",
      )
      await query('GRANT SELECT, INSERT ON _tworole_probe TO app_user')
      await query(
        `INSERT INTO _tworole_probe VALUES (1, '${UID_A}', 'a-row'), (2, '${UID_B}', 'b-row')`,
      )

      // Owner (system pool) sees BOTH rows.
      const ownerView = await query<{ n: string }>('SELECT count(*) AS n FROM _tworole_probe')
      expect(Number(ownerView.rows[0].n)).toBe(2)

      // app_user scoped to A sees ONLY A's row.
      const aView = await queryWithRLS<{ body: string }>(
        UID_A,
        'SELECT body FROM _tworole_probe',
      )
      expect(aView.rows.map((r) => r.body)).toEqual(['a-row'])

      // app_user scoped to B sees ONLY B's row (proves it actually filters).
      const bView = await queryWithRLS<{ body: string }>(
        UID_B,
        'SELECT body FROM _tworole_probe',
      )
      expect(bView.rows.map((r) => r.body)).toEqual(['b-row'])

      // WITH CHECK: app_user acting as A cannot INSERT a row owned by B.
      await expect(
        queryWithRLS(
          UID_A,
          `INSERT INTO _tworole_probe VALUES (3, '${UID_B}', 'a-forging-b')`,
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    it('reverts agent JSON GUCs to valid defaults before the next human transaction', async () => {
      const insideAgent = await runWithAgentAccess(
        {
          clearance: 'internal',
          compartments: ['team:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
          projectIds: ['cccccccc-cccc-cccc-cccc-cccccccccccc'],
        },
        () => queryWithRLS<{
          compartments: string
          project_ids: string
        }>(
          UID_A,
          `SELECT
             current_setting('app.agent_compartments', true) AS compartments,
             current_setting('app.agent_project_ids', true) AS project_ids`,
        ),
      )
      expect(insideAgent.rows[0]).toEqual({
        compartments: '["team:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]',
        project_ids: '["cccccccc-cccc-cccc-cccc-cccccccccccc"]',
      })

      // PG_POOL_MAX=1 guarantees this is the same backend connection. The
      // agent transaction's SET LOCAL values must have reverted to type-valid
      // session defaults before an unrelated human request evaluates RLS.
      const human = await queryWithRLS<{
        compartments: string
        project_ids: string
        visible_pages: string
      }>(
        UID_A,
        `SELECT
           current_setting('app.agent_compartments', true) AS compartments,
           current_setting('app.agent_project_ids', true) AS project_ids,
           (SELECT count(*) FROM saved_views)::text AS visible_pages`,
      )
      expect(human.rows[0]).toMatchObject({
        compartments: '[]',
        project_ids: 'null',
      })
    })

    it('normalizes a legacy empty JSON GUC at the saved-views policy cast site', async () => {
      const fixtureUser = await query<{ id: string }>(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES (gen_random_uuid(), 'test', 'two-role-guc-' || gen_random_uuid())
         RETURNING id`,
      )
      const fixtureUserId = fixtureUser.rows[0].id
      const fixtureWorkspace = await query<{ id: string }>(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES (gen_random_uuid(), 'two-role-guc-test', 'test', $1, false)
         RETURNING id`,
        [fixtureUserId],
      )
      const fixtureWorkspaceId = fixtureWorkspace.rows[0].id

      try {
        await query(
          `INSERT INTO workspace_members (id, workspace_id, user_id, role)
           VALUES (gen_random_uuid(), $1, $2, 'owner')`,
          [fixtureWorkspaceId, fixtureUserId],
        )
        const fixtureProject = await query<{ id: string }>(
          `INSERT INTO workspace_projects
             (id, workspace_id, name, normalized_name, created_by)
           VALUES (gen_random_uuid(), $1, 'GUC test Project', 'guc test project', $2)
           RETURNING id`,
          [fixtureWorkspaceId, fixtureUserId],
        )
        await query(
          `INSERT INTO saved_views
             (id, workspace_id, created_by, name, entity, view_type, project_id)
           VALUES (gen_random_uuid(), $1, $2, 'GUC test page', 'tasks', 'table', $3)`,
          [fixtureWorkspaceId, fixtureUserId, fixtureProject.rows[0].id],
        )

        const poison = await getAppPool().connect()
        try {
          await poison.query(
            `SELECT
               set_config('app.agent_clearance', 'internal', false),
               set_config('app.agent_compartments', '', false),
               set_config('app.agent_project_ids', '', false)`,
          )
        } finally {
          poison.release()
        }

        // The non-null Project row forces the saved_views policy through the
        // agent-project branch that used to cast the poisoned empty string.
        await expect(
          queryWithRLS(fixtureUserId, 'SELECT count(*) FROM saved_views'),
        ).resolves.toBeDefined()

        // The shared predicate consumed both agent JSON GUCs with the same
        // unsafe guard/cast shape before migration 490.
        await expect(
          queryWithRLS(
            fixtureUserId,
            `SELECT context_scope_allows_current_principal(
               $1::uuid, 'internal', '{}'::text[], '{}'::uuid[]
             )`,
            [fixtureWorkspaceId],
          ),
        ).resolves.toBeDefined()
      } finally {
        // Restore the single pooled backend and remove the owner-created row
        // even if an assertion fails, so no later test inherits either state.
        const restore = await getAppPool().connect()
        try {
          await restore.query(
            `SELECT
               set_config('app.agent_clearance', '', false),
               set_config('app.agent_compartments', '[]', false),
               set_config('app.agent_project_ids', 'null', false)`,
          )
        } finally {
          restore.release()
        }
        await query('DELETE FROM workspaces WHERE id = $1', [fixtureWorkspaceId])
        await query('DELETE FROM users WHERE id = $1', [fixtureUserId])
      }
    })
  })
})
