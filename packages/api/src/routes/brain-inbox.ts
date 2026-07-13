/**
 * Brain inbox routes — workspace-scoped verification surface across
 * every brain primitive carrying the universal `verified_by_user_id`
 * column (mig 128 / WU-2.1). Generalises the per-assistant memory
 * verify/adjust routes that lived in `memories.ts` to also cover
 * entities, edges, tasks, CRM rows, and workspace files.
 *
 * Spec: [`docs/architecture/brain/corrections.md`](../../../../docs/architecture/brain/corrections.md).
 *
 * Mounted at `/api/brain-inbox` behind `requireAuth`.
 *
 * Routes:
 *   GET    /:workspaceId                            — paginated unverified list
 *   GET    /:workspaceId/count                      — total + per-primitive counts
 *   POST   /:workspaceId/:primitive/:rowId/verify   — generic verify stamp
 *   POST   /:workspaceId/:primitive/:rowId/adjust   — adjust (memory in v1; others 405)
 *   DELETE /:workspaceId/:primitive/:rowId          — soft delete (valid_to)
 *   GET    /:workspaceId/:primitive/:rowId/explain  — source-session context (no LLM)
 *   POST   /:workspaceId/:primitive/:rowId/inspection-session — ephemeral chat session
 *
 * Legacy compatibility: `/api/workspaces/:id/memories/unverified` and
 * `/api/assistants/:id/memories/:id/verify` stay mounted via thin
 * shims that delegate here. Removed in a follow-up deploy cycle.
 *
 * [COMP:api/brain-inbox-route]
 */

import { Router } from 'express'
import type { Response } from 'express'
import { query } from '../db/client.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  listBrainInbox,
  countBrainInbox,
  getBrainInboxRow,
  markVerifiedGeneric,
  appendBrainVerification,
  pruneDanglingEntityLinks,
  primitiveToTable,
  type BrainInboxPrimitive,
} from '../db/brain-inbox-store.js'
import { createInspectionSession } from '../db/sessions.js'
import {
  updateEntity,
  reclassifyEntityKind,
  promoteEntityToCrm,
  addEntityAlias,
  removeEntityAlias,
  type PromoteEntityToCrmParams,
} from '../db/entities-store.js'
import { SYSTEM_ENTITY_KINDS, TASK_STATUSES } from '@sidanclaw/core'
import { updateWorkspaceFileMeta } from '../db/workspace-files.js'
import { updateTask } from '../db/tasks.js'
import type { FilesApi, FilesContext, TaskRecordStatus, TaskUpdateFields } from '@sidanclaw/core'
import { notifyBrainInboxChange } from '../brain-stream/notify.js'

type RouteOptions = {
  workspaceStore: WorkspaceStore
  /**
   * Entity-kind classifier — when provided, exposes a `POST
   * /:workspaceId/classify` suggestion endpoint that the web UI can
   * call before submit to show "did you mean…" hints.
   *
   * Spec: docs/architecture/brain/classification/README.md
   *   §B3 Brain inbox / web UI
   */
  entityKindClassifier?: import('@sidanclaw/core').Classifier<import('@sidanclaw/core').EntityKind>
  /**
   * Pending-classifications store — when provided, exposes
   * `GET /:workspaceId/pending-classifications` (list unresolved) and
   * `POST /:workspaceId/pending-classifications/:id/resolve` (accept /
   * reject / dismiss). The web UI inbox surface reads from these.
   *
   * Spec: docs/architecture/brain/classification/README.md
   *   §Pending-reclassification queue
   */
  pendingClassificationStore?: import('@sidanclaw/core').PendingClassificationStore
  /**
   * Files API — when provided, exposes `GET
   * /:workspaceId/workspace_file/:rowId/content` so the brain detail
   * drawer can preview a saved file's bytes (images inline, text/markdown
   * as text, anything else as a download). Reads through `filesApi.readBytes`
   * which is access-scoped (workspace + clearance). Absent → the endpoint
   * returns 501 and the drawer falls back to a metadata-only card.
   */
  filesApi?: FilesApi | null
}

const VALID_PRIMITIVES: BrainInboxPrimitive[] = [
  'memory',
  'entity',
  'entity_link',
  'task',
  'contact',
  'company',
  'deal',
  'workspace_file',
]

function isValidPrimitive(s: string): s is BrainInboxPrimitive {
  return (VALID_PRIMITIVES as string[]).includes(s)
}

