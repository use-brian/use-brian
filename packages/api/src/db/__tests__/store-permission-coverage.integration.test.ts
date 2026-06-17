import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import type { AccessContext, RetrievalActor } from '@sidanclaw/core'

/**
 * [COMP:brain/store-permission-coverage] — WU-4.2 spec gate.
 *
 * Integration assertion that the universal access projection
 * (`buildAccessPredicate`, P1-12) is applied on the READ path of every
 * store carrying the universal column set: the six primitives
 * (memories, tasks, workspace_files, and contacts/companies/deals via
 * the CRM store) plus entities, entity_links, episodes, and kb_chunks.
 *
 * For every primitive the test seeds one CONFIDENTIAL row and one
 * PUBLIC control row in the same visibility scope, then exercises:
 *   - a low-clearance viewer (clearance='internal') — must NOT see the
 *     confidential row but MUST see the public control;
 *   - a high-clearance viewer (clearance='confidential') — MUST see the
 *     confidential row;
 *   - a cross-workspace viewer — must see neither.
 *
 * Each assertion runs through the primitive's own store read function
 * (`getMemoryById`, `getTaskById`, `getWorkspaceFileById`,
 * `getCompanyById` / `getContactById` / `getDealById`, `getEntityById`,
 * `getEntityLinkById`, `getEpisodeById`). `kb_chunks` has no dedicated
 * viewer store — its only viewer read path is `retrieval-store.search()`
 * (`scope: 'kb_chunk'`), so that scope is exercised there.
 *
 * See docs/plans/company-brain/permissions.md → "Universal resource
 * projection" (P1-12) and "Per-assistant user blocklist" (Q20) for the
 * spec, and docs/historical/completion-plan.md → WS-4 for the
 * work-unit scope.
 *
 * Requires a local `sidanclaw` PostgreSQL database with migrations
 * through 132 applied. Skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe one column on every universal-column-carrying table.
      await client.query(
        `SELECT workspace_id, user_id, assistant_id, sensitivity, valid_to, retracted_at
           FROM memories LIMIT 1`,
      )
      await client.query('SELECT sensitivity FROM tasks LIMIT 1')
      await client.query('SELECT sensitivity FROM workspace_files LIMIT 1')
      await client.query('SELECT sensitivity FROM companies LIMIT 1')
      await client.query('SELECT sensitivity FROM contacts LIMIT 1')
      await client.query('SELECT sensitivity FROM deals LIMIT 1')
      await client.query('SELECT sensitivity FROM entities LIMIT 1')
      await client.query('SELECT sensitivity FROM entity_links LIMIT 1')
      await client.query('SELECT sensitivity FROM episodes LIMIT 1')
      await client.query('SELECT sensitivity FROM kb_chunks LIMIT 1')
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

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'perm-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'perm-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

async function makeAssistant(
  client: pg.PoolClient,
  ownerId: string,
  workspaceId: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'perm-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

type Sensitivity = 'public' | 'internal' | 'confidential'

/**
 * One seeded primitive: a confidential row + a public control row, both
 * in the same `(workspace, user, assistant)` visibility scope. The
 * confidential id must be invisible below `confidential` clearance; the
 * control id must be visible to any in-scope viewer (it isolates the
 * sensitivity axis — a clearance filter, not a visibility filter,
 * removes the confidential row).
 */
type PrimitiveRows = { confidential: string; control: string }

// Direct-SQL seeding keeps full control over the universal columns
// (sensitivity / user_id / assistant_id) — several store `create`
// helpers default `sensitivity` and don't accept it as a parameter.

