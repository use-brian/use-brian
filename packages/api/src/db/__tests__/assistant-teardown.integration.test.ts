import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ASSISTANT_TEARDOWN_RULES, AssistantTeardownBlockedError, deleteAssistantFootprint } from '../assistant-teardown.js'

// Real-schema proof for the assistant teardown. A mocked client cannot see
// foreign-key trigger ordering or the evidence guards, which are what this
// code must get right.
//
// Production runs the delete as a NON-superuser table owner (the system
// pool), so when the connection is a superuser each test hands every public
// table and function to a NOSUPERUSER NOBYPASSRLS role inside its own
// transaction and runs as that role (all rolled back), as the account
// teardown suite does. Run against an idle database.
const connectionString = process.env.DATABASE_URL
const pool = connectionString ? new pg.Pool({ connectionString }) : null
let client: pg.PoolClient | null = null
let reachable = false
let superuser = false

beforeAll(async () => {
  try {
    client = await pool!.connect()
    await client.query(`SELECT 'agent_visibility_allows'::regproc`)
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
  for (let attempt = 1; ; attempt++) {
    await q('SAVEPOINT ordinary_owner')
    try {
      await q(`CREATE ROLE assistant_teardown_owner NOSUPERUSER NOBYPASSRLS`)
      await q(`GRANT ALL ON SCHEMA public TO assistant_teardown_owner`)
      await q(`DO $$
        DECLARE r record;
        BEGIN
          FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') LOOP
            EXECUTE format('ALTER TABLE %s OWNER TO assistant_teardown_owner', r.rel);
          END LOOP;
          FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.prokind = 'f'
                      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
            EXECUTE format('ALTER FUNCTION %s OWNER TO assistant_teardown_owner', r.fn);
          END LOOP;
        END $$`)
      await q('RELEASE SAVEPOINT ordinary_owner')
      break
    } catch (err) {
      await q('ROLLBACK TO SAVEPOINT ordinary_owner')
      if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err
    }
  }
  await q(`SET LOCAL ROLE assistant_teardown_owner`)
}

async function newUser(label: string) {
  return (await one<{ id: string }>(
    `INSERT INTO users (auth_provider, auth_provider_id, email, name)
     VALUES ('test', $1 || '-' || gen_random_uuid(), $1 || '-' || gen_random_uuid() || '@example.com', $1) RETURNING id`,
    [label],
  )).id
}

async function newWorkspace(owner: string, members: string[] = []) {
  const id = (await one<{ id: string }>(
    `INSERT INTO workspaces (name, owner_user_id, is_personal) VALUES ('WS', $1, false) RETURNING id`,
    [owner],
  )).id
  await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, owner])
  for (const m of members) {
    await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [id, m])
  }
  return id
}

