import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import type { RetrievalActor, RetrievalStore } from '@use-brian/core'

/**
 * Integration tests for createDbAggregateStore (company-brain WU-5.4).
 *
 * Requires the local `Use Brian` PostgreSQL database with migrations
 * through 296 (tasks table + CRM→entity unification) applied: the `deals`
 * primitive reads `entities` rows (kind='deal'), tasks its own table.
 * Skips silently when the DB isn't reachable — matches the pattern in
 * entities-store.integration.test.ts.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §"aggregate semantics".
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe the bi-temporal `valid_from` column on the tables the
      // aggregate store reads. Post CRM→entity unification (mig 296) the
      // `deals` primitive is an `entities` row (kind='deal'); a missing
      // column means the environment predates the universal-columns /
      // unification migrations and the store can't be exercised meaningfully.
      await client.query('SELECT valid_from FROM entities LIMIT 1')
      await client.query('SELECT valid_from FROM tasks LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'agg-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'aggregate-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

/**
 * Insert a deal as an `entities` row (kind='deal'). Post CRM→entity
 * unification (mig 296) the old `deals` table is gone; the aggregate
 * store's `deals` primitive reads `attributes->>'stage'` and
 * `(attributes->>'amount')::numeric` off `entities` (see the ALLOWLIST in
 * aggregate-store.ts). The row is owned by `createdByUserId` (set as both
 * `created_by_user_id` and `user_id`) so the store's visibility-double
 * access predicate admits it — `entities` requires a non-null owner
 * (`user_id IS NOT NULL OR assistant_id IS NOT NULL`) and a non-null
 * `created_by_user_id`, unlike the old shared-null-owner `deals` row.
 */
async function insertDeal(
  client: pg.PoolClient,
  workspaceId: string,
  createdByUserId: string,
  stage: string,
  amount: number | null,
  overrides: {
    validFrom?: string
    validTo?: string
    retractedAt?: string
  } = {},
): Promise<string> {
  const r = await client.query(
    `INSERT INTO entities
       (workspace_id, kind, display_name, source, created_by_user_id, user_id,
        attributes, valid_from, valid_to, retracted_at)
     VALUES ($1, 'deal', 'Deal', 'user', $2, $2,
        jsonb_build_object('stage', $3::text, 'amount', $4::numeric),
        COALESCE($5::timestamptz, now()), $6, $7)
     RETURNING id`,
    [
      workspaceId,
      createdByUserId,
      stage,
      amount,
      overrides.validFrom ?? null,
      overrides.validTo ?? null,
      overrides.retractedAt ?? null,
    ],
  )
  return r.rows[0].id
}

async function insertTask(
  client: pg.PoolClient,
  workspaceId: string,
  status: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO tasks (workspace_id, title, status)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [workspaceId, `task-${status}`, status],
  )
  return r.rows[0].id
}

