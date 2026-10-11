/**
 * Executed proof of the unified session schema (migration 741,
 * docs/plans/unified-sessions.md §4.5, §9 S3).
 *
 * The chain is replayed from empty as an ordinary owner role, then every
 * session shape is read, listed and posted to under the RLS policies as the
 * owner, a member, a lower-clearance member, a guest (a real user who is not a
 * member) and a removed member. The creation-admission and kind-derivation
 * triggers are exercised by executed inserts, never by reading the file.
 *
 * Spec: docs/architecture/context-engine/session-messages.md -> "Session kind";
 * docs/architecture/platform/database-schema.md -> migration 741.
 *
 * [COMP:api/session-schema]
 */

import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { migratePglite } from '../migrate-pglite.js'

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/api/migrations', import.meta.url),
)

const W = '00000000-0000-4000-8000-00000000a001'
const ASSISTANT = '00000000-0000-4000-8000-00000000a002'
const OWNER = '00000000-0000-4000-8000-00000000b001'
const MEMBER = '00000000-0000-4000-8000-00000000b002'
const LOW = '00000000-0000-4000-8000-00000000b003'
const GUEST = '00000000-0000-4000-8000-00000000b004'
const REMOVED = '00000000-0000-4000-8000-00000000b005'

type Principal = 'owner' | 'member' | 'lowerClearance' | 'guest' | 'removed'
const PRINCIPALS: Record<Principal, string> = {
  owner: OWNER, member: MEMBER, lowerClearance: LOW, guest: GUEST, removed: REMOVED,
}

let db: PGlite