export function brainInboxRoutes({
  workspaceStore,
  entityKindClassifier,
  pendingClassificationStore,
  filesApi,
}: RouteOptions): Router {
  const router = Router()

  async function requireWorkspaceMember(
    req: { userId?: string; params: { workspaceId: string } },
    res: Response,
  ): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    return role
  }

  // ── GET /:workspaceId — list ────────────────────────────────────

  router.get('/:workspaceId', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId } = req.params as { workspaceId: string }
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const cursor = req.query.cursor as string | undefined
    const primitiveQuery = req.query.primitive as string | undefined
    const includeExtracted = req.query.includeExtracted === 'true'

    let primitive: BrainInboxPrimitive | undefined
    if (primitiveQuery) {
      if (!isValidPrimitive(primitiveQuery)) {
        res.status(400).json({ error: `Unknown primitive '${primitiveQuery}'` })
        return
      }
      primitive = primitiveQuery
    }

    try {
      // Auto-prune dead relationships before listing when edges are in scope
      // (the unscoped feed or an explicit entity_link fetch): a dangling edge
      // points at a hard-deleted endpoint, so there's nothing to review. Soft-
      // deleting them here keeps the queue + badge honest. Best-effort — a
      // prune failure must not break the list (the list query also excludes
      // dangling edges, so correctness doesn't depend on the prune landing).
      if (!primitive || primitive === 'entity_link') {
        try {
          await pruneDanglingEntityLinks(workspaceId)
        } catch (pruneErr) {
          console.error('[brain-inbox] dangling-edge prune failed:', pruneErr)
        }
      }
      const result = await listBrainInbox({
        workspaceId,
        primitive,
        cursor,
        limit,
        includeExtracted,
      })
      res.json({ rows: result.rows, cursor: result.cursor })
    } catch (err) {
      console.error('[brain-inbox] list failed:', err)
      res.status(500).json({ error: 'Failed to list brain inbox' })
    }
  })

  // ── POST /:workspaceId/classify ─────────────────────────────────
  //
  // Suggestion endpoint for the web UI's "did you mean…" hint. Takes a
  // candidate entity (display_name + optional canonical_id + optional
  // attributes + optional proposed kind) and returns the classifier's
  // decision, so the UI can guide the user before submit.
  //
  // No-op when no classifier wired (returns 200 with kind='no_signal').
  //
  // Spec: docs/architecture/brain/classification/README.md
  //   §Decision semantics per boundary — B3 brain inbox / web UI
  router.post('/:workspaceId/classify', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return
    if (!entityKindClassifier) {
      res.json({ kind: 'no_signal' })
      return
    }
    const body = (req.body ?? {}) as {
      display_name?: unknown
      canonical_id?: unknown
      attributes?: unknown
      proposed?: unknown
    }
    const displayName =
      typeof body.display_name === 'string' && body.display_name.trim().length > 0
        ? body.display_name.trim()
        : null
    if (!displayName) {
      res.status(400).json({ error: 'display_name is required and must be a non-empty string' })
      return
    }
    try {
      const decision = entityKindClassifier.decide(
        {
          primary: displayName,
          canonical_id: typeof body.canonical_id === 'string' ? body.canonical_id : null,
          attributes:
            body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)
              ? (body.attributes as Record<string, unknown>)
              : undefined,
          proposed: typeof body.proposed === 'string' ? body.proposed : undefined,
        },
        'inbox',
      )
      res.json(decision)
    } catch (err) {
      console.error('[brain-inbox] classify failed:', err)
      res.status(500).json({ error: 'Classification failed' })
    }
  })

  // ── GET /:workspaceId/pending-classifications ───────────────────
  //
  // List unresolved classifier suggestions for the workspace inbox UI.
  // Newest-first, capped at 100. Returns 200 with empty array when
  // pending_classifications isn't wired (older deployments).
  router.get('/:workspaceId/pending-classifications', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return
    if (!pendingClassificationStore) {
      res.json({ rows: [] })
      return
    }
    const { workspaceId } = req.params as { workspaceId: string }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 100)
    const primitiveKindRaw = req.query.primitive as string | undefined
    try {
      const rows = await pendingClassificationStore.listUnresolvedForWorkspace(
        {
          workspaceId,
          userId,
          assistantId: '',  // brain-inbox is workspace-scoped; no per-assistant filter
          assistantKind: 'primary',
        },
        {
          limit,
          primitiveKind:
            primitiveKindRaw === 'entity' ||
            primitiveKindRaw === 'edge' ||
            primitiveKindRaw === 'memory' ||
            primitiveKindRaw === 'episode'
              ? primitiveKindRaw
              : undefined,
        },
      )
      res.json({ rows })
    } catch (err) {
      console.error('[brain-inbox] pending-classifications list failed:', err)
      res.status(500).json({ error: 'Failed to list pending classifications' })
    }
  })

  // ── POST /:workspaceId/pending-classifications/:id/resolve ─────
  //
  // Resolve a single suggestion. Body: { resolution: 'accept' | 'reject' | 'dismiss' }.
  // 'accept' is the UI affordance — it marks the queue row but DOES NOT
  // apply the suggestion (the caller must invoke reclassifyEntityKind /
  // promoteEntityToCrm separately, typically via the existing
  // POST /:workspaceId/entity/:entityId/reclassify endpoint).
  // 'reject' and 'dismiss' just flip the resolution state.
  router.post('/:workspaceId/pending-classifications/:id/resolve', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return
    if (!pendingClassificationStore) {
      res.status(404).json({ error: 'Pending classifications not enabled' })
      return
    }
    const { id } = req.params as { id: string }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { resolution } = (req.body ?? {}) as { resolution?: unknown }
    if (resolution !== 'accept' && resolution !== 'reject' && resolution !== 'dismiss') {
      res.status(400).json({ error: 'resolution must be one of: accept, reject, dismiss' })
      return
    }
    try {
      const resolved = await pendingClassificationStore.resolve(userId, id, resolution)
      if (!resolved) {
        res.status(404).json({ error: 'Pending classification not found or already resolved' })
        return
      }
      res.json({ ok: true, row: resolved })
    } catch (err) {
      console.error('[brain-inbox] pending-classifications resolve failed:', err)
      res.status(500).json({ error: 'Failed to resolve pending classification' })
    }
  })

  // ── GET /:workspaceId/count ─────────────────────────────────────

  router.get('/:workspaceId/count', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId } = req.params as { workspaceId: string }
    const includeExtracted = req.query.includeExtracted === 'true'
    try {
      const counts = await countBrainInbox(workspaceId, { includeExtracted })
      res.json(counts)
    } catch (err) {
      console.error('[brain-inbox] count failed:', err)
      res.status(500).json({ error: 'Failed to count brain inbox' })
    }
  })

  // ── GET /:workspaceId/:primitive/:rowId — single-row detail ────
  //
  // Drives the per-primitive detail page. Unlike the inbox list, this
  // includes already-verified rows (with the verifiedByUserId stamp in
  // the response) so the page survives the user pressing Confirm and
  // bookmarked / deep-linked URLs keep working. Soft-deleted /
  // retracted rows still return 404 — those really are gone.

  router.get('/:workspaceId/:primitive/:rowId', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
      workspaceId: string
      primitive: string
      rowId: string
    }
    if (!isValidPrimitive(primitiveParam)) {
      res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
      return
    }

    try {
      const row = await getBrainInboxRow(workspaceId, primitiveParam, rowId)
      if (!row) {
        res.status(404).json({ error: 'Row not found' })
        return
      }
      res.json({
        primitive: row.primitive,
        id: row.id,
        workspaceId: row.workspaceId,
        createdAt: row.createdAt,
        createdByAssistantId: row.createdByAssistantId,
        verifiedByUserId: row.verifiedByUserId,
        verifiedAt: row.verifiedAt,
        body: row.body,
      })
    } catch (err) {
      // Log full pg error detail (message + code + position + where) so the
      // next failure pinpoints the failing column / table. Stringifying the
      // bare error object only prints `error: column "X"` and truncates.
      const e = err as { message?: string; code?: string; position?: string; hint?: string; where?: string }
      console.error(
        `[brain-inbox] fetch row failed — workspaceId=${workspaceId} primitive=${primitiveParam} rowId=${rowId} ` +
        `pgCode=${e?.code} msg=${e?.message} position=${e?.position} where=${e?.where} hint=${e?.hint}`,
      )
      res.status(500).json({ error: 'Failed to load brain row' })
    }
  })

  // ── GET /:workspaceId/workspace_file/:rowId/content ─────────────
  //
  // Streams a saved file's bytes so the brain detail drawer can preview
  // it (images inline, text/markdown as text, anything else offered as a
  // download). Access-scoped through `filesApi.readBytes` (workspace +
  // clearance) after the membership gate. 501 when no files API is wired
  // (the row still renders as a metadata-only card). This is a 4-segment
  // path with the literal `workspace_file`/`content` bookends, so it does
  // not collide with the 3-segment `/:primitive/:rowId` detail route.

  router.get('/:workspaceId/workspace_file/:rowId/content', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return
    if (!filesApi) {
      res.status(501).json({ error: 'File preview is not available on this deployment' })
      return
    }
    const { workspaceId, rowId } = req.params as { workspaceId: string; rowId: string }
    const userId = (req as { userId?: string }).userId as string
    try {
      // Clearance is the read ceiling for the access-scoped byte read.
      const member = await query<{ clearance: 'public' | 'internal' | 'confidential' }>(
        `SELECT clearance FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId],
      )
      const clearance = member.rows[0]?.clearance ?? 'public'
      const ctx: FilesContext = { workspaceId, userId, assistantId: null, clearance }
      const result = await filesApi.readBytes(ctx, rowId)
      if (!result.ok) {
        res.status(404).json({ error: 'File not found' })
        return
      }
      const { file, bytes } = result.value
      res.setHeader('Content-Type', file.mime || 'application/octet-stream')
      res.setHeader('Content-Length', String(bytes.length))
      res.setHeader('Cache-Control', 'private, max-age=300')
      // Inline so the drawer renders images / text / pdf in place; the
      // filename is advisory for a save-as.
      const safeName = (file.name || 'file').replace(/"/g, '')
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`)
      res.send(bytes)
    } catch (err) {
      console.error('[brain-inbox] file content failed:', err)
      res.status(500).json({ error: 'Failed to load file content' })
    }
  })

  // ── POST /:workspaceId/:primitive/:rowId/verify ─────────────────
  //
  // Generic verify stamp. Sets verified_by_user_id + verified_at on
  // the active row + appends a brain_verifications audit row (or
  // memory_verifications for the memory primitive — the existing
  // evolution worker consumes that table specifically).

  router.post('/:workspaceId/:primitive/:rowId/verify', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
      workspaceId: string
      primitive: string
      rowId: string
    }
    if (!isValidPrimitive(primitiveParam)) {
      res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
      return
    }
    const userId = (req as any).userId as string

    try {
      // Validate the row belongs to this workspace before stamping —
      // primitiveToTable is closed-set so the table name is safe to
      // interpolate.
      const ownership = await query<{ workspace_id: string }>(
        `SELECT workspace_id FROM ${primitiveToTable(primitiveParam)}
         WHERE id = $1 AND valid_to IS NULL`,
        [rowId],
      )
      if (ownership.rows.length === 0) {
        res.status(404).json({ error: 'Row not found' })
        return
      }
      if (ownership.rows[0].workspace_id !== workspaceId) {
        res.status(403).json({ error: 'Row belongs to a different workspace' })
        return
      }

      const stamped = await markVerifiedGeneric(primitiveParam, rowId, userId)
      // Append audit. For memory we ride the existing memory_verifications
      // shape; for other primitives we use the new polymorphic
      // brain_verifications.
      if (primitiveParam === 'memory') {
        await query(
          `INSERT INTO memory_verifications (memory_id, workspace_id, verified_by, action)
           VALUES ($1, $2, $3, 'confirm')`,
          [rowId, workspaceId, userId],
        )
      } else {
        await appendBrainVerification({
          targetKind: primitiveParam,
          targetId: rowId,
          workspaceId,
          verifiedByUserId: userId,
          action: 'confirm',
        })
      }

      // Fire-and-forget realtime NOTIFY so open /brain pages on other tabs /
      // devices repaint the now-verified row.
      void notifyBrainInboxChange(workspaceId, primitiveParam, rowId, 'update')

      res.json({ ok: true, stamped })
    } catch (err) {
      console.error('[brain-inbox] verify failed:', err)
      res.status(500).json({ error: 'Failed to verify row' })
    }
  })

  // ── POST /:workspaceId/:primitive/:rowId/adjust ─────────────────
  //
  // V1 implementation: memory uses the existing scope/sensitivity/
  // summary/detail flow from the per-assistant memory route. Other
  // primitives return 405 with a pointer to the detail page — the
  // inbox card's "Edit" affordance for non-memory primitives links
  // out, not inline. Generic per-primitive adjust is a follow-up.

  router.post('/:workspaceId/:primitive/:rowId/adjust', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
      workspaceId: string
      primitive: string
      rowId: string
    }
    if (!isValidPrimitive(primitiveParam)) {
      res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
      return
    }
    const userId = (req as any).userId as string

    if (primitiveParam === 'memory') {
      // Memory adjust — delegate to the existing per-assistant route by
      // returning a 308 redirect. The existing route requires the
      // assistantId; we look it up from the memory row.
      const assistantLookup = await query<{ assistantId: string }>(
        `SELECT assistant_id as "assistantId" FROM memories WHERE id = $1 AND valid_to IS NULL`,
        [rowId],
      )
      if (assistantLookup.rows.length === 0) {
        res.status(404).json({ error: 'Memory not found' })
        return
      }
      const assistantId = assistantLookup.rows[0].assistantId
      res.redirect(
        308,
        `/api/assistants/${encodeURIComponent(assistantId)}/memories/${encodeURIComponent(rowId)}/adjust`,
      )
      return
    }

    if (primitiveParam === 'entity') {
      // Entity adjust — v1 supports display_name + sensitivity only.
      const { display_name, sensitivity, reason } = req.body as {
        display_name?: unknown
        sensitivity?: unknown
        reason?: unknown
      }

      let nextDisplayName: string | undefined
      if (display_name !== undefined) {
        if (typeof display_name !== 'string' || display_name.trim().length === 0) {
          res.status(400).json({ error: 'display_name must be a non-empty string' })
          return
        }
        if (display_name.length > 200) {
          res.status(400).json({ error: 'display_name must be 200 characters or less' })
          return
        }
        nextDisplayName = display_name.trim()
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public' &&
          sensitivity !== 'internal' &&
          sensitivity !== 'confidential'
        ) {
          res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      if (nextDisplayName === undefined && nextSensitivity === undefined) {
        res.status(400).json({
          error: 'At least one field (display_name, sensitivity) is required',
        })
        return
      }

      try {
        const before = await query<{
          workspaceId: string
          displayName: string
          sensitivity: 'public' | 'internal' | 'confidential'
        }>(
          `SELECT workspace_id as "workspaceId",
                  display_name as "displayName",
                  sensitivity
             FROM entities
            WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'Entity not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Entity belongs to a different workspace' })
          return
        }
        const prev = before.rows[0]

        // Write under the viewer's workspace projection (primary-reflector
        // shape — the route already verified workspace membership above).
        const updated = await updateEntity(userId, rowId, {
          displayName: nextDisplayName,
          sensitivity: nextSensitivity,
          verifiedByUserId: userId,
          verifiedAt: new Date(),
        }, { workspaceId, userId, assistantId: '', assistantKind: 'primary' })
        if (!updated) {
          res.status(404).json({ error: 'Entity not found' })
          return
        }

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        const writes: Promise<unknown>[] = []
        if (nextDisplayName !== undefined && nextDisplayName !== prev.displayName) {
          writes.push(
            appendBrainVerification({
              targetKind: 'entity',
              targetId: rowId,
              workspaceId,
              verifiedByUserId: userId,
              action: 'edit_summary',
              modelValue: { display_name: prev.displayName },
              userValue: { display_name: nextDisplayName },
              reason: reasonText,
            }),
          )
        }
        if (nextSensitivity !== undefined && nextSensitivity !== prev.sensitivity) {
          writes.push(
            appendBrainVerification({
              targetKind: 'entity',
              targetId: rowId,
              workspaceId,
              verifiedByUserId: userId,
              action: 'adjust_sensitivity',
              modelValue: prev.sensitivity,
              userValue: nextSensitivity,
              reason: reasonText,
            }),
          )
        }
        await Promise.all(writes)

        // Realtime repaint for the adjusted entity row.
        void notifyBrainInboxChange(workspaceId, 'entity', rowId, 'update')

        res.json({ ok: true, stamped: true })
      } catch (err) {
        console.error('[brain-inbox] entity adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust entity' })
      }
      return
    }

    if (primitiveParam === 'company' || primitiveParam === 'contact' || primitiveParam === 'deal') {
      // CRM-row adjust — supports `display_name` (mapped to the
      // companies/contacts/deals `name` column) + `sensitivity` (which
      // flows through the linked entity since that's the canonical
      // source). For company-specific `domain` and other kind-specific
      // fields, the chat tools (updateCompany / updateContact /
      // updateDeal) remain the surface. Both row + entity updates
      // happen so the list view (which reads the CRM row) and the
      // graph view (which reads the entity row) stay in sync.
      const { display_name, sensitivity, reason } = req.body as {
        display_name?: unknown
        sensitivity?: unknown
        reason?: unknown
      }

      let nextName: string | undefined
      if (display_name !== undefined) {
        if (typeof display_name !== 'string' || display_name.trim().length === 0) {
          res.status(400).json({ error: 'display_name must be a non-empty string' })
          return
        }
        if (display_name.length > 200) {
          res.status(400).json({ error: 'display_name must be 200 characters or less' })
          return
        }
        nextName = display_name.trim()
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public'
          && sensitivity !== 'internal'
          && sensitivity !== 'confidential'
        ) {
          res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      if (nextName === undefined && nextSensitivity === undefined) {
        res.status(400).json({
          error: 'At least one field (display_name, sensitivity) is required',
        })
        return
      }

      try {
        // Post CRM→entity unification the CRM row IS the entity — read it
        // directly; the record id is the entity id (entityId == rowId).
        const before = await query<{
          workspaceId: string
          name: string | null
          sensitivity: 'public' | 'internal' | 'confidential'
          entityId: string | null
        }>(
          `SELECT workspace_id AS "workspaceId", display_name AS name, sensitivity,
                  id AS "entityId"
             FROM entities
            WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'Row not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Row belongs to a different workspace' })
          return
        }
        const prev = before.rows[0]

        // The CRM row IS the entity now — a single updateEntity write
        // covers display_name + sensitivity.
        if (prev.entityId && (nextName !== undefined || nextSensitivity !== undefined)) {
          // Viewer-workspace projection; membership verified above.
          await updateEntity(userId, prev.entityId, {
            ...(nextName !== undefined ? { displayName: nextName } : {}),
            ...(nextSensitivity !== undefined ? { sensitivity: nextSensitivity } : {}),
            verifiedByUserId: userId,
            verifiedAt: new Date(),
          }, { workspaceId, userId, assistantId: '', assistantKind: 'primary' })
        }

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        const writes: Promise<unknown>[] = []
        if (nextName !== undefined && nextName !== prev.name) {
          writes.push(
            appendBrainVerification({
              targetKind: primitiveParam,
              targetId: rowId,
              workspaceId,
              verifiedByUserId: userId,
              action: 'edit_summary',
              modelValue: { name: prev.name },
              userValue: { name: nextName },
              reason: reasonText,
            }),
          )
        }
        if (nextSensitivity !== undefined && nextSensitivity !== prev.sensitivity) {
          writes.push(
            appendBrainVerification({
              targetKind: primitiveParam,
              targetId: rowId,
              workspaceId,
              verifiedByUserId: userId,
              action: 'adjust_sensitivity',
              modelValue: prev.sensitivity,
              userValue: nextSensitivity,
              reason: reasonText,
            }),
          )
        }
        await Promise.all(writes)

        // Realtime repaint: the CRM row itself, plus the linked entity when
        // this adjust mirrored name / sensitivity onto it (the graph view +
        // brain-search read the entity row, the list view reads the CRM row).
        void notifyBrainInboxChange(workspaceId, primitiveParam, rowId, 'update')
        if (prev.entityId && (nextName !== undefined || nextSensitivity !== undefined)) {
          void notifyBrainInboxChange(workspaceId, 'entity', prev.entityId, 'update')
        }

        res.json({ ok: true, stamped: true })
      } catch (err) {
        console.error(`[brain-inbox] ${primitiveParam} adjust failed:`, err)
        res.status(500).json({ error: `Failed to adjust ${primitiveParam}` })
      }
      return
    }

    if (primitiveParam === 'workspace_file') {
      // File adjust — v1 supports `sensitivity` + `tags`. `name` is the
      // path-coupled display name, so rename stays out of scope; substantive
      // content edits route through supersession, not this metadata patch.
      const { sensitivity, tags, reason } = req.body as {
        sensitivity?: unknown
        tags?: unknown
        reason?: unknown
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public'
          && sensitivity !== 'internal'
          && sensitivity !== 'confidential'
        ) {
          res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      let nextTags: string[] | undefined
      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
          res.status(400).json({ error: 'tags must be an array of strings' })
          return
        }
        nextTags = (tags as string[]).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 50)
      }

      if (nextSensitivity === undefined && nextTags === undefined) {
        res.status(400).json({ error: 'At least one field (sensitivity, tags) is required' })
        return
      }

      try {
        const before = await query<{
          workspaceId: string
          sensitivity: 'public' | 'internal' | 'confidential'
          tags: string[]
        }>(
          `SELECT workspace_id AS "workspaceId", sensitivity, tags
             FROM workspace_files
            WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'File not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'File belongs to a different workspace' })
          return
        }
        const prev = before.rows[0]

        const updated = await updateWorkspaceFileMeta(userId, workspaceId, rowId, {
          ...(nextSensitivity !== undefined ? { sensitivity: nextSensitivity } : {}),
          ...(nextTags !== undefined ? { tags: nextTags } : {}),
        })
        if (!updated) {
          res.status(404).json({ error: 'File not found' })
          return
        }
        // Stamp verified — an explicit edit is an acknowledgement, so the row
        // leaves the pending queue (matches the entity / CRM adjust branches).
        await markVerifiedGeneric('workspace_file', rowId, userId)

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        const writes: Promise<unknown>[] = []
        if (nextSensitivity !== undefined && nextSensitivity !== prev.sensitivity) {
          writes.push(
            appendBrainVerification({
              targetKind: 'workspace_file',
              targetId: rowId,
              workspaceId,
              verifiedByUserId: userId,
              action: 'adjust_sensitivity',
              modelValue: prev.sensitivity,
              userValue: nextSensitivity,
              reason: reasonText,
            }),
          )
        }
        if (nextTags !== undefined) {
          writes.push(
            appendBrainVerification({
              targetKind: 'workspace_file',
              targetId: rowId,
              workspaceId,
              verifiedByUserId: userId,
              action: 'adjust_attributes',
              modelValue: { tags: prev.tags },
              userValue: { tags: nextTags },
              reason: reasonText,
            }),
          )
        }
        await Promise.all(writes)

        void notifyBrainInboxChange(workspaceId, 'workspace_file', rowId, 'update')
        res.json({ ok: true, stamped: true })
      } catch (err) {
        console.error('[brain-inbox] workspace_file adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust file' })
      }
      return
    }

    if (primitiveParam === 'task') {
      // Task adjust — v1 supports the doc-like editable fields surfaced in
      // the Brain detail panel: title, status, due date, and tags. Each
      // edit supersedes the row (a new bi-temporal id), so the preserved
      // old row IS the audit trail — no brain_verification stamp here.
      const { title, status, due_at, tags } = req.body as {
        title?: unknown
        status?: unknown
        due_at?: unknown
        tags?: unknown
      }

      const fields: TaskUpdateFields = {}

      if (title !== undefined) {
        if (typeof title !== 'string' || title.trim().length === 0) {
          res.status(400).json({ error: 'title must be a non-empty string' })
          return
        }
        if (title.length > 500) {
          res.status(400).json({ error: 'title must be 500 characters or less' })
          return
        }
        fields.title = title.trim()
      }

      if (status !== undefined) {
        if (!TASK_STATUSES.includes(status as TaskRecordStatus)) {
          res.status(400).json({
            error: `status must be one of ${TASK_STATUSES.join(', ')}`,
          })
          return
        }
        fields.status = status as TaskRecordStatus
      }

      if (due_at !== undefined) {
        // null clears the due date; a string must parse to a valid date.
        if (due_at === null) {
          fields.due = null
        } else if (typeof due_at === 'string') {
          const parsed = new Date(due_at)
          if (Number.isNaN(parsed.getTime())) {
            res.status(400).json({ error: 'due_at must be an ISO date string or null' })
            return
          }
          fields.due = parsed
        } else {
          res.status(400).json({ error: 'due_at must be an ISO date string or null' })
          return
        }
      }

      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
          res.status(400).json({ error: 'tags must be an array of strings' })
          return
        }
        fields.tags = (tags as string[]).map((s) => s.trim()).filter(Boolean)
      }

      if (Object.keys(fields).length === 0) {
        res.status(400).json({
          error: 'At least one field (title, status, due_at, tags) is required',
        })
        return
      }

      try {
        // Workspace-ownership check — requireWorkspaceMember already gated
        // membership; this confirms the row lives in *this* workspace and
        // distinguishes 404 (gone) from 403 (cross-workspace).
        const before = await query<{ workspaceId: string }>(
          `SELECT workspace_id as "workspaceId" FROM tasks WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'Task not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Task belongs to a different workspace' })
          return
        }

        const updated = await updateTask(userId, rowId, fields)
        if (!updated) {
          res.status(404).json({ error: 'Task not found' })
          return
        }

        // Supersession mints a new id; return it so the client can re-anchor
        // (the panel closes + refetches, so a stale id never lingers).
        void notifyBrainInboxChange(workspaceId, 'task', rowId, 'update')
        res.json({ ok: true, stamped: true, id: updated.id })
      } catch (err) {
        console.error('[brain-inbox] task adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust task' })
      }
      return
    }

    res.status(405).json({
      error:
        `Inline adjust not yet supported for primitive '${primitiveParam}'. ` +
        `Use the detail page (e.g., /task/:id) to edit.`,
    })
  })

  // (Removed) GET /:workspaceId/entity/:entityId/crm-companion.
  // Post CRM→entity unification a person/company/deal IS the entity —
  // the detail drawer fetches it directly, with no separate specialization
  // row to resolve. The route and its `fetchCrmCompanion` client are gone.

  // ── POST /:workspaceId/entity/:entityId/reclassify ─────────────
  //
  // Non-CRM kind change. Targets `product` / `project` / `event` /
  // tenant.* — anything not in CRM_SPECIALIZED_KINDS. CRM targets are
  // rejected here; they go through /promote-to-crm so the companion
  // row is created in the same transaction. Stamps a brain_verification
  // audit row with `action='reclassify_kind'`.
  router.post('/:workspaceId/entity/:entityId/reclassify', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, entityId } = req.params as {
      workspaceId: string
      entityId: string
    }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { kind, reason } = req.body as { kind?: unknown; reason?: unknown }
    if (typeof kind !== 'string' || kind.trim().length === 0) {
      res.status(400).json({ error: 'kind must be a non-empty string' })
      return
    }
    const targetKind = kind.trim()
    const CRM_KINDS = new Set<string>(['person', 'company', 'deal'])
    if (CRM_KINDS.has(targetKind)) {
      res.status(400).json({
        error:
          `Reclassifying to '${targetKind}' requires the CRM companion row. Use POST /promote-to-crm.`,
        useEndpoint: `/api/brain-inbox/${workspaceId}/entity/${entityId}/promote-to-crm`,
      })
      return
    }
    const systemKinds = new Set<string>(SYSTEM_ENTITY_KINDS as readonly string[])
    if (!systemKinds.has(targetKind) && !targetKind.startsWith('tenant.')) {
      res.status(400).json({
        error: `Unknown entity kind '${targetKind}'. Allowed: project, product, or a tenant.* namespace.`,
      })
      return
    }

    try {
      const before = await query<{ workspaceId: string; kind: string }>(
        `SELECT workspace_id AS "workspaceId", kind
           FROM entities
          WHERE id = $1 AND valid_to IS NULL`,
        [entityId],
      )
      if (before.rows.length === 0) {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      if (before.rows[0].workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Entity belongs to a different workspace' })
        return
      }
      if (before.rows[0].kind === targetKind) {
        // No-op — surface as success so the UI moves on.
        res.json({ ok: true, kind: targetKind, idempotent: true })
        return
      }

      const updated = await reclassifyEntityKind(userId, entityId, {
        kind: targetKind,
      })
      if (!updated) {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      await appendBrainVerification({
        targetKind: 'entity',
        targetId: entityId,
        workspaceId,
        verifiedByUserId: userId,
        action: 'reclassify_kind',
        modelValue: { kind: before.rows[0].kind },
        userValue: { kind: targetKind },
        reason: typeof reason === 'string' ? reason.slice(0, 500) : undefined,
      })
      // Realtime repaint for the reclassified entity node.
      void notifyBrainInboxChange(workspaceId, 'entity', entityId, 'update')
      res.json({ ok: true, kind: targetKind })
    } catch (err) {
      console.error('[brain-inbox] entity reclassify failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: 'Failed to reclassify entity', detail: message })
    }
  })

  // ── Alias mutators ────────────────────────────────────────────
  //
  // POST   /:workspaceId/entity/:entityId/aliases       — add alias
  // DELETE /:workspaceId/entity/:entityId/aliases/:alias — remove alias
  //
  // Backs the entity-drawer's alias chips. Same RLS as the rest of
  // the route group (workspace membership required). Add returns 409
  // with the conflicting entity id when the alias is bound elsewhere
  // in the workspace — the drawer surfaces that as a merge prompt.
  router.post('/:workspaceId/entity/:entityId/aliases', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return
    const { workspaceId, entityId } = req.params as {
      workspaceId: string
      entityId: string
    }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { alias } = req.body as { alias?: unknown }
    if (typeof alias !== 'string' || alias.trim().length === 0) {
      res.status(400).json({ error: 'alias must be a non-empty string' })
      return
    }
    if (alias.trim().length > 200) {
      res.status(400).json({ error: 'alias must be <= 200 characters' })
      return
    }
    try {
      // Ownership check — RLS in addEntityAlias would already block
      // cross-workspace, but a 404 here is friendlier than a not_found.
      const owner = await query<{ workspaceId: string }>(
        `SELECT workspace_id AS "workspaceId" FROM entities WHERE id = $1 AND valid_to IS NULL`,
        [entityId],
      )
      if (owner.rows.length === 0) {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      if (owner.rows[0].workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Entity belongs to a different workspace' })
        return
      }
      const result = await addEntityAlias(userId, entityId, alias)
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      if (result.kind === 'conflict') {
        res.status(409).json({
          error: 'Alias is already bound to another entity in this workspace',
          conflictingEntityId: result.conflictingEntityId,
        })
        return
      }
      // Realtime repaint — alias chips are part of the entity card.
      void notifyBrainInboxChange(workspaceId, 'entity', entityId, 'update')
      res.json({ ok: true, aliases: result.entity.aliases })
    } catch (err) {
      console.error('[brain-inbox] alias add failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: 'Failed to add alias', detail: message })
    }
  })

  router.delete('/:workspaceId/entity/:entityId/aliases/:alias', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return
    const { workspaceId, entityId, alias } = req.params as {
      workspaceId: string
      entityId: string
      alias: string
    }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    try {
      const owner = await query<{ workspaceId: string }>(
        `SELECT workspace_id AS "workspaceId" FROM entities WHERE id = $1 AND valid_to IS NULL`,
        [entityId],
      )
      if (owner.rows.length === 0) {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      if (owner.rows[0].workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Entity belongs to a different workspace' })
        return
      }
      const updated = await removeEntityAlias(userId, entityId, decodeURIComponent(alias))
      if (!updated) {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      // Realtime repaint — alias chips are part of the entity card.
      void notifyBrainInboxChange(workspaceId, 'entity', entityId, 'update')
      res.json({ ok: true, aliases: updated.aliases })
    } catch (err) {
      console.error('[brain-inbox] alias remove failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: 'Failed to remove alias', detail: message })
    }
  })

  // ── POST /:workspaceId/entity/:entityId/promote-to-crm ──────────
  //
  // Atomic CRM promotion. Inserts the companion `contacts` /
  // `companies` / `deals` row referencing the existing entity and
  // flips `entities.kind` in one transaction. Required fields by kind:
  //   - company: nothing extra (name defaults from display_name; domain optional)
  //   - person : nothing extra (email/phone/companyId optional)
  //   - deal   : stage REQUIRED ('lead'|'qualified'|'proposal'|'negotiation'|'won'|'lost')
  router.post('/:workspaceId/entity/:entityId/promote-to-crm', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, entityId } = req.params as {
      workspaceId: string
      entityId: string
    }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const body = (req.body ?? {}) as {
      kind?: unknown
      name?: unknown
      tags?: unknown
      domain?: unknown
      email?: unknown
      phone?: unknown
      companyId?: unknown
      stage?: unknown
      amount?: unknown
      closeDate?: unknown
      contactId?: unknown
      reason?: unknown
    }
    if (
      body.kind !== 'person'
      && body.kind !== 'company'
      && body.kind !== 'deal'
    ) {
      res.status(400).json({
        error: "kind must be one of: 'person', 'company', 'deal'",
      })
      return
    }
    const params: PromoteEntityToCrmParams = { kind: body.kind }
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      params.name = body.name.trim().slice(0, 200)
    }
    if (Array.isArray(body.tags)) {
      params.tags = body.tags.filter((t): t is string => typeof t === 'string').slice(0, 20)
    }
    if (body.kind === 'company') {
      if (typeof body.domain === 'string' && body.domain.trim().length > 0) {
        params.domain = body.domain.trim()
      }
    } else if (body.kind === 'person') {
      if (typeof body.email === 'string' && body.email.trim().length > 0) {
        params.email = body.email.trim()
      }
      if (typeof body.phone === 'string' && body.phone.trim().length > 0) {
        params.phone = body.phone.trim()
      }
      if (typeof body.companyId === 'string' && body.companyId.trim().length > 0) {
        params.companyId = body.companyId.trim()
      }
    } else {
      // deal — stage is required, validated against the enum.
      const allowedStages = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const
      type Stage = (typeof allowedStages)[number]
      if (!allowedStages.includes(body.stage as Stage)) {
        res.status(400).json({
          error: `stage is required and must be one of: ${allowedStages.join(', ')}`,
        })
        return
      }
      params.stage = body.stage as Stage
      if (typeof body.amount === 'number' && Number.isFinite(body.amount)) {
        params.amount = body.amount
      }
      if (typeof body.closeDate === 'string') {
        const d = new Date(body.closeDate)
        if (!isNaN(d.getTime())) params.closeDate = d
      }
      if (typeof body.contactId === 'string' && body.contactId.trim().length > 0) {
        params.contactId = body.contactId.trim()
      }
      if (typeof body.companyId === 'string' && body.companyId.trim().length > 0) {
        params.companyId = body.companyId.trim()
      }
    }

    try {
      const before = await query<{ workspaceId: string; kind: string }>(
        `SELECT workspace_id AS "workspaceId", kind
           FROM entities
          WHERE id = $1 AND valid_to IS NULL`,
        [entityId],
      )
      if (before.rows.length === 0) {
        res.status(404).json({ error: 'Entity not found' })
        return
      }
      if (before.rows[0].workspaceId !== workspaceId) {
        res.status(403).json({ error: 'Entity belongs to a different workspace' })
        return
      }

      const result = await promoteEntityToCrm(userId, entityId, params)
      await appendBrainVerification({
        targetKind: 'entity',
        targetId: entityId,
        workspaceId,
        verifiedByUserId: userId,
        action: 'promote_to_crm',
        modelValue: { kind: before.rows[0].kind },
        userValue: { kind: params.kind, specializationId: result.specializationId },
        reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
      })
      // Realtime repaint: the new CRM companion row (a 'create') plus the
      // entity itself whose kind just flipped (an 'update'). `params.kind`
      // 'person' maps to the 'contact' inbox primitive.
      const crmPrimitive = params.kind === 'person' ? 'contact' : params.kind
      void notifyBrainInboxChange(workspaceId, crmPrimitive, result.specializationId, 'create')
      void notifyBrainInboxChange(workspaceId, 'entity', entityId, 'update')
      res.json({
        ok: true,
        kind: result.entity.kind,
        entityId: result.entity.id,
        specializationId: result.specializationId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[brain-inbox] entity promote-to-crm failed:', message)
      // Map known-message errors from the helper to 4xx so the UI can
      // surface them cleanly.
      if (
        message.includes('already CRM-specialized')
        || message.includes('requires a stage')
        || message.includes('Cannot promote')
      ) {
        res.status(400).json({ error: message })
      } else if (message === 'Entity not found or not live.') {
        res.status(404).json({ error: message })
      } else {
        res.status(500).json({ error: 'Failed to promote entity', detail: message })
      }
    }
  })

  // ── DELETE /:workspaceId/:primitive/:rowId ──────────────────────
  //
  // Soft delete — sets valid_to = now() on the active version.
  // Records the action in brain_verifications (or memory_verifications
  // for memory).

  router.delete('/:workspaceId/:primitive/:rowId', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
      workspaceId: string
      primitive: string
      rowId: string
    }
    if (!isValidPrimitive(primitiveParam)) {
      res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
      return
    }
    const userId = (req as any).userId as string

    try {
      // Validate ownership.
      const ownership = await query<{ workspace_id: string }>(
        `SELECT workspace_id FROM ${primitiveToTable(primitiveParam)}
         WHERE id = $1 AND valid_to IS NULL`,
        [rowId],
      )
      if (ownership.rows.length === 0) {
        res.status(404).json({ error: 'Row not found' })
        return
      }
      if (ownership.rows[0].workspace_id !== workspaceId) {
        res.status(403).json({ error: 'Row belongs to a different workspace' })
        return
      }

      // Soft delete.
      await query(
        `UPDATE ${primitiveToTable(primitiveParam)}
            SET valid_to = now(), updated_at = now()
          WHERE id = $1 AND valid_to IS NULL`,
        [rowId],
      )

      // Audit. For memory ride memory_verifications.action='delete'; for
      // others use brain_verifications.action='delete'.
      if (primitiveParam === 'memory') {
        await query(
          `INSERT INTO memory_verifications (memory_id, workspace_id, verified_by, action)
           VALUES ($1, $2, $3, 'delete')`,
          [rowId, workspaceId, userId],
        )
      } else {
        await appendBrainVerification({
          targetKind: primitiveParam,
          targetId: rowId,
          workspaceId,
          verifiedByUserId: userId,
          action: 'delete',
        })
      }

      // Realtime repaint so the deleted row drops off open /brain pages.
      void notifyBrainInboxChange(workspaceId, primitiveParam, rowId, 'delete')

      res.json({ ok: true })
    } catch (err) {
      console.error('[brain-inbox] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete row' })
    }
  })

  // ── GET /:workspaceId/:primitive/:rowId/explain ─────────────────
  //
  // Returns the source context that motivated the save — the "where did
  // this come from?" answer for the entry page's Source block:
  //   - The saving assistant's id + name and the creating user
  //   - An `origin` descriptor (kind + channel/workflow/episode detail)
  //     so the UI always has a clue line, even without a chat to show
  //   - Source-session id (link target for the frontend) when a REAL
  //     session resolves, plus up to 6 surrounding session_messages
  //     (3 before, 3 after the save's created_at)
  //
  // Session resolution ladder: the row's own `source_session_id`
  // (memory / task / entity-backed primitives, mig 316) → episode
  // `content_ref.session_id` → episode `source_ref.session_id`
  // (tolerating the legacy `{kind: ...}` field-name drift), then
  // VERIFIED against `sessions` — a dangling id (e.g. the brain-MCP
  // surface's synthetic randomUUID) resolves to nothing and falls
  // through to the next origin kind.
  //
  // No LLM call. Cheap. The "Ask about this" drawer is where the
  // model-mediated deliberation happens.
  // Spec: docs/architecture/brain/corrections.md → "Source descriptor".
  // [COMP:api/brain-inbox-explain]

  router.get('/:workspaceId/:primitive/:rowId/explain', async (req, res) => {
    const role = await requireWorkspaceMember(req as any, res)
    if (!role) return

    const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
      workspaceId: string
      primitive: string
      rowId: string
    }
    if (!isValidPrimitive(primitiveParam)) {
      res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
      return
    }

    try {
      // Pull the universal-column fields we need. Every brain primitive
      // carries created_by_* + source_episode_id + source; memory, task,
      // and the entity-backed primitives (entity / contact / company /
      // deal) also carry source_session_id (mig 316). Edges and files
      // anchor through their episode only.
      const targetTable = primitiveToTable(primitiveParam)
      const sourceSessionCol =
        primitiveParam === 'entity_link' || primitiveParam === 'workspace_file'
          ? 'NULL'
          : 'source_session_id'
      // Workflow tagging (`workflow:<id>`) exists on memories only.
      const tagsCol = primitiveParam === 'memory' ? 'tags' : 'NULL::text[]'
      const meta = await query<{
        workspace_id: string
        created_at: Date
        created_by_assistant_id: string | null
        created_by_user_id: string | null
        source_episode_id: string | null
        source_session_id: string | null
        source: string | null
        tags: string[] | null
      }>(
        `SELECT workspace_id, created_at, created_by_assistant_id, created_by_user_id,
                source_episode_id, ${sourceSessionCol} AS source_session_id,
                source, ${tagsCol} AS tags
         FROM ${targetTable}
         WHERE id = $1`,
        [rowId],
      )
      if (meta.rows.length === 0) {
        res.status(404).json({ error: 'Row not found' })
        return
      }
      const row = meta.rows[0]
      if (row.workspace_id !== workspaceId) {
        res.status(403).json({ error: 'Row belongs to a different workspace' })
        return
      }

      // Resolve the saving assistant's name.
      let assistantName: string | null = null
      if (row.created_by_assistant_id) {
        const a = await query<{ name: string }>(
          `SELECT name FROM assistants WHERE id = $1`,
          [row.created_by_assistant_id],
        )
        assistantName = a.rows[0]?.name ?? null
      }

      // Resolve the creating user's name (the "Added manually by …" /
      // author-fallback label).
      let createdByUserName: string | null = null
      if (row.created_by_user_id) {
        const u = await query<{ name: string | null }>(
          `SELECT name FROM users WHERE id = $1`,
          [row.created_by_user_id],
        )
        createdByUserName = u.rows[0]?.name ?? null
      }

      // Load the source episode when the row has one — both a session-id
      // fallback and the extraction-origin detail for the descriptor.
      type EpisodeRef = { source_kind?: string; kind?: string; session_id?: string }
      let episode: {
        id: string
        source_kind: string
        occurred_at: Date
        summary_text: string | null
        content_ref: EpisodeRef | null
        source_ref: EpisodeRef | null
      } | null = null
      if (row.source_episode_id) {
        const ep = await query<{
          id: string
          source_kind: string
          occurred_at: Date
          summary_text: string | null
          content_ref: EpisodeRef | null
          source_ref: EpisodeRef | null
        }>(
          `SELECT id, source_kind, occurred_at, summary_text, content_ref, source_ref
           FROM episodes WHERE id = $1`,
          [row.source_episode_id],
        )
        episode = ep.rows[0] ?? null
      }

      // Session ladder: own column → content_ref → source_ref.
      let candidateSessionId = row.source_session_id
      if (!candidateSessionId && episode) {
        for (const ref of [episode.content_ref, episode.source_ref]) {
          if (ref && typeof ref.session_id === 'string') {
            candidateSessionId = ref.session_id
            break
          }
        }
      }

      // Verify the candidate against `sessions` — dangling ids fall
      // through (the row keeps its non-chat origin) — and pick up the
      // channel type for the origin label.
      let sourceSessionId: string | null = null
      let sessionChannelType: string | null = null
      if (candidateSessionId) {
        const s = await query<{ id: string; channel_type: string }>(
          `SELECT id, channel_type FROM sessions WHERE id = $1`,
          [candidateSessionId],
        )
        if (s.rows[0]) {
          sourceSessionId = s.rows[0].id
          sessionChannelType = s.rows[0].channel_type
        }
      }

      // Workflow provenance rides on the memory's `workflow:<id>` tag.
      const workflowId =
        row.tags
          ?.find((t) => typeof t === 'string' && t.startsWith('workflow:'))
          ?.slice('workflow:'.length) ?? null

      // Origin kind precedence: manual → consolidation → session-backed
      // (workflow / scheduled / chat) → extraction → unknown.
      let originKind:
        | 'manual'
        | 'consolidation'
        | 'workflow'
        | 'scheduled'
        | 'chat'
        | 'extraction'
        | 'unknown'
      if (row.source === 'manual') {
        originKind = 'manual'
      } else if (row.source === 'consolidation' || row.source === 'reflection') {
        originKind = 'consolidation'
      } else if (sourceSessionId) {
        originKind =
          workflowId || sessionChannelType === 'assistant-call'
            ? 'workflow'
            : sessionChannelType === 'cron'
              ? 'scheduled'
              : 'chat'
      } else if (workflowId) {
        originKind = 'workflow'
      } else if (episode) {
        originKind = 'extraction'
      } else {
        originKind = 'unknown'
      }

      // Pull up to 3 messages before + 3 after the row's created_at,
      // ordered by created_at ASC for chronological reading.
      let messages: Array<{
        id: string
        role: string
        content: unknown
        createdAt: Date
      }> = []
      if (sourceSessionId) {
        const msgs = await query<{
          id: string
          role: string
          content: unknown
          createdAt: Date
          rn: number
        }>(
          `WITH ordered AS (
             SELECT id, role, content, created_at AS "createdAt",
                    row_number() OVER (ORDER BY created_at ASC) AS rn,
                    abs(extract(epoch FROM (created_at - $2))) AS dist
             FROM session_messages
             WHERE session_id = $1
           ),
           pivot AS (
             SELECT rn FROM ordered ORDER BY dist ASC LIMIT 1
           )
           SELECT o.id, o.role, o.content, o."createdAt", o.rn
           FROM ordered o, pivot p
           WHERE o.rn BETWEEN GREATEST(p.rn - 3, 1) AND p.rn + 3
           ORDER BY o."createdAt" ASC`,
          [sourceSessionId, row.created_at],
        )
        messages = msgs.rows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        }))
      }

      res.json({
        savedAt: row.created_at,
        savedByAssistantId: row.created_by_assistant_id,
        savedByAssistantName: assistantName,
        sourceSessionId,
        sourceEpisodeId: row.source_episode_id,
        messages,
        origin: {
          kind: originKind,
          source: row.source,
          channelType: sessionChannelType,
          workflowId,
          episode: episode
            ? {
                id: episode.id,
                sourceKind: episode.source_kind,
                occurredAt: episode.occurred_at,
                summaryText: episode.summary_text,
              }
            : null,
          createdByUserId: row.created_by_user_id,
          createdByUserName,
        },
      })
    } catch (err) {
      console.error('[brain-inbox] explain failed:', err)
      res.status(500).json({ error: 'Failed to load explain context' })
    }
  })

  // ── POST /:workspaceId/:primitive/:rowId/inspection-session ─────
  //
  // Creates a transient session bound to the workspace's primary
  // assistant (fallback: most-recent assistant). The frontend opens
  // the drawer and routes user messages through the normal /api/chat
  // endpoint targeted at this session. The system-prompt seeding +
  // restricted tool registry happen on the chat-route side, gated on
  // sessions.transient = TRUE.

  router.post(
    '/:workspaceId/:primitive/:rowId/inspection-session',
    async (req, res) => {
      const role = await requireWorkspaceMember(req as any, res)
      if (!role) return

      const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
        workspaceId: string
        primitive: string
        rowId: string
      }
      if (!isValidPrimitive(primitiveParam)) {
        res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
        return
      }
      const userId = (req as any).userId as string

      try {
        // Validate ownership.
        const ownership = await query<{ workspace_id: string }>(
          `SELECT workspace_id FROM ${primitiveToTable(primitiveParam)}
           WHERE id = $1`,
          [rowId],
        )
        if (
          ownership.rows.length === 0 ||
          ownership.rows[0].workspace_id !== workspaceId
        ) {
          res.status(404).json({ error: 'Row not found' })
          return
        }

        // Resolve the primary assistant for this workspace. Fallback to
        // the most-recently-created assistant if no kind='primary'
        // exists. Workspaces with only kind='app' distribution
        // assistants have no inspectable assistant — return 422.
        const primary = await query<{ id: string; kind: string; name: string }>(
          `SELECT id, kind, name FROM assistants
            WHERE workspace_id = $1
              AND kind != 'app'
            ORDER BY (kind = 'primary') DESC, created_at DESC
            LIMIT 1`,
          [workspaceId],
        )
        if (primary.rows.length === 0) {
          res.status(422).json({
            error:
              'This workspace has no inspectable assistant. Ask features are only available where the workspace has a primary or standard assistant.',
          })
          return
        }

        const session = await createInspectionSession({
          primaryAssistantId: primary.rows[0].id,
          userId,
        })

        res.json({
          sessionId: session.id,
          assistantId: session.assistantId,
          assistantName: primary.rows[0].name,
          // Inspection context the frontend includes in its first
          // outbound /api/chat message so the model has the memory in
          // hand. We pass these here so the frontend doesn't need a
          // round-trip to load them separately.
          inspectionContext: {
            primitive: primitiveParam,
            rowId,
          },
        })
      } catch (err) {
        console.error('[brain-inbox] inspection-session failed:', err)
        res.status(500).json({ error: 'Failed to create inspection session' })
      }
    },
  )

  return router
}