describeIf('[COMP:retrieval/aggregate] aggregate store (integration)', () => {
  let store: Pick<RetrievalStore, 'aggregate'>
  let actor: RetrievalActor
  let userId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../aggregate-store.js')
    store = mod.createDbAggregateStore()
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
    } finally {
      client.release()
    }
    actor = {
      workspaceId,
      userId,
      assistantId: '00000000-0000-0000-0000-000000000001',
      assistantKind: 'standard',
    }
  })

  describe('measures', () => {
    it('count over deals grouped by stage', async () => {
      const client = await pool!.connect()
      try {
        await insertDeal(client, workspaceId, userId, 'lead', 100)
        await insertDeal(client, workspaceId, userId, 'lead', 200)
        await insertDeal(client, workspaceId, userId, 'won', 1000)
      } finally {
        client.release()
      }

      const result = await store.aggregate(actor, {
        measure: { fn: 'count' },
        dimensions: ['stage'],
        filters: { primitive: 'deals' },
      })

      expect(result.api_version).toBe('v1')
      expect(result.meta.truncated).toBe(false)
      const rows = result.data.map((r) => ({ stage: r.stage, count: r.measure_value }))
      expect(rows).toEqual(
        expect.arrayContaining([
          { stage: 'lead', count: 2 },
          { stage: 'won', count: 1 },
        ]),
      )
    })

    it('sum over deals.amount grouped by stage', async () => {
      const client = await pool!.connect()
      try {
        await insertDeal(client, workspaceId, userId, 'lead', 100)
        await insertDeal(client, workspaceId, userId, 'lead', 250)
        await insertDeal(client, workspaceId, userId, 'won', 1000)
      } finally {
        client.release()
      }

      const result = await store.aggregate(actor, {
        measure: { fn: 'sum', path: 'amount' },
        dimensions: ['stage'],
        filters: { primitive: 'deals' },
      })

      const byStage = new Map(result.data.map((r) => [r.stage as string, r.measure_value]))
      expect(byStage.get('lead')).toBe(350)
      expect(byStage.get('won')).toBe(1000)
    })

    it('count over tasks grouped by status', async () => {
      const client = await pool!.connect()
      try {
        await insertTask(client, workspaceId, 'todo')
        await insertTask(client, workspaceId, 'todo')
        await insertTask(client, workspaceId, 'done')
      } finally {
        client.release()
      }

      const result = await store.aggregate(actor, {
        measure: { fn: 'count' },
        dimensions: ['status'],
        filters: { primitive: 'tasks' },
      })

      const byStatus = new Map(result.data.map((r) => [r.status as string, r.measure_value]))
      expect(byStatus.get('todo')).toBe(2)
      expect(byStatus.get('done')).toBe(1)
    })
  })

  describe('projection rules', () => {
    it('as_of projects historical bi-temporal state', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString()

      const client = await pool!.connect()
      try {
        // Historical row: valid between 2h ago and 1h ago.
        await insertDeal(client, workspaceId, userId, 'lead', 100, {
          validFrom: twoHoursAgo,
          validTo: oneHourAgo,
        })
        // Current row: valid from now onward.
        await insertDeal(client, workspaceId, userId, 'lead', 200)
      } finally {
        client.release()
      }

      // Current state — only the current row.
      const current = await store.aggregate(actor, {
        measure: { fn: 'sum', path: 'amount' },
        dimensions: ['stage'],
        filters: { primitive: 'deals' },
      })
      expect(current.data.find((r) => r.stage === 'lead')?.measure_value).toBe(200)

      // 90 minutes ago — only the historical row was valid then.
      const past = await store.aggregate(actor, {
        measure: { fn: 'sum', path: 'amount' },
        dimensions: ['stage'],
        filters: { primitive: 'deals' },
        as_of: ninetyMinAgo,
      })
      expect(past.data.find((r) => r.stage === 'lead')?.measure_value).toBe(100)
    })

    it('retracted rows are excluded', async () => {
      const client = await pool!.connect()
      try {
        await insertDeal(client, workspaceId, userId, 'lead', 100, {
          retractedAt: new Date().toISOString(),
        })
        await insertDeal(client, workspaceId, userId, 'lead', 200)
      } finally {
        client.release()
      }

      const result = await store.aggregate(actor, {
        measure: { fn: 'sum', path: 'amount' },
        dimensions: ['stage'],
        filters: { primitive: 'deals' },
      })
      expect(result.data.find((r) => r.stage === 'lead')?.measure_value).toBe(200)
    })

    it('rows in another workspace are excluded', async () => {
      const client = await pool!.connect()
      try {
        await insertDeal(client, workspaceId, userId, 'lead', 100)

        // Foreign workspace + member so RLS would let the other user
        // read it, but the aggregate filter pins to actor.workspaceId.
        const otherUser = await makeUser(client)
        const otherWs = await makeWorkspace(client, otherUser)
        await addMember(client, otherWs, otherUser)
        await insertDeal(client, otherWs, otherUser, 'lead', 9999)
      } finally {
        client.release()
      }

      const result = await store.aggregate(actor, {
        measure: { fn: 'sum', path: 'amount' },
        dimensions: ['stage'],
        filters: { primitive: 'deals' },
      })
      expect(result.data.find((r) => r.stage === 'lead')?.measure_value).toBe(100)
    })
  })

  describe('validation', () => {
    it('rejects missing filters.primitive', async () => {
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'count' },
          dimensions: ['stage'],
        }),
      ).rejects.toThrow(/filters\.primitive is required/)
    })

    it('rejects unknown primitive', async () => {
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'count' },
          dimensions: ['stage'],
          filters: { primitive: 'planets' },
        }),
      ).rejects.toThrow(/unknown primitive "planets"/)
    })

    it('rejects unregistered measure.path', async () => {
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'sum', path: 'attributes.evil_payload' },
          dimensions: ['stage'],
          filters: { primitive: 'deals' },
        }),
      ).rejects.toThrow(/not registered for primitive "deals"/)
    })

    it('rejects sum on a non-numeric path', async () => {
      // `created_at` is a registered timestamp measure path on deals
      // (valid for max / min). sum must reject it.
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'sum', path: 'created_at' },
          dimensions: ['stage'],
          filters: { primitive: 'deals' },
        }),
      ).rejects.toThrow(/not numeric/)
    })

    it('rejects unregistered dimension', async () => {
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'count' },
          dimensions: ['amount'],
          filters: { primitive: 'deals' },
        }),
      ).rejects.toThrow(/dimension "amount" is not registered/)
    })

    it('rejects unregistered filter key', async () => {
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'count' },
          dimensions: ['stage'],
          filters: { primitive: 'deals', random_field: 'x' },
        }),
      ).rejects.toThrow(/filter "random_field" is not registered/)
    })

    it('rejects malformed as_of', async () => {
      await expect(
        store.aggregate(actor, {
          measure: { fn: 'count' },
          dimensions: ['stage'],
          filters: { primitive: 'deals' },
          as_of: 'yesterday',
        }),
      ).rejects.toThrow(/as_of is not a valid ISO timestamp/)
    })
  })
})
