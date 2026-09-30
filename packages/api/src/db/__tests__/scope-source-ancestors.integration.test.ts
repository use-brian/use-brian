import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Gated like context-scope-schema.integration.test.ts: point
// CONTEXT_SCOPE_TEST_DATABASE_URL at a migration-replayed database (the local
// rig) and the suite runs; unset, it skips. Every test runs inside one
// BEGIN/ROLLBACK so the fixture never persists.
const connectionString = process.env.CONTEXT_SCOPE_TEST_DATABASE_URL
const describeIf = connectionString ? describe : describe.skip
const pool = connectionString ? new pg.Pool({ connectionString }) : null
let client: pg.PoolClient | null = null

/** Deterministic ids so the chain can be built head-first with plain INSERTs. */
const chainId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * Production carried 700-link repository chains on 2026-09-30. At that depth
 * the 567-588 walk (`to_jsonb(r)->>'superseded_by'`, one full workspace scan per
 * level) ran past the 120 s background statement timeout on every entity
 * update; the column walk (618) finishes in milliseconds. 1,000 links keeps the
 * old body seconds away from the bound (8.5 s / 16.9 s on the local rig), and
 * the new body is two orders of magnitude inside it. The budget is the
 * behavioral check; the function-body assertion at the end of this file is the
 * deterministic guard that fails under the old body on any machine.
 */
const CHAIN_LINKS = 1_000
const WALK_BUDGET_MS = 3_000

describeIf('[COMP:api/workspace-scope-review] scope_source_ancestors walks the supersession column', () => {
  beforeAll(async () => {
    client = await pool!.connect()
  })

  afterAll(async () => {
    if (client) client.release()
    await pool?.end()
  })

  beforeEach(async () => {
    await client!.query('BEGIN')
  })

  afterEach(async () => {
    await client!.query('ROLLBACK').catch(() => {})
  })

  async function seedWorkspace(): Promise<{ workspace: string; owner: string }> {
    const owner = (await client!.query<{ id: string }>(
      `INSERT INTO users (auth_provider, auth_provider_id)
       VALUES ('test', 'chain-owner-' || gen_random_uuid()) RETURNING id`,
    )).rows[0].id
    const workspace = (await client!.query<{ id: string }>(
      `INSERT INTO workspaces (name, purpose, owner_user_id, is_personal)
       VALUES ('Supersession chain test', 'test', $1, false) RETURNING id`,
      [owner],
    )).rows[0].id
    await client!.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, team_scope_mode)
       VALUES ($1, $2, 'owner', 'assigned')`,
      [workspace, owner],
    )
    return { workspace, owner }
  }

  /**
   * Head first (the live row, `superseded_by IS NULL`), then N superseded
   * predecessors each pointing at the row that replaced it - the shape
   * `supersedeEntity` leaves behind. INSERTs do not fire
   * `canonical_scope_version` (BEFORE DELETE OR UPDATE), so the fixture
   * itself never exercises the walk.
   */
  async function seedChain(workspace: string, owner: string, links: number): Promise<string> {
    await client!.query(
      `INSERT INTO entities (id, kind, display_name, workspace_id, created_by_user_id, source, valid_to, superseded_by)
       VALUES ($1, 'repository', 'chain head', $2, $3, 'extracted', NULL, NULL)`,
      [chainId(0), workspace, owner],
    )
    await client!.query(
      `INSERT INTO entities (id, kind, display_name, workspace_id, created_by_user_id, source, valid_to, superseded_by)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
              'repository', 'chain v' || n, $1, $2, 'extracted', now(),
              ('00000000-0000-4000-8000-' || lpad((n - 1)::text, 12, '0'))::uuid
         FROM generate_series(1, $3::int) n`,
      [workspace, owner, links],
    )
    return chainId(0)
  }

  it('resolves every superseded ancestor of a deep chain inside the budget', async () => {
    const { workspace, owner } = await seedWorkspace()
    const head = await seedChain(workspace, owner, CHAIN_LINKS)

    const started = performance.now()
    const walk = await client!.query<{ resource_id: string }>(
      `SELECT resource_id FROM scope_source_ancestors($1, 'entity', $2)`,
      [workspace, head],
    )
    const walkMs = performance.now() - started
    expect(walk.rowCount).toBe(CHAIN_LINKS + 1)
    expect(new Set(walk.rows.map((r) => r.resource_id))).toContain(chainId(CHAIN_LINKS))
    expect(walkMs).toBeLessThan(WALK_BUDGET_MS)
  })

  it('keeps a live-row update (the trigger path) inside the budget', async () => {
    const { workspace, owner } = await seedWorkspace()
    const head = await seedChain(workspace, owner, CHAIN_LINKS)

    // The same statement supersedeEntity issues; advance_canonical_scope_version
    // -> hold_scope_descendants -> scope_source_ancestors runs inside it.
    const started = performance.now()
    const updated = await client!.query(
      `UPDATE entities SET valid_to = now(), superseded_by = $2, updated_at = now()
        WHERE id = $1 AND valid_to IS NULL`,
      [head, chainId(0).replace(/0{12}$/, '999999999999')],
    )
    const updateMs = performance.now() - started
    expect(updated.rowCount).toBe(1)
    expect(updateMs).toBeLessThan(WALK_BUDGET_MS)
  })

  it('returns only the row itself for a source kind without a superseded_by column', async () => {
    const { workspace, owner } = await seedWorkspace()
    const episode = (await client!.query<{ id: string }>(
      `INSERT INTO episodes (source_kind, source_ref, occurred_at, workspace_id, user_id, created_by_user_id)
       VALUES ('test', '{}'::jsonb, now(), $1, $2, $2) RETURNING id`,
      [workspace, owner],
    )).rows[0].id
    const walk = await client!.query<{ resource_id: string }>(
      `SELECT resource_id FROM scope_source_ancestors($1, 'episode', $2)`,
      [workspace, episode],
    )
    expect(walk.rows.map((r) => r.resource_id)).toEqual([episode])
  })

  it('never serializes rows to jsonb to find the parent link', async () => {
    const def = (await client!.query<{ def: string }>(
      `SELECT pg_get_functiondef('scope_source_ancestors(uuid,text,uuid)'::regprocedure) AS def`,
    )).rows[0].def
    expect(def).not.toMatch(/to_jsonb\(r\)/)
    expect(def).toMatch(/r\.superseded_by=a\.id/)
  })
})
