import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const connectionString = process.env.CONTEXT_SCOPE_TEST_DATABASE_URL
const describeIf = connectionString ? describe : describe.skip
const pool = connectionString ? new pg.Pool({ connectionString }) : null
let client: pg.PoolClient | null = null

describeIf('[COMP:api/context-scope-store] context scope schema integration', () => {
  beforeAll(async () => {
    client = await pool!.connect()
  })

  afterAll(async () => {
    if (client) {
      client.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    await client!.query('BEGIN')
  })

  afterEach(async () => {
    await client!.query('ROLLBACK').catch(() => {})
  })

  it('matches flat Team algebra in SQL and locks session context on first message', async () => {
    const owner = (await client!.query<{ id: string }>(
      `INSERT INTO users (auth_provider, auth_provider_id)
       VALUES ('test', 'context-owner-' || gen_random_uuid()) RETURNING id`,
    )).rows[0].id
    const member = (await client!.query<{ id: string }>(
      `INSERT INTO users (auth_provider, auth_provider_id)
       VALUES ('test', 'context-member-' || gen_random_uuid()) RETURNING id`,
    )).rows[0].id
    const workspace = (await client!.query<{ id: string }>(
      `INSERT INTO workspaces (name, purpose, owner_user_id, is_personal)
       VALUES ('Context test', 'test', $1, false) RETURNING id`,
      [owner],
    )).rows[0].id
    await client!.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, team_scope_mode)
       VALUES ($1, $2, 'owner', 'assigned'), ($1, $3, 'member', 'assigned')`,
      [workspace, owner, member],
    )
    const assistant = (await client!.query<{ id: string }>(
      `INSERT INTO assistants (name, owner_user_id, workspace_id)
       VALUES ('Scoped assistant', $1, $2) RETURNING id`,
      [owner, workspace],
    )).rows[0].id
    const group = (await client!.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0].id
    const compartment = `team:${group}`
    await client!.query(
      `INSERT INTO workspace_groups
         (id, workspace_id, name, created_by, kind, key, compartment_key)
       VALUES ($1, $2, 'Sales', $3, 'team', 'sales', $4)`,
      [group, workspace, owner, compartment],
    )
    await client!.query(
      `INSERT INTO workspace_compartments
         (workspace_id, key, label, created_by, managed_by, managed_ref_id)
       VALUES ($1, $2, 'Sales', $3, 'team', $4)`,
      [workspace, compartment, owner, group],
    )
    await client!.query(
      `INSERT INTO workspace_group_compartment_grants
         (group_id, compartment_key, granted_by_user_id)
       VALUES ($1, $2, $3)`,
      [group, compartment, owner],
    )
    await client!.query(
      'INSERT INTO workspace_group_members (group_id, user_id) VALUES ($1, $2)',
      [group, member],
    )

    const memberGrant = await client!.query<{ grant: string[] | null }>(
      'SELECT effective_member_team_compartments($1, $2) AS grant',
      [member, workspace],
    )
    expect(memberGrant.rows[0].grant).toEqual([compartment])
    await client!.query('UPDATE workspace_groups SET read_all = true WHERE id = $1', [group])
    const wildcardGrant = await client!.query<{ grant: string[] | null }>(
      'SELECT effective_member_team_compartments($1, $2) AS grant',
      [member, workspace],
    )
    expect(wildcardGrant.rows[0].grant).toBeNull()
    await client!.query('UPDATE workspace_groups SET read_all = false WHERE id = $1', [group])
    const ownerGrant = await client!.query<{ grant: string[] | null }>(
      'SELECT effective_member_team_compartments($1, $2) AS grant',
      [owner, workspace],
    )
    expect(ownerGrant.rows[0].grant).toBeNull()

    const session = (await client!.query<{ id: string }>(
      `INSERT INTO sessions
         (assistant_id, user_id, channel_type, channel_id, workspace_id,
          context_group_id, context_compartments)
       VALUES ($1, $2, 'web', 'context-test', $3, $4, ARRAY[$5]::text[])
       RETURNING id`,
      [assistant, member, workspace, group, compartment],
    )).rows[0].id
    await client!.query(
      `INSERT INTO session_messages (session_id, role, content, sequence_num)
       VALUES ($1, 'user', '[]'::jsonb, 1)`,
      [session],
    )
    await expect(
      client!.query(
        'UPDATE sessions SET context_group_id = NULL, context_compartments = ARRAY[]::text[] WHERE id = $1',
        [session],
      ),
    ).rejects.toThrow(/context_locked/)
  })

  it('rejects a Project requirement from another workspace', async () => {
    const owner = (await client!.query<{ id: string }>(
      `INSERT INTO users (auth_provider, auth_provider_id)
       VALUES ('test', 'context-cross-' || gen_random_uuid()) RETURNING id`,
    )).rows[0].id
    const workspaces = await client!.query<{ id: string }>(
      `INSERT INTO workspaces (name, purpose, owner_user_id, is_personal)
       VALUES ('Context A', 'test', $1, false), ('Context B', 'test', $1, false)
       RETURNING id`,
      [owner],
    )
    const [workspaceA, workspaceB] = workspaces.rows.map((row) => row.id)
    await client!.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`,
      [workspaceA, workspaceB, owner],
    )
    const project = (await client!.query<{ id: string }>(
      `INSERT INTO workspace_projects
         (workspace_id, name, normalized_name, created_by)
       VALUES ($1, 'Elsewhere', 'elsewhere', $2) RETURNING id`,
      [workspaceB, owner],
    )).rows[0].id

    await expect(client!.query(
      `INSERT INTO tasks (workspace_id, title, user_id, project_ids)
       VALUES ($1, 'Cross scope', $2, ARRAY[$3]::uuid[])`,
      [workspaceA, owner, project],
    )).rejects.toThrow(/Project requirements must stay within/)
  })

  // 474 shipped inherit_file_cache_context_scope() selecting context_project_ids
  // from sessions — a column that only exists on workflow_runs/scheduled_jobs
  // (sessions carries the singular context_project_id), so every file_cache
  // INSERT threw 42703 at trigger time and chat file uploads failed
  // platform-wide. CREATE FUNCTION never validates a plpgsql body's SQL, so
  // only an executed insert catches this class. 479 repairs the function; this
  // pins the insert path plus the scope inheritance it exists to provide.
  it('inherits a session Project onto file_cache inserts', async () => {
    const owner = (await client!.query<{ id: string }>(
      `INSERT INTO users (auth_provider, auth_provider_id)
       VALUES ('test', 'context-file-' || gen_random_uuid()) RETURNING id`,
    )).rows[0].id
    const workspace = (await client!.query<{ id: string }>(
      `INSERT INTO workspaces (name, purpose, owner_user_id, is_personal)
       VALUES ('Context files', 'test', $1, false) RETURNING id`,
      [owner],
    )).rows[0].id
    await client!.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspace, owner],
    )
    const assistant = (await client!.query<{ id: string }>(
      `INSERT INTO assistants (name, owner_user_id, workspace_id)
       VALUES ('File assistant', $1, $2) RETURNING id`,
      [owner, workspace],
    )).rows[0].id
    const project = (await client!.query<{ id: string }>(
      `INSERT INTO workspace_projects
         (workspace_id, name, normalized_name, created_by)
       VALUES ($1, 'Files', 'files', $2) RETURNING id`,
      [workspace, owner],
    )).rows[0].id

    const cacheInsert = (sessionId: string, name: string) => client!.query<{
      compartments: string[]
      project_ids: string[]
    }>(
      `INSERT INTO file_cache
         (session_id, file_name, mime_type, content, size_bytes, expires_at,
          workspace_id, user_id, assistant_id, sensitivity, compartments, project_ids)
       VALUES ($1, $2, 'text/plain', 'x', 1, now() + interval '7 days',
               $3, $4, $5, 'internal', '{}', '{}')
       RETURNING compartments, project_ids`,
      [sessionId, name, workspace, owner, assistant],
    )

    const unscoped = (await client!.query<{ id: string }>(
      `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, workspace_id)
       VALUES ($1, $2, 'web', 'file-unscoped', $3) RETURNING id`,
      [assistant, owner, workspace],
    )).rows[0].id
    const plain = await cacheInsert(unscoped, 'plain.txt')
    expect(plain.rows[0].compartments).toEqual([])
    expect(plain.rows[0].project_ids).toEqual([])

    const scoped = (await client!.query<{ id: string }>(
      `INSERT INTO sessions
         (assistant_id, user_id, channel_type, channel_id, workspace_id, context_project_id)
       VALUES ($1, $2, 'web', 'file-scoped', $3, $4) RETURNING id`,
      [assistant, owner, workspace, project],
    )).rows[0].id
    const inherited = await cacheInsert(scoped, 'scoped.txt')
    expect(inherited.rows[0].compartments).toEqual([])
    expect(inherited.rows[0].project_ids).toEqual([project])
  })
})
