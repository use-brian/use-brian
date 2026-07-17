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

const { query, queryWithRLS, getPool, getAppPool } = await import('../client.js')

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
  })
})
