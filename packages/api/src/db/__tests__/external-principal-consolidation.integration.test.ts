import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'

/**
 * [COMP:consolidation/external-principal-isolation] — the cross-client
 * memory-merge leak fix, proven end to end against real SQL.
 *
 * A company can point one assistant at its own clients through the public
 * API (`api:<keyId>:<externalUserId>`) or a public chat link
 * (`chatlink:<linkId>:<visitorId>`). Before this fix those client shadows
 * were indistinguishable from teammates to the team consolidation passes:
 * `runTeamLightConsolidation` reads every row in the workspace through
 * `getWorkspaceIndexSystem` (no user filter, by design) and `mergeDetails`
 * concatenates one author's `detail` lines onto another author's row. Two
 * clients of the same assistant with near-identical summaries therefore had
 * their memory content merged into each other. `runTeamDeepConsolidation`,
 * reading `listTeamWithMetrics`, could likewise delete another client's row.
 *
 * The repair is store-side (`excludeExternalPrincipalsSql` in `memories.ts`),
 * so both team passes inherit it and the wrappers in `phases.ts` are
 * untouched. This suite asserts the behavior the wrappers actually exhibit,
 * not the SQL text — `external-principal-scope.test.ts` covers the clause
 * itself without a DB.
 *
 * The discriminator is the auth namespace, never workspace membership:
 * Slack/Telegram teammate shadows are non-members but are genuinely team, so
 * a membership filter would silently stop consolidating them. See
 * `docs/architecture/context-engine/memory-consolidation.md` → "External
 * principals" and `docs/plans/client-principal.md` §6.1 (D1).
 *
 * Requires a local Use Brian PostgreSQL. Skips silently otherwise.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT auth_provider, auth_provider_id FROM users LIMIT 1')
      await client.query('SELECT user_id, workspace_id, confidence FROM memories LIMIT 1')
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

// ── Seed helpers ────────────────────────────────────────────────────

/** A teammate: any auth namespace that is not `api:` / `chatlink:`. */
async function makeMemberUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'google', 'extp-member-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

/**
 * An external principal. `namespace` is the real prefix `executePublicTurn`
 * mints — `api:<keyId>` for the keyed route, `chatlink:<linkId>` for the
 * chat-link route.
 */
