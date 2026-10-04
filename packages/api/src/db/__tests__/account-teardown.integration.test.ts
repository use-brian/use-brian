import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNT_TEARDOWN_RULES, DELETED_USER_NAME, deleteAccountFootprint } from '../account-teardown.js'

// Real-schema proof for the account teardown (needs migrations through 659).
// A mocked client cannot see foreign-key trigger ordering, row-level
// security, or the evidence guards, which are what this code must get right.
//
// Production runs the teardown as a NON-superuser table owner, so FORCE RLS
// tables bind it and SECURITY DEFINER functions run without superuser. A
// local superuser would hide both, so when the connection is a superuser each
// test hands every public table and function to a NOSUPERUSER NOBYPASSRLS
// role inside its own transaction and runs as that role (all rolled back).
// The ownership swap locks every table for the test's duration, so a busy
// database (a live local stack) can deadlock it; run against an idle one.
const connectionString = process.env.DATABASE_URL
const pool = connectionString ? new pg.Pool({ connectionString }) : null
let client: pg.PoolClient | null = null
let reachable = false
let superuser = false

beforeAll(async () => {
  try {
    client = await pool!.connect()
    await client.query(`SELECT 'account_erasure_allows'::regproc`)
    superuser = (await client.query<{ s: boolean }>(`SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`)).rows[0].s
    reachable = true
  } catch {
    reachable = false
  }
})

afterAll(async () => {
  client?.release()
  await pool?.end()
})

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  client!.query<T>(sql, values)
const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => (await q<T>(sql, values)).rows[0]
const count = async (sql: string, values: unknown[]) => Number((await one<{ n: string }>(sql, values)).n)

async function runAsOrdinaryOwner() {
  if (!superuser) return
  // The swap locks every table; a live stack sharing the database can
  // deadlock it, which only aborts the savepoint, so try again.
  for (let attempt = 1; ; attempt++) {
    await q('SAVEPOINT ordinary_owner')
    try {
      await swapToOrdinaryOwner()
      await q('RELEASE SAVEPOINT ordinary_owner')
      break
    } catch (err) {
      await q('ROLLBACK TO SAVEPOINT ordinary_owner')
      if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err
    }
  }
  await q(`SET LOCAL ROLE account_teardown_owner`)
}

async function swapToOrdinaryOwner() {
  await q(`CREATE ROLE account_teardown_owner NOSUPERUSER NOBYPASSRLS`)
  await q(`GRANT ALL ON SCHEMA public TO account_teardown_owner`)
  await q(`DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO account_teardown_owner', r.rel);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prokind = 'f'
                  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO account_teardown_owner', r.fn);
      END LOOP;
    END $$`)
}

async function newUser(label: string) {
  return (await one<{ id: string }>(
    `INSERT INTO users (auth_provider, auth_provider_id, email, name)
     VALUES ('test', $1 || '-' || gen_random_uuid(), $1 || '-' || gen_random_uuid() || '@example.com', $1) RETURNING id`,
    [label],
  )).id
}

async function newWorkspace(owner: string, personal: boolean, members: string[] = []) {
  const id = (await one<{ id: string }>(
    `INSERT INTO workspaces (name, owner_user_id, is_personal) VALUES ('WS', $1, $2) RETURNING id`,
    [owner, personal],
  )).id
  await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, owner])
  for (const m of members) {
    await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [id, m])
  }
  return id
}

async function newAssistant(ws: string, owner: string | null) {
  return (await one<{ id: string }>(
    `INSERT INTO assistants (name, workspace_id, owner_user_id, kind) VALUES ('A', $1, $2, 'standard') RETURNING id`,
    [ws, owner],
  )).id
}

