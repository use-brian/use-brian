import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import type { AccessContext } from '@use-brian/core'
import {
  createMemory,
  getMemoryIndexRanked,
  getMemoryIndexSystem,
  listMemoryUsers,
} from '../memories.js'

/**
 * [COMP:api/memory-store] — write-side "Primary widens".
 *
 * Regression for the silent-silo bug: every memory writer used to stamp
 * the visibility double as (ctx.userId, ctx.assistantId) = `personal`,
 * so the primary assistant's accumulated brain was invisible to every
 * non-primary assistant (the universal access predicate gates them on
 * `assistant_id IS NULL OR assistant_id = self`). A doc assistant
 * authoring "from the user's memories" saw nothing.
 *
 * The fix resolves a `kind='primary'` writer's memory to
 * `workspace_shared` (`assistant_id = NULL`, `user_id` kept) in
 * `createMemory`, so it is readable by every assistant in the workspace
 * for that user, clearance-bounded. Standard/app writers stay `personal`
 * (siloed). See docs/architecture/platform/sensitivity.md →
 * "saveMemory resolution" + "Primary widens on WRITE too", and migration
 * `240_primary_memories_workspace_shared.sql` for the existing-row
 * backfill.
 *
 * Requires a local `Use Brian` PostgreSQL database. Skips silently when
 * unavailable (mirrors the other db/__tests__ integration suites).
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT workspace_id, user_id, assistant_id FROM memories LIMIT 1')
      await client.query('SELECT kind FROM assistants LIMIT 1')
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

const PRIMARY_FACT = 'wss-primary-fact ' + 'permcanary'
const APP_FACT = 'wss-app-fact ' + 'permcanary'

describeIf('[COMP:api/memory-store] primary memories are workspace_shared', () => {
  let ws: string
  let userId: string
  let primaryId: string
  let docId: string
  let otherAppId: string

  beforeAll(async () => {
    const client = await pool!.connect()
    try {
      userId = (
        await client.query<{ id: string }>(
          `INSERT INTO users (id, auth_provider, auth_provider_id)
           VALUES (gen_random_uuid(), 'test', 'wss-' || gen_random_uuid())
           RETURNING id`,
        )
      ).rows[0].id
      ws = (
        await client.query<{ id: string }>(
          `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
           VALUES (gen_random_uuid(), 'wss-test-ws', 'test', $1, true)
           RETURNING id`,
          [userId],
        )
      ).rows[0].id
      await client.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, clearance)
         VALUES (gen_random_uuid(), $1, $2, 'owner', 'confidential')`,
        [ws, userId],
      )
      primaryId = (
        await client.query<{ id: string }>(
          `INSERT INTO assistants (id, name, owner_user_id, workspace_id, kind, clearance)
           VALUES (gen_random_uuid(), 'wss-primary', $1, $2, 'primary', 'confidential')
           RETURNING id`,
          [userId, ws],
        )
      ).rows[0].id
      // Workspace-owned doc app assistant (no owner), like prod.
      docId = (
        await client.query<{ id: string }>(
          `INSERT INTO assistants (id, name, owner_user_id, workspace_id, kind, app_type, clearance)
           VALUES (gen_random_uuid(), 'wss-doc', NULL, $1, 'app', 'doc', 'internal')
           RETURNING id`,
          [ws],
        )
      ).rows[0].id
      // A second, different non-primary assistant (standard) — the
      // siloing control. kind!='app' so no app_type is required by the
      // `assistant_kind_app_type_consistency` CHECK.
      otherAppId = (
        await client.query<{ id: string }>(
          `INSERT INTO assistants (id, name, owner_user_id, workspace_id, kind, clearance)
           VALUES (gen_random_uuid(), 'wss-standard', $1, $2, 'standard', 'internal')
           RETURNING id`,
          [userId, ws],
        )
      ).rows[0].id
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    if (!pool) return
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM memories WHERE workspace_id = $1', [ws])
      await client.query('DELETE FROM assistants WHERE workspace_id = $1', [ws])
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1', [ws])
      await client.query('DELETE FROM workspaces WHERE id = $1', [ws])
      await client.query('DELETE FROM users WHERE id = $1', [userId])
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('persists assistant_id = NULL for a primary writer (workspace_shared), preserving authorship', async () => {
    const mem = await createMemory({
      assistantId: primaryId,
      userId,
      workspaceId: ws,
      summary: PRIMARY_FACT,
      sensitivity: 'internal',
      createdByUserId: userId,
      createdByAssistantId: primaryId,
    })
    expect(mem.assistantId).toBeNull()
    // Provenance is independent of visibility — the authoring primary
    // is still recorded.
    expect(mem.createdByAssistantId).toBe(primaryId)
    expect(mem.userId).toBe(userId)
  })

  it('makes the primary memory visible to a non-primary (doc) assistant', async () => {
    const ctx: AccessContext = {
      workspaceId: ws,
      userId,
      assistantId: docId,
      assistantKind: 'app',
      clearance: 'internal',
    }
    const { rows } = await getMemoryIndexRanked(ctx, 100)
    expect(rows.some((r) => r.summary === PRIMARY_FACT)).toBe(true)
  })

  it('keeps a non-primary writer siloed (assistant_id = self), invisible to OTHER non-primary assistants', async () => {
    const mem = await createMemory({
      assistantId: docId,
      userId,
      workspaceId: ws,
      summary: APP_FACT,
      sensitivity: 'internal',
      createdByUserId: userId,
      createdByAssistantId: docId,
    })
    expect(mem.assistantId).toBe(docId)

    // A DIFFERENT non-primary assistant must NOT see the doc-authored
    // memory (still per-assistant siloed) ...
    const otherCtx: AccessContext = {
      workspaceId: ws,
      userId,
      assistantId: otherAppId,
      assistantKind: 'standard',
      clearance: 'internal',
    }
    const { rows } = await getMemoryIndexRanked(otherCtx, 100)
    expect(rows.some((r) => r.summary === APP_FACT)).toBe(false)
    // ... but it DOES still see the primary's workspace_shared memory.
    expect(rows.some((r) => r.summary === PRIMARY_FACT)).toBe(true)
  })

  // ── Consolidation / soul ownership (system-worker reads) ───────────

  it('enumeration folds a primary null-author back to the primary id (never null)', async () => {
    const rows = await listMemoryUsers()
    // The primary's workspace_shared memory must surface under the
    // primary's REAL id so the worker writes user_souls / consolidation_logs
    // (both assistant_id NOT NULL) with a concrete id — not as a (null, user)
    // pair.
    expect(rows.some((r) => r.assistantId === primaryId && r.userId === userId)).toBe(true)
    expect(rows.every((r) => r.assistantId !== null)).toBe(true)
  })

  it('system reads: the primary consolidates its workspace_shared rows; siblings do not', async () => {
    // The primary's system index INCLUDES its workspace_shared (null) rows.
    const primaryIdx = await getMemoryIndexSystem(primaryId, userId)
    expect(primaryIdx.some((r) => r.summary === PRIMARY_FACT)).toBe(true)
    // A sibling (doc) must NOT pull the primary's shared rows into its
    // own consolidation/soul — that would duplicate REM connections and
    // pollute the sibling's soul.
    const docIdx = await getMemoryIndexSystem(docId, userId)
    expect(docIdx.some((r) => r.summary === PRIMARY_FACT)).toBe(false)
    // ... but the doc DOES consolidate its OWN (personal) memory.
    expect(docIdx.some((r) => r.summary === APP_FACT)).toBe(true)
  })
})