async function openAsOwner(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { vector, pg_trgm } })
  await pg.waitReady
  await pg.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
    UPDATE pg_extension
       SET extowner = (SELECT oid FROM pg_authid WHERE rolname = 'migration_owner')
     WHERE extname = 'vector';
    ALTER SCHEMA public OWNER TO migration_owner;
    GRANT CREATE ON DATABASE postgres TO migration_owner;
    SET ROLE migration_owner;
  `)
  return pg
}

/** Run `sql` as `userId` through the RLS-subject application role. */
async function asUser<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  // The baseline leaves row_security off for the migrating connection.
  await db.exec('SET ROLE app_rls; SET row_security = on')
  try {
    await db.query("SELECT set_config('app.current_user_id', $1, false)", [userId])
    return (await db.query<T>(sql, params)).rows
  } finally {
    await db.exec('RESET row_security; SET ROLE migration_owner')
  }
}

type Shape = {
  name: string
  insert: Record<string, unknown>
  expectAnchor: string
  expectVisibility: 'personal' | 'workspace'
  expectChannelType: string
  /** Who reads, lists and posts. Personal: the creator only. Workspace: members at clearance. */
  readers: Principal[]
}

const MEMBERS_AT_CLEARANCE: Principal[] = ['owner', 'member']
const SHAPES: Shape[] = [
  { name: 'personal web chat', insert: { user_id: MEMBER, channel_type: 'web', channel_id: 'chat-1', app_origin: 'chat', visibility: 'owner' },
    expectAnchor: 'none', expectVisibility: 'personal', expectChannelType: 'web', readers: ['member'] },
  { name: 'doc dock', insert: { user_id: MEMBER, channel_type: 'web', channel_id: 'dock-1', app_origin: 'doc' },
    expectAnchor: 'none', expectVisibility: 'personal', expectChannelType: 'web', readers: ['member'] },
  { name: 'external DM', insert: { user_id: MEMBER, channel_type: 'telegram', channel_id: '12345' },
    expectAnchor: 'none', expectVisibility: 'personal', expectChannelType: 'telegram', readers: ['member'] },
  { name: 'notification inbox', insert: { user_id: MEMBER, channel_type: 'notification', channel_id: 'notifications' },
    expectAnchor: 'inbox', expectVisibility: 'personal', expectChannelType: 'web', readers: ['member'] },
  { name: 'workspace room started by a removed member', insert: { user_id: REMOVED, channel_type: 'web', channel_id: 'room-1', app_origin: 'chat', visibility: 'workspace' },
    expectAnchor: 'none', expectVisibility: 'workspace', expectChannelType: 'web', readers: MEMBERS_AT_CLEARANCE },
  { name: 'feed draft', insert: { user_id: MEMBER, channel_type: 'web', channel_id: 'draft:1', mode: 'draft' },
    expectAnchor: 'feed_draft', expectVisibility: 'workspace', expectChannelType: 'web', readers: MEMBERS_AT_CLEARANCE },
  { name: 'doc comment thread', insert: { user_id: MEMBER, channel_type: 'doc_thread', channel_id: 'thread-1', visibility: 'workspace' },
    expectAnchor: 'doc_thread', expectVisibility: 'workspace', expectChannelType: 'web', readers: MEMBERS_AT_CLEARANCE },
  { name: 'office file thread', insert: { user_id: MEMBER, channel_type: 'office_thread', channel_id: 'office-1', visibility: 'workspace' },
    expectAnchor: 'office_file', expectVisibility: 'workspace', expectChannelType: 'web', readers: MEMBERS_AT_CLEARANCE },
  { name: 'feed thread', insert: { user_id: MEMBER, channel_type: 'feed_thread', channel_id: 'feed-thread:1', visibility: 'workspace' },
    expectAnchor: 'feed_thread', expectVisibility: 'workspace', expectChannelType: 'web', readers: MEMBERS_AT_CLEARANCE },
  { name: 'converged channel room', insert: { user_id: MEMBER, channel_type: 'telegram', channel_id: '-1001', visibility: 'workspace', anchor_kind: 'channel' },
    expectAnchor: 'channel', expectVisibility: 'workspace', expectChannelType: 'telegram', readers: MEMBERS_AT_CLEARANCE },
]

const ids = new Map<string, string>()
let sequence = 1

describe('[COMP:api/session-schema] Unified session schema', () => {
  before(async () => {
    db = await openAsOwner()
    assert.ok((await migratePglite(db, migrationsDir)) > 0)
    assert.deepEqual(
      (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows,
      [{ rolsuper: false, rolbypassrls: false }],
    )
    // The application role is subject to RLS (the hosted DATABASE_URL_APP role).
    await db.exec(`
      RESET ROLE;
      CREATE ROLE app_rls NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO app_rls;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_rls;
      GRANT app_rls TO migration_owner;
      SET ROLE migration_owner;
    `)
    await db.query(
      `INSERT INTO users (id, auth_provider, auth_provider_id)
       SELECT u, 'test', 'session-schema-' || u FROM unnest($1::uuid[]) AS u`,
      [[OWNER, MEMBER, LOW, GUEST, REMOVED]],
    )
    await db.query(
      `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
       VALUES ($1, 'Session schema', 'test', $2, false)`, [W, OWNER])
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, clearance) VALUES
         ($1, $2, 'owner', 'confidential'), ($1, $3, 'member', 'confidential'),
         ($1, $4, 'member', 'public'), ($1, $5, 'member', 'confidential')`,
      [W, OWNER, MEMBER, LOW, REMOVED])
    await db.query(
      `INSERT INTO assistants (id, name, owner_user_id, workspace_id, clearance)
       VALUES ($1, 'Room assistant', $2, $3, 'internal')`, [ASSISTANT, OWNER, W])

    for (const shape of SHAPES) {
      const row = { assistant_id: ASSISTANT, workspace_id: W, ...shape.insert }
      const cols = Object.keys(row)
      const id = (await db.query<{ id: string }>(
        `INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      )).rows[0].id
      ids.set(shape.name, id)
      await db.query(
        `INSERT INTO session_messages (session_id, role, content, sequence_num) VALUES ($1, 'user', '[{"type":"text","text":"hi"}]'::jsonb, 1)`,
        [id])
      // Session state is written by whoever drove the turn; its readers are the session's.
      await db.query(
        `INSERT INTO session_state (session_id, user_id, assistant_id, key, status, summary, source)
         VALUES ($1, $2, $3, 'k', 'open', 's', 'tool')`, [id, shape.insert.user_id, ASSISTANT])
    }
    // The starter leaves: on a workspace row user_id is "created by" and grants nothing (D9).
    await db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [W, REMOVED])
  })

  after(async () => { await db?.close() })

  it('derives anchor, audience and transport on insert', async () => {
    for (const shape of SHAPES) {
      const row = (await db.query<{ anchor_kind: string; visibility: string; channel_type: string; effective_clearance: string | null }>(
        'SELECT anchor_kind, visibility, channel_type, effective_clearance FROM sessions WHERE id = $1',
        [ids.get(shape.name)])).rows[0]
      assert.equal(row.anchor_kind, shape.expectAnchor, shape.name)
      assert.equal(row.visibility, shape.expectVisibility, shape.name)
      assert.equal(row.channel_type, shape.expectChannelType, shape.name)
      // D10: every workspace row carries a clearance.
      if (shape.expectVisibility === 'workspace') assert.equal(row.effective_clearance, 'internal', shape.name)
    }
  })

  for (const principal of Object.keys(PRINCIPALS) as Principal[]) {
    it(`reads, lists and posts every shape as the ${principal}`, async () => {
      const userId = PRINCIPALS[principal]
      const listed = new Set((await asUser<{ id: string }>(userId, 'SELECT id FROM sessions')).map((r) => r.id))
      for (const shape of SHAPES) {
        const id = ids.get(shape.name)!
        const expected = shape.readers.includes(principal)
        assert.equal(listed.has(id), expected, `${shape.name}: list as ${principal}`)
        const messages = await asUser(userId, 'SELECT id FROM session_messages WHERE session_id = $1', [id])
        assert.equal(messages.length > 0, expected, `${shape.name}: read as ${principal}`)
        const state = await asUser(userId, 'SELECT id FROM session_state WHERE session_id = $1', [id])
        assert.equal(state.length > 0, expected, `${shape.name}: session state as ${principal}`)
        // A personal session's owner posts under RLS; nobody posts into someone
        // else's personal session. Workspace posts go through the gated room
        // path, never through a per-user message policy.
        let posted = true
        try {
          await asUser(userId,
            `INSERT INTO session_messages (session_id, role, content, sequence_num) VALUES ($1, 'user', '[]'::jsonb, $2)`, [id, ++sequence])
        } catch { posted = false }
        assert.equal(posted, shape.expectVisibility === 'personal' && expected, `${shape.name}: post as ${principal}`)
      }
    })
  }

  it('keeps one room per provider conversation, whoever speaks', async () => {
    await assert.rejects(db.query(
      `INSERT INTO sessions (assistant_id, workspace_id, user_id, channel_type, channel_id, visibility, anchor_kind)
       VALUES ($1, $2, $3, 'telegram', '-1001', 'workspace', 'channel')`, [ASSISTANT, W, OWNER]),
    /sessions_channel_room_key/)
  })

  it('requires a creation receipt for a workspace session in a ready workspace', async () => {
    await db.query(
      `INSERT INTO workspace_access_policies (workspace_id, setup_state, access_mode) VALUES ($1, 'ready', 'departments')
       ON CONFLICT (workspace_id) DO UPDATE SET setup_state = 'ready', access_mode = 'departments'`, [W])
    try {
      await assert.rejects(db.query(
        `INSERT INTO sessions (assistant_id, workspace_id, user_id, channel_type, channel_id, visibility, anchor_kind, anchor_ref)
         VALUES ($1, $2, $3, 'web', 'thread-2', 'workspace', 'doc_thread', 'thread-2')`, [ASSISTANT, W, MEMBER]),
      /workspace_creation_admission_required/)

      const revision = (await db.query<{ revision: string }>(
        'SELECT revision::text FROM workspace_access_policies WHERE workspace_id = $1', [W])).rows[0].revision
      const receipt = (over: Record<string, unknown>) => JSON.stringify({
        protocol: '1', provenance: 'anchored_thread', workspaceId: W, policyRevision: revision,
        actor: MEMBER, assistantId: ASSISTANT, userId: MEMBER, anchorKind: 'doc_thread',
        anchorRef: 'thread-2', sensitivity: 'internal', ...over,
      })
      await db.exec('BEGIN')
      await db.query("SELECT set_config('app.session_creation_admission', $1, true)", [receipt({})])
      const admitted = await db.query<{ anchor_kind: string }>(
        `INSERT INTO sessions (assistant_id, workspace_id, user_id, channel_type, channel_id, visibility, anchor_kind, anchor_ref, effective_clearance)
         VALUES ($1, $2, $3, 'web', 'thread-2', 'workspace', 'doc_thread', 'thread-2', 'internal') RETURNING anchor_kind`,
        [ASSISTANT, W, MEMBER])
      await db.exec('COMMIT')
      assert.equal(admitted.rows[0].anchor_kind, 'doc_thread')

      // A receipt is single-use and bound to its anchor and actor.
      await db.exec('BEGIN')
      await db.query("SELECT set_config('app.session_creation_admission', $1, true)", [receipt({ actor: GUEST, userId: GUEST })])
      await assert.rejects(db.query(
        `INSERT INTO sessions (assistant_id, workspace_id, user_id, channel_type, channel_id, visibility, anchor_kind, anchor_ref, effective_clearance)
         VALUES ($1, $2, $3, 'web', 'thread-3', 'workspace', 'doc_thread', 'thread-2', 'internal')`, [ASSISTANT, W, GUEST]),
      /workspace_creation_admission_required/)
      await db.exec('ROLLBACK')

      // A personal session needs no workspace receipt.
      await db.query(
        `INSERT INTO sessions (assistant_id, workspace_id, user_id, channel_type, channel_id)
         VALUES ($1, $2, $3, 'telegram', '999')`, [ASSISTANT, W, MEMBER])
    } finally {
      await db.query("UPDATE workspace_access_policies SET setup_state = 'legacy' WHERE workspace_id = $1", [W])
    }
  })
})
