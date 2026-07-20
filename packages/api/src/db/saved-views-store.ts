/**
 * Saved views store, backed by PostgreSQL (migration 120 + 184).
 *
 * Workspace-scoped persisted view definitions for the Q5 Views feature.
 * Stores BindingConfig JSON; the A2UI ViewPayload is rebuilt on read by
 * the bindings catalog (`packages/core/src/views/bindings.ts`).
 *
 * Migration 184 adds the Notion-redesign columns: `page JSONB`, `state`,
 * `auto_prune_at`. The legacy `binding` column stays alongside as a
 * single-source-of-truth for pre-redesign rows; the new readers prefer
 * `page` when present.
 *
 * RLS via the `saved_views_workspace_member` policy — every workspace
 * member can read / write saved views in their workspaces. System bypass
 * available for boot-time seeding and for the prune worker.
 *
 * [COMP:api/saved-views-store]
 */

import type {
  BindingConfig,
  CreateDraftInput,
  NameOrigin,
  Page,
  PageLifecycleEvent,
  SavedView,
  SavedViewListFilters,
  SavedViewListRow,
  SavedViewStore,
  SavedViewUpdateFields,
  ViewEntity,
  ViewState,
  ViewType,
} from '@use-brian/core'
import { getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'

// ── SQL projections ───────────────────────────────────────────────────

const FULL_SELECT = `
  id,
  workspace_id   AS "workspaceId",
  created_by     AS "createdBy",
  name,
  name_origin    AS "nameOrigin",
  description,
  icon,
  entity,
  view_type      AS "viewType",
  binding,
  page,
  state,
  nest_parent_id AS "nestParentId",
  position,
  teamspace_id   AS "teamspaceId",
  full_width     AS "fullWidth",
  clearance,
  origin_prompt  AS "originPrompt",
  anchor_key     AS "anchorKey",
  linked_recording_id AS "linkedRecordingId",
  auto_prune_at  AS "autoPruneAt",
  brain_sync_enabled   AS "brainSyncEnabled",
  brain_last_ingest_hash AS "brainLastIngestHash",
  brain_last_ingest_at AS "brainLastIngestAt",
  created_event_pending AS "createdEventPending",
  created_at     AS "createdAt",
  updated_at     AS "updatedAt"
`

const LIST_SELECT = `
  id,
  workspace_id   AS "workspaceId",
  name,
  name_origin    AS "nameOrigin",
  description,
  icon,
  entity,
  view_type      AS "viewType",
  state,
  nest_parent_id AS "nestParentId",
  position,
  teamspace_id   AS "teamspaceId",
  updated_at     AS "updatedAt"
`

type FullRow = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  nameOrigin: NameOrigin
  description: string | null
  icon: string | null
  entity: ViewEntity
  viewType: ViewType
  binding: BindingConfig
  page: Page | null
  state: ViewState
  nestParentId: string | null
  position: number
  teamspaceId: string | null
  fullWidth: boolean
  clearance: 'public' | 'internal' | 'confidential'
  anchorKey: string | null
  linkedRecordingId: string | null
  originPrompt: string | null
  autoPruneAt: Date | null
  brainSyncEnabled: boolean
  brainLastIngestHash: string | null
  brainLastIngestAt: Date | null
  createdEventPending: boolean
  createdAt: Date
  updatedAt: Date
}

type ListRow = {
  id: string
  workspaceId: string
  name: string
  nameOrigin: NameOrigin
  description: string | null
  icon: string | null
  entity: ViewEntity
  viewType: ViewType
  state: ViewState
  nestParentId: string | null
  position: number
  teamspaceId: string | null
  anchorKey: string | null
  updatedAt: Date
}

function rowToFull(row: FullRow): SavedView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy,
    name: row.name,
    nameOrigin: row.nameOrigin,
    description: row.description,
    icon: row.icon,
    anchorKey: row.anchorKey ?? null,
    linkedRecordingId: row.linkedRecordingId ?? null,
    entity: row.entity,
    viewType: row.viewType,
    binding: row.binding,
    page: row.page,
    state: row.state,
    nestParentId: row.nestParentId,
    position: row.position,
    teamspaceId: row.teamspaceId,
    fullWidth: row.fullWidth,
    clearance: row.clearance,
    originPrompt: row.originPrompt,
    autoPruneAt: row.autoPruneAt,
    brainSyncEnabled: row.brainSyncEnabled,
    brainLastIngestHash: row.brainLastIngestHash,
    brainLastIngestAt: row.brainLastIngestAt,
    createdEventPending: row.createdEventPending,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToList(row: ListRow): SavedViewListRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    nameOrigin: row.nameOrigin,
    description: row.description,
    icon: row.icon,
    entity: row.entity,
    viewType: row.viewType,
    state: row.state,
    nestParentId: row.nestParentId,
    position: row.position,
    teamspaceId: row.teamspaceId,
    updatedAt: row.updatedAt,
  }
}

