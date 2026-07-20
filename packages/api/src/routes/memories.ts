/**
 * Memory management routes for the assistant detail page.
 *
 * Mounted at `/api/assistants/:assistantId/memories` behind requireAuth.
 * All queries use queryWithRLS so a user can only access memories on
 * assistants they are a member of.
 *
 * [COMP:api/memories-route]
 *
 *   GET    /                            — list memories (paginated, filterable)
 *                                          ?status=unverified&workspace_id=&limit=&cursor=
 *                                          — staged-memory review queue (LOCKED #2)
 *   GET    /stats                       — counts by type + total recalls
 *   GET    /soul                        — SOUL content (read-only)
 *   GET    /search?q=...                — FTS search
 *   GET    /:memoryId                   — single memory detail
 *   PATCH  /:memoryId                   — edit summary/detail/tags
 *   POST   /:memoryId/scope             — promote to team / demote to personal
 *   POST   /:memoryId/verify            — user confirms a model-saved memory
 *                                          (sets verified_by_user_id / verified_at;
 *                                          writes a memory_verifications row).
 *   POST   /:memoryId/adjust            — user adjusts scope/sensitivity/summary/detail
 *                                          (per-field memory_verifications rows;
 *                                          sets verified_by_user_id / verified_at).
 *   DELETE /:memoryId                   — delete a memory
 */

import { Router } from 'express'
import type { AccessContext, Sensitivity } from '@use-brian/core'
import {
  listMemories, getMemoryById, updateMemory, deleteMemory,
  searchMemories, getMemoryStats, getSoul,
  listWorkspaceMemories, searchWorkspaceMemories,
  createMemory,
  listUnverifiedByWorkspace,
  countUnverifiedByWorkspace,
  markVerifiedDirect,
} from '../db/memories.js'
import { query } from '../db/client.js'
import { queryWithRLS } from '../db/client.js'
import { getWorkspaceRoleSystem, resolveReadCeilingsSystem } from '../db/workspace-store.js'
import { recordVerification } from '../db/memory-verifications-store.js'
import { listMemoriesByRecentOutcome } from '../db/memory-recall-events-store.js'
import { notifyBrainInboxChange } from '../brain-stream/notify.js'

type AssistantParams = { assistantId: string }
type MemoryParams = { assistantId: string; memoryId: string }

/**
 * Build the viewer's `AccessContext` from the route's
 * `(userId, assistantId)` pair. Fetches the assistant's workspace +
 * clearance (one extra query per request). Returns `null` if the
 * assistant is missing — caller should 404.
 */
async function resolveViewerCtx(
  userId: string,
  assistantId: string,
): Promise<AccessContext | null> {
  const result = await query<{
    workspaceId: string | null
    clearance: Sensitivity
    compartments: string[] | null
    kind: AccessContext['assistantKind']
  }>(
    `SELECT workspace_id AS "workspaceId", clearance, compartments, kind FROM assistants WHERE id = $1`,
    [assistantId],
  )
  const row = result.rows[0]
  if (!row) return null
  // Read-side ceilings (incident 2026-06-01 + compartment axis): this REST
  // surface lists a workspace assistant's memories to any member. Bound the
  // read ceiling to the acting member (`min(member, assistant)` clearance +
  // `member ∩ assistant` compartments) so a member can't read above their tier
  // or outside their compartments via a broader assistant. Read-only — no write
  // ceiling needed.
  const { clearance, compartments } = await resolveReadCeilingsSystem(
    userId,
    row.workspaceId,
    row.clearance,
    row.compartments,
  )
  return {
    workspaceId: row.workspaceId ?? '',
    userId,
    assistantId,
    assistantKind: row.kind,
    clearance,
    compartments,
  }
}