async function newAssistant(ws: string, owner: string, kind: 'primary' | 'standard') {
  const id = (await one<{ id: string }>(
    `INSERT INTO assistants (name, workspace_id, owner_user_id, kind) VALUES ($3, $1, $2, $3) RETURNING id`,
    [ws, owner, kind],
  )).id
  await q(`INSERT INTO assistant_members (assistant_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, owner])
  return id
}

async function newSession(assistant: string, user: string, visibility: 'owner' | 'workspace', ws: string) {
  return (await one<{ id: string }>(
    `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, visibility, workspace_id)
     VALUES ($1, $2, 'web', gen_random_uuid()::text, $3, $4) RETURNING id`,
    [assistant, user, visibility, ws],
  )).id
}

async function newScopedMessage(session: string, ws: string, user: string, assistant: string, seq: number) {
  return (await one<{ id: string }>(
    `INSERT INTO session_messages (session_id, role, content, sequence_num, workspace_id, user_id, assistant_id,
                                   sensitivity, compartments, project_ids, scope_version, scope_held)
     VALUES ($1, 'user', '"hi"'::jsonb, $5, $2, $3, $4, 'internal', '{}', '{}', 1, false) RETURNING id`,
    [session, ws, user, assistant, seq],
  )).id
}

describe('[COMP:api/assistant-teardown] assistant teardown against a real schema', () => {
  beforeEach(async (ctx) => {
    if (!reachable) ctx.skip()
    await q('BEGIN')
    await runAsOrdinaryOwner()
  })

  afterEach(async () => {
    if (reachable) await q('ROLLBACK').catch(() => {})
  })

  it('has a rule for every foreign key to assistants without an ON DELETE action', async () => {
    const { rows } = await q<{ col: string }>(
      `SELECT regexp_replace(c.conrelid::regclass::text, '^public\\.', '') || '.' || a.attname AS col
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'assistants'::regclass AND c.confdeltype IN ('a', 'r')`,
    )
    expect(rows.map((r) => r.col).filter((c) => !ASSISTANT_TEARDOWN_RULES[c])).toEqual([])
  })

  it('moves brain rows anchored on the assistant to the primary and deletes the assistant', async () => {
    const owner = await newUser('owner')
    const member = await newUser('member')
    const ws = await newWorkspace(owner, [member])
    const primary = await newAssistant(ws, owner, 'primary')
    const demo = await newAssistant(ws, owner, 'standard')

    // Workspace-visible brain rows anchored on the assistant (no user_id), and
    // a member's private row anchored on it.
    const episode = (await one<{ id: string }>(
      `INSERT INTO episodes (source_kind, source_ref, occurred_at, workspace_id, created_by_user_id, assistant_id, created_by_assistant_id)
       VALUES ('file_upload', '{}', now(), $1, $2, $3, $3) RETURNING id`,
      [ws, owner, demo],
    )).id
    const company = (await one<{ id: string }>(
      `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, source, assistant_id, created_by_assistant_id, source_episode_id)
       VALUES ('company', 'Example Co', $1, $2, 'manual', $3, $3, $4) RETURNING id`,
      [ws, owner, demo, episode],
    )).id
    const person = (await one<{ id: string }>(
      `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, source, user_id, assistant_id)
       VALUES ('person', 'Private Subject', $1, $2, 'manual', $2, $3) RETURNING id`,
      [ws, member, demo],
    )).id
    const link = (await one<{ id: string }>(
      `INSERT INTO entity_links (source_kind, source_id, target_kind, target_id, edge_type, source, workspace_id, assistant_id)
       VALUES ('entity', $1, 'entity', $2, 'works_at', 'manual', $3, $4) RETURNING id`,
      [person, company, ws, demo],
    )).id
    const task = (await one<{ id: string }>(
      `INSERT INTO tasks (workspace_id, title, assistant_id, created_by_assistant_id) VALUES ($1, 'Follow up', $2, $2) RETURNING id`,
      [ws, demo],
    )).id
    const chunk = (await one<{ id: string }>(
      `INSERT INTO kb_chunks (chunk_text, workspace_id, created_by_user_id, source, assistant_id, created_by_assistant_id)
       VALUES ('fact', $1, $2, 'manual', $3, $3) RETURNING id`,
      [ws, owner, demo],
    )).id
    const file = (await one<{ id: string }>(
      `INSERT INTO workspace_files (workspace_id, path, name, storage_uri, assistant_id) VALUES ($1, '/a.txt', 'a.txt', 'mem://a', $2) RETURNING id`,
      [ws, demo],
    )).id
    // A memory another assistant holds but this one wrote: the author pointer clears.
    const authored = (await one<{ id: string }>(
      `INSERT INTO memories (summary, workspace_id, assistant_id, created_by_assistant_id) VALUES ('kept', $1, $2, $3) RETURNING id`,
      [ws, primary, demo],
    )).id
    // The assistant's own memory and conversation go with it.
    const ownMemory = (await one<{ id: string }>(
      `INSERT INTO memories (summary, workspace_id, assistant_id) VALUES ('mine', $1, $2) RETURNING id`,
      [ws, demo],
    )).id
    const ownSession = await newSession(demo, owner, 'owner', ws)
    const ownMessage = await newScopedMessage(ownSession, ws, owner, demo, 1)
    // A message it left in a room another assistant hosts stays in the room.
    const room = await newSession(primary, owner, 'workspace', ws)
    const roomMessage = await newScopedMessage(room, ws, owner, demo, 1)

    const result = await deleteAssistantFootprint(client!, demo, owner)

    expect(result).toEqual({ deleted: true, primaryAssistantId: primary })
    expect(await count(`SELECT count(*) AS n FROM assistants WHERE id = $1`, [demo])).toBe(0)
    for (const [table, id] of [
      ['episodes', episode], ['entities', company], ['entities', person], ['entity_links', link],
      ['tasks', task], ['kb_chunks', chunk], ['workspace_files', file], ['session_messages', roomMessage],
    ] as const) {
      expect(await one(`SELECT assistant_id FROM ${table} WHERE id = $1`, [id]), `${table}`).toEqual({ assistant_id: primary })
    }
    // The member's private row stays private to the member.
    expect(await one(`SELECT user_id FROM entities WHERE id = $1`, [person])).toEqual({ user_id: member })
    for (const [table, id] of [
      ['episodes', episode], ['entities', company], ['tasks', task], ['kb_chunks', chunk], ['memories', authored],
    ] as const) {
      expect(await one(`SELECT created_by_assistant_id FROM ${table} WHERE id = $1`, [id]), `${table}`)
        .toEqual({ created_by_assistant_id: null })
    }
    expect(await count(`SELECT count(*) AS n FROM memories WHERE id = $1`, [ownMemory])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM sessions WHERE id = $1`, [ownSession])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM session_messages WHERE id = $1`, [ownMessage])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM sessions WHERE id = $1`, [room])).toBe(1)
  })

  it('deletes an assistant that has no brain rows even without a primary', async () => {
    const owner = await newUser('owner')
    const ws = await newWorkspace(owner)
    const demo = await newAssistant(ws, owner, 'standard')

    expect(await deleteAssistantFootprint(client!, demo, owner)).toEqual({ deleted: true, primaryAssistantId: null })
    expect(await count(`SELECT count(*) AS n FROM assistants WHERE id = $1`, [demo])).toBe(0)
  })

  it('refuses, before changing anything, when brain rows have no primary to move to', async () => {
    const owner = await newUser('owner')
    const ws = await newWorkspace(owner)
    const demo = await newAssistant(ws, owner, 'standard')
    await q(`INSERT INTO tasks (workspace_id, title, assistant_id, created_by_assistant_id) VALUES ($1, 'Kept', $2, $2)`, [ws, demo])

    await expect(deleteAssistantFootprint(client!, demo, owner)).rejects.toBeInstanceOf(AssistantTeardownBlockedError)
    expect(await one(`SELECT assistant_id, created_by_assistant_id FROM tasks WHERE workspace_id = $1`, [ws]))
      .toEqual({ assistant_id: demo, created_by_assistant_id: demo })
  })

  it('deletes past skill scope revisions but names a skill whose current revision is the assistant', async () => {
    const owner = await newUser('owner')
    const ws = await newWorkspace(owner)
    const primary = await newAssistant(ws, owner, 'primary')
    const demo = await newAssistant(ws, owner, 'standard')
    await q(`SELECT set_config('app.current_user_id', $1, true), set_config('app.system_bypass', 'true', true)`, [owner])
    const skill = async (name: string) => (await one<{ id: string }>(
      `INSERT INTO workspace_skills (slug, name, description, content, workspace_id)
       VALUES (lower($1), $1, 'd', 'c', $2) RETURNING id`,
      [name, ws],
    )).id
    const revision = async (skillId: string, n: number, assistant: string) => {
      const id = (await one<{ id: string }>(
        `INSERT INTO workspace_skill_scope_revisions (workspace_id, skill_id, revision, assistant_id, sensitivity, compartments, project_ids)
         VALUES ($1, $2, $3, $4, 'internal', '{}', '{}') RETURNING id`,
        [ws, skillId, n, assistant],
      )).id
      await q(`UPDATE workspace_skills SET scope_revision_id = $1 WHERE id = $2`, [id, skillId])
      return id
    }
    // Re-scoped since: only a past revision names the assistant.
    const moved = await skill('Moved')
    const past = await revision(moved, 1, demo)
    await revision(moved, 2, primary)
    // Still scoped to the assistant.
    const learned = await skill('Learned')
    await revision(learned, 1, demo)
    await q(`SELECT set_config('app.system_bypass', '', true)`)

    await expect(deleteAssistantFootprint(client!, demo, owner)).rejects.toMatchObject({
      blockers: [{ step: 'workspace_skills', error: 'Learned' }],
    })

    await q(`DELETE FROM workspace_skills WHERE id = $1`, [learned])
    expect(await deleteAssistantFootprint(client!, demo, owner)).toEqual({ deleted: true, primaryAssistantId: primary })
    expect(await count(`SELECT count(*) AS n FROM workspace_skill_scope_revisions WHERE id = $1`, [past])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM workspace_skills WHERE id = $1 AND scope_revision_id IS NOT NULL`, [moved])).toBe(1)
  })

  it('refuses the primary assistant', async () => {
    const owner = await newUser('owner')
    const ws = await newWorkspace(owner)
    const primary = await newAssistant(ws, owner, 'primary')

    await expect(deleteAssistantFootprint(client!, primary, owner)).rejects.toMatchObject({
      code: 'assistant_delete_blocked',
      blockers: [{ step: 'primary', error: expect.any(String) }],
    })
    expect(await count(`SELECT count(*) AS n FROM assistants WHERE id = $1`, [primary])).toBe(1)
  })
})