async function makeExternalUser(client: pg.PoolClient, namespace: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'channel', $1 || ':extp-' || gen_random_uuid())
     RETURNING id`,
    [namespace],
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'extp-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

/**
 * `standard` on purpose: a `primary` assistant's rows are stored with
 * `assistant_id IS NULL` and re-folded by `systemAssistantScopeSql`, which
 * is a separate mechanism. Keeping the assistant standard isolates the
 * author-namespace exclusion as the only thing under test.
 */
async function makeAssistant(client: pg.PoolClient, ownerId: string, workspaceId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id, kind, clearance)
     VALUES (gen_random_uuid(), 'extp-test-assistant', $1, $2, 'standard', 'confidential')
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

/**
 * Seeds through the real `createMemory` chokepoint rather than a raw INSERT
 * — the same rule `invariants/memories-write-user-scope` grades — so the
 * fixture cannot drift into a row shape the product can't actually produce.
 */
async function seedMemory(
  createMemory: typeof import('../memories.js')['createMemory'],
  opts: { assistantId: string; workspaceId: string; userId: string; summary: string; detail: string },
): Promise<string> {
  const m = await createMemory({
    assistantId: opts.assistantId,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    scope: 'workspace',
    tags: ['extp-test'],
    summary: opts.summary,
    detail: opts.detail,
    confidence: 0.9,
    sensitivity: 'internal',
    source: 'user',
    createdByUserId: opts.userId,
  })
  return m.id
}

/**
 * Two summaries whose Jaccard similarity clears the 0.9 non-REM threshold —
 * identical word sets, so similarity is exactly 1.0. Details differ, which
 * is what makes a merge observable (and what makes the leak a content leak).
 */
const SHARED_SUMMARY = 'prefers invoices delivered monthly by email'

type Seed = {
  workspaceId: string
  assistantId: string
  ownerId: string
  memberA: string
  memberB: string
  apiClientA: string
  apiClientB: string
  chatlinkVisitor: string
  memoryIds: Record<string, string>
}

async function seedFixture(
  client: pg.PoolClient,
  createMemory: typeof import('../memories.js')['createMemory'],
): Promise<Seed> {
  const ownerId = await makeMemberUser(client)
  const workspaceId = await makeWorkspace(client, ownerId)
  const assistantId = await makeAssistant(client, ownerId, workspaceId)

  const memberA = await makeMemberUser(client)
  const memberB = await makeMemberUser(client)
  const apiClientA = await makeExternalUser(client, 'api:key-alpha')
  const apiClientB = await makeExternalUser(client, 'api:key-alpha')
  const chatlinkVisitor = await makeExternalUser(client, 'chatlink:link-beta')

  const mem = (userId: string, detail: string) =>
    seedMemory(createMemory, { assistantId, workspaceId, userId, summary: SHARED_SUMMARY, detail })

  const memoryIds = {
    memberA: await mem(memberA, 'member-a-detail-line'),
    memberB: await mem(memberB, 'member-b-detail-line'),
    apiClientA: await mem(apiClientA, 'client-a-secret-detail-line'),
    apiClientB: await mem(apiClientB, 'client-b-secret-detail-line'),
    chatlinkVisitor: await mem(chatlinkVisitor, 'visitor-secret-detail-line'),
  }

  return {
    workspaceId, assistantId, ownerId,
    memberA, memberB, apiClientA, apiClientB, chatlinkVisitor,
    memoryIds,
  }
}

/**
 * The LIVE row for each author in the workspace, keyed by `user_id`.
 *
 * Read by author rather than by seeded id on purpose: `updateMemory` is
 * bi-temporal, so a merge tombstones the row it edited (`valid_to` set,
 * `superseded_by` pointed forward) and INSERTs a new one carrying the same
 * `user_id`. Following the seeded id would read the pre-merge snapshot and
 * report "nothing merged" no matter what the pass did.
 */
async function liveRowsByAuthor(
  client: pg.PoolClient,
  workspaceId: string,
): Promise<Map<string, { detail: string | null; confidence: number }>> {
  const r = await client.query<{ userId: string; detail: string | null; confidence: number }>(
    `SELECT user_id as "userId", detail, confidence
       FROM memories
      WHERE workspace_id = $1 AND valid_to IS NULL`,
    [workspaceId],
  )
  return new Map(r.rows.map((row) => [row.userId, { detail: row.detail, confidence: Number(row.confidence) }]))
}

// ── Tests ──────────────────────────────────────────────────────────

describeIf('[COMP:consolidation/external-principal-isolation] team passes skip external principals', () => {
  let seed: Seed
  let memories: typeof import('../memories.js')
  let memoryStore: typeof import('../memory-store.js')
  let phases: typeof import('@use-brian/core')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
    memoryStore = await import('../memory-store.js')
    phases = await import('@use-brian/core')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      seed = await seedFixture(client, memories.createMemory)
    } finally {
      client.release()
    }
  })

  afterEach(async () => {
    const client = await pool!.connect()
    try {
      await client.query(`DELETE FROM memories WHERE workspace_id = $1`, [seed.workspaceId])
      await client.query(`DELETE FROM consolidation_logs WHERE workspace_id = $1`, [seed.workspaceId])
      await client.query(`DELETE FROM assistants WHERE workspace_id = $1`, [seed.workspaceId])
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [seed.workspaceId])
      await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[
        seed.ownerId, seed.memberA, seed.memberB,
        seed.apiClientA, seed.apiClientB, seed.chatlinkVisitor,
      ]])
    } finally {
      client.release()
    }
  })

  it('team light pass merges two member authors but never two external authors', async () => {
    const store = memoryStore.createDbMemoryStore()
    await phases.runTeamLightConsolidation(store, seed.assistantId, seed.workspaceId)

    const client = await pool!.connect()
    try {
      const live = await liveRowsByAuthor(client, seed.workspaceId)

      // Members: identical summaries → one row absorbs the other's detail and
      // the loser is marked for prune. Which row wins depends on the index's
      // `ORDER BY updated_at DESC`, so assert the shape, not the direction.
      const memA = live.get(seed.memberA)!
      const memB = live.get(seed.memberB)!
      const [winner, loser] = memA.confidence === 0 ? [memB, memA] : [memA, memB]
      expect(loser.confidence).toBe(0)
      expect(winner.confidence).toBeGreaterThan(0)
      expect(winner.detail).toContain('member-a-detail-line')
      expect(winner.detail).toContain('member-b-detail-line')

      // External clients: same summaries, but never compared to anything —
      // untouched detail, untouched confidence, no prune mark.
      const externals = {
        apiClientA: [seed.apiClientA, 'client-a-secret-detail-line'],
        apiClientB: [seed.apiClientB, 'client-b-secret-detail-line'],
        chatlinkVisitor: [seed.chatlinkVisitor, 'visitor-secret-detail-line'],
      } as const
      for (const [userId, ownDetail] of Object.values(externals)) {
        const row = live.get(userId)!
        expect(row.confidence).toBe(0.9)
        expect(row.detail).toBe(ownDetail)
      }
      // Belt-and-braces: no client's detail ever reached a teammate's row.
      expect(winner.detail).not.toContain('secret')
    } finally {
      client.release()
    }
  })

  it('getWorkspaceMemoryIndexSystem projects only member-authored rows', async () => {
    const index = await memories.getWorkspaceMemoryIndexSystem(seed.assistantId, seed.workspaceId)
    const ids = index.map((r) => r.id)
    expect(ids).toContain(seed.memoryIds.memberA)
    expect(ids).toContain(seed.memoryIds.memberB)
    expect(ids).not.toContain(seed.memoryIds.apiClientA)
    expect(ids).not.toContain(seed.memoryIds.apiClientB)
    expect(ids).not.toContain(seed.memoryIds.chatlinkVisitor)
  })

  it('listWorkspaceMemoriesWithMetrics (the Deep-pass scan) skips external rows', async () => {
    const rows = await memories.listWorkspaceMemoriesWithMetrics(seed.assistantId, seed.workspaceId)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(seed.memoryIds.memberA)
    expect(ids).toContain(seed.memoryIds.memberB)
    expect(ids).not.toContain(seed.memoryIds.apiClientA)
    expect(ids).not.toContain(seed.memoryIds.chatlinkVisitor)
  })

  it('listMemoryUsers omits external principals so no personal pass is scheduled for them', async () => {
    const users = await memories.listMemoryUsers()
    const userIds = new Set(users.map((u) => u.userId))
    expect(userIds.has(seed.memberA)).toBe(true)
    expect(userIds.has(seed.memberB)).toBe(true)
    expect(userIds.has(seed.apiClientA)).toBe(false)
    expect(userIds.has(seed.apiClientB)).toBe(false)
    expect(userIds.has(seed.chatlinkVisitor)).toBe(false)
  })
})