export function memoryRoutes(): Router {
  const router = Router({ mergeParams: true })

  /**
   * Verify the authenticated user is a member of this assistant.
   * Returns the userId or sends 401/403 and returns null.
   */
  async function verifyMembership(
    req: { userId?: string; params: AssistantParams },
    res: import('express').Response,
  ): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const { assistantId } = req.params

    const result = await queryWithRLS<{ ok: number }>(
      userId,
      // Personal: assistant_members. Team (post-089): workspace_members for
      // the assistant's owning team.
      `SELECT 1 AS ok
       WHERE EXISTS (
         SELECT 1 FROM assistant_members am
         WHERE am.assistant_id = $1 AND am.user_id = $2
       )
       OR EXISTS (
         SELECT 1 FROM assistants a
         JOIN workspace_members tm ON tm.workspace_id = a.workspace_id
         WHERE a.id = $1 AND tm.user_id = $2
       )`,
      [assistantId, userId],
    )
    if (result.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this assistant' })
      return null
    }
    return userId
  }

  /**
   * Verify access to team-scoped routes. Team-owned `kind='app'` assistants
   * (e.g. the feed app) don't carry a row per team-member in
   * `assistant_members` — access flows through `workspace_members`. Accept either
   * direct assistant membership or team membership; fall back to 403 only
   * when neither path matches.
   *
   * Returns `{ userId, workspaceId }` on success (workspaceId is null when the
   * assistant is not team-owned, in which case access required direct
   * assistant membership). Sends 401/403/404 and returns null otherwise.
   */
  async function verifyTeamAccess(
    req: { userId?: string; params: AssistantParams },
    res: import('express').Response,
  ): Promise<{ userId: string; workspaceId: string | null } | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const { assistantId } = req.params

    const assistantResult = await query<{ workspaceId: string | null }>(
      `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
      [assistantId],
    )
    if (assistantResult.rows.length === 0) {
      res.status(404).json({ error: 'Assistant not found' })
      return null
    }
    const workspaceId = assistantResult.rows[0].workspaceId

    if (workspaceId) {
      const role = await getWorkspaceRoleSystem(userId, workspaceId)
      if (role) return { userId, workspaceId }
    }

    const memberResult = await queryWithRLS<{ user_id: string }>(
      userId,
      `SELECT user_id FROM assistant_members
       WHERE assistant_id = $1 AND user_id = $2`,
      [assistantId, userId],
    )
    if (memberResult.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this assistant or its team' })
      return null
    }
    return { userId, workspaceId }
  }

  // ── List memories (paginated, filterable) ──────────────────────

  router.get<AssistantParams>('/', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId } = req.params
    // Post-Phase-4 (retire-memory-type): `type` query param maps to a
    // tag-narrowing filter — callers that filtered by `type=preference`
    // can switch to `tag=preference` (or some other meaningful tag).
    // Old `type=...` URLs gracefully degrade to the unfiltered list.
    const tag = req.query.tag as string | undefined
    const scope = req.query.scope as string | undefined
    const status = req.query.status as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    try {
      const ctx = await resolveViewerCtx(userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }

      // Staged-memory review queue (LOCKED #2 — mig 165). When the caller
      // passes `status=unverified`, switch to the partial-index scan and
      // surface every model-saved memory in the workspace that no user
      // has acknowledged yet. Pagination uses an opaque cursor instead
      // of offset because the underlying set drains as users confirm.
      //
      // Optional `?include=bad_outcome` (LOCKED #2 item (d), mig 167):
      // narrow the queue to unverified memories that have been recalled
      // in the last 30 days AND drew negative feedback / corrections on
      // at least 2 of those recalls. These are the memories the staged
      // review surface marks "Frequently led to bad responses" — the
      // implicit complement to the explicit verify/adjust flow.
      if (status === 'unverified') {
        if (!ctx.workspaceId) {
          res.json({ memories: [], cursor: null })
          return
        }
        let cursor: { createdAt: Date; id: string } | undefined
        const rawCursor = req.query.cursor as string | undefined
        if (rawCursor) {
          try {
            const decoded = JSON.parse(Buffer.from(rawCursor, 'base64').toString('utf8'))
            if (decoded && typeof decoded.createdAt === 'string' && typeof decoded.id === 'string') {
              cursor = { createdAt: new Date(decoded.createdAt), id: decoded.id }
            }
          } catch {
            // Malformed cursor restarts from head — same posture as opaque
            // cursors elsewhere in the codebase. No error to caller.
          }
        }

        const include = req.query.include as string | undefined
        const wantBadOutcome = include === 'bad_outcome'

        let badOutcomeIds: Set<string> | null = null
        const outcomeScores = new Map<
          string,
          { recallCount: number; negativeCount: number; correctionCount: number }
        >()
        if (wantBadOutcome) {
          // Compute the bad-outcome set first (small — capped by recall
          // events in the 30d window), then filter the unverified list
          // against it. Two queries, but the second drains the
          // unverified partial-index scan as normal and just discards
          // misses. Cheaper than a single composite query that always
          // pays for the JOIN even when the include flag is absent.
          const scored = await listMemoriesByRecentOutcome({
            workspaceId: ctx.workspaceId,
            windowDays: 30,
            sentimentFilter: 'negative',
            minBadCount: 2,
          })
          badOutcomeIds = new Set(scored.map((s) => s.memoryId))
          for (const s of scored) {
            outcomeScores.set(s.memoryId, {
              recallCount: s.recallCount,
              negativeCount: s.negativeCount,
              correctionCount: s.correctionCount,
            })
          }
          if (badOutcomeIds.size === 0) {
            res.json({ memories: [], cursor: null })
            return
          }
        }

        const rows = await listUnverifiedByWorkspace(ctx.workspaceId, limit, cursor)
        const filteredRows = badOutcomeIds
          ? rows.filter((r) => badOutcomeIds!.has(r.id)).map((r) => ({
              ...r,
              outcomeScore: outcomeScores.get(r.id) ?? null,
            }))
          : rows
        const nextCursor = rows.length === limit
          ? Buffer.from(
              JSON.stringify({
                createdAt: rows[rows.length - 1].createdAt.toISOString(),
                id: rows[rows.length - 1].id,
              }),
            ).toString('base64')
          : null
        res.json({ memories: filteredRows, cursor: nextCursor })
        return
      }

      const { memories, total } = await listMemories(ctx, { tag, scope, limit, offset })
      res.json({ memories, total, limit, offset })
    } catch (err) {
      console.error('[memories] list failed:', err)
      res.status(500).json({ error: 'Failed to list memories' })
    }
  })

  // ── Stats ──────────────────────────────────────────────────────

  router.get<AssistantParams>('/stats', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId } = req.params

    try {
      const ctx = await resolveViewerCtx(userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const stats = await getMemoryStats(ctx)
      res.json(stats)
    } catch (err) {
      console.error('[memories] stats failed:', err)
      res.status(500).json({ error: 'Failed to get memory stats' })
    }
  })

  // ── SOUL (read-only) ──────────────────────────────────────────

  router.get<AssistantParams>('/soul', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId } = req.params

    try {
      const soul = await getSoul(assistantId, userId)
      res.json({ soul })
    } catch (err) {
      console.error('[memories] soul failed:', err)
      res.status(500).json({ error: 'Failed to get SOUL' })
    }
  })

  // ── Search ─────────────────────────────────────────────────────

  router.get<AssistantParams>('/search', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId } = req.params
    const q = req.query.q as string
    if (!q || !q.trim()) {
      res.status(400).json({ error: 'Query parameter q is required' })
      return
    }

    try {
      const ctx = await resolveViewerCtx(userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const memories = await searchMemories(ctx, { searchQuery: q.trim(), limit: 20 })
      res.json({ memories })
    } catch (err) {
      console.error('[memories] search failed:', err)
      res.status(500).json({ error: 'Failed to search memories' })
    }
  })

  // ── Team memories list ──────────────────────────────────────────
  // NOTE: Must be before /:memoryId to avoid Express matching "team" as memoryId.

  router.get<AssistantParams>('/team', async (req, res) => {
    const access = await verifyTeamAccess(req, res)
    if (!access) return
    const { assistantId } = req.params
    const { workspaceId } = access
    // Post-Phase-4: tag-based filter replaces type-based filter.
    const tag = req.query.tag as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    if (!workspaceId) {
      res.json({ memories: [], total: 0, limit, offset })
      return
    }

    try {
      const ctx = await resolveViewerCtx(access.userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const { memories, total } = await listWorkspaceMemories(ctx, { tag, limit, offset })
      res.json({ memories, total, limit, offset })
    } catch (err) {
      console.error('[memories] team list failed:', err)
      res.status(500).json({ error: 'Failed to list team memories' })
    }
  })

  // ── Team memory create (team voice) ────────────────────────────
  //
  // Admin-only. Creates a team-scoped memory keyed on this assistant +
  // the assistant's team. Intended for "team voice" curation on the team
  // page — admins type concrete voice notes ("we always sign off with —
  // the DeltaDeFi team", "never use the word 'leverage'") and those land
  // as team identity memories. Distribution L5 draft generation pulls them
  // in via `getWorkspaceIdentity`.
  //
  // See docs/architecture/feed/defense-pipeline.md → "Team voice".

  router.post<AssistantParams>('/team', async (req, res) => {
    const access = await verifyTeamAccess(req, res)
    if (!access) return
    const { userId, workspaceId } = access
    const { assistantId } = req.params

    const { summary, detail, tags, sensitivity, type } = req.body as {
      summary?: string
      detail?: string
      tags?: string[]
      sensitivity?: string
      type?: string
    }

    if (typeof summary !== 'string' || summary.trim().length === 0) {
      res.status(400).json({ error: 'summary is required' })
      return
    }
    if (summary.length > 500) {
      res.status(400).json({ error: 'summary must be 500 characters or less' })
      return
    }

    if (!workspaceId) {
      res.status(400).json({ error: 'Assistant is not team-owned' })
      return
    }

    const role = await getWorkspaceRoleSystem(userId, workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Team admin or owner required' })
      return
    }

    const sensitivityTier: 'public' | 'internal' | 'confidential' =
      sensitivity === 'public' || sensitivity === 'internal' || sensitivity === 'confidential'
        ? sensitivity
        : 'internal'

    // Post-Phase-4 (retire-memory-type): `type` field gone; legacy
    // callers passing `type='identity'` should switch to
    // `updateSelfProfile` for self-facts. The body's `type` param is
    // honoured as a tag here so old clients don't break — it lands in
    // tags as a single string.
    const tagsList = Array.isArray(tags)
      ? tags.slice(0, 12).map(String)
      : ['voice']
    if (typeof type === 'string' && type.length > 0 && !tagsList.includes(type)) {
      tagsList.push(type)
    }

    try {
      const memory = await createMemory({
        assistantId,
        userId,                 // author = acting admin
        workspaceId,
        scope: 'workspace',
        tags: tagsList,
        summary: summary.trim(),
        detail: typeof detail === 'string' && detail.trim().length > 0 ? detail.trim() : undefined,
        sensitivity: sensitivityTier,
        source: 'manual',
        createdByUserId: userId,
      })
      res.status(201).json({ memory })
    } catch (err) {
      console.error('[memories] team create failed:', err)
      res.status(500).json({ error: 'Failed to create team memory' })
    }
  })

  // ── Team memories search ───────────────────────────────────────

  router.get<AssistantParams>('/team/search', async (req, res) => {
    const access = await verifyTeamAccess(req, res)
    if (!access) return
    const { assistantId } = req.params
    const { workspaceId } = access
    const q = req.query.q as string
    if (!q || !q.trim()) {
      res.status(400).json({ error: 'Query parameter q is required' })
      return
    }

    if (!workspaceId) {
      res.json({ memories: [] })
      return
    }

    try {
      const ctx = await resolveViewerCtx(access.userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const memories = await searchWorkspaceMemories(ctx, { searchQuery: q.trim(), limit: 20 })
      res.json({ memories })
    } catch (err) {
      console.error('[memories] team search failed:', err)
      res.status(500).json({ error: 'Failed to search team memories' })
    }
  })

  // ── Get single memory ─────────────────────────────────────────

  router.get<MemoryParams>('/:memoryId', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return

    try {
      const ctx = await resolveViewerCtx(userId, req.params.assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const memory = await getMemoryById(ctx, req.params.memoryId)
      if (!memory) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      res.json({ memory })
    } catch (err) {
      console.error('[memories] get failed:', err)
      res.status(500).json({ error: 'Failed to get memory' })
    }
  })

  // ── Edit memory ────────────────────────────────────────────────

  router.patch<MemoryParams>('/:memoryId', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { summary, detail, tags, sensitivity } = req.body as {
      summary?: string
      detail?: string
      tags?: string[]
      sensitivity?: string
    }

    if (summary === undefined && detail === undefined && tags === undefined && sensitivity === undefined) {
      res.status(400).json({ error: 'At least one field (summary, detail, tags, sensitivity) is required' })
      return
    }

    let sensitivityTier: 'public' | 'internal' | 'confidential' | undefined
    if (sensitivity !== undefined) {
      if (sensitivity !== 'public' && sensitivity !== 'internal' && sensitivity !== 'confidential') {
        res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
        return
      }
      sensitivityTier = sensitivity
    }

    try {
      // Scope the edit to memories this caller may read — unlike the promote/
      // demote and reclassify handlers, this route went straight to
      // updateMemory with no prior getMemoryById(ctx) check, so a member could
      // edit another user's/workspace's memory by id (WS3 read/write
      // asymmetry). resolveViewerCtx returns null for an assistant the user
      // can't access → 404.
      const ctx = await resolveViewerCtx(userId, req.params.assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      const memory = await updateMemory(req.params.memoryId, { summary, detail, tags, sensitivity: sensitivityTier }, ctx)
      if (!memory) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      // Realtime repaint so open /brain pages reflect the edit. updateMemory
      // supersedes the row — notify the new active id.
      void notifyBrainInboxChange(memory.workspaceId, 'memory', memory.id, 'update')
      res.json({ memory })
    } catch (err) {
      console.error('[memories] update failed:', err)
      res.status(500).json({ error: 'Failed to update memory' })
    }
  })

  // ── Change memory scope (promote to team / demote to personal) ─
  //
  // A user can only change the scope of memories they authored, even if
  // a teammate is a team owner/admin — widening visibility is the writer's
  // call, not the operator's. The assistant must be team-owned for either
  // direction to make sense; a solo assistant has no team to promote into.
  //
  // Idempotent: if the memory is already in the target scope, returns 200
  // with the current row unchanged — the UI can flip the button state
  // optimistically without worrying about double-clicks.

  router.post<MemoryParams>('/:memoryId/scope', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId, memoryId } = req.params
    const { scope } = req.body as { scope?: string }

    if (scope !== 'workspace' && scope !== 'user') {
      res.status(400).json({ error: 'scope must be "team" or "user"' })
      return
    }

    // Fetch assistant first so the (workspace + clearance) → viewer
    // ctx is available for `getMemoryById`. The existing
    // `assistantTeamId` check below reuses the same row — one query,
    // not two.
    const assistantResult = await query<{
      workspaceId: string | null
      clearance: Sensitivity
      kind: AccessContext['assistantKind']
    }>(
      `SELECT workspace_id AS "workspaceId", clearance, kind FROM assistants WHERE id = $1`,
      [assistantId],
    )
    const assistantRow = assistantResult.rows[0]
    if (!assistantRow) {
      res.status(404).json({ error: 'Assistant not found' })
      return
    }
    const assistantTeamId = assistantRow.workspaceId
    const ctx: AccessContext = {
      workspaceId: assistantRow.workspaceId ?? '',
      userId,
      assistantId,
      assistantKind: assistantRow.kind,
      clearance: assistantRow.clearance,
    }
    const memory = await getMemoryById(ctx, memoryId)
    if (!memory || memory.assistantId !== assistantId) {
      res.status(404).json({ error: 'Memory not found' })
      return
    }
    if (memory.userId !== userId) {
      res.status(403).json({ error: 'You can only change the scope of memories you authored' })
      return
    }
    if (!assistantTeamId) {
      res.status(400).json({ error: 'Assistant is not part of a team' })
      return
    }

    // Idempotent short-circuit.
    if (scope === 'workspace' && memory.scope === 'workspace' && memory.workspaceId === assistantTeamId) {
      res.json({ memory })
      return
    }
    if (scope === 'user' && memory.scope !== 'workspace') {
      res.json({ memory })
      return
    }

    // Team-role gate — only members of the team itself can move memories
    // in or out of team visibility. Assistant membership alone is not
    // sufficient (a solo member adopted into a team assistant still needs
    // a workspace_members row).
    const teamRole = await getWorkspaceRoleSystem(userId, assistantTeamId)
    if (!teamRole) {
      res.status(403).json({ error: 'Not a member of this team' })
      return
    }

    try {
      const updated =
        scope === 'workspace'
          ? await updateMemory(memoryId, { scope: 'workspace', workspaceId: assistantTeamId })
          : await updateMemory(memoryId, { scope: 'shared', workspaceId: null })
      if (!updated) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      // Realtime repaint. Scope to the assistant's workspace (always non-null
      // here — the not-on-a-team case 400'd above) so both promote and demote
      // reach the workspace's open /brain pages, even when the new row's own
      // workspaceId was just cleared by a demotion.
      void notifyBrainInboxChange(assistantTeamId, 'memory', updated.id, 'update')
      res.json({ memory: updated })
    } catch (err) {
      console.error('[memories] scope change failed:', err)
      res.status(500).json({ error: 'Failed to change memory scope' })
    }
  })

  // ── Confirm a model-saved memory (staged-memory review) ────────
  //
  // User confirms the model's save as-is. Stamps `verified_by_user_id`
  // + `verified_at` on the memory and writes a `confirm` row to
  // `memory_verifications`. Idempotent: confirming a memory that was
  // already verified by this user reads as a no-op (returns 200 with
  // the existing row, no new audit event).
  //
  // LOCKED #2 — staged-memory feedback loop. See
  // docs/architecture/brain/corrections.md → "User verification
  // surface".

  router.post<MemoryParams>('/:memoryId/verify', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId, memoryId } = req.params

    try {
      const ctx = await resolveViewerCtx(userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const memory = await getMemoryById(ctx, memoryId)
      if (!memory || memory.assistantId !== assistantId) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      // Idempotent — already-verified rows short-circuit so a UI double-tap
      // doesn't append a duplicate `confirm` audit event.
      if (memory.verifiedByUserId) {
        res.json({ memory })
        return
      }
      if (!memory.workspaceId) {
        res.status(400).json({ error: 'Memory is not workspace-partitioned' })
        return
      }
      const stamped = await markVerifiedDirect(memoryId, userId)
      if (!stamped) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      await recordVerification({
        memoryId,
        workspaceId: memory.workspaceId,
        verifiedBy: userId,
        action: 'confirm',
      })
      // Realtime repaint so the now-verified memory drops off the inbox queue
      // on other tabs / devices.
      void notifyBrainInboxChange(memory.workspaceId, 'memory', memoryId, 'update')
      res.json({ memory: stamped })
    } catch (err) {
      console.error('[memories] verify failed:', err)
      res.status(500).json({ error: 'Failed to verify memory' })
    }
  })

  // ── Adjust a model-saved memory (staged-memory review) ─────────
  //
  // User changes one or more of scope/sensitivity/summary/detail on a
  // model-saved memory. Each changed field becomes one row in
  // `memory_verifications` carrying the (model_value → user_value)
  // transition for that field; the memory row itself supersedes
  // through `updateMemory` (carrying authorship + original_* forward).
  // The new active row is then stamped with `verified_by_user_id` +
  // `verified_at` via `markVerifiedDirect`.
  //
  // Allowed fields:
  //   `scope`        — 'shared' (personal scope) | 'workspace_shared'
  //                    | 'workspace'. The first two are persisted as
  //                    `scope='shared'` (workspace_shared = visible to
  //                    your own assistants, workspace = visible to
  //                    everyone in the workspace). The store column
  //                    accepts 'shared' | 'workspace' today; the third
  //                    UI choice maps onto the same DB scope until a
  //                    follow-up adds an explicit visibility band.
  //   `sensitivity`  — 'internal' | 'confidential'  (the only two
  //                    user-adjustable tiers; 'public' is operator-only
  //                    per sensitivity.md)
  //   `summary`      — short surface text
  //   `detail`       — optional long-form
  //   `reason`       — optional pedagogical note, attached to every
  //                    field-row written in this call
  //
  // Sends 400 if the payload has no recognised field changes; sends
  // 404 if the memory isn't on this assistant; sends 403 on membership
  // fail (via verifyMembership).
  //
  // LOCKED #2. See docs/architecture/brain/corrections.md → "User
  // verification surface".

  router.post<MemoryParams>('/:memoryId/adjust', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return
    const { assistantId, memoryId } = req.params
    const { scope, sensitivity, summary, detail, reason } = req.body as {
      scope?: string
      sensitivity?: string
      summary?: string
      detail?: string
      reason?: string
    }

    // Validate inputs up front so we never mint a partial audit trail
    // before bailing on a downstream type error.
    let nextScope: 'shared' | 'workspace' | undefined
    let nextWorkspaceId: string | null | undefined
    let scopeUserValue: 'personal' | 'workspace_shared' | 'workspace' | undefined
    if (scope !== undefined) {
      if (scope === 'personal') {
        nextScope = 'shared'
        nextWorkspaceId = null
        scopeUserValue = 'personal'
      } else if (scope === 'workspace_shared') {
        nextScope = 'shared'
        scopeUserValue = 'workspace_shared'
      } else if (scope === 'workspace') {
        nextScope = 'workspace'
        scopeUserValue = 'workspace'
      } else {
        res
          .status(400)
          .json({ error: 'scope must be personal, workspace_shared, or workspace' })
        return
      }
    }

    let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
    if (sensitivity !== undefined) {
      if (sensitivity !== 'public' && sensitivity !== 'internal' && sensitivity !== 'confidential') {
        res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
        return
      }
      nextSensitivity = sensitivity
    }

    let nextSummary: string | undefined
    if (summary !== undefined) {
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        res.status(400).json({ error: 'summary must be a non-empty string' })
        return
      }
      if (summary.length > 500) {
        res.status(400).json({ error: 'summary must be 500 characters or less' })
        return
      }
      nextSummary = summary.trim()
    }

    let nextDetail: string | undefined
    if (detail !== undefined) {
      if (typeof detail !== 'string') {
        res.status(400).json({ error: 'detail must be a string' })
        return
      }
      nextDetail = detail
    }

    if (
      nextScope === undefined &&
      nextSensitivity === undefined &&
      nextSummary === undefined &&
      nextDetail === undefined
    ) {
      res.status(400).json({
        error:
          'At least one field (scope, sensitivity, summary, detail) is required',
      })
      return
    }

    try {
      const ctx = await resolveViewerCtx(userId, assistantId)
      if (!ctx) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const before = await getMemoryById(ctx, memoryId)
      if (!before || before.assistantId !== assistantId) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      if (!before.workspaceId) {
        res.status(400).json({ error: 'Memory is not workspace-partitioned' })
        return
      }

      // Default `workspaceId` for workspace/workspace_shared scope to the
      // assistant's own workspace; explicit personal scope clears it.
      const computedWorkspaceId =
        nextWorkspaceId === null
          ? null
          : nextScope !== undefined
            ? before.workspaceId
            : undefined

      const updated = await updateMemory(memoryId, {
        scope: nextScope,
        workspaceId: computedWorkspaceId,
        sensitivity: nextSensitivity,
        summary: nextSummary,
        detail: nextDetail,
      })
      if (!updated) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }

      // Per-field audit envelope. `model_value` is read from the row
      // pre-supersession; `original_scope` etc. on `memories` carry the
      // first-save snapshot so the row's lineage stays intact.
      const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
      const writes: Promise<unknown>[] = []
      if (nextScope !== undefined) {
        const modelScope =
          before.scope === 'workspace'
            ? 'workspace'
            : before.workspaceId
              ? 'workspace_shared'
              : 'personal'
        if (modelScope !== scopeUserValue) {
          writes.push(
            recordVerification({
              memoryId,
              workspaceId: updated.workspaceId ?? before.workspaceId,
              verifiedBy: userId,
              action: 'adjust_scope',
              modelValue: modelScope,
              userValue: scopeUserValue,
              reason: reasonText,
            }),
          )
        }
      }
      if (nextSensitivity !== undefined && nextSensitivity !== before.sensitivity) {
        writes.push(
          recordVerification({
            memoryId,
            workspaceId: updated.workspaceId ?? before.workspaceId,
            verifiedBy: userId,
            action: 'adjust_sensitivity',
            modelValue: before.sensitivity,
            userValue: nextSensitivity,
            reason: reasonText,
          }),
        )
      }
      if (
        (nextSummary !== undefined && nextSummary !== before.summary) ||
        (nextDetail !== undefined && nextDetail !== before.detail)
      ) {
        writes.push(
          recordVerification({
            memoryId,
            workspaceId: updated.workspaceId ?? before.workspaceId,
            verifiedBy: userId,
            action: 'edit_summary',
            modelValue: { summary: before.summary, detail: before.detail },
            userValue: {
              summary: nextSummary ?? before.summary,
              detail: nextDetail ?? before.detail,
            },
            reason: reasonText,
          }),
        )
      }
      await Promise.all(writes)

      // Supersession minted a new row id — stamp verification on the new
      // active row so the next call to listUnverifiedByWorkspace
      // (workspace pill, review page) drops it from the queue.
      const stamped = await markVerifiedDirect(updated.id, userId)
      // Realtime repaint for the adjusted (now-verified) memory row.
      void notifyBrainInboxChange(
        updated.workspaceId ?? before.workspaceId,
        'memory',
        updated.id,
        'update',
      )
      res.json({ memory: stamped ?? updated })
    } catch (err) {
      console.error('[memories] adjust failed:', err)
      res.status(500).json({ error: 'Failed to adjust memory' })
    }
  })

  // ── Delete memory ──────────────────────────────────────────────

  router.delete<MemoryParams>('/:memoryId', async (req, res) => {
    const userId = await verifyMembership(req, res)
    if (!userId) return

    try {
      // Capture the workspace before the row is gone — `deleteMemory` returns
      // only a boolean, and we need a workspaceId to scope the realtime NOTIFY
      // below. A null workspace (personal memory) just no-ops the notify.
      const wsLookup = await query<{ workspaceId: string | null }>(
        `SELECT workspace_id AS "workspaceId" FROM memories WHERE id = $1`,
        [req.params.memoryId],
      )
      const workspaceId = wsLookup.rows[0]?.workspaceId ?? null

      const deleted = await deleteMemory(req.params.memoryId)
      if (!deleted) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      // Realtime repaint so the deleted memory drops off open /brain pages.
      void notifyBrainInboxChange(workspaceId, 'memory', req.params.memoryId, 'delete')
      res.status(204).end()
    } catch (err) {
      console.error('[memories] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete memory' })
    }
  })

  return router
}