describe('[COMP:api/account-teardown] account teardown against a real schema', () => {
  beforeEach(async (ctx) => {
    if (!reachable) ctx.skip()
    await q('BEGIN')
    await runAsOrdinaryOwner()
  })

  afterEach(async () => {
    if (reachable) await q('ROLLBACK').catch(() => {})
  })

  it('has a rule for every foreign key to users without an ON DELETE action', async () => {
    const { rows } = await q<{ col: string }>(
      `SELECT regexp_replace(c.conrelid::regclass::text, '^public\\.', '') || '.' || a.attname AS col
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND c.confdeltype IN ('a', 'r')`,
    )
    expect(rows.map((r) => r.col).filter((c) => !ACCOUNT_TEARDOWN_RULES[c])).toEqual([])
  })

  it('fully deletes a solo user whose Personal workspace holds views, episodes, files, segments, and recordings', async () => {
    const user = await newUser('solo')
    const ws = await newWorkspace(user, true)
    const assistant = await newAssistant(ws, user)
    await q(`INSERT INTO assistant_members (assistant_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [assistant, user])
    await q(`INSERT INTO saved_views (workspace_id, created_by, name, entity, view_type) VALUES ($1, $2, 'Tasks', 'tasks', 'table')`, [ws, user])
    const episode = (await one<{ id: string }>(
      `INSERT INTO episodes (source_kind, source_ref, occurred_at, workspace_id, created_by_user_id, user_id, assistant_id)
       VALUES ('file_upload', '{}', now(), $1, $2, $2, $3) RETURNING id`,
      [ws, user, assistant],
    )).id
    // Grandchildren whose workspace_id FK is NO ACTION and that cascade only
    // through another table.
    await q(`INSERT INTO recordings (id, workspace_id, mime, gcs_key, created_by_user_id) VALUES ($1, $2, 'audio/webm', 'k', $3)`, [episode, ws, user])
    const file = (await one<{ id: string }>(
      `INSERT INTO workspace_files (workspace_id, path, name, storage_uri, user_id) VALUES ($1, '/a.txt', 'a.txt', 'mem://a', $2) RETURNING id`,
      [ws, user],
    )).id
    await q(
      `INSERT INTO file_segments (workspace_id, file_id, segment_index, char_start, char_end, content, created_by_user_id)
       VALUES ($1, $2, 0, 0, 5, 'hello', $3)`,
      [ws, file, user],
    )

    const removed = await deleteAccountFootprint(client!, user)

    expect(removed).toMatchObject({ mode: 'deleted', workspacesDeleted: 1 })
    expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [user])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM workspaces WHERE id = $1`, [ws])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM account_erasures`, [])).toBe(0)
  })

  it("moves a member's footprint in someone else's workspace to its owner and tombstones the account", async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    await newWorkspace(member, true)
    const shared = await newWorkspace(owner, false, [member])
    const teamspace = (await one<{ id: string }>(`INSERT INTO teamspaces (workspace_id, name) VALUES ($1, 'Team') RETURNING id`, [shared])).id

    // Pages: no teamspace = private to its creator (deleted); a teamspace page moves to the owner.
    const privatePage = (await one<{ id: string }>(
      `INSERT INTO saved_views (workspace_id, created_by, name, entity, view_type) VALUES ($1, $2, 'Mine', 'tasks', 'table') RETURNING id`,
      [shared, member],
    )).id
    const teamPage = (await one<{ id: string }>(
      `INSERT INTO saved_views (workspace_id, created_by, name, entity, view_type, teamspace_id)
       VALUES ($1, $2, 'Pipeline', 'tasks', 'table', $3) RETURNING id`,
      [shared, member, teamspace],
    )).id

    // Brain rows: a private episode, a private entity, and a shared entity
    // derived from the private episode and verified by the member.
    const privateEpisode = (await one<{ id: string }>(
      `INSERT INTO episodes (source_kind, source_ref, occurred_at, workspace_id, created_by_user_id, user_id)
       VALUES ('file_upload', '{}', now(), $1, $2, $2) RETURNING id`,
      [shared, member],
    )).id
    const sharedEntity = (await one<{ id: string }>(
      `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, source, verified_by_user_id, source_episode_id)
       VALUES ('company', 'Example Co', $1, $2, 'manual', $2, $3) RETURNING id`,
      [shared, member, privateEpisode],
    )).id
    const privateEntity = (await one<{ id: string }>(
      `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, source, user_id)
       VALUES ('person', 'Private Subject', $1, $2, 'manual', $2) RETURNING id`,
      [shared, member],
    )).id

    // A workflow the member authored: it runs as its author.
    const workflow = (await one<{ id: string }>(
      `INSERT INTO workflows (workspace_id, created_by, name, definition, enabled, schedule_authoring_user_id)
       VALUES ($1, $2, 'Daily', '{}'::jsonb, true, $2) RETURNING id`,
      [shared, member],
    )).id

    // A room the member started, with a teammate's message, and a private
    // session of the member's.
    const assistant = await newAssistant(shared, null)
    const room = (await one<{ id: string }>(
      `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, workspace_id, visibility)
       VALUES ($1, $2, 'web', 'room', $3, 'workspace') RETURNING id`,
      [assistant, member, shared],
    )).id
    const ownerMessage = (await one<{ id: string }>(
      `INSERT INTO session_messages (session_id, role, content, sequence_num, sender_user_id)
       VALUES ($1, 'user', '"from the owner"'::jsonb, 1, $2) RETURNING id`,
      [room, owner],
    )).id
    const memberMessage = (await one<{ id: string }>(
      `INSERT INTO session_messages (session_id, role, content, sequence_num, sender_user_id)
       VALUES ($1, 'user', '"from the member"'::jsonb, 2, $2) RETURNING id`,
      [room, member],
    )).id
    const privateSession = (await one<{ id: string }>(
      `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, workspace_id, visibility)
       VALUES ($1, $2, 'web', 'dm', $3, 'owner') RETURNING id`,
      [assistant, member, shared],
    )).id

    // A personal assistant the member owns in the shared workspace, and a
    // shared episode scoped to it: the assistant moves to the owner.
    const memberAssistant = await newAssistant(shared, member)
    await q(`INSERT INTO assistant_members (assistant_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [memberAssistant, member])
    const capturedEpisode = (await one<{ id: string }>(
      `INSERT INTO episodes (source_kind, source_ref, occurred_at, workspace_id, created_by_user_id, assistant_id)
       VALUES ('file_upload', '{}', now(), $1, $2, $3) RETURNING id`,
      [shared, owner, memberAssistant],
    )).id

    // Approvals and an assigned task.
    const pending = (await one<{ id: string }>(
      `INSERT INTO pending_approvals (workspace_id, approver_user_id, status, tool_name) VALUES ($1, $2, 'pending', 'sendEmail') RETURNING id`,
      [shared, member],
    )).id
    const membership = async (user: string) =>
      (await one<{ id: string }>(`SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [shared, user])).id
    const task = (await one<{ id: string }>(
      `INSERT INTO tasks (workspace_id, title, created_by_user_id, assignee_id) VALUES ($1, 'Follow up', $2, $3) RETURNING id`,
      [shared, owner, await membership(member)],
    )).id
    const ownerMembership = await membership(owner)

    const removed = await deleteAccountFootprint(client!, member)

    expect(removed.mode).toBe('tombstoned')
    // The account: scrubbed, unusable, still there for the history that names it.
    expect(await one(
      `SELECT email, name, auth_provider, deleted_at IS NOT NULL AS deleted FROM users WHERE id = $1`,
      [member],
    )).toEqual({ email: null, name: DELETED_USER_NAME, auth_provider: 'deleted', deleted: true })
    expect(await count(`SELECT count(*) AS n FROM workspace_members WHERE user_id = $1`, [member])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM workspaces WHERE id = $1`, [shared])).toBe(1)

    // Private rows are gone; shared ones moved; recorded actors kept.
    expect(await count(`SELECT count(*) AS n FROM saved_views WHERE id = $1`, [privatePage])).toBe(0)
    expect(await one(`SELECT created_by FROM saved_views WHERE id = $1`, [teamPage])).toEqual({ created_by: owner })
    expect(await count(`SELECT count(*) AS n FROM episodes WHERE id = $1`, [privateEpisode])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM entities WHERE id = $1`, [privateEntity])).toBe(0)
    expect(await one(
      `SELECT created_by_user_id, verified_by_user_id, source_episode_id FROM entities WHERE id = $1`,
      [sharedEntity],
    )).toEqual({ created_by_user_id: owner, verified_by_user_id: member, source_episode_id: null })

    // The workflow moved and paused; its run-as identity is the deleted user.
    expect(await one(
      `SELECT created_by, schedule_authoring_user_id, enabled FROM workflows WHERE id = $1`,
      [workflow],
    )).toEqual({ created_by: owner, schedule_authoring_user_id: member, enabled: false })

    // The room and both messages stay; the private session is gone.
    expect(await one(`SELECT user_id FROM sessions WHERE id = $1`, [room])).toEqual({ user_id: owner })
    expect(await count(`SELECT count(*) AS n FROM session_messages WHERE id = ANY($1::uuid[])`, [[ownerMessage, memberMessage]])).toBe(2)
    expect(await count(`SELECT count(*) AS n FROM sessions WHERE id = $1`, [privateSession])).toBe(0)

    expect(await one(`SELECT status, approver_user_id FROM pending_approvals WHERE id = $1`, [pending]))
      .toEqual({ status: 'expired', approver_user_id: member })
    expect(await one(`SELECT assignee_id FROM tasks WHERE id = $1`, [task])).toEqual({ assignee_id: ownerMembership })
    expect(await one(`SELECT owner_user_id FROM assistants WHERE id = $1`, [memberAssistant])).toEqual({ owner_user_id: owner })
    expect(await count(`SELECT count(*) AS n FROM assistant_members WHERE assistant_id = $1 AND user_id = $2`, [memberAssistant, owner])).toBe(1)
    expect(await one(`SELECT assistant_id FROM episodes WHERE id = $1`, [capturedEpisode])).toEqual({ assistant_id: memberAssistant })
    expect(await count(`SELECT count(*) AS n FROM account_erasures`, [])).toBe(0)
  })

  it.each(['legacy', 'ready'])('revokes the credentials a leaving member created and keeps a session a brain key was configured in (%s workspace)', async (setupState) => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const shared = await newWorkspace(owner, false, [member])
    const assistant = await newAssistant(shared, null)
    const { email, provider_id } = await one<{ email: string; provider_id: string }>(
      `SELECT email, auth_provider_id AS provider_id FROM users WHERE id = $1`, [member],
    )
    // A team brain key records the auth session it was configured in.
    const session = (await one<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, auth_version, device_label, expires_at)
       VALUES ($1, 0, 'laptop', now() + interval '1 day') RETURNING id`,
      [member],
    )).id
    const brainKey = (await one<{ id: string }>(
      `INSERT INTO brain_keys (workspace_id, created_by, key_hash, key_prefix, name, configuration_session_id)
       VALUES ($1, $2, 'hash-brain', 'bk_', 'Team key', $3) RETURNING id`,
      [shared, member, session],
    )).id
    const apiKey = (await one<{ id: string }>(
      `INSERT INTO api_keys (assistant_id, created_by, key_hash, key_prefix, name)
       VALUES ($1, $2, 'hash-api', 'ak_', 'Integration') RETURNING id`,
      [assistant, member],
    )).id
    // A v2 workspace arms the external-key guards against rebinding.
    await q(`UPDATE workspace_access_policies SET setup_state = $2 WHERE workspace_id = $1`, [shared, setupState])

    const removed = await deleteAccountFootprint(client!, member)

    expect(removed.mode).toBe('tombstoned')
    expect(await one(`SELECT status FROM brain_keys WHERE id = $1`, [brainKey])).toEqual({ status: 'revoked' })
    expect(await one(`SELECT status FROM api_keys WHERE id = $1`, [apiKey])).toEqual({ status: 'revoked' })
    expect(await one(`SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = $1`, [session]))
      .toEqual({ revoked: true })
    // Nothing that signs in can find the account any more.
    expect(await count(`SELECT count(*) AS n FROM users WHERE email = $1`, [email])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM users WHERE auth_provider = 'test' AND auth_provider_id = $1`, [provider_id])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [member])).toBe(0)
  })

  async function soleOwnedDepartment(owner: string, member: string, shared: string) {
    const department = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id
    await q(
      `INSERT INTO workspace_groups (id, workspace_id, name, created_by, kind, key, compartment_key)
       VALUES ($1::uuid, $2, 'Sales', $3, 'team', $1::uuid::text, 'team:' || $1::uuid::text)`,
      [department, shared, owner],
    )
    await q(`INSERT INTO department_owners (workspace_id, department_id, user_id, added_by) VALUES ($1, $2, $3, $4)`,
      [shared, department, member, owner])
    // Creating a department makes its creator an owner with a seeded edge;
    // leave the member as the one owner and the only edge.
    await q(`DELETE FROM department_owners WHERE department_id = $1 AND user_id <> $2`, [department, member])
    await q(`DELETE FROM department_edges WHERE department_id = $1 AND user_id <> $2`, [department, member])
    return department
  }
  const revision = async (department: string) =>
    Number((await one<{ r: string }>(`SELECT revision AS r FROM department_revisions WHERE department_id = $1`, [department])).r)
  const audit = async (department: string) =>
    (await q<{ action: string; principal_id: string }>(
      `SELECT action, principal_id FROM department_audit_events WHERE department_id = $1 ORDER BY created_at, action`,
      [department],
    )).rows

  it('hands a sole-owned department to an existing confidential member, with an audit trail', async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const colleague = await newUser('colleague')
    const shared = await newWorkspace(owner, false, [member, colleague])
    const department = await soleOwnedDepartment(owner, member, shared)
    await q(
      `INSERT INTO department_edges (workspace_id, department_id, principal_kind, user_id, clearance, origin)
       VALUES ($1, $2, 'user', $3, 'confidential', 'member')`,
      [shared, department, colleague],
    )
    const before = await revision(department)

    await deleteAccountFootprint(client!, member)

    expect((await q(`SELECT user_id FROM department_owners WHERE department_id = $1`, [department])).rows)
      .toEqual([{ user_id: colleague }])
    expect(await count(`SELECT count(*) AS n FROM department_edges WHERE department_id = $1 AND user_id = $2`, [department, member])).toBe(0)
    // The workspace owner gained nothing.
    expect(await count(`SELECT count(*) AS n FROM department_edges WHERE department_id = $1 AND user_id = $2`, [department, owner])).toBe(0)
    expect(await audit(department)).toEqual(expect.arrayContaining([
      { action: 'owner_added', principal_id: colleague },
      { action: 'owner_removed', principal_id: member },
    ]))
    expect(await revision(department)).toBeGreaterThan(before)
  })

  it('falls back to the workspace owner, audited, when no confidential member remains', async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const shared = await newWorkspace(owner, false, [member])
    const department = await soleOwnedDepartment(owner, member, shared)

    await deleteAccountFootprint(client!, member)

    expect((await q(`SELECT user_id FROM department_owners WHERE department_id = $1`, [department])).rows)
      .toEqual([{ user_id: owner }])
    expect(await audit(department)).toEqual(expect.arrayContaining([
      { action: 'owner_added', principal_id: owner },
      { action: 'owner_removed', principal_id: member },
    ]))
  })

  it('keeps a stale row in a Team-linked teamspace roster and tombstones the account', async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const shared = await newWorkspace(owner, false, [member])
    const team = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id
    await q(
      `INSERT INTO workspace_groups (id, workspace_id, name, created_by, kind, key, compartment_key)
       VALUES ($1::uuid, $2, 'Ops', $3, 'team', $1::uuid::text, 'team:' || $1::uuid::text)`,
      [team, shared, owner],
    )
    const teamspace = (await one<{ id: string }>(
      `INSERT INTO teamspaces (workspace_id, name, created_by) VALUES ($1, 'Ops space', $2) RETURNING id`,
      [shared, member],
    )).id
    await q(`INSERT INTO teamspace_members (teamspace_id, user_id) VALUES ($1, $2)`, [teamspace, member])
    await q(`UPDATE teamspaces SET workspace_group_id = $2 WHERE id = $1`, [teamspace, team])

    const removed = await deleteAccountFootprint(client!, member)

    expect(removed.mode).toBe('tombstoned')
    expect(await count(`SELECT count(*) AS n FROM workspace_members WHERE user_id = $1`, [member])).toBe(0)
  })

  it('refuses inside the transaction if the user gained a shared workspace after the route checked', async () => {
    const owner = await newUser('owner')
    const teammate = await newUser('teammate')
    await newWorkspace(owner, false, [teammate])
    await expect(deleteAccountFootprint(client!, owner)).rejects.toMatchObject({
      blockers: [{ step: 'ownership' }],
    })
  })

  it('moves a pinned workflow only while pausing it, and only inside the erasure', async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const shared = await newWorkspace(owner, false, [member])
    const workflow = (await one<{ id: string }>(
      `INSERT INTO workflows (workspace_id, created_by, name, definition, enabled, schedule_authoring_user_id)
       VALUES ($1, $2, 'Pinned', '{}'::jsonb, true, $2) RETURNING id`,
      [shared, member],
    )).id
    await q(`UPDATE workflows SET schedule_authoring_pinned = true WHERE id = $1`, [workflow])

    // Outside an erasure the guard still refuses an authority swap.
    await q('SAVEPOINT outside')
    await expect(q(`UPDATE workflows SET created_by = $2 WHERE id = $1`, [workflow, owner])).rejects.toThrow(/workflow_schedule_reapproval_required/)
    await q('ROLLBACK TO SAVEPOINT outside')

    await deleteAccountFootprint(client!, member)

    expect(await one(`SELECT created_by, enabled FROM workflows WHERE id = $1`, [workflow]))
      .toEqual({ created_by: owner, enabled: false })
  })

  it('admits the erasure exemption only for the transaction that registered it', async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const shared = await newWorkspace(owner, false, [member])
    const allows = async (oldRow: object, newRow: object) =>
      (await one<{ ok: boolean }>(`SELECT account_erasure_allows($1::jsonb, $2::jsonb, ARRAY['created_by']) AS ok`, [
        JSON.stringify(oldRow), JSON.stringify(newRow),
      ])).ok
    const before = { workspace_id: shared, created_by: member, payload: 'x' }

    // A setting alone, with no registered erasure, admits nothing.
    await q(`SELECT set_config('app.account_erasure', $1, true)`, [member])
    expect(await allows(before, { ...before, created_by: owner })).toBe(false)

    await q(`INSERT INTO account_erasures (txid, user_id) VALUES (pg_current_xact_id()::text, $1)`, [member])
    expect(await allows(before, { ...before, created_by: owner })).toBe(true)
    expect(await allows(before, { ...before, created_by: null })).toBe(true)
    // Any other column changing, another target, or another user: refused.
    expect(await allows(before, { ...before, created_by: owner, payload: 'y' })).toBe(false)
    expect(await allows(before, { ...before, created_by: await newUser('other') })).toBe(false)
    expect(await allows({ ...before, created_by: owner }, { ...before, created_by: null })).toBe(false)
  })
})
