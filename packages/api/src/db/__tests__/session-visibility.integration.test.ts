/**
 * [COMP:api/session-visibility] Session visibility RLS (integration).
 *
 * Exercises the migration-223 policies against a real Postgres:
 *   - a `visibility='workspace'` session (a doc comment thread) owned by
 *     user A is READABLE by a workspace teammate B via sessions_workspace_shared
 *     and its messages via session_messages_workspace_shared;
 *   - a non-member C cannot read it;
 *   - an owner-scoped (`visibility='owner'`) session of A stays invisible to B.
 *
 * Requires the local `Use Brian` DB with migration 223 applied. Skips silently
 * when the DB isn't reachable / the column is absent — matches the pattern in
 * aggregate-store.integration.test.ts.
 *
 * Spec: docs/plans/doc-brain-distillation.md → "Session model"; migration
 * 223_session_visibility.sql.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

let pool: pg.Pool | undefined
// Reads run through the application role when one is configured
// (DATABASE_URL_APP, the non-owner role production uses), so RLS applies.
let appPool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres:///sidanclaw',
    connectionTimeoutMillis: 2000,
  })
  try {
    const client = await p.connect()
    try {
      // Probe the column added by migration 223.
      await client.query('SELECT visibility FROM sessions LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
  } catch {
    await p.end().catch(() => {})
    return false
  }
  if (process.env.DATABASE_URL_APP) {
    const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, connectionTimeoutMillis: 2000 })
    try {
      const role = await app.query<{ bypass: boolean }>(
        'SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
      )
      if (role.rows[0]?.bypass === false) appPool = app
      else await app.end()
    } catch {
      await app.end().catch(() => {})
    }
  }
  return true
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip
// Cross-user DENIAL needs a role that RLS actually binds.
const itDenial = appPool ? it : it.skip

afterAll(async () => {
  if (appPool) await appPool.end()
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'sv-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'sv-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
  clearance: 'public' | 'internal' | 'confidential' = 'internal',
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, clearance)
     VALUES (gen_random_uuid(), $1, $2, 'member', $3)`,
    [workspaceId, userId, clearance],
  )
}

async function makeAssistant(client: pg.PoolClient, ownerId: string, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'sv-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

async function makeSession(
  client: pg.PoolClient,
  assistantId: string,
  userId: string,
  channelType: string,
  visibility: 'owner' | 'workspace',
  workspaceId: string | null,
  effectiveClearance: 'public' | 'internal' | 'confidential' | null = null,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, app_id, visibility, workspace_id, effective_clearance)
     VALUES ($1, $2, $3, gen_random_uuid()::text, 'Use Brian', $4, $5, $6)
     RETURNING id`,
    [assistantId, userId, channelType, visibility, workspaceId, effectiveClearance],
  )
  return r.rows[0].id
}

async function addMessage(client: pg.PoolClient, sessionId: string): Promise<void> {
  await client.query(
    `INSERT INTO session_messages (session_id, role, content, sequence_num)
     VALUES ($1, 'user', '"hi"'::jsonb, 0)`,
    [sessionId],
  )
}

/** Run a read as `userId` with RLS active (bypass off), then restore. */
async function asUser<T>(
  client: pg.PoolClient,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("SET app.system_bypass = ''")
  await client.query(`SET app.current_user_id = '${userId}'`)
  try {
    return await fn()
  } finally {
    await client.query("SET app.system_bypass = 'true'")
  }
}

describeIf('[COMP:api/session-visibility] Session visibility RLS (integration)', () => {
  let client: pg.PoolClient
  let reader: pg.PoolClient
  let userA: string // owner / creator
  let userB: string // workspace teammate
  let userC: string // outsider
  let assistantId: string
  let sharedSession: string // visibility='workspace', effective_clearance='internal'
  let ownerSession: string // visibility='owner' (web chat)
  let confidentialSession: string // visibility='workspace', effective_clearance='confidential'

  beforeAll(async () => {
    client = await pool!.connect()
    userA = await makeUser(client)
    userB = await makeUser(client)
    userC = await makeUser(client)
    const ws = await makeWorkspace(client, userA)
    await addMember(client, ws, userA, 'confidential')
    await addMember(client, ws, userB, 'internal') // B clears 'internal', not 'confidential'
    // userC is deliberately NOT a member.
    assistantId = await makeAssistant(client, userA, ws)
    sharedSession = await makeSession(client, assistantId, userA, 'doc_thread', 'workspace', ws, 'internal')
    ownerSession = await makeSession(client, assistantId, userA, 'web', 'owner', null)
    confidentialSession = await makeSession(client, assistantId, userA, 'doc_thread', 'workspace', ws, 'confidential')
    await addMessage(client, sharedSession)
    await addMessage(client, ownerSession)
    await addMessage(client, confidentialSession)
    reader = appPool ? await appPool.connect() : client
  })

  afterAll(() => {
    if (reader && reader !== client) reader.release()
    client?.release()
  })

  it('teammate B reads the workspace-shared session', async () => {
    const rows = await asUser(reader, userB, async () =>
      (await reader.query('SELECT id FROM sessions WHERE id = $1', [sharedSession])).rows,
    )
    expect(rows).toHaveLength(1)
  })

  it('teammate B reads the shared session messages', async () => {
    const rows = await asUser(reader, userB, async () =>
      (await reader.query('SELECT id FROM session_messages WHERE session_id = $1', [sharedSession])).rows,
    )
    expect(rows).toHaveLength(1)
  })

  // Cross-user DENIAL cannot be exercised through the owner connection:
  // superusers and the table owner bypass RLS. These run whenever
  // DATABASE_URL_APP names a role without rolsuper / rolbypassrls (the
  // scripts/crm/local-fixture.mjs assurance_app role, and production).
  itDenial('teammate B cannot read A\'s owner-scoped session', async () => {
    const rows = await asUser(reader, userB, async () =>
      (await reader.query('SELECT id FROM sessions WHERE id = $1', [ownerSession])).rows,
    )
    expect(rows).toHaveLength(0)
  })

  itDenial('outsider C cannot read the workspace-shared session', async () => {
    const rows = await asUser(reader, userC, async () =>
      (await reader.query('SELECT id FROM sessions WHERE id = $1', [sharedSession])).rows,
    )
    expect(rows).toHaveLength(0)
  })

  // Clearance gate (migration 224): B clears 'internal' but not 'confidential',
  // so B reads the internal thread (covered above) but NOT the confidential
  // one.
  itDenial('member below the thread clearance cannot read it', async () => {
    const rows = await asUser(reader, userB, async () =>
      (await reader.query('SELECT id FROM sessions WHERE id = $1', [confidentialSession])).rows,
    )
    expect(rows).toHaveLength(0)
  })

  it('owner A reads both their sessions', async () => {
    const rows = await asUser(reader, userA, async () =>
      (await reader.query('SELECT id FROM sessions WHERE id = ANY($1::uuid[])', [[sharedSession, ownerSession]])).rows,
    )
    expect(rows).toHaveLength(2)
  })
})