const DEFAULT_DRAFT_TTL_DAYS = 30

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + days)
  return out
}

// ── Page-tree cycle guard (migration 210) ─────────────────────────────

/**
 * Pure cycle-guard for `reparent`. Returns `true` if filing `movingId`
 * under `newParentId` would create a loop in the nest-parent tree.
 *
 * A move is a cycle when:
 *   - `newParentId === movingId` (a page can't be its own parent), or
 *   - `movingId` is an ancestor of `newParentId` — i.e. walking up from
 *     `newParentId` via `parentOf` eventually reaches `movingId`. Reparenting
 *     under one of your own descendants would orphan the in-between chain.
 *
 * `parentOf` returns the `nest_parent_id` of a page (or `null` for a root /
 * `undefined` for unknown). The store builds this lookup by reading the
 * ancestor chain; tests can pass a plain map so the guard has a fast,
 * DB-free unit test.
 *
 * The walk is bounded by `maxDepth` (default 10_000) as a belt-and-braces
 * stop in case the persisted tree is already corrupt (a pre-existing cycle):
 * we treat hitting the bound as "cycle" so a corrupt tree can't hang the
 * reparent.
 */
export function reparentWouldCycle(
  movingId: string,
  newParentId: string | null,
  parentOf: (pageId: string) => string | null | undefined,
  maxDepth = 10_000,
): boolean {
  if (newParentId === null) return false // promoting to root is always safe
  if (newParentId === movingId) return true

  let cursor: string | null | undefined = newParentId
  let steps = 0
  while (cursor != null) {
    if (cursor === movingId) return true
    if (++steps > maxDepth) return true // corrupt tree — refuse the move
    cursor = parentOf(cursor)
  }
  return false
}

// ── Factory ───────────────────────────────────────────────────────────

/** Construction deps for the saved-views store. */
export type DbSavedViewStoreDeps = {
  /**
   * Best-effort page-lifecycle sink — fired after a successful create / update
   * / move so the workflow event-trigger dispatcher can run `page`-source
   * workflows. Synchronous and fire-and-forget by contract (the store does not
   * await it); a thrown error is swallowed so it never fails a page write.
   * Wired to `publishPageLifecycle` (`../page-event-fanout.ts`) at boot;
   * absent in tests and open builds with no dispatcher.
   */
  onPageLifecycle?: (event: PageLifecycleEvent) => void
}

