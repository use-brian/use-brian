import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AccessContext } from '@sidanclaw/core'
import pg from 'pg'

function ctxOf(userId: string, workspaceId: string, assistantId: string = userId): AccessContext {
  return { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
}

/**
 * Integration test for createDbEpisodesStore + the episodes schema
 * defined in migration 129 (company-brain WU-3.1). Requires a local
 * PostgreSQL database named `sidanclaw` with that migration applied.
 * Skips silently when the DB is unavailable or the migration hasn't
 * been applied yet.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM episodes LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'episodes-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'episodes-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

describeIf('[COMP:brain/episodes-store] episodes store (integration)', () => {
  let store: ReturnType<
    typeof import('../episodes-store.js') extends { createDbEpisodesStore: infer F }
      ? F extends () => infer R
        ? () => R
        : never
      : never
  >

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../episodes-store.js')
    store = mod.createDbEpisodesStore()
  })

  describe('createEpisode + getEpisodeById', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('round trips a web_chat episode with defaults applied', async () => {
      const occurredAt = new Date('2026-05-01T10:00:00Z')
      const ep = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { sessionId: 'sess-1' },
        occurredAt,
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
        contentRef: { session_id: 'sess-1', message_id_range: ['m1', 'm5'] },
      })
      expect(ep.sourceKind).toBe('web_chat')
      expect(ep.sourceRef).toEqual({ sessionId: 'sess-1' })
      expect(ep.occurredAt.toISOString()).toBe(occurredAt.toISOString())
      expect(ep.status).toBe('open')
      expect(ep.sensitivity).toBe('internal')
      expect(ep.attachments).toEqual([])
      expect(ep.lastCheckpointAt).toBeNull()
      expect(ep.workspaceId).toBe(workspaceId)
      expect(ep.userId).toBe(userId)
      expect(ep.assistantId).toBeNull()
      expect(ep.createdByUserId).toBe(userId)
      expect(ep.extractionLocked).toBe(false)
      expect(ep.ingestedAt).toBeInstanceOf(Date)
      expect(ep.contentRef).toEqual({ session_id: 'sess-1', message_id_range: ['m1', 'm5'] })

      const fetched = await store.getEpisodeById(ctxOf(userId, workspaceId), ep.id)
      expect(fetched?.id).toBe(ep.id)
      expect(fetched?.sourceRef).toEqual({ sessionId: 'sess-1' })
    })

    it('rejects when both userId and assistantId are null (visibility double)', async () => {
      await expect(
        store.createEpisode(userId, {
          sourceKind: 'manual_paste',
          sourceRef: {},
          occurredAt: new Date(),
          workspaceId,
          userId: null,
          assistantId: null,
          createdByUserId: userId,
        }),
      ).rejects.toThrow(/visibility double/)
    })

    it('returns null for unknown id', async () => {
      const ep = await store.getEpisodeById(
        ctxOf(userId, workspaceId),
        '00000000-0000-0000-0000-000000000000',
      )
      expect(ep).toBeNull()
    })
  })

  describe('listEpisodes filters', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('filters by source_kind and partitions by workspace', async () => {
      // Build a second workspace + episode to confirm isolation.
      const client = await pool!.connect()
      let otherWorkspaceId: string
      try {
        otherWorkspaceId = await makeWorkspace(client, userId)
        await addMember(client, otherWorkspaceId, userId)
      } finally {
        client.release()
      }
      await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { sessionId: 'a' },
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })
      await store.createEpisode(userId, {
        sourceKind: 'slack_thread',
        sourceRef: { channelId: 'c1', threadTs: '1' },
        occurredAt: new Date('2026-05-01T11:00:00Z'),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })
      await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { sessionId: 'b' },
        occurredAt: new Date('2026-05-01T12:00:00Z'),
        workspaceId: otherWorkspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })

      const ws1WebChat = await store.listEpisodes(ctxOf(userId, workspaceId), {
        sourceKind: 'web_chat',
      })
      expect(ws1WebChat).toHaveLength(1)
      expect((ws1WebChat[0].sourceRef as { sessionId: string }).sessionId).toBe('a')

      const ws1All = await store.listEpisodes(ctxOf(userId, workspaceId), {})
      expect(ws1All).toHaveLength(2)
      expect(ws1All.every((e) => e.workspaceId === workspaceId)).toBe(true)
    })

    it('filters by status (single + array)', async () => {
      const open = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: {},
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })
      const archived = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: {},
        occurredAt: new Date('2026-05-01T11:00:00Z'),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })
      await store.updateStatus(userId, archived.id, 'archived')

      const openOnly = await store.listEpisodes(ctxOf(userId, workspaceId), { status: 'open' })
      expect(openOnly.map((e) => e.id)).toEqual([open.id])

      const both = await store.listEpisodes(ctxOf(userId, workspaceId), {
        status: ['open', 'archived'],
      })
      expect(both.map((e) => e.id).sort()).toEqual([open.id, archived.id].sort())
    })

    it('filters by occurredAfter / occurredBefore window', async () => {
      const base = new Date('2026-05-01T12:00:00Z')
      const t_minus_2h = new Date(base.getTime() - 2 * 3600_000)
      const t_minus_1h = new Date(base.getTime() - 1 * 3600_000)

      const old = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { tag: 'old' },
        occurredAt: t_minus_2h,
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      const middle = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { tag: 'middle' },
        occurredAt: t_minus_1h,
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      const recent = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { tag: 'recent' },
        occurredAt: base,
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      void old
      void recent

      const window = new Date(base.getTime() - 90 * 60_000)
      const windowEnd = new Date(base.getTime() - 30 * 60_000)
      const rows = await store.listEpisodes(ctxOf(userId, workspaceId), {
        occurredAfter: window,
        occurredBefore: windowEnd,
      })
      expect(rows.map((e) => e.id)).toEqual([middle.id])
    })

    it('honours limit and order', async () => {
      const first = await store.createEpisode(userId, {
        sourceKind: 'web_chat', sourceRef: { i: 1 },
        occurredAt: new Date('2026-05-01T08:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      const second = await store.createEpisode(userId, {
        sourceKind: 'web_chat', sourceRef: { i: 2 },
        occurredAt: new Date('2026-05-01T09:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      const third = await store.createEpisode(userId, {
        sourceKind: 'web_chat', sourceRef: { i: 3 },
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })

      const desc = await store.listEpisodes(ctxOf(userId, workspaceId), {}, { limit: 2 })
      expect(desc.map((e) => e.id)).toEqual([third.id, second.id])

      const asc = await store.listEpisodes(
        ctxOf(userId, workspaceId),
        {},
        { order: 'occurred_at_asc' },
      )
      expect(asc.map((e) => e.id)).toEqual([first.id, second.id, third.id])
    })
  })

  describe('asOf bi-temporal read', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('filters listEpisodes and getEpisodeById by ingested_at <= asOf', async () => {
      const early = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { tag: 'early' },
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      const late = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: { tag: 'late' },
        occurredAt: new Date('2026-05-01T11:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })

      // Backdate `early.ingested_at` to 1h ago; leave `late` at now.
      // Then asOf 30 min ago should only see `early`.
      const oneHourAgo = new Date(Date.now() - 3600_000)
      const thirtyMinAgo = new Date(Date.now() - 1800_000)
      const client = await pool!.connect()
      try {
        await client.query(`UPDATE episodes SET ingested_at = $1 WHERE id = $2`, [
          oneHourAgo,
          early.id,
        ])
      } finally {
        client.release()
      }

      const visible = await store.listEpisodes(ctxOf(userId, workspaceId), {
        asOf: thirtyMinAgo,
      })
      expect(visible.map((e) => e.id)).toEqual([early.id])

      const lateOut = await store.getEpisodeById(ctxOf(userId, workspaceId), late.id, { asOf: thirtyMinAgo })
      expect(lateOut).toBeNull()
      const earlyIn = await store.getEpisodeById(ctxOf(userId, workspaceId), early.id, { asOf: thirtyMinAgo })
      expect(earlyIn?.id).toBe(early.id)
    })
  })

  describe('updateStatus transitions', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    async function freshEpisode() {
      return store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: {},
        occurredAt: new Date(),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })
    }

    it('open → extracting stamps last_checkpoint_at; extracting → archived succeeds', async () => {
      const ep = await freshEpisode()
      const extracting = await store.updateStatus(userId, ep.id, 'extracting')
      expect(extracting?.status).toBe('extracting')
      expect(extracting?.lastCheckpointAt).toBeInstanceOf(Date)

      const archived = await store.updateStatus(userId, ep.id, 'archived')
      expect(archived?.status).toBe('archived')
    })

    it('allows open → archived (skip-extraction path)', async () => {
      const ep = await freshEpisode()
      const archived = await store.updateStatus(userId, ep.id, 'archived')
      expect(archived?.status).toBe('archived')
      // open → archived does NOT stamp the checkpoint unless explicitly asked.
      expect(archived?.lastCheckpointAt).toBeNull()
    })

    it('rejects archived → * (terminal)', async () => {
      const ep = await freshEpisode()
      await store.updateStatus(userId, ep.id, 'archived')
      await expect(
        store.updateStatus(userId, ep.id, 'open'),
      ).rejects.toThrow(/invalid episode status transition/)
      await expect(
        store.updateStatus(userId, ep.id, 'extracting'),
      ).rejects.toThrow(/invalid episode status transition/)
    })

    it('rejects extracting → open (no reopen)', async () => {
      const ep = await freshEpisode()
      await store.updateStatus(userId, ep.id, 'extracting')
      await expect(
        store.updateStatus(userId, ep.id, 'open'),
      ).rejects.toThrow(/invalid episode status transition/)
    })

    it('rejects same-state self-transition', async () => {
      const ep = await freshEpisode()
      await expect(
        store.updateStatus(userId, ep.id, 'open'),
      ).rejects.toThrow(/already in status/)
    })

    it('stampCheckpoint forces a checkpoint stamp on open → archived', async () => {
      const ep = await freshEpisode()
      const archived = await store.updateStatus(userId, ep.id, 'archived', {
        stampCheckpoint: true,
      })
      expect(archived?.lastCheckpointAt).toBeInstanceOf(Date)
    })

    it('returns null for unknown id', async () => {
      const result = await store.updateStatus(
        userId,
        '00000000-0000-0000-0000-000000000000',
        'archived',
      )
      expect(result).toBeNull()
    })
  })

  describe('updateCheckpoint patch semantics', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('sets summaryText, leaves unrelated fields alone, stamps last_checkpoint_at', async () => {
      const ep = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: {},
        occurredAt: new Date(),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
        attachments: [{ kind: 'file', ref: 'f-1' }],
        idleThresholdSecs: 600,
      })
      expect(ep.lastCheckpointAt).toBeNull()

      const patched = await store.updateCheckpoint(userId, ep.id, {
        summaryText: 'first checkpoint summary',
      })
      expect(patched?.summaryText).toBe('first checkpoint summary')
      expect(patched?.attachments).toEqual([{ kind: 'file', ref: 'f-1' }])
      expect(patched?.idleThresholdSecs).toBe(600)
      expect(patched?.lastCheckpointAt).toBeInstanceOf(Date)
    })

    it('lets attachments and idleThresholdSecs be replaced', async () => {
      const ep = await store.createEpisode(userId, {
        sourceKind: 'web_chat',
        sourceRef: {},
        occurredAt: new Date(),
        workspaceId,
        userId,
        assistantId: null,
        createdByUserId: userId,
      })
      const patched = await store.updateCheckpoint(userId, ep.id, {
        attachments: [{ kind: 'image', ref: 'i-1' }],
        idleThresholdSecs: 120,
      })
      expect(patched?.attachments).toEqual([{ kind: 'image', ref: 'i-1' }])
      expect(patched?.idleThresholdSecs).toBe(120)
    })

    it('returns null for unknown id', async () => {
      const result = await store.updateCheckpoint(
        userId,
        '00000000-0000-0000-0000-000000000000',
        { summaryText: 'never' },
      )
      expect(result).toBeNull()
    })
  })

  describe('parent_episode_id continuation chain', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('listEpisodes can find a continuation by parentEpisodeId', async () => {
      const parent = await store.createEpisode(userId, {
        sourceKind: 'slack_thread',
        sourceRef: { channelId: 'c', threadTs: '1' },
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
      })
      await store.updateStatus(userId, parent.id, 'archived')

      const child = await store.createEpisode(userId, {
        sourceKind: 'slack_thread',
        sourceRef: { channelId: 'c', threadTs: '1' },
        occurredAt: new Date('2026-05-02T10:00:00Z'),
        workspaceId, userId, assistantId: null, createdByUserId: userId,
        parentEpisodeId: parent.id,
      })

      const continuations = await store.listEpisodes(ctxOf(userId, workspaceId), {
        parentEpisodeId: parent.id,
      })
      expect(continuations.map((e) => e.id)).toEqual([child.id])
      expect(continuations[0].parentEpisodeId).toBe(parent.id)
    })
  })
})