async function seedMemory(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO memories (
       assistant_id, user_id, workspace_id, scope, tags, summary, detail,
       confidence, sensitivity, source, created_by_user_id
     ) VALUES (
       $1, $2, $3, 'workspace', ARRAY['perm-test'],
       'permcanaryword memory ' || $4, NULL, 0.9, $4, 'user', $2
     ) RETURNING id`,
    [assistantId, userId, ws, sensitivity],
  )
  return r.rows[0].id
}

async function seedTask(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  // params: $1 ws, $2 userId, $3 assistantId, $4 sensitivity
  const r = await client.query<{ id: string }>(
    `INSERT INTO tasks (
       workspace_id, title, status, tags, sensitivity,
       user_id, assistant_id, source, created_by_user_id
     ) VALUES (
       $1, 'permcanaryword task ' || $4, 'todo', ARRAY['perm-test'], $4,
       $2, $3, 'user', $2
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedWorkspaceFile(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace_files (
       workspace_id, path, parent_path, name, mime, size_bytes, tags,
       storage_uri, sensitivity, user_id, assistant_id, source, created_by_user_id
     ) VALUES (
       $1, '/permcanaryword-' || gen_random_uuid() || '.txt', '/',
       'permcanaryword file', 'text/plain', 1, ARRAY['perm-test'],
       'gs://perm-test/' || gen_random_uuid(), $4, $2, $3, 'user', $2
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedCompany(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO companies (
       workspace_id, name, tags, external_ref, sensitivity,
       user_id, assistant_id, source, created_by_user_id
     ) VALUES (
       $1, 'permcanaryword company ' || $4, ARRAY['perm-test'], '{}'::jsonb, $4,
       $2, $3, 'user', $2
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedContact(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO contacts (
       workspace_id, name, tags, external_ref, sensitivity,
       user_id, assistant_id, source, created_by_user_id
     ) VALUES (
       $1, 'permcanaryword contact ' || $4, ARRAY['perm-test'], '{}'::jsonb, $4,
       $2, $3, 'user', $2
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedDeal(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO deals (
       workspace_id, stage, external_ref, sensitivity,
       user_id, assistant_id, source, created_by_user_id
     ) VALUES (
       $1, 'lead', '{}'::jsonb, $4, $2, $3, 'user', $2
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedEntity(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  // `kind='project'` — the CRM-specialization kinds (person/company/
  // deal) are write-blocked by the Q24 guard; project is unguarded.
  const r = await client.query<{ id: string }>(
    `INSERT INTO entities (
       kind, display_name, sensitivity, workspace_id, user_id, assistant_id,
       created_by_user_id, source
     ) VALUES (
       'project', 'permcanaryword entity ' || $4, $4, $1, $2, $3, $2, 'user'
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedEntityLink(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  // `source_id` / `target_id` are plain UUIDs (no FK) — arbitrary ids
  // are fine for a visibility/clearance projection test. `edge_type`
  // references the seeded `entity_link_types` vocabulary.
  const r = await client.query<{ id: string }>(
    `INSERT INTO entity_links (
       source_kind, source_id, target_kind, target_id, edge_type,
       source, sensitivity, workspace_id, user_id, assistant_id
     ) VALUES (
       'memory', gen_random_uuid(), 'entity', gen_random_uuid(), 'mentioned',
       'user', $4, $1, $2, $3
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedEpisode(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO episodes (
       source_kind, source_ref, occurred_at, status, sensitivity,
       user_id, assistant_id, workspace_id, created_by_user_id
     ) VALUES (
       'manual_paste', '{}'::jsonb, now(), 'archived', $4,
       $2, $3, $1, $2
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedKbChunk(
  client: pg.PoolClient,
  ws: string,
  userId: string,
  assistantId: string,
  sensitivity: Sensitivity,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO kb_chunks (
       chunk_text, sensitivity, user_id, assistant_id, workspace_id,
       created_by_user_id, source
     ) VALUES (
       'permcanaryword kb chunk ' || $4, $4, $2, $3, $1, $2, 'kb_sync'
     ) RETURNING id`,
    [ws, userId, assistantId, sensitivity],
  )
  return r.rows[0].id
}

async function seedPair(
  client: pg.PoolClient,
  seed: (
    c: pg.PoolClient,
    ws: string,
    u: string,
    a: string,
    s: Sensitivity,
  ) => Promise<string>,
  ws: string,
  userId: string,
  assistantId: string,
): Promise<PrimitiveRows> {
  const confidential = await seed(client, ws, userId, assistantId, 'confidential')
  const control = await seed(client, ws, userId, assistantId, 'public')
  return { confidential, control }
}

// ── Test setup ─────────────────────────────────────────────────────

type Seed = {
  workspaceA: string
  workspaceB: string
  userA1: string
  userB: string
  assistantA: string
  assistantB: string
  // Per-primitive rows in workspace A, scope (userA1, assistantA).
  memory: PrimitiveRows
  task: PrimitiveRows
  file: PrimitiveRows
  company: PrimitiveRows
  contact: PrimitiveRows
  deal: PrimitiveRows
  entity: PrimitiveRows
  entityLink: PrimitiveRows
  episode: PrimitiveRows
  kbChunk: PrimitiveRows
}

async function seedFixture(client: pg.PoolClient): Promise<Seed> {
  // Workspace A — viewer's workspace.
  const userA1 = await makeUser(client)
  const workspaceA = await makeWorkspace(client, userA1)
  await addMember(client, workspaceA, userA1)
  const assistantA = await makeAssistant(client, userA1, workspaceA)

  // Workspace B — cross-workspace isolation check.
  const userB = await makeUser(client)
  const workspaceB = await makeWorkspace(client, userB)
  await addMember(client, workspaceB, userB)
  const assistantB = await makeAssistant(client, userB, workspaceB)

  return {
    workspaceA,
    workspaceB,
    userA1,
    userB,
    assistantA,
    assistantB,
    memory: await seedPair(client, seedMemory, workspaceA, userA1, assistantA),
    task: await seedPair(client, seedTask, workspaceA, userA1, assistantA),
    file: await seedPair(client, seedWorkspaceFile, workspaceA, userA1, assistantA),
    company: await seedPair(client, seedCompany, workspaceA, userA1, assistantA),
    contact: await seedPair(client, seedContact, workspaceA, userA1, assistantA),
    deal: await seedPair(client, seedDeal, workspaceA, userA1, assistantA),
    entity: await seedPair(client, seedEntity, workspaceA, userA1, assistantA),
    entityLink: await seedPair(client, seedEntityLink, workspaceA, userA1, assistantA),
    episode: await seedPair(client, seedEpisode, workspaceA, userA1, assistantA),
    kbChunk: await seedPair(client, seedKbChunk, workspaceA, userA1, assistantA),
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describeIf('[COMP:brain/store-permission-coverage] WU-4.2 universal projection', () => {
  let seed: Seed
  let memories: typeof import('../memories.js')
  let tasks: typeof import('../tasks.js')
  let files: typeof import('../workspace-files.js')
  let crm: typeof import('../crm.js')
  let entitiesStore: typeof import('../entities-store.js')
  let entityLinks: typeof import('../entity-links-store.js')
  let episodes: typeof import('../episodes-store.js')
  let retrieval: typeof import('../retrieval-store.js')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
    tasks = await import('../tasks.js')
    files = await import('../workspace-files.js')
    crm = await import('../crm.js')
    entitiesStore = await import('../entities-store.js')
    entityLinks = await import('../entity-links-store.js')
    episodes = await import('../episodes-store.js')
    retrieval = await import('../retrieval-store.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      seed = await seedFixture(client)
    } finally {
      client.release()
    }
  })

  // Viewer in workspace A, scope (userA1, assistantA), at a given clearance.
  function ctx(clearance: Sensitivity): AccessContext {
    return {
      workspaceId: seed.workspaceA,
      userId: seed.userA1,
      assistantId: seed.assistantA,
      assistantKind: 'standard',
      clearance,
    }
  }

  // A viewer who belongs to workspace B — same shape, foreign workspace.
  function crossCtx(): AccessContext {
    return {
      workspaceId: seed.workspaceB,
      userId: seed.userB,
      assistantId: seed.assistantB,
      assistantKind: 'standard',
      clearance: 'confidential',
    }
  }

  describe('memories — getMemoryById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await memories.getMemoryById(ctx('internal'), seed.memory.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await memories.getMemoryById(ctx('internal'), seed.memory.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await memories.getMemoryById(ctx('confidential'), seed.memory.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await memories.getMemoryById(crossCtx(), seed.memory.confidential)).toBeNull()
      expect(await memories.getMemoryById(crossCtx(), seed.memory.control)).toBeNull()
    })
  })

  describe('tasks — getTaskById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await tasks.getTaskById(ctx('internal'), seed.task.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await tasks.getTaskById(ctx('internal'), seed.task.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await tasks.getTaskById(ctx('confidential'), seed.task.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await tasks.getTaskById(crossCtx(), seed.task.confidential)).toBeNull()
      expect(await tasks.getTaskById(crossCtx(), seed.task.control)).toBeNull()
    })
  })

  describe('workspace_files — getWorkspaceFileById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await files.getWorkspaceFileById(ctx('internal'), seed.file.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await files.getWorkspaceFileById(ctx('internal'), seed.file.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await files.getWorkspaceFileById(ctx('confidential'), seed.file.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await files.getWorkspaceFileById(crossCtx(), seed.file.confidential)).toBeNull()
      expect(await files.getWorkspaceFileById(crossCtx(), seed.file.control)).toBeNull()
    })
  })

  describe('companies — getCompanyById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await crm.getCompanyById(ctx('internal'), seed.company.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await crm.getCompanyById(ctx('internal'), seed.company.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await crm.getCompanyById(ctx('confidential'), seed.company.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await crm.getCompanyById(crossCtx(), seed.company.confidential)).toBeNull()
      expect(await crm.getCompanyById(crossCtx(), seed.company.control)).toBeNull()
    })
  })

  describe('contacts — getContactById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await crm.getContactById(ctx('internal'), seed.contact.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await crm.getContactById(ctx('internal'), seed.contact.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await crm.getContactById(ctx('confidential'), seed.contact.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await crm.getContactById(crossCtx(), seed.contact.confidential)).toBeNull()
      expect(await crm.getContactById(crossCtx(), seed.contact.control)).toBeNull()
    })
  })

  describe('deals — getDealById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await crm.getDealById(ctx('internal'), seed.deal.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await crm.getDealById(ctx('internal'), seed.deal.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await crm.getDealById(ctx('confidential'), seed.deal.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await crm.getDealById(crossCtx(), seed.deal.confidential)).toBeNull()
      expect(await crm.getDealById(crossCtx(), seed.deal.control)).toBeNull()
    })
  })

  describe('entities — getEntityById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await entitiesStore.getEntityById(ctx('internal'), seed.entity.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await entitiesStore.getEntityById(ctx('internal'), seed.entity.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await entitiesStore.getEntityById(ctx('confidential'), seed.entity.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await entitiesStore.getEntityById(crossCtx(), seed.entity.confidential)).toBeNull()
      expect(await entitiesStore.getEntityById(crossCtx(), seed.entity.control)).toBeNull()
    })
  })

  describe('entity_links — getEntityLinkById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await entityLinks.getEntityLinkById(ctx('internal'), seed.entityLink.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await entityLinks.getEntityLinkById(ctx('internal'), seed.entityLink.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await entityLinks.getEntityLinkById(ctx('confidential'), seed.entityLink.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await entityLinks.getEntityLinkById(crossCtx(), seed.entityLink.confidential)).toBeNull()
      expect(await entityLinks.getEntityLinkById(crossCtx(), seed.entityLink.control)).toBeNull()
    })
  })

  describe('episodes — getEpisodeById', () => {
    it('low-clearance viewer cannot read the confidential row', async () => {
      expect(await episodes.getEpisodeById(ctx('internal'), seed.episode.confidential)).toBeNull()
    })
    it('low-clearance viewer can still read the public control row', async () => {
      expect(await episodes.getEpisodeById(ctx('internal'), seed.episode.control)).not.toBeNull()
    })
    it('high-clearance viewer can read the confidential row', async () => {
      expect(await episodes.getEpisodeById(ctx('confidential'), seed.episode.confidential)).not.toBeNull()
    })
    it('cross-workspace viewer sees neither row', async () => {
      expect(await episodes.getEpisodeById(crossCtx(), seed.episode.confidential)).toBeNull()
      expect(await episodes.getEpisodeById(crossCtx(), seed.episode.control)).toBeNull()
    })
  })

  describe('kb_chunks — retrieval-store.search() scope=kb_chunk', () => {
    // kb_chunks has no dedicated viewer store; the only viewer read path
    // is retrieval-store's `searchKbChunksScope`, which composes
    // `buildAccessPredicate` via the shared `visibilityPredicate`.
    function actor(workspaceId: string, userId: string, assistantId: string, clearance: Sensitivity): RetrievalActor {
      return { workspaceId, userId, assistantId, assistantKind: 'standard', clearance }
    }
    async function searchKbIds(a: RetrievalActor): Promise<string[]> {
      const r = await retrieval.search(a, { query: 'permcanaryword', scope: 'kb_chunk' })
      return r.data.map((row) => row.row_id)
    }

    it('low-clearance viewer cannot see the confidential chunk but sees the control', async () => {
      const ids = await searchKbIds(
        actor(seed.workspaceA, seed.userA1, seed.assistantA, 'internal'),
      )
      expect(ids).not.toContain(seed.kbChunk.confidential)
      expect(ids).toContain(seed.kbChunk.control)
    })
    it('high-clearance viewer sees the confidential chunk', async () => {
      const ids = await searchKbIds(
        actor(seed.workspaceA, seed.userA1, seed.assistantA, 'confidential'),
      )
      expect(ids).toContain(seed.kbChunk.confidential)
    })
    it('cross-workspace viewer sees neither chunk', async () => {
      const ids = await searchKbIds(
        actor(seed.workspaceB, seed.userB, seed.assistantB, 'confidential'),
      )
      expect(ids).not.toContain(seed.kbChunk.confidential)
      expect(ids).not.toContain(seed.kbChunk.control)
    })
  })

  describe('predicate-fragment shape', () => {
    // Canary against silent regressions where a refactor reintroduces a
    // local predicate instead of the shared helper.
    it('buildAccessPredicate emits the spec-mandated AND-group', async () => {
      const ap = await import('../access-predicate.js')
      const fragment = ap.buildAccessPredicate({
        workspaceId: seed.workspaceA,
        userId: seed.userA1,
        assistantId: seed.assistantA,
        assistantKind: 'standard',
        clearance: 'internal',
      })
      // Spec invariant from permissions.md → "Access predicate".
      expect(fragment.sql).toContain('workspace_id = $1')
      expect(fragment.sql).toContain('(user_id IS NULL OR user_id = $2)')
      expect(fragment.sql).toContain('(assistant_id IS NULL OR assistant_id = $3)')
      expect(fragment.sql).toContain('sensitivity_rank(sensitivity) <= sensitivity_rank($4)')
    })
  })
})