export function createDbSavedViewStore(
  deps: DbSavedViewStoreDeps = {},
): SavedViewStore {
  // Best-effort emit — a broken sink must never break a page write.
  const emitLifecycle = (event: PageLifecycleEvent): void => {
    if (!deps.onPageLifecycle) return
    try {
      deps.onPageLifecycle(event)
    } catch {
      // swallow — the page write already succeeded
    }
  }
  return {
    async create({ userId, workspaceId, name, description, binding, writtenBy }) {
      // Manual /views/new — defaults to 'saved' (the user explicitly
      // created the view through the form). No auto-prune timestamp.
      // Page is seeded as a one-block data page so the new readers can
      // round-trip without a binding fallback.
      const page: Page = {
        blocks: [
          {
            kind: 'data',
            id: crypto.randomUUID(),
            binding,
          },
        ],
      }
      const result = await queryWithRLS<FullRow>(
        userId,
        // `name_origin = 'user'` — the /views/new form always carries a
        // user-chosen name, so it's never auto-title-eligible.
        // `teamspace_id` defaults to the workspace's General teamspace
        // (migration 313) so a programmatic root create stays team-visible.
        `INSERT INTO saved_views
           (workspace_id, created_by, name, name_origin, description, entity, view_type, binding, page, state, auto_prune_at, teamspace_id)
         VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, $8, 'saved', NULL,
           (SELECT t.id FROM teamspaces t WHERE t.workspace_id = $1 AND t.is_default = true))
         RETURNING ${FULL_SELECT}`,
        [
          workspaceId,
          userId,
          name,
          description ?? null,
          binding.entity,
          binding.viewType,
          JSON.stringify(binding),
          JSON.stringify(page),
        ],
      )
      const view = rowToFull(result.rows[0])
      emitLifecycle({
        workspaceId: view.workspaceId,
        pageId: view.id,
        parentId: view.nestParentId ?? null,
        title: view.name,
        actorId: userId,
        action: 'created',
        isSystem: writtenBy === 'system',
      })
      return view
    },

    async getById(userId, id) {
      const result = await queryWithRLS<FullRow>(
        userId,
        `SELECT ${FULL_SELECT} FROM saved_views WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToFull(result.rows[0]) : null
    },

    async list({ userId, workspaceId, entity, state, limit }) {
      const values: unknown[] = [workspaceId]
      let entityClause = ''
      if (entity) {
        values.push(entity)
        entityClause = ` AND entity = $${values.length}`
      }
      // Default to 'saved' — the sidebar lists saved views by default.
      // 'all' includes drafts (used by the /views home page when a user
      // wants to see "everything", e.g. recent drafts surfaced at top).
      let stateClause = ''
      const effectiveState: ViewState | 'all' = state ?? 'saved'
      if (effectiveState !== 'all') {
        values.push(effectiveState)
        stateClause = ` AND state = $${values.length}`
      }
      const cap = Math.min(limit ?? 100, 500)
      values.push(cap)
      const result = await queryWithRLS<ListRow>(
        userId,
        `SELECT ${LIST_SELECT} FROM saved_views
         WHERE workspace_id = $1${entityClause}${stateClause}
         ORDER BY updated_at DESC
         LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(rowToList)
    },

    async update(userId, id, fields: SavedViewUpdateFields, writtenBy) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (fields.name !== undefined) {
        sets.push(`name = $${idx++}`)
        values.push(fields.name)
      }
      if (fields.nameOrigin !== undefined) {
        // Stamped alongside a user-driven rename (`'user'`) to freeze the
        // title against auto-title. The placeholder→auto transition uses
        // the dedicated guarded `setAutoTitle` instead. See migration 218.
        sets.push(`name_origin = $${idx++}`)
        values.push(fields.nameOrigin)
      }
      if (fields.description !== undefined) {
        sets.push(`description = $${idx++}`)
        values.push(fields.description)
      }
      if (fields.icon !== undefined) {
        // `null` clears the icon (back to a derived glyph); a string sets it.
        sets.push(`icon = $${idx++}`)
        values.push(fields.icon)
      }
      if (fields.fullWidth !== undefined) {
        // Notion-style per-page width toggle (migration 220).
        sets.push(`full_width = $${idx++}`)
        values.push(fields.fullWidth)
      }
      if (fields.clearance !== undefined) {
        // Page-level clearance (migration 212). The route validates the new
        // value is ≤ the setter's own clearance before reaching here.
        sets.push(`clearance = $${idx++}`)
        values.push(fields.clearance)
      }
      if (fields.binding !== undefined) {
        sets.push(`binding = $${idx++}`)
        values.push(JSON.stringify(fields.binding))
        sets.push(`entity = $${idx++}`)
        values.push(fields.binding.entity)
        sets.push(`view_type = $${idx++}`)
        values.push(fields.binding.viewType)
      }
      if (fields.brainSyncEnabled !== undefined) {
        // Per-page "Sync to brain" toggle (migration 001_doc_brain_sync). The
        // route gates it on the caller being able to write the page; enabling
        // it doesn't ingest here — the auto-on-save trigger does that on the
        // next authored-content change.
        sets.push(`brain_sync_enabled = $${idx++}`)
        values.push(fields.brainSyncEnabled)
      }
      if (fields.linkedRecordingId !== undefined) {
        // Manually-linked recording (migration 339). `null` unlinks. The route
        // has already checked the recording is in this page's workspace and the
        // caller can see it — the FK only guarantees it is a real recording.
        sets.push(`linked_recording_id = $${idx++}`)
        values.push(fields.linkedRecordingId)
      }

      if (sets.length === 0) {
        // No-op update — return current row unchanged.
        const cur = await queryWithRLS<FullRow>(
          userId,
          `SELECT ${FULL_SELECT} FROM saved_views WHERE id = $1`,
          [id],
        )
        return cur.rows[0] ? rowToFull(cur.rows[0]) : null
      }

      values.push(id)
      const result = await queryWithRLS<FullRow>(
        userId,
        `UPDATE saved_views SET ${sets.join(', ')}
         WHERE id = $${idx}
         RETURNING ${FULL_SELECT}`,
        values,
      )
      if (!result.rows[0]) return null
      const view = rowToFull(result.rows[0])
      // Real metadata change (rename / icon / clearance / binding / brain-sync).
      // The no-op early-return above never reaches here, and the guarded
      // placeholder→auto title transition runs through `setAutoTitle`, not this
      // path, so the auto-titler never self-fires an `updated` event.
      emitLifecycle({
        workspaceId: view.workspaceId,
        pageId: view.id,
        parentId: view.nestParentId ?? null,
        title: view.name,
        actorId: userId,
        action: 'updated',
        isSystem: writtenBy === 'system',
      })
      return view
    },

    async remove(userId, id) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `DELETE FROM saved_views WHERE id = $1 RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },

    // ── Notion-redesign extensions ────────────────────────────────────

    async getPage(userId, id) {
      // Prefer the live collaborative snapshot (documents) over the
      // frozen legacy `saved_views.page` so the AI's lazy block reads
      // (getBlock / queryDataBlock) see what humans see. Falls back to the
      // legacy column for pages never opened collaboratively. See doc.md
      // → "Real-time collaboration".
      const result = await queryWithRLS<{ page: Page | null }>(
        userId,
        `SELECT COALESCE(cd.snapshot_json, sv.page) AS page
           FROM saved_views sv
           LEFT JOIN documents cd ON cd.page_id = sv.id
          WHERE sv.id = $1`,
        [id],
      )
      return result.rows[0]?.page ?? null
    },

    async updatePage(userId, id, page) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE saved_views SET page = $1 WHERE id = $2 RETURNING id`,
        [JSON.stringify(page), id],
      )
      return result.rows.length > 0
    },

    async setState(userId, id, state) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE saved_views SET state = $1 WHERE id = $2 RETURNING id`,
        [state, id],
      )
      return result.rows.length > 0
    },

    async setAutoPruneAt(userId, id, when) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE saved_views SET auto_prune_at = $1 WHERE id = $2 RETURNING id`,
        [when, id],
      )
      return result.rows.length > 0
    },

    async createDraft({ userId, workspaceId, name, nameOrigin, icon, entity, viewType, binding, page, nestParentId, autoPruneDays, originPrompt, anchorKey, writtenBy, deferCreatedEvent, teamspaceId }) {
      const days = autoPruneDays ?? DEFAULT_DRAFT_TTL_DAYS
      const autoPruneAt = addDays(new Date(), days)
      // Snapshot the genesis prompt (migration 231). Trim + cap so a pasted
      // wall of text can't bloat the page row — the History card only previews
      // it. Empty / whitespace-only → NULL (no origin entry shown).
      const originPromptValue = originPrompt?.trim().slice(0, 2000) || null
      // Born auto-title-eligible unless the caller already supplied a real
      // title (renderPage/createSubPage pass 'user'). Migration 218.
      const origin: NameOrigin = nameOrigin ?? 'placeholder'
      const result = await queryWithRLS<FullRow>(
        userId,
        // `position` appends to the end of the destination sibling set so
        // new pages get a distinct, contiguous slot instead of all sharing
        // 0 (which broke reparent's gap-open reindexing). The sibling set is
        // scoped exactly like `reparent`/`reorderSiblings`: `nest_parent_id
        // IS NOT DISTINCT FROM` matches the root list (NULL) and any concrete
        // parent, and `workspace_id` keeps the root list per-workspace.
        // `icon` ($10) seeds the page emoji (migration 211) — null when the
        // caller passed none, leaving auto-title's COALESCE suggestion free.
        // `origin_prompt` ($11) snapshots the creating prompt (migration 231 —
        // see `originPromptValue` above); `auto_prune_at` ($12) precedes the
        // trailing `anchor_key` ($13).
        // `anchor_key` ($13) is the stable cross-run identity for workflow
        // `page.reuse === 'per-workflow'` (migration 279); null on every other
        // path. The partial unique index (workspace_id, anchor_key) enforces
        // row-uniqueness only — it does NOT make this find-or-create atomic;
        // the boot `createAnchorPage` adapter converges on a 23505 race by
        // re-reading the winner. See findIdByAnchorKey below.
        // `created_event_pending` ($14) defers the `created` page-event for
        // interactive drafts (migration 283): true → the `created` emit below
        // is skipped and the client fires it later via `commitCreatedEvent`.
        // Programmatic creates pass false (default) and emit immediately.
        // `teamspace_id` (migration 313) is tri-state via $15/$16: an explicit
        // placement ($15 true — a teamspace id, or NULL for a private page)
        // wins; else a nested draft inherits its parent's teamspace; else the
        // workspace's default (General) teamspace, so every AI / workflow /
        // programmatic root create stays team-visible. The subqueries run
        // under RLS: an invisible parent or missing default resolves NULL →
        // a private page, never an insert into a teamspace the caller can't
        // see (the policy WITH CHECK backstops that anyway).
        `INSERT INTO saved_views
           (workspace_id, created_by, name, name_origin, description, icon, entity, view_type, binding, page, state, nest_parent_id, position, origin_prompt, auto_prune_at, anchor_key, created_event_pending, teamspace_id)
         VALUES ($1, $2, $3, $4, NULL, $10, $5, $6, $7, $8, 'draft', $9,
           (SELECT COALESCE(MAX(position) + 1, 0) FROM saved_views
              WHERE nest_parent_id IS NOT DISTINCT FROM $9 AND workspace_id = $1),
           $11, $12, $13, $14,
           CASE
             WHEN $15::boolean THEN $16::uuid
             WHEN $9::uuid IS NOT NULL THEN (SELECT p.teamspace_id FROM saved_views p WHERE p.id = $9)
             ELSE (SELECT t.id FROM teamspaces t WHERE t.workspace_id = $1 AND t.is_default = true)
           END)
         RETURNING ${FULL_SELECT}`,
        [
          workspaceId,
          userId,
          name,
          origin,
          entity,
          viewType,
          JSON.stringify(binding),
          JSON.stringify(page),
          nestParentId ?? null,
          icon ?? null,
          originPromptValue,
          autoPruneAt,
          anchorKey ?? null,
          deferCreatedEvent === true,
          teamspaceId !== undefined,
          teamspaceId ?? null,
        ],
      )
      const view = rowToFull(result.rows[0])
      // Deferred (interactive) drafts hold their `created` event until the
      // client commits it (debounced typing / navigate-away) via
      // `commitCreatedEvent`; every other create fires it now.
      if (!deferCreatedEvent) {
        emitLifecycle({
          workspaceId: view.workspaceId,
          pageId: view.id,
          parentId: view.nestParentId ?? null,
          title: view.name,
          actorId: userId,
          action: 'created',
          isSystem: writtenBy === 'system',
        })
      }
      return view
    },

    async commitCreatedEvent(userId, id) {
      // Atomic single-fire: only the call that flips `created_event_pending`
      // from true → false emits. Concurrent commits (typing debounce vs the
      // navigate-away flush, a double-click, a reload re-arming) see 0 rows and
      // no-op, so the workflow fires exactly once. RLS-scoped by `userId`.
      const result = await queryWithRLS<FullRow>(
        userId,
        `UPDATE saved_views
            SET created_event_pending = false
          WHERE id = $1 AND created_event_pending = true
          RETURNING ${FULL_SELECT}`,
        [id],
      )
      const row = result.rows[0]
      if (!row) return false
      const view = rowToFull(row)
      // A human committing through the doc editor — always a `user` write (the
      // deferral path is interactive-only), so it fires for a default
      // `fromBots: false` subscription.
      emitLifecycle({
        workspaceId: view.workspaceId,
        pageId: view.id,
        parentId: view.nestParentId ?? null,
        title: view.name,
        actorId: userId,
        action: 'created',
        isSystem: false,
      })
      return true
    },

    async findIdByAnchorKey(userId, workspaceId, anchorKey) {
      // Find-or-create lookup for workflow `page.reuse === 'per-workflow'`
      // (migration 279). RLS-scoped by `userId` (a workspace member); the
      // `(workspace_id, anchor_key)` partial unique index makes this a single
      // index probe.
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `SELECT id FROM saved_views
          WHERE workspace_id = $1 AND anchor_key = $2
          LIMIT 1`,
        [workspaceId, anchorKey],
      )
      return result.rows[0]?.id ?? null
    },

    async setAutoTitle(userId, id, title, icon) {
      // Conditional placeholder→auto transition (migration 218). The
      // `WHERE name_origin = 'placeholder'` predicate is the race guard:
      // exactly one of the concurrent human/AI triggers matches, the other
      // sees 0 rows and no-ops. Idempotent after the flip.
      //
      // `icon = COALESCE(icon, $3)` fills the suggested emoji only when the
      // user hasn't already chosen one — a user emoji is never clobbered, and
      // a null suggestion (model emitted no emoji) leaves the column be.
      const result = await queryWithRLS<{ name: string; icon: string | null }>(
        userId,
        `UPDATE saved_views
            SET name = $2, name_origin = 'auto', icon = COALESCE(icon, $3), updated_at = now()
          WHERE id = $1 AND name_origin = 'placeholder'
          RETURNING name, icon`,
        [id, title, icon ?? null],
      )
      const row = result.rows[0]
      return row ? { name: row.name, icon: row.icon ?? null } : null
    },

    // ── Doc page-tree (migration 210) ──────────────────────────────

    async reparent(userId, id, newNestParentId, position, writtenBy, teamspaceId) {
      // 1. Cycle guard. Walk up the ancestor chain from the destination
      //    parent (RLS-scoped reads) and refuse the move if it would form
      //    a loop. Done before opening the write transaction so a rejected
      //    move never touches the row.
      if (newNestParentId !== null) {
        const ancestors = new Map<string, string | null>()
        let cursor: string | null = newNestParentId
        let steps = 0
        while (cursor != null) {
          if (ancestors.has(cursor)) break // already-corrupt tree; stop walking
          if (++steps > 10_000) break
          const row: import('pg').QueryResult<{ nestParentId: string | null }> =
            await queryWithRLS<{ nestParentId: string | null }>(
              userId,
              `SELECT nest_parent_id AS "nestParentId" FROM saved_views WHERE id = $1`,
              [cursor],
            )
          if (row.rows.length === 0) {
            // Destination parent (or an ancestor) is not visible / missing.
            // RLS hid it or it doesn't exist — reject the move.
            ancestors.set(cursor, null)
            break
          }
          const parent: string | null = row.rows[0].nestParentId
          ancestors.set(cursor, parent)
          cursor = parent
        }
        if (
          reparentWouldCycle(id, newNestParentId, (pid) =>
            ancestors.has(pid) ? ancestors.get(pid) : undefined,
          )
        ) {
          return false
        }
      }

      // 2. Mutate under a single RLS transaction: set the new parent +
      //    position on the moved row, then reindex the destination
      //    siblings to 0..n-1. Multi-statement under RLS → the
      //    bypass-disable / SET current_user_id / BEGIN / COMMIT pattern
      //    documented in packages/api/CLAUDE.md.
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        // App pool (app_user, RLS-enforced). SET LOCAL current_user_id reverts
        // at COMMIT/ROLLBACK to the seeded sentinel.
        await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

        // Confirm the row is visible to this user before moving it, and
        // capture its workspace so the sibling-set operations stay scoped
        // to one workspace (critical for the root list — `nest_parent_id
        // IS NULL` would otherwise span every workspace the user can see).
        // `teamspace_id` rides along for the destination-teamspace resolve
        // below (migration 313).
        const found = await client.query<{ workspaceId: string; name: string; teamspaceId: string | null }>(
          `SELECT workspace_id AS "workspaceId", name, teamspace_id AS "teamspaceId"
             FROM saved_views WHERE id = $1 FOR UPDATE`,
          [id],
        )
        if (found.rows.length === 0) {
          await client.query('ROLLBACK')
          return false
        }
        const workspaceId = found.rows[0].workspaceId
        const movedName = found.rows[0].name
        const currentTeamspaceId = found.rows[0].teamspaceId

        // Resolve the destination teamspace (migration 313):
        //  - under a page parent → the child always adopts the parent's
        //    teamspace (the container is a property of the subtree root);
        //  - to a root slot → the caller's explicit section (a teamspace id
        //    or null = Private), else keep the current one (plain reorder /
        //    legacy promote-to-root).
        let destTeamspaceId: string | null
        if (newNestParentId !== null) {
          const parentRow = await client.query<{ teamspaceId: string | null }>(
            `SELECT teamspace_id AS "teamspaceId" FROM saved_views WHERE id = $1`,
            [newNestParentId],
          )
          if (parentRow.rows.length === 0) {
            // Parent invisible under RLS / gone — mirrors the cycle-guard's
            // inaccessible-parent rejection.
            await client.query('ROLLBACK')
            return false
          }
          destTeamspaceId = parentRow.rows[0].teamspaceId
        } else {
          destTeamspaceId = teamspaceId === undefined ? currentTeamspaceId : teamspaceId
        }

        // Open a gap at the requested slot among the destination siblings,
        // then place the moved row there. `nest_parent_id IS NOT DISTINCT
        // FROM $1` matches the root list (NULL) and any concrete parent;
        // `workspace_id = $4` keeps the root list per-workspace, and the
        // root list is additionally scoped to the destination teamspace
        // section ($5/$6) so sections keep independent orderings — a
        // non-root sibling set is teamspace-uniform already, so the extra
        // predicate is a no-op there.
        await client.query(
          `UPDATE saved_views
              SET position = position + 1
            WHERE nest_parent_id IS NOT DISTINCT FROM $1
              AND id <> $2
              AND position >= $3
              AND workspace_id = $4
              AND ($1::uuid IS NOT NULL OR teamspace_id IS NOT DISTINCT FROM $5::uuid)`,
          [newNestParentId, id, position, workspaceId, destTeamspaceId],
        )
        await client.query(
          `UPDATE saved_views
              SET nest_parent_id = $1, position = $2, teamspace_id = $4
            WHERE id = $3`,
          [newNestParentId, position, id, destTeamspaceId],
        )

        // Cascade the teamspace across the moved page's whole descendant
        // subtree so the denormalized `teamspace_id` stays true (migration
        // 313) — a move files the subtree, not just the root. RLS-scoped:
        // the caller can see the subtree (it shared the moved row's old
        // teamspace), and the policy's WITH CHECK refuses a destination the
        // caller isn't a member of.
        if (destTeamspaceId !== currentTeamspaceId) {
          await client.query(
            `WITH RECURSIVE subtree AS (
               SELECT id FROM saved_views WHERE id = $1
               UNION ALL
               SELECT sv.id FROM saved_views sv JOIN subtree s ON sv.nest_parent_id = s.id
             )
             UPDATE saved_views
                SET teamspace_id = $2
              WHERE id IN (SELECT id FROM subtree)`,
            [id, destTeamspaceId],
          )
        }

        // Renumber the destination sibling set to contiguous 0..n-1,
        // preserving the ordering the gap-open produced. Ties (e.g. equal
        // raw positions) break on id for determinism. Scoped to the
        // workspace (and, for the root list, the destination teamspace
        // section) so positions don't bleed across workspaces or sections.
        await client.query(
          `WITH ordered AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1 AS rn
               FROM saved_views
              WHERE nest_parent_id IS NOT DISTINCT FROM $1
                AND workspace_id = $2
                AND ($1::uuid IS NOT NULL OR teamspace_id IS NOT DISTINCT FROM $3::uuid)
           )
           UPDATE saved_views sv
              SET position = ordered.rn
             FROM ordered
            WHERE sv.id = ordered.id
              AND sv.position <> ordered.rn`,
          [newNestParentId, workspaceId, destTeamspaceId],
        )

        await client.query('COMMIT')
        // Emit after the move commits — `newNestParentId` is the destination
        // parent (null = workspace root).
        emitLifecycle({
          workspaceId,
          pageId: id,
          parentId: newNestParentId,
          title: movedName,
          actorId: userId,
          action: 'moved',
          isSystem: writtenBy === 'system',
        })
        return true
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        // A row-level-security WITH CHECK violation (42501) means the caller
        // tried to file the page (or its subtree) somewhere they may not —
        // a teamspace they aren't a member of, or privatizing a teammate's
        // page. That's a clean authorization reject, not a server fault.
        if ((err as { code?: string }).code === '42501') return false
        throw err
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async reorderSiblings(userId, nestParentId, orderedIds) {
      if (orderedIds.length === 0) return
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        // App pool (app_user, RLS-enforced). SET LOCAL current_user_id reverts
        // at COMMIT/ROLLBACK to the seeded sentinel.
        await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

        // Set each id's position to its array index. Scope the write to
        // the sibling set (`nest_parent_id IS NOT DISTINCT FROM`) so a
        // stray id from another parent can't be re-positioned here.
        for (let i = 0; i < orderedIds.length; i++) {
          await client.query(
            `UPDATE saved_views
                SET position = $1
              WHERE id = $2
                AND nest_parent_id IS NOT DISTINCT FROM $3`,
            [i, orderedIds[i], nestParentId],
          )
        }

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async pruneExpiredDraftsSystem() {
      // System-bypass path — the prune worker has no userId. Bare query
      // is fine here because saved_views' system_bypass RLS policy
      // defaults open.
      //
      // A draft filed inside a *saved* (Favorites) subtree is **kept by
      // ancestry**: the parent's save covers it, so it must never be
      // pruned even once its own `auto_prune_at` lapses. We first collect
      // the expired-draft candidates (cheap — the partial index on
      // `(auto_prune_at) WHERE state='draft' AND auto_prune_at IS NOT NULL`
      // from migration 184 drives the `candidate` CTE), then climb each
      // candidate's `nest_parent_id` chain and drop any candidate that has
      // a `state='saved'` ancestor. The depth cap (100) makes the recursion
      // terminate even on a corrupt parent cycle. Mirrors the frontend
      // `savedAncestorIds` rule — the two MUST agree, or the sidebar would
      // hide a draft's Save CTA while this worker silently deletes it.
      const result = await query<{ id: string }>(
        `WITH RECURSIVE candidate AS (
           SELECT id, nest_parent_id
             FROM saved_views
            WHERE state = 'draft'
              AND auto_prune_at IS NOT NULL
              AND auto_prune_at < now()
         ),
         ancestry AS (
           SELECT c.id AS candidate_id, p.id AS ancestor_id,
                  p.state AS ancestor_state, p.nest_parent_id AS next_parent,
                  1 AS depth
             FROM candidate c
             JOIN saved_views p ON p.id = c.nest_parent_id
           UNION ALL
           SELECT a.candidate_id, p.id, p.state, p.nest_parent_id, a.depth + 1
             FROM ancestry a
             JOIN saved_views p ON p.id = a.next_parent
            WHERE a.depth < 100
         ),
         kept AS (
           SELECT DISTINCT candidate_id FROM ancestry WHERE ancestor_state = 'saved'
         )
         DELETE FROM saved_views
          WHERE id IN (SELECT id FROM candidate)
            AND id NOT IN (SELECT candidate_id FROM kept)
          RETURNING id`,
      )
      return result.rows.map((r) => r.id)
    },

    // ── Brain sync (migration 001_doc_brain_sync) ──────────────────────

    async getBrainSyncStateSystem(id) {
      // System-bypass read — the auto-on-save trigger (doc-sync → API
      // /internal/ingest-page) has no member userId; the route authorises by
      // resolving the page owner. `createdBy` + `workspaceId` scope the ingest.
      const result = await query<{
        workspaceId: string
        createdBy: string
        brainSyncEnabled: boolean
        brainLastIngestHash: string | null
        brainLastIngestAt: Date | null
      }>(
        `SELECT workspace_id AS "workspaceId",
                created_by    AS "createdBy",
                brain_sync_enabled     AS "brainSyncEnabled",
                brain_last_ingest_hash AS "brainLastIngestHash",
                brain_last_ingest_at   AS "brainLastIngestAt"
           FROM saved_views WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async markBrainIngestedSystem(id, contentHash) {
      const result = await query<{ id: string }>(
        `UPDATE saved_views
            SET brain_last_ingest_hash = $2,
                brain_last_ingest_at   = now()
          WHERE id = $1
          RETURNING id`,
        [id, contentHash],
      )
      return result.rows.length > 0
    },

    async getPageEventContextSystem(id) {
      // System-bypass read — the content-edit `updated` trigger (doc-sync →
      // API /internal/page-event) has no member userId; doc-sync already
      // clearance-gated the writers at connect, and the emit is workspace-scoped
      // by the resolved `workspaceId`. Returns just what `PageLifecycleEvent`
      // needs for an `updated` event.
      const result = await query<{
        workspaceId: string
        parentId: string | null
        title: string | null
      }>(
        `SELECT workspace_id   AS "workspaceId",
                nest_parent_id AS "parentId",
                name           AS "title"
           FROM saved_views WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },
  }
}

/**
 * System-side page read (no RLS, no `AccessContext`). Returns the live
 * page blocks — preferring the collaborative snapshot over the legacy
 * column, same COALESCE as the RLS-scoped `getPage`. Used by the anonymous
 * public-share route, which has no member `userId`; access is already
 * gated by the link-token resolver before this is called.
 *
 * [COMP:doc/public-share-route]
 */
export async function getPageSystem(id: string): Promise<Page | null> {
  const result = await query<{ page: Page | null }>(
    `SELECT COALESCE(cd.snapshot_json, sv.page) AS page
       FROM saved_views sv
       LEFT JOIN documents cd ON cd.page_id = sv.id
      WHERE sv.id = $1`,
    [id],
  )
  return result.rows[0]?.page ?? null
}

/** How a `child_page` target is reachable from a shared page (doc.md "Subtree
 *  share"): `subtree` = nested under the rendered page, addressable through
 *  the same share (token-scoped URL on a link share); `published` = outside
 *  the subtree but independently published (universal `/share/p/<id>` URL). */
export type ChildPageLabel = { name: string; icon: string | null; via: 'subtree' | 'published' }

/**
 * System-side batch lookup of `child_page` display labels for a public render.
 * `anchorPageId` is the SHARE-SUBTREE ROOT the caller already verified access
 * through: the token's granted root for a link share (so sibling/up-tree
 * targets inside the token subtree still resolve), the rendered page for a
 * published render, or the previewed page for the owner preview. A child
 * resolves
 * when it is (a) inside that subtree — its `nest_parent_id` chain passes
 * through the anchor — or (b) independently published (a live `published`
 * grant on it or an ancestor that is still `clearance='public'`, covering
 * "Link to page" targets outside the subtree). The child's own clearance is
 * deliberately NOT a gate for (a): sharing a page shares everything nested
 * under it. Any other child resolves to no entry and the renderer blanks the
 * block (no id/title leak). Only name + icon are read.
 */
export async function getChildPageLabelsSystem(
  ids: string[],
  anchorPageId: string,
): Promise<Map<string, ChildPageLabel>> {
  const map = new Map<string, ChildPageLabel>()
  if (ids.length === 0) return map
  const result = await query<{
    id: string
    name: string
    icon: string | null
    inSubtree: boolean
    published: boolean
  }>(
    `WITH RECURSIVE walk AS (
       SELECT id AS start_id, id, nest_parent_id, clearance
         FROM saved_views WHERE id = ANY($1)
       UNION ALL
       SELECT w.start_id, sv.id, sv.nest_parent_id, sv.clearance
         FROM saved_views sv JOIN walk w ON sv.id = w.nest_parent_id
     )
     SELECT t.id, t.name, t.icon,
            bool_or(w.id = $2::uuid) AS "inSubtree",
            bool_or(pg.id IS NOT NULL AND w.clearance = 'public') AS published
       FROM saved_views t
       JOIN walk w ON w.start_id = t.id
       LEFT JOIN page_grants pg
              ON pg.page_id = w.id
             AND pg.principal_type = 'published'
             AND pg.revoked_at IS NULL
             AND (pg.expires_at IS NULL OR pg.expires_at > now())
      WHERE t.id = ANY($1)
      GROUP BY t.id, t.name, t.icon`,
    [ids, anchorPageId],
  )
  for (const r of result.rows) {
    if (r.inSubtree) map.set(r.id, { name: r.name, icon: r.icon, via: 'subtree' })
    else if (r.published) map.set(r.id, { name: r.name, icon: r.icon, via: 'published' })
  }
  return map
}
