import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

/**
 * [COMP:brain/assistant-blocklist-evaluator] — WU-4.4 observation side.
 *
 * Integration assertion for `isUserBlockedForAssistant` in
 * `packages/api/src/db/users.ts` — the observation-direction blocklist
 * evaluator. It is the DB-backed counterpart to the pure invocation-side
 * `isUserBlocked` evaluator (unit-tested in `routes/__tests__/chat.test.ts`
 * under the same component tag).
 *
 * The evaluator is wired into Pipeline B via the processor's
 * `isUserBlockedForAssistant` port (`apps/api/src/index.ts`) so a user in
 * an assistant's `blocked_user_ids` array (migration 122) has their
 * content archived without extraction — see
 * `docs/plans/company-brain/permissions.md` §"Per-assistant user
 * blocklist" (Q20) and `packages/core/src/ingest/pipeline-b.ts`
 * (`processEpisode` step 0).
 *
 * Requires a local `Use Brian` PostgreSQL database with migration 122
 * applied. Skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT blocked_user_ids FROM assistants LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'blocklist-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'blocklist-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function makeAssistant(
  client: pg.PoolClient,
  ownerId: string,
  workspaceId: string,
  blockedUserIds: string[],
): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id, blocked_user_ids)
     VALUES (gen_random_uuid(), 'blocklist-test-assistant', $1, $2, $3)
     RETURNING id`,
    [ownerId, workspaceId, blockedUserIds],
  )
  return r.rows[0].id
}

describeIf('[COMP:brain/assistant-blocklist-evaluator] isUserBlockedForAssistant', () => {
  let store: typeof import('../users.js')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../users.js')
  })

  it('returns true when the user is in the assistant blocklist (observation block)', async () => {
    const client = await pool!.connect()
    try {
      const owner = await makeUser(client)
      const blocked = await makeUser(client)
      const ws = await makeWorkspace(client, owner)
      const assistant = await makeAssistant(client, owner, ws, [blocked])

      expect(await store.isUserBlockedForAssistant(assistant, blocked)).toBe(true)
    } finally {
      client.release()
    }
  })

  it('returns false when the user is absent from the blocklist', async () => {
    const client = await pool!.connect()
    try {
      const owner = await makeUser(client)
      const other = await makeUser(client)
      const ws = await makeWorkspace(client, owner)
      // Empty blocklist — the column defaults to '{}'.
      const assistant = await makeAssistant(client, owner, ws, [])

      expect(await store.isUserBlockedForAssistant(assistant, other)).toBe(false)
    } finally {
      client.release()
    }
  })

  it('blocks only the listed user — a sibling user on the same assistant is not blocked', async () => {
    const client = await pool!.connect()
    try {
      const owner = await makeUser(client)
      const blocked = await makeUser(client)
      const allowed = await makeUser(client)
      const ws = await makeWorkspace(client, owner)
      const assistant = await makeAssistant(client, owner, ws, [blocked])

      expect(await store.isUserBlockedForAssistant(assistant, blocked)).toBe(true)
      expect(await store.isUserBlockedForAssistant(assistant, allowed)).toBe(false)
    } finally {
      client.release()
    }
  })

  it('returns false for an unknown assistant id — a stale id never suppresses extraction', async () => {
    const client = await pool!.connect()
    try {
      const someUser = await makeUser(client)
      const missingAssistantId = '00000000-0000-0000-0000-000000000000'

      expect(
        await store.isUserBlockedForAssistant(missingAssistantId, someUser),
      ).toBe(false)
    } finally {
      client.release()
    }
  })
})
